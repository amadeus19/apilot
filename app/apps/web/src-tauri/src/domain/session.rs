//! 工作空间会话实体：一行一工作空间＝整个「工作现场」
//! （Tab 列表 + 激活态 + 预览标记 + 树展开），按工作空间隔离。

use sqlx::FromRow;

use crate::constants::MAX_SESSION_BYTES;
use crate::error::AppError;
use crate::error::codes;

/// 会话行。`tabs` / `tree_expanded` 为前端组装的 JSON 字符串，Rust 不感知
/// 内部结构（恢复时的残留 Tab 过滤只按约定键读取，见 services 层）。
#[derive(Debug, Clone, FromRow)]
pub struct WorkspaceSession {
    pub workspace_id: String,
    pub tabs: String,
    pub tree_expanded: String,
    pub updated_at: String,
}

/// 会话保存输入（整包 upsert）。
pub struct SessionInput {
    pub tabs: String,
    pub tree_expanded: String,
}

impl SessionInput {
    /// 合计大小校验（字节；Tab 数不设硬上限，此为会话 JSON 护栏）。
    pub fn validate_size(&self) -> Result<(), AppError> {
        let total = self.tabs.len() + self.tree_expanded.len();
        if total > MAX_SESSION_BYTES {
            return Err(AppError::new(
                codes::SESSION_TOO_LARGE,
                format!("session payload exceeds {MAX_SESSION_BYTES} bytes"),
            )
            .with_details(serde_json::json!({ "limit": MAX_SESSION_BYTES, "actual": total })));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_size_accepts_normal_session() {
        let input = SessionInput {
            tabs: "[]".into(),
            tree_expanded: "[]".into(),
        };
        assert!(input.validate_size().is_ok());
    }

    #[test]
    fn validate_size_rejects_over_limit() {
        let input = SessionInput {
            tabs: "x".repeat(MAX_SESSION_BYTES + 1),
            tree_expanded: "[]".into(),
        };
        assert_eq!(
            input.validate_size().unwrap_err().code,
            codes::SESSION_TOO_LARGE
        );
    }
}
