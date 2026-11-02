//! demo-server：APilot 演示靶机（ADR-0008）。带 Swagger UI 的本地回环演示服务，
//! 兼作 src-tauri 集成测试靶机（同进程内嵌自旋，端口 0 免就绪探测）。
//! 定位＝测试夹具：仅经 `[dev-dependencies]` path 依赖进产品 crate，不进安装包。

pub mod auth;
pub mod fixture;
pub mod files;
pub mod misc;
pub mod state;
pub mod streaming;
pub mod users;

use std::net::SocketAddr;

use axum::Router;
use tokio::net::TcpListener;
use utoipa::openapi::OpenApiVersion;
use utoipa_axum::{routes, router::OpenApiRouter};
use utoipa_swagger_ui::SwaggerUi;

use state::AppState;

/// 默认监听地址：仅回环绑定，避免 Windows 防火墙弹窗
pub const DEFAULT_HOST: &str = "127.0.0.1";
/// 默认端口（`--port` 覆写）
pub const DEFAULT_PORT: u16 = 18080;

/// 组装完整路由（18 条）＋ Swagger UI ＋ OpenAPI 3.2 文档。
/// 上传路由的 DefaultBodyLimit(32MB) 以 route_layer 限定在已注册路由（仅 upload）。
pub fn build_router(state: AppState) -> Router {
    let (router, mut api) = OpenApiRouter::new()
        .routes(routes!(misc::healthz))
        .routes(routes!(auth::login))
        .routes(routes!(auth::me))
        .routes(routes!(users::list_users))
        .routes(routes!(users::create_user))
        .routes(routes!(users::get_user))
        .routes(routes!(users::update_user))
        .routes(routes!(users::delete_user))
        .routes(routes!(streaming::sse_events))
        // upload 先注册，再 route_layer 32MB——之后的路由不受影响
        .routes(routes!(files::upload))
        .route_layer(axum::extract::DefaultBodyLimit::max(files::MAX_UPLOAD_BYTES))
        .routes(routes!(files::download_binary))
        .routes(routes!(files::download_text))
        .routes(routes!(files::download_pdf))
        .routes(routes!(files::download_image))
        .routes(routes!(files::download_html))
        .routes(routes!(misc::error_status))
        .routes(routes!(misc::slow))
        .routes(routes!(misc::flaky))
        // fixture 文档端点经 axum 原生 route 透传挂载（不进注解生成的 OpenAPI
        // 文档——保持固化产物的操作数口径，文档端点亦无自指意义）
        .route(fixture::FIXTURE_DOC_PATH, axum::routing::get(fixture::serve_fixture))
        // 路由注册完毕再注入状态（链中注册要求 MethodRouter 与状态参数同型）
        .with_state(state)
        .split_for_parts();
    // OpenAPI 3.2：SSE / 流式负载的媒体类型在 3.2 语义下建模（utoipa 6 默认 3.1，opt-in 3.2）
    api.openapi = OpenApiVersion::Version32;
    api.info = {
        let mut info = utoipa::openapi::Info::new("APilot demo-server", env!("CARGO_PKG_VERSION"));
        info.description = Some("APilot 演示靶机：认证（JWT 双形态）/ CRUD 四形态 / SSE / multipart 上传 / 流式下载（二进制 / 文本）与媒体样本下载（PDF / 图片 / HTML）/ 错误样本 / 慢响应。内存态存储，重启即重置。".to_string());
        info
    };

    let swagger = SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", api);
    router.merge(swagger)
}

/// 同进程内嵌自旋（测试夹具）：绑定 127.0.0.1:0（bind 完成即端口已定，免就绪探测），
/// `tokio::spawn` 起服务，返回服务句柄。测试收尾调 `shutdown()`，或不调（测试 runtime
/// drop 时任务随之回收）。
pub async fn spawn_ephemeral() -> std::io::Result<DemoServer> {
    let listener = TcpListener::bind((DEFAULT_HOST, 0)).await?;
    let addr = listener.local_addr()?;
    let state = AppState::new();
    let router = build_router(state.clone());
    let handle = tokio::spawn(async move {
        // serve 仅在 listener 故障时返回 Err；测试夹具语境下记录后结束即可
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("demo-server stopped: {e}");
        }
    });
    Ok(DemoServer { addr, state, handle })
}

/// 靶机句柄：地址、观测面（SSE 活跃计数）、服务任务
pub struct DemoServer {
    addr: SocketAddr,
    state: AppState,
    handle: tokio::task::JoinHandle<()>,
}

impl DemoServer {
    /// 基地址（`http://127.0.0.1:<port>`，无尾斜杠）
    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// 当前活跃 SSE 连接数（断开检测观测面）
    pub fn sse_active_connections(&self) -> usize {
        self.state.sse_active_connections()
    }

    /// 注入 /api/flaky 的剩余故障次数（重试链路集成测试的布点）
    pub fn set_flaky_failures(&self, count: usize) {
        self.state.set_flaky_failures(count)
    }

    /// 测试收尾：终止服务任务（夹具无持久状态，直接 abort 即净）；
    /// 可重复调用（abort 幂等），Drop 兜底亦走此路径
    pub fn shutdown(&self) {
        self.handle.abort();
    }
}

impl Drop for DemoServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}
