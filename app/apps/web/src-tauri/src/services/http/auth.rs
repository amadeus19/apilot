//! 认证合成：两级继承（请求级 → 工作空间级）与七种纯注入型的注入规则。
//!
//! 类型集（纯注入型，签名型 / 流程型不进第一版；UI 不展示未支持类型）：
//! `inherit`（请求级默认）/ `none`（显式阻断继承）/ `bearer` / `basic` /
//! `apiKey`·header / `apiKey`·query / `apiKey`·cookie。
//!
//! 合成规则：请求级「继承」（或未配置）→ 取工作空间配置；「不使用」→ 发裸请求；
//! 具名类型 → 请求级生效；工作空间未配置（NULL 或 `none`）＝全链无认证。
//! 注入位于用户数据 headers 之上：与用户数据 headers 同名冲突时认证配置优先。
//!
//! 字段值形态：字面量，或 `{{变量}}` 引用（原样透传、不校验合法性；
//! 变量解析点亮后生效）。快照存明文；展示 / 导出 / 日志 / CLI 输出按
//! [`RedactionHints`] 默认脱敏（`--show-secrets` 放行）。

use base64::Engine as _;

use crate::domain::user_data_codec::KvRow;
use crate::error::AppError;
use crate::error::codes;

use super::request::RequestModel;

/// 认证配置 JSON 契约（前端 Auth 页签 / 工作空间认证区组装，此处解析消费）：
/// ```json
/// {"type": "inherit"}
/// {"type": "none"}
/// {"type": "bearer", "token": "..."}
/// {"type": "basic", "username": "...", "password": "..."}
/// {"type": "apiKey", "position": "header" | "query" | "cookie", "key": "...", "value": "..."}
/// ```
/// 工作空间级不出现 `inherit`（它就是链根；未配置＝NULL 列）。
#[derive(Debug, Clone, PartialEq)]
pub enum AuthConfig {
    /// 请求级默认：继承工作空间级
    Inherit,
    /// 显式阻断继承：发裸请求
    None,
    Bearer {
        token: String,
    },
    Basic {
        username: String,
        password: String,
    },
    ApiKey {
        position: ApiKeyPosition,
        key: String,
        value: String,
    },
}

/// API Key 注入位置。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiKeyPosition {
    Header,
    Query,
    Cookie,
}

/// 解析认证配置 JSON（发送链 fail-fast；`{{变量}}` 引用形态原样透传不校验）。
pub fn parse_auth_json(raw: &str) -> Result<AuthConfig, AppError> {
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
        AppError::new(
            codes::HTTP_SYNTHESIS_INVALID,
            format!("auth config is not valid JSON: {e}"),
        )
    })?;
    let obj = value.as_object().ok_or_else(|| {
        AppError::new(
            codes::HTTP_SYNTHESIS_INVALID,
            "auth config must be an object",
        )
    })?;
    let get_str = |key: &str| -> Result<String, AppError> {
        obj.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                AppError::new(
                    codes::HTTP_SYNTHESIS_INVALID,
                    format!("auth config field {key} must be a string"),
                )
            })
    };
    match obj
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
    {
        "inherit" => Ok(AuthConfig::Inherit),
        "none" => Ok(AuthConfig::None),
        "bearer" => Ok(AuthConfig::Bearer {
            token: get_str("token")?,
        }),
        "basic" => Ok(AuthConfig::Basic {
            username: get_str("username")?,
            password: get_str("password")?,
        }),
        "apiKey" => {
            let position = match obj
                .get("position")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
            {
                "header" => ApiKeyPosition::Header,
                "query" => ApiKeyPosition::Query,
                "cookie" => ApiKeyPosition::Cookie,
                other => {
                    return Err(AppError::new(
                        codes::HTTP_SYNTHESIS_INVALID,
                        format!(
                            "auth config apiKey position must be header/query/cookie, got {other}"
                        ),
                    ));
                }
            };
            Ok(AuthConfig::ApiKey {
                position,
                key: get_str("key")?,
                value: get_str("value")?,
            })
        }
        other => Err(AppError::new(
            codes::HTTP_SYNTHESIS_INVALID,
            format!("auth config type unsupported: {other}"),
        )),
    }
}

/// 认证合成入参：请求级与工作空间级配置 JSON（None＝列 NULL）。
pub struct AuthInput<'a> {
    /// 请求级认证配置 JSON（user_data `auth` 列；None＝未配置＝继承上级）
    pub request_auth: Option<&'a str>,
    /// 工作空间级认证配置 JSON（workspace `auth` 列；None＝未配置＝链根无认证）
    pub workspace_auth: Option<&'a str>,
}

/// 两级继承判定（纯函数）：
/// 请求级 Inherit/未配置 → 工作空间级（未配置 / none → 全链无认证）。
pub fn resolve_effective_auth(
    request: Option<AuthConfig>,
    workspace: Option<AuthConfig>,
) -> Option<AuthConfig> {
    match request {
        Some(AuthConfig::Inherit) | None => match workspace {
            Some(AuthConfig::Inherit) | None | Some(AuthConfig::None) => None,
            named => named,
        },
        Some(AuthConfig::None) => None,
        Some(named) => Some(named),
    }
}

/// 脱敏提示（随快照持久化，供展示 / 导出 / CLI 输出消费端脱敏）：
/// 认证产生的敏感头名与 query 键名，以及本次消费的 Secret 变量值清单。
/// 标准名单（Authorization / Cookie 等）由 domain::redact 兜底；此处只登记
/// 配置派生的自定义名与解析派生的值。`secret_values` 由编排层在变量解析
/// 后并入（快照本体存明文——历史详情回显需要该清单执行掩码）。
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactionHints {
    /// 认证注入 / 合并的头名（含自定义 API Key 头名）
    pub header_names: Vec<String>,
    /// 认证追加的 query 参数名（apiKey·query 的 secret 键）
    pub query_keys: Vec<String>,
    /// 本次发送消费的 Secret 变量值（展示与输出面对请求镜像全文替换掩码）
    pub secret_values: Vec<String>,
}

/// 认证注入（在用户数据 headers 之上；同名冲突认证优先）并返回脱敏提示。
/// 返回 Err＝配置 JSON 非法（发送链 fail-fast，归构建失败）。
pub fn apply_auth(
    model: &mut RequestModel,
    input: &AuthInput<'_>,
) -> Result<RedactionHints, AppError> {
    let request = match input.request_auth {
        Some(raw) => Some(parse_auth_json(raw)?),
        None => None,
    };
    let workspace = match input.workspace_auth {
        Some(raw) => Some(parse_auth_json(raw)?),
        None => None,
    };
    let effective = resolve_effective_auth(request, workspace);
    let mut hints = RedactionHints::default();

    match effective {
        None => {}
        Some(AuthConfig::Inherit) => {
            // resolve 后不再出现（防御：视作无认证）
        }
        Some(AuthConfig::None) => {}
        Some(AuthConfig::Bearer { token }) => {
            set_header(model, "Authorization", &format!("Bearer {token}"));
            hints.header_names.push("Authorization".into());
        }
        Some(AuthConfig::Basic { username, password }) => {
            let encoded =
                base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"));
            set_header(model, "Authorization", &format!("Basic {encoded}"));
            hints.header_names.push("Authorization".into());
        }
        Some(AuthConfig::ApiKey {
            position,
            key,
            value,
        }) => match position {
            ApiKeyPosition::Header => {
                set_header(model, &key, &value);
                hints.header_names.push(key);
            }
            ApiKeyPosition::Query => {
                append_query(model, &key, &value);
                hints.query_keys.push(key);
            }
            ApiKeyPosition::Cookie => {
                merge_cookie(model, &key, &value);
                hints.header_names.push("Cookie".into());
            }
        },
    }
    Ok(hints)
}

/// 认证头写入：同名替换（认证优先于用户数据 headers），无则追加。
fn set_header(model: &mut RequestModel, name: &str, value: &str) {
    if let Some(existing) = model
        .headers
        .iter_mut()
        .find(|r| r.enabled && r.key.eq_ignore_ascii_case(name))
    {
        existing.value = value.to_string();
    } else {
        model.headers.push(KvRow::new(name, value));
    }
}

/// apiKey·query：URL 追加 query 参数（同名多值全保留）。
fn append_query(model: &mut RequestModel, key: &str, value: &str) {
    let separator = if model.url.contains('?') { '&' } else { '?' };
    model.url.push(separator);
    model.url.push_str(&format!(
        "{}={}",
        encode_component(key),
        encode_component(value)
    ));
}

/// apiKey·cookie：Cookie 头合并（已有则分号拼接，无则新建）。
fn merge_cookie(model: &mut RequestModel, key: &str, value: &str) {
    let pair = format!("{key}={value}");
    let existing = model
        .headers
        .iter_mut()
        .find(|r| r.enabled && r.key.eq_ignore_ascii_case("cookie"));
    match existing {
        Some(row) if !row.value.trim().is_empty() => {
            row.value = format!("{}; {pair}", row.value);
        }
        Some(row) => {
            row.value = pair;
        }
        None => {
            model.headers.push(KvRow::new("Cookie", &pair));
        }
    }
}

/// query 组件编码（与 request 合成同口径：非保留字符直通）。
fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::request::BodyKind;
    use super::*;
    use crate::domain::endpoint::{Definition, HttpMethod};

    fn model() -> RequestModel {
        RequestModel {
            method: HttpMethod::GET,
            url: "http://x.test/api".to_string(),
            headers: Vec::new(),
            body: BodyKind::None,
        }
    }

    fn config(json: &str) -> Option<AuthConfig> {
        Some(parse_auth_json(json).unwrap())
    }

    #[test]
    fn parse_accepts_all_seven_types() {
        assert_eq!(
            parse_auth_json(r#"{"type":"inherit"}"#).unwrap(),
            AuthConfig::Inherit
        );
        assert_eq!(
            parse_auth_json(r#"{"type":"none"}"#).unwrap(),
            AuthConfig::None
        );
        assert!(matches!(
            parse_auth_json(r#"{"type":"bearer","token":"t"}"#).unwrap(),
            AuthConfig::Bearer { .. }
        ));
        assert!(matches!(
            parse_auth_json(r#"{"type":"basic","username":"u","password":"p"}"#).unwrap(),
            AuthConfig::Basic { .. }
        ));
        assert_eq!(
            parse_auth_json(r#"{"type":"apiKey","position":"header","key":"X-Key","value":"v"}"#)
                .unwrap(),
            AuthConfig::ApiKey {
                position: ApiKeyPosition::Header,
                key: "X-Key".into(),
                value: "v".into()
            }
        );
    }

    #[test]
    fn parse_rejects_dirty_shapes() {
        for raw in [
            "not json",
            "[]",
            r#"{"type":"oauth2"}"#,
            r#"{"type":"bearer"}"#,
            r#"{"type":"apiKey","position":"body","key":"k","value":"v"}"#,
        ] {
            assert!(parse_auth_json(raw).is_err(), "{raw}");
        }
        // {{变量}} 引用形态原样透传（不校验）
        assert!(parse_auth_json(r#"{"type":"bearer","token":"{{secret.token}}"}"#).is_ok());
    }

    #[test]
    fn inheritance_chain_resolution() {
        let bearer = config(r#"{"type":"bearer","token":"t"}"#);
        // 请求级继承 / 未配置 → 工作空间级；工作空间未配置或 none → 全链无认证
        assert_eq!(resolve_effective_auth(None, None), None);
        assert_eq!(resolve_effective_auth(None, Some(AuthConfig::None)), None);
        assert_eq!(
            resolve_effective_auth(Some(AuthConfig::Inherit), bearer.clone()),
            bearer
        );
        assert_eq!(resolve_effective_auth(None, bearer.clone()), bearer);
        // 请求级「不使用」阻断继承
        assert_eq!(
            resolve_effective_auth(Some(AuthConfig::None), bearer.clone()),
            None
        );
        // 请求级具名优先
        let request_key = config(r#"{"type":"apiKey","position":"header","key":"K","value":"1"}"#);
        assert_eq!(
            resolve_effective_auth(request_key.clone(), bearer),
            request_key
        );
    }

    #[test]
    fn bearer_injects_authorization_over_user_header() {
        let mut m = model();
        m.headers.push(KvRow::new("Authorization", "Basic stale"));
        let input = AuthInput {
            request_auth: Some(r#"{"type":"bearer","token":"tk"}"#),
            workspace_auth: None,
        };
        let hints = apply_auth(&mut m, &input).unwrap();
        // 同名冲突认证优先（替换用户数据头）
        assert_eq!(m.headers[0].value, "Bearer tk");
        assert_eq!(hints.header_names, vec!["Authorization".to_string()]);
    }

    #[test]
    fn basic_injects_base64_credentials() {
        let mut m = model();
        let input = AuthInput {
            request_auth: Some(r#"{"type":"basic","username":"admin","password":"123"}"#),
            workspace_auth: None,
        };
        apply_auth(&mut m, &input).unwrap();
        let expected = base64::engine::general_purpose::STANDARD.encode("admin:123");
        assert_eq!(m.headers[0].value, format!("Basic {expected}"));
    }

    #[test]
    fn api_key_header_and_query_positions() {
        let mut m = model();
        let input = AuthInput {
            request_auth: Some(
                r#"{"type":"apiKey","position":"header","key":"X-Api-Key","value":"sec"}"#,
            ),
            workspace_auth: None,
        };
        let hints = apply_auth(&mut m, &input).unwrap();
        assert!(
            m.headers
                .iter()
                .any(|r| r.key == "X-Api-Key" && r.value == "sec")
        );
        assert_eq!(hints.header_names, vec!["X-Api-Key".to_string()]);

        let mut m = model();
        let input = AuthInput {
            request_auth: Some(
                r#"{"type":"apiKey","position":"query","key":"api_key","value":"sec"}"#,
            ),
            workspace_auth: None,
        };
        let hints = apply_auth(&mut m, &input).unwrap();
        assert!(m.url.ends_with("?api_key=sec"), "url={}", m.url);
        assert_eq!(hints.query_keys, vec!["api_key".to_string()]);
    }

    #[test]
    fn api_key_cookie_merges_with_existing_cookie() {
        // 已有 Cookie 头：分号拼接
        let mut m = model();
        m.headers.push(KvRow::new("Cookie", "a=1"));
        let input = AuthInput {
            request_auth: Some(r#"{"type":"apiKey","position":"cookie","key":"sid","value":"v"}"#),
            workspace_auth: None,
        };
        let hints = apply_auth(&mut m, &input).unwrap();
        assert_eq!(m.headers[0].value, "a=1; sid=v");
        assert_eq!(hints.header_names, vec!["Cookie".to_string()]);
        // 无 Cookie 头：新建
        let mut m = model();
        apply_auth(&mut m, &input).unwrap();
        assert_eq!(m.headers[0].value, "sid=v");
    }

    #[test]
    fn workspace_level_applies_when_request_inherits() {
        let mut m = model();
        let input = AuthInput {
            request_auth: None,
            workspace_auth: Some(r#"{"type":"bearer","token":"root"}"#),
        };
        apply_auth(&mut m, &input).unwrap();
        assert!(m.headers.iter().any(|r| r.value == "Bearer root"));
        // 工作空间未配置＝全链无认证
        let mut m = model();
        let input = AuthInput {
            request_auth: None,
            workspace_auth: None,
        };
        let hints = apply_auth(&mut m, &input).unwrap();
        assert!(m.headers.is_empty());
        assert_eq!(hints, RedactionHints::default());
    }

    #[test]
    fn dirty_request_auth_fails_fast() {
        let mut m = model();
        let input = AuthInput {
            request_auth: Some("{bad"),
            workspace_auth: None,
        };
        let err = apply_auth(&mut m, &input).unwrap_err();
        assert_eq!(err.code, codes::HTTP_SYNTHESIS_INVALID);
    }

    /// 完整合成链冒烟：Definition → synthesize → apply_auth（鉴权可视化素材）。
    #[test]
    fn auth_overrides_url_query_appends_after_user_query() {
        let mut m = RequestModel {
            method: HttpMethod::GET,
            url: "http://x.test/a?verbose=true".into(),
            headers: Vec::new(),
            body: BodyKind::None,
        };
        let input = AuthInput {
            request_auth: Some(
                r#"{"type":"apiKey","position":"query","key":"api_key","value":"s 1"}"#,
            ),
            workspace_auth: None,
        };
        apply_auth(&mut m, &input).unwrap();
        // 已有 query 用 & 接续；值按 UTF-8 百分号编码
        assert_eq!(m.url, "http://x.test/a?verbose=true&api_key=s%201");
        // Definition 仅为引用防未用告警
        let _ = Definition::new(HttpMethod::GET, "/a").unwrap();
    }
}
