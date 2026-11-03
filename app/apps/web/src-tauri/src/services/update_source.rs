//! 更新源服务：可达性校验与更新检查——
//! 本机文件夹 / 局域网共享（UNC）与云端 GitHub Release 双源的 `manifest.json`
//! 读取、解析与版本比较。检查只读清单不安装；下载 / 校验 / 安装在下方分节实现。
//!
//! 双源分界：folder 与 cloud 只在「清单与安装包字节从哪来」分叉——
//! folder 走文件系统（UNC 阻塞语义见下），cloud 走 HTTPS（GitHub Release
//! 直链：清单固定名资产 `releases/latest/download/manifest.json`，安装包按
//! 清单 `tag` 寻址 `releases/download/<tag>/<file>`，旧清单无 tag 时兼容走
//! latest 直链）。清单解析、平台条目选择、size/sha256/minisign 校验与暂存
//! 落盘（`.part` → 原子 rename）为双源共用段。
//!
//! 阻塞语义：UNC 在 SMB 不可达时 `fs` 操作会阻塞数秒以上，全部文件访问放
//! `spawn_blocking` 并按 `UPDATE_SOURCE_CHECK_TIMEOUT_MS` 超时兜底（超时 =
//! 不可达，不卡 Command）；注意 blocking 任务本身不可取消，超时后最长会
//! 占用一个 blocking 线程至 SMB 自然超时（池有界，可接受）。检查是单次
//! 只读动作，不持有任何资源。
//!
//! 云端请求的资源归属（四问）：请求对象（Client / Response）为函数局部
//! 值，即用即弃——每次检查 / 下载调用现建现用，函数返回即随栈帧释放，
//! 无长期句柄、不缓存连接与 release-assets 签名 URL（签名 URL 约 1 小时
//! 过期，缓存必错）；请求期间不持有任何跨 `await` 的资源锁，失败路径
//! （超时 / 重试 / 校验拒绝）仅丢弃局部缓冲，`.part` 中态残留由 boot 扫场
//! 清理（与 folder 同一规则）。用户侧取消沿用 folder 语义：单发请求由
//! HTTP 层超时兜底，前端丢弃 Promise 即不再等待结果。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::constants::{
    MAX_MANIFEST_BYTES, MAX_UPDATE_FILE_BYTES, UPDATE_CLOUD_CONNECT_TIMEOUT_MS,
    UPDATE_CLOUD_MANIFEST_TIMEOUT_MS, UPDATE_CLOUD_READ_TIMEOUT_MS,
    UPDATE_CLOUD_RETRY_AFTER_CAP_SECS, UPDATE_CLOUD_RETRY_ATTEMPTS,
    UPDATE_CLOUD_RETRY_BASE_DELAY_MS, UPDATE_SOURCE_CHECK_TIMEOUT_MS,
};
use crate::error::AppError;

/// 更新签名公钥（minisign 公钥文件两行格式，`PublicKey::decode` 按此解析）。
/// 来源：`~/.tauri/apilot-release.key.pub`（fingerprint 72717A9A59890552）的
/// base64 内容解码后的原文两行（tauri 的 `.pub` 是 minisign.pub 全文再 base64
/// 一层，`plugins.updater.pubkey` 用那层，本常量用解码后的原文）。
/// **正式发版换密钥时同步更新此常量**。
const UPDATE_PUBKEY: &str = "untrusted comment: minisign public key: 72717A9A59890552\nRWRSBYlZmnpxcqmBfp10g0pf5RgiiHr7zXYCWCH6UjNJwvrK9PK8A8c7";

/// 临时目录就绪包文件名前缀（download 落盘与 list 扫描共用同一常量防漂移）：
/// 完整形态 `APilot-update-<x.y.z>.exe`，落盘中态 `APilot-update-<x.y.z>.exe.part`
const STAGED_UPDATE_PREFIX: &str = "APilot-update-";

/// cloud 源默认仓库地址（settings 契约的默认预填值；UA 标识同源引用）。
/// 用户可改可删——指向任意 GitHub 仓库的 Releases。清单上传目标在
/// `publish-update.mjs` 的 GITHUB_REPO——同一仓库地址的两处事实，换仓库须两处齐改。
const DEFAULT_CLOUD_BASE_URL: &str = "https://github.com/amadeus19/apilot";

/// GitHub Release 直链路径段：清单挂最新正式 Release 的固定名资产位，
/// 安装包按清单 `tag` 落在带 tag 的不可变地址（两次请求间发新版不竞态）
const RELEASES_LATEST_PATH: &str = "/releases/latest/download/";
const RELEASES_DOWNLOAD_PATH: &str = "/releases/download/";
/// 清单资产固定名（GitHub Release 直链只支持固定名资产的 latest 通道）
const MANIFEST_ASSET_NAME: &str = "manifest.json";

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
    /// Release tag（新增可选顶层字段，向后兼容）：云端资产按
    /// `releases/download/<tag>/<file>` 不可变寻址，消除「检查与下载之间
    /// 发新版导致 latest 解析错位」的竞态；旧清单缺失时走 latest 兼容路径
    #[serde(default)]
    tag: Option<String>,
    platforms: HashMap<String, ManifestPlatform>,
}

/// manifest 平台键按运行架构映射（双架构定案：Windows x64 与 ARM64 双写）。
/// 纯函数便于表驱动测试；`current_platform_key` 包装运行时架构。
fn platform_key_for(arch: &str) -> Option<&'static str> {
    match arch {
        "x86_64" => Some("windows-x86_64"),
        "aarch64" => Some("windows-aarch64"),
        _ => None,
    }
}

/// 当前运行架构对应的 manifest 平台键；未支持架构返回 None（清单必然没有
/// 对应条目，按缺平台条目口径拒绝，不新增错误类别）。
fn current_platform_key() -> Option<&'static str> {
    platform_key_for(std::env::consts::ARCH)
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
    /// 清单顶层 tag（新 schema 可选字段）：云端资产按 tag 不可变寻址；
    /// None = 旧清单（无 tag），云端下载走 latest 兼容路径
    pub tag: Option<String>,
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

/// 清单解析与入口校验（folder / cloud 共用）：manifestVersion 与版本号
/// SemVer 在入口拒绝（版本语义是检查 / 安装 / 扫场三方共用的判定地基）。
/// 平台条目校验在 [`select_platform`]——键名随运行架构变化，不在此固化。
fn parse_manifest(raw: &str) -> Result<Manifest, ManifestError> {
    let manifest: Manifest = serde_json::from_str(raw)
        .map_err(|err| ManifestError::Invalid(format!("manifest.json is not valid: {err}")))?;
    if manifest.manifest_version != 1 {
        return Err(ManifestError::Invalid(format!(
            "unsupported manifestVersion {}",
            manifest.manifest_version
        )));
    }
    semver::Version::parse(&manifest.version).map_err(|err| {
        ManifestError::Invalid(format!("manifest version is not valid semver: {err}"))
    })?;
    Ok(manifest)
}

/// 当前平台条目选择：架构映射平台键后查清单；运行架构不受支持或清单缺
/// 当前平台条目均按 Invalid（清单对当前环境不可用，配置面问题）。
fn select_platform(manifest: &Manifest) -> Result<&ManifestPlatform, ManifestError> {
    let key = current_platform_key().ok_or_else(|| {
        ManifestError::Invalid(format!(
            "unsupported runtime arch {}",
            std::env::consts::ARCH
        ))
    })?;
    manifest.platforms.get(key).ok_or_else(|| {
        ManifestError::Invalid(format!("manifest has no {key} platform entry"))
    })
}

/// 读取并解析本机源清单（blocking 内执行）：文件读取属源侧失败（Unreadable），
/// 解析校验属清单侧失败（Invalid）。
fn read_manifest_blocking(source_root: PathBuf) -> Result<Manifest, ManifestError> {
    let manifest_path = source_root.join("manifest.json");
    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|err| ManifestError::Unreadable(format!("manifest.json unreadable: {err}")))?;
    parse_manifest(&raw)
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

/// 失败检查出口共用形状：状态 + 英文细节 notes，latest_version / tag 恒 None
fn note_status_result(status: &'static str, note: impl Into<String>) -> CheckUpdatesResult {
    CheckUpdatesResult {
        status,
        latest_version: None,
        notes: Some(note.into()),
        tag: None,
    }
}

/// 未到达状态（unreachable + 英文细节 notes）：源侧失败的统一检查出口
fn unreachable_status(note: impl Into<String>) -> CheckUpdatesResult {
    note_status_result("unreachable", note)
}

/// 清单 → 检查结果（双源共用尾段）：平台条目校验 + 版本方向三分。
/// 方向三分：清单高于当前 → 可更新；低于当前 → 可回滚（发布回滚 = 清单
/// 指回旧版本，旧版包仍在源内，按同一「下载 → 确认 → 安装」路径安装）。
/// None 不可达：清单版本已在解析时校验为合法 SemVer，当前版本编译期固定。
fn manifest_check_result(manifest: Manifest) -> Result<CheckUpdatesResult, ManifestError> {
    select_platform(&manifest)?;
    let current = env!("CARGO_PKG_VERSION");
    let tag = manifest.tag;
    let notes = (!manifest.notes.is_empty()).then_some(manifest.notes);
    Ok(match compare_semver(&manifest.version, current) {
        Some(std::cmp::Ordering::Greater) => CheckUpdatesResult {
            status: "newer_available",
            latest_version: Some(manifest.version),
            notes,
            tag,
        },
        Some(std::cmp::Ordering::Less) => CheckUpdatesResult {
            status: "downgrade_available",
            latest_version: Some(manifest.version),
            notes,
            tag,
        },
        _ => CheckUpdatesResult {
            status: "up_to_date",
            latest_version: Some(manifest.version),
            // 已是最新不带 notes（与既有行为一致）
            notes: None,
            tag,
        },
    })
}

/// ManifestError → 检查结果（unreachable / invalid_manifest 状态 + 细节 notes）
fn manifest_error_status(err: &ManifestError) -> CheckUpdatesResult {
    let reason = match err {
        ManifestError::Unreadable(reason) | ManifestError::Invalid(reason) => reason.clone(),
    };
    note_status_result(manifest_status(err), reason)
}

/// 更新检查主流程：`updateSource` 设置（`kind` 判别，兼容旧 `type` 数据）→
/// 未配置按 not_configured 返回；folder 读清单比版本，cloud 经 HTTPS 拉取。
pub async fn check_for_update(
    update_source: Option<&serde_json::Value>,
) -> Result<CheckUpdatesResult, AppError> {
    let Some(config) = parse_update_source(update_source) else {
        return Ok(CheckUpdatesResult {
            status: "not_configured",
            latest_version: None,
            notes: None,
            tag: None,
        });
    };
    match config {
        UpdateSourceConfig::Folder { path } => check_folder_source(&path).await,
        UpdateSourceConfig::Cloud {
            base_url,
            mirror_prefix,
        } => {
            check_cloud_source(&base_url, &mirror_prefix, &CloudHttpPolicy::default()).await
        }
    }
}

/// folder 源检查：spawn_blocking 读清单 + 超时兜底（UNC 阻塞语义见模块头）。
async fn check_folder_source(path: &str) -> Result<CheckUpdatesResult, AppError> {
    let owned = path.to_owned();
    let read = tokio::task::spawn_blocking(move || read_manifest_blocking(PathBuf::from(owned)));
    let manifest =
        match tokio::time::timeout(Duration::from_millis(UPDATE_SOURCE_CHECK_TIMEOUT_MS), read)
            .await
        {
            // timeout ok + join ok + read ok
            Ok(Ok(Ok(manifest))) => manifest,
            // timeout ok + join ok + read err（清单缺失 / 损坏 / 不支持）：查表归状态
            Ok(Ok(Err(err))) => return Ok(manifest_error_status(&err)),
            // timeout ok + join err（blocking 任务 panic，内部错误）
            Ok(Err(err)) => {
                return Err(AppError::internal(format!(
                    "update source read failed: {err}"
                )));
            }
            // 超时（UNC 不可达等）
            Err(_elapsed) => return Ok(unreachable_status(format!(
                "timed out after {UPDATE_SOURCE_CHECK_TIMEOUT_MS}ms"
            ))),
        };
    Ok(manifest_check_result(manifest).unwrap_or_else(|err| manifest_error_status(&err)))
}

/// cloud 源检查：HTTPS 拉清单（请求自带超时与重试，不叠加外层超时——
/// 重试退避叠加固定外层超时会掐死合法慢网络请求）。请求失败统一归
/// unreachable 状态（源问题，可重试 / 可配镜像），清单损坏归 invalid_manifest。
async fn check_cloud_source(
    base_url: &str,
    mirror_prefix: &str,
    policy: &CloudHttpPolicy,
) -> Result<CheckUpdatesResult, AppError> {
    let manifest = match fetch_cloud_manifest(base_url, mirror_prefix, policy).await {
        Ok(manifest) => manifest,
        Err(err) => {
            return Ok(note_status_result(
                cloud_manifest_status(&err),
                err.reason().to_owned(),
            ));
        }
    };
    Ok(manifest_check_result(manifest).unwrap_or_else(|err| manifest_error_status(&err)))
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

/// 更新源配置（settings 键 `updateSource` 的解析形态，`kind` 判别字段与
/// 前端契约一致，serde camelCase）。
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum UpdateSourceConfig {
    /// 本机文件夹 / 局域网共享（UNC）：清单与安装包从目录读取（沿用 `path`）
    Folder { path: String },
    /// 云端 GitHub Release：`baseUrl` 仓库地址（默认预填官方仓库），
    /// `mirrorPrefix` 镜像前缀（空 = 直连）
    Cloud {
        base_url: String,
        mirror_prefix: String,
    },
}

/// settings JSON → 更新源配置（None = 未配置 / 形态不识别，调用方按
/// not_configured 引导，不猜不救）。
///
/// 兼容规则：`kind` 缺失按 folder 处理——旧数据 `{type:"local"|"network",
/// path}` 直接落 folder；旧 `type:"cloud"` 数据 path 必空，随 folder 解析
/// 自然落未配置（与旧版「cloud 未对接按未配置」行为一致）。cloud 的
/// `baseUrl` / `mirrorPrefix` 缺失或空白回落契约默认值（默认地址 / 直连）。
fn parse_update_source(value: Option<&serde_json::Value>) -> Option<UpdateSourceConfig> {
    let v = value?;
    let kind = v
        .get("kind")
        .and_then(|k| k.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match kind {
        Some("cloud") => {
            let base_url = v
                .get("baseUrl")
                .and_then(|b| b.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_CLOUD_BASE_URL)
                .to_owned();
            let mirror_prefix = v
                .get("mirrorPrefix")
                .and_then(|m| m.as_str())
                .map(str::trim)
                .unwrap_or("")
                .to_owned();
            Some(UpdateSourceConfig::Cloud {
                base_url,
                mirror_prefix,
            })
        }
        // folder 显式判别；kind 缺失（旧数据）同样按 folder
        None | Some("folder") => {
            let path = v
                .get("path")
                .and_then(|p| p.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())?;
            Some(UpdateSourceConfig::Folder { path: path.to_owned() })
        }
        // 未知判别值：按未配置引导（前端展示默认态，不按猜出的源执行）
        Some(_) => None,
    }
}

/// 下载并校验更新包（folder，blocking 内执行）：读源文件进内存 → 交共用
/// 校验落盘段。folder 与 cloud 只在字节来源分叉（文件系统 vs HTTPS 流），
/// 校验与落盘走同一条路（[`verify_and_stage`]）。
fn download_and_verify_blocking(source_root: &Path) -> Result<StagedUpdateInfo, AppError> {
    let manifest =
        read_manifest_blocking(source_root.to_path_buf()).map_err(manifest_download_error)?;
    let platform = select_platform(&manifest).map_err(manifest_download_error)?;

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
    verify_and_stage(&manifest.version, platform, &bytes)
}

/// 校验（size / sha256 / minisign）+ 暂存落盘（folder / cloud 共用尾段）。
/// 顺序经过实测校准：**先校验后落盘**——落盘后的 .exe 会被 Windows Defender
/// 实时扫描短暂独占，读回校验会撞 error 32；先校验后写则写完即返回，无
/// 读回竞态。任何一步失败拒绝安装。
fn verify_and_stage(
    version: &str,
    platform: &ManifestPlatform,
    bytes: &[u8],
) -> Result<StagedUpdateInfo, AppError> {
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
    let actual_hash = format!("{:x}", sha2::Sha256::digest(bytes));
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
        .verify(bytes, &signature, false)
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
    let staged = StagedUpdate::from_version(version)?;
    let final_path = staged.path;
    let part_path = std::env::temp_dir().join(StagedUpdate::part_file_name(version));
    std::fs::write(&part_path, bytes).map_err(|err| {
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
        version: version.to_owned(),
    })
}

// —— 云端 HTTPS 基建（清单拉取 / 资产下载共用）——

/// 云端 HTTP 参数包：生产默认取 constants 登记（清单 connect 10s + 总 30s、
/// 下载 connect 10s + read 30s、重试 2 次退避 1s→4s）；测试注入小值加速。
/// 集中成包是为了让 mock 测试能在不碰生产常量的前提下走全链路。
struct CloudHttpPolicy {
    connect_timeout: Duration,
    /// 清单总超时（从连接到 body 读完）；资产下载不设总超时
    manifest_total_timeout: Duration,
    /// 资产下载单次读超时（僵死连接检测，读成功即重置）
    download_read_timeout: Duration,
    /// 可重试失败的额外尝试次数（总尝试 = 1 + 此值）
    extra_attempts: u32,
    /// 退避基数：第 n 次重试等待 `基数 × 4^(n-1)`
    base_delay: Duration,
}

impl Default for CloudHttpPolicy {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_millis(UPDATE_CLOUD_CONNECT_TIMEOUT_MS),
            manifest_total_timeout: Duration::from_millis(UPDATE_CLOUD_MANIFEST_TIMEOUT_MS),
            download_read_timeout: Duration::from_millis(UPDATE_CLOUD_READ_TIMEOUT_MS),
            extra_attempts: UPDATE_CLOUD_RETRY_ATTEMPTS,
            base_delay: Duration::from_millis(UPDATE_CLOUD_RETRY_BASE_DELAY_MS),
        }
    }
}

/// 云端请求失败分类（HTTP 语义细分；检查与下载两阶段各自映射状态 / 错误码，
/// 映射表见 [`cloud_manifest_status`] 与 [`cloud_request_error`]）。
#[derive(Debug)]
enum CloudRequestError {
    /// 404：清单 / 资产在源上不存在（终态，不重试——latest 通道无正式
    /// Release、未挂对应资产，或 tag 不存在）
    NotFound(String),
    /// 非 404 的不可重试 HTTP 拒绝（401/403 等：源侧拒绝访问，重试无意义）
    Unreachable(String),
    /// 可重试失败（网络错 / 超时 / 429 / 5xx）退避重试后仍不成功
    RetriesExhausted(String),
}

impl CloudRequestError {
    /// 失败细节（检查阶段随 notes 展示、下载阶段进 AppError message）
    fn reason(&self) -> &str {
        match self {
            Self::NotFound(r) | Self::Unreachable(r) | Self::RetriesExhausted(r) => r,
        }
    }
}

/// cloud 清单获取失败 = 请求失败分类 + 清单校验失败（Invalid）的合并
#[derive(Debug)]
enum CloudManifestError {
    Request(CloudRequestError),
    Invalid(String),
}

impl CloudManifestError {
    fn reason(&self) -> &str {
        match self {
            Self::Request(err) => err.reason(),
            Self::Invalid(r) => r,
        }
    }
}

/// 检查阶段：cloud 清单失败 → 检查状态（取不到归 unreachable 可重试 /
/// 可配镜像；损坏归 invalid_manifest 需修源——与 folder 同一口径）
fn cloud_manifest_status(err: &CloudManifestError) -> &'static str {
    match err {
        CloudManifestError::Invalid(_) => "invalid_manifest",
        CloudManifestError::Request(_) => "unreachable",
    }
}

/// 下载阶段：cloud 请求失败 → 阶段错误码（HTTP 语义变体精确切分）
fn cloud_request_error(err: CloudRequestError) -> AppError {
    match err {
        CloudRequestError::NotFound(reason) => {
            AppError::new(crate::error::codes::UPDATE_SOURCE_NOT_FOUND, reason)
        }
        CloudRequestError::Unreachable(reason) => {
            AppError::new(crate::error::codes::UPDATE_SOURCE_UNREACHABLE, reason)
        }
        CloudRequestError::RetriesExhausted(reason) => {
            AppError::new(crate::error::codes::UPDATE_SOURCE_RETRIES_EXHAUSTED, reason)
        }
    }
}

/// 下载阶段：cloud 清单获取失败 → 阶段错误码（请求分类复用 [`cloud_request_error`]）
fn cloud_manifest_download_error(err: CloudManifestError) -> AppError {
    match err {
        CloudManifestError::Request(err) => cloud_request_error(err),
        CloudManifestError::Invalid(reason) => {
            AppError::new(crate::error::codes::UPDATE_MANIFEST_INVALID, reason)
        }
    }
}

/// 仓库地址规范化：去首尾空白与尾斜杠（清单 / 资产 URL 的拼接基底）
fn normalize_base_url(base_url: &str) -> &str {
    base_url.trim().trim_end_matches('/')
}

/// 镜像前缀套用：空 = 直连原 URL；非空 = 前缀原样前置到完整 GitHub URL
/// 之前（ghproxy 形态 `<prefix><原URL>`，约定前缀自带尾斜杠，如
/// `https://gh-proxy.com/`）。作用域 = 清单与资产全部 GitHub URL——只代理
/// 清单不代理资产时大陆用户资产下载仍会卡死（研究结论），故统一在此套用。
fn apply_mirror_prefix(prefix: &str, url: &str) -> String {
    let prefix = prefix.trim();
    if prefix.is_empty() {
        url.to_owned()
    } else {
        format!("{prefix}{url}")
    }
}

/// cloud 清单 URL：`<mirror><base>/releases/latest/download/manifest.json`
fn cloud_manifest_url(base_url: &str, mirror_prefix: &str) -> String {
    apply_mirror_prefix(
        mirror_prefix,
        &format!(
            "{}{RELEASES_LATEST_PATH}{MANIFEST_ASSET_NAME}",
            normalize_base_url(base_url)
        ),
    )
}

/// cloud 资产 URL：新清单按 `tag` 不可变寻址（`releases/download/<tag>/<file>`，
/// 消除检查与下载之间发新版的竞态）；旧清单无 tag 走 latest 兼容路径
/// （`releases/latest/download/<file>`）。`file` 为 Release 资产文件名。
fn cloud_asset_url(base_url: &str, mirror_prefix: &str, tag: Option<&str>, file: &str) -> String {
    let suffix = match tag {
        Some(tag) => format!("{RELEASES_DOWNLOAD_PATH}{tag}/{file}"),
        None => format!("{RELEASES_LATEST_PATH}{file}"),
    };
    apply_mirror_prefix(
        mirror_prefix,
        &format!("{}{suffix}", normalize_base_url(base_url)),
    )
}

/// 标识 UA：`Apilot/<版本> (+仓库主页)`——GitHub 反滥用画像友好、出问题可
/// 排查，且公共镜像站普遍要求正常 UA。地址取官方仓库常量（非用户配置值：
/// 配置值随用户输入变化，不适合作为进程标识）。
fn cloud_user_agent() -> String {
    format!(
        "Apilot/{} (+{})",
        env!("CARGO_PKG_VERSION"),
        DEFAULT_CLOUD_BASE_URL
    )
}

/// 清单请求 client：connect 超时 + 总超时（清单是 KB 级小对象，总超时可控）
fn manifest_client(policy: &CloudHttpPolicy) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .connect_timeout(policy.connect_timeout)
        .timeout(policy.manifest_total_timeout)
        .user_agent(cloud_user_agent())
        .build()
}

/// 资产下载 client：connect 超时 + 单次读超时（僵死连接检测），
/// **不设总超时**——大文件传输时长不可预估，读停滞由 read_timeout 兜底。
fn download_client(policy: &CloudHttpPolicy) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .connect_timeout(policy.connect_timeout)
        .read_timeout(policy.download_read_timeout)
        .user_agent(cloud_user_agent())
        .build()
}

/// 云端 GET 重试语义：网络错（连接 / DNS / TLS / 超时）、429、5xx → 指数
/// 退避重试（429 尊重 Retry-After，秒粒度封顶防呆）；404 → 终态不重试；
/// 其余 4xx → 源侧拒绝不重试。重定向跟随 reqwest 默认（上限 10 跳，GitHub
/// 链路 2 跳足够）。请求即用即弃：函数不缓存 Response（release-assets 签名
/// URL 约 1 小时过期，缓存必错——重试从原始 URL 重新走重定向）。
async fn get_with_retry(
    client: &reqwest::Client,
    url: &str,
    policy: &CloudHttpPolicy,
) -> Result<reqwest::Response, CloudRequestError> {
    let mut retry_after_override: Option<Duration> = None;
    let mut last_err = CloudRequestError::RetriesExhausted("no attempt made".to_owned());
    for attempt in 0..=policy.extra_attempts {
        if attempt > 0 {
            // 退避：显式 Retry-After 优先（429 服务端指令），否则指数 4 倍步进
            let delay = retry_after_override.take().unwrap_or_else(|| {
                policy.base_delay * 4u32.saturating_pow(attempt - 1)
            });
            tokio::time::sleep(delay).await;
        }
        match client.get(url).send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    return Ok(resp);
                }
                let reason = format!("HTTP {status} for {url}");
                if status.as_u16() == 404 {
                    return Err(CloudRequestError::NotFound(reason));
                }
                if status.is_client_error() {
                    return Err(CloudRequestError::Unreachable(reason));
                }
                // 429/5xx：可重试，记录失败并按 Retry-After（若有）退避
                last_err = CloudRequestError::RetriesExhausted(reason);
                if status.as_u16() == 429 {
                    retry_after_override = resp
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.trim().parse::<u64>().ok())
                        .map(|secs| {
                            Duration::from_secs(secs.min(UPDATE_CLOUD_RETRY_AFTER_CAP_SECS))
                        });
                }
            }
            Err(err) => {
                // 网络错（含连接 / 读超时）一律视为可重试
                last_err = CloudRequestError::RetriesExhausted(format!("request failed: {err}"));
            }
        }
    }
    Err(last_err)
}

/// 拉取并解析 cloud 清单（检查与下载共用）：`<mirror><base>/releases/latest/
/// download/manifest.json` → [`Manifest`]（manifestVersion / SemVer 入口校验，
/// 平台条目校验在 [`select_platform`]）。
async fn fetch_cloud_manifest(
    base_url: &str,
    mirror_prefix: &str,
    policy: &CloudHttpPolicy,
) -> Result<Manifest, CloudManifestError> {
    let url = cloud_manifest_url(base_url, mirror_prefix);
    let client = manifest_client(policy).map_err(|err| {
        CloudManifestError::Request(CloudRequestError::Unreachable(format!(
            "http client build failed: {err}"
        )))
    })?;
    let resp = get_with_retry(&client, &url, policy)
        .await
        .map_err(CloudManifestError::Request)?;
    // 清单体读入内存有界（与资产侧 collect_asset_bytes 同款双护栏）：
    // Content-Length 预检超限即拒；逐 chunk 累计兜底流式响应。正常清单
    // 为 KB 量级 JSON，超限属服务端异常（劫持/故障），拒绝解析。
    if let Some(len) = resp.content_length() {
        if len > MAX_MANIFEST_BYTES {
            return Err(CloudManifestError::Invalid(format!(
                "manifest too large: {len} bytes exceeds limit {MAX_MANIFEST_BYTES}"
            )));
        }
    }
    let mut raw_bytes: Vec<u8> = Vec::new();
    let mut resp = resp;
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if raw_bytes.len() as u64 + chunk.len() as u64 > MAX_MANIFEST_BYTES {
                    return Err(CloudManifestError::Invalid(format!(
                        "manifest too large: exceeds limit {MAX_MANIFEST_BYTES}"
                    )));
                }
                raw_bytes.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(err) => {
                return Err(CloudManifestError::Request(CloudRequestError::Unreachable(
                    format!("manifest body read failed: {err}"),
                )));
            }
        }
    }
    let raw = String::from_utf8(raw_bytes)
        .map_err(|_| CloudManifestError::Invalid("manifest is not valid UTF-8".to_owned()))?;
    match parse_manifest(&raw) {
        Ok(manifest) => Ok(manifest),
        // parse_manifest 只产生 Invalid；Unreadable 分支防御性兜底
        Err(ManifestError::Invalid(reason)) => Err(CloudManifestError::Invalid(reason)),
        Err(ManifestError::Unreadable(reason)) => {
            Err(CloudManifestError::Request(CloudRequestError::Unreachable(reason)))
        }
    }
}

/// 资产字节收集（内存缓冲有界）：Content-Length 预检 + 逐 chunk 累计护栏，
/// 超限即中断不再收数；读停滞由 client read_timeout 兜底。最终尺寸与内容
/// 完整性由 [`verify_and_stage`] 按清单 size + sha256 硬校验兜底。
async fn collect_asset_bytes(
    resp: reqwest::Response,
    max_bytes: u64,
) -> Result<Vec<u8>, AppError> {
    if let Some(len) = resp.content_length() {
        if len > max_bytes {
            return Err(AppError::new(
                crate::error::codes::UPDATE_CHECKSUM_MISMATCH,
                format!("asset size {len} exceeds cap {max_bytes}"),
            ));
        }
    }
    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| {
            AppError::new(
                crate::error::codes::UPDATE_PACKAGE_UNREADABLE,
                format!("asset download interrupted: {err}"),
            )
        })?;
        if bytes.len() as u64 + chunk.len() as u64 > max_bytes {
            return Err(AppError::new(
                crate::error::codes::UPDATE_CHECKSUM_MISMATCH,
                format!("asset size exceeds cap {max_bytes}"),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// cloud 下载主流程：拉清单（同检查链路）→ 选平台条目 → 按 tag 构造资产
/// URL → 流式下载（大小护栏）→ 共用校验落盘段（size/sha256/minisign →
/// `.part` → 原子 rename）。清单与资产每次调用现拉（不缓存 latest 解析
/// 结果与签名 URL），按「已取得的清单」整套执行——两请求间发新版时本套
/// tag+sha256 校验天然自洽，无竞态处理需求。
async fn download_cloud_update(
    base_url: &str,
    mirror_prefix: &str,
    policy: &CloudHttpPolicy,
) -> Result<StagedUpdateInfo, AppError> {
    let manifest =
        fetch_cloud_manifest(base_url, mirror_prefix, policy)
            .await
            .map_err(cloud_manifest_download_error)?;
    let platform = select_platform(&manifest).map_err(manifest_download_error)?;
    let url = cloud_asset_url(
        base_url,
        mirror_prefix,
        manifest.tag.as_deref(),
        &platform.file,
    );
    let client = download_client(policy).map_err(|err| {
        AppError::new(
            crate::error::codes::UPDATE_SOURCE_UNREACHABLE,
            format!("http client build failed: {err}"),
        )
    })?;
    let resp = get_with_retry(&client, &url, policy)
        .await
        .map_err(cloud_request_error)?;
    let bytes = collect_asset_bytes(resp, MAX_UPDATE_FILE_BYTES).await?;
    verify_and_stage(&manifest.version, platform, &bytes)
}

/// 下载 + 校验（Command 层入口）：按 `kind` 分流——folder 走 spawn_blocking
/// + 总超时兜底（UNC 复制可能长时间阻塞）；cloud 走 async HTTPS（超时由
/// 请求层承担：清单有总超时、下载只有读超时不设总超时，外层不再叠加）。
pub async fn download_update(
    update_source: Option<&serde_json::Value>,
) -> Result<StagedUpdateInfo, AppError> {
    let Some(config) = parse_update_source(update_source) else {
        return Err(AppError::new(
            crate::error::codes::UPDATE_SOURCE_NOT_CONFIGURED,
            "update source is not configured or unsupported type",
        ));
    };
    match config {
        UpdateSourceConfig::Folder { path } => {
            let read =
                tokio::task::spawn_blocking(move || download_and_verify_blocking(Path::new(&path)));
            match tokio::time::timeout(
                Duration::from_millis(UPDATE_SOURCE_CHECK_TIMEOUT_MS * 10),
                read,
            )
            .await
            {
                Ok(Ok(result)) => result,
                Ok(Err(err)) => {
                    Err(AppError::internal(format!("update download failed: {err}")))
                }
                Err(_elapsed) => Err(AppError::new(
                    crate::error::codes::UPDATE_DOWNLOAD_TIMED_OUT,
                    format!(
                        "download timed out after {}ms",
                        UPDATE_SOURCE_CHECK_TIMEOUT_MS * 10
                    ),
                )),
            }
        }
        UpdateSourceConfig::Cloud {
            base_url,
            mirror_prefix,
        } => {
            download_cloud_update(&base_url, &mirror_prefix, &CloudHttpPolicy::default()).await
        }
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

    // —— 云端源（mock HTTP 服务器，不依赖公网）——

    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    /// 单次请求记录：path 与 UA（镜像前缀拼接形态与 UA 语义的断言材料）
    #[derive(Debug, Clone)]
    struct MockRequest {
        path: String,
        user_agent: String,
    }

    /// 路由行为：
    /// - Sequence：按请求序回放（状态码 + body），耗尽后重复最后一个——
    ///   「503 后 200」重试序列与重试耗尽（请求计数断言）都以此表达；
    /// - StallAfterHeaders：发响应头 + body 前缀后挂住连接——资产下载的
    ///   读超时测试（对端已收请求、响应头已到、body 停滞不发）；
    /// - Hang：收下请求后不回包不关连接——清单总超时测试（对端静默）。
    enum MockBehavior {
        Sequence(Vec<(u16, Vec<u8>)>),
        StallAfterHeaders {
            status: u16,
            content_length: u64,
            prefix: &'static [u8],
        },
        Hang,
    }

    /// 最小 HTTP 应答帧（Content-Length 明示 + Connection: close，一请求一连接）
    fn http_response(status: u16, body: &[u8]) -> Vec<u8> {
        let reason = match status {
            200 => "OK",
            404 => "Not Found",
            429 => "Too Many Requests",
            503 => "Service Unavailable",
            _ => "Error",
        };
        let mut resp = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        resp.extend_from_slice(body);
        resp
    }

    struct CloudMock {
        base: String,
        requests: Arc<Mutex<Vec<MockRequest>>>,
    }

    impl CloudMock {
        fn request_count(&self) -> usize {
            self.requests.lock().unwrap_or_else(std::sync::PoisonError::into_inner).len()
        }

        fn request_paths(&self) -> Vec<String> {
            self.requests
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .iter()
                .map(|r| r.path.clone())
                .collect()
        }

        fn last_user_agent(&self) -> Option<String> {
            self.requests
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .last()
                .map(|r| r.user_agent.clone())
        }
    }

    /// mock 更新源服务器（测试专用，不依赖公网）：按路径路由，每连接处理
    /// 一个请求（Connection: close）。头名解析大小写不敏感（hyper 发小写）。
    async fn spawn_cloud_mock(routes: Vec<(&str, MockBehavior)>) -> CloudMock {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let route_map: HashMap<String, MockBehavior> = routes
            .into_iter()
            .map(|(p, b)| (p.to_owned(), b))
            .collect();
        let requests = Arc::new(Mutex::new(Vec::<MockRequest>::new()));
        let req_log = Arc::clone(&requests);
        // Sequence 游标按路由路径计请求序（多路由互不干扰）
        tokio::spawn(async move {
            let routes = Arc::new(route_map);
            let cursors = Arc::new(Mutex::new(HashMap::<String, usize>::new()));
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let routes = Arc::clone(&routes);
                let cursors = Arc::clone(&cursors);
                let req_log = Arc::clone(&req_log);
                tokio::spawn(async move {
                    // 读请求头（到空行止；GET 无 body，不继续读）
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 1024];
                    loop {
                        match socket.read(&mut tmp).await {
                            Ok(0) => break,
                            Ok(n) => {
                                buf.extend_from_slice(&tmp[..n]);
                                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    let head = String::from_utf8_lossy(&buf);
                    let request_line = head.lines().next().unwrap_or("");
                    let path = request_line
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("")
                        .to_owned();
                    let user_agent = head
                        .lines()
                        .find_map(|l| {
                            let (k, v) = l.split_once(':')?;
                            k.eq_ignore_ascii_case("user-agent")
                                .then(|| v.trim().to_owned())
                        })
                        .unwrap_or_default();
                    req_log
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .push(MockRequest { path: path.clone(), user_agent });

                    let Some(behavior) = routes.get(&path) else {
                        let _ = socket.write_all(&http_response(404, b"no route")).await;
                        return;
                    };
                    match behavior {
                        MockBehavior::Sequence(resps) => {
                            let (status, body) = {
                                let mut cursors = cursors
                                    .lock()
                                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                                let idx = cursors.entry(path).or_insert(0);
                                let item = resps
                                    .get(*idx)
                                    .unwrap_or_else(|| resps.last().expect("empty sequence"));
                                *idx += 1;
                                item.clone()
                            };
                            let _ = socket.write_all(&http_response(status, &body)).await;
                        }
                        MockBehavior::StallAfterHeaders {
                            status,
                            content_length,
                            prefix,
                        } => {
                            let head_text = format!(
                                "HTTP/1.1 {status} OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {content_length}\r\nConnection: close\r\n\r\n"
                            );
                            let _ = socket.write_all(head_text.as_bytes()).await;
                            let _ = socket.write_all(prefix).await;
                            // body 停滞：挂住连接，等客户端读超时断开
                            tokio::time::sleep(Duration::from_secs(3600)).await;
                        }
                        MockBehavior::Hang => {
                            // 静默：不回包不关连接，客户端只能等总超时
                            tokio::time::sleep(Duration::from_secs(3600)).await;
                        }
                    }
                });
            }
        });
        CloudMock {
            base: format!("http://{addr}"),
            requests,
        }
    }

    /// 测试小值 policy：本地回环毫秒级响应，超时 / 退避注小值让重试全链
    /// 亚秒完成（生产默认走 constants，不因测试改动）
    fn test_policy() -> CloudHttpPolicy {
        CloudHttpPolicy {
            connect_timeout: Duration::from_secs(5),
            manifest_total_timeout: Duration::from_secs(2),
            download_read_timeout: Duration::from_millis(500),
            extra_attempts: 2,
            base_delay: Duration::from_millis(10),
        }
    }

    fn seq_response(status: u16, body: &[u8]) -> (u16, Vec<u8>) {
        (status, body.to_vec())
    }

    /// cloud 配置 JSON（新 kind 形态）
    fn cloud_config(base_url: &str, mirror_prefix: &str) -> serde_json::Value {
        serde_json::json!({"kind": "cloud", "baseUrl": base_url, "mirrorPrefix": mirror_prefix})
    }

    /// 构造 manifest.json 字节（size/sha256 按包内容真值；tag 可选注入两态；
    /// signature 可注入伪造形态）
    fn manifest_body(tag: Option<&str>, file: &str, content: &[u8], signature: &str) -> Vec<u8> {
        let mut m = serde_json::json!({
            "manifestVersion": 1, "version": "12.34.56", "notes": "n",
            "platforms": { "windows-x86_64": {
                "file": file, "size": content.len(),
                "sha256": format!("{:x}", sha2::Sha256::digest(content)),
                "signature": signature } }
        });
        if let Some(tag) = tag {
            m["tag"] = serde_json::json!(tag);
        }
        m.to_string().into_bytes()
    }

    /// 结构合法但密钥伪造的 minisign 签名（base64 一层包装前的原文形态）
    fn forged_signature() -> String {
        use base64::Engine as _;
        let mut bin = vec![0x45u8, 0x64];
        bin.extend_from_slice(&[0u8; 72]);
        format!(
            "untrusted comment: forged\n{}\ntrusted comment: forged\n{}\n",
            base64::engine::general_purpose::STANDARD.encode(&bin),
            base64::engine::general_purpose::STANDARD.encode([0u8; 64]),
        )
    }

    #[test]
    fn parse_update_source_variants() {
        // 未配置：缺失 / 空对象
        assert_eq!(parse_update_source(None), None);
        assert_eq!(parse_update_source(Some(&serde_json::json!({}))), None);

        // 旧数据（type 形态，kind 缺失按 folder）：path 裁剪空白
        assert_eq!(
            parse_update_source(Some(&serde_json::json!({"type": "local", "path": " D:/repo "}))),
            Some(UpdateSourceConfig::Folder {
                path: "D:/repo".to_owned()
            })
        );
        assert_eq!(
            parse_update_source(Some(
                &serde_json::json!({"type": "network", "path": "\\\\srv\\share"})
            )),
            Some(UpdateSourceConfig::Folder {
                path: "\\\\srv\\share".to_owned()
            })
        );
        // 旧 cloud 数据 path 必空：按 folder 解析自然落未配置（与旧行为一致）
        assert_eq!(
            parse_update_source(Some(&serde_json::json!({"type": "cloud", "path": null}))),
            None
        );

        // 新 kind 形态：folder 缺 path = 未配置
        assert_eq!(
            parse_update_source(Some(&serde_json::json!({"kind": "folder", "path": "D:/repo"}))),
            Some(UpdateSourceConfig::Folder {
                path: "D:/repo".to_owned()
            })
        );
        assert_eq!(
            parse_update_source(Some(&serde_json::json!({"kind": "folder"}))),
            None
        );

        // cloud 默认值：baseUrl 缺失回落契约默认地址，mirrorPrefix 缺失 = 直连；
        // 两端空白裁剪
        assert_eq!(
            parse_update_source(Some(&serde_json::json!({"kind": "cloud"}))),
            Some(UpdateSourceConfig::Cloud {
                base_url: DEFAULT_CLOUD_BASE_URL.to_owned(),
                mirror_prefix: String::new(),
            })
        );
        assert_eq!(
            parse_update_source(Some(&serde_json::json!({
                "kind": "cloud", "baseUrl": " https://example.com/repo/ ", "mirrorPrefix": " https://p/ "
            }))),
            Some(UpdateSourceConfig::Cloud {
                base_url: "https://example.com/repo/".to_owned(),
                mirror_prefix: "https://p/".to_owned(),
            })
        );

        // 未知 kind：按未配置引导（不猜）
        assert_eq!(
            parse_update_source(Some(&serde_json::json!({"kind": "smb", "path": "x"}))),
            None
        );
    }

    #[test]
    fn platform_key_maps_by_arch() {
        assert_eq!(platform_key_for("x86_64"), Some("windows-x86_64"));
        assert_eq!(platform_key_for("aarch64"), Some("windows-aarch64"));
        assert_eq!(platform_key_for("x86"), None);
        assert_eq!(platform_key_for("arm"), None);
        // 运行时包装 = 纯函数对运行架构的映射（自洽）
        assert_eq!(
            current_platform_key(),
            platform_key_for(std::env::consts::ARCH)
        );
    }

    #[test]
    fn cloud_urls_compose_mirror_and_tag() {
        // 清单 URL：baseUrl 去尾斜杠 + 固定路径段
        assert_eq!(
            cloud_manifest_url("https://github.com/amadeus19/apilot/", ""),
            "https://github.com/amadeus19/apilot/releases/latest/download/manifest.json"
        );
        // 镜像前缀非空 = 前缀原样前置到完整 URL 之前（ghproxy 形态）；空白 = 直连
        assert_eq!(
            apply_mirror_prefix("https://gh-proxy.com/", "https://github.com/a/b/x.json"),
            "https://gh-proxy.com/https://github.com/a/b/x.json"
        );
        assert_eq!(apply_mirror_prefix("  ", "https://a/b"), "https://a/b");
        // 资产 URL：新清单按 tag 不可变寻址
        assert_eq!(
            cloud_asset_url(
                "https://github.com/amadeus19/apilot",
                "",
                Some("v12.34.56"),
                "APilot_12.34.56_x64-setup.exe"
            ),
            "https://github.com/amadeus19/apilot/releases/download/v12.34.56/APilot_12.34.56_x64-setup.exe"
        );
        // 资产 URL：旧清单无 tag 走 latest 兼容直链，且镜像前缀同套
        assert_eq!(
            cloud_asset_url(
                "https://github.com/amadeus19/apilot",
                "https://p.io/",
                None,
                "pkg.exe"
            ),
            "https://p.io/https://github.com/amadeus19/apilot/releases/latest/download/pkg.exe"
        );
    }

    #[tokio::test]
    async fn check_kind_folder_behaves_like_legacy_local() {
        // kind:"folder" 与旧 type:"local" 同链路同结果（配置兼容回归）
        let dir = temp_source_dir("kindfolder");
        write_manifest(&dir, "999.0.0", "n");
        for cfg in [
            serde_json::json!({"kind": "folder", "path": dir.to_str()}),
            serde_json::json!({"type": "local", "path": dir.to_str()}),
        ] {
            let r = check_for_update(Some(&cfg)).await.unwrap();
            assert_eq!(r.status, "newer_available");
            assert_eq!(r.latest_version.as_deref(), Some("999.0.0"));
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn cloud_check_reports_newer_with_tag() {
        let manifest = manifest_body(
            Some("v12.34.56"),
            "APilot_12.34.56_x64-setup.exe",
            b"pkg",
            "sig",
        );
        let mock = spawn_cloud_mock(vec![(
            "/releases/latest/download/manifest.json",
            MockBehavior::Sequence(vec![seq_response(200, &manifest)]),
        )])
        .await;
        let r = check_for_update(Some(&cloud_config(&mock.base, "")))
            .await
            .unwrap();
        assert_eq!(r.status, "newer_available");
        assert_eq!(r.latest_version.as_deref(), Some("12.34.56"));
        assert_eq!(r.tag.as_deref(), Some("v12.34.56"), "检查结果带出清单 tag");
        assert_eq!(mock.request_count(), 1);
    }

    #[tokio::test]
    async fn cloud_check_old_manifest_has_no_tag() {
        // 旧清单无 tag 字段：解析兼容（serde default），检查结果如实反映 None
        let manifest = manifest_body(None, "f.exe", b"pkg", "sig");
        let mock = spawn_cloud_mock(vec![(
            "/releases/latest/download/manifest.json",
            MockBehavior::Sequence(vec![seq_response(200, &manifest)]),
        )])
        .await;
        let r = check_for_update(Some(&cloud_config(&mock.base, "")))
            .await
            .unwrap();
        assert_eq!(r.status, "newer_available");
        assert_eq!(r.tag, None, "旧清单无 tag，结果按 None 反映兼容形态");
    }

    #[tokio::test]
    async fn cloud_manifest_oversized_content_length_rejected() {
        // Content-Length 预检：声明超限的清单即拒（缓冲有界），不读满 body
        let body = vec![b'x'; 2 * 1024 * 1024];
        let mock = spawn_cloud_mock(vec![(
            "/releases/latest/download/manifest.json",
            MockBehavior::Sequence(vec![seq_response(200, &body)]),
        )])
        .await;
        let r = check_for_update(Some(&cloud_config(&mock.base, "")))
            .await
            .unwrap();
        assert_eq!(r.status, "invalid_manifest");
        assert!(
            r.notes.as_deref().unwrap_or_default().contains("too large"),
            "超限细节应携带：{:?}",
            r.notes
        );
    }

    #[tokio::test]
    async fn cloud_manifest_404_not_retried() {
        let mock = spawn_cloud_mock(vec![(
            "/releases/latest/download/manifest.json",
            MockBehavior::Sequence(vec![seq_response(404, b"nope")]),
        )])
        .await;
        let r = check_for_update(Some(&cloud_config(&mock.base, "")))
            .await
            .unwrap();
        assert_eq!(r.status, "unreachable");
        assert!(
            r.notes.as_deref().unwrap_or_default().contains("404"),
            "细节应携带 HTTP 语义：{:?}",
            r.notes
        );
        assert_eq!(mock.request_count(), 1, "404 是终态，不得重试");
    }

    #[tokio::test]
    async fn cloud_manifest_503_retries_then_succeeds() {
        let manifest = manifest_body(Some("v12.34.56"), "f.exe", b"pkg", "sig");
        let mock = spawn_cloud_mock(vec![(
            "/releases/latest/download/manifest.json",
            MockBehavior::Sequence(vec![
                seq_response(503, b"busy"),
                seq_response(200, &manifest),
            ]),
        )])
        .await;
        let policy = test_policy();
        let r = check_cloud_source(&mock.base, "", &policy).await.unwrap();
        assert_eq!(r.status, "newer_available");
        assert_eq!(mock.request_count(), 2, "503 后退避重试一次成功");
    }

    #[tokio::test]
    async fn cloud_manifest_retries_exhausted_maps_status_and_code() {
        let mock = spawn_cloud_mock(vec![(
            "/releases/latest/download/manifest.json",
            MockBehavior::Sequence(vec![seq_response(503, b"busy"); 3]),
        )])
        .await;
        let policy = test_policy();
        // 检查阶段：重试耗尽归 unreachable 状态（源问题，可重试 / 可配镜像）
        let r = check_cloud_source(&mock.base, "", &policy).await.unwrap();
        assert_eq!(r.status, "unreachable");
        assert_eq!(mock.request_count(), 3, "首次 + 2 次重试后耗尽");
        // 下载阶段：同一失败映射为重试耗尽错误码
        let err = download_cloud_update(&mock.base, "", &policy)
            .await
            .unwrap_err();
        assert_eq!(err.code, "UPDATE_SOURCE_RETRIES_EXHAUSTED");
        assert_eq!(mock.request_count(), 6, "下载阶段独立重试一轮");
    }

    #[tokio::test]
    async fn cloud_check_timeout_maps_unreachable() {
        // 对端静默（不回包不关连接）：清单总超时在请求层触发（外层不叠加
        // 固定超时——重试退避与总超时叠加会掐死合法慢网络请求）
        let mock = spawn_cloud_mock(vec![(
            "/releases/latest/download/manifest.json",
            MockBehavior::Hang,
        )])
        .await;
        let mut policy = test_policy();
        policy.manifest_total_timeout = Duration::from_millis(80);
        let started = std::time::Instant::now();
        let r = check_cloud_source(&mock.base, "", &policy).await.unwrap();
        assert_eq!(r.status, "unreachable");
        // 3 次尝试 × 80ms 超时 + 10ms/40ms 退避 ≈ 350ms；留宽限断言「不会
        // 挂到固定外层超时量级」
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "超时应由请求层承担，实际耗时 {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn mirror_prefix_wraps_full_github_url_and_sends_ua() {
        // 前缀 = mock 服务器 + 尾斜杠；baseUrl 保持真实 GitHub 地址——前缀套
        // 在完整 GitHub URL 之前，mock 收到的 path 应为完整原 URL
        let manifest = manifest_body(Some("v12.34.56"), "f.exe", b"pkg", "sig");
        let mock = spawn_cloud_mock(vec![(
            "/https://github.com/amadeus19/apilot/releases/latest/download/manifest.json",
            MockBehavior::Sequence(vec![seq_response(200, &manifest)]),
        )])
        .await;
        let mirror = format!("{}/", mock.base);
        let r = check_for_update(Some(&cloud_config(DEFAULT_CLOUD_BASE_URL, &mirror)))
            .await
            .unwrap();
        assert_eq!(r.status, "newer_available");
        assert_eq!(
            mock.request_paths()[0],
            "/https://github.com/amadeus19/apilot/releases/latest/download/manifest.json",
            "镜像前缀应套在完整 GitHub URL 之前"
        );
        assert_eq!(
            mock.last_user_agent().as_deref(),
            Some(cloud_user_agent().as_str()),
            "UA = Apilot/<版本> (+官方仓库地址)"
        );
    }

    #[tokio::test]
    async fn cloud_download_full_chain_reaches_signature_gate() {
        // 包内容真值（size/sha256 与清单一致）→ 流程应穿过 size / sha256 校验
        // 到达 minisign 验签、被伪造签名拦截（签名正路径由实机验证覆盖，
        // 单测负路径——与 folder 同一口径）。tag 寻址断言：资产请求落在
        // /releases/download/<tag>/ 下。
        let content = b"fake-installer-binary-content";
        let mock = spawn_cloud_mock(vec![
            (
                "/releases/latest/download/manifest.json",
                MockBehavior::Sequence(vec![seq_response(
                    200,
                    &manifest_body(
                        Some("v12.34.56"),
                        "APilot_12.34.56_x64-setup.exe",
                        content,
                        &forged_signature(),
                    ),
                )]),
            ),
            (
                "/releases/download/v12.34.56/APilot_12.34.56_x64-setup.exe",
                MockBehavior::Sequence(vec![seq_response(200, content)]),
            ),
        ])
        .await;
        let err = download_update(Some(&cloud_config(&mock.base, "")))
            .await
            .unwrap_err();
        assert_eq!(
            err.code, "UPDATE_SIGNATURE_INVALID",
            "sha256 一致时应走到验签门：{err:?}"
        );
        let paths = mock.request_paths();
        assert_eq!(paths.len(), 2, "清单 1 次 + 资产 1 次");
        assert_eq!(
            paths[1],
            "/releases/download/v12.34.56/APilot_12.34.56_x64-setup.exe",
            "资产按清单 tag 不可变寻址"
        );
        // 校验先于落盘：签名拒绝时暂存包与 .part 中态都不存在（不留垃圾）
        let staged = StagedUpdate::from_version("12.34.56").unwrap();
        assert!(!staged.path.exists(), "校验失败不得落盘");
        assert!(!std::env::temp_dir()
            .join(StagedUpdate::part_file_name("12.34.56"))
            .exists());
    }

    #[tokio::test]
    async fn cloud_download_old_manifest_falls_back_to_latest_asset() {
        // 旧清单无 tag：资产 URL 走 latest 兼容直链（兼容路径在下载侧生效）
        let content = b"old-manifest-pkg";
        let mock = spawn_cloud_mock(vec![
            (
                "/releases/latest/download/manifest.json",
                MockBehavior::Sequence(vec![seq_response(
                    200,
                    &manifest_body(None, "legacy.exe", content, &forged_signature()),
                )]),
            ),
            (
                "/releases/latest/download/legacy.exe",
                MockBehavior::Sequence(vec![seq_response(200, content)]),
            ),
        ])
        .await;
        let err = download_update(Some(&cloud_config(&mock.base, "")))
            .await
            .unwrap_err();
        assert_eq!(err.code, "UPDATE_SIGNATURE_INVALID", "兼容路径应走到验签门");
        assert_eq!(
            mock.request_paths()[1],
            "/releases/latest/download/legacy.exe",
            "无 tag 清单的资产按 latest 直链寻址"
        );
    }

    #[tokio::test]
    async fn cloud_download_asset_404_is_terminal() {
        let mock = spawn_cloud_mock(vec![
            (
                "/releases/latest/download/manifest.json",
                MockBehavior::Sequence(vec![seq_response(
                    200,
                    &manifest_body(Some("v12.34.56"), "missing.exe", b"x", "sig"),
                )]),
            ),
            (
                "/releases/download/v12.34.56/missing.exe",
                MockBehavior::Sequence(vec![seq_response(404, b"gone")]),
            ),
        ])
        .await;
        let err = download_update(Some(&cloud_config(&mock.base, "")))
            .await
            .unwrap_err();
        assert_eq!(err.code, "UPDATE_SOURCE_NOT_FOUND", "资产不存在 = 404 终态");
        assert_eq!(mock.request_count(), 2, "资产 404 不重试（清单 1 + 资产 1）");
    }

    #[tokio::test]
    async fn cloud_download_asset_retries_exhausted_code() {
        // 资产 503 × 3：重试耗尽错误码在资产阶段同样生效（503 egress 场景
        // 主要发生在资产下载——重试语义必须覆盖两个阶段）
        let mock = spawn_cloud_mock(vec![
            (
                "/releases/latest/download/manifest.json",
                MockBehavior::Sequence(vec![seq_response(
                    200,
                    &manifest_body(Some("v12.34.56"), "pkg.exe", b"x", "sig"),
                )]),
            ),
            (
                "/releases/download/v12.34.56/pkg.exe",
                MockBehavior::Sequence(vec![seq_response(503, b"busy"); 3]),
            ),
        ])
        .await;
        let policy = test_policy();
        let err = download_cloud_update(&mock.base, "", &policy)
            .await
            .unwrap_err();
        assert_eq!(err.code, "UPDATE_SOURCE_RETRIES_EXHAUSTED");
        let asset_hits = mock
            .request_paths()
            .into_iter()
            .filter(|p| p.ends_with("/pkg.exe"))
            .count();
        assert_eq!(asset_hits, 3, "资产请求独立重试一轮（1 + 2）");
    }

    #[tokio::test]
    async fn cloud_download_read_timeout_interrupts_stalled_asset() {
        // 响应头已发（Content-Length 大值）+ body 前缀后停滞：读超时断开 →
        // UPDATE_PACKAGE_UNREADABLE（下载中断不重试整体、不落盘）
        let content: &'static [u8] = b"real-installer-bytes";
        let mock = spawn_cloud_mock(vec![
            (
                "/releases/latest/download/manifest.json",
                MockBehavior::Sequence(vec![seq_response(
                    200,
                    &manifest_body(Some("v12.34.56"), "pkg.exe", content, "sig"),
                )]),
            ),
            (
                "/releases/download/v12.34.56/pkg.exe",
                MockBehavior::StallAfterHeaders {
                    status: 200,
                    content_length: 10_000_000,
                    prefix: content,
                },
            ),
        ])
        .await;
        let mut policy = test_policy();
        policy.download_read_timeout = Duration::from_millis(150);
        let err = download_cloud_update(&mock.base, "", &policy)
            .await
            .unwrap_err();
        assert_eq!(err.code, "UPDATE_PACKAGE_UNREADABLE", "body 中断归读失败：{err:?}");
        // 中断不落盘（校验未过）
        let staged = StagedUpdate::from_version("12.34.56").unwrap();
        assert!(!staged.path.exists());
    }

    #[tokio::test]
    async fn asset_collection_enforces_size_cap() {
        // Content-Length 预检：声明超上限即拒绝（不开始收数）
        let mock = spawn_cloud_mock(vec![(
            "/big.bin",
            MockBehavior::Sequence(vec![seq_response(200, &vec![0u8; 64])]),
        )])
        .await;
        let client = download_client(&test_policy()).unwrap();
        let resp = client
            .get(format!("{}/big.bin", mock.base))
            .send()
            .await
            .unwrap();
        let err = collect_asset_bytes(resp, 16).await.unwrap_err();
        assert_eq!(err.code, "UPDATE_CHECKSUM_MISMATCH");
    }
}
