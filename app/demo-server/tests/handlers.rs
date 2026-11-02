//! 处理器级自测：oneshot 直调 Router（不经网络、不依赖 reqwest）。
//! 对网络层的完整集成（SSE 渐进 / 取消 / 大响应分级）由 src-tauri 集成测试经
//! `spawn_ephemeral` 覆盖，此处只钉处理器契约。

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use tower::ServiceExt;

use demo_server::{build_router, state::AppState};

fn router() -> Router {
    build_router(AppState::new())
}

async fn send(router: Router, req: Request<Body>) -> (StatusCode, String, Vec<(String, String)>) {
    let (status, body, headers) = send_bytes(router, req).await;
    (status, String::from_utf8_lossy(&body).into_owned(), headers)
}

/// 字节形态响应（媒体端点断言原始字节用）；`send` 在其上做文本解码。
async fn send_bytes(
    router: Router,
    req: Request<Body>,
) -> (StatusCode, Vec<u8>, Vec<(String, String)>) {
    let resp = router.oneshot(req).await.expect("oneshot 恒可完成");
    let status = resp.status();
    let headers = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let body = resp
        .into_body()
        .collect()
        .await
        .expect("响应体读取恒成功")
        .to_bytes();
    (status, body.to_vec(), headers)
}

/// 按名取响应头值（头名不区分大小写，http crate 存储恒小写）。
fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

#[tokio::test]
async fn healthz_ok() {
    let (status, body, _) = send(router(), Request::get("/healthz").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("\"ok\""));
}

#[tokio::test]
async fn login_correct_creds_token_in_header_and_body() {
    let req = Request::post("/auth/login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"username":"admin","password":"123456"}"#))
        .unwrap();
    let (status, body, headers) = send(router(), req).await;
    assert_eq!(status, StatusCode::OK);
    // 双形态：响应头 access-token 与响应体 token 同时存在且一致
    let header_token = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("access-token"))
        .map(|(_, v)| v.clone())
        .expect("响应头 access-token 必在");
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(header_token, parsed["token"].as_str().unwrap());
    assert_eq!(parsed["tokenType"], "Bearer");
}

#[tokio::test]
async fn login_wrong_creds_401() {
    let req = Request::post("/auth/login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"username":"admin","password":"wrong"}"#))
        .unwrap();
    let (status, _, _) = send(router(), req).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_me_requires_bearer() {
    let (status, _, _) = send(router(), Request::get("/auth/me").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let req = Request::get("/auth/me")
        .header(header::AUTHORIZATION, "Bearer not-a-jwt")
        .body(Body::empty())
        .unwrap();
    let (status, _, _) = send(router(), req).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_me_with_valid_token_echoes_claims() {
    // 先登录取 token，再带 token 调受保护接口（同一 router 实例＝同一内存态）
    let r = router();
    let req = Request::post("/auth/login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"username":"admin","password":"123456"}"#))
        .unwrap();
    // router 消耗于 oneshot，克隆再调（Router: Clone）
    let (status, body, _) = send(r.clone(), req).await;
    assert_eq!(status, StatusCode::OK);
    let token = serde_json::from_str::<serde_json::Value>(&body).unwrap()["token"]
        .as_str()
        .unwrap()
        .to_string();

    let req = Request::get("/auth/me")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let (status, body, _) = send(r, req).await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(parsed["sub"], "admin");
}

#[tokio::test]
async fn users_crud_flow() {
    let r = router();
    // list：种子数据 3 条
    let (status, body, _) =
        send(r.clone(), Request::get("/api/users").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(serde_json::from_str::<serde_json::Value>(&body).unwrap()["total"], 3);

    // query 形态：keyword 过滤
    let (status, body, _) = send(
        r.clone(),
        Request::get("/api/users?keyword=alice").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(serde_json::from_str::<serde_json::Value>(&body).unwrap()["total"], 1);

    // create：JSON body 形态
    let req = Request::post("/api/users")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"name":"Dave","email":"dave@example.com"}"#))
        .unwrap();
    let (status, body, _) = send(r.clone(), req).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(serde_json::from_str::<serde_json::Value>(&body).unwrap()["id"], 4);

    // path 形态：get 存在 / 不存在
    let (status, _, _) =
        send(r.clone(), Request::get("/api/users/4").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) =
        send(r.clone(), Request::get("/api/users/999").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // header 形态：PUT 缺 X-Request-Id → 400；带头 → 200
    let req = Request::put("/api/users/4")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"name":"Dave2","email":"dave2@example.com"}"#))
        .unwrap();
    let (status, _, _) = send(r.clone(), req).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let req = Request::put("/api/users/4")
        .header(header::CONTENT_TYPE, "application/json")
        .header("X-Request-Id", "req-1")
        .body(Body::from(r#"{"name":"Dave2","email":"dave2@example.com"}"#))
        .unwrap();
    let (status, body, _) = send(r.clone(), req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(serde_json::from_str::<serde_json::Value>(&body).unwrap()["name"], "Dave2");

    // delete：204 后再 get 404
    let (status, _, _) = send(
        r.clone(),
        Request::delete("/api/users/4").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _, _) =
        send(r.clone(), Request::get("/api/users/4").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn error_endpoint_returns_requested_status() {
    let (status, body, _) =
        send(router(), Request::get("/api/error/418").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::from_u16(418).unwrap());
    assert!(body.contains("418"));
    // 非法状态码 → 400
    let (status, _, _) =
        send(router(), Request::get("/api/error/999").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn slow_endpoint_delayed_response() {
    let r = router();
    let (status, body, _) = send(
        r,
        Request::get("/api/slow?ms=10").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("\"delayedMs\":10"));
    // 超上限拒绝
    let (status, _, _) = send(
        router(),
        Request::get("/api/slow?ms=60001").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn download_pdf_serves_minimal_pdf() {
    let (status, body, headers) =
        send_bytes(router(), Request::get("/api/download/pdf").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    // Content-Type 与前端 Preview PDF 通道白名单口径一致
    assert_eq!(header_value(&headers, "content-type"), Some("application/pdf"));
    assert!(body.starts_with(b"%PDF-"), "PDF 文件头");
    assert!(body.ends_with(b"%%EOF\n"), "%%EOF 收尾");
    let catalog = b"/Type /Catalog";
    assert!(body.windows(catalog.len()).any(|w| w == catalog), "含文档目录对象");
}

#[tokio::test]
async fn download_image_png_default_and_svg_param() {
    // 默认 PNG：Content-Type 命中前端图片通道白名单（image/ 前缀）
    let (status, body, headers) =
        send_bytes(router(), Request::get("/api/download/image").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(header_value(&headers, "content-type"), Some("image/png"));
    assert!(
        body.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
        "PNG 签名"
    );

    // type=svg：内联 SVG 文本，image/svg+xml 同样命中 image/ 前缀白名单
    let (status, body, headers) = send_bytes(
        router(),
        Request::get("/api/download/image?type=svg").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        header_value(&headers, "content-type"),
        Some("image/svg+xml; charset=utf-8")
    );
    let text = String::from_utf8(body).expect("SVG 恒为 UTF-8 文本");
    assert!(text.contains("<svg"), "内联 SVG 文本");
    assert!(text.contains("APilot SVG 靶图"), "SVG 中文文案");

    // 非法 type → 400
    let (status, _, _) = send_bytes(
        router(),
        Request::get("/api/download/image?type=bmp").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn download_html_serves_self_contained_page() {
    let (status, body, headers) =
        send_bytes(router(), Request::get("/api/download/html").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    // Content-Type 与前端 Preview html 通道白名单口径一致
    assert_eq!(
        header_value(&headers, "content-type"),
        Some("text/html; charset=utf-8")
    );
    let text = String::from_utf8(body).expect("HTML 恒为 UTF-8 文本");
    assert!(text.contains("<!doctype html>"), "自包含文档头");
    assert!(text.contains("APilot HTML 靶页"), "中文标题");
    assert!(text.contains("<table"), "表格");
    assert!(text.contains("<a href="), "链接");
    assert!(text.contains("style="), "内联样式");
}

#[tokio::test]
async fn media_download_endpoints_listed_in_openapi() {
    let (_, body, _) = send(
        router(),
        Request::get("/api-docs/openapi.json").body(Body::empty()).unwrap(),
    )
    .await;
    // 三端点经 utoipa 注解进入 OpenAPI 文档（Swagger UI 可见的程序化钉子）
    assert!(body.contains("/api/download/pdf"));
    assert!(body.contains("/api/download/image"));
    assert!(body.contains("/api/download/html"));
    // Content-Type 与前端 Preview 白名单口径一一对应地写进文档
    assert!(body.contains("application/pdf"));
    assert!(body.contains("image/png"));
    assert!(body.contains("image/svg+xml; charset=utf-8"));
    assert!(body.contains("text/html; charset=utf-8"));
}

/// fixture 端点默认（未配置路径）返回编译期内嵌的靶机真文档：JSON 可解析、
/// 与固化 fixture 同源（17 操作），且端点自身不进注解生成的 OpenAPI 文档
/// （保持固化口径不漂移）。
#[tokio::test]
async fn fixture_endpoint_serves_embedded_doc_by_default() {
    let r = router();
    let (status, body, headers) = send(
        r.clone(),
        Request::get("/api-docs/fixture.json").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(header_value(&headers, "content-type"), Some("application/json"));
    let doc: serde_json::Value = serde_json::from_str(&body).expect("内嵌真文档恒为合法 JSON");
    assert_eq!(doc["openapi"], "3.2.0");
    let op_count = doc["paths"]
        .as_object()
        .expect("paths 恒在")
        .values()
        .flat_map(|item| item.as_object().expect("path item 恒为对象").keys())
        .count();
    assert_eq!(op_count, 17, "与固化 fixture 同源：17 个操作");
    // 注解文档不含 fixture 端点（透传挂载，不进自动生成的 OpenAPI）
    let (_, api_doc, _) = send(
        r,
        Request::get("/api-docs/openapi.json").body(Body::empty()).unwrap(),
    )
    .await;
    assert!(!api_doc.contains("/api-docs/fixture.json"));
}

/// fixture 端点每请求读盘、不缓存：文件尚不存在时回落内嵌真文档；写入后读到
/// 文件内容；替换后再请求读到新内容——「改 fixture → 二次拉取」的核心行为。
#[tokio::test]
async fn fixture_endpoint_reads_file_and_picks_up_replacement() {
    let path = std::env::temp_dir().join(format!("apilot-demo-fixture-{}.json", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let r = build_router(demo_server::state::AppState::with_openapi_fixture(path.clone()));

    // 文件尚不存在 → 回落内嵌真文档
    let (status, body, _) = send(
        r.clone(),
        Request::get("/api-docs/fixture.json").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("\"openapi\""), "回落内嵌真文档");

    // 写入 v1 → 读到 v1
    let v1 = r#"{"openapi":"3.0.1","info":{"title":"fixture v1","version":"1"},"paths":{}}"#;
    std::fs::write(&path, v1).expect("写入 fixture v1");
    let (_, body, _) = send(
        r.clone(),
        Request::get("/api-docs/fixture.json").body(Body::empty()).unwrap(),
    )
    .await;
    assert!(body.contains("fixture v1"), "读到文件内容");

    // 替换为 v2 → 再请求读到 v2（不缓存，文件可被外部替换）
    let v2 = r#"{"openapi":"3.0.1","info":{"title":"fixture v2","version":"1"},"paths":{}}"#;
    std::fs::write(&path, v2).expect("写入 fixture v2");
    let (_, body, _) = send(
        r.clone(),
        Request::get("/api-docs/fixture.json").body(Body::empty()).unwrap(),
    )
    .await;
    assert!(body.contains("fixture v2"), "替换后读到新内容");

    std::fs::remove_file(&path).expect("清理临时 fixture");
}
