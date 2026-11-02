//! 基础与素材路由：就绪探测、任意状态码错误样本、慢响应（Cancellation 素材）、
//! 可注入故障端点（重试链路素材）。

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;

use crate::auth::{bad_request, ErrorBody};
use crate::state::AppState;

#[derive(Debug, serde::Serialize, utoipa::ToSchema)]
pub struct Healthz {
    pub status: String,
}

/// GET /healthz：就绪探测。
#[utoipa::path(
    get,
    path = "/healthz",
    summary = "就绪探测",
    responses((status = 200, description = "服务就绪", body = Healthz))
)]
pub async fn healthz() -> Json<Healthz> {
    Json(Healthz { status: "ok".into() })
}

#[derive(Debug, serde::Serialize, utoipa::ToSchema)]
pub struct ErrorSample {
    pub error: bool,
    pub status: u16,
    pub message: String,
}

/// GET /api/error/{status}：返回指定状态码＋JSON 错误体（任意 100–599）。
#[utoipa::path(
    get,
    path = "/api/error/{status}",
    summary = "返回指定状态码错误样本",
    params(("status" = u16, Path, description = "目标状态码（100–599）")),
    responses(
        (status = 200, description = "按路径参数原样返回该状态码", body = ErrorSample),
        (status = 400, description = "状态码非法", body = ErrorBody),
    )
)]
pub async fn error_status(
    Path(status): Path<u16>,
) -> Result<(StatusCode, Json<ErrorSample>), (StatusCode, Json<ErrorBody>)> {
    // StatusCode::from_u16 本身接受 100–999，靶机口径收紧到合法注册段 100–599
    if !(100..=599).contains(&status) {
        return Err(bad_request("状态码须在 100–599"));
    }
    let code = StatusCode::from_u16(status).map_err(|_| bad_request("状态码须在 100–599"))?;
    Ok((
        code,
        Json(ErrorSample {
            error: code.as_u16() >= 400,
            status: code.as_u16(),
            message: format!("演示错误样本：{}", code.canonical_reason().unwrap_or("自定义状态码")),
        }),
    ))
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct SlowQuery {
    /// 延迟毫秒（默认 5000，上限 60000）
    ms: Option<u64>,
}

/// GET /api/slow：延迟后返回——Cancellation 集成测试素材。
#[utoipa::path(
    get,
    path = "/api/slow",
    summary = "延迟慢响应",
    params(SlowQuery),
    responses(
        (status = 200, description = "延迟后正常返回", body = serde_json::Value),
        (status = 400, description = "ms 超出上限", body = ErrorBody),
    )
)]
pub async fn slow(
    Query(q): Query<SlowQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorBody>)> {
    let ms = q.ms.unwrap_or(5000);
    if ms > 60_000 {
        return Err(bad_request("ms 上限 60000"));
    }
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    Ok(Json(serde_json::json!({"ok": true, "delayedMs": ms})))
}

/// GET /api/flaky：剩余故障次数内挂起到客户端超时（传输失败），之后立即
/// 200——工作流重试链路「失败 → 重试 → 成功 / 耗尽」的靶面。
#[utoipa::path(
    get,
    path = "/api/flaky",
    summary = "可注入故障端点",
    responses(
        (status = 200, description = "故障耗尽后正常返回", body = serde_json::Value),
    )
)]
pub async fn flaky(State(state): State<AppState>) -> Json<serde_json::Value> {
    let failed = state.take_flaky_failure();
    // 故障段挂起远超常规客户端超时：请求侧以超时失败收场（靶机不被等待阻塞）
    if failed {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    }
    Json(serde_json::json!({ "ok": true, "degraded": failed }))
}
