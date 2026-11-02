//! 接口用户数据（草稿）实体：body / params / headers / auth 整包读写。
//!
//! params / headers / auth 为前端组装的 JSON 字符串，body 为原样文本；
//! 写路径不感知字段语义（auth 结构由发送时的 services/http/auth 解析），
//! 大小上限在服务层经 [`validate_size`] 校验（四列合计）。

use sqlx::FromRow;

use crate::constants::MAX_USER_DATA_BYTES;
use crate::error::AppError;
use crate::error::codes;

/// 接口用户数据（草稿归属接口实体，同一接口重开读同一份）。
/// `timeout_seconds`＝接口级超时覆写（NULL 继承全局 / 0 不限制 / >0 秒）；
/// `auth`＝请求级认证配置 JSON（NULL＝继承工作空间级）；
/// `path_override`＝路径覆写（NULL＝跟随接口定义；发送时覆写优先，
/// 定义侧随同步文档更新，互不干扰）。
#[derive(Debug, Clone, FromRow)]
pub struct EndpointUserData {
    pub service_id: String,
    pub key: String,
    pub body: Option<String>,
    pub params: String,
    pub headers: String,
    pub timeout_seconds: Option<i64>,
    pub auth: Option<String>,
    pub path_override: Option<String>,
    pub method_override: Option<String>,
    pub updated_at: String,
}

/// 接口级超时秒数上限（护栏：UI 自定义秒数输入的可容上限）
pub const MAX_ENDPOINT_TIMEOUT_SECONDS: i64 = 86_400;

/// 整包写入输入（body / params / headers / timeout_seconds / auth /
/// path_override 一次 upsert）。
pub struct UserDataInput {
    pub body: Option<String>,
    pub params: String,
    pub headers: String,
    pub timeout_seconds: Option<i64>,
    pub auth: Option<String>,
    /// 路径覆写（None＝跟随定义；Some 空白串由服务层归一为 None）
    pub path_override: Option<String>,
    /// 方法覆写（None＝跟随定义；Some 空白串由服务层归一为 None）
    pub method_override: Option<String>,
}

impl UserDataInput {
    /// 四列合计大小校验（字节；一切缓冲有界）。
    pub fn validate_size(&self) -> Result<(), AppError> {
        let total = self.body.as_deref().map_or(0, str::len)
            + self.params.len()
            + self.headers.len()
            + self.auth.as_deref().map_or(0, str::len);
        if total > MAX_USER_DATA_BYTES {
            return Err(AppError::new(
                codes::USER_DATA_TOO_LARGE,
                format!("user data exceeds {MAX_USER_DATA_BYTES} bytes"),
            )
            .with_details(serde_json::json!({ "limit": MAX_USER_DATA_BYTES, "actual": total })));
        }
        Ok(())
    }

    /// 超时覆写值域校验：NULL（继承）/ 0（不限制）/ 1..=上限（秒）。
    pub fn validate_timeout(&self) -> Result<(), AppError> {
        if let Some(secs) = self.timeout_seconds
            && !(0..=MAX_ENDPOINT_TIMEOUT_SECONDS).contains(&secs)
        {
            return Err(AppError::new(
                codes::INVALID_ARGUMENT,
                format!("timeout seconds must be 0..={MAX_ENDPOINT_TIMEOUT_SECONDS} or null"),
            ));
        }
        Ok(())
    }

    /// 路径覆写形状校验：与接口定义路径同一校验器（相对模板或绝对 URL）。
    /// 仅校验非空覆写值；空白串（归一前的中间态）不在此拒绝，由服务层归一。
    pub fn validate_path_override(&self) -> Result<(), AppError> {
        if let Some(path) = self.path_override.as_deref().map(str::trim)
            && !path.is_empty()
        {
            crate::domain::endpoint::validate_path_template(path)?;
        }
        Ok(())
    }

    /// 方法覆写校验：七选之外拒绝（与接口定义方法同一解析器）。
    pub fn validate_method_override(&self) -> Result<(), AppError> {
        if let Some(method) = self.method_override.as_deref().map(str::trim)
            && !method.is_empty()
        {
            crate::domain::endpoint::HttpMethod::parse(method)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_size_accepts_within_limit() {
        let input = UserDataInput {
            body: Some("{\"a\":1}".into()),
            params: "[]".into(),
            headers: "{}".into(),
            timeout_seconds: None,
            auth: None,
            path_override: None,
            method_override: None,
        };
        assert!(input.validate_size().is_ok());
    }

    #[test]
    fn validate_size_rejects_total_over_limit() {
        // 三列各自都在限内、合计超限同样拒绝（上限按合计计）
        let third = "x".repeat(MAX_USER_DATA_BYTES / 2 + 8);
        let input = UserDataInput {
            body: Some(third.clone()),
            params: third.clone(),
            headers: third,
            timeout_seconds: None,
            auth: None,
            path_override: None,
            method_override: None,
        };
        let err = input.validate_size().unwrap_err();
        assert_eq!(err.code, codes::USER_DATA_TOO_LARGE);
        assert!(err.details.is_some());
    }

    #[test]
    fn validate_size_treats_missing_body_as_zero() {
        let input = UserDataInput {
            body: None,
            params: "[]".into(),
            headers: "{}".into(),
            timeout_seconds: None,
            auth: None,
            path_override: None,
            method_override: None,
        };
        assert!(input.validate_size().is_ok());
    }
}
