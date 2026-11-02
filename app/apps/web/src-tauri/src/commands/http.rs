//! HTTP 执行域 IPC 命令（http.* / sse.*）：发送（先落草稿再编排）、取消、
//! 关 Tab 清理、大响应 range-read、SSE 流启动。Command 只做参数反序列化、
//! SendCtx 装配投影、转发编排层（GUI 与 CLI 双入口同源）。

use std::path::Path;

use tauri::State;
use tauri::ipc::Response as IpcResponse;

use crate::AppState;
use crate::error::AppError;
use crate::error::codes;
use crate::services::http::response::{self, response_tmp_path};
use crate::services::send::{self, SendCtx, SendEntry, SendRequest};
use crate::services::user_data;
use crate::tasks::TaskRegistry;

/// 单次 range-read 分段上限（一切读取有界；UI 分页懒加载按需多次请求）
const RANGE_READ_MAX_BYTES: usize = 1024 * 1024;

/// 组装编排层上下文（AppState → SendCtx 投影＝GUI 入口装配点）。
fn send_ctx<'a>(state: &'a AppState) -> Result<SendCtx<'a>, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    Ok(SendCtx {
        pool: &db.pool,
        cache: &db.cache,
        http: &state.http,
        registry: &state.tasks,
        data_dir: &state.data_dir,
    })
}

/// http.send：发送当前草稿——先整包落草稿（「发送只消费当前草稿」的落点：
/// 编辑器防抖写与发送竞速时以此整包为准），再走编排层（Tab 键登记、
/// 连续发送取消前笔、Run Record 落库）。AppHandle 供事件流响应的 SSE
/// 升级链路实时推送事件。`base_url_override`＝接口级 BaseUrl 覆写（GUI
/// Tab 会话态随 invoke 携带、不落库；None＝跟随工作空间生效值）。
#[allow(clippy::too_many_arguments)] // 扁平参数＝前端 invoke 载荷契约（收拢结构体会改 IPC 面）
#[tauri::command(rename = "http.send")]
pub async fn http_send(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    service_id: String,
    key: String,
    tab_id: String,
    body: Option<String>,
    params: String,
    headers: String,
    timeout_seconds: Option<i64>,
    auth: Option<String>,
    path_override: Option<String>,
    method_override: Option<String>,
    base_url_override: Option<String>,
) -> Result<send::RunResult, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    user_data::upsert(
        &db.pool,
        &service_id,
        &key,
        body,
        params,
        headers,
        timeout_seconds,
        auth,
        path_override,
        method_override,
    )
    .await?;
    let ctx = send_ctx(&state)?;
    // GUI 入口变体携带 AppHandle：事件流响应经 SSE 升级链路实时推送
    // （sse-upgrade://<tabId> 告知＋sse://<id> 增量），响应面板发送中即得流式视图
    send::execute_endpoint_gui(
        &ctx,
        SendRequest {
            service_id,
            endpoint_key: key,
            entry: SendEntry::Gui { tab_id },
            overrides: Default::default(),
            base_url_override,
        },
        app,
    )
    .await
}

/// http.cancel：取消 Tab 作用域的在途请求（普通发送与 SSE 同键；幂等）。
#[tauri::command(rename = "http.cancel")]
pub async fn http_cancel(state: State<'_, AppState>, tab_id: String) -> Result<bool, AppError> {
    Ok(state.tasks.cancel(&send::tab_task_key(&tab_id)))
}

/// http.tab_closed：关 Tab 清理——取消该 Tab 在途请求（普通发送与 SSE 同键、
/// 幂等）＋单键删除其响应临时文件。切工作空间由前端对每个关闭的 Tab 复用
/// 同一命令（逐 Tab 同语义）。取消后的 cancelled 终态行经发送链路自身的
/// 取消分野落库，此处不另起写库。
#[tauri::command(rename = "http.tab_closed")]
pub async fn http_tab_closed(state: State<'_, AppState>, tab_id: String) -> Result<bool, AppError> {
    Ok(close_tab_cleanup(&state.tasks, &state.data_dir, &tab_id))
}

/// 关 Tab 清理内核（http.tab_closed 的可测面）：取消 Tab 任务键＋单键删除
/// 响应临时文件。编排取舍：业务＝键拼装＋cancel＋删文件两句（无库事务、无
/// 锁等待），下沉 service 无复用面，按「薄内联」落在 Command 层；抽独立
/// 函数仅为绕开 State 装配直测行为。
///
/// 取消与删除各自独立错误域：文件删除失败仅留痕不外抛（不影响取消语义，
/// 残留由启动 / 退出扫场兜底）；文件名规则与落盘侧同构（任务键净化形态）。
pub fn close_tab_cleanup(registry: &TaskRegistry, data_dir: &Path, tab_id: &str) -> bool {
    let key = send::tab_task_key(tab_id);
    // 先停笔再删文件：取消信号先行，任务侧读取随即终止；与残余写入的竞速
    // 收敛于「文件名消失」（Windows 上句柄带共享删除位，删除打开中的文件
    // 是 POSIX 式标记删除）
    let cancelled = registry.cancel(&key);
    let path = response_tmp_path(data_dir, &key);
    // 文件不存在＝常态（内存档 / 未发送过 / 已删）：静默
    if let Err(err) = std::fs::remove_file(&path)
        && err.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(error = %err, "remove response tmp file on tab close failed");
    }
    cancelled
}

/// http.read_range：大响应全量查看的分段读取（响应 id＋offset/len；UI 不碰
/// 文件系统铁律经 IPC 满足）。响应 id 即任务键（临时文件名＝其净化形态）；
/// 文件缺失（内存档请求 / 已被新发送替换删除）按空段返回（UI 回落 Preview）。
#[tauri::command(rename = "http.read_range")]
pub async fn http_read_range(
    state: State<'_, AppState>,
    response_id: String,
    offset: u64,
    len: usize,
) -> Result<IpcResponse, AppError> {
    if len == 0 || len > RANGE_READ_MAX_BYTES {
        return Err(AppError::new(
            codes::INVALID_ARGUMENT,
            format!("read range length must be 1..={RANGE_READ_MAX_BYTES}"),
        ));
    }
    let path = response_tmp_path(&state.data_dir, &response_id);
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(_) => return Ok(IpcResponse::new(Vec::new())),
    };
    use std::io::{Read, Seek, SeekFrom};
    let mut file = file;
    let size = file.metadata().map_err(io_err)?.len();
    if offset >= size {
        return Ok(IpcResponse::new(Vec::new()));
    }
    let readable = ((size - offset) as usize).min(len);
    file.seek(SeekFrom::Start(offset)).map_err(io_err)?;
    let mut buf = vec![0u8; readable];
    file.read_exact(&mut buf).map_err(io_err)?;
    Ok(IpcResponse::new(buf))
}

/// http.save_response：保存响应体原始字节到用户选定路径（GUI Body 工具行
/// 「保存」的落点；写盘语义＝保存体原始字节，不改 Run Record 留痕）。字节
/// 按分级取：文件档凭 responseId 重建临时文件路径分段拼装（复用 50MB 上限
/// 护栏）；内存档由前端回传其持有的 rawBase64 解码写盘。目标路径来自对话框
/// 选择，不落库不留痕；写盘句柄即用即关，无新生命周期。
#[tauri::command(rename = "http.save_response")]
pub async fn http_save_response(
    state: State<'_, AppState>,
    response_id: Option<String>,
    content_base64: Option<String>,
    target_path: String,
) -> Result<response::SaveResponseDto, AppError> {
    let source = response::save_source(response_id, content_base64, &state.data_dir)?;
    let saved_bytes = response::save_body_to(&source, Path::new(&target_path))?;
    Ok(response::SaveResponseDto { saved_bytes })
}

/// sse.start：启动事件流（立即返回流 id；事件经 `sse://<streamId>` 推送，
/// 停止＝http.cancel 同 Tab 键；SSE 请求同样先落草稿——与 http.send 同链）。
/// `base_url_override` / `path_override` 与 http.send 同口径。
#[allow(clippy::too_many_arguments)] // 扁平参数＝前端 invoke 载荷契约（收拢结构体会改 IPC 面）
#[tauri::command(rename = "sse.start")]
pub async fn sse_start(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    service_id: String,
    key: String,
    tab_id: String,
    body: Option<String>,
    params: String,
    headers: String,
    timeout_seconds: Option<i64>,
    auth: Option<String>,
    path_override: Option<String>,
    method_override: Option<String>,
    base_url_override: Option<String>,
) -> Result<send::SseStartDto, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    user_data::upsert(
        &db.pool,
        &service_id,
        &key,
        body,
        params,
        headers,
        timeout_seconds,
        auth,
        path_override,
        method_override,
    )
    .await?;
    let ctx = send_ctx(&state)?;
    send::start_sse(app, &ctx, &tab_id, &service_id, &key, base_url_override).await
}

/// 响应临时目录扫场（启动清空＝崩溃残留清扫；退出清空同入口）。
/// 临时文件不与 Run Record 关联，可无条件整体清除。
pub fn sweep_response_tmp(app_data_dir: &std::path::Path) {
    let tmp = app_data_dir.join("tmp").join("response");
    if tmp.exists()
        && let Err(err) = std::fs::remove_dir_all(&tmp)
    {
        tracing::warn!(error = %err, "sweep response tmp dir failed");
    }
}

fn io_err(e: std::io::Error) -> AppError {
    AppError::new(
        codes::IO_OPEN_PATH_FAILED,
        format!("read response range: {e}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 启动/退出扫场：残留临时文件整体清除；目录缺失时幂等。
    #[test]
    fn sweep_response_tmp_clears_leftovers_idempotently() {
        let dir = std::env::temp_dir().join(format!("apilot-sweep-{}", uuid::Uuid::new_v4()));
        let tmp = dir.join("tmp").join("response");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("http_tab_x.body"), b"stale").unwrap();

        sweep_response_tmp(&dir);
        assert!(!tmp.exists(), "扫场后临时目录整体清除");
        sweep_response_tmp(&dir); // 目录已缺失：不得报错
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 关 Tab 清理：在途任务取消＋本键临时文件单键删除（他键不受影响），
    /// 文件名与落盘规则同构（任务键净化形态）。
    #[tokio::test]
    async fn close_tab_cleanup_cancels_task_and_removes_single_file() {
        let registry = TaskRegistry::new();
        registry
            .spawn("http:tab:t1", |token| async move {
                token.cancelled().await;
            })
            .unwrap();
        let dir = std::env::temp_dir().join(format!("apilot-tabclosed-{}", uuid::Uuid::new_v4()));
        let tmp = dir.join("tmp").join("response");
        std::fs::create_dir_all(&tmp).unwrap();
        let mine = response_tmp_path(&dir, "http:tab:t1");
        let other = response_tmp_path(&dir, "http:tab:t2");
        std::fs::write(&mine, b"x").unwrap();
        std::fs::write(&other, b"y").unwrap();

        assert!(
            close_tab_cleanup(&registry, &dir, "t1"),
            "有在途任务应返回 true"
        );
        assert!(!mine.exists(), "关 Tab 即删：本键临时文件删除");
        assert!(other.exists(), "单键删除：他键文件不受影响");
        // 任务感知取消退出后不在运行（取消链路生效）
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!registry.is_running("http:tab:t1"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 幂等：对无在途任务 / 无文件（甚至无 tmp/response 子目录）的 Tab
    /// 调用无错误（返回 false＝无任务可取消）。
    #[test]
    fn close_tab_cleanup_idempotent_on_idle_tab() {
        let registry = TaskRegistry::new();
        let dir = std::env::temp_dir().join(format!("apilot-tabclosed-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!close_tab_cleanup(&registry, &dir, "idle-tab"));
        assert!(
            !close_tab_cleanup(&registry, &dir, "idle-tab"),
            "二次调用同样收敛"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
