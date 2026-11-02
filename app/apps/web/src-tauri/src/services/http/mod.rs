//! HTTP 引擎子模块：request（合成）/ auth（认证注入）/ engine（纯执行）/
//! response（分级句柄）。编排层（`services::send`）是 GUI 与 CLI 双入口的共用链路。
//!
//! 资源所有权：reqwest Client 归 [`HttpService`] 所有——按设置快照构建并缓存，
//! `http` 设置键写入时整体重建（在途请求持旧 Client 的 Arc 不受影响）；
//! 应用退出随 AppState / AppContext 释放。

pub mod auth;
pub mod engine;
pub mod request;
pub mod response;

use std::sync::RwLock;

use crate::error::AppError;
use crate::error::codes;

/// 重定向跟随上限（redirect=true 时的固定上限）。
const REDIRECT_LIMIT: usize = 10;

/// HTTP 设置快照（settings 单键 `http` 的值形态；见设置组实现）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpSettings {
    /// 全局超时档：None＝不限制（默认）| Some(秒)
    pub timeout_seconds: Option<u64>,
    /// 是否跟随重定向（true＝跟随，上限固定 10）
    pub redirect: bool,
    /// 是否校验 TLS 证书
    pub tls_verify: bool,
    /// 代理
    pub proxy: ProxySetting,
}

/// 代理设置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxySetting {
    /// 不使用代理（默认）
    None,
    /// 自定义代理地址（scheme 自动判别 http / https / socks5）
    Custom { url: String },
}

impl Default for HttpSettings {
    fn default() -> Self {
        Self {
            timeout_seconds: None,
            redirect: true,
            tls_verify: true,
            proxy: ProxySetting::None,
        }
    }
}

/// 超时秒数上限（有界护栏：手工改库的可容上限，UI 档位仅 10/30/60）
const MAX_TIMEOUT_SECONDS: u64 = 86_400;

impl HttpSettings {
    /// settings 单键 `http` 的值形态解析（写入校验与 boot 构建共用）：
    /// `{timeoutSeconds: null|正整数, redirect: bool, tlsVerify: bool,
    /// proxy: {mode: "none"|"custom", url: null|string}}`；缺字段取默认。
    pub fn from_value(value: &serde_json::Value) -> Result<Self, AppError> {
        let obj = value.as_object().ok_or_else(|| {
            AppError::new(codes::INVALID_ARGUMENT, "http setting must be an object")
        })?;
        let get_bool = |key: &str, default: bool| -> Result<bool, AppError> {
            match obj.get(key) {
                None | Some(serde_json::Value::Null) => Ok(default),
                Some(serde_json::Value::Bool(b)) => Ok(*b),
                Some(_) => Err(AppError::new(
                    codes::INVALID_ARGUMENT,
                    format!("http setting field {key} must be a boolean"),
                )),
            }
        };
        let timeout_seconds = match obj.get("timeoutSeconds") {
            None | Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::Number(n)) => {
                let secs = n.as_u64().ok_or_else(|| {
                    AppError::new(
                        codes::INVALID_ARGUMENT,
                        "http setting field timeoutSeconds must be a positive integer",
                    )
                })?;
                if secs == 0 || secs > MAX_TIMEOUT_SECONDS {
                    return Err(AppError::new(
                        codes::INVALID_ARGUMENT,
                        format!(
                            "http setting field timeoutSeconds must be 1..={MAX_TIMEOUT_SECONDS} or null"
                        ),
                    ));
                }
                Some(secs)
            }
            Some(_) => {
                return Err(AppError::new(
                    codes::INVALID_ARGUMENT,
                    "http setting field timeoutSeconds must be a positive integer or null",
                ));
            }
        };
        let proxy = match obj.get("proxy") {
            None | Some(serde_json::Value::Null) => ProxySetting::None,
            Some(serde_json::Value::Object(proxy)) => {
                let mode = proxy
                    .get("mode")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("none");
                match mode {
                    "none" => ProxySetting::None,
                    "custom" => {
                        let url = proxy
                            .get("url")
                            .and_then(serde_json::Value::as_str)
                            .map(str::trim)
                            .filter(|u| !u.is_empty())
                            .ok_or_else(|| {
                                AppError::new(
                                    codes::INVALID_ARGUMENT,
                                    "http setting proxy.url is required when mode is custom",
                                )
                            })?;
                        ProxySetting::Custom {
                            url: url.to_string(),
                        }
                    }
                    other => {
                        return Err(AppError::new(
                            codes::INVALID_ARGUMENT,
                            format!("http setting proxy.mode must be none or custom, got {other}"),
                        ));
                    }
                }
            }
            Some(_) => {
                return Err(AppError::new(
                    codes::INVALID_ARGUMENT,
                    "http setting field proxy must be an object",
                ));
            }
        };
        Ok(Self {
            timeout_seconds,
            redirect: get_bool("redirect", true)?,
            tls_verify: get_bool("tlsVerify", true)?,
            proxy,
        })
    }

    /// 值形态序列化（与 from_value 往返一致；测试与默认值对账用）。
    pub fn to_value(&self) -> serde_json::Value {
        let proxy = match &self.proxy {
            ProxySetting::None => serde_json::json!({"mode": "none", "url": null}),
            ProxySetting::Custom { url } => serde_json::json!({"mode": "custom", "url": url}),
        };
        serde_json::json!({
            "timeoutSeconds": self.timeout_seconds,
            "redirect": self.redirect,
            "tlsVerify": self.tls_verify,
            "proxy": proxy,
        })
    }
}

/// 按设置快照构建 reqwest Client（构建期参数：重定向 / TLS / 代理；超时档
/// 由编排层按「全局档 / 接口覆写」解析后以 per-request timeout 落点）。
pub fn build_client(settings: &HttpSettings) -> Result<reqwest::Client, AppError> {
    let mut builder = reqwest::Client::builder().redirect(if settings.redirect {
        reqwest::redirect::Policy::limited(REDIRECT_LIMIT)
    } else {
        reqwest::redirect::Policy::none()
    });
    if !settings.tls_verify {
        builder = builder.danger_accept_invalid_certs(true);
    }
    if let ProxySetting::Custom { url } = &settings.proxy {
        let proxy = reqwest::Proxy::all(url).map_err(|e| {
            AppError::new(
                codes::URL_INVALID,
                format!("invalid proxy url: {url} ({e})"),
            )
        })?;
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|e| AppError::new(codes::INTERNAL, format!("build http client failed: {e}")))
}

/// 设置快照＋按其构建的 Client 的缓存对。
struct ClientSnapshot {
    settings: HttpSettings,
    client: reqwest::Client,
}

/// HTTP 服务：Client 快照缓存持有者。首启以默认设置构建；设置变更经
/// [`HttpService::rebuild`] 整体替换（新请求即生效，在途请求持旧 Arc）。
pub struct HttpService {
    snapshot: RwLock<ClientSnapshot>,
}

impl Default for HttpService {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpService {
    pub fn new() -> Self {
        Self::from_settings(HttpSettings::default())
    }

    pub fn from_settings(settings: HttpSettings) -> Self {
        // 构建失败落 INTERNAL：默认/已校验设置恒可构建，失败属不可恢复装配错
        let client = build_client(&settings).expect("已校验设置构建 Client 恒成功");
        Self {
            snapshot: RwLock::new(ClientSnapshot { settings, client }),
        }
    }

    /// 设置变更重建 Client（写锁短暂持有；等待中的发送请求读旧快照完成）。
    pub fn rebuild(&self, settings: HttpSettings) -> Result<(), AppError> {
        let client = build_client(&settings)?;
        let mut guard = self
            .snapshot
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *guard = ClientSnapshot { settings, client };
        Ok(())
    }

    /// 当前 Client 克隆（reqwest Client 内部 Arc，克隆廉价）。
    pub fn client(&self) -> reqwest::Client {
        self.snapshot
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .client
            .clone()
    }

    /// 当前设置快照克隆（发送前解析有效超时用）。
    pub fn settings(&self) -> HttpSettings {
        self.snapshot
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .settings
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_client_builds() {
        assert!(build_client(&HttpSettings::default()).is_ok());
    }

    #[test]
    fn settings_value_roundtrip() {
        // 默认值 → 值形态 → 解析恒等（boot 构建与写校验共用同一路径）
        let value = HttpSettings::default().to_value();
        assert_eq!(
            HttpSettings::from_value(&value).unwrap(),
            HttpSettings::default()
        );
        // 全字段自定义 → 往返一致
        let custom = HttpSettings {
            timeout_seconds: Some(30),
            redirect: false,
            tls_verify: false,
            proxy: ProxySetting::Custom {
                url: "socks5://127.0.0.1:1080".into(),
            },
        };
        assert_eq!(
            HttpSettings::from_value(&custom.to_value()).unwrap(),
            custom
        );
        // 缺字段取默认
        let partial = serde_json::json!({"timeoutSeconds": 10});
        assert_eq!(
            HttpSettings::from_value(&partial).unwrap(),
            HttpSettings {
                timeout_seconds: Some(10),
                ..HttpSettings::default()
            }
        );
    }

    #[test]
    fn settings_value_rejects_dirty_shapes() {
        let cases = [
            serde_json::json!("not an object"),
            serde_json::json!({"timeoutSeconds": "soon"}),
            serde_json::json!({"timeoutSeconds": 0}),
            serde_json::json!({"timeoutSeconds": -5}),
            serde_json::json!({"redirect": "yes"}),
            serde_json::json!({"proxy": {"mode": "custom"}}),
            serde_json::json!({"proxy": {"mode": " PAC "}}),
            serde_json::json!({"proxy": []}),
        ];
        for value in cases {
            assert!(
                HttpSettings::from_value(&value).is_err(),
                "应拒绝脏值: {value}"
            );
        }
    }

    #[test]
    fn rebuild_replaces_settings_snapshot() {
        let service = HttpService::new();
        assert_eq!(service.settings(), HttpSettings::default());
        let next = HttpSettings {
            timeout_seconds: Some(30),
            redirect: false,
            tls_verify: false,
            proxy: ProxySetting::Custom {
                url: "socks5://127.0.0.1:1080".into(),
            },
        };
        service.rebuild(next.clone()).unwrap();
        assert_eq!(service.settings(), next);
        // 重建后 Client 可用（克隆非空句柄）
        let _ = service.client();
    }

    #[test]
    fn rebuild_rejects_invalid_proxy_url() {
        let service = HttpService::new();
        let bad = HttpSettings {
            proxy: ProxySetting::Custom {
                url: "not a url".into(),
            },
            ..HttpSettings::default()
        };
        let err = service.rebuild(bad).unwrap_err();
        assert_eq!(err.code, codes::URL_INVALID);
    }
}
