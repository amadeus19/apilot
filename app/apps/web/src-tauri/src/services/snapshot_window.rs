//! 快照窗服务：响应定格快照的暂存与独立小窗的打开。
//!
//! 资源所有权（四问）：快照窗由 AppHandle 持有、窗口系统统一管理，
//! `open` 按需创建；用户点 X / Alt+F4 直接销毁窗口——CloseRequested
//! 放行系统默认销毁（分流决策见 [`should_intercept_close`]），不进主窗
//! closeBehavior 三分派与退出序列。暂存 payload 挂 AppState（进程
//! 内存态），随进程退出释放；窗口销毁不清除（单例替换语义，下次 open
//! 覆盖）。位置 / 尺寸 / 置顶记忆经 settings 键 `responseSnapshotWindow`
//! 持久化（写入由前端 onMoved / onResized / 置顶切换时经通用 set_setting
//! 落库），本模块只负责建窗时的宽容解析。

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::error::AppError;

/// 快照窗 label（窗口系统标识，与前端窗口路由约定一致）
pub const SNAPSHOT_WINDOW_LABEL: &str = "response-snapshot";
/// 主窗口 label（CloseRequested 分流的拦截侧；主窗配置见 tauri.conf.json）
pub const MAIN_WINDOW_LABEL: &str = "main";

/// 建窗默认尺寸：快照窗是小型定格视图
const DEFAULT_WIDTH: f64 = 480.0;
const DEFAULT_HEIGHT: f64 = 600.0;

// —— payload（接口契约：title＝窗口标题，content＝定格的 pretty 文本）——

/// 快照内容形态（快照窗前端按形态选择渲染策略）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SnapshotContentType {
    Json,
    Text,
}

/// 快照窗载荷：`open` 暂存 / `get` 读取的同一形态
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseSnapshotPayload {
    pub title: String,
    pub content: String,
    pub content_type: SnapshotContentType,
}

// —— settings 记忆解析 ——

/// 快照窗几何记忆（settings 键 `responseSnapshotWindow` 的强类型形态）。
/// Tauri 窗口坐标是逻辑像素 f64，与 WebView2 缩放无关，原样存取。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SnapshotWindowMemory {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub always_on_top: bool,
}

/// 记忆值宽容解析（纯函数，可测）：缺失 / null / 非对象 / 任一字段缺失或
/// 类型错 → None（＝从未记忆，建窗回退默认）。不部分采信：几何记忆是
/// 整体快照，半份记忆建出的位置 / 尺寸混搭无意义。
pub fn memory_from_value(value: Option<&Value>) -> Option<SnapshotWindowMemory> {
    let value = value?;
    Some(SnapshotWindowMemory {
        x: value.get("x")?.as_f64()?,
        y: value.get("y")?.as_f64()?,
        width: value.get("width")?.as_f64()?,
        height: value.get("height")?.as_f64()?,
        always_on_top: value.get("alwaysOnTop")?.as_bool()?,
    })
}

// —— 建窗决策 ——

/// 建窗参数（记忆或默认值的归档结果）
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct CreateParams {
    pub width: f64,
    pub height: f64,
    /// None＝从未记忆，不指定位置（交系统默认级联摆放）
    pub position: Option<(f64, f64)>,
    /// 无记忆时默认置顶：快照是对照主窗工作的辅助视图
    pub always_on_top: bool,
}

/// 建窗参数决策（纯函数，可测）：记忆完整时按记忆值；否则回退默认——
/// 480×600、系统默认位置、置顶。
fn create_params(memory: Option<&SnapshotWindowMemory>) -> CreateParams {
    let memory = memory.copied();
    CreateParams {
        width: memory.map_or(DEFAULT_WIDTH, |m| m.width),
        height: memory.map_or(DEFAULT_HEIGHT, |m| m.height),
        position: memory.map(|m| (m.x, m.y)),
        always_on_top: memory.map_or(true, |m| m.always_on_top),
    }
}

/// CloseRequested 分流决策（纯函数，可测）：仅主窗口拦截关闭并交
/// closeBehavior 三分派（ask 询问 / tray 隐藏到托盘 / exit 退出序列）；
/// 快照窗及其他辅助窗口放行系统默认销毁——关闭即销毁窗口本体，主窗与
/// 进程生命周期不受影响。
pub fn should_intercept_close(label: &str) -> bool {
    label == MAIN_WINDOW_LABEL
}

// —— 暂存（进程内存态单例）——

/// 暂存写入（单例替换语义：重复 open 覆盖前一份，不累积）。锁中毒按
/// 取回内部数据继续（与 AppState 其他 Mutex 同口径）。
pub fn store_payload(
    stash: &Mutex<Option<ResponseSnapshotPayload>>,
    payload: ResponseSnapshotPayload,
) {
    *stash
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(payload);
}

/// 暂存读取（`get_response_snapshot` 的返回面；未 open 过为 None → 前端
/// 拿到 null）
pub fn current_payload(
    stash: &Mutex<Option<ResponseSnapshotPayload>>,
) -> Option<ResponseSnapshotPayload> {
    stash
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

// —— 打开快照窗 ——

/// 打开快照窗（`open_response_snapshot` 的业务实现）：暂存替换 → 已有同
/// label 窗则同步标题并聚焦（不重建——用户拖出的几何态保留），否则按
/// 记忆 / 默认建窗。DB 不可用时无记忆可读，按默认建窗（快照内容已在
/// payload 里，不依赖 DB）。
pub fn open(app: &AppHandle, payload: ResponseSnapshotPayload) -> Result<(), AppError> {
    use tauri::Manager;

    let state = app.state::<crate::AppState>();
    store_payload(&state.response_snapshot, payload.clone());
    if let Some(window) = app.get_webview_window(SNAPSHOT_WINDOW_LABEL) {
        // 复用：标题同步为最新 payload（窗口内容与标题一致），再聚焦。
        // Windows 上对最小化窗口 set_focus 通常不还原前台——最小化态先
        // unminimize 再聚焦。各步失败只留痕——窗口仍在场，用户可手动
        // 点出，不因此判失败
        if let Err(err) = window.set_title(&payload.title) {
            tracing::warn!(error = %err, "snapshot window title sync failed");
        }
        match window.is_minimized() {
            Ok(true) => {
                if let Err(err) = window.unminimize() {
                    tracing::warn!(error = %err, "snapshot window unminimize failed");
                }
            }
            Ok(false) => {}
            Err(err) => tracing::warn!(error = %err, "snapshot window minimized probe failed"),
        }
        if let Err(err) = window.set_focus() {
            tracing::warn!(error = %err, "snapshot window focus failed");
        }
        return Ok(());
    }
    let memory = state.db.as_ref().ok().and_then(|db| {
        memory_from_value(
            db.cache
                .get(crate::services::settings::RESPONSE_SNAPSHOT_WINDOW_KEY)
                .as_ref(),
        )
    });
    let params = create_params(memory.as_ref());
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        SNAPSHOT_WINDOW_LABEL,
        // 应用默认入口：dev 解析到 devUrl、生产到前端 dist，快照页由前端
        // 按窗口路由分辨
        tauri::WebviewUrl::default(),
    )
    .title(&payload.title)
    .inner_size(params.width, params.height)
    .resizable(true)
    // 自绘标题栏（与主窗同款观感：系统原生标题栏是暗色系统底，与主题化
    // 界面割裂；标题 / 置顶开关 / 关闭钮由前端 data-tauri-drag-region 承载）
    .decorations(false)
    // 隐藏创建（防闪协议，与主窗同款）：建窗→WebView 加载→boot→内容
    // 就绪后才 show——否则 WebView2 白底→系统暗色→页面样式的闪烁链可见
    .visible(false)
    .always_on_top(params.always_on_top)
    // 与主窗同款链（保持一致）：devtools 初值同源门控；快照窗无输入
    // 场景，同样关闭 WebView2 通用自动填充
    .devtools(state.devtools_native)
    .general_autofill_enabled(false);
    if let Some((x, y)) = params.position {
        builder = builder.position(x, y);
    }
    builder
        .build()
        .map_err(|err| AppError::internal(format!("snapshot window creation failed: {err}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn memory_parses_well_formed_value() {
        let value = json!({
            "x": 100.5, "y": 200.25,
            "width": 480.0, "height": 600.0,
            "alwaysOnTop": false
        });
        assert_eq!(
            memory_from_value(Some(&value)),
            Some(SnapshotWindowMemory {
                x: 100.5,
                y: 200.25,
                width: 480.0,
                height: 600.0,
                always_on_top: false,
            })
        );
    }

    #[test]
    fn memory_rejects_missing_null_or_dirty_values() {
        // 缺失 / null（前端清除记忆即写 null）→ 从未记忆
        assert_eq!(memory_from_value(None), None);
        assert_eq!(memory_from_value(Some(&json!(null))), None);
        // 非对象
        assert_eq!(memory_from_value(Some(&json!("bogus"))), None);
        assert_eq!(memory_from_value(Some(&json!(42))), None);
        // 缺字段（含整份记忆缺 alwaysOnTop）
        assert_eq!(
            memory_from_value(Some(
                &json!({"x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0})
            )),
            None
        );
        assert_eq!(
            memory_from_value(Some(&json!({"x": 1.0, "y": 2.0, "width": 3.0}))),
            None
        );
        // 类型错：字符串数字不是 f64，布尔位不接受字符串
        assert_eq!(
            memory_from_value(Some(&json!({
                "x": "1", "y": 2.0, "width": 3.0, "height": 4.0, "alwaysOnTop": true
            }))),
            None
        );
        assert_eq!(
            memory_from_value(Some(&json!({
                "x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0, "alwaysOnTop": "yes"
            }))),
            None
        );
    }

    #[test]
    fn create_params_falls_back_to_defaults_without_memory() {
        let params = create_params(None);
        assert_eq!(params.width, 480.0);
        assert_eq!(params.height, 600.0);
        assert_eq!(params.position, None, "未记忆时不指定位置，交系统默认级联");
        assert!(params.always_on_top, "未记忆时默认置顶");
    }

    #[test]
    fn create_params_honors_memory_including_always_on_top() {
        let memory = SnapshotWindowMemory {
            x: 12.0,
            y: 34.0,
            width: 520.0,
            height: 700.0,
            always_on_top: false,
        };
        let params = create_params(Some(&memory));
        assert_eq!(params.width, 520.0);
        assert_eq!(params.height, 700.0);
        assert_eq!(params.position, Some((12.0, 34.0)));
        assert!(!params.always_on_top, "记忆的置顶关闭态建窗时生效");
    }

    #[test]
    fn only_main_window_close_is_intercepted() {
        assert!(should_intercept_close("main"));
        // 快照窗关闭放行：销毁窗口本体，不触发主窗三分派与退出序列
        assert!(!should_intercept_close(SNAPSHOT_WINDOW_LABEL));
        // 未来辅助窗口默认放行：退出序列只归主窗
        assert!(!should_intercept_close("some-future-window"));
    }

    #[test]
    fn stash_starts_empty_and_replaces_on_reopen() {
        // 未 open 过 → get 返回 None（前端拿到 null）
        let stash: Mutex<Option<ResponseSnapshotPayload>> = Mutex::new(None);
        assert_eq!(current_payload(&stash), None);
        // 两次 open 不同 payload：单例替换，读取到最新一份
        store_payload(&stash, sample_payload("first"));
        store_payload(&stash, sample_payload("second"));
        assert_eq!(
            current_payload(&stash).map(|p| p.title),
            Some("second".to_owned())
        );
    }

    #[test]
    fn payload_serde_follows_camel_case_contract() {
        // 反序列化：camelCase 字段名 + contentType 枚举两值
        let payload: ResponseSnapshotPayload = serde_json::from_value(
            json!({"title": "GET /users", "content": "{}", "contentType": "json"}),
        )
        .unwrap();
        assert_eq!(payload.content_type, SnapshotContentType::Json);
        let payload: ResponseSnapshotPayload = serde_json::from_value(
            json!({"title": "t", "content": "plain", "contentType": "text"}),
        )
        .unwrap();
        assert_eq!(payload.content_type, SnapshotContentType::Text);
        // 序列化回契约形态
        let out = serde_json::to_value(&payload).unwrap();
        assert_eq!(out["contentType"], json!("text"));
        assert_eq!(out["title"], json!("t"));
        // 非法 contentType 在参数反序列化层 fail-fast
        let err = serde_json::from_value::<ResponseSnapshotPayload>(json!({
            "title": "t", "content": "c", "contentType": "html"
        }));
        assert!(err.is_err());
        // 缺字段同样拒绝
        let err = serde_json::from_value::<ResponseSnapshotPayload>(json!({
            "title": "t", "contentType": "json"
        }));
        assert!(err.is_err());
    }

    fn sample_payload(title: &str) -> ResponseSnapshotPayload {
        ResponseSnapshotPayload {
            title: title.to_owned(),
            content: "{\"ok\":true}".to_owned(),
            content_type: SnapshotContentType::Json,
        }
    }
}
