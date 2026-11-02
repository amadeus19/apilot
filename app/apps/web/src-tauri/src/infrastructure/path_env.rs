//! 用户 PATH 注册表读写、系统 PATH 只读、命令解析与环境变量广播
//! （双进程 CLI 可用性）。
//!
//! 机制事实（官方文档核实）：`setx` 会静默截断 1024 字符并展开 `%VAR%`
//! 引用，必须走注册表读-改-写；取尺寸＝`lpData=NULL` 探测一趟，文档口径
//! 此时返回 `ERROR_SUCCESS` 并把所需字节数回填 `lpcbData`（值缺失＝
//! `ERROR_FILE_NOT_FOUND`）；`RegQueryValueExW` 取原始未展开值，
//! 写回恒 `REG_EXPAND_SZ`；`WM_SETTINGCHANGE` 广播须在后台线程（总耗时
//! ＝超时×顶层窗口数），`SendMessageTimeoutW`＋`SMTO_ABORTIFHUNG` 兜底
//! 挂死窗口。
//!
//! 条目匹配口径：**只有本安装目录的条目按大小写不敏感比较**（Windows
//! 路径不区分大小写，精确匹配会让旧版写入的大小写变体同时出现假阴性与
//! 漏删）；用户其余条目逐字不动——不重排、不删、不规整。
//!
//! 注册目标＝GUI 安装目录（Tauri per-user 安装路径固定，更新覆盖不变），
//! 即当前进程 exe 所在目录——`apilot.exe` 与 `app.exe` 同目录部署。

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE, REG_EXPAND_SZ, RegCloseKey,
    RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE,
};

use crate::error::AppError;
use crate::error::codes;

/// 用户环境变量的注册表子键与值名（Windows 定值）。
const ENV_SUBKEY: &str = "Environment";
/// 系统环境变量的注册表子键（`HKLM` 下，只读——应用永不写系统 PATH）。
const SYSTEM_ENV_SUBKEY: &str = "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
const PATH_VALUE_NAME: &str = "Path";
/// 广播超时：单窗口上限 5s（窗口挂死经 SMTO_ABORTIFHUNG 提前放弃）。
const BROADCAST_TIMEOUT_MS: u32 = 5000;
/// CLI 二进制文件名（与 GUI 同目录；命令解析按此名逐目录探测）。
pub(crate) const CLI_EXE_NAME: &str = "apilot.exe";

/// PATH 注册表读写接缝：services 层编排经此注入，测试以内存实现替换
/// （真实注册表写入只做一次性人工验证，不进自动化）。
pub(crate) trait PathRegistry: Send + Sync {
    /// 读用户 PATH 原始条目（未展开 `%VAR%`；值不存在＝空清单）。
    fn read(&self) -> Result<Vec<String>, AppError>;
    /// 整表写回（保持既有条目原样，仅增删目标条目）。
    fn write(&self, entries: &[String]) -> Result<(), AppError>;
    /// 读系统 PATH 原始条目（只读，供命令解析对账；值不存在＝空清单）。
    fn read_system(&self) -> Result<Vec<String>, AppError>;
}

/// 真实实现：`HKCU\Environment` 的 `Path` 值（读写）＋
/// `HKLM\...\Session Manager\Environment` 的 `Path` 值（只读）。
pub(crate) struct UserPathRegistry;

impl PathRegistry for UserPathRegistry {
    fn read(&self) -> Result<Vec<String>, AppError> {
        read_path_value(HKEY_CURRENT_USER, ENV_SUBKEY)
    }

    fn write(&self, entries: &[String]) -> Result<(), AppError> {
        write_user_path(entries)
    }

    fn read_system(&self) -> Result<Vec<String>, AppError> {
        read_path_value(HKEY_LOCAL_MACHINE, SYSTEM_ENV_SUBKEY)
    }
}

/// 宽字符辅助：Rust 字符串 → 以 NUL 结尾的 UTF-16。
fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// 第一趟尺寸探测（`lpData=NULL`、`lpcbData` 非 NULL）结果分类：Windows
/// 文档口径此时返回 `ERROR_SUCCESS` 并把所需字节数回填 `lpcbData`；
/// `ERROR_FILE_NOT_FOUND`＝值缺失（首启形态，空清单非错误）；其余状态＝
/// 真失败。真实注册表不进自动化，判定语义以纯函数形态在此锁定。
fn classify_size_probe(status: u32, size: u32) -> Result<Option<u32>, u32> {
    match status {
        ERROR_SUCCESS => Ok(Some(size)),
        ERROR_FILE_NOT_FOUND => Ok(None),
        _ => Err(status),
    }
}

/// PATH 值单趟查询接缝：与 `RegQueryValueExW` 同语义——`data` 为空指针＝
/// 尺寸探测（返回状态码并回填所需字节数），非空＝整读（回填实际字节数）。
/// 真实实现闭包捕获已打开的句柄；测试以内存实现模拟真实返回行为，
/// 锁定「探测传 NULL、尺寸喂给整读」的调用点接线。
fn query_path_value<Q>(mut query: Q) -> Result<Vec<String>, AppError>
where
    Q: FnMut(*mut u8, &mut u32) -> u32,
{
    let mut size: u32 = 0;
    // 第一趟只取尺寸（lpData=NULL）：分类语义见 classify_size_probe
    let status = query(std::ptr::null_mut(), &mut size);
    let size = match classify_size_probe(status, size) {
        Ok(Some(size)) => size,
        Ok(None) => return Ok(Vec::new()),
        Err(status) => return Err(reg_error("query size", status)),
    };
    // 第二趟按探测尺寸整读
    let mut raw = vec![0u8; size as usize];
    let mut actual = raw.len() as u32;
    let status = query(raw.as_mut_ptr(), &mut actual);
    if status != ERROR_SUCCESS {
        return Err(reg_error("query", status));
    }
    Ok(split_path(&utf16_from_bytes(&raw[..actual as usize])))
}

/// 读指定根键下 `Path` 值（原始未展开）。值缺失＝空清单（用户 PATH 首启
/// 形态，非错误）。用户 PATH 与系统 PATH 共用此读取路径，仅根键与子键不同。
fn read_path_value(root: HKEY, subkey: &str) -> Result<Vec<String>, AppError> {
    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let status = RegOpenKeyExW(root, wide(subkey).as_ptr(), 0, KEY_READ, &mut hkey);
        if status != ERROR_SUCCESS {
            return Err(reg_error("open", status));
        }
        let name = wide(PATH_VALUE_NAME);
        let mut reg_type: u32 = 0;
        let result = query_path_value(|data, len| {
            RegQueryValueExW(
                hkey,
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut reg_type,
                data,
                len,
            )
        });
        RegCloseKey(hkey);
        result
    }
}

/// 注册表 UTF-16 缓冲（`actual` 字节，含结尾 NUL）→ String。
fn utf16_from_bytes(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .take_while(|&unit| unit != 0)
        .collect();
    String::from_utf16_lossy(&units)
}

/// 整表写回（恒 `REG_EXPAND_SZ`，保留 `%VAR%` 引用不展开）。
fn write_user_path(entries: &[String]) -> Result<(), AppError> {
    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let status = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            wide(ENV_SUBKEY).as_ptr(),
            0,
            KEY_READ | KEY_WRITE,
            &mut hkey,
        );
        if status != ERROR_SUCCESS {
            return Err(reg_error("open for write", status));
        }
        let mut value = join_path(entries);
        if !value.is_empty() {
            value.push(';');
        }
        // REG_EXPAND_SZ 以 NUL 结尾：写入长度按字节数含结尾两个 0x00
        let mut units = value.encode_utf16().collect::<Vec<u16>>();
        units.push(0);
        let bytes = units.len() * 2;
        let status = RegSetValueExW(
            hkey,
            wide(PATH_VALUE_NAME).as_ptr(),
            0,
            REG_EXPAND_SZ,
            units.as_ptr().cast(),
            bytes as u32,
        );
        RegCloseKey(hkey);
        if status != ERROR_SUCCESS {
            return Err(reg_error("write", status));
        }
        Ok(())
    }
}

fn reg_error(action: &str, status: u32) -> AppError {
    AppError::new(
        codes::CLI_PATH_REGISTRY_FAILED,
        format!("registry {action} failed: status=0x{status:08x}"),
    )
}

/// 原始 PATH 值 → 条目清单（`;` 分隔；空段丢弃；条目内容原样保留）。
pub(crate) fn split_path(raw: &str) -> Vec<String> {
    raw.split(';')
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
}

/// 条目清单 → 原始 PATH 值（结尾 `;` 由写回层统一补，不在此处拼接）。
pub(crate) fn join_path(entries: &[String]) -> String {
    entries.join(";")
}

/// 本安装目录条目的匹配口径（判定 / 追加判重 / 注销过滤 / 命令解析命中
/// 共用单点）：大小写不敏感的整段比较。只拿它比对自身目录字符串，用户其余
/// 条目不经过此函数，因此没有误伤他人条目的通路。
pub(crate) fn is_own_entry(entry: &str, own_dir: &str) -> bool {
    entry.to_lowercase() == own_dir.to_lowercase()
}

/// 注册态判定：用户 PATH 是否含本安装目录条目（开关显示态的唯一来源）。
pub(crate) fn is_registered(entries: &[String], own_dir: &str) -> bool {
    entries.iter().any(|existing| is_own_entry(existing, own_dir))
}

/// 追加注册条目：已存在（含大小写变体）则原清单原样返回（幂等，重复开关
/// 不产生重复条目）；其余条目不规范化、不重排。
pub(crate) fn append_entry(mut entries: Vec<String>, entry: &str) -> Vec<String> {
    if is_registered(&entries, entry) {
        return entries;
    }
    entries.push(entry.to_owned());
    entries
}

/// 注销注册条目：移除本目录的全部大小写变体；其余条目原样保留。
pub(crate) fn remove_entry(mut entries: Vec<String>, entry: &str) -> Vec<String> {
    entries.retain(|existing| !is_own_entry(existing, entry));
    entries
}

/// 展开条目中的 `%VAR%` 引用（注册表原始值未展开，探测文件前须展开）。
/// 语义对齐 `ExpandEnvironmentStrings`：已定义变量替换为值，未定义的引用
/// 与不成对的 `%` 原样保留。查值函数注入（生产取进程环境，测试喂固定表）。
pub(crate) fn expand_env_refs(entry: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(entry.len());
    let mut rest = entry;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else {
            // 不成对的 `%`：余下全部按字面保留
            out.push_str(&rest[start..]);
            return out;
        };
        let name = &after[..end];
        match lookup(name) {
            Some(value) if !name.is_empty() => out.push_str(&value),
            _ => {
                out.push('%');
                out.push_str(name);
                out.push('%');
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// 是否开发构建目录：`tauri dev` 的 exe 落在 cargo `target` 目录下，注册进
/// PATH 的是开发目录而非安装目录，正式安装后需重新注册。
pub(crate) fn is_dev_build_dir(dir: &Path) -> bool {
    dir.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|name| name.eq_ignore_ascii_case("target"))
    })
}

/// 命令解析结果：「终端敲 `apilot` 会执行谁」的只读对账。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CommandResolution {
    /// 第一个含 `apilot.exe` 的目录（已展开 `%VAR%`）；`None`＝全链未命中
    pub resolved_dir: Option<String>,
    /// 命中目录是否为本安装目录
    pub resolved_is_own: bool,
    /// 用户 PATH 中本目录之外、解析顺序在首个命中之后且含 `apilot.exe` 的
    /// 条目（旧安装遗留，被遮蔽故无害；只报告，不清理）
    pub stale_dirs: Vec<String>,
}

/// 按终端解析顺序（系统 PATH 在前、用户 PATH 在后）逐目录探测 `apilot.exe`，
/// 第一个命中即结果。纯函数：条目清单与文件存在性探针均由调用方注入，
/// 不拉进程、不写注册表。
pub(crate) fn resolve_command(
    system_entries: &[String],
    user_entries: &[String],
    own_dir: &str,
    expand: &dyn Fn(&str) -> String,
    exists: &dyn Fn(&Path) -> bool,
) -> CommandResolution {
    let mut resolved: Option<(String, bool)> = None;
    let mut stale_dirs = Vec::new();
    let ordered = system_entries
        .iter()
        .map(|entry| (entry, false))
        .chain(user_entries.iter().map(|entry| (entry, true)));
    for (raw, from_user) in ordered {
        let expanded = expand(raw);
        if !exists(&Path::new(&expanded).join(CLI_EXE_NAME)) {
            continue;
        }
        let is_own = is_own_entry(&expanded, own_dir);
        if resolved.is_none() {
            resolved = Some((expanded, is_own));
        } else if from_user && !is_own {
            stale_dirs.push(expanded);
        }
    }
    let (resolved_dir, resolved_is_own) = match resolved {
        Some((dir, is_own)) => (Some(dir), is_own),
        None => (None, false),
    };
    CommandResolution {
        resolved_dir,
        resolved_is_own,
        stale_dirs,
    }
}

/// 当前进程 exe 所在目录（＝GUI 安装目录，`apilot.exe` 与 `app.exe` 同目录）。
pub(crate) fn install_dir() -> Result<PathBuf, AppError> {
    let exe = std::env::current_exe()
        .map_err(|err| AppError::internal(format!("failed to locate current executable: {err}")))?;
    exe.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| AppError::internal("executable has no parent directory"))
}

/// `WM_SETTINGCHANGE` 广播（后台线程）：让资源管理器与新开终端感知环境变化。
/// 线程内失败与线程创建失败均静默（广播是尽力而为语义，注册已落表、
/// 新进程读注册表取值不受影响；开关路径不得因此失败或 panic）。
pub(crate) fn broadcast_env_change() {
    let payload = wide("Environment");
    // 'static 泄漏一份定长 UTF-16 缓冲：后台线程持有裸指针跨生命周期，
    // 每次开关泄漏一份（开关级频次，量级恒定可忽略）
    let leaked: &'static [u16] = Box::leak(payload.into_boxed_slice());
    let spawned = std::thread::Builder::new()
        .name("env-change-broadcast".into())
        .spawn(move || unsafe {
            let lparam = leaked.as_ptr() as isize;
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0usize,
                lparam,
                SMTO_ABORTIFHUNG,
                BROADCAST_TIMEOUT_MS,
                std::ptr::null_mut(),
            );
        });
    let _ = spawned;
}

#[cfg(test)]
mod tests {
    use super::*;

    use windows_sys::Win32::Foundation::{
        ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA,
    };

    // —— 自身条目三处口径（判定 / 追加判重 / 注销过滤）：大小写不敏感，
    // 其余条目逐字不动 ——
    #[test]
    fn registered_detects_case_variants_of_own_dir() {
        let entries = vec!["C:\\Tools".to_owned(), "c:\\apps\\apilot".to_owned()];
        assert!(is_registered(&entries, "C:\\Apps\\APilot"));
        assert!(!is_registered(&entries, "C:\\Apps\\Other"));
        assert!(!is_registered(&[], "C:\\Apps\\APilot"));
    }

    #[test]
    fn append_is_idempotent_ignoring_case_of_own_dir() {
        let entries = vec!["C:\\Tools".to_owned(), "%JAVA_HOME%\\bin".to_owned()];
        let appended = append_entry(entries.clone(), "C:\\Apps\\APilot");
        assert_eq!(appended.len(), 3);
        // 重复开关：不产生重复条目
        let again = append_entry(appended.clone(), "C:\\Apps\\APilot");
        assert_eq!(again.len(), 3);
        // 旧版写入的大小写变体已在：视为已注册，不再追加
        let variant = append_entry(appended, "c:\\apps\\apilot");
        assert_eq!(variant.len(), 3);
        // 他人条目的大小写变体不是自身目录：照常追加，且原条目逐字不动
        let other = append_entry(entries.clone(), "c:\\tools\\sub");
        assert_eq!(other.len(), 3);
        assert_eq!(&other[..2], &entries[..]);
    }

    #[test]
    fn remove_drops_all_own_variants_and_keeps_others_verbatim() {
        let entries = vec![
            "C:\\Apps\\APilot".to_owned(),
            "C:\\Tools".to_owned(),
            "c:\\apps\\apilot".to_owned(),
            "%JAVA_HOME%\\bin".to_owned(),
            "C:\\tools".to_owned(),
        ];
        let remaining = remove_entry(entries, "C:\\APPS\\APILOT");
        // 自身两处变体删净；他人条目（含互为大小写变体的两条）原样、原序保留
        assert_eq!(
            remaining,
            vec![
                "C:\\Tools".to_owned(),
                "%JAVA_HOME%\\bin".to_owned(),
                "C:\\tools".to_owned(),
            ]
        );
    }

    // —— `%VAR%` 展开 ——
    #[test]
    fn expand_replaces_defined_refs_and_keeps_undefined_literal() {
        let lookup = |name: &str| match name {
            "JAVA_HOME" => Some("C:\\Java".to_owned()),
            "USERPROFILE" => Some("C:\\Users\\me".to_owned()),
            _ => None,
        };
        assert_eq!(expand_env_refs("%JAVA_HOME%\\bin", &lookup), "C:\\Java\\bin");
        assert_eq!(
            expand_env_refs("%USERPROFILE%\\%JAVA_HOME%", &lookup),
            "C:\\Users\\me\\C:\\Java"
        );
        // 未定义引用原样保留（与 ExpandEnvironmentStrings 一致）
        assert_eq!(expand_env_refs("%NOPE%\\bin", &lookup), "%NOPE%\\bin");
        // 不成对的 `%` 与空名引用都按字面保留
        assert_eq!(expand_env_refs("C:\\50%off", &lookup), "C:\\50%off");
        assert_eq!(expand_env_refs("a%%b", &lookup), "a%%b");
        // 无引用条目零改动
        assert_eq!(expand_env_refs("C:\\Plain", &lookup), "C:\\Plain");
    }

    // —— 开发构建目录判定 ——
    #[test]
    fn dev_build_dir_is_any_path_under_target() {
        assert!(is_dev_build_dir(Path::new(
            "D:\\repo\\app\\apps\\web\\src-tauri\\target\\debug"
        )));
        assert!(is_dev_build_dir(Path::new("D:\\repo\\TARGET\\release")));
        assert!(!is_dev_build_dir(Path::new(
            "C:\\Users\\me\\AppData\\Local\\Programs\\Apilot"
        )));
        // 「target」只认整段目录名，不认子串
        assert!(!is_dev_build_dir(Path::new("C:\\Apps\\targeted\\bin")));
    }

    // —— 命令解析纯函数：系统在前、用户在后，首命中即结果 ——
    const OWN: &str = "C:\\Apps\\APilot";

    /// 文件存在性探针：给定目录集合视为含 apilot.exe（大小写不敏感比较目录）
    fn exe_in(dirs: &'static [&'static str]) -> impl Fn(&Path) -> bool {
        move |path: &Path| {
            let parent = path.parent().map(|p| p.to_string_lossy().to_lowercase());
            path.file_name().is_some_and(|name| name == CLI_EXE_NAME)
                && parent.is_some_and(|dir| dirs.iter().any(|d| d.to_lowercase() == dir))
        }
    }

    fn no_expand(entry: &str) -> String {
        entry.to_owned()
    }

    fn owned(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|e| (*e).to_owned()).collect()
    }

    #[test]
    fn resolve_hits_own_dir_when_first_in_order() {
        let resolution = resolve_command(
            &owned(&["C:\\Windows"]),
            &owned(&["C:\\Tools", OWN]),
            OWN,
            &no_expand,
            &exe_in(&[OWN]),
        );
        assert_eq!(
            resolution,
            CommandResolution {
                resolved_dir: Some(OWN.to_owned()),
                resolved_is_own: true,
                stale_dirs: vec![],
            }
        );
    }

    #[test]
    fn resolve_reports_shadowing_when_system_path_hits_first() {
        let resolution = resolve_command(
            &owned(&["C:\\Windows", "C:\\OldApilot"]),
            &owned(&[OWN]),
            OWN,
            &no_expand,
            &exe_in(&["C:\\OldApilot", OWN]),
        );
        assert_eq!(resolution.resolved_dir.as_deref(), Some("C:\\OldApilot"));
        assert!(!resolution.resolved_is_own);
        // 本目录在后被遮蔽：不算残留（残留专指本目录之外的条目）
        assert!(resolution.stale_dirs.is_empty());
    }

    #[test]
    fn resolve_reports_shadowing_when_user_path_hits_other_dir_first() {
        let resolution = resolve_command(
            &[],
            &owned(&["C:\\OldApilot", OWN]),
            OWN,
            &no_expand,
            &exe_in(&["C:\\OldApilot", OWN]),
        );
        assert_eq!(resolution.resolved_dir.as_deref(), Some("C:\\OldApilot"));
        assert!(!resolution.resolved_is_own);
    }

    #[test]
    fn resolve_collects_stale_user_entries_after_own_hit() {
        let resolution = resolve_command(
            &[],
            &owned(&[OWN, "C:\\Tools", "C:\\OldApilot", "c:\\apps\\apilot", "D:\\Older"]),
            OWN,
            &no_expand,
            &exe_in(&[OWN, "C:\\OldApilot", "D:\\Older"]),
        );
        assert!(resolution.resolved_is_own);
        // 本目录之后含 apilot.exe 的他目录＝残留；本目录大小写变体与无 exe 的
        // 目录都不计入
        assert_eq!(
            resolution.stale_dirs,
            vec!["C:\\OldApilot".to_owned(), "D:\\Older".to_owned()]
        );
    }

    #[test]
    fn resolve_returns_none_when_no_entry_has_exe() {
        let resolution = resolve_command(
            &owned(&["C:\\Windows"]),
            &owned(&["C:\\Tools"]),
            OWN,
            &no_expand,
            &exe_in(&[]),
        );
        assert_eq!(resolution.resolved_dir, None);
        assert!(!resolution.resolved_is_own);
        assert!(resolution.stale_dirs.is_empty());
    }

    #[test]
    fn resolve_expands_refs_before_probing_and_reports_expanded_dir() {
        let expand = |entry: &str| {
            expand_env_refs(entry, &|name| {
                (name == "LOCALAPPDATA").then(|| "C:\\Users\\me\\AppData\\Local".to_owned())
            })
        };
        let resolution = resolve_command(
            &[],
            &owned(&["%LOCALAPPDATA%\\Programs\\Apilot"]),
            "C:\\Users\\me\\AppData\\Local\\Programs\\Apilot",
            &expand,
            &exe_in(&["C:\\Users\\me\\AppData\\Local\\Programs\\Apilot"]),
        );
        // 展开后参与探测，展开形态命中本目录；报告的是展开后的目录
        assert_eq!(
            resolution.resolved_dir.as_deref(),
            Some("C:\\Users\\me\\AppData\\Local\\Programs\\Apilot")
        );
        assert!(resolution.resolved_is_own);
    }

    #[test]
    fn split_drops_empty_segments_and_keeps_references() {
        let entries = split_path("C:\\A;;%JAVA_HOME%\\bin;");
        assert_eq!(
            entries,
            vec!["C:\\A".to_owned(), "%JAVA_HOME%\\bin".to_owned()]
        );
        assert!(split_path("").is_empty());
    }

    #[test]
    fn join_roundtrips_through_split() {
        let entries = vec!["C:\\A".to_owned(), "C:\\B C".to_owned()];
        assert_eq!(split_path(&join_path(&entries)), entries);
    }

    // —— 第一趟尺寸探测（lpData=NULL 取尺寸）的分类：真实注册表不进自动化，
    // 判定语义收敛为纯函数在此锁定 ——
    #[test]
    fn size_probe_accepts_success_with_filled_size() {
        // Windows 文档口径：lpData=NULL 且 lpcbData 非 NULL 时返回 ERROR_SUCCESS
        // 并回填所需字节数——0x00000000 是成功而非失败；ERROR_MORE_DATA 语义
        // 是缓冲区过小，仅 lpData 非 NULL 时出现
        assert_eq!(classify_size_probe(ERROR_SUCCESS, 1024), Ok(Some(1024)));
    }

    #[test]
    fn size_probe_treats_missing_value_as_empty_list() {
        assert_eq!(classify_size_probe(ERROR_FILE_NOT_FOUND, 0), Ok(None));
    }

    #[test]
    fn size_probe_rejects_unexpected_status() {
        assert_eq!(classify_size_probe(ERROR_MORE_DATA, 0), Err(ERROR_MORE_DATA));
        assert_eq!(
            classify_size_probe(ERROR_ACCESS_DENIED, 0),
            Err(ERROR_ACCESS_DENIED)
        );
    }

    // —— query_path_value 接缝：模拟真实注册表返回行为，锁定调用点接线 ——
    /// 模拟真实 PATH 值查询：探测趟（data 为空指针）返回 SUCCESS＋所需字节
    /// 数，整读趟回填内容字节；趟序与指针形态不符即断言失败（不进 UB 路径）。
    fn seeded_query(units: &[u16]) -> impl FnMut(*mut u8, &mut u32) -> u32 + '_ {
        let seeded: Vec<u8> = units.iter().flat_map(|unit| unit.to_le_bytes()).collect();
        let probed = std::cell::Cell::new(false);
        move |data: *mut u8, len: &mut u32| -> u32 {
            if data.is_null() {
                assert!(!probed.get(), "探测趟至多一次");
                probed.set(true);
                *len = seeded.len() as u32;
                return ERROR_SUCCESS;
            }
            assert!(probed.get(), "整读趟必须先探测");
            unsafe {
                std::ptr::copy_nonoverlapping(seeded.as_ptr(), data, seeded.len())
            };
            *len = seeded.len() as u32;
            ERROR_SUCCESS
        }
    }

    #[test]
    fn seam_reads_entries_via_probe_then_full_read() {
        // 「C:\A」的 UTF-16＋结尾 NUL：探测回填尺寸，整读按实际字节数切片
        let units: Vec<u16> = "C:\\A".encode_utf16().chain(std::iter::once(0)).collect();
        let entries = query_path_value(seeded_query(&units)).unwrap();
        assert_eq!(entries, vec!["C:\\A".to_owned()]);
    }

    #[test]
    fn seam_returns_empty_list_when_value_missing() {
        let missing = |data: *mut u8, len: &mut u32| -> u32 {
            assert!(data.is_null(), "值缺失时只会发生探测趟");
            *len = 0;
            ERROR_FILE_NOT_FOUND
        };
        assert!(query_path_value(missing).unwrap().is_empty());
    }

    #[test]
    fn seam_maps_unexpected_probe_status_to_registry_error() {
        let denied = |data: *mut u8, _len: &mut u32| -> u32 {
            assert!(data.is_null());
            ERROR_ACCESS_DENIED
        };
        let err = query_path_value(denied).unwrap_err();
        assert_eq!(err.code, codes::CLI_PATH_REGISTRY_FAILED);
        assert!(err.message.contains("query size"), "{}", err.message);
    }

    #[test]
    fn seam_reports_full_read_failure() {
        let flaky = |data: *mut u8, len: &mut u32| -> u32 {
            if data.is_null() {
                *len = 10;
                return ERROR_SUCCESS;
            }
            ERROR_ACCESS_DENIED
        };
        let err = query_path_value(flaky).unwrap_err();
        assert!(err.message.contains("query"), "{}", err.message);
        assert!(
            !err.message.contains("query size"),
            "整读趟失败不得误报为尺寸探测失败",
        );
    }
}
