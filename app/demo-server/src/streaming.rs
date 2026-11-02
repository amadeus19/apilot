//! SSE：N 条事件后服务端关闭；KeepAlive 保活；断开检测＝Drop guard＋事件间隔内短周期唤醒。

use std::convert::Infallible;
use std::time::Duration;

use async_stream::stream;
use axum::extract::{Query, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use crate::state::AppState;

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct SseQuery {
    /// 事件条数，发完即服务端关闭
    events: Option<u32>,
    /// 事件间隔毫秒
    interval_ms: Option<u64>,
}

/// 断开检测 guard：流被 drop（客户端断开或收尾）时递减活跃计数。
/// 集成测试经 `AppState::sse_active_connections` 观测断开是否被感知。
struct DisconnectGuard {
    state: AppState,
}

impl Drop for DisconnectGuard {
    fn drop(&mut self) {
        self.state.sse_disconnect();
    }
}

/// GET /api/sse：事件携带递增序号与时间戳；短周期 tick 让断开后 guard 能及时 drop。
/// 返回类型取具象 Response（Sse<impl Stream> 需引 futures-core trait 路径，从简不引）。
#[utoipa::path(
    get,
    path = "/api/sse",
    summary = "订阅 SSE 事件流",
    params(SseQuery),
    responses(
        (status = 200, description = "事件流：N 条 data 事件后服务端关闭", content_type = "text/event-stream"),
    )
)]
pub async fn sse_events(
    State(state): State<AppState>,
    Query(q): Query<SseQuery>,
) -> Response {
    let events = q.events.unwrap_or(5).clamp(1, 1000);
    let interval = Duration::from_millis(q.interval_ms.unwrap_or(500).clamp(1, 10_000));
    state.sse_connect();
    let guard = DisconnectGuard { state: state.clone() };
    // 短周期唤醒：最长 50ms 一拍，避免长间隔期间断开感知滞后
    let tick = Duration::from_millis(50);

    let stream = stream! {
        for seq in 1..=events {
            // 首条立即发出；其后间隔拆成短 tick 累计，等待期流仍周期性被驱动
            let mut waited = Duration::ZERO;
            while waited < interval && seq > 1 {
                tokio::time::sleep(tick.min(interval - waited)).await;
                waited += tick;
            }
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let payload = serde_json::json!({"seq": seq, "total": events, "ts": ts});
            yield Ok::<_, Infallible>(
                Event::default()
                    .event("message")
                    .json_data(payload)
                    .expect("JSON 序列化 Event 恒成功"),
            );
        }
        // 显式 drop：服务端正常收尾时立即递减（客户端断开则由流 drop 走同一 Drop）
        drop(guard);
    };

    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}
