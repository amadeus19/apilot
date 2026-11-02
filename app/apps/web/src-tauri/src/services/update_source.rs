//! 更新源服务：可达性校验与更新检查——
//! 本机文件夹 / 局域网共享（UNC）的 `manifest.json` 读取、解析与版本比较。
//! 检查只读清单不下载；下载 / 校验 / 安装在下方分节实现。
//!
//! 阻塞语义：UNC 在 SMB 不可达时 `fs` 操作会阻塞数秒以上，全部文件访问放
//! `spawn_blocking` 并按 `UPDATE_SOURCE_CHECK_TIMEOUT_MS` 超时兜底（超时 =
//! 不可达，不卡 Command）；注意 blocking 任务本身不可取消，超时后最长会
//! 占用一个 blocking 线程至 SMB 自然超时（池有界，可接受）。检查是单次
//! 只读动作，不持有任何资源。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::constants::{MAX_UPDATE_FILE_BYTES, UPDATE_SOURCE_CHECK_TIMEOUT_MS};
use crate::error::AppError;

/// 更新签名公钥（minisign 公钥文件两行格式，`PublicKey::decode` 按此解析）。
/// 来源：`~/.tauri/apilot.key.pub` 的 base64 内容解码后的第二行（tauri 的
/// `.pub` 是 minisign.pub 全文再 base64 一层，`plugins.updater.pubkey` 用那层，
/// 本常量用解码后的真实公钥行）。**正式发版换密钥时同步更新此常量**。
const UPDATE_PUBKEY: &str = "untrusted comment: minisign public key: 5AC3AF3D64CAD149\nRWRJ0cpkPa/DWi47iDT/8JiWhKsq4YZvPEmmb73JZNyprJYkU7dyiPX9";

/// 临时目录就绪包文件名前缀（download 落盘与 list 扫描共用同一常量防漂移）：
/// 完整形态 `APilot-update-<x.y.z>.exe`，落盘中态 `APilot-update-<x.y.z>.exe.part`
const STAGED_UPDATE_PREFIX: &str = "APilot-update-";

/// 保存前可达性校验：路径存在且为目录 → Ok；不存在 / 非目录 / 网络不可达 /
/// 超时 → `UPDATE_SOURCE_UNREACHABLE`（message 带细节，前端 toast 本地化文案）。
pub async fn check_reachable(path: &str) -> Result<(), AppError> {
    let owned = path.to_owned();
    let check = tokio::task::spawn_blocking(move || {
        match std::fs::metadata(&owned) {
            Ok(metadata) if metadata.is_dir() => Ok(()),
            Ok(_) => Err("path exists but is not a directory".to_owned()),
            // NotFound 单列（最常见的输错路径形态），其余 IO/网络错误原样带上
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Err("path does not exist".to_owned())
            }
            Err(err) => Err(format!("path is not reachable: {err}")),
        }
    });
    match tokio::time::timeout(Duration::from_millis(UPDATE_SOURCE_CHECK_TIMEOUT_MS), check).await {
        Ok(Ok(result)) => result.map_err(|reason| {
            AppError::new(
                crate::error::codes::UPDATE_SOURCE_UNREACHABLE,
                format!("update source unreachable: {reason}"),
            )
        }),
        // 校验任务 panic 属内部错误（spawn 失败同理）
        Ok(Err(err)) => Err(AppError::internal(format!(
            "update source check failed: {err}"
        ))),
        Err(_elapsed) => Err(AppError::new(
            crate::error::codes::UPDATE_SOURCE_UNREACHABLE,
            format!("update source check timed out after {UPDATE_SOURCE_CHECK_TIMEOUT_MS}ms"),
        )),
    }
}

// —— 更新检查（读 manifest.json + 版本比较，不下载）——

/// 清单平台条目（选型字段：file / size / sha256 / signature）。
/// sha256 / signature 校验逻辑在下载安装期实现，本期仅随清单带出。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestPlatform {
    #[allow(dead_code)]
    file: String,
    #[allow(dead_code)]
    size: u64,
    #[allow(dead_code)]
    sha256: String,
    #[allow(dead_code)]
    signature: String,
}

/// 更新源清单（manifest.json，manifestVersion 1）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    manifest_version: u32,
    version: String,
    #[serde(default)]
    notes: String,
    #[allow(dead_code)]
    #[serde(default)]
    pub_date: String,
    #[allow(dead_code)]
    #[serde(default)]
    required: bool,
    platforms: HashMap<String, ManifestPlatform>,
}

/// 检查结果状态（前端按状态渲染文案）：
/// not_configured = 未配置更新源；unreachable = 源/清单读不到；
/// invalid_manifest = 清单损坏或缺平台条目；up_to_date = 已是最新；
/// newer_available = 有更新版本。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckUpdatesResult {
    pub status: &'static str,
    pub latest_version: Option<String>,
    pub notes: Option<String>,
}

/// 严格 SemVer 比较（semver crate 解析 + 规范 precedence 语义）：pre-release
/// 低于同版本正体（`0.2.0-rc.1 < 0.2.0`）。构建元数据不参与比较——crate 的
/// 派生 Ord 含 build 字典序，这里按规范语义显式裁掉（同版本重打包不得误报
/// 可更新）。任一侧解析失败返回 None——调用方按非法清单 / 非法文件名各自
/// 处理，不猜排序。
fn compare_semver(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    let (a, b) = (
        semver::Version::parse(a).ok()?,
        semver::Version::parse(b).ok()?,
    );
    Some(
        a.major
            .cmp(&b.major)
            .then(a.minor.cmp(&b.minor))
            .then(a.patch.cmp(&b.patch))
            .then(a.pre.cmp(&b.pre)),
    )
}

/// 清单读取失败语义（类型承载，取代编码进文案再 contains 解码）：
/// 检查状态与下载错误码都由 match 驱动（表函数可测），新增失败类别时
/// 编译器引导两处映射补全。
#[derive(Debug)]
enum ManifestError {
    /// manifest.json 文件读不到（缺失 / 权限 / 源不可达）
    Unreadable(String),
    /// 清单不可用（非法 JSON / manifestVersion 不支持 / 缺当前平台条目）
    Invalid(String),
}

/// 读取并解析更新源清单（blocking 内执行）。
fn read_manifest_blocking(source_root: PathBuf) -> Result<Manifest, ManifestError> {
    let manifest_path = source_root.join("manifest.json");
    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|err| ManifestError::Unreadable(format!("manifest.json unreadable: {err}")))?;
    let manifest: Manifest = serde_json::from_str(&raw)
        .map_err(|err| ManifestError::Invalid(format!("manifest.json is not valid: {err}")))?;
    if manifest.manifest_version != 1 {
        return Err(ManifestError::Invalid(format!(
            "unsupported manifestVersion {}",
            manifest.manifest_version
        )));
    }
    if !manifest.platforms.contains_key("windows-x86_64") {
        return Err(ManifestError::Invalid(
            "manifest has no windows-x86_64 platform entry".to_owned(),
        ));
    }
    // 版本号必须是合法 SemVer：版本语义（含 pre-release 排序）是检查 /
    // 安装 / 扫场三方共用的判定地基，非法版本在入口拒绝
    semver::Version::parse(&manifest.version).map_err(|err| {
        ManifestError::Invalid(format!("manifest version is not valid semver: {err}"))
    })?;
    Ok(manifest)
}

/// ManifestError → 检查状态映射（表驱动纯函数）：读不到归 unreachable
/// （源问题，可重试），清单不可用归 invalid_manifest（配置问题，需修源）。
fn manifest_status(err: &ManifestError) -> &'static str {
    match err {
        ManifestError::Unreadable(_) => "unreachable",
        ManifestError::Invalid(_) => "invalid_manifest",
    }
}

/// ManifestError → 下载阶段错误码映射（match 驱动，码随失败阶段切分）。
fn manifest_download_error(err: ManifestError) -> AppError {
    match err {
        ManifestError::Unreadable(reason) => {
            AppError::new(crate::error::codes::UPDATE_MANIFEST_UNREADABLE, reason)
        }
        ManifestError::Invalid(reason) => {
            AppError::new(crate::error::codes::UPDATE_MANIFEST_INVALID, reason)
        }
    }
}

/// 更新检查主流程：`updateSource` 设置（`{"type","path"}` 或缺失）→ 未配置 /
/// 云类型（未对接）按 not_configured 返回；本地源读清单比版本。
pub async fn check_for_update(
    update_source: Option<&serde_json::Value>,
) -> Result<CheckUpdatesResult, AppError> {
    let current = env!("CARGO_PKG_VERSION");
    // 配置解析：缺失 / path 空为未配置；cloud 未对接同样按未配置引导
    let Some(path) = resolve_source_path(update_source) else {
        return Ok(CheckUpdatesResult {
            status: "not_configured",
            latest_version: None,
            notes: None,
        });
    };

    let owned = path;
    let read = tokio::task::spawn_blocking(move || read_manifest_blocking(owned));
    let manifest =
        match tokio::time::timeout(Duration::from_millis(UPDATE_SOURCE_CHECK_TIMEOUT_MS), read)
            .await
        {
            // timeout ok + join ok + read ok
            Ok(Ok(Ok(manifest))) => manifest,
            // timeout ok + join ok + read err（清单缺失 / 损坏 / 不支持）：查表归状态
            Ok(Ok(Err(err))) => {
                return Ok(CheckUpdatesResult {
                    status: manifest_status(&err),
                    latest_version: None,
                    notes: Some(match &err {
                        ManifestError::Unreadable(reason) | ManifestError::Invalid(reason) => {
                            reason.clone()
                        }
                    }),
                });
            }
            // timeout ok + join err（blocking 任务 panic，内部错误）
            Ok(Err(err)) => {
                return Err(AppError::internal(format!(
                    "update source read failed: {err}"
                )));
            }
            // 超时（UNC 不可达等）
            Err(_elapsed) => {
                return Ok(CheckUpdatesResult {
                    status: "unreachable",
                    latest_version: None,
                    notes: Some(format!(
                        "timed out after {UPDATE_SOURCE_CHECK_TIMEOUT_MS}ms"
                    )),
                });
            }
        };
    // 方向三分：清单高于当前 → 可更新；低于当前 → 可回滚（发布回滚 = 清单
    // 指回旧版本，旧版包仍在源内，按同一「下载 → 确认 → 安装」路径安装）。
    // None 不可达：清单版本已在读取时校验为合法 SemVer，当前版本编译期固定。
    Ok(match compare_semver(&manifest.version, current) {
        Some(std::cmp::Ordering::Greater) => CheckUpdatesResult {
            status: "newer_available",
            latest_version: Some(manifest.version),
            notes: (!manifest.notes.is_empty()).then_some(manifest.notes),
        },
        Some(std::cmp::Ordering::Less) => CheckUpdatesResult {
            status: "downgrade_available",
            latest_version: Some(manifest.version),
            notes: (!manifest.notes.is_empty()).then_some(manifest.notes),
        },
        _ => CheckUpdatesResult {
            status: "up_to_date",
            latest_version: Some(manifest.version),
            notes: None,
        },
    })
}

// —— 下载 + 校验 + 安装（两段式：download_update 校验落盘 → install_update 启动安装器）——

/// 安装准备结果（校验全过后就绪的暂存包信息，camelCase 对齐前端 DTO 约定）。
/// IPC 只传版本号——路径由 Rust 侧 [`StagedUpdate`] 从版本号重构，不越过
/// IPC 边界（类型即防线）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedUpdateInfo {
    /// 清单版本号
    pub version: String,
}

/// `updateSource` 设置 → 本地源根目录：未配置 / path 空 / 云类型 = None
/// （check_for_update 归 not_configured，download 归 UPDATE_SOURCE_NOT_CONFIGURED）。
fn resolve_source_path(update_source: Option<&serde_json::Value>) -> Option<PathBuf> {
    let path = update_source
        .and_then(|v| v.get("path"))
        .and_then(|p| p.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    let source_type = update_source
        .and_then(|v| v.get("type"))
        .and_then(|t| t.as_str())
        .unwrap_or("local");
    if source_type == "cloud" {
        return None;
    }
    Some(PathBuf::from(path))
}

/// 下载并校验更新包（blocking 内执行）：读源文件进内存 → size / sha256 /
/// minisign 三重校验 → 写入临时固定名（`APilot-update-<version>.exe`，覆盖
/// 落盘供安装器使用）。顺序经过实测校准：**先校验后落盘**——落盘后的 .exe
/// 会被 Windows Defender 实时扫描短暂独占，读回校验会撞 error 32；先校验
/// 后写则写完即返回，无读回竞态。任何一步失败拒绝安装。
fn download_and_verify_blocking(source_root: &Path) -> Result<StagedUpdateInfo, AppError> {
    let manifest =
        read_manifest_blocking(source_root.to_path_buf()).map_err(manifest_download_error)?;
    let platform = manifest.platforms.get("windows-x86_64").ok_or_else(|| {
        AppError::new(
            crate::error::codes::UPDATE_MANIFEST_INVALID,
            "manifest has no windows-x86_64 entry",
        )
    })?;

    let source_file = source_root.join(&platform.file);
    let bytes = std::fs::read(&source_file).map_err(|err| {
        AppError::new(
            crate::error::codes::UPDATE_PACKAGE_UNREADABLE,
            format!(
                "failed to read update package {}: {err}",
                source_file.display()
            ),
        )
    })?;

    // 大小护栏（一切缓冲有界）：实际字节数必须与清单一致且低于上限
    let actual_size = bytes.len() as u64;
    if actual_size != platform.size || actual_size > MAX_UPDATE_FILE_BYTES {
        return Err(AppError::new(
            crate::error::codes::UPDATE_CHECKSUM_MISMATCH,
            format!(
                "package size mismatch: manifest {}, actual {actual_size}",
                platform.size
            ),
        ));
    }

    // sha256 复核（内存字节上计算；包 ~4MB，上限护栏内可接受）
    use sha2::Digest;
    let actual_hash = format!("{:x}", sha2::Sha256::digest(&bytes));
    if actual_hash != platform.sha256 {
        return Err(AppError::new(
            crate::error::codes::UPDATE_CHECKSUM_MISMATCH,
            format!(
                "sha256 mismatch: expected {}, got {actual_hash}",
                platform.sha256
            ),
        ));
    }

    // minisign 验签（官方 updater 同款 Ed25519；签名对象 = 安装包文件字节）。
    // manifest 的 signature 按 tauri 约定是 .sig 全文（四行）再 base64 一层，先解出原文
    use base64::Engine as _;
    let sig_text = base64::engine::general_purpose::STANDARD
        .decode(platform.signature.trim())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(|| {
            AppError::new(
                crate::error::codes::UPDATE_SIGNATURE_INVALID,
                "manifest signature is not valid base64",
            )
        })?;
    // decode 对部分非法输入会 panic（库内实现假设），catch_unwind 归一为
    // UPDATE_SIGNATURE_INVALID（spawn_blocking 的 panic 会变 INTERNAL，语义不对）
    let public_key = minisign_verify::PublicKey::decode(UPDATE_PUBKEY)
        .map_err(|err| AppError::internal(format!("built-in update pubkey invalid: {err}")))?;
    let decoded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        minisign_verify::Signature::decode(&sig_text)
    }))
    .unwrap_or(Err(minisign_verify::Error::InvalidEncoding));
    let signature = decoded.map_err(|err| {
        AppError::new(
            crate::error::codes::UPDATE_SIGNATURE_INVALID,
            format!("manifest signature is not a valid minisign form: {err}"),
        )
    })?;
    public_key
        .verify(&bytes, &signature, false)
        .map_err(|err| {
            AppError::new(
                crate::error::codes::UPDATE_SIGNATURE_INVALID,
                format!("signature verification failed: {err}"),
            )
        })?;

    // 校验全过后落盘：先写 `.part` 临时名，再同卷 rename 到最终名（同目录
    // rename 原子生效——最终名出现时文件必然完整）。下载中途关窗 / 写盘中断
    // 只可能留下 `.part` 截断文件，boot 扫场不识别该后缀，不再误报「更新就绪」。
    // 落盘命名经 StagedUpdate::from_version 统一构造：能落盘的包必然可被
    // boot 扫场识别与安装消费（清单版本非可暂存形态在此拒绝，不留永久残留）。
    // 顺序仍为先校验后落盘：落盘后的 .exe 会被 Windows Defender 实时扫描短暂
    // 独占，读回校验会撞 error 32；校验在内存字节上完成，落盘后无读回竞态。
    let staged = StagedUpdate::from_version(&manifest.version)?;
    let final_path = staged.path;
    let part_path = std::env::temp_dir().join(StagedUpdate::part_file_name(&manifest.version));
    std::fs::write(&part_path, &bytes).map_err(|err| {
        AppError::new(
            crate::error::codes::UPDATE_STAGE_WRITE_FAILED,
            format!("failed to stage installer {}: {err}", part_path.display()),
        )
    })?;
    if let Err(err) = std::fs::rename(&part_path, &final_path) {
        // rename 失败（最终名被占用等）：清掉 .part 残留（尽力而为），拒绝安装
        let _ = std::fs::remove_file(&part_path);
        return Err(AppError::new(
            crate::error::codes::UPDATE_STAGE_WRITE_FAILED,
            format!(
                "failed to finalize staged installer {}: {err}",
                final_path.display()
            ),
        ));
    }

    Ok(StagedUpdateInfo {
        version: manifest.version,
    })
}

/// 下载 + 三重校验（Command 层入口）：超时兜底同检查（UNC 复制也可能阻塞）。
pub async fn download_update(
    update_source: Option<&serde_json::Value>,
) -> Result<StagedUpdateInfo, AppError> {
    let Some(path) = resolve_source_path(update_source) else {
        return Err(AppError::new(
            crate::error::codes::UPDATE_SOURCE_NOT_CONFIGURED,
            "update source is not configured or unsupported type",
        ));
    };
    let read = tokio::task::spawn_blocking(move || download_and_verify_blocking(&path));
    match tokio::time::timeout(
        Duration::from_millis(UPDATE_SOURCE_CHECK_TIMEOUT_MS * 10),
        read,
    )
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(err)) => Err(AppError::internal(format!("update download failed: {err}"))),
        Err(_elapsed) => Err(AppError::new(
            crate::error::codes::UPDATE_DOWNLOAD_TIMED_OUT,
            format!(
                "download timed out after {}ms",
                UPDATE_SOURCE_CHECK_TIMEOUT_MS * 10
            ),
        )),
    }
}

// —— 暂存更新包（类型即防线）——

/// 暂存更新包：安装 / 清理链路的唯一货币。路径**不由 IPC 注入**——从版本号
/// 经「系统临时目录 + 固定命名」推导，构造即校验（版本形态收窄到 `x.y.z`
/// 全数字），IPC 注入的裸路径字符串无法绕过构造进入执行面。这关闭「任意
/// 路径执行」缺口：本产品渲染不可信 HTTP 响应，XSS → 宿主进程执行任意路径
/// exe 是现实链路（官方 updater 插件的 install 本就不接受外部路径）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedUpdate {
    version: String,
    path: PathBuf,
}

impl StagedUpdate {
    /// 就绪包最终名（下载落盘与 boot 扫描共用同一常量防漂移）
    fn staged_file_name(version: &str) -> String {
        format!("{STAGED_UPDATE_PREFIX}{version}.exe")
    }

    /// `.part` 落盘中态名：写 `.part` → 校验已过 → 同卷 rename 到最终名；
    /// boot 扫描不识别该后缀，下载中断残留不误报就绪。
    fn part_file_name(version: &str) -> String {
        format!("{}.part", Self::staged_file_name(version))
    }

    /// IPC 入口构造（install / discard）：版本号校验通过后推导路径，任何外部
    /// 路径字符串都不参与构造——非法版本（含路径注入形态）一律拒绝。
    pub fn from_version(version: &str) -> Result<Self, AppError> {
        let version = version.trim();
        if !is_staged_version(version) {
            return Err(AppError::new(
                crate::error::codes::INVALID_ARGUMENT,
                format!("not a staged update version: {version:?}"),
            ));
        }
        Ok(Self {
            version: version.to_owned(),
            path: std::env::temp_dir().join(Self::staged_file_name(version)),
        })
    }

    /// boot 扫场构造：父目录必须是系统临时目录且文件名匹配就绪包命名；
    /// `.part` 残留后缀不符，天然不进分类。
    fn from_entry(path: &Path) -> Option<Self> {
        let version = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(parse_staged_version)?;
        path.parent()
            .is_some_and(|parent| parent == std::env::temp_dir())
            .then(|| Self {
                version,
                path: path.to_path_buf(),
            })
    }

    /// 版本号（DTO 直出；路径不越过 IPC 边界）
    pub fn version(&self) -> &str {
        &self.version
    }

    /// 安装前置校验：暂存包文件存在（重启后误调 / 手工清理过的暂存包拒绝）。
    /// 通过后进入待安装请求，由退出序列末尾 spawn。
    pub fn verify_launchable(&self) -> Result<(), AppError> {
        if !self.path.is_file() {
            return Err(AppError::new(
                crate::error::codes::UPDATE_INSTALL_FAILED,
                format!("staged installer missing: {}", self.path.display()),
            ));
        }
        Ok(())
    }

    /// 安装意向标记路径（最终名 + `.attempt` 后缀，仍在自产命名空间内）。
    /// 安装器（tauri NSIS 模板）静默模式下经 Restart Manager 强制关闭仍在
    /// 运行的应用——等待安装器退出码在进程内不可得，安装结果改为「意向
    /// 标记 + 下轮 boot 校验暂存包版本」感知。
    fn attempt_marker_path(&self) -> PathBuf {
        let mut name = self.path.clone().into_os_string();
        name.push(ATTEMPT_MARKER_SUFFIX);
        PathBuf::from(name)
    }

    /// 安装失败标记路径（最终名 + `.failed` 后缀）：spawn 失败同步留痕。
    fn failure_marker_path(&self) -> PathBuf {
        let mut name = self.path.clone().into_os_string();
        name.push(FAILURE_MARKER_SUFFIX);
        PathBuf::from(name)
    }

    /// 记录安装意向（退出序列末尾、spawn 安装器之前）：下轮 boot 以
    /// 「暂存包版本 == 当前版本」判定安装成败并清理标记。写入失败仅记日志
    /// （最坏结果 = 该次安装若失败则下轮无失败反馈，不影响安装本体）。
    pub fn record_attempt(&self) {
        if let Err(err) = std::fs::write(self.attempt_marker_path(), &self.version) {
            tracing::warn!(error = %err, "failed to write install attempt marker");
        }
    }

    /// 记录安装失败（spawn 失败同步可知；安装器中途失败由意向标记兜底感知）
    pub fn record_failure(&self) {
        if let Err(err) = std::fs::write(self.failure_marker_path(), &self.version) {
            tracing::warn!(error = %err, "failed to write install failure marker");
        }
    }

    /// 清除安装标记（幂等尽力而为；成功路径由扫场清理，discard 一并清理）
    pub fn clear_markers(&self) {
        for marker in [self.attempt_marker_path(), self.failure_marker_path()] {
            match std::fs::remove_file(&marker) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => {
                    tracing::warn!(error = %err, path = %marker.display(), "failed to clear install marker")
                }
            }
        }
    }

    /// 启动静默安装器（退出序列末尾调用，应用随即退出，不等待安装器）：
    /// - `/S` 静默零交互；`/UPDATE` 更新模式（跳过卸载旧版，保留快捷方式/
    ///   自启动/用户数据——官方自更新约定，防数据被清）；`/R` 安装成功后
    ///   自动重启新版本（官方模板 `.onInstSuccess`：仅静默/被动生效）。
    ///
    /// 安装器对仍在运行的旧进程走 Restart Manager 强制关闭，spawn 后立即
    /// 退出（官方顺序）避免安装器杀到未完成退出的应用。
    pub fn spawn_installer(&self) -> Result<(), AppError> {
        std::process::Command::new(&self.path)
            .args(["/S", "/UPDATE", "/R"])
            .spawn()
            .map(|_| ())
            .map_err(|err| {
                AppError::new(
                    crate::error::codes::UPDATE_INSTALL_FAILED,
                    format!("failed to launch installer: {err}"),
                )
            })
    }

    /// 删除暂存包（完成提示后清理）：文件不存在视为幂等成功；
    /// 安装标记一并清除（discard 后不应再出现任何安装反馈）。
    pub fn discard(&self) -> Result<(), AppError> {
        self.clear_markers();
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(AppError::new(
                crate::error::codes::UPDATE_DISCARD_FAILED,
                format!("failed to discard staged update: {err}"),
            )),
        }
    }
}

// —— 就绪包扫描（就绪确认 + 完成提示 + 安装结果反馈）——

/// 临时目录就绪包扫描结果：`ready` 供 boot 续接弹确认对话框，`finished` 是
/// 覆盖安装完成的标志（前端提示后调用 discard 清理），`installFailed` 是
/// 上次安装未完成的反馈信号（一次性，读即清；暂存包保留供重试）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedUpdates {
    pub ready: Option<StagedUpdateInfo>,
    pub finished: Option<StagedUpdateInfo>,
    pub install_failed: Option<StagedUpdateInfo>,
}

/// 就绪包版本形态校验：合法 SemVer（含 pre-release / 构建元数据，字符集
/// `A-Za-z0-9 . - +` 均为 Windows 文件名安全字符；构建元数据进文件名仅为
/// 唯一性，比较语义不受其影响）。
fn is_staged_version(version: &str) -> bool {
    semver::Version::parse(version).is_ok()
}

/// 安装意向 / 失败标记文件名后缀（叠加在最终名 `.exe` 之上）
const ATTEMPT_MARKER_SUFFIX: &str = ".attempt";
const FAILURE_MARKER_SUFFIX: &str = ".failed";

/// 从文件名解析标记版本：`APilot-update-<x.y.z>.exe<suffix>` → `x.y.z`
/// （suffix 形如 `.attempt` / `.failed`，解析时须连同 `.exe` 一起剥除）；
/// 其余形态返回 None。
fn parse_marker_version(file_name: &str, suffix: &str) -> Option<String> {
    let exe_suffix = format!(".exe{suffix}");
    let rest = file_name
        .strip_prefix(STAGED_UPDATE_PREFIX)?
        .strip_suffix(exe_suffix.as_str())?;
    is_staged_version(rest).then(|| rest.to_owned())
}

/// 从文件名解析就绪包版本：`APilot-update-<x.y.z>.exe` → `x.y.z`；
/// 其余形态（他应用文件 / 命名不符 / 非数字段）返回 None。
fn parse_staged_version(file_name: &str) -> Option<String> {
    let rest = file_name
        .strip_prefix(STAGED_UPDATE_PREFIX)?
        .strip_suffix(".exe")?;
    is_staged_version(rest).then(|| rest.to_owned())
}

/// 扫描系统临时目录的就绪包：版本高于当前 → ready（上次「稍后」留下的）；
/// 等于当前 → finished（覆盖安装完成的标志）；低于当前 → 直接删除。降级
/// （回滚）是「检查 → 下载 → 确认安装」的即时路径，不跨 boot 保留暂存包——
/// 否则低版本残留包与陈旧垃圾无从区分，有界清理纪律失效；由此的已知边界：
/// 降级安装若中断，`installFailed` 反馈仍会给出，但重试需重新下载。
/// `.part` 中态残留（下载中断）同为自产垃圾，顺手清理。暂存包只在下载校验
/// 全过后经原子 rename 产生，扫场分类以文件名版本为信号、不再重复校验内容。
/// 安装标记（意向 / 失败）读即清：意向标记版本 = 当前 → 安装已完成（标记
/// 失效）；不等于当前 → 上次安装未完成，`installFailed` 一次性反馈，暂存包
/// 保留供重试。
pub fn list_staged_updates() -> StagedUpdates {
    let current = env!("CARGO_PKG_VERSION");
    let mut result = StagedUpdates {
        ready: None,
        finished: None,
        install_failed: None,
    };
    let entries = match std::fs::read_dir(std::env::temp_dir()) {
        Ok(entries) => entries,
        Err(err) => {
            tracing::warn!(error = %err, "list staged updates: read temp dir failed");
            return result;
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let path = entry.path();
        // .part 中态残留：不进分类，直接清理（自产命名空间内，尽力而为）
        if name.starts_with(STAGED_UPDATE_PREFIX) && name.ends_with(".part") {
            if let Err(err) = std::fs::remove_file(&path) {
                tracing::warn!(error = %err, path = %path.display(), "prune partial staged update failed");
            }
            continue;
        }
        // 失败标记（spawn 失败留痕）：一次性反馈后清除
        if let Some(version) = parse_marker_version(&name, FAILURE_MARKER_SUFFIX) {
            if let Err(err) = std::fs::remove_file(&path) {
                tracing::warn!(error = %err, path = %path.display(), "clear failure marker failed");
            }
            result.install_failed = Some(StagedUpdateInfo { version });
            continue;
        }
        // 意向标记：版本 = 当前 → 安装已完成（标记失效即清）；≠ 当前 →
        // 上次安装未完成，一次性反馈（暂存包保留，ready 续接可重试）
        if let Some(version) = parse_marker_version(&name, ATTEMPT_MARKER_SUFFIX) {
            if let Err(err) = std::fs::remove_file(&path) {
                tracing::warn!(error = %err, path = %path.display(), "clear attempt marker failed");
            }
            if version != current {
                result.install_failed = Some(StagedUpdateInfo { version });
            }
            continue;
        }
        let Some(staged) = StagedUpdate::from_entry(&path) else {
            continue;
        };
        match compare_semver(&staged.version, current) {
            Some(std::cmp::Ordering::Greater) => {
                // 多个就绪包（固定名覆盖下的版本演进残留）取最大版本
                let newer = result.ready.as_ref().is_none_or(|old| {
                    compare_semver(&staged.version, &old.version)
                        == Some(std::cmp::Ordering::Greater)
                });
                if newer {
                    result.ready = Some(StagedUpdateInfo {
                        version: staged.version,
                    });
                }
            }
            Some(std::cmp::Ordering::Equal) => {
                result.finished = Some(StagedUpdateInfo {
                    version: staged.version,
                });
            }
            // 低于当前（或比较不可得，from_entry 已保证合法，防御性归入清理）
            _ => {
                if let Err(err) = std::fs::remove_file(&path) {
                    tracing::warn!(error = %err, path = %path.display(), "prune stale staged update failed");
                }
            }
        }
    }
    result
}

/// 删除指定就绪包（前端完成提示后调用）：以版本号重构暂存包（路径不越过
/// IPC 边界），文件不存在视为幂等成功。
pub fn discard_staged_update(version: &str) -> Result<(), AppError> {
    StagedUpdate::from_version(version)?.discard()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn existing_dir_passes() {
        let dir = std::env::temp_dir();
        check_reachable(dir.to_str().unwrap()).await.unwrap();
    }

    #[tokio::test]
    async fn missing_path_is_unreachable() {
        let missing =
            std::env::temp_dir().join(format!("apilot-update-src-missing-{}", std::process::id()));
        let err = check_reachable(missing.to_str().unwrap())
            .await
            .unwrap_err();
        assert_eq!(err.code, "UPDATE_SOURCE_UNREACHABLE");
        assert!(err.message.contains("does not exist"));
    }

    #[tokio::test]
    async fn file_path_is_unreachable() {
        let file =
            std::env::temp_dir().join(format!("apilot-update-src-file-{}.txt", std::process::id()));
        std::fs::write(&file, "not a dir").unwrap();
        let err = check_reachable(file.to_str().unwrap()).await.unwrap_err();
        assert_eq!(err.code, "UPDATE_SOURCE_UNREACHABLE");
        assert!(err.message.contains("not a directory"));
        std::fs::remove_file(&file).ok();
    }

    // —— 更新检查（read_manifest / check_for_update）——

    fn temp_source_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("apilot-checkup-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_manifest(dir: &Path, version: &str, notes: &str) {
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::json!({
                "manifestVersion": 1, "version": version, "notes": notes,
                "pub_date": "2026-09-28T00:00:00Z", "required": false,
                "platforms": { "windows-x86_64": {
                    "file": format!("releases/{version}/APilot_{version}_x64-setup.exe"),
                    "size": 123, "sha256": "ab", "signature": "sig" } }
            })
            .to_string(),
        )
        .unwrap();
    }

    #[test]
    fn compare_semver_orders_strictly() {
        use std::cmp::Ordering;
        // 数值段按值比较（非字典序）
        assert_eq!(compare_semver("0.1.1", "0.1.0"), Some(Ordering::Greater));
        assert_eq!(compare_semver("0.2.0", "0.1.9"), Some(Ordering::Greater));
        assert_eq!(compare_semver("1.0.0", "0.9.9"), Some(Ordering::Greater));
        assert_eq!(compare_semver("0.10.0", "0.9.0"), Some(Ordering::Greater));
        assert_eq!(compare_semver("0.1.0", "0.1.0"), Some(Ordering::Equal));
        assert_eq!(compare_semver("0.1.0", "0.1.1"), Some(Ordering::Less));
        // pre-release 低于同版本正体，rc 之间按标识符排序
        assert_eq!(compare_semver("0.2.0-rc.1", "0.2.0"), Some(Ordering::Less));
        assert_eq!(
            compare_semver("0.2.0-rc.1", "0.2.0-rc.2"),
            Some(Ordering::Less)
        );
        assert_eq!(
            compare_semver("0.2.0-rc.1", "0.1.9"),
            Some(Ordering::Greater)
        );
        // 构建元数据不参与比较
        assert_eq!(compare_semver("1.0.0+a", "1.0.0+b"), Some(Ordering::Equal));
        // 任一侧非法 → None（调用方各自按非法处理，不猜排序）
        assert_eq!(compare_semver("x.y", "0.0.1"), None);
        assert_eq!(compare_semver("0.1", "0.1.0"), None);
    }

    #[test]
    fn manifest_status_maps_by_variant_not_message() {
        // 表驱动映射：按变体归类，错误文案不再参与判定
        //（含 invalid 字样的 Unreadable 仍归 unreachable）
        let cases: &[(ManifestError, &str)] = &[
            (
                ManifestError::Unreadable("no such file".into()),
                "unreachable",
            ),
            (
                ManifestError::Unreadable("manifest.json is not valid".into()),
                "unreachable",
            ),
            (
                ManifestError::Invalid("bad json".into()),
                "invalid_manifest",
            ),
            (
                ManifestError::Invalid("unsupported manifestVersion 9".into()),
                "invalid_manifest",
            ),
            (
                ManifestError::Invalid("no platform entry".into()),
                "invalid_manifest",
            ),
        ];
        for (err, expected) in cases {
            assert_eq!(&manifest_status(err), expected);
        }
    }

    #[test]
    fn manifest_download_error_maps_by_variant_to_phase_code() {
        assert_eq!(
            manifest_download_error(ManifestError::Unreadable("gone".into())).code,
            "UPDATE_MANIFEST_UNREADABLE"
        );
        assert_eq!(
            manifest_download_error(ManifestError::Invalid("bad".into())).code,
            "UPDATE_MANIFEST_INVALID"
        );
    }

    #[tokio::test]
    async fn check_reports_not_configured_for_missing_path_or_cloud() {
        // 未配置（updateSource 缺失）
        let r = check_for_update(None).await.unwrap();
        assert_eq!(r.status, "not_configured");
        // path 为空
        let r = check_for_update(Some(&serde_json::json!({"type": "local", "path": "  "})))
            .await
            .unwrap();
        assert_eq!(r.status, "not_configured");
        // cloud 类型（本期未对接）按未配置引导
        let r = check_for_update(Some(&serde_json::json!({"type": "cloud", "path": null})))
            .await
            .unwrap();
        assert_eq!(r.status, "not_configured");
    }

    #[tokio::test]
    async fn check_reports_direction_aware_statuses() {
        let dir = temp_source_dir("newer");
        // 用绝对版本值（不随构建版本漂移）：999.0.0 必新、0.0.1 必旧
        write_manifest(&dir, "999.0.0", "修复若干问题");
        let r = check_for_update(Some(
            &serde_json::json!({"type": "local", "path": dir.to_str()}),
        ))
        .await
        .unwrap();
        assert_eq!(r.status, "newer_available");
        assert_eq!(r.latest_version.as_deref(), Some("999.0.0"));
        assert_eq!(r.notes.as_deref(), Some("修复若干问题"));

        // pre-release 高于当前正体 → 可更新（严格 SemVer，不误判为相等/更旧）
        write_manifest(&dir, "999.0.0-rc.1", "");
        let r = check_for_update(Some(
            &serde_json::json!({"type": "local", "path": dir.to_str()}),
        ))
        .await
        .unwrap();
        assert_eq!(r.status, "newer_available");
        assert_eq!(r.latest_version.as_deref(), Some("999.0.0-rc.1"));

        // 清单版本等于当前 → 已是最新
        write_manifest(&dir, env!("CARGO_PKG_VERSION"), "");
        let r = check_for_update(Some(
            &serde_json::json!({"type": "local", "path": dir.to_str()}),
        ))
        .await
        .unwrap();
        assert_eq!(r.status, "up_to_date");

        // 清单版本低于当前 → 可回滚（发布回滚 = 清单指回旧版本）
        write_manifest(&dir, "0.0.1", "回滚说明");
        let r = check_for_update(Some(
            &serde_json::json!({"type": "local", "path": dir.to_str()}),
        ))
        .await
        .unwrap();
        assert_eq!(r.status, "downgrade_available");
        assert_eq!(r.latest_version.as_deref(), Some("0.0.1"));
        assert_eq!(r.notes.as_deref(), Some("回滚说明"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn check_reports_unreachable_and_invalid_manifest() {
        let dir = temp_source_dir("bad");
        // 清单缺失 → unreachable
        let r = check_for_update(Some(
            &serde_json::json!({"type": "local", "path": dir.to_str()}),
        ))
        .await
        .unwrap();
        assert_eq!(r.status, "unreachable");

        // 清单损坏 → invalid_manifest
        std::fs::write(dir.join("manifest.json"), "not-json").unwrap();
        let r = check_for_update(Some(
            &serde_json::json!({"type": "local", "path": dir.to_str()}),
        ))
        .await
        .unwrap();
        assert_eq!(r.status, "invalid_manifest");

        // 缺当前平台条目 → invalid_manifest
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::json!({
                "manifestVersion": 1, "version": "0.2.0",
                "platforms": { "linux-x86_64": { "file": "x", "size": 1, "sha256": "x", "signature": "x" } }
            })
            .to_string(),
        )
        .unwrap();
        let r = check_for_update(Some(
            &serde_json::json!({"type": "local", "path": dir.to_str()}),
        ))
        .await
        .unwrap();
        assert_eq!(r.status, "invalid_manifest");

        // manifestVersion 升级 → invalid_manifest
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::json!({
                "manifestVersion": 99, "version": "0.2.0",
                "platforms": { "windows-x86_64": { "file": "x", "size": 1, "sha256": "x", "signature": "x" } }
            })
            .to_string(),
        )
        .unwrap();
        let r = check_for_update(Some(
            &serde_json::json!({"type": "local", "path": dir.to_str()}),
        ))
        .await
        .unwrap();
        assert_eq!(r.status, "invalid_manifest");

        // 版本号非 SemVer → invalid_manifest（版本语义是三方判定地基，入口拒绝）
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::json!({
                "manifestVersion": 1, "version": "not-a-version",
                "platforms": { "windows-x86_64": { "file": "x", "size": 1, "sha256": "x", "signature": "x" } }
            })
            .to_string(),
        )
        .unwrap();
        let r = check_for_update(Some(
            &serde_json::json!({"type": "local", "path": dir.to_str()}),
        ))
        .await
        .unwrap();
        assert_eq!(r.status, "invalid_manifest");

        std::fs::remove_dir_all(&dir).ok();
    }

    // —— 下载 + 校验（真签名正路径由实机验证覆盖，单测负路径）——

    use sha2::Digest as _;

    /// 造一个完整更新源：包文件 + 清单（size/sha256 按包文件真实值，
    /// signature/sha256 可注入篡改）
    fn stage_source(tag: &str, patch: impl FnOnce(&mut serde_json::Value)) -> PathBuf {
        let dir = temp_source_dir(tag);
        let pkg = dir.join("APilot_9.9.9_x64-setup.exe");
        std::fs::write(&pkg, b"fake-installer-binary-content").unwrap();
        let size = std::fs::metadata(&pkg).unwrap().len();
        let sha256 = format!(
            "{:x}",
            sha2::Sha256::digest(b"fake-installer-binary-content")
        );
        let mut manifest = serde_json::json!({
            "manifestVersion": 1, "version": "9.9.9", "notes": "n",
            "platforms": { "windows-x86_64": {
                "file": "APilot_9.9.9_x64-setup.exe",
                "size": size, "sha256": sha256, "signature": "untrusted comment: signature\nFAKE=" } }
        });
        patch(&mut manifest);
        std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
        dir
    }

    #[tokio::test]
    async fn download_requires_configured_source() {
        let err = download_update(None).await.unwrap_err();
        assert_eq!(err.code, "UPDATE_SOURCE_NOT_CONFIGURED");
        // 云类型同样不下载
        let err = download_update(Some(&serde_json::json!({"type": "cloud", "path": null})))
            .await
            .unwrap_err();
        assert_eq!(err.code, "UPDATE_SOURCE_NOT_CONFIGURED");
    }

    #[tokio::test]
    async fn download_rejects_sha256_mismatch() {
        let dir = stage_source("sha", |m| {
            m["platforms"]["windows-x86_64"]["sha256"] = serde_json::json!(format!("{:x}", {
                let mut h = sha2::Sha256::new();
                h.update(b"different");
                h.finalize()
            }));
        });
        let err = download_update(Some(
            &serde_json::json!({"type": "local", "path": dir.to_str()}),
        ))
        .await
        .unwrap_err();
        assert_eq!(err.code, "UPDATE_CHECKSUM_MISMATCH");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn download_rejects_size_mismatch() {
        let dir = stage_source("size", |m| {
            m["platforms"]["windows-x86_64"]["size"] = serde_json::json!(12345);
        });
        let err = download_update(Some(
            &serde_json::json!({"type": "local", "path": dir.to_str()}),
        ))
        .await
        .unwrap_err();
        assert_eq!(err.code, "UPDATE_CHECKSUM_MISMATCH");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn download_rejects_invalid_signature_format() {
        // sha256 正确但签名是垃圾（base64 解不开的 minisign 形态）→ 验签前拦截
        let dir = stage_source("sig", |m| {
            m["platforms"]["windows-x86_64"]["signature"] =
                serde_json::json!("untrusted comment: signature\n###not-base64###");
        });
        let err = download_update(Some(
            &serde_json::json!({"type": "local", "path": dir.to_str()}),
        ))
        .await
        .unwrap_err();
        eprintln!("download err code={} message={}", err.code, err.message);
        assert_eq!(err.code, "UPDATE_SIGNATURE_INVALID");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn download_rejects_forged_signature() {
        // 结构合法（四行 minisign 形态、按 tauri 约定 base64 一层包装）但密钥伪造
        // → base64 解包与 decode 都应通过、verify 拦截（覆盖解包后的完整链路）
        use base64::Engine as _;
        let mut bin1 = vec![0x45u8, 0x64];
        bin1.extend_from_slice(&[0u8; 72]);
        let forged = format!(
            "untrusted comment: forged\n{}\ntrusted comment: forged\n{}\n",
            base64::engine::general_purpose::STANDARD.encode(&bin1),
            base64::engine::general_purpose::STANDARD.encode([0u8; 64]),
        );
        let dir = stage_source("forge", |m| {
            m["platforms"]["windows-x86_64"]["signature"] = serde_json::json!(
                base64::engine::general_purpose::STANDARD.encode(forged.as_bytes())
            );
        });
        let err = download_update(Some(
            &serde_json::json!({"type": "local", "path": dir.to_str()}),
        ))
        .await
        .unwrap_err();
        eprintln!("download err code={} message={}", err.code, err.message);
        assert_eq!(err.code, "UPDATE_SIGNATURE_INVALID");
        assert!(err.message.contains("signature verification failed"));
        std::fs::remove_dir_all(&dir).ok();
    }

    // —— 就绪包扫描 ——

    #[test]
    fn parse_staged_version_accepts_only_namespaced_semver() {
        assert_eq!(
            parse_staged_version("APilot-update-0.1.4.exe").as_deref(),
            Some("0.1.4")
        );
        // pre-release 形态可解析（pre-release 版本也走下载暂存安装链路）
        assert_eq!(
            parse_staged_version("APilot-update-0.2.0-rc.1.exe").as_deref(),
            Some("0.2.0-rc.1")
        );
        assert_eq!(parse_staged_version("APilot-update-1.2.exe"), None); // 段数不足
        assert_eq!(parse_staged_version("APilot-update-a.b.c.exe"), None); // 非 SemVer
        assert_eq!(parse_staged_version("APilot-update-0.1"), None); // 段数不足
        assert_eq!(parse_staged_version("APilot-update-0.1.4"), None); // 缺后缀
        assert_eq!(parse_staged_version("unrelated.txt"), None); // 命名空间外
    }

    #[test]
    fn from_version_rejects_non_semver_and_injection() {
        // 非法版本（含路径注入形态）一律拒绝，路径无法被外部形态影响
        for bad in [
            "",
            "abc",
            "0.1",
            "0.1.4.5",
            "../evil",
            "..\\..\\evil",
            "1.2.3/../../Windows/notepad.exe",
            "C:\\Windows\\notepad.exe",
        ] {
            let err = StagedUpdate::from_version(bad).unwrap_err();
            assert_eq!(err.code, "INVALID_ARGUMENT", "version {bad:?} 应被拒绝");
        }
        // 合法版本（含首尾空白裁剪）构造成功，路径固定落在临时目录命名空间内
        let staged = StagedUpdate::from_version(" 0.1.4 ").unwrap();
        assert_eq!(staged.version(), "0.1.4");
        assert_eq!(
            staged.path.parent(),
            Some(std::env::temp_dir().as_path()),
            "推导路径的父目录必须是系统临时目录"
        );
        assert_eq!(
            staged.path.file_name().and_then(|n| n.to_str()),
            Some("APilot-update-0.1.4.exe")
        );
        // pre-release 版本同样合法（文件名字符集安全），命名保持可扫场解析
        let rc = StagedUpdate::from_version("0.2.0-rc.1").unwrap();
        assert_eq!(
            rc.path.file_name().and_then(|n| n.to_str()),
            Some("APilot-update-0.2.0-rc.1.exe")
        );
        assert_eq!(
            parse_staged_version("APilot-update-0.2.0-rc.1.exe").as_deref(),
            Some("0.2.0-rc.1")
        );
    }

    #[test]
    fn from_entry_requires_temp_namespace() {
        // 与 sweep 用例共享临时目录，统一持锁串行（本用例不调 sweep，
        // 防护一致避免后续加断言踩互扰坑）
        let _guard = sweep_lock()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // 临时目录内匹配命名的文件可构造
        let inside = std::env::temp_dir().join("APilot-update-6.6.6.exe");
        std::fs::write(&inside, b"pkg").unwrap();
        let staged = StagedUpdate::from_entry(&inside).expect("临时目录内文件应可构造");
        assert_eq!(staged.version(), "6.6.6");
        std::fs::remove_file(&inside).ok();

        // 同名文件位于子目录（父目录非临时目录）不构造
        let nested_dir = std::env::temp_dir().join(format!("apilot-nested-{}", std::process::id()));
        std::fs::create_dir_all(&nested_dir).unwrap();
        let nested = nested_dir.join("APilot-update-6.6.6.exe");
        std::fs::write(&nested, b"pkg").unwrap();
        assert!(
            StagedUpdate::from_entry(&nested).is_none(),
            "子目录内文件不应被识别"
        );
        std::fs::remove_dir_all(&nested_dir).ok();
    }

    #[test]
    fn list_staged_updates_ignores_and_prunes_part_files() {
        // sweep 测试共享系统临时目录，并行互扰（另一用例的就绪包会让本用例
        // 的 ready 断言失真），统一串行
        let _guard = sweep_lock()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // 下载中断残留：.part 截断文件不被识别为就绪包，且被顺手清理。
        // 系统临时目录不受测试控制（可能存在真实就绪包），断言只针对
        // .part 自身的处置：不被分类为该版本的就绪包 + 文件被清理
        let version = "4.3.2";
        let part = std::env::temp_dir().join(format!("{STAGED_UPDATE_PREFIX}{version}.exe.part"));
        std::fs::write(&part, b"truncated").unwrap();

        let staged = list_staged_updates();
        assert_ne!(
            staged.ready.as_ref().map(|s| s.version.as_str()),
            Some(version),
            ".part 残留不得被分类为就绪包"
        );
        assert!(!part.exists(), ".part 残留应被顺手清理");
    }

    /// sweep 用例互斥锁（共享系统临时目录的测试串行化）
    fn sweep_lock() -> &'static std::sync::Mutex<()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(std::sync::Mutex::default)
    }

    #[test]
    fn list_staged_updates_classifies_and_prunes() {
        let _guard = sweep_lock()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let current = env!("CARGO_PKG_VERSION");
        let temp = std::env::temp_dir();
        let ready = temp.join(format!("{STAGED_UPDATE_PREFIX}9.9.9.exe"));
        let ready_rc = temp.join(format!("{STAGED_UPDATE_PREFIX}9.9.9-rc.1.exe"));
        let downgrade_rc = temp.join(format!("{STAGED_UPDATE_PREFIX}0.0.1-rc.1.exe"));
        let finished = temp.join(format!("{STAGED_UPDATE_PREFIX}{current}.exe"));
        let stale = temp.join(format!("{STAGED_UPDATE_PREFIX}0.0.1.exe"));
        std::fs::write(&ready, b"pkg").unwrap();
        std::fs::write(&ready_rc, b"pkg").unwrap();
        std::fs::write(&downgrade_rc, b"pkg").unwrap();
        std::fs::write(&finished, b"pkg").unwrap();
        std::fs::write(&stale, b"pkg").unwrap();

        let staged = list_staged_updates();
        // 多就绪包取最大版本（rc.1 高于当前但低于正体，不参报不清理）
        assert_eq!(
            staged.ready.as_ref().map(|s| s.version.as_str()),
            Some("9.9.9")
        );
        assert_eq!(
            staged.finished.as_ref().map(|s| s.version.as_str()),
            Some(current)
        );
        assert!(
            ready_rc.exists(),
            "高于当前的 pre-release 就绪包不按降级清理"
        );
        assert!(!stale.exists(), "陈旧残留（版本低于当前）应被顺手清理");
        assert!(
            !downgrade_rc.exists(),
            "降级方向（含 pre-release）不留暂存包：回滚是即时路径"
        );

        std::fs::remove_file(&ready).ok();
        std::fs::remove_file(&ready_rc).ok();
        std::fs::remove_file(&finished).ok();
    }

    #[test]
    fn discard_rejects_invalid_version_and_is_idempotent_for_missing() {
        // 版本形态不合法（哪怕文件名形似）一律拒绝——路径不再参与构造
        for bad in [
            "C:\\Windows\\system32\\APilot-update-0.1.4.exe",
            "C:\\Windows\\notepad.exe",
            "0.1",
        ] {
            let err = discard_staged_update(bad).unwrap_err();
            assert_eq!(err.code, "INVALID_ARGUMENT");
        }
        // 命名空间内不存在的文件幂等成功
        discard_staged_update("8.8.8").unwrap();
    }

    #[test]
    fn discard_staged_update_removes_namespaced_file() {
        let file = std::env::temp_dir().join(format!("{STAGED_UPDATE_PREFIX}7.7.7.exe"));
        std::fs::write(&file, b"pkg").unwrap();
        discard_staged_update("7.7.7").unwrap();
        assert!(!file.exists());
    }

    #[test]
    fn built_in_pubkey_decode() {
        let pk = minisign_verify::PublicKey::decode(UPDATE_PUBKEY);
        assert!(pk.is_ok(), "pubkey decode failed: {:?}", pk.err());
    }

    #[test]
    fn verify_launchable_rejects_missing_staged_file() {
        // 版本合法但暂存包不存在（重启后误调 / 手工清理）：拒绝进入待安装
        let err = StagedUpdate::from_version("98.76.5")
            .unwrap()
            .verify_launchable()
            .unwrap_err();
        assert_eq!(err.code, "UPDATE_INSTALL_FAILED");
        assert!(err.message.contains("missing"));
    }

    #[test]
    fn install_markers_are_namespaced_and_cleared_by_discard() {
        let _guard = sweep_lock()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let staged = StagedUpdate::from_version("9.6.4").unwrap();
        // 标记路径固定落在暂存命名空间内（最终名 + 后缀）
        assert_eq!(
            staged
                .attempt_marker_path()
                .file_name()
                .and_then(|n| n.to_str()),
            Some("APilot-update-9.6.4.exe.attempt")
        );
        assert_eq!(
            staged
                .failure_marker_path()
                .file_name()
                .and_then(|n| n.to_str()),
            Some("APilot-update-9.6.4.exe.failed")
        );

        // 意向标记 + 暂存包同时在场，discard 后三者全部清除
        let staged_file = staged.path.clone();
        std::fs::write(&staged_file, b"pkg").unwrap();
        staged.record_attempt();
        assert!(staged.attempt_marker_path().exists());
        staged.discard().unwrap();
        assert!(!staged_file.exists());
        assert!(!staged.attempt_marker_path().exists());
        assert!(!staged.failure_marker_path().exists());
    }

    #[test]
    fn sweep_reports_install_failure_once_and_keeps_staged() {
        let _guard = sweep_lock()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let staged = StagedUpdate::from_version("9.5.2").unwrap();
        // 安装未完成场景：暂存包（版本 > 当前）+ 意向标记同时残留
        std::fs::write(&staged.path, b"pkg").unwrap();
        staged.record_attempt();

        let first = list_staged_updates();
        assert_eq!(
            first.install_failed.as_ref().map(|s| s.version.as_str()),
            Some("9.5.2")
        );
        assert!(
            !staged.attempt_marker_path().exists(),
            "标记读即清（一次性反馈）"
        );
        assert!(staged.path.exists(), "暂存包保留供重试");
        assert_eq!(
            first.ready.as_ref().map(|s| s.version.as_str()),
            Some("9.5.2")
        );

        // 第二轮扫场不再重复反馈
        let second = list_staged_updates();
        assert!(second.install_failed.is_none());

        // 清理现场
        staged.discard().ok();
    }

    #[test]
    fn sweep_treats_attempt_marker_of_current_version_as_completed() {
        let _guard = sweep_lock()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // 安装成功场景：暂存包版本 = 当前 + 意向标记 → finished 而非失败反馈
        let current = env!("CARGO_PKG_VERSION");
        let staged = StagedUpdate::from_version(current).unwrap();
        std::fs::write(&staged.path, b"pkg").unwrap();
        staged.record_attempt();

        let result = list_staged_updates();
        assert!(result.install_failed.is_none(), "安装已完成不得报失败");
        assert_eq!(
            result.finished.as_ref().map(|s| s.version.as_str()),
            Some(current)
        );
        assert!(!staged.attempt_marker_path().exists(), "标记已清");

        staged.discard().ok();
    }

    #[test]
    fn sweep_surfaces_failure_marker_without_staged_file() {
        let _guard = sweep_lock()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // spawn 失败场景：只有失败标记，无暂存包
        let staged = StagedUpdate::from_version("9.5.3").unwrap();
        staged.record_failure();

        let result = list_staged_updates();
        assert_eq!(
            result.install_failed.as_ref().map(|s| s.version.as_str()),
            Some("9.5.3")
        );
        assert!(!staged.failure_marker_path().exists());

        staged.discard().ok();
    }
}
