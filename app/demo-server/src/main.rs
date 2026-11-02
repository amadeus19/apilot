//! CLI 入口：`pnpm demo:server` → `cargo run -p demo-server [-- --port N] [-- --fixture <path>]`。
//! 默认 127.0.0.1:18080 仅回环绑定（避免 Windows 防火墙弹窗）。

use std::path::PathBuf;

use demo_server::{build_router, fixture::FIXTURE_DOC_PATH, state::AppState, DEFAULT_HOST, DEFAULT_PORT};

/// 启动参数：端口与 swagger fixture 文档路径
struct ServerArgs {
    port: u16,
    fixture: Option<PathBuf>,
}

fn main() {
    let args = parse_args(std::env::args().skip(1));
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("构建 tokio runtime");
    rt.block_on(async move {
        let listener = match tokio::net::TcpListener::bind((DEFAULT_HOST, args.port)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("绑定 {DEFAULT_HOST}:{} 失败: {e}", args.port);
                std::process::exit(1);
            }
        };
        let fixture_suffix = args
            .fixture
            .as_ref()
            .map(|p| format!(" <- {p:?}"))
            .unwrap_or_default();
        println!(
            "demo-server listening on http://{DEFAULT_HOST}:{} (Swagger UI: http://{DEFAULT_HOST}:{}/swagger-ui; fixture doc: http://{DEFAULT_HOST}:{}{FIXTURE_DOC_PATH}{fixture_suffix})",
            args.port, args.port, args.port
        );
        let state = match &args.fixture {
            Some(path) => AppState::with_openapi_fixture(path.clone()),
            None => AppState::new(),
        };
        if let Err(e) = axum::serve(listener, build_router(state)).await {
            eprintln!("demo-server stopped: {e}");
            std::process::exit(1);
        }
    });
}

/// 极简参数解析：`--port <N>`（非法值回落默认端口）与 `--fixture <path>`
/// （演示夹具不值得引 clap）
fn parse_args(args: impl Iterator<Item = String>) -> ServerArgs {
    let mut port = DEFAULT_PORT;
    let mut fixture = None;
    let mut iter = args;
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--port" => {
                if let Some(raw) = iter.next() {
                    if let Ok(parsed) = raw.parse() {
                        port = parsed;
                    }
                }
            }
            "--fixture" => {
                if let Some(raw) = iter.next() {
                    fixture = Some(PathBuf::from(raw));
                }
            }
            _ => {}
        }
    }
    ServerArgs { port, fixture }
}
