//! 可控 swagger fixture 端点：内容可变的文档端点（读 fixture 文件对外服务）。
//! 支撑「改 fixture → 重新拉取 → 二次 diff」的测试场景——外部替换 fixture
//! 文件后无需重启服务，下次请求即读到新内容。

use axum::body::Body;
use axum::extract::State;
use axum::http::header;
use axum::response::Response;

use crate::state::AppState;

/// 编译期内嵌的靶机真文档：与 src-tauri 侧固化的 fixture 同一份文件（单一事实源，
/// include_str! 使文件更新后自动触发重编）。未指定 `--fixture` 或文件不可读时的
/// 回落内容。
const EMBEDDED_FIXTURE_DOC: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../apps/web/src-tauri/tests/fixtures/sync/utoipa-openapi32.json"
));

/// GET /api-docs/fixture.json：每请求读盘、不缓存（本地回环 KB 级文件读取开销
/// 微小，同步 std::fs 即可，不为夹具引 tokio fs feature）。配置了路径但文件不
/// 存在或不可读时回落内嵌真文档（eprintln! 留痕）；文件内容原样透传——坏 JSON
/// 由消费方（同步链路）按 SYNC_BAD_SWAGGER 报错，正确传播 fixture 损坏的事实。
pub async fn serve_fixture(State(state): State<AppState>) -> Response {
    let body = match state.openapi_fixture_path() {
        Some(path) => match std::fs::read_to_string(path) {
            Ok(content) => content,
            Err(e) => {
                eprintln!("demo-server: 读取 fixture 文件 {path:?} 失败（{e}），回落内嵌真文档");
                EMBEDDED_FIXTURE_DOC.to_owned()
            }
        },
        None => EMBEDDED_FIXTURE_DOC.to_owned(),
    };
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .expect("固定头值构建 Response 恒成功")
}

/// fixture 端点路径（路由挂载与启动打印的单一来源）
pub const FIXTURE_DOC_PATH: &str = "/api-docs/fixture.json";
