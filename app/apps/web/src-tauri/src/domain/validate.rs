//! 名称与 URL 校验纯函数（工作空间 / 服务 / 分类 / 接口标题共用）。

use crate::constants::{MAX_BASE_URL_BYTES, MAX_ENTITY_NAME_BYTES};
use crate::error::AppError;
use crate::error::codes;

/// 名称规范化与校验：去首尾空白 → 非空 → 长度上限。
/// 返回规范化后的名称，调用方以返回值为准落库（不得使用原值）。
pub fn normalize_name(raw: &str) -> Result<String, AppError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(name_invalid("name must not be empty"));
    }
    if name.len() > MAX_ENTITY_NAME_BYTES {
        return Err(name_invalid(format!(
            "name exceeds {MAX_ENTITY_NAME_BYTES} bytes"
        )));
    }
    Ok(name.to_owned())
}

/// BaseUrl 校验：可空；配置时去首尾空白、非空、长度上限。
/// 返回 None 表示清空该字段。
pub fn normalize_base_url(raw: Option<&str>) -> Result<Option<String>, AppError> {
    let Some(raw) = raw else { return Ok(None) };
    let url = raw.trim();
    if url.is_empty() {
        return Ok(None);
    }
    if url.len() > MAX_BASE_URL_BYTES {
        return Err(AppError::new(
            codes::URL_INVALID,
            format!("base url exceeds {MAX_BASE_URL_BYTES} bytes"),
        ));
    }
    Ok(Some(url.to_owned()))
}

fn name_invalid(message: impl Into<String>) -> AppError {
    AppError::new(codes::NAME_INVALID, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_name_trims_and_accepts() {
        assert_eq!(normalize_name("  My API  ").unwrap(), "My API");
        assert_eq!(normalize_name("用户服务").unwrap(), "用户服务");
    }

    #[test]
    fn normalize_name_rejects_empty_and_blank() {
        assert_eq!(normalize_name("").unwrap_err().code, codes::NAME_INVALID);
        assert_eq!(normalize_name("   ").unwrap_err().code, codes::NAME_INVALID);
    }

    #[test]
    fn normalize_name_rejects_over_limit() {
        let long = "x".repeat(MAX_ENTITY_NAME_BYTES + 1);
        let err = normalize_name(&long).unwrap_err();
        assert_eq!(err.code, codes::NAME_INVALID);
        // 恰好在上限内（多字节字符按字节计）
        let edge = "字".repeat(MAX_ENTITY_NAME_BYTES / 3);
        assert!(normalize_name(&edge).is_ok());
    }

    #[test]
    fn normalize_base_url_trims_and_clears_blank() {
        assert_eq!(
            normalize_base_url(Some(" https://api.example.com/ "))
                .unwrap()
                .as_deref(),
            Some("https://api.example.com/")
        );
        assert_eq!(normalize_base_url(Some("   ")).unwrap(), None);
        assert_eq!(normalize_base_url(None).unwrap(), None);
    }

    #[test]
    fn normalize_base_url_rejects_over_limit() {
        let long = "h".repeat(MAX_BASE_URL_BYTES + 1);
        assert_eq!(
            normalize_base_url(Some(&long)).unwrap_err().code,
            codes::URL_INVALID
        );
    }
}
