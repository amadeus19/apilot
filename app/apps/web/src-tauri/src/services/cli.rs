//! CLI 服务（设置「开发者 › 高级」命令行界面开关的后端）：PATH 注册 / 注销
//! 编排与状态聚合探测。
//!
//! 真值模型：开关显示态唯一派生自「用户 PATH 是否含本安装目录条目」，
//! settings 不再持有 `cli` 副本——能读真值就不存副本，「开关开 / 状态未
//! 注册」的双真值矛盾从模型上消除。CLI 二进制不检查任何开关：PATH 注册
//! 只决定终端能否直接敲 `apilot`，与命令放行（权限架构）正交。
//!
//! 状态聚合（`get_cli_status`）三路探测：版本（拉起 `apilot.exe --version`，
//! 3 秒超时）、PATH 注册态（用户 PATH 读注册表）、命令解析（系统＋用户
//! PATH 按终端顺序逐目录找 `apilot.exe`，只读纯函数）。探测异常是状态值
//! 不是错误；只有注册表读写失败才返回 `CLI_PATH_REGISTRY_FAILED`。

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;

use crate::error::AppError;
use crate::infrastructure::path_env::{self, CLI_EXE_NAME, PathRegistry, UserPathRegistry};

/// 版本探测超时：超过即弃结果、杀子进程（短时限进程不登记 TaskRegistry，
/// 超时是唯一取消通路）。
pub(crate) const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// CLI 状态 DTO（camelCase 对齐前端 Diagnostics / BootSettings 同款约定）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    /// `apilot.exe` 完整路径（[复制 CLI 路径] 复制此值，可直接粘贴终端执行）
    pub exe_path: String,
    /// 探测到的 CLI 版本（拉起失败 / 超时 / 输出不可解析时为 `None`）
    pub version: Option<String>,
    /// 二进制可执行且版本与 GUI 同源（同 crate 双 bin 版本恒同，不一致只在
    /// 被手工替换时出现）；`false`＝S6「CLI 二进制不可用」
    pub binary_available: bool,
    /// 安装目录是否为开发构建目录（cargo `target` 下）；`true`＝S7 警示
    pub is_dev_build: bool,
    /// 本安装目录是否在用户 PATH（开关显示态的唯一来源）
    pub registered: bool,
    /// 终端解析到的 `apilot.exe` 所在目录（已展开 `%VAR%`）；`None`＝未命中
    pub resolved_dir: Option<String>,
    /// 遮蔽目录：解析命中的不是本目录时为该目录（S3 / S4），否则 `None`
    pub shadowed_by: Option<String>,
    /// 残留：用户 PATH 中本目录之外、解析顺序在后的含 `apilot.exe` 条目（S5）
    pub stale_dirs: Vec<String>,
}

/// 版本探测结果（拉起 `apilot.exe --version` 的三类终局）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum VersionProbe {
    /// 拉起成功并解析到版本号
    Version(String),
    /// 拉起失败：二进制缺失 / 不可执行 / 非零退出 / 输出不可解析
    Failed,
    /// 超时：future 被 drop，子进程随 `kill_on_drop` 终止
    TimedOut,
}

// —— 注册 / 注销（拨开弹窗 [注册] 与拨关静默注销的后端）——

/// 注册：本安装目录追加进用户 PATH → 广播环境变化。
pub fn register() -> Result<(), AppError> {
    register_with(&UserPathRegistry, &path_env::install_dir()?)
}

/// 注销：从用户 PATH 移除本安装目录（含大小写变体）→ 广播环境变化。
pub fn unregister() -> Result<(), AppError> {
    unregister_with(&UserPathRegistry, &path_env::install_dir()?)
}

/// 注入形态（单测用）：注册表接缝与目标目录可替换。
pub(crate) fn register_with(registry: &dyn PathRegistry, exe_dir: &Path) -> Result<(), AppError> {
    let entry = exe_dir.to_string_lossy().into_owned();
    let updated = path_env::append_entry(registry.read()?, &entry);
    registry.write(&updated)?;
    // 广播是尽力而为语义（后台线程，不阻塞、不因失败回滚注册）
    path_env::broadcast_env_change();
    Ok(())
}

pub(crate) fn unregister_with(registry: &dyn PathRegistry, exe_dir: &Path) -> Result<(), AppError> {
    let entry = exe_dir.to_string_lossy().into_owned();
    let updated = path_env::remove_entry(registry.read()?, &entry);
    registry.write(&updated)?;
    path_env::broadcast_env_change();
    Ok(())
}

// —— 状态聚合（`get_cli_status`）——

/// 聚合探测：版本（真拉进程）＋注册态＋命令解析。打开设置对话框时调用一次，
/// 注册 / 注销后前端失效重取。
pub async fn status() -> Result<CliStatus, AppError> {
    let install_dir = path_env::install_dir()?;
    let probe = probe_version(&install_dir.join(CLI_EXE_NAME)).await;
    status_with(
        &UserPathRegistry,
        &install_dir,
        probe,
        &|name| std::env::var(name).ok(),
        &|path| path.is_file(),
    )
}

/// 注入形态（单测用）：注册表接缝、安装目录、版本探测结果、环境变量查值与
/// 文件存在性探针全部可替换——S1–S7 各态在此以纯装配锁定。
pub(crate) fn status_with(
    registry: &dyn PathRegistry,
    install_dir: &Path,
    probe: VersionProbe,
    env_lookup: &dyn Fn(&str) -> Option<String>,
    exists: &dyn Fn(&Path) -> bool,
) -> Result<CliStatus, AppError> {
    let own_dir = install_dir.to_string_lossy().into_owned();
    let user_entries = registry.read()?;
    let system_entries = registry.read_system()?;
    let registered = path_env::is_registered(&user_entries, &own_dir);
    let resolution = path_env::resolve_command(
        &system_entries,
        &user_entries,
        &own_dir,
        &|entry| path_env::expand_env_refs(entry, env_lookup),
        exists,
    );
    let shadowed_by = match (&resolution.resolved_dir, resolution.resolved_is_own) {
        (Some(dir), false) => Some(dir.clone()),
        _ => None,
    };
    let version = match &probe {
        VersionProbe::Version(version) => Some(version.clone()),
        VersionProbe::Failed | VersionProbe::TimedOut => None,
    };
    let binary_available = version.as_deref() == Some(env!("CARGO_PKG_VERSION"));
    Ok(CliStatus {
        exe_path: install_dir.join(CLI_EXE_NAME).to_string_lossy().into_owned(),
        version,
        binary_available,
        is_dev_build: path_env::is_dev_build_dir(install_dir),
        registered,
        resolved_dir: resolution.resolved_dir,
        shadowed_by,
        stale_dirs: resolution.stale_dirs,
    })
}

/// 以绝对路径拉起 `apilot.exe --version`（不经 PATH 查找——探测的是本安装
/// 目录的二进制是否可执行，不是终端会执行到谁）。
async fn probe_version(exe: &Path) -> VersionProbe {
    let run = tokio::process::Command::new(exe)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // GUI 进程拉起控制台子进程会闪一个控制台窗口；不建窗口
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
        .kill_on_drop(true)
        .output();
    probe_version_with(run, VERSION_PROBE_TIMEOUT).await
}

/// 探测终局分类（单测注入 future 与时限）：成功且输出可解析 → 版本；
/// 拉起错误 / 非零退出 / 不可解析 → 失败；超过时限 → 超时（future 随之 drop）。
pub(crate) async fn probe_version_with<F>(run: F, limit: Duration) -> VersionProbe
where
    F: std::future::Future<Output = std::io::Result<std::process::Output>>,
{
    match tokio::time::timeout(limit, run).await {
        Ok(Ok(output)) if output.status.success() => parse_version_output(&output.stdout)
            .map(VersionProbe::Version)
            .unwrap_or(VersionProbe::Failed),
        Ok(_) => VersionProbe::Failed,
        Err(_) => VersionProbe::TimedOut,
    }
}

/// clap 默认 `--version` 输出形如 `apilot 0.1.0`：取首行最后一个空白分隔
/// 片段作版本号；空输出或首行无片段＝不可解析。
pub(crate) fn parse_version_output(stdout: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(stdout);
    let first_line = text.lines().next()?;
    first_line
        .split_whitespace()
        .next_back()
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::ExitStatusExt;
    use std::path::PathBuf;
    use std::process::{ExitStatus, Output};
    use std::sync::Mutex;

    /// 内存注册表：记录读写轨迹，可注入写失败；系统 PATH 只读。
    struct FakeRegistry {
        entries: Mutex<Vec<String>>,
        system_entries: Vec<String>,
        fail_write: bool,
        writes: Mutex<Vec<Vec<String>>>,
    }

    impl FakeRegistry {
        fn with_user(entries: &[&str]) -> Self {
            Self::with(entries, &[])
        }

        fn with(user: &[&str], system: &[&str]) -> Self {
            FakeRegistry {
                entries: Mutex::new(owned(user)),
                system_entries: owned(system),
                fail_write: false,
                writes: Mutex::new(Vec::new()),
            }
        }
    }

    impl PathRegistry for FakeRegistry {
        fn read(&self) -> Result<Vec<String>, AppError> {
            Ok(self.entries.lock().unwrap().clone())
        }
        fn write(&self, entries: &[String]) -> Result<(), AppError> {
            if self.fail_write {
                return Err(AppError::new(
                    crate::error::codes::CLI_PATH_REGISTRY_FAILED,
                    "injected write failure",
                ));
            }
            self.writes.lock().unwrap().push(entries.to_vec());
            *self.entries.lock().unwrap() = entries.to_vec();
            Ok(())
        }
        fn read_system(&self) -> Result<Vec<String>, AppError> {
            Ok(self.system_entries.clone())
        }
    }

    const OWN: &str = "C:\\Apps\\APilot";

    fn owned(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|e| (*e).to_owned()).collect()
    }

    fn target() -> PathBuf {
        PathBuf::from(OWN)
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    /// 文件存在性探针：给定目录集合视为含 apilot.exe（目录大小写不敏感）
    fn exe_in(dirs: &'static [&'static str]) -> impl Fn(&Path) -> bool {
        move |path: &Path| {
            let parent = path.parent().map(|p| p.to_string_lossy().to_lowercase());
            path.file_name().is_some_and(|name| name == CLI_EXE_NAME)
                && parent.is_some_and(|dir| dirs.iter().any(|d| d.to_lowercase() == dir))
        }
    }

    fn gui_version() -> VersionProbe {
        VersionProbe::Version(env!("CARGO_PKG_VERSION").to_owned())
    }

    // —— 注册 / 注销编排 ——

    #[test]
    fn register_appends_own_dir_and_writes_back() {
        let registry = FakeRegistry::with_user(&["C:\\Tools"]);
        register_with(&registry, &target()).unwrap();
        let writes = registry.writes.lock().unwrap();
        assert_eq!(writes.last().unwrap(), &owned(&["C:\\Tools", OWN]));
    }

    #[test]
    fn register_is_idempotent_across_case_variants() {
        let registry = FakeRegistry::with_user(&["c:\\apps\\apilot"]);
        register_with(&registry, &target()).unwrap();
        // 旧版写入的小写变体视为已注册：不追加第二条，原条目逐字保留
        assert_eq!(
            registry.writes.lock().unwrap().last().unwrap(),
            &owned(&["c:\\apps\\apilot"])
        );
    }

    #[test]
    fn unregister_removes_all_own_variants_keeps_others() {
        let registry =
            FakeRegistry::with_user(&[OWN, "C:\\Tools", "c:\\apps\\apilot", "C:\\tools"]);
        unregister_with(&registry, &target()).unwrap();
        assert_eq!(
            registry.writes.lock().unwrap().last().unwrap(),
            &owned(&["C:\\Tools", "C:\\tools"])
        );
    }

    #[test]
    fn registry_write_failure_propagates_registry_code() {
        let registry = FakeRegistry {
            fail_write: true,
            ..FakeRegistry::with_user(&[])
        };
        let err = register_with(&registry, &target()).unwrap_err();
        assert_eq!(err.code, crate::error::codes::CLI_PATH_REGISTRY_FAILED);
        assert!(registry.writes.lock().unwrap().is_empty());
    }

    // —— 版本探测三路径（注入 future，不真拉进程）——

    fn output(code: u32, stdout: &str) -> Output {
        Output {
            status: ExitStatus::from_raw(code),
            stdout: stdout.as_bytes().to_vec(),
            stderr: Vec::new(),
        }
    }

    #[tokio::test]
    async fn probe_parses_version_from_successful_run() {
        let probe = probe_version_with(
            async { Ok(output(0, "apilot 0.1.0\n")) },
            VERSION_PROBE_TIMEOUT,
        )
        .await;
        assert_eq!(probe, VersionProbe::Version("0.1.0".to_owned()));
    }

    #[tokio::test]
    async fn probe_reports_failed_when_binary_missing_or_exits_nonzero() {
        let missing = probe_version_with(
            async { Err(std::io::Error::from(std::io::ErrorKind::NotFound)) },
            VERSION_PROBE_TIMEOUT,
        )
        .await;
        assert_eq!(missing, VersionProbe::Failed);

        let nonzero =
            probe_version_with(async { Ok(output(1, "apilot 0.1.0\n")) }, VERSION_PROBE_TIMEOUT)
                .await;
        assert_eq!(nonzero, VersionProbe::Failed);

        let garbage = probe_version_with(async { Ok(output(0, "\n")) }, VERSION_PROBE_TIMEOUT).await;
        assert_eq!(garbage, VersionProbe::Failed);
    }

    /// 时限走到即判超时（future 随之 drop）；此处用毫秒级时限验证路径，
    /// 生产 3 秒常量另行锁定。
    #[tokio::test]
    async fn probe_reports_timed_out_when_process_never_returns() {
        let probe = probe_version_with(std::future::pending(), Duration::from_millis(20)).await;
        assert_eq!(probe, VersionProbe::TimedOut);
    }

    #[test]
    fn probe_timeout_is_three_seconds() {
        assert_eq!(VERSION_PROBE_TIMEOUT, Duration::from_secs(3));
    }

    #[test]
    fn parse_version_takes_last_token_of_first_line() {
        assert_eq!(parse_version_output(b"apilot 0.1.0\n"), Some("0.1.0".to_owned()));
        assert_eq!(parse_version_output(b"apilot 0.1.0\r\nextra"), Some("0.1.0".to_owned()));
        assert_eq!(parse_version_output(b""), None);
        assert_eq!(parse_version_output(b"   \n"), None);
    }

    // —— 状态聚合 S1–S7 ——

    #[test]
    fn s1_normal_registered_resolves_own_binary_ok() {
        let registry = FakeRegistry::with(&[OWN], &["C:\\Windows"]);
        let status =
            status_with(&registry, &target(), gui_version(), &no_env, &exe_in(&[OWN])).unwrap();
        assert_eq!(
            status,
            CliStatus {
                exe_path: format!("{OWN}\\{CLI_EXE_NAME}"),
                version: Some(env!("CARGO_PKG_VERSION").to_owned()),
                binary_available: true,
                is_dev_build: false,
                registered: true,
                resolved_dir: Some(OWN.to_owned()),
                shadowed_by: None,
                stale_dirs: vec![],
            }
        );
    }

    #[test]
    fn s2_unregistered_without_any_hit() {
        let registry = FakeRegistry::with(&["C:\\Tools"], &["C:\\Windows"]);
        let status =
            status_with(&registry, &target(), gui_version(), &no_env, &exe_in(&[OWN])).unwrap();
        assert!(!status.registered);
        assert_eq!(status.resolved_dir, None);
        assert_eq!(status.shadowed_by, None);
        assert!(status.stale_dirs.is_empty());
        // 二进制在本目录可用，只是不在 PATH
        assert!(status.binary_available);
    }

    #[test]
    fn s3_unregistered_and_shadowed_by_system_path() {
        let registry = FakeRegistry::with(&[], &["C:\\OldApilot"]);
        let status = status_with(
            &registry,
            &target(),
            gui_version(),
            &no_env,
            &exe_in(&[OWN, "C:\\OldApilot"]),
        )
        .unwrap();
        assert!(!status.registered);
        assert_eq!(status.shadowed_by.as_deref(), Some("C:\\OldApilot"));
        assert_eq!(status.resolved_dir.as_deref(), Some("C:\\OldApilot"));
    }

    #[test]
    fn s4_registered_but_shadowed_by_earlier_entry() {
        let registry = FakeRegistry::with(&[OWN], &["C:\\OldApilot"]);
        let status = status_with(
            &registry,
            &target(),
            gui_version(),
            &no_env,
            &exe_in(&[OWN, "C:\\OldApilot"]),
        )
        .unwrap();
        assert!(status.registered);
        assert_eq!(status.shadowed_by.as_deref(), Some("C:\\OldApilot"));
    }

    #[test]
    fn s5_registered_with_stale_entries_after_own() {
        let registry = FakeRegistry::with(&[OWN, "C:\\OldApilot"], &[]);
        let status = status_with(
            &registry,
            &target(),
            gui_version(),
            &no_env,
            &exe_in(&[OWN, "C:\\OldApilot"]),
        )
        .unwrap();
        assert!(status.registered);
        assert_eq!(status.shadowed_by, None);
        assert_eq!(status.stale_dirs, owned(&["C:\\OldApilot"]));
    }

    #[test]
    fn s6_binary_unavailable_on_probe_failure_timeout_or_version_mismatch() {
        let registry = FakeRegistry::with(&[OWN], &[]);
        let failed =
            status_with(&registry, &target(), VersionProbe::Failed, &no_env, &exe_in(&[])).unwrap();
        assert!(!failed.binary_available);
        assert_eq!(failed.version, None);

        let timed_out = status_with(
            &registry,
            &target(),
            VersionProbe::TimedOut,
            &no_env,
            &exe_in(&[]),
        )
        .unwrap();
        assert!(!timed_out.binary_available);

        let mismatch = status_with(
            &registry,
            &target(),
            VersionProbe::Version("9.9.9".to_owned()),
            &no_env,
            &exe_in(&[OWN]),
        )
        .unwrap();
        // 版本仍回报供呈现，但不算可用
        assert_eq!(mismatch.version.as_deref(), Some("9.9.9"));
        assert!(!mismatch.binary_available);
    }

    #[test]
    fn s7_dev_build_dir_is_flagged() {
        let dev_dir = PathBuf::from("D:\\repo\\app\\apps\\web\\src-tauri\\target\\debug");
        let registry = FakeRegistry::with(&[], &[]);
        let status =
            status_with(&registry, &dev_dir, gui_version(), &no_env, &exe_in(&[])).unwrap();
        assert!(status.is_dev_build);
        assert_eq!(
            status.exe_path,
            format!("{}\\{CLI_EXE_NAME}", dev_dir.display())
        );
    }

    #[test]
    fn status_expands_env_refs_before_probing() {
        let registry = FakeRegistry::with(&["%APILOT_HOME%"], &[]);
        let env = |name: &str| (name == "APILOT_HOME").then(|| OWN.to_owned());
        let status =
            status_with(&registry, &target(), gui_version(), &env, &exe_in(&[OWN])).unwrap();
        // 注册态按原始条目比对：`%VAR%` 形态不算我们写的条目
        assert!(!status.registered);
        // 命令解析按展开后比对：命中本目录
        assert_eq!(status.resolved_dir.as_deref(), Some(OWN));
        assert_eq!(status.shadowed_by, None);
    }

    #[test]
    fn status_propagates_registry_read_failure() {
        struct Broken;
        impl PathRegistry for Broken {
            fn read(&self) -> Result<Vec<String>, AppError> {
                Err(AppError::new(
                    crate::error::codes::CLI_PATH_REGISTRY_FAILED,
                    "injected read failure",
                ))
            }
            fn write(&self, _: &[String]) -> Result<(), AppError> {
                unreachable!("status never writes")
            }
            fn read_system(&self) -> Result<Vec<String>, AppError> {
                Ok(vec![])
            }
        }
        let err = status_with(&Broken, &target(), gui_version(), &no_env, &exe_in(&[]))
            .unwrap_err();
        assert_eq!(err.code, crate::error::codes::CLI_PATH_REGISTRY_FAILED);
    }

    #[test]
    fn dto_serializes_camel_case() {
        let registry = FakeRegistry::with(&[OWN], &[]);
        let status =
            status_with(&registry, &target(), gui_version(), &no_env, &exe_in(&[OWN])).unwrap();
        let value = serde_json::to_value(status).unwrap();
        for key in [
            "exePath",
            "version",
            "binaryAvailable",
            "isDevBuild",
            "registered",
            "resolvedDir",
            "shadowedBy",
            "staleDirs",
        ] {
            assert!(value.get(key).is_some(), "missing key {key}");
        }
        assert_eq!(value.as_object().unwrap().len(), 8);
    }
}
