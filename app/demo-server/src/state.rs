//! 内存态：CRUD 种子数据、ID 发号、SSE 活跃连接计数（断开检测观测面）。
//! 重启即重置——演示靶机不持久化任何数据。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::sync::{Arc, Mutex};

/// 演示用户（GET /api/users 家族的响应主体）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, utoipa::ToSchema)]
pub struct User {
    /// 用户 ID（服务端自增发号，创建后随响应返回）
    pub id: u64,
    /// 用户显示名（keyword 子串过滤的命中字段之一）
    pub name: String,
    /// 邮箱地址（keyword 子串过滤的命中字段之一）
    pub email: String,
}

#[derive(Default)]
struct AppInner {
    /// std Mutex 足够：锁内无 await，持有时间恒短
    users: Mutex<Vec<User>>,
    next_id: AtomicU64,
    sse_active: AtomicUsize,
    /// swagger fixture 端点的文档文件路径（None＝端点用编译期内嵌真文档）
    openapi_fixture: Option<PathBuf>,
    /// /api/flaky 剩余故障次数（消费到 0 后端点恢复 200——重试链路素材）
    flaky_pending_failures: AtomicUsize,
}

/// 共享状态：路由层克隆传递，观测面（SSE 活跃计数）供集成测试断言断开检测
#[derive(Clone, Default)]
pub struct AppState {
    inner: Arc<AppInner>,
}

impl AppState {
    pub fn new() -> Self {
        Self::with_seed(None)
    }

    /// 带 swagger fixture 文档路径构造（CLI `--fixture <path>` 入口）：
    /// fixture 端点每请求读该文件，文件可被外部替换
    pub fn with_openapi_fixture(fixture: PathBuf) -> Self {
        Self::with_seed(Some(fixture))
    }

    fn with_seed(fixture: Option<PathBuf>) -> Self {
        // 直接构造 inner 再包 Arc：fixture 路径随构造注入，无需穿透 Arc 改写
        let state = AppState {
            inner: Arc::new(AppInner {
                openapi_fixture: fixture,
                ..AppInner::default()
            }),
        };
        // 种子数据：让 GET /api/users 开箱即有内容
        state.inner.users.lock().unwrap().extend([
            User {
                id: 1,
                name: "Alice".into(),
                email: "alice@example.com".into(),
            },
            User {
                id: 2,
                name: "Bob".into(),
                email: "bob@example.com".into(),
            },
            User {
                id: 3,
                name: "Carol".into(),
                email: "carol@example.com".into(),
            },
        ]);
        state.inner.next_id.store(4, std::sync::atomic::Ordering::SeqCst);
        state
    }

    /// swagger fixture 端点的文档文件路径（None＝内嵌真文档）
    pub fn openapi_fixture_path(&self) -> Option<&std::path::Path> {
        self.inner.openapi_fixture.as_deref()
    }

    pub fn list_users(&self, keyword: Option<&str>) -> Vec<User> {
        let users = self.inner.users.lock().unwrap();
        match keyword {
            // 子串过滤：name / email 命中任一即保留
            Some(k) if !k.is_empty() => users
                .iter()
                .filter(|u| u.name.contains(k) || u.email.contains(k))
                .cloned()
                .collect(),
            _ => users.clone(),
        }
    }

    pub fn get_user(&self, id: u64) -> Option<User> {
        self.inner.users.lock().unwrap().iter().find(|u| u.id == id).cloned()
    }

    pub fn create_user(&self, name: String, email: String) -> User {
        let id = self.inner.next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let user = User { id, name, email };
        self.inner.users.lock().unwrap().push(user.clone());
        user
    }

    /// 更新已存在用户；不存在返回 None（404 语义）
    pub fn update_user(&self, id: u64, name: String, email: String) -> Option<User> {
        let mut users = self.inner.users.lock().unwrap();
        users
            .iter_mut()
            .find(|u| u.id == id)
            .map(|u| {
                u.name = name;
                u.email = email;
                u.clone()
            })
    }

    pub fn delete_user(&self, id: u64) -> bool {
        let mut users = self.inner.users.lock().unwrap();
        let before = users.len();
        users.retain(|u| u.id != id);
        users.len() != before
    }

    /// SSE 连接建立时递增；guard 的 Drop（客户端断开或服务端收尾）递减
    pub(crate) fn sse_connect(&self) -> usize {
        self.inner.sse_active.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
    }

    pub(crate) fn sse_disconnect(&self) -> usize {
        self.inner.sse_active.fetch_sub(1, std::sync::atomic::Ordering::SeqCst) - 1
    }

    /// 当前活跃 SSE 连接数（集成测试断言断开检测的观测面）
    pub fn sse_active_connections(&self) -> usize {
        self.inner.sse_active.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 注入 /api/flaky 的剩余故障次数（工作流重试链路集成测试的布点）
    pub fn set_flaky_failures(&self, count: usize) {
        self.inner
            .flaky_pending_failures
            .store(count, std::sync::atomic::Ordering::SeqCst);
    }

    /// /api/flaky 取一次故障：剩余次数 > 0 时消耗一次并返回 true（请求侧
    /// 挂起到客户端超时），否则返回 false（立即 200）
    pub(crate) fn take_flaky_failure(&self) -> bool {
        self.inner
            .flaky_pending_failures
            .fetch_update(
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
                |pending| (pending > 0).then(|| pending - 1),
            )
            .is_ok()
    }
}
