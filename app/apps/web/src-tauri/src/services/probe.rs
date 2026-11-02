//! 服务可达性探测（四态：可达 / 不可达 / 未知 / 探测中）。
//!
//! 生命周期（资源四问）：
//! - 谁拥有：`AppState.probe`（进程内存态，不落库——可达性是瞬时事实，
//!   重启后回「未知」等首轮探测）；
//! - 何时创建：应用启动后后台探测一次（经 TaskRegistry spawn，不阻塞启动）；
//! - 何时释放：探测请求有远大于常态的兜底超时
//!   （`PROBE_FALLBACK_TIMEOUT_MS`——对端 accept 后静默不回包的连接不会
//!   在进程生命周期内永驻；连接层成败仍自然收敛，慢服务不被误判
//!   「不可达」）。一切探测任务（启动轮 / 全量刷新 / 单服务联动重探）经
//!   TaskRegistry 登记、shutdown 统一取消；在途请求取消链落
//!   CancellationToken（随取消立即退出）；
//! - 并发有界：批量探测并发上限 `PROBE_CONCURRENCY`（信号量），状态表
//!   单锁短持有。
//!
//! 事件推送：状态变化经事件出口闭包推送 `probe://status`（分层纪律——
//! 服务层不触 Tauri，AppHandle 由 commands 层装配注入；headless / 测试
//! 出口缺省为 None 静默）。UI 不轮询：初始快照走 `probe.list` IPC，之后
//! 全靠事件；同步拉取完成、手动建 / 改服务后的联动重探由本模块
//! `refresh_in_background` 单点编排（命令层只委托，编排留在服务层）。

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;

use crate::constants::PROBE_CONCURRENCY;
use crate::domain::clock::now_rfc3339;
use crate::domain::service::Service;
use crate::domain::url::resolve_entry_url;
use crate::error::AppError;
use crate::infrastructure::service_repo;
use crate::services::send::SseEventSink;
use tokio_util::sync::CancellationToken;

/// 探测四态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProbeStatus {
    /// 探测请求收到任一 HTTP 响应（2xx–5xx 皆证明服务活着）
    Reachable,
    /// 连接失败 / TLS 失败（连接层的「不可达」证明）；兜底超时不落此态
    /// （超时＝对端已建立连接但静默不回包，可达性无从断言，回「未知」）
    Unreachable,
    /// 未探测（进程启动后的初始态）
    Unknown,
    /// 探测请求在途
    Probing,
}

/// 单服务探测状态（内存态快照）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeState {
    pub service_id: String,
    pub status: ProbeStatus,
    /// 最近一次探测完成时刻（RFC3339 UTC；未知 / 探测中为 None）
    pub checked_at: Option<String>,
}

/// 事件载荷（`probe://status`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeEvent {
    service_id: String,
    status: ProbeStatus,
    checked_at: Option<String>,
}

/// 探测服务：状态表＋事件出口＋共享探测 client。
pub struct ProbeService {
    states: std::sync::RwLock<HashMap<String, ProbeState>>,
    sink: Option<SseEventSink>,
    /// 共享探测 client：首次探测惰性构建一次（连接池 / TLS 会话跨探测
    /// 复用，批量轮与联动重探不再每探重建）；兜底超时策略在构建点单点声明
    client: std::sync::OnceLock<reqwest::Client>,
    /// 探测请求兜底超时（生产为 `PROBE_FALLBACK_TIMEOUT_MS`；测试注入
    /// 短值直测超时口径，见 `with_fallback_timeout_for_test`）
    fallback_timeout: std::time::Duration,
}

impl ProbeService {
    /// headless / 测试装配（无事件出口，静默）。
    pub fn new() -> Self {
        Self {
            states: std::sync::RwLock::new(HashMap::new()),
            sink: None,
            client: std::sync::OnceLock::new(),
            fallback_timeout: std::time::Duration::from_millis(
                crate::constants::PROBE_FALLBACK_TIMEOUT_MS,
            ),
        }
    }

    /// GUI 装配（事件出口注入；commands 层把 AppHandle 装配为闭包）。
    pub fn with_sink(sink: SseEventSink) -> Self {
        Self {
            states: std::sync::RwLock::new(HashMap::new()),
            sink: Some(sink),
            client: std::sync::OnceLock::new(),
            fallback_timeout: std::time::Duration::from_millis(
                crate::constants::PROBE_FALLBACK_TIMEOUT_MS,
            ),
        }
    }

    /// 测试装配：注入短兜底超时（超时口径直测不等真实 60s）。必须在首次
    /// 探测前调用——共享 client 惰性构建时读取该值，构建后不可再变。
    #[cfg(test)]
    pub(crate) fn with_fallback_timeout_for_test(fallback_timeout: std::time::Duration) -> Self {
        Self {
            fallback_timeout,
            ..Self::new()
        }
    }

    /// 共享探测 client：首次调用惰性构建，此后全实例复用。构建失败原样
    /// 返回（罕见且无害——不缓存失败，下次探测重试构建）。并发首建的
    /// 竞争下后写者赢，两实例策略相同（同一超时值），等价无害。
    fn probe_client(&self) -> Result<reqwest::Client, AppError> {
        if let Some(client) = self.client.get() {
            return Ok(client.clone());
        }
        let built = reqwest::Client::builder()
            .timeout(self.fallback_timeout)
            .build()
            .map_err(|err| AppError::internal(format!("probe client build failed: {err}")))?;
        let _ = self.client.set(built.clone());
        Ok(built)
    }

    /// 全部服务的当前状态（`probe.list` 初始快照；未记录的服务不在表中，
    /// 前端按「未知」呈现）。
    pub fn snapshot(&self) -> Vec<ProbeState> {
        // 锁中毒仅当持锁线程 panic（短临界区无 panic 面）——视为不可达不变量
        self.states
            .read()
            .expect("probe states lock")
            .values()
            .cloned()
            .collect()
    }

    fn emit(&self, service_id: &str, status: ProbeStatus, checked_at: Option<String>) {
        if let Some(sink) = &self.sink
            && let Ok(value) = serde_json::to_value(ProbeEvent {
                service_id: service_id.to_string(),
                status,
                checked_at: checked_at.clone(),
            })
        {
            sink("probe://status", &value);
        }
    }

    fn mark(&self, service_id: &str, status: ProbeStatus, checked_at: Option<String>) {
        self.states.write().expect("probe states lock").insert(
            service_id.to_string(),
            ProbeState {
                service_id: service_id.to_string(),
                status,
                checked_at: checked_at.clone(),
            },
        );
        self.emit(service_id, status, checked_at);
    }

    /// 单服务探测：doc_url 发 GET，收到任一 HTTP 响应即「可达」。取消链
    /// 落 token（在途请求随取消立即退出）。兜底超时口径（钉住）：
    /// 连接层成败自然收敛、「不可达」只留给连接失败 / TLS 失败的证明；
    /// 唯一的超时是远大于常态的兜底（`PROBE_FALLBACK_TIMEOUT_MS`），触发
    /// 即对端 accept 后静默不回包——可达性无从断言，回「未知」而非
    /// 「不可达」（慢服务在正常时长内不触此兜底，不违「不误判」初衷）。
    ///
    /// 探测目标与同步拉取同一地址口径（单点收敛 `resolve_entry_url`）：
    /// 相对地址相对工作空间 BaseUrl 解析。地址无法构成请求（相对地址且
    /// 无 BaseUrl）时请求未发出，保持「未知」——「不可达」只留给连接层
    /// 失败，地址无效的明示归同步拉取的 `URL_INVALID`。
    pub async fn probe_one(
        &self,
        pool: &sqlx::SqlitePool,
        service: &Service,
        token: &CancellationToken,
    ) -> Result<ProbeStatus, AppError> {
        // 无 doc_url 的服务无从探起：保持「未知」（不产生误导性「不可达」）
        let Some(doc_url) = service
            .doc_url
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty())
        else {
            return Ok(ProbeStatus::Unknown);
        };
        let base_url = crate::infrastructure::workspace_repo::get(pool, &service.workspace_id)
            .await
            .ok()
            .flatten()
            .and_then(|workspace| workspace.base_url);
        let Ok(target) = resolve_entry_url(doc_url, base_url.as_deref()) else {
            self.mark(&service.id, ProbeStatus::Unknown, None);
            return Ok(ProbeStatus::Unknown);
        };
        self.mark(&service.id, ProbeStatus::Probing, None);
        let client = self.probe_client()?;
        // 探测目标＝解析后的 doc_url 直探（入口页形态的服务探入口页即可达
        // ——可达性关心服务活着，不关心文档形态）
        let outcome = tokio::select! {
            sent = client.get(target).send() => match sent {
                Ok(_) => ProbeStatus::Reachable,
                // 兜底超时≠「不可达」：连接已建立而对端不回包，可达性无从
                // 断言；回「未知」且不落 checked_at（与取消同口径——非终态
                // 不记时，「未知 / 探测中为 None」的快照语义保持不变）
                Err(err) if err.is_timeout() => {
                    self.mark(&service.id, ProbeStatus::Unknown, None);
                    return Ok(ProbeStatus::Unknown);
                }
                Err(_) => ProbeStatus::Unreachable,
            },
            _ = token.cancelled() => {
                // 取消不是终态：回「未知」并停止（不产「不可达」误报）
                self.mark(&service.id, ProbeStatus::Unknown, None);
                return Ok(ProbeStatus::Unknown);
            }
        };
        self.mark(&service.id, outcome, Some(now_rfc3339()));
        Ok(outcome)
    }

    /// 联动重探（后台）：读取最新服务形态后探测，不阻塞调用方。调用面＝
    /// 同步拉取成功（服务可达的事实更新）与手动建 / 改服务后芯片状态即时
    /// 回流（`probe://status` 事件，不等下一轮刷新）。纯手工容器
    /// （doc_url 为空）无从探起，静默跳过——状态保持「未知」。
    ///
    /// 经 TaskRegistry 登记（键 `probe:refresh:<service_id>`）：同键在途
    /// 时再触发被拒绝（无害——在途任务的探测即将回流状态，与
    /// `probe:refresh_all` 同形态）；已完成的同键残留先解除再登记（任务体
    /// 由下一次同键或 `cleanup_finished` 回收）。取消链由 registry 生命
    /// 周期接管（shutdown 序列 cancel_all → wait_all 对探测完整覆盖），
    /// 不自建无人取消的裸 token。
    pub fn refresh_in_background(
        self: &Arc<Self>,
        registry: &crate::tasks::TaskRegistry,
        pool: &sqlx::SqlitePool,
        service_id: &str,
    ) {
        let this = self.clone();
        let pool = pool.clone();
        let service_id = service_id.to_owned();
        let key = crate::tasks::probe_refresh_task_key(&service_id);
        // 上一次同键重探已完成：残留条目先解除（remove 仅用于已结束条目
        // 的清理纪律）；仍在途则下方 spawn 被拒——重探是尽力事实，无害
        if !registry.is_running(&key) {
            registry.remove(&key);
        }
        // 登记失败只可能因同键在途或 shutdown 已启动，两者皆无害
        let _ = registry.spawn(&key, |token| async move {
            let Ok(Some(service)) = service_repo::get(&pool, &service_id).await else {
                return;
            };
            if service.doc_url.is_none() {
                return;
            }
            let _ = this.probe_one(&pool, &service, &token).await;
        });
    }

    /// 批量探测（启动后台轮 / 手动全量刷新）：有界并发，单服务失败不阻断
    /// 其余（可达性是尽力事实）。返回完成数（测试断言面）。
    pub async fn probe_all(
        self: &Arc<Self>,
        pool: &sqlx::SqlitePool,
        services: Vec<Service>,
        token: &CancellationToken,
    ) -> usize {
        let semaphore = Arc::new(tokio::sync::Semaphore::new(PROBE_CONCURRENCY));
        let mut handles = Vec::with_capacity(services.len());
        for service in services {
            let permit_sem = semaphore.clone();
            let this = self.clone();
            let token = token.clone();
            let pool = pool.clone();
            handles.push(tokio::spawn(async move {
                // 信号量限制同时在途的探测请求数；取消时新任务不再起探
                let _permit = permit_sem.acquire().await;
                if token.is_cancelled() {
                    return;
                }
                let _ = this.probe_one(&pool, &service, &token).await;
            }));
        }
        let mut done = 0;
        for handle in handles {
            if handle.await.is_ok() {
                done += 1;
            }
        }
        done
    }
}

impl Default for ProbeService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::infrastructure::service_repo::test_support as service_support;
    use crate::infrastructure::workspace_repo::test_support as ws_support;
    use sqlx::SqlitePool;

    async fn memory_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn snapshot_starts_empty_and_states_flow() {
        let probe = ProbeService::new();
        let pool = memory_pool().await;
        assert!(probe.snapshot().is_empty());
        let service = Service {
            id: "s1".into(),
            workspace_id: "w1".into(),
            name: "服务A".into(),
            doc_url: Some("http://127.0.0.1:1/doc".into()),
            doc_type: crate::domain::service::DOC_TYPE_OPENAPI.to_owned(),
            sort_order: 0,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let token = CancellationToken::new();
        // 端口 1 无监听：连接失败 → Unreachable（终态含 checked_at）
        let status = probe.probe_one(&pool, &service, &token).await.unwrap();
        assert_eq!(status, ProbeStatus::Unreachable);
        let snapshot = probe.snapshot();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].status, ProbeStatus::Unreachable);
        assert!(snapshot[0].checked_at.is_some());
    }

    #[tokio::test]
    async fn cancel_returns_unknown_without_false_unreachable() {
        let probe = ProbeService::new();
        let pool = memory_pool().await;
        let service = Service {
            id: "s1".into(),
            workspace_id: "w1".into(),
            name: "服务A".into(),
            doc_url: Some("http://127.0.0.1:1/doc".into()),
            doc_type: crate::domain::service::DOC_TYPE_OPENAPI.to_owned(),
            sort_order: 0,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let token = CancellationToken::new();
        token.cancel();
        let status = probe.probe_one(&pool, &service, &token).await.unwrap();
        assert_eq!(status, ProbeStatus::Unknown);
        assert_eq!(probe.snapshot()[0].status, ProbeStatus::Unknown);
    }

    #[tokio::test]
    async fn probe_all_bounded_and_completes() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        for i in 0..6 {
            service_support::seed_service_with_doc_url(
                &pool,
                &format!("s{i}"),
                "w1",
                &format!("服务{i}"),
                Some(&format!("http://127.0.0.1:1/doc{i}")),
            )
            .await;
        }
        let probe = Arc::new(ProbeService::new());
        let services = crate::infrastructure::service_repo::list_all(&pool)
            .await
            .unwrap();
        assert_eq!(services.len(), 6);
        let done = probe
            .probe_all(&pool, services, &CancellationToken::new())
            .await;
        assert_eq!(done, 6);
        // 全部到达终态（不可达：端口无监听），无残留「探测中」
        assert!(
            probe
                .snapshot()
                .iter()
                .all(|s| s.status == ProbeStatus::Unreachable)
        );
    }

    /// 本地 TCP 应答器：任意 HTTP 响应＝可达（不依赖公网）。
    #[tokio::test]
    async fn reachable_when_any_http_response() {
        let pool = memory_pool().await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = [0u8; 1024];
                    let _ = socket.read(&mut buf).await;
                    let _ = socket
                        .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                        .await;
                });
            }
        });
        let probe = ProbeService::new();
        let service = Service {
            id: "s1".into(),
            workspace_id: "w1".into(),
            name: "服务A".into(),
            doc_url: Some(format!("http://{addr}/doc")),
            doc_type: crate::domain::service::DOC_TYPE_OPENAPI.to_owned(),
            sort_order: 0,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let status = probe
            .probe_one(&pool, &service, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(status, ProbeStatus::Reachable);
        server.abort();
    }

    /// 相对文档地址＋工作空间 BaseUrl：探测与同步拉取必须同一地址口径
    /// （相对地址按 BaseUrl 解析后可探）——此前探测直用原串发请求，同址
    /// 导入能接入而探测误报「不可达」。
    #[tokio::test]
    async fn relative_doc_url_resolves_against_workspace_base_url() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = [0u8; 1024];
                    let _ = socket.read(&mut buf).await;
                    let _ = socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                        .await;
                });
            }
        });
        crate::infrastructure::workspace_repo::update(
            &pool,
            "w1",
            "一",
            Some(format!("http://{addr}").as_str()),
        )
        .await
        .unwrap();
        service_support::seed_service_with_doc_url(
            &pool,
            "s1",
            "w1",
            "服务A",
            Some("/doc/openapi.json"),
        )
        .await;
        let service = crate::infrastructure::service_repo::get(&pool, "s1")
            .await
            .unwrap()
            .unwrap();
        let probe = ProbeService::new();
        let status = probe
            .probe_one(&pool, &service, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            status,
            ProbeStatus::Reachable,
            "相对地址须经 BaseUrl 解析后再探"
        );
        server.abort();
    }

    /// 相对文档地址且工作空间无 BaseUrl：探测请求无从构成，保持「未知」
    /// （不产误导性「不可达」；地址无效的明示归同步拉取的 URL_INVALID）。
    #[tokio::test]
    async fn relative_doc_url_without_base_url_stays_unknown() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        service_support::seed_service_with_doc_url(
            &pool,
            "s1",
            "w1",
            "服务A",
            Some("/doc/openapi.json"),
        )
        .await;
        let service = crate::infrastructure::service_repo::get(&pool, "s1")
            .await
            .unwrap()
            .unwrap();
        let probe = ProbeService::new();
        let status = probe
            .probe_one(&pool, &service, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(status, ProbeStatus::Unknown);
        assert_eq!(probe.snapshot()[0].status, ProbeStatus::Unknown);
    }

    /// 挂起服务器：accept 后读挂、永不写响应（模拟对端 accept 后静默
    /// 不回包的已建立连接）。返回句柄 abort 供测试收尾。
    async fn spawn_hanging_server() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    use tokio::io::AsyncReadExt;
                    let mut buf = [0u8; 1024];
                    // 读到 EOF 前持续丢弃请求字节：连接保持打开且永不写
                    // 任何 HTTP 响应（单次 read 收到请求字节即返回会让
                    // socket 随任务结束 drop、连接被关闭，探测将收到
                    // 「连接中断」而非「静默不回包」）
                    loop {
                        match socket.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {}
                        }
                    }
                });
            }
        });
        (addr, server)
    }

    /// ①联动重探经 registry 登记（headless 直测）：spawn 后 registry 可见、
    /// 同键在途再触发被拒（活跃数不涨）、cancel_all 后任务终止且状态回
    /// 「未知」（不产「不可达」误报）。
    #[tokio::test]
    async fn refresh_in_background_registers_and_cancels_via_registry() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        let (addr, server) = spawn_hanging_server().await;
        service_support::seed_service_with_doc_url(
            &pool,
            "s1",
            "w1",
            "服务A",
            Some(&format!("http://{addr}/doc")),
        )
        .await;

        let probe = Arc::new(ProbeService::new());
        let registry = crate::tasks::TaskRegistry::new();
        probe.refresh_in_background(&registry, &pool, "s1");
        let key = crate::tasks::probe_refresh_task_key("s1");
        assert!(registry.is_running(&key), "spawn 后 registry 应可见");

        // 同键在途再触发：被 registry 拒绝（无害），活跃数不涨
        probe.refresh_in_background(&registry, &pool, "s1");
        assert_eq!(registry.active_count(), 1, "在途同键重探不得重复登记");

        // cancel_all 后任务终止（探测挂起中，唯一出口＝取消链；不依赖
        // 连接拒绝速度）
        registry.cancel_all();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while registry.active_count() > 0 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "任务应感知取消并退出"
            );
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(
            probe.snapshot()[0].status,
            ProbeStatus::Unknown,
            "取消回「未知」，不产「不可达」误报"
        );
        server.abort();
    }

    /// 轮询等待 registry 中指定任务结束（测试辅助，不持锁）。deadline 取
    /// 5s：连接拒绝在本机 loopback 上可慢至 ~2s（安全软件介入 RST 传递），
    /// 2s 会把正常路径误判为挂死；5s 仍足以防真挂死。
    async fn wait_task_finished(registry: &crate::tasks::TaskRegistry, key: &str) {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while registry.is_running(key) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "task did not finish in time"
            );
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    /// ①任务体完成后的回收（headless 直测）：快速失败目标（端口无监听）
    /// 让任务自然终态；已完成残留未清理时，下一次同键触发自行解除重登
    /// （不被残留的 TASK_KEY_EXISTS 挡住），此后 `cleanup_finished` 仍可回收。
    #[tokio::test]
    async fn refresh_in_background_recycles_finished_entry_on_next_trigger() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        service_support::seed_service_with_doc_url(
            &pool,
            "s1",
            "w1",
            "服务A",
            Some("http://127.0.0.1:1/doc"),
        )
        .await;

        let probe = Arc::new(ProbeService::new());
        let registry = crate::tasks::TaskRegistry::new();
        let key = crate::tasks::probe_refresh_task_key("s1");

        // 第一轮：连接拒绝完成（本机 loopback 拒绝可慢至 ~2s，等待见
        // wait_task_finished），写入「不可达」终态；完成后残留保留
        // （不主动 cleanup——正是下一次同键触发的回收场景）
        probe.refresh_in_background(&registry, &pool, "s1");
        wait_task_finished(&registry, &key).await;
        assert_eq!(probe.snapshot()[0].status, ProbeStatus::Unreachable);

        // 第二轮：目标改为相对地址且无 BaseUrl（任务体必写「未知」）。
        // 若被残留挡住（TASK_KEY_EXISTS），状态将停留在「不可达」
        sqlx::query("UPDATE services SET doc_url = '/doc/openapi.json' WHERE id = 's1'")
            .execute(&pool)
            .await
            .unwrap();
        probe.refresh_in_background(&registry, &pool, "s1");
        wait_task_finished(&registry, &key).await;
        assert_eq!(
            probe.snapshot()[0].status,
            ProbeStatus::Unknown,
            "已完成残留不得挡住同键复用（第二轮重探必须执行）"
        );
        assert_eq!(
            registry.cleanup_finished(),
            1,
            "已完成条目应可被 cleanup_finished 回收"
        );
    }

    /// ②兜底超时口径（headless 直测）：对端 accept 后静默不回包 → 兜底
    /// 超时回「未知」而非「不可达」，且不落 checked_at（非终态不记时，
    /// 与取消同口径）。注入短超时直测（生产 60s，测试不等真实值）。
    #[tokio::test]
    async fn hanging_connection_times_out_to_unknown() {
        let pool = memory_pool().await;
        let (addr, server) = spawn_hanging_server().await;
        let probe =
            ProbeService::with_fallback_timeout_for_test(std::time::Duration::from_millis(150));
        let service = Service {
            id: "s1".into(),
            workspace_id: "w1".into(),
            name: "服务A".into(),
            doc_url: Some(format!("http://{addr}/doc")),
            doc_type: crate::domain::service::DOC_TYPE_OPENAPI.to_owned(),
            sort_order: 0,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let status = probe
            .probe_one(&pool, &service, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            status,
            ProbeStatus::Unknown,
            "兜底超时回「未知」，不误报「不可达」"
        );
        let snapshot = probe.snapshot();
        assert_eq!(snapshot[0].status, ProbeStatus::Unknown);
        assert!(
            snapshot[0].checked_at.is_none(),
            "非终态不落时间戳（快照语义保持「未知为 None」）"
        );
        server.abort();
    }
}
