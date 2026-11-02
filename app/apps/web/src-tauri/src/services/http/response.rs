//! 响应分级句柄：2MB / 50MB 双线内存分级与 Preview 契约。
//!
//! - ≤2MB（`HTTP_MEMORY_TIER_BYTES`）：全量入内存（`BodyHandle::Memory`）；
//! - >2MB 且 ≤50MB：边收边写临时文件（`BodyHandle::File`），内存只留 Preview；
//! - >50MB（含无 Content-Length 累计越线）：停止下载（UI 只读 Preview）——一切缓冲与落盘有界；临时文件不与 Run Record 关联（Tab 绑定生命周期）。
//!
//! Preview 契约（恒在）：≤64KB（`HTTP_PREVIEW_BYTES`）前缀 ＋ total_size ＋
//! truncated 标记。Content-Length 可预判体量（预判超上限时读满 Preview 即停，
//! 不空耗带宽）；chunked 边收边判、越线转文件（已缓冲部分随写）。临时文件名＝
//! 发起方任务键的净化形态（同 Tab 新发送覆盖同名即替换删旧；关 Tab 经
//! `http.tab_closed` 单键删除，启动 / 退出由扫场整删兜底）。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;

use crate::constants::{HTTP_MAX_RESPONSE_BYTES, HTTP_MEMORY_TIER_BYTES, HTTP_PREVIEW_BYTES};
use crate::error::AppError;
use crate::error::codes;

/// 响应体持有形态。
#[derive(Debug, Clone)]
pub enum BodyHandle {
    /// 全量内存（≤2MB）
    Memory { bytes: Vec<u8> },
    /// 临时文件（2MB–50MB）：路径＋体量；全量查看经 range-read（UI 不碰
    /// 文件系统）。path 由读侧按响应 id 重建（sanitize 同规则），此处留作
    /// Workflow 域与运维观测的模型面。
    #[allow(dead_code)]
    File { path: PathBuf, total_size: u64 },
    /// 不持有体数据（CLI 面或预判超上限）：仅 Preview 与总量
    #[allow(dead_code)]
    Discarded { total_size: u64 },
}

/// Preview 契约：前缀字节（≤64KB）＋总量＋截断标记。
#[derive(Debug, Clone)]
pub struct BodyPreview {
    pub bytes: Vec<u8>,
    pub total_size: u64,
    pub truncated: bool,
}

/// 引擎输出的响应句柄（快照与 UI 消费的统一面）。
#[derive(Debug, Clone)]
pub struct ResponseHandle {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub content_type: Option<String>,
    pub body: BodyHandle,
    pub preview: BodyPreview,
}

/// 响应体读取策略（谁落盘谁不落盘）。
pub enum BodySink<'a> {
    /// GUI：内存分级＋临时文件（root＝数据目录 `tmp/response/`；file_key＝
    /// 发起方任务键净化形态，同名覆盖＝同 Tab 新发送替换删旧）
    File { root: &'a Path, file_key: &'a str },
    /// CLI：不落盘不驻内存（只统计体量与 Preview；chunked 大响应计数以上限封顶）
    PreviewOnly,
}

/// 任务键 → 临时文件名（去除路径分隔符等不安全字符，保持可辨识）。
pub fn sanitize_file_key(key: &str) -> String {
    key.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 响应临时文件路径（数据目录 `tmp/response/<净化键>.body`）。响应 id 即
/// 任务键：落盘命名、range-read 凭据、关 Tab 删除与保存响应共用此拼装，
/// 文件名规则与落盘侧同构（sanitize_file_key 净化形态）。
pub fn response_tmp_path(data_dir: &Path, response_id: &str) -> PathBuf {
    data_dir
        .join("tmp")
        .join("response")
        .join(format!("{}.body", sanitize_file_key(response_id)))
}

// —— 响应体保存（Body 工具行「保存」的字节出口）：语义＝保存体原始字节，
//    不改 Run Record 留痕；目标路径来自用户对话框选择，不落库不留痕 ——

/// 保存响应体的字节源（按分级二选一）。
#[derive(Debug)]
pub enum SaveBodySource {
    /// 文件档：响应临时文件（凭据＝响应 id，路径按落盘同规则重建）
    TmpFile { path: PathBuf },
    /// 内存档：前端持有的 base64 编码原始字节（DTO rawBase64 原样透传）
    MemoryBase64 { encoded: String },
}

/// 保存响应体结果 DTO：写出字节数（成功反馈的展示口径）。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResponseDto {
    pub saved_bytes: u64,
}

/// 分段复制的段宽（与 range-read 同量级：一切缓冲有界）。
const SAVE_COPY_CHUNK_BYTES: usize = 1024 * 1024;

/// command 参数 → 保存源：responseId（文件档凭据）与 contentBase64（内存档
/// 字节）恰好其一，同传或全缺均为参数错误。data_dir＝应用数据目录（文件档
/// 凭 response_id 按落盘同规则重建临时文件路径）。
pub fn save_source(
    response_id: Option<String>,
    content_base64: Option<String>,
    data_dir: &Path,
) -> Result<SaveBodySource, AppError> {
    match (response_id, content_base64) {
        (Some(id), None) => Ok(SaveBodySource::TmpFile {
            path: response_tmp_path(data_dir, &id),
        }),
        (None, Some(encoded)) => Ok(SaveBodySource::MemoryBase64 { encoded }),
        (Some(_), Some(_)) | (None, None) => Err(AppError::new(
            codes::INVALID_ARGUMENT,
            "save response requires exactly one of responseId or contentBase64",
        )),
    }
}

/// 保存响应体原始字节到目标路径，返回写出字节数。写盘句柄即用即关
/// （读与写都收敛在本调用内，不新增生命周期）。
pub fn save_body_to(source: &SaveBodySource, target: &Path) -> Result<u64, AppError> {
    save_body_with(
        source,
        target,
        HTTP_MAX_RESPONSE_BYTES,
        SAVE_COPY_CHUNK_BYTES,
    )
}

/// 实现（护栏与段宽参数化，测试以小值验证行为；生产入口经 save_body_to
/// 固定为 50MB 上限护栏与 1MB 段宽）：
/// - 内存档：base64 解码后一次写入（内存档本体有界）；
/// - 文件档：临时文件分段流式复制（不整包驻内存），累计越过上限护栏即中止。
fn save_body_with(
    source: &SaveBodySource,
    target: &Path,
    max_bytes: u64,
    chunk_bytes: usize,
) -> Result<u64, AppError> {
    match source {
        SaveBodySource::MemoryBase64 { encoded } => {
            let bytes = BASE64_STANDARD.decode(encoded).map_err(|e| {
                AppError::new(
                    codes::INVALID_ARGUMENT,
                    format!("save response content is not valid base64: {e}"),
                )
            })?;
            if bytes.len() as u64 > max_bytes {
                return Err(AppError::new(
                    codes::INVALID_ARGUMENT,
                    format!("save response content exceeds the {max_bytes} bytes guardrail"),
                ));
            }
            std::fs::write(target, &bytes).map_err(save_io_error)?;
            Ok(bytes.len() as u64)
        }
        SaveBodySource::TmpFile { path } => {
            let mut src = std::fs::File::open(path).map_err(save_io_error)?;
            let mut dst = std::fs::File::create(target).map_err(save_io_error)?;
            let mut total: u64 = 0;
            let mut buf = vec![0u8; chunk_bytes];
            loop {
                let read = src.read(&mut buf).map_err(save_io_error)?;
                if read == 0 {
                    break;
                }
                total += read as u64;
                if total > max_bytes {
                    // 护栏中止：已写入的半成品一并清掉，不在目标路径留残迹
                    // （先关句柄，Windows 上持句柄删除会失败）
                    drop(dst);
                    let _ = std::fs::remove_file(target);
                    return Err(AppError::new(
                        codes::INVALID_ARGUMENT,
                        format!("response body exceeds the {max_bytes} bytes save guardrail"),
                    ));
                }
                dst.write_all(&buf[..read]).map_err(save_io_error)?;
            }
            Ok(total)
        }
    }
}

fn save_io_error(e: std::io::Error) -> AppError {
    AppError::new(
        codes::IO_OPEN_PATH_FAILED,
        format!("save response body failed: {e}"),
    )
}

/// 分级读取响应体。返回 (body, preview)；读取中传输错误上抛（引擎归传输失败）。
pub async fn read_body(
    response: reqwest::Response,
    sink: &BodySink<'_>,
) -> Result<(BodyHandle, BodyPreview), AppError> {
    use futures_util::StreamExt;

    let declared = response.content_length();
    // 预判超上限：只补满 Preview 即停（不空耗带宽到 50MB 线）
    let oversize_declared = declared
        .map(|len| len > HTTP_MAX_RESPONSE_BYTES)
        .unwrap_or(false);
    let memory_tier = matches!(sink, BodySink::File { .. }) && !oversize_declared;

    let mut preview: Vec<u8> = Vec::with_capacity(HTTP_PREVIEW_BYTES);
    let mut received: u64 = 0;
    let mut memory: Option<Vec<u8>> = memory_tier.then(Vec::new);
    let mut file: Option<(std::fs::File, PathBuf)> = None;
    let mut stopped = false;

    let mut stream = response.bytes_stream();
    loop {
        let chunk = match stream.next().await {
            Some(Ok(chunk)) => chunk,
            Some(Err(e)) => return Err(transport_error(&e)),
            None => break,
        };
        received += chunk.len() as u64;

        // Preview 恒捕获前 64KB（有界）
        if preview.len() < HTTP_PREVIEW_BYTES {
            let take = HTTP_PREVIEW_BYTES - preview.len();
            preview.extend_from_slice(&chunk[..take.min(chunk.len())]);
        }

        // 停读判定：预判超上限补满 Preview 即停；chunked 累计越线即停
        if (oversize_declared && preview.len() >= HTTP_PREVIEW_BYTES)
            || received > HTTP_MAX_RESPONSE_BYTES
        {
            stopped = true;
            break;
        }

        match (&mut memory, &mut file) {
            (Some(mem), _) => {
                mem.extend_from_slice(&chunk);
                if mem.len() > HTTP_MEMORY_TIER_BYTES {
                    // 越内存线：转文件（已缓冲部分随写）
                    let (mut f, path) = create_body_file(sink)?;
                    f.write_all(mem).map_err(io_error)?;
                    file = Some((f, path));
                    memory = None;
                }
            }
            (None, Some((f, _))) => {
                f.write_all(&chunk).map_err(io_error)?;
            }
            (None, None) => {
                // PreviewOnly / 预判超上限：丢弃（Preview 已捕获）
            }
        }
    }

    let total_size = match declared {
        // Content-Length 存在即权威总量（stopped 也准确）
        Some(len) => len,
        // chunked：实收值（stopped 时为截断下界）
        None => received,
    };
    let truncated = stopped || (preview.len() as u64) < total_size;

    let body = match (memory, file) {
        (Some(mem), _) => BodyHandle::Memory { bytes: mem },
        (None, Some((mut f, path))) => {
            f.flush().map_err(io_error)?;
            BodyHandle::File { path, total_size }
        }
        (None, None) => BodyHandle::Discarded { total_size },
    };

    Ok((
        body,
        BodyPreview {
            bytes: preview,
            total_size,
            truncated,
        },
    ))
}

fn create_body_file(sink: &BodySink<'_>) -> Result<(std::fs::File, PathBuf), AppError> {
    let BodySink::File { root, file_key } = sink else {
        return Err(AppError::new(
            codes::INTERNAL,
            "file tier requires a file sink",
        ));
    };
    std::fs::create_dir_all(root).map_err(|e| {
        AppError::new(
            codes::IO_CREATE_DIR_FAILED,
            format!("create response tmp dir failed: {e}"),
        )
    })?;
    let path = root.join(format!("{}.body", sanitize_file_key(file_key)));
    let file = std::fs::File::create(&path).map_err(|e| {
        AppError::new(
            codes::IO_OPEN_PATH_FAILED,
            format!("create response tmp file failed: {e}"),
        )
    })?;
    Ok((file, path))
}

fn transport_error(e: &reqwest::Error) -> AppError {
    AppError::new(
        codes::HTTP_REQUEST_FAILED,
        format!("response body read failed: {e}"),
    )
}

fn io_error(e: std::io::Error) -> AppError {
    AppError::new(
        codes::IO_OPEN_PATH_FAILED,
        format!("response tmp file io failed: {e}"),
    )
}

/// Preview 文本形态（utf8 lossy）＋截断标记——快照 excerpt 的统一口径。
pub fn preview_excerpt(preview: &BodyPreview) -> ExcerptText {
    ExcerptText {
        text: String::from_utf8_lossy(&preview.bytes).into_owned(),
        truncated: preview.truncated,
        total_size: preview.total_size,
    }
}

/// 文本 excerpt（request_json / response_json 的 body 口径：≤64KB＋truncated＋总量）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ExcerptText {
    pub text: String,
    pub truncated: bool,
    pub total_size: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_replaces_unsafe_chars() {
        assert_eq!(sanitize_file_key("http:tab:abc-1"), "http_tab_abc-1");
        assert_eq!(sanitize_file_key("http:run:run_x"), "http_run_run_x");
    }

    // —— 保存响应体（save_source 分级二选一 + save_body_with 写盘内核） ——

    /// save_source：文件档凭 response_id 按落盘同规则重建临时文件路径。
    #[test]
    fn save_source_builds_tmp_file_path_from_response_id() {
        let dir = std::env::temp_dir().join(format!("apilot-save-{}", uuid::Uuid::new_v4()));
        let source = save_source(Some("http:tab:abc-1".into()), None, &dir).unwrap();
        match source {
            SaveBodySource::TmpFile { path } => {
                assert_eq!(
                    path,
                    dir.join("tmp").join("response").join("http_tab_abc-1.body")
                );
            }
            other => panic!("应重建临时文件路径，实际: {other:?}"),
        }
    }

    /// save_source：responseId 与 contentBase64 恰好其一，同传或全缺拒绝。
    #[test]
    fn save_source_requires_exactly_one_credential() {
        let dir = std::env::temp_dir();
        assert!(save_source(None, None, &dir).is_err(), "全缺应拒绝");
        assert!(
            save_source(Some("id".into()), Some("aGk=".into()), &dir).is_err(),
            "同传应拒绝"
        );
    }

    /// 内存档保存：base64 解码后写盘字节一致，返回字节数。
    #[test]
    fn save_memory_body_writes_decoded_bytes() {
        let dir = std::env::temp_dir().join(format!("apilot-save-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("out.bin");
        let source = SaveBodySource::MemoryBase64 {
            encoded: BASE64_STANDARD.encode(b"hello"),
        };
        let saved = save_body_with(&source, &target, 1024, 16).unwrap();
        assert_eq!(saved, 5);
        assert_eq!(std::fs::read(&target).unwrap(), b"hello");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 内存档保存：非法 base64 拒绝（INVALID_ARGUMENT），不落盘。
    #[test]
    fn save_memory_body_rejects_invalid_base64() {
        let dir = std::env::temp_dir().join(format!("apilot-save-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("out.bin");
        let source = SaveBodySource::MemoryBase64 {
            encoded: "not-base64!!".into(),
        };
        let err = save_body_with(&source, &target, 1024, 16).unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);
        assert!(!target.exists(), "解码失败不落盘");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 上限护栏：字节源越过护栏即拒绝（生产入口护栏＝HTTP_MAX_RESPONSE_BYTES）。
    #[test]
    fn save_body_enforces_size_guardrail() {
        let dir = std::env::temp_dir().join(format!("apilot-save-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("out.bin");
        let payload = vec![0u8; 64];
        let source = SaveBodySource::MemoryBase64 {
            encoded: BASE64_STANDARD.encode(&payload),
        };
        let err = save_body_with(&source, &target, 32, 16).unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);
        assert!(!target.exists(), "越线不落盘");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 文件档保存：分段流式复制完整还原（源大于段宽验证跨段循环）。
    #[test]
    fn save_file_body_copies_across_chunks() {
        let dir = std::env::temp_dir().join(format!("apilot-save-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let tmp = dir.join("tmp.bin");
        let payload: Vec<u8> = (0..100u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&tmp, &payload).unwrap();
        let target = dir.join("out.bin");
        let source = SaveBodySource::TmpFile { path: tmp };
        let saved = save_body_with(&source, &target, 1024, 16).unwrap();
        assert_eq!(saved as usize, payload.len());
        assert_eq!(std::fs::read(&target).unwrap(), payload, "跨段复制完整还原");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 文件档保存：临时文件缺失报 IO 错误（已被新发送替换删除的竞态兜底）。
    #[test]
    fn save_file_body_reports_missing_tmp_file() {
        let dir = std::env::temp_dir().join(format!("apilot-save-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = SaveBodySource::TmpFile {
            path: dir.join("missing.body"),
        };
        let err = save_body_with(&source, &dir.join("out.bin"), 1024, 16).unwrap_err();
        assert_eq!(err.code, codes::IO_OPEN_PATH_FAILED);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 文件档保存：累计越过上限护栏即中止（不无限写盘），半成品目标文件清掉。
    #[test]
    fn save_file_body_enforces_size_guardrail() {
        let dir = std::env::temp_dir().join(format!("apilot-save-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let tmp = dir.join("tmp.bin");
        std::fs::write(&tmp, vec![0u8; 64]).unwrap();
        let source = SaveBodySource::TmpFile { path: tmp };
        let target = dir.join("out.bin");
        let err = save_body_with(&source, &target, 32, 16).unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);
        assert!(!target.exists(), "护栏中止不留半成品文件");
        std::fs::remove_dir_all(&dir).ok();
    }
}
