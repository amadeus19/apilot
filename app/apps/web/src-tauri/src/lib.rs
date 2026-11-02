//! APilot 2.0 Tauri 宿主：builder 组装、插件、状态注入与 IPC 命令注册。
//!
//! 分层：Command（commands/）→ Service（services/）→ Infrastructure（db/）。

mod commands;
// 登记处语义：常量注册即交付（部分在后续阶段才被引用），故 pub 避免误报死代码
pub mod app_context;
pub mod cli;
pub mod constants;
mod db;
// 领域实体与不变量纯函数按登记处语义公开（部分在同步域接入时才被消费）
pub mod domain;
pub mod error;
mod infrastructure;
mod services;
#[cfg(test)]
pub(crate) mod test_support;
mod tasks;

use std::path::Path;

use sqlx::SqlitePool;

use crate::services::settings::SettingsCache;
use error::AppError;

/// 数据库句柄：连接池 + settings 内存缓存。
pub struct Db {
    pub pool: SqlitePool,
    pub cache: SettingsCache,
}

/// 应用状态。DB 初始化失败（如 `DB_CORRUPTED`）**不终止启动**：
/// 错误保存在 `db` 中，窗口照常打开，前端 `get_boot_settings` 拉到错误后
/// 做全屏阻断呈现。
pub struct AppState {
    pub db: Result<Db, AppError>,
    /// 退出闸门：CloseRequested 后等前端收尾（超时兜底放行）
    pub exit_gate: services::exit_gate::ExitGate,
    /// 任务登记处：一切长期运行任务经此 spawn——裸 spawn 禁止
    pub tasks: tasks::TaskRegistry,
    /// HTTP 引擎服务：Client 快照缓存（`http` 设置键写入时重建；boot 侧
    /// 由此处按缓存值构建——GUI 与 CLI 同一构建入口）
    pub http: services::http::HttpService,
    /// 可达性探测服务（进程内存态；事件出口在 GUI 装配，headless 静默）
    pub probe: std::sync::Arc<services::probe::ProbeService>,
    /// 数据目录（Tauri path resolver 权威值）：响应临时文件 `tmp/response/`
    /// 等会话态落盘的根；GUI 侧不经 data_dir 模块（headless 专用）
    pub data_dir: std::path::PathBuf,
    /// 主窗口创建时的 devtools 初值（F12 加速键只认创建时的值，
    /// 经 get_boot_settings 下发前端，供非原生会话启用 F12 通道）
    pub devtools_native: bool,
    /// 待安装更新包：install_update 校验后暂存，退出序列末尾 spawn
    /// （安装器覆盖 exe 必须发生在应用释放文件锁之后）
    pub install_request: std::sync::Mutex<Option<services::update_source::StagedUpdate>>,
}

/// 从 settings 缓存构建 HttpService（boot 侧唯一构建入口，GUI / CLI 共用）：
/// `http` 键缺省取默认设置；脏值降级默认并留痕（不阻断启动）。
pub fn http_service_from_cache(cache: &SettingsCache) -> services::http::HttpService {
    match cache.snapshot().get("http") {
        Some(value) => match services::http::HttpSettings::from_value(value) {
            Ok(settings) => services::http::HttpService::from_settings(settings),
            Err(err) => {
                tracing::warn!(code = %err.code, message = %err.message, "stored http setting invalid, using defaults");
                services::http::HttpService::new()
            }
        },
        None => services::http::HttpService::new(),
    }
}

/// 统一 Shutdown 序列：CloseRequested（含 Alt+F4，
/// Windows 同路触发）→ prevent_close 接管 → 任务排空 + flush 日志 + 关闭
/// 连接池 → 待安装请求 spawn 安装器 → cleanup → 退出码 0。DB 初始化失败的
/// 实例 pool 为空，只走任务清理与日志 flush。
async fn shutdown_and_exit(app: tauri::AppHandle) {
    use tauri::Manager;

    let state: tauri::State<AppState> = app.state();
    let pool = state.db.as_ref().ok().map(|db| &db.pool);
    tasks::shutdown(&state.tasks, pool).await;
    // 响应临时文件随会话清空（Tab 绑定生命周期的进程侧兜底）
    commands::http::sweep_response_tmp(&state.data_dir);
    // 待安装请求在任务排空与连接池关闭之后处理：spawn 后立即退出（官方
    // 顺序）——安装器（NSIS）静默模式下经 Restart Manager 强制关闭仍在
    // 运行的旧进程，等待其退出码不可行；spawn 失败同步留痕，安装中途失败
    // 由意向标记在下轮 boot 扫场感知（一次性反馈）
    let pending = state
        .install_request
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    if let Some(staged) = pending {
        staged.record_attempt();
        if let Err(err) = staged.spawn_installer() {
            tracing::error!(version = staged.version(), code = %err.code, message = %err.message, "update installer spawn failed");
            staged.clear_markers();
            staged.record_failure();
        }
    }
    app.cleanup_before_exit();
    tracing::info!("exiting with code 0");
    app.exit(0);
}

/// 初始化数据库：备份恢复替换链（段一开库前 → 连接 → 完整性校验 → 迁移 →
/// 段二易失表搬回）→ 缓存灌入。
///
/// 替换链失败不阻断启动：段一自身消化为跳过 / 延迟（留痕）；段二失败
/// 留痕并保留旧库与标记，下次启动自动续跑。段二必须在 settings 缓存灌入
/// 前完成——搬回的设置要即时生效。
async fn init_db(app_data_dir: &Path) -> Result<Db, AppError> {
    let pending = services::backup::apply_pending_before_open(app_data_dir).await;
    let pool = db::init_gui(app_data_dir).await?;
    match pending {
        services::backup::PendingRestore::None => {}
        services::backup::PendingRestore::Applied => {
            if let Err(err) = services::backup::carry_volatile_back(&pool, app_data_dir).await {
                tracing::error!(code = %err.code, message = %err.message, "backup volatile carryover failed; will retry on next boot");
            }
        }
        // 两类失败都已由段一消化（跳过＝标记已收敛；延迟＝待下次启动重试），
        // 原库无损，只留痕不阻断启动
        services::backup::PendingRestore::Skipped(err) => {
            tracing::error!(code = %err.code, message = %err.message, "pending backup restore skipped; original database intact");
        }
        services::backup::PendingRestore::Deferred(err) => {
            tracing::error!(code = %err.code, message = %err.message, "pending backup restore deferred to next boot");
        }
    }
    let cache = SettingsCache::default();
    services::settings::load_all(&pool, &cache).await?;
    Ok(Db { pool, cache })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
    .plugin(tauri_plugin_os::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    // 备份恢复暂存后的「立即重启」（relaunch）：不注册则前端调用被 ACL 拒绝
    .plugin(tauri_plugin_process::init())
    .setup(|app| {
      use tauri::Manager;

      // 日志装置先于 DB 初始化（迁移期事件同样进缓冲与文件；级别默认 info，
      // DB 就绪后按 logLevel 设置校正——见下方 setup 尾部）
      let log_dir = app.path().app_log_dir()?;
      services::logging::init(&log_dir);

      let app_data_dir = app.path().app_data_dir()?;
      // setup 钩子是同步的；本地 SQLite 初始化属启动关键路径（毫秒级），
      // 用 block_on 在此完成，保证 get_boot_settings 首调即可用（防闪协议前提）
      let state = tauri::async_runtime::block_on(async {
        let state = init_db(&app_data_dir).await;
        // 首启动 / 删光后自动建「默认工作空间」（单一 seeding 路径；
        // DB 初始化失败的实例跳过——错误呈现已由前端全屏阻断）
        if let Ok(db) = &state
          && let Err(err) = services::workspace::ensure_default(&db.pool).await {
            tracing::error!(code = %err.code, message = %err.message, "default workspace seeding failed");
          }
        state
      });
      if let Err(err) = &state {
        tracing::error!(code = %err.code, message = %err.message, "database init failed");
      }
      // boot 校正收口 settings 服务（键注册表单点）：logLevel 热更与写后
      // 生效共用同一执行面；logDir 切换/搬移/滚动清理在 correct_on_boot 内
      // 收口（恢复默认不搬回的决策在其 migrate 语义内）；目录不可用降级
      // 保持默认，不阻断启动。devMode 的 boot 侧是建窗初值（F12 加速键只认
      // webview 创建时的 AreDevToolsEnabled，运行时切换无效，见
      // services/devtools.rs）；读库失败保持默认目录且门控按关（从紧）
      let devtools_native = match &state {
        Ok(db) => {
          let snapshot = db.cache.snapshot();
          let host = services::settings::AppHost::new(app.handle());
          services::settings::correct_on_boot(&host, &snapshot, &log_dir);
          services::settings::devtools_initial(&snapshot)
        }
        Err(_) => false,
      };
      // 响应临时目录启动扫场（崩溃残留清扫；退出侧同入口）
      commands::http::sweep_response_tmp(&app_data_dir);
      let window_config = app
        .config()
        .app
        .windows
        .first()
        .ok_or("no main window config")?;
      tauri::WebviewWindowBuilder::from_config(app.handle(), window_config)?
        .devtools(devtools_native)
        // 关闭 WebView2 通用自动填充：桌面工具的所有输入框都不应让浏览器
        // 联想已保存表单历史（弹「保存的信息」下拉）或把用户输入存进
        // WebView2 用户数据目录（密码/信用卡自动填充不在其管辖内，
        // 本产品亦无此类表单场景）
        .general_autofill_enabled(false)
        .build()?;
      tracing::info!(devtools_native, "main window created");
      let http_service = match &state {
        // boot 构建：`http` 键已在缓存（DB 失败实例取默认——发送链路本就
        // 被 DB 阻断，Client 只需非空装配）
        Ok(db) => http_service_from_cache(&db.cache),
        Err(_) => services::http::HttpService::new(),
      };
      app.manage(AppState {
        db: state,
        exit_gate: services::exit_gate::ExitGate::default(),
        tasks: tasks::TaskRegistry::new(),
        http: http_service,
        probe: std::sync::Arc::new(services::probe::ProbeService::with_sink(
          services::send::sse_event_sink(app.handle().clone()),
        )),
        data_dir: app_data_dir.clone(),
        devtools_native,
        install_request: std::sync::Mutex::new(None),
      });
      // 日志运行期巡检（registry 常驻任务，shutdown 统一取消）：目录会话内
      // 固定（日志目录切换重启生效），启动期已清过一轮，先睡后清。
      // setup 是同步线程，task spawn 需要 runtime 上下文——经 block_on 进入
      // tauri 全局 runtime（登记本身同步返回，不阻塞）
      let tasks_handle = &app.state::<AppState>().tasks;
      tauri::async_runtime::block_on(async {
        tasks::spawn_log_prune(tasks_handle, log_dir);
        // 可达性探测启动轮：后台一次、有界并发，不阻塞应用启动（DB 就绪
        // 才起；失败静默——探测是尽力事实，失败态留给手动刷新重试）
        tasks::spawn_probe_startup(app.state::<AppState>().clone());
      });
      tracing::info!(version = env!("CARGO_PKG_VERSION"), "apilot started");
      Ok(())
    })
    .on_window_event(|window, event| {
      use tauri::Manager;
      // 关窗统一接管：CloseRequested 与 Alt+F4 同路。
      // Phase 1 单窗口假设：任一窗口关闭即整应用退出；多窗口落地时
      // 需按窗口 label 分流（辅助窗口关闭不应触发 shutdown）
      // prevent_close 后异步执行 shutdown 序列，完成才真正退出
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        use std::time::Duration;

        use tauri::Emitter;

        // 拦截默认销毁：不 prevent_close 则窗口即刻销毁 → ExitRequested →
        // 进程退出与 shutdown 序列竞速（有任务时事件循环必赢，序列失去完成保证）
        api.prevent_close();
        let app = window.app_handle().clone();
        // 退出闸门：给前端一次会话保存 + 草稿 flush 的机会，ack 或超时后放行
        // （重复 CloseRequested 会覆盖闸门发送端，先前等待端随 drop 失效，收敛安全）
        let ack_receiver = {
          let state: tauri::State<AppState> = app.state();
          state.exit_gate.arm()
        };
        let _ = app.emit("app://close-requested", ());
        // 基础设施接线（非业务任务）：不进 registry——shutdown 序列自身
        // 不能依赖被排空的对象。重复 CloseRequested 会并发多个序列，
        // 但 close/cancel/wait/flush/pool.close/exit 全幂等，收敛安全
        tauri::async_runtime::spawn(async move {
          if tokio::time::timeout(
            Duration::from_millis(crate::constants::EXIT_ACK_TIMEOUT_MS),
            ack_receiver,
          )
          .await
          .is_err()
          {
            tracing::warn!("frontend close ack timed out, proceeding with shutdown");
          }
          shutdown_and_exit(app).await;
        });
      }
    })
    .invoke_handler(tauri::generate_handler![
      commands::settings::get_boot_settings,
      commands::settings::set_setting,
      commands::diagnostics::get_diagnostics,
      commands::system::open_log_dir,
      commands::system::check_update_source,
      commands::system::check_updates,
      commands::system::download_update,
      commands::system::install_update,
      commands::system::list_staged_updates,
      commands::system::discard_staged_update,
      commands::system::app_ready_to_exit,
      // CLI（设置「开发者 › 高级」）：PATH 注册 / 注销与状态聚合探测
      commands::cli::register_cli_path,
      commands::cli::unregister_cli_path,
      commands::cli::get_cli_status,
      // 工作台域（26 条，点分命名经 command rename 登记）
      // HTTP 执行域（发送 / 取消 / 关 Tab 清理 / 大响应 range-read /
      // 响应体保存 / SSE 流）
      commands::http::http_send,
      commands::http::http_cancel,
      commands::http::http_tab_closed,
      commands::http::http_read_range,
      commands::http::http_save_response,
      commands::http::sse_start,
      // 历史查询与管理（History 视图、详情 Tab 与删除 / 清空）
      commands::run::run_list,
      commands::run::run_get,
      commands::run::run_delete,
      commands::run::run_clear,
      commands::workspace::workspace_list,
      commands::workspace::workspace_create,
      commands::workspace::workspace_rename,
      commands::workspace::workspace_delete,
      commands::workspace::workspace_set_current,
      commands::workspace::workspace_set_auth,
      commands::workspace::workspace_reorder,
      commands::tree::tree_get,
      commands::service::service_list_by_workspace,
      commands::service::service_create,
      commands::service::service_update,
      commands::service::service_delete,
      commands::service::service_move,
      commands::service::service_move_to,
      // 批量导入（Swashbuckle 入口页发现 → 勾选建服务）
      commands::service::service_import_discover,
      commands::service::service_import_create,
      commands::category::category_create,
      commands::category::category_rename,
      commands::category::category_delete,
      commands::category::category_move,
      commands::category::category_move_to,
      commands::endpoint::endpoint_create_manual,
      commands::endpoint::endpoint_update_manual,
      commands::endpoint::endpoint_delete,
      commands::endpoint::endpoint_set_pinned,
      commands::endpoint::endpoint_move,
      // 接口文档元数据（文档抽屉数据源；同步接口经应用事务写入）
      commands::endpoint::endpoint_doc,
      commands::user_data::user_data_get,
      commands::user_data::user_data_upsert,
      commands::session::session_get,
      commands::session::session_save,
      // 变量域（分类 CRUD / 激活切换 / 变量 CRUD / 生效集合成 / BaseUrl 候选）
      commands::variable::variable_list_categories,
      commands::variable::variable_create_category,
      commands::variable::variable_rename_category,
      commands::variable::variable_delete_category,
      commands::variable::variable_set_active_category,
      commands::variable::variable_move_category,
      commands::variable::variable_list_variables,
      commands::variable::variable_create_variable,
      commands::variable::variable_update_variable,
      commands::variable::variable_rename_variable,
      commands::variable::variable_delete_variable,
      commands::variable::variable_effective,
      commands::variable::variable_list_base_urls,
      commands::variable::variable_add_base_url,
      commands::variable::variable_delete_base_url,
      // 同步域（拉取段：快照双代滚动写入；后续段在此追加）
      commands::sync::sync_fetch,
      commands::sync::sync_fetch_cancel,
      commands::sync::sync_diff,
      commands::sync::sync_apply,
      commands::sync::sync_last_synced,
      // 可达性探测（四态；初始快照＋事件推送，UI 不轮询）
      commands::probe::probe_list,
      commands::probe::probe_refresh_all,
      // 工作流域（编辑模型 CRUD：清单 / 加载 / 新建 / 重命名 / 保存 / 删除；
      // 跨空间粘贴为全新落地＋稳定键解析报告；导出导入共用该解析链）
      commands::workflow::workflow_list,
      commands::workflow::workflow_load,
      commands::workflow::workflow_create,
      commands::workflow::workflow_paste,
      commands::workflow::workflow_export,
      commands::workflow::workflow_import,
      commands::workflow::workflow_rename,
      commands::workflow::workflow_save,
      commands::workflow::workflow_delete,
      commands::workflow::workflow_group_list,
      commands::workflow::workflow_group_create,
      commands::workflow::workflow_group_rename,
      commands::workflow::workflow_group_delete,
      commands::workflow::workflow_set_group,
      commands::workflow::workflow_move,
      commands::workflow::workflow_group_move,
      commands::workflow::workflow_execute,
      commands::workflow::workflow_cancel,
      commands::workflow::workflow_last_execution,
      commands::workflow::workflow_validate,
      commands::workflow::workflow_endpoint_usage,
      // 备份域（手动导出 / 恢复：一次性 IPC 动作，非长任务）
      commands::backup::backup_export,
      commands::backup::backup_validate,
      commands::backup::backup_restore,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|_app, event| {
      // Shutdown 序列之外的兜底：事件循环退出（Exit）时确保缓冲日志落盘
      // （幂等；Rust static 项退出不运行 Drop，显式 flush 是唯一保证）
      if let tauri::RunEvent::Exit = event {
        services::logging::shutdown_flush();
      }
    });
}
