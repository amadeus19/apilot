//! 数据目录发现（headless 侧）：
//! `<RoamingAppData>/<APP_IDENTIFIER>`，经 windows-sys known folder API 解析。
//!
//! 不用 `%APPDATA%` 环境变量（被用户改动时会与 GUI 侧漂移）；GUI 侧不经此
//! 模块——Tauri path resolver 是 GUI 的权威（`app_data_dir()` 底层同为
//! `FOLDERID_RoamingAppData`，两侧同源不同实现）。`resolve_data_dir` 只允许
//! 在两入口 main 调用，测试一律构造注入目录；E2E 子进程经 `APILOT_DATA_DIR`
//! 注入替代目录（多实例隔离同理），绝不触碰生产数据。

use std::ffi::OsString;
use std::path::PathBuf;

use crate::error::AppError;
use crate::error::codes;

#[cfg(windows)]
use windows_sys::Win32::System::Com::CoTaskMemFree;
#[cfg(windows)]
use windows_sys::Win32::UI::Shell::{FOLDERID_RoamingAppData, SHGetKnownFolderPath};
#[cfg(windows)]
use windows_sys::core::PWSTR;

use crate::constants::APP_IDENTIFIER;

/// 数据目录环境注入缝：设置后 `resolve_data_dir` 直接以该值作为数据目录
/// （不再拼接 APP_IDENTIFIER）。供 E2E 子进程测试与多实例隔离使用；
/// 置空字符串视为显式错误（防脚本静默回退到生产目录）。
pub const DATA_DIR_ENV: &str = "APILOT_DATA_DIR";

/// 解析应用数据目录（只发现不创建；目录创建归 DB 初始化链）。
pub fn resolve_data_dir() -> Result<PathBuf, AppError> {
    resolve_from(std::env::var_os(DATA_DIR_ENV))
}

/// 注入缝判定与生产解析的纯逻辑分离：override 值（`Some(空串)`＝显式错误）
/// 优先，否则走 known folder。
fn resolve_from(override_dir: Option<OsString>) -> Result<PathBuf, AppError> {
    if let Some(dir) = override_dir {
        if dir.is_empty() {
            return Err(AppError::new(
                codes::INVALID_ARGUMENT,
                format!("{DATA_DIR_ENV} is set but empty; unset it or provide a directory"),
            ));
        }
        return Ok(PathBuf::from(dir));
    }
    #[cfg(windows)]
    {
        let roaming = known_folder_roaming_app_data()?;
        Ok(roaming.join(APP_IDENTIFIER))
    }
    #[cfg(not(windows))]
    {
        Err(AppError::new(
            codes::IO_RESOLVE_PATH_FAILED,
            "data dir resolution is only implemented for windows",
        ))
    }
}

/// `FOLDERID_RoamingAppData` known folder 解析（Windows 优先产品；
/// 其余平台待进入交付范围时按同语义落地，编译期显式拒绝而非静默漂移）。
#[cfg(windows)]
fn known_folder_roaming_app_data() -> Result<PathBuf, AppError> {
    unsafe {
        let mut path_ptr: PWSTR = std::ptr::null_mut();
        // 不要求调用方初始化 COM（dirs 生态同款直接调用）
        let hr = SHGetKnownFolderPath(
            &FOLDERID_RoamingAppData,
            0,
            std::ptr::null_mut(),
            &mut path_ptr,
        );
        if hr != 0 {
            return Err(AppError::new(
                codes::IO_RESOLVE_PATH_FAILED,
                format!("SHGetKnownFolderPath(RoamingAppData) failed: hr=0x{hr:08x}"),
            ));
        }
        // PWSTR 为调用方须释放的 CoTaskMemAlloc 缓冲：先取长度再释放
        let mut len = 0usize;
        while *path_ptr.add(len) != 0 {
            len += 1;
        }
        let value = String::from_utf16_lossy(std::slice::from_raw_parts(path_ptr, len));
        CoTaskMemFree(path_ptr.cast());
        if value.is_empty() {
            return Err(AppError::new(
                codes::IO_RESOLVE_PATH_FAILED,
                "SHGetKnownFolderPath(RoamingAppData) returned an empty path",
            ));
        }
        Ok(PathBuf::from(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// known folder 解析结果必须是规范的应用数据目录：
    /// 绝对路径、末段为 APP_IDENTIFIER、父目录真实存在（RoamingAppData 本体）。
    #[cfg(windows)]
    #[test]
    fn resolved_data_dir_is_canonical() {
        let dir = resolve_data_dir().unwrap();
        assert!(dir.is_absolute(), "not absolute: {}", dir.display());
        assert_eq!(dir.file_name().unwrap().to_str(), Some(APP_IDENTIFIER));
        let parent = dir.parent().unwrap();
        assert!(
            parent.exists(),
            "RoamingAppData parent must exist: {}",
            parent.display()
        );
    }

    /// 环境注入缝：设置值整体作为数据目录（E2E 子进程测试的构造注入面）；
    /// 空串显式报错，不得静默回退生产目录。
    #[test]
    fn env_override_takes_whole_value_and_rejects_empty() {
        let dir = resolve_from(Some(OsString::from("Z:\\apilot-e2e-fixture"))).unwrap();
        assert_eq!(dir, PathBuf::from("Z:\\apilot-e2e-fixture"));
        let err = resolve_from(Some(OsString::from(""))).unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);
    }
}
