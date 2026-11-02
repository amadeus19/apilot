//! 日志目录打开：前端 opener ACL（`opener:allow-open-path` scope
//! `$LOG`）在 Windows 上与实际路径的规范化形态（`\\?\` 前缀 / 盘符大小写 /
//! 斜杠方向）不一致时被插件 ACL 拒绝，且 scope 写法无法覆盖全部形态——
//! 改由 Rust 侧先 `canonicalize` 再 `open_path`，capability 面同步收敛
//! （default.json 已移除 opener 权限，最小权限保持）。
//!
//! BootErrorScreen 与设置面板两出口经前端 `services/log-dir.ts` 单一事实源
//! 汇入 `open_log_dir` 命令，本模块是其 Service 层。

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppError;

/// 确保目录存在并返回规范化绝对路径：目录不存在时先建（首启动未写日志前
/// 点「打开日志目录」也有目标可定位）；canonicalize 产出 `\\?\` 完整形态，
/// 资源管理器与 opener 均可接受。
pub fn ensure_canonical(dir: &Path) -> Result<PathBuf, AppError> {
    fs::create_dir_all(dir).map_err(|err| {
        AppError::new(
            crate::error::codes::IO_CREATE_DIR_FAILED,
            format!("failed to create log dir {}: {err}", dir.display()),
        )
    })?;
    dir.canonicalize().map_err(|err| {
        AppError::new(
            crate::error::codes::IO_RESOLVE_PATH_FAILED,
            format!("failed to canonicalize log dir {}: {err}", dir.display()),
        )
    })
}

/// 用系统文件管理器打开目录。
pub fn open(dir: &Path) -> Result<(), AppError> {
    let canonical = ensure_canonical(dir)?;
    tauri_plugin_opener::open_path(&canonical, None::<&str>).map_err(|err| {
        AppError::new(
            crate::error::codes::IO_OPEN_PATH_FAILED,
            format!("failed to open path {}: {err}", canonical.display()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_canonical_creates_missing_dir_and_returns_absolute_path() {
        let dir = std::env::temp_dir()
            .join(format!("apilot-logdir-test-{}", std::process::id()))
            .join("nested");
        fs::remove_dir_all(&dir).ok();
        assert!(!dir.exists());

        let canonical = ensure_canonical(&dir).unwrap();
        assert!(dir.exists());
        assert!(canonical.is_absolute());
        // Windows 规范形态带 \\?\ 前缀（opener 直调所依赖的确定性来源）
        // 部分环境下 temp_dir 本身已含前缀，此处只断言绝对化与存在性

        fs::remove_dir_all(&dir).ok();
    }
}
