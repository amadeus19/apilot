//! 同步拉取应用服务（同步域第一步：拉取 → 归一 → 待应用暂存）。
//!
//! 职责边界：
//! - 按服务 doc_url 拉取 swagger.json（相对地址相对工作空间 BaseUrl 解析，
//!   与批量导入发现链路同一地址约定）；拉取不设超时——挂起由用户在向导中
//!   手动取消兜底，缓冲界由 32MB 大小上限承担；错误映射稳定错误码（网络
//!   错误＝`SYNC_SERVICE_UNREACHABLE`；HTTP 非 2xx、非法 JSON、版本不
//!   支持、超 32MB 上限＝`SYNC_BAD_SWAGGER`）；
//! - **只写待应用暂存**：唯一落盘写入＝拉取完成后写 `pending_fetches`
//!   （**不推进快照代**——未采用的变更不得刷新快照；
//!   快照只随全量应用转正。不写树、不碰用户数据表——
//!   `endpoint_user_data` 零接触）；归一仅作写库前可用性校验（坏文档零
//!   写入），暂存与快照原文是唯一事实源，diff 与 apply 均从原文重归一；
//!   拉取产物只回元信息，定义面不跨 IPC；徽标由应用事务按本次 diff 写入；
//! - 取消零副作用：CancellationToken 取消链贯穿拉取与下载循环，写库前设
//!   检查点——取消发生在任何写入之前（半途不留脏数据）；
//! - 拉取成功＝服务可达的事实更新：联动重探由 `fetch_and_refresh` 编排
//!   （委托 `ProbeService::refresh_in_background` 单点，经 TaskRegistry
//!   登记、后台不阻塞返回；拉取失败零重探）。

// lib.rs 的 invoke_handler 注册行由调度者验收时统一挂载，挂载前拉取命令
// 链路无引用面（services 模块私有）；挂载后本属性无害。
#![allow(dead_code)]

use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use sha2::Digest;
use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;

use crate::constants::{MAX_SWAGGER_DOC_BYTES, SYNC_FETCH_REDIRECT_LIMIT};
use crate::domain::sync::normalize::normalize;
use crate::domain::url::resolve_entry_url;
use crate::error::AppError;
use crate::error::codes;
use crate::infrastructure::{service_repo, snapshot_repo, workspace_repo};
use crate::services::probe::ProbeService;

/// 拉取产物：快照元信息（拉取页呈现与诊断用）。定义面（统一模型）不随
/// IPC 返回——diff 与 apply 从快照原文重归一（库为事实源）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchOutcome {
    pub service_id: String,
    /// 本次拉取对应的待转正代次（当前已应用最大代 + 1；全量应用时写入）
    pub generation: i64,
    pub sha256: String,
    pub size_bytes: usize,
    pub elapsed_ms: u64,
}

/// 对单个服务执行拉取：读服务 → 解析 doc_url → 有界拉取 → sha256 →
/// 归一 → 写待应用暂存（覆盖式，不推进快照代）。无文档地址的服务是纯
/// 手工容器，调用面不应对其发起拉取（`INVALID_ARGUMENT` 拒绝）。
pub async fn fetch_service(
    pool: &SqlitePool,
    service_id: &str,
    token: &CancellationToken,
) -> Result<FetchOutcome, AppError> {
    let started = Instant::now();
    let service = service_repo::get(pool, service_id).await?.ok_or_else(|| {
        AppError::new(
            codes::SERVICE_NOT_FOUND,
            format!("service not found: {service_id}"),
        )
    })?;
    let Some(doc_url) = service.doc_url.as_deref() else {
        return Err(AppError::new(
            codes::INVALID_ARGUMENT,
            format!("service {service_id} has no doc url (pure manual container, sync skips it)"),
        ));
    };
    let workspace = workspace_repo::get(pool, &service.workspace_id)
        .await?
        .ok_or_else(|| {
            AppError::new(
                codes::WORKSPACE_NOT_FOUND,
                format!("workspace not found: {}", service.workspace_id),
            )
        })?;
    let url = resolve_entry_url(doc_url, workspace.base_url.as_deref())?;
    let (text, size_bytes) = fetch_doc(&url, token).await?;
    // 写库前取消检查点：取消必须发生在任何写入之前（零副作用承诺）
    if token.is_cancelled() {
        return Err(AppError::new(codes::CANCELLED, "fetch cancelled"));
    }
    let sha256 = format!("{:x}", sha2::Sha256::digest(text.as_bytes()));
    // 归一＝写库前可用性校验：坏文档在此报 SYNC_BAD_SWAGGER，快照零写入
    normalize(&text)?;
    let mut conn = pool.acquire().await?;
    // 快照只随全量应用转正：拉取写待应用暂存（覆盖式），generation 报
    // 待转正代次（当前已应用最大代 + 1，无已应用代＝1）
    let applied = snapshot_repo::current(&mut *conn, service_id).await?;
    snapshot_repo::pending_upsert(&mut conn, service_id, &text, &sha256).await?;
    Ok(FetchOutcome {
        service_id: service_id.to_owned(),
        generation: applied.map(|s| s.generation).unwrap_or(0) + 1,
        sha256,
        size_bytes,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// 拉取并联动重探：拉取成功＝服务可达的事实更新，后台重探刷新芯片状态
/// （重探经 TaskRegistry 登记，键 `probe:refresh:<service_id>`，取消链由
/// registry 生命周期接管，不随拉取 token 回收）；拉取失败零重探
/// （可达性无从佐证）。
pub async fn fetch_and_refresh(
    pool: &SqlitePool,
    probe: &Arc<ProbeService>,
    registry: &crate::tasks::TaskRegistry,
    service_id: &str,
    token: &CancellationToken,
) -> Result<FetchOutcome, AppError> {
    let outcome = fetch_service(pool, service_id, token).await?;
    probe.refresh_in_background(registry, pool, service_id);
    Ok(outcome)
}

/// 有界拉取文档原文：Content-Length 预检＋分块累计超限即断（一切缓冲有界）；
/// 不设超时（挂起由手动取消兜底）；取消贯穿 send 与下载循环（select token）。
async fn fetch_doc(url: &str, token: &CancellationToken) -> Result<(String, usize), AppError> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(
            SYNC_FETCH_REDIRECT_LIMIT,
        ))
        .build()
        .map_err(|err| AppError::internal(format!("reqwest client build failed: {err}")))?;
    let mut response = tokio::select! {
        sent = client.get(url).send() => sent.map_err(unreachable)?,
        _ = token.cancelled() => return Err(cancelled()),
    };
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::new(
            codes::SYNC_BAD_SWAGGER,
            format!("document request returned {status}"),
        ));
    }
    if let Some(length) = response.content_length()
        && length as usize > MAX_SWAGGER_DOC_BYTES
    {
        return Err(too_large(length as usize));
    }
    let mut bytes: Vec<u8> = Vec::new();
    loop {
        let chunk = tokio::select! {
            chunk = response.chunk() => chunk.map_err(unreachable)?,
            _ = token.cancelled() => return Err(cancelled()),
        };
        let Some(chunk) = chunk else {
            break;
        };
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_SWAGGER_DOC_BYTES {
            return Err(too_large(bytes.len()));
        }
    }
    let text = String::from_utf8(bytes).map_err(|_| {
        AppError::new(
            codes::SYNC_BAD_SWAGGER,
            "document body is not valid UTF-8 text",
        )
    })?;
    let size = text.len();
    Ok((text, size))
}

fn cancelled() -> AppError {
    AppError::new(codes::CANCELLED, "fetch cancelled")
}

/// 网络层失败（连接拒绝 / DNS / TLS / 中途中断）＝服务不可达。
fn unreachable(err: reqwest::Error) -> AppError {
    AppError::new(
        codes::SYNC_SERVICE_UNREACHABLE,
        format!("document fetch failed: {err}"),
    )
}

fn too_large(actual: usize) -> AppError {
    AppError::new(
        codes::SYNC_BAD_SWAGGER,
        format!("document exceeds {MAX_SWAGGER_DOC_BYTES} bytes limit"),
    )
    .with_details(serde_json::json!({
        "limit": MAX_SWAGGER_DOC_BYTES,
        "actual": actual,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::domain::sync::model::{UnifiedDoc, UnifiedParamLocation, UnifiedSchema};
    use crate::infrastructure::service_repo::test_support::seed_service;
    use crate::infrastructure::workspace_repo::test_support as ws_support;
    use sqlx::SqlitePool;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const SWAGGER2_FIXTURE: &str = include_str!("../../tests/fixtures/sync/swagger2.json");
    const OPENAPI3_FIXTURE: &str = include_str!("../../tests/fixtures/sync/openapi3.json");

    async fn memory_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        pool
    }

    /// 最小本地 HTTP 服务器（测试专用，不依赖公网）：对每个连接回写
    /// `response`（先行常量头 + body），`delay` 模拟慢响应供取消测试。
    async fn spawn_test_server(response: &'static str, delay_ms: u64) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let response = response;
                tokio::spawn(async move {
                    // 读掉请求头（最小消费，不解析）
                    let mut buf = [0u8; 4096];
                    let _ = socket.read(&mut buf).await;
                    if delay_ms > 0 {
                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    }
                    let head = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n";
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}/swagger/v1/swagger.json")
    }

    async fn count_snapshots(pool: &SqlitePool) -> i64 {
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM snapshots")
            .fetch_one(pool)
            .await
            .unwrap();
        count
    }

    async fn count_pending(pool: &SqlitePool) -> i64 {
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pending_fetches")
            .fetch_one(pool)
            .await
            .unwrap();
        count
    }

    async fn count_endpoints(pool: &SqlitePool) -> i64 {
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM endpoints")
            .fetch_one(pool)
            .await
            .unwrap();
        count
    }

    async fn count_user_data(pool: &SqlitePool) -> i64 {
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM endpoint_user_data")
            .fetch_one(pool)
            .await
            .unwrap();
        count
    }

    /// 真链路：本地服务器返回 Swagger 2.0 fixture → 待应用暂存写入＋元信息
    /// 返回（定义面不跨 IPC，diff/apply 从暂存与已应用代重归一）；快照
    /// 零滚动（滚动只随全量应用）。
    #[tokio::test]
    async fn fetch_writes_pending_and_returns_meta() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        seed_service(&pool, "s1", "w1", "服务A").await;
        sqlx::query("UPDATE services SET doc_url = ? WHERE id = 's1'")
            .bind(spawn_test_server(SWAGGER2_FIXTURE, 0).await)
            .execute(&pool)
            .await
            .unwrap();

        let outcome = fetch_service(&pool, "s1", &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(outcome.service_id, "s1");
        assert_eq!(
            outcome.generation, 1,
            "待转正代次＝已应用最大代+1（无已应用代＝1）"
        );
        assert_eq!(outcome.size_bytes, SWAGGER2_FIXTURE.len());
        assert_eq!(
            outcome.sha256,
            format!("{:x}", sha2::Sha256::digest(SWAGGER2_FIXTURE.as_bytes()))
        );

        // 暂存原文整存；快照、树行与用户数据零写入
        let pending = snapshot_repo::pending_get(&pool, "s1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pending.content, SWAGGER2_FIXTURE);
        assert_eq!(count_snapshots(&pool).await, 0, "拉取不得滚快照");
        assert_eq!(count_endpoints(&pool).await, 0, "拉取不得写树");
        assert_eq!(count_user_data(&pool).await, 0, "拉取不得碰用户数据表");
    }

    /// 重复拉取覆盖暂存、不滚快照；OpenAPI 3.0 fixture 同链路可解析。
    #[tokio::test]
    async fn repeated_fetch_overwrites_pending_without_rolling() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        seed_service(&pool, "s1", "w1", "服务A").await;
        let url = spawn_test_server(OPENAPI3_FIXTURE, 0).await;
        sqlx::query("UPDATE services SET doc_url = ? WHERE id = 's1'")
            .bind(&url)
            .execute(&pool)
            .await
            .unwrap();

        let first = fetch_service(&pool, "s1", &CancellationToken::new())
            .await
            .unwrap();
        let second = fetch_service(&pool, "s1", &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            (first.generation, second.generation),
            (1, 1),
            "未应用不滚代"
        );
        assert_eq!(count_snapshots(&pool).await, 0);
        assert_eq!(count_pending(&pool).await, 1, "每服务一行，重复拉取覆盖");
        let pending = snapshot_repo::pending_get(&pool, "s1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pending.content, OPENAPI3_FIXTURE);
    }

    /// 取消零副作用：慢响应服务器上拉取中取消 → CANCELLED 且快照表零行。
    #[tokio::test]
    async fn cancel_during_fetch_leaves_no_dirty_writes() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        seed_service(&pool, "s1", "w1", "服务A").await;
        let url = spawn_test_server(SWAGGER2_FIXTURE, 10_000).await;
        sqlx::query("UPDATE services SET doc_url = ? WHERE id = 's1'")
            .bind(&url)
            .execute(&pool)
            .await
            .unwrap();

        let token = CancellationToken::new();
        let fetch_token = token.clone();
        let handle = tokio::spawn({
            let pool = pool.clone();
            async move { fetch_service(&pool, "s1", &fetch_token).await }
        });
        // 等拉取进入等待响应，再取消
        tokio::time::sleep(Duration::from_millis(100)).await;
        token.cancel();
        let err = handle.await.unwrap().unwrap_err();
        assert_eq!(err.code, codes::CANCELLED);
        assert_eq!(count_snapshots(&pool).await, 0, "取消不得留任何快照写入");
        assert_eq!(count_pending(&pool).await, 0, "取消不得留任何暂存写入");
        assert_eq!(count_endpoints(&pool).await, 0);
        assert_eq!(count_user_data(&pool).await, 0);
    }

    /// 非 2xx 响应＝SYNC_BAD_SWAGGER（服务可达但文档不可用）。
    #[tokio::test]
    async fn non_success_status_maps_to_bad_swagger() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        seed_service(&pool, "s1", "w1", "服务A").await;
        // 404 服务器：回写 404 头即断
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = socket.read(&mut buf).await;
                    let _ = socket
                        .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .await;
                });
            }
        });
        sqlx::query("UPDATE services SET doc_url = ? WHERE id = 's1'")
            .bind(format!("http://{addr}/swagger/v1/swagger.json"))
            .execute(&pool)
            .await
            .unwrap();

        let err = fetch_service(&pool, "s1", &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::SYNC_BAD_SWAGGER);
        assert_eq!(count_snapshots(&pool).await, 0, "异常响应零写入");
    }

    /// 连接不可达（无监听端口）＝SYNC_SERVICE_UNREACHABLE。
    #[tokio::test]
    async fn network_failure_maps_to_service_unreachable() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        seed_service(&pool, "s1", "w1", "服务A").await;
        // 先占一个端口再关掉，得到「确定无监听」的地址
        let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = probe.local_addr().unwrap();
        drop(probe);
        sqlx::query("UPDATE services SET doc_url = ? WHERE id = 's1'")
            .bind(format!("http://{addr}/swagger/v1/swagger.json"))
            .execute(&pool)
            .await
            .unwrap();

        let err = fetch_service(&pool, "s1", &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::SYNC_SERVICE_UNREACHABLE);
        assert_eq!(count_snapshots(&pool).await, 0);
    }

    /// 联动重探不变式（headless 直测）：拉取成功必须在限期内写入探测终态
    /// （本地靶机任一 HTTP 响应＝可达）。
    #[tokio::test]
    async fn fetch_success_triggers_background_reprobe() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        seed_service(&pool, "s1", "w1", "服务A").await;
        sqlx::query("UPDATE services SET doc_url = ? WHERE id = 's1'")
            .bind(spawn_test_server(SWAGGER2_FIXTURE, 0).await)
            .execute(&pool)
            .await
            .unwrap();

        let probe = Arc::new(crate::services::probe::ProbeService::new());
        fetch_and_refresh(
            &pool,
            &probe,
            &crate::tasks::TaskRegistry::new(),
            "s1",
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        // 重探是后台 spawn：轮询状态表直到终态
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(state) = probe.snapshot().iter().find(|s| s.service_id == "s1") {
                assert_eq!(state.status, crate::services::probe::ProbeStatus::Reachable);
                break;
            }
            assert!(
                Instant::now() < deadline,
                "拉取成功后联动重探必须在限期内写入终态"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// 联动重探不变式（headless 直测）：拉取失败零重探——状态表不出现
    /// 该服务条目（靶机回 404：若误触发重探，「任一响应即可达」会留下
    /// 可达条目，测试即失败）。
    #[tokio::test]
    async fn fetch_failure_skips_reprobe() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        seed_service(&pool, "s1", "w1", "服务A").await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = [0u8; 4096];
                    let _ = socket.read(&mut buf).await;
                    let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                });
            }
        });
        sqlx::query("UPDATE services SET doc_url = ? WHERE id = 's1'")
            .bind(format!("http://{addr}/swagger/v1/swagger.json"))
            .execute(&pool)
            .await
            .unwrap();

        let probe = Arc::new(crate::services::probe::ProbeService::new());
        let err = fetch_and_refresh(
            &pool,
            &probe,
            &crate::tasks::TaskRegistry::new(),
            "s1",
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, codes::SYNC_BAD_SWAGGER);
        // 给潜在的后台重探留观察窗口：拉取失败不得留下任何状态写入
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            probe.snapshot().is_empty(),
            "拉取失败不得触发联动重探（状态表必须零写入）"
        );
    }

    /// 前置校验：服务不存在 / 无文档地址 / 工作空间缺 BaseUrl 配相对地址。
    #[tokio::test]
    async fn fetch_validates_service_and_doc_url() {
        let pool = memory_pool().await;
        let err = fetch_service(&pool, "nope", &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::SERVICE_NOT_FOUND);

        ws_support::seed_workspace(&pool, "w1", "一").await;
        seed_service(&pool, "s1", "w1", "服务A").await;
        let err = fetch_service(&pool, "s1", &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT, "无地址服务拒绝拉取");

        sqlx::query("UPDATE services SET doc_url = '/swagger/v1/swagger.json' WHERE id = 's1'")
            .execute(&pool)
            .await
            .unwrap();
        let err = fetch_service(&pool, "s1", &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(
            err.code,
            codes::URL_INVALID,
            "相对地址在无工作空间 BaseUrl 时必须 URL_INVALID"
        );
    }

    /// 两套规范同一业务面：拉取链路（本地服务器）保证两代快照可写；归一
    /// 等价性经 normalize 直调断言（解析纯函数对齐断言见 normalize 模块测试）。
    #[tokio::test]
    async fn fetch_outcomes_align_across_spec_versions() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        seed_service(&pool, "s2", "w1", "Swagger2服务").await;
        seed_service(&pool, "s3", "w1", "OpenAPI3服务").await;
        let url2 = spawn_test_server(SWAGGER2_FIXTURE, 0).await;
        let url3 = spawn_test_server(OPENAPI3_FIXTURE, 0).await;
        sqlx::query("UPDATE services SET doc_url = ? WHERE id = 's2'")
            .bind(&url2)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE services SET doc_url = ? WHERE id = 's3'")
            .bind(&url3)
            .execute(&pool)
            .await
            .unwrap();

        fetch_service(&pool, "s2", &CancellationToken::new())
            .await
            .unwrap();
        fetch_service(&pool, "s3", &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            normalize(SWAGGER2_FIXTURE).unwrap(),
            normalize(OPENAPI3_FIXTURE).unwrap(),
            "同一业务面的两套规范必须产出等价统一模型"
        );
    }

    /// 归一层元数据保真抽查（definition 扩容供料面）：description / 类型 /
    /// required / example 与参数五位置经统一模型可达。
    #[tokio::test]
    async fn unified_doc_carries_definition_side_metadata() {
        let doc = normalize(OPENAPI3_FIXTURE).unwrap();
        let create = doc
            .operations
            .iter()
            .find(|op| op.key == "POST /users")
            .expect("POST /users 必须在 fixture 内");
        let body = create.request_body.as_ref().unwrap();
        assert_eq!(body.content_type, "application/json");
        assert_eq!(body.schema.schema_type, "object");
        assert_eq!(body.schema.required, vec!["username", "email"]);
        let username = &body
            .schema
            .properties
            .iter()
            .find(|(name, _)| name == "username")
            .unwrap()
            .1;
        assert_eq!(username.schema_type, "string");
        assert_eq!(
            username.description.as_deref(),
            Some("用户名（登录凭证，全局唯一）")
        );
        assert_eq!(username.example, Some(serde_json::json!("alice")));

        let id_param = create
            .parameters
            .iter()
            .find(|p| p.name == "X-Request-Id")
            .expect("header 参数必须归一保留");
        assert_eq!(id_param.location, UnifiedParamLocation::Header);
        assert_eq!(id_param.description.as_deref(), Some("请求追踪头"));

        // 响应侧结构可达（示例双轨：MediaType.example 优先）
        let created = create.responses.iter().find(|r| r.status == "201").unwrap();
        assert_eq!(created.content_type.as_deref(), Some("application/json"));
        let schema = created.schema.as_ref().unwrap();
        assert_eq!(schema.schema_type, "object");
        assert!(schema.properties.iter().any(|(name, _)| name == "id"));

        // 循环引用截断形态：User.friends 自引用不死锁
        let user_schema = |op: &crate::domain::sync::model::UnifiedOperation| {
            op.responses
                .iter()
                .find(|r| r.status == "200")
                .and_then(|r| r.schema.clone())
        };
        let get_one = doc
            .operations
            .iter()
            .find(|op| op.key == "GET /users/{id}")
            .unwrap();
        let user = user_schema(get_one).unwrap();
        let friends = user
            .properties
            .iter()
            .find(|(name, _)| name == "friends")
            .map(|(_, schema)| schema.clone())
            .unwrap();
        assert_eq!(friends.schema_type, "array");
        let items = friends.items.unwrap();
        assert_eq!(items.ref_name.as_deref(), Some("User"));
        assert!(items.truncated, "循环引用必须在第二层截断");
        assert_eq!(items.schema_type, "object", "截断前保留已知类型面");
    }

    /// 参数类型归一形态（v2 参数 type 字符串 / v3 schema 类型）等价性抽查。
    #[tokio::test]
    async fn parameter_types_normalize_identically() {
        let v2 = normalize(SWAGGER2_FIXTURE).unwrap();
        let v3 = normalize(OPENAPI3_FIXTURE).unwrap();
        let pick = |doc: &UnifiedDoc| {
            doc.operations
                .iter()
                .find(|op| op.key == "GET /users")
                .unwrap()
                .parameters
                .clone()
        };
        assert_eq!(pick(&v2), pick(&v3));
    }

    /// 空统一 schema 形态冒烟（截断基底不炸序列化）。
    #[test]
    fn unified_schema_empty_serializes() {
        let schema = UnifiedSchema::empty();
        let json = serde_json::to_string(&schema).unwrap();
        assert!(json.contains("\"schemaType\":\"\""));
    }
}
