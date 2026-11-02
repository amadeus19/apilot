//! 端到端集成测试：子进程调起真实 `apilot` 二进制。
//!
//! 数据经 `APILOT_DATA_DIR` 注入临时目录——测试永不触碰生产数据目录；
//! GUI 全程未运行：Mode B（直连 SQLite）的完整装配链在子进程内兑现。
//! 不变式在此验收：--json 模式命令执行面 stdout 恒为合法 JSON 或空
//! （元路径 `--help` / `--version` / 裸调用属人类帮助面，不受此约束）。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::{Command, Output};

use app_lib::app_context::AppContext;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("apilot2-cli-e2e-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 调起真实二进制（数据目录注入）。
fn run_cli(args: &[&str], data_dir: &PathBuf) -> Output {
    Command::new(env!("CARGO_BIN_EXE_apilot"))
        .args(args)
        .env("APILOT_DATA_DIR", data_dir)
        .output()
        .expect("apilot binary must spawn")
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

fn exit_code(out: &Output) -> i32 {
    out.status.code().expect("process must exit normally")
}

/// stdout 合法 JSON 或空（--json 纯净性不变式）。
fn assert_stdout_is_json_or_empty(out: &Output) -> Option<serde_json::Value> {
    let text = stdout(out).trim().to_owned();
    if text.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(&text)
        .unwrap_or_else(|err| panic!("stdout 非合法 JSON: {err}\n{text}"));
    Some(value)
}

/// 种子数据（GUI 未运行，库由测试进程装配后交给子进程独占）：
/// 服务A（GET /users＋用户数据、POST /orders）＋服务B（同名稳定键撞车）。
async fn seeded_dir(tag: &str) -> PathBuf {
    let dir = temp_dir(tag);
    let ctx = AppContext::new(dir.clone()).await.unwrap();
    let pool = &ctx.db.pool;
    let (ws,): (String,) = sqlx::query_as("SELECT id FROM workspaces LIMIT 1")
        .fetch_one(pool)
        .await
        .unwrap();

    for (id, name) in [("s1", "服务A"), ("s2", "服务B")] {
        sqlx::query(
            "INSERT INTO services (id, workspace_id, name, doc_url, doc_type, sort_order, created_at, updated_at) \
             VALUES (?, ?, ?, NULL, 'openapi', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(id)
        .bind(&ws)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    }
    let endpoints = [
        (
            "s1",
            "GET /users",
            "用户列表",
            r#"{"method":"GET","path_template":"/users"}"#,
        ),
        (
            "s1",
            "POST /orders",
            "创建订单",
            r#"{"method":"POST","path_template":"/orders"}"#,
        ),
        (
            "s2",
            "GET /users",
            "他服务同名",
            r#"{"method":"GET","path_template":"/users"}"#,
        ),
    ];
    for (service_id, key, title, definition) in endpoints {
        sqlx::query(
            "INSERT INTO endpoints (service_id, key, title, category_id, definition, created_at, badge, sort_order) \
             VALUES (?, ?, ?, NULL, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, 0)",
        )
        .bind(service_id)
        .bind(key)
        .bind(title)
        .bind(definition)
        .execute(pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO endpoint_user_data (service_id, key, body, params, headers, updated_at) \
         VALUES ('s1', 'GET /users', '{\"a\":1}', '[{\"name\":\"page\",\"value\":\"1\"}]', \
         '[{\"name\":\"Authorization\",\"value\":\"Bearer tok\"},{\"name\":\"Accept\",\"value\":\"application/json\"}]', \
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .execute(pool)
    .await
    .unwrap();
    ctx.db.pool.close().await;
    dir
}

#[tokio::test]
async fn version_prints_shared_crate_version() {
    let dir = temp_dir("version");
    let out = run_cli(&["--version"], &dir);
    assert_eq!(exit_code(&out), 0);
    assert_eq!(
        stdout(&out),
        format!("apilot {}\n", env!("CARGO_PKG_VERSION")),
        "与 GUI 同 crate 同源"
    );
}

#[tokio::test]
async fn help_lists_commands_and_json_flag() {
    let dir = temp_dir("help");
    let out = run_cli(&["--help"], &dir);
    assert_eq!(exit_code(&out), 0);
    let text = stdout(&out);
    for needle in ["project", "api", "workflow", "run", "--json"] {
        assert!(text.contains(needle), "--help 缺 {needle}");
    }
    // 嵌套命令按各自层级出现（clap 原生分层用法）
    let api_help = run_cli(&["api", "--help"], &dir);
    assert_eq!(exit_code(&api_help), 0);
    let api_text = stdout(&api_help);
    for needle in ["list", "search", "get", "run"] {
        assert!(api_text.contains(needle), "api --help 缺 {needle}");
    }
    let project_help = run_cli(&["project", "--help"], &dir);
    assert_eq!(exit_code(&project_help), 0);
    assert!(
        stdout(&project_help).contains("info"),
        "project --help 缺 info"
    );
    let workflow_help = run_cli(&["workflow", "--help"], &dir);
    assert_eq!(exit_code(&workflow_help), 0);
    let workflow_text = stdout(&workflow_help);
    for needle in ["list", "get", "validate", "run"] {
        assert!(
            workflow_text.contains(needle),
            "workflow --help 缺 {needle}"
        );
    }
    // run 组＝工作流执行状态查询，仅 status（get/result/list 历史查询已下架）
    let run_help = run_cli(&["run", "--help"], &dir);
    assert_eq!(exit_code(&run_help), 0);
    let run_text = stdout(&run_help);
    assert!(
        run_text.contains("status"),
        "run --help 缺 status：{run_text}"
    );
    assert!(
        !run_text.contains("get") && !run_text.contains("result") && !run_text.contains("list"),
        "run 组不得残留已下架子命令：{run_text}"
    );
}

#[tokio::test]
async fn project_info_json_envelope() {
    let dir = seeded_dir("info").await;
    let out = run_cli(&["project", "info", "--json"], &dir);
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(value["success"], serde_json::Value::Bool(true));
    assert_eq!(value["data"]["name"], "默认工作空间");
    assert!(value["data"]["base_url"].is_null());
    assert_eq!(value["data"]["apis"], 3);
    assert_eq!(value["data"]["workflows"], 0, "占位计数");
    assert_eq!(value["data"]["environments"], 0, "占位计数");
    assert!(
        value["data"].get("path").is_none(),
        "无 path 字段（逻辑容器）"
    );
}

#[tokio::test]
async fn api_list_json_tree_order_and_service_column() {
    let dir = seeded_dir("list").await;
    let out = run_cli(&["--json", "api", "list"], &dir);
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    let items = value["data"].as_array().expect("data 即数组");
    assert_eq!(items.len(), 3);
    // 树遍历序：服务A（GET /users → POST /orders）→ 服务B
    assert_eq!(items[0]["id"], "GET /users");
    assert_eq!(items[0]["service"], "服务A");
    assert_eq!(items[1]["id"], "POST /orders");
    assert_eq!(items[2]["id"], "GET /users");
    assert_eq!(items[2]["service"], "服务B");
    assert_eq!(items[0]["category"], serde_json::Value::Null, "散层无分类");
    assert_eq!(
        items[0]["pinned"],
        serde_json::Value::Bool(false),
        "pinned 字段输出（数据序不提升）"
    );
}

#[tokio::test]
async fn api_list_on_fresh_db_returns_empty_array_exit_0() {
    let dir = temp_dir("list-empty");
    let out = run_cli(&["api", "list", "--json"], &dir);
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(value["data"].as_array().unwrap().len(), 0, "空库＝data:[]");
}

#[tokio::test]
async fn api_list_human_table() {
    let dir = seeded_dir("list-human").await;
    let out = run_cli(&["api", "list"], &dir);
    assert_eq!(exit_code(&out), 0);
    let text = stdout(&out);
    assert!(text.starts_with("ID "), "Human＝无边框四列表格：{text}");
    for needle in ["GET /users", "POST /orders", "服务A", "服务B"] {
        assert!(text.contains(needle), "缺 {needle}");
    }
    // Human 成功路径 stdout 纯净性：恰＝表头＋三数据行，无任何其他输出
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(
        lines.len(),
        4,
        "Human 成功输出不得混入表格之外的内容：{text}"
    );
    assert!(
        lines[3].starts_with("GET /users"),
        "末行＝第三数据行（服务B）"
    );
    assert!(
        !text.ends_with('\n') || text.lines().count() == 4,
        "无尾随空行"
    );
}

#[tokio::test]
async fn api_search_json_hits_and_empty_success() {
    let dir = seeded_dir("search").await;
    let out = run_cli(&["api", "search", "用户", "--json"], &dir);
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    let items = value["data"].as_array().unwrap();
    assert_eq!(items.len(), 1, "标题「用户列表」命中");
    assert_eq!(items[0]["id"], "GET /users");

    // 零命中＝成功空集（exit 0）
    let out = run_cli(&["api", "search", "不存在的关键词", "--json"], &dir);
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(value["data"].as_array().unwrap().len(), 0);

    // 空/纯空白关键词＝INVALID_ARGUMENT（exit 2，脚本缺陷 fail-fast）
    for keyword in ["", "   "] {
        let out = run_cli(&["api", "search", keyword, "--json"], &dir);
        assert_eq!(exit_code(&out), 2, "keyword={keyword:?}");
        let value = assert_stdout_is_json_or_empty(&out).expect("错误包络在 stdout");
        assert_eq!(value["error"]["code"], "INVALID_ARGUMENT");
    }
}

#[tokio::test]
async fn api_get_json_structured_and_redacted() {
    let dir = seeded_dir("get").await;
    let out = run_cli(
        &["api", "get", "GET /users", "--service", "服务A", "--json"],
        &dir,
    );
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    let data = &value["data"];
    assert_eq!(data["id"], "GET /users");
    assert_eq!(data["name"], "用户列表");
    assert_eq!(data["method"], "GET");
    assert_eq!(data["path"], "/users");
    assert_eq!(data["service"], "服务A");
    assert_eq!(data["category"], serde_json::Value::Null);
    assert_eq!(
        data["manual"],
        serde_json::Value::Bool(false),
        "稳定键＝同步来源"
    );
    assert_eq!(data["params"][0]["name"], "page", "params 结构化");
    assert_eq!(data["headers"][0]["value"], "***", "敏感头值掩码");
    assert_eq!(
        data["headers"][1]["value"], "application/json",
        "非敏感头放行"
    );
    assert_eq!(
        data["body"],
        serde_json::json!("{\"a\":1}"),
        "body 原样字符串，不猜测 JSON"
    );

    // --show-secrets 放行
    let out = run_cli(
        &[
            "api",
            "get",
            "GET /users",
            "--service",
            "服务A",
            "--show-secrets",
            "--json",
        ],
        &dir,
    );
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(value["data"]["headers"][0]["value"], "Bearer tok");
}

#[tokio::test]
async fn api_get_not_found_and_ambiguous_exit_3_with_json_envelope() {
    let dir = seeded_dir("get-err").await;
    // 未命中：exit 3＋错误包络走 stdout（JSON 模式）
    let out = run_cli(&["api", "get", "GET /nope", "--json"], &dir);
    assert_eq!(exit_code(&out), 3);
    let value = assert_stdout_is_json_or_empty(&out).expect("错误包络在 stdout");
    assert_eq!(value["success"], serde_json::Value::Bool(false));
    assert_eq!(value["error"]["code"], "ENDPOINT_NOT_FOUND");

    // Human 模式：错误文本走 stderr，stdout 为空
    let out = run_cli(&["api", "get", "GET /nope"], &dir);
    assert_eq!(exit_code(&out), 3);
    assert!(stdout(&out).is_empty(), "Human 错误不得污染 stdout");
    assert!(stderr(&out).contains("ENDPOINT_NOT_FOUND"));

    // 跨服务撞车未消歧：exit 3＋候选清单
    let out = run_cli(&["api", "get", "GET /users", "--json"], &dir);
    assert_eq!(exit_code(&out), 3);
    let value = assert_stdout_is_json_or_empty(&out).expect("错误包络在 stdout");
    assert_eq!(value["error"]["code"], "ENDPOINT_AMBIGUOUS");
    let candidates = value["error"]["details"]["candidates"].as_array().unwrap();
    assert_eq!(candidates.len(), 2);
    assert_eq!(candidates[0]["service"], "服务A");

    // --service 消歧成功
    let out = run_cli(
        &["api", "get", "GET /users", "--service", "服务B", "--json"],
        &dir,
    );
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(value["data"]["service"], "服务B");

    // --service 零命中：SERVICE_NOT_FOUND
    let out = run_cli(
        &["api", "get", "GET /users", "--service", "不存在", "--json"],
        &dir,
    );
    assert_eq!(exit_code(&out), 3);
    let value = assert_stdout_is_json_or_empty(&out).expect("错误包络在 stdout");
    assert_eq!(value["error"]["code"], "SERVICE_NOT_FOUND");
}

#[tokio::test]
async fn json_purity_across_success_and_error_paths() {
    let dir = seeded_dir("purity").await;
    // 成功与失败全路径：--json 模式 stdout 恒为合法 JSON 或空
    for args in [
        vec!["project", "info", "--json"],
        vec!["api", "list", "--json"],
        vec!["api", "search", "用户", "--json"],
        vec!["api", "get", "GET /users", "--json"],
        vec!["api", "get", "GET /nope", "--json"],
        vec!["api", "get", "GET /nope", "--show-secrets", "--json"],
    ] {
        let out = run_cli(&args, &dir);
        assert_stdout_is_json_or_empty(&out);
        // stderr 在 JSON 模式下也不得承载包络（错误包络走 stdout）
        if exit_code(&out) != 0 {
            assert!(
                !stderr(&out).contains("\"success\""),
                "JSON 模式错误包络误走 stderr：{:?}",
                args
            );
        }
    }
}

// —— api run 与 run 命令组（执行域，对进程内靶机实发）——
//
// 本区测试一律 multi_thread flavor：`#[tokio::test]` 默认 current_thread，
// 测试线程被 `Command::output()` 同步阻塞期间 runtime 无法调度靶机的
// serve 任务——子进程请求进内核 backlog 后无人 accept，双方互等死锁。

/// api run E2E 种子：workspace base_url 指向靶机地址，接口路径对齐靶机路由。
/// `GET /api/users` 用户数据带敏感头（脱敏 grep 素材）＋ query 分页参数；
/// `GET /api/error/{status}` 供 --param 覆写出 4xx/5xx；
/// `GET /api/slow` 接口级 timeout_seconds=1（靶机默认延迟 5 秒 → 必超时）。
async fn seeded_run_dir(tag: &str, base_url: &str) -> PathBuf {
    let dir = temp_dir(tag);
    let ctx = AppContext::new(dir.clone()).await.unwrap();
    let pool = &ctx.db.pool;
    let (ws,): (String,) = sqlx::query_as("SELECT id FROM workspaces LIMIT 1")
        .fetch_one(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE workspaces SET base_url = ? WHERE id = ?")
        .bind(base_url)
        .bind(&ws)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO services (id, workspace_id, name, doc_url, doc_type, sort_order, created_at, updated_at) \
         VALUES ('s1', ?, '靶机', NULL, 'openapi', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .bind(&ws)
    .execute(pool)
    .await
    .unwrap();
    let endpoints = [
        (
            "GET /api/users",
            "用户列表",
            r#"{"method":"GET","path_template":"/api/users"}"#,
        ),
        (
            "GET /api/error/{status}",
            "错误样本",
            r#"{"method":"GET","path_template":"/api/error/{status}"}"#,
        ),
        (
            "GET /api/slow",
            "慢速端点",
            r#"{"method":"GET","path_template":"/api/slow"}"#,
        ),
    ];
    for (key, title, definition) in endpoints {
        sqlx::query(
            "INSERT INTO endpoints (service_id, key, title, category_id, definition, created_at, badge, sort_order) \
             VALUES ('s1', ?, ?, NULL, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, 0)",
        )
        .bind(key)
        .bind(title)
        .bind(definition)
        .execute(pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO endpoint_user_data (service_id, key, body, params, headers, updated_at) \
         VALUES ('s1', 'GET /api/users', NULL, '[{\"name\":\"page\",\"value\":\"1\"}]', \
         '[{\"name\":\"Authorization\",\"value\":\"Bearer run-e2e-secret-token\"}]', \
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO endpoint_user_data (service_id, key, body, params, headers, timeout_seconds, updated_at) \
         VALUES ('s1', 'GET /api/slow', NULL, '[]', '[]', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .execute(pool)
    .await
    .unwrap();
    ctx.db.pool.close().await;
    dir
}

#[tokio::test(flavor = "multi_thread")]
async fn api_run_success_redacts_and_takes_overrides() {
    let server = demo_server::spawn_ephemeral().await.unwrap();
    let dir = seeded_run_dir("run-ok", &server.base_url()).await;

    let out = run_cli(
        &[
            "api",
            "run",
            "GET /api/users",
            "--query",
            "page=2",
            "--json",
        ],
        &dir,
    );
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(value["success"], serde_json::Value::Bool(true));
    let run_id = value["runId"].as_str().expect("runId 恒在").to_owned();
    assert!(run_id.starts_with("run_"), "run_<ULID> 形态：{run_id}");
    assert_eq!(value["request"]["method"], "GET");
    assert!(
        value["request"]["url"].as_str().unwrap().contains("page=2"),
        "--query 覆写生效"
    );
    let headers = value["request"]["headers"].as_array().unwrap();
    let auth = headers
        .iter()
        .find(|h| h["name"] == "Authorization")
        .expect("敏感头在快照");
    assert_eq!(auth["value"], "***", "Authorization 掩码");
    assert_eq!(value["response"]["status"], 200);
    assert_eq!(
        value["extracted"],
        serde_json::json!({}),
        "预留位恒在（schema 稳定）"
    );
    assert_eq!(value["assertions"], serde_json::json!([]));
    assert!(
        !stdout(&out).contains("run-e2e-secret-token"),
        "默认脱敏：token 不得明文外泄"
    );

    // --show-secrets 放行
    let out = run_cli(
        &["api", "run", "GET /api/users", "--show-secrets", "--json"],
        &dir,
    );
    assert_eq!(exit_code(&out), 0);
    assert!(
        stdout(&out).contains("run-e2e-secret-token"),
        "放行后明文可见"
    );

    // Human 模式同样默认脱敏
    let out = run_cli(&["api", "run", "GET /api/users"], &dir);
    assert_eq!(exit_code(&out), 0);
    assert!(
        !stdout(&out).contains("run-e2e-secret-token"),
        "Human 默认脱敏"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn api_run_4xx_and_5xx_are_execution_success_exit_0() {
    let server = demo_server::spawn_ephemeral().await.unwrap();
    let dir = seeded_run_dir("run-status", &server.base_url()).await;
    for (status, code) in [("404", 404), ("503", 503)] {
        let flag = format!("status={status}");
        let out = run_cli(
            &[
                "api",
                "run",
                "GET /api/error/{status}",
                "--param",
                &flag,
                "--json",
            ],
            &dir,
        );
        assert_eq!(
            exit_code(&out),
            0,
            "{status} 也是执行成功（成败判定交消费者）"
        );
        let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
        assert_eq!(value["success"], serde_json::Value::Bool(true));
        assert_eq!(value["response"]["status"], code, "--param 占位符覆写生效");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn api_run_timeout_maps_to_exit_4() {
    let server = demo_server::spawn_ephemeral().await.unwrap();
    let dir = seeded_run_dir("run-timeout", &server.base_url()).await;
    let out = run_cli(&["api", "run", "GET /api/slow", "--json"], &dir);
    assert_eq!(exit_code(&out), 4);
    let value = assert_stdout_is_json_or_empty(&out).expect("错误包络在 stdout");
    assert_eq!(
        value["error"]["code"], "TIMEOUT",
        "超时归 failed 终态 error_code=TIMEOUT"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn api_run_transport_failure_maps_to_exit_4() {
    let server = demo_server::spawn_ephemeral().await.unwrap();
    // base_url 指向特权死端口（无监听）：连接拒绝 → HTTP_REQUEST_FAILED
    let dir = seeded_run_dir("run-dead", "http://127.0.0.1:1").await;
    let _ = server; // 靶机仅对齐种子形态；本测试不需要存活靶机
    let out = run_cli(&["api", "run", "GET /api/users", "--json"], &dir);
    assert_eq!(exit_code(&out), 4);
    let value = assert_stdout_is_json_or_empty(&out).expect("错误包络在 stdout");
    assert_eq!(value["error"]["code"], "HTTP_REQUEST_FAILED");
}

#[tokio::test(flavor = "multi_thread")]
async fn api_run_usage_and_lookup_errors() {
    let server = demo_server::spawn_ephemeral().await.unwrap();
    let dir = seeded_run_dir("run-usage", &server.base_url()).await;

    // 接口不存在 → exit 3
    let out = run_cli(&["api", "run", "GET /nope", "--json"], &dir);
    assert_eq!(exit_code(&out), 3);
    let value = assert_stdout_is_json_or_empty(&out).expect("错误包络在 stdout");
    assert_eq!(value["error"]["code"], "ENDPOINT_NOT_FOUND");

    // --env 旗标已移除 → clap 用法错误 exit 2（错误走 stderr，stdout 保持空）
    let out = run_cli(
        &["api", "run", "GET /api/users", "--env", "dev", "--json"],
        &dir,
    );
    assert_eq!(exit_code(&out), 2);
    assert!(
        stdout(&out).is_empty(),
        "用法错误不进 stdout（JSON 纯净性）"
    );
    assert!(stderr(&out).contains("--env"), "stderr 须指认未知旗标");

    // K=V 形态错误 → exit 2 INVALID_ARGUMENT
    let out = run_cli(
        &["api", "run", "GET /api/users", "--query", "page", "--json"],
        &dir,
    );
    assert_eq!(exit_code(&out), 2);
    let value = assert_stdout_is_json_or_empty(&out).expect("错误包络在 stdout");
    assert_eq!(value["error"]["code"], "INVALID_ARGUMENT");
}

/// 裁剪回归：run 历史查询组已下架（Run Record 查询归 GUI History），
/// 越界子命令为 clap 用法错误——exit 2、错误走 stderr、stdout 保持空
/// （--json 纯净性不变式的空侧）。clap 错误发生在装配前，无需种子数据。
#[test]
fn pruned_run_group_returns_clap_usage_error() {
    let dir = temp_dir("pruned-run");
    for args in [
        vec!["run", "list"],
        vec!["run", "get", "run_x"],
        vec!["run", "result", "run_x"],
    ] {
        let out = run_cli(&args, &dir);
        assert_eq!(exit_code(&out), 2, "{args:?}");
        assert!(stdout(&out).is_empty(), "用法错误不进 stdout：{args:?}");
        assert!(
            stderr(&out).contains("run"),
            "stderr 须指认未知子命令：{args:?}"
        );
    }
}

// —— workflow 命令组（list / get / validate / run + run status）——

/// 登录链图（对靶机）：Start → 登录请求 → 提取节点两条规则（$.token 产物
/// token、$.tokenType 产物 tokenType）→ 带 `{{token}}` 产物引用的受保护
/// 请求（URL query 携带 Secret 消费值＝掩码面）与 `{{tokenType}}` 第二产物
/// 引用 → 状态码断言 → End。me 的直接上游是提取节点，产物在连线作用域内
/// 可见（裸键解析）。
fn login_chain_graph() -> String {
    serde_json::json!({
        "schemaVersion": 1,
        "nodes": [
            { "id": "start", "name": "", "position": {"x": 0.0, "y": 0.0}, "config": {"type": "start"} },
            { "id": "login", "name": "登录", "position": {"x": 1.0, "y": 0.0},
              "config": { "type": "request", "endpointKey": "POST /auth/login",
                "query": [],
                "body": "{\"username\":\"admin\",\"password\":\"123456\"}" } },
            { "id": "extract", "name": "提取", "position": {"x": 2.0, "y": 0.0},
              "config": { "type": "extract", "source": "jsonPath",
                "rules": [ {"path": "$.token", "name": "token"}, {"path": "$.tokenType", "name": "tokenType"} ] } },
            { "id": "me", "name": "查询", "position": {"x": 3.0, "y": 0.0},
              "config": { "type": "request", "endpointKey": "GET /auth/me",
                "query": [{"name": "token", "value": "{{token}}"},
                          {"name": "tokenType", "value": "{{tokenType}}"}] } },
            { "id": "assert", "name": "断言", "position": {"x": 4.0, "y": 0.0},
              "config": { "type": "assert", "rules": [{"type": "statusCode", "expected": "200"}] } },
            { "id": "end", "name": "", "position": {"x": 5.0, "y": 0.0}, "config": {"type": "end"} }
        ],
        "edges": [
            {"id": "e0", "source": "start", "target": "login", "label": null},
            {"id": "e1", "source": "login", "target": "extract", "label": null},
            {"id": "e2", "source": "extract", "target": "me", "label": null},
            {"id": "e3", "source": "me", "target": "assert", "label": null},
            {"id": "e4", "source": "assert", "target": "end", "label": null}
        ]
    })
    .to_string()
}

/// 断言必败图（失败路径靶）：Start → 登录请求 → 期望 418 的状态码断言 → End。
fn failing_assert_graph() -> String {
    serde_json::json!({
        "schemaVersion": 1,
        "nodes": [
            { "id": "start", "name": "", "position": {"x": 0.0, "y": 0.0}, "config": {"type": "start"} },
            { "id": "login", "name": "登录", "position": {"x": 1.0, "y": 0.0},
              "config": { "type": "request", "endpointKey": "POST /auth/login",
                "query": [], "body": "{\"username\":\"admin\",\"password\":\"123456\"}" } },
            { "id": "assert", "name": "断言", "position": {"x": 2.0, "y": 0.0},
              "config": { "type": "assert", "rules": [{"type": "statusCode", "expected": "418"}] } },
            { "id": "end", "name": "", "position": {"x": 3.0, "y": 0.0}, "config": {"type": "end"} }
        ],
        "edges": [
            {"id": "e0", "source": "start", "target": "login", "label": null},
            {"id": "e1", "source": "login", "target": "assert", "label": null},
            {"id": "e2", "source": "assert", "target": "end", "label": null}
        ]
    })
    .to_string()
}

/// 无 Start 的坏图（校验清单靶）：孤立未绑定请求节点。
fn broken_graph() -> String {
    serde_json::json!({
        "schemaVersion": 1,
        "nodes": [
            { "id": "n0", "name": "悬空", "position": {"x": 0.0, "y": 0.0},
              "config": { "type": "request", "query": [] } }
        ],
        "edges": []
    })
    .to_string()
}

/// 宽松引用图（引用放行靶）：条件表达式引用的键在其直接上游（Start，不
/// 产出任何键）无产出者——静态不判（可能是普通变量或运行时缺失语义），
/// 校验放行：valid=true、issues 空，运行时按既有变量缺失语义求值。
fn loose_reference_graph() -> String {
    serde_json::json!({
        "schemaVersion": 1,
        "nodes": [
            { "id": "start", "name": "", "position": {"x": 0.0, "y": 0.0}, "config": {"type": "start"} },
            { "id": "cond", "name": "条件", "position": {"x": 1.0, "y": 0.0},
              "config": { "type": "condition",
                "branches": [{"id": "b0", "expression": "{{ghost.status}} == 200"}] } },
            { "id": "end", "name": "", "position": {"x": 2.0, "y": 0.0}, "config": {"type": "end"} }
        ],
        "edges": [
            {"id": "e0", "source": "start", "target": "cond", "label": null},
            {"id": "e1", "source": "cond", "target": "end", "label": "b0"},
            {"id": "e2", "source": "cond", "target": "end", "label": "DEFAULT"}
        ]
    })
    .to_string()
}

/// 带敏感覆写头的图（get 脱敏靶）：Authorization 覆写行硬编码凭据形态值。
fn sensitive_override_graph() -> String {
    serde_json::json!({
        "schemaVersion": 1,
        "nodes": [
            { "id": "start", "name": "", "position": {"x": 0.0, "y": 0.0}, "config": {"type": "start"} },
            { "id": "n0", "name": "调用", "position": {"x": 1.0, "y": 0.0},
              "config": { "type": "request", "endpointKey": "GET /auth/me",
                "query": [
                  {"name": "Authorization", "value": "Bearer get-e2e-credential"},
                  {"name": "Accept", "value": "application/json"}
                ] } },
            { "id": "end", "name": "", "position": {"x": 2.0, "y": 0.0}, "config": {"type": "end"} }
        ],
        "edges": [
            {"id": "e0", "source": "start", "target": "n0", "label": null},
            {"id": "e1", "source": "n0", "target": "end", "label": null}
        ]
    })
    .to_string()
}

/// 工作流种子目录：靶机 BaseUrl＋登录链端点＋三条工作流（登录链 / 必败断言 /
/// 坏图）＋敏感覆写头工作流。GUI 未运行，库由测试进程装配后交给子进程独占。
async fn seeded_workflow_dir(tag: &str, base_url: &str) -> PathBuf {
    let dir = temp_dir(tag);
    let ctx = AppContext::new(dir.clone()).await.unwrap();
    let pool = &ctx.db.pool;
    let (ws,): (String,) = sqlx::query_as("SELECT id FROM workspaces LIMIT 1")
        .fetch_one(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE workspaces SET base_url = ? WHERE id = ?")
        .bind(base_url)
        .bind(&ws)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO services (id, workspace_id, name, doc_url, doc_type, sort_order, created_at, updated_at) \
         VALUES ('s1', ?, '靶机', NULL, 'openapi', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .bind(&ws)
    .execute(pool)
    .await
    .unwrap();
    let endpoints = [
        (
            "POST /auth/login",
            "登录",
            r#"{"method":"POST","path_template":"/auth/login"}"#,
        ),
        (
            "GET /auth/me",
            "当前登录信息",
            r#"{"method":"GET","path_template":"/auth/me"}"#,
        ),
    ];
    for (key, title, definition) in endpoints {
        sqlx::query(
            "INSERT INTO endpoints (service_id, key, title, category_id, definition, created_at, badge, sort_order) \
             VALUES ('s1', ?, ?, NULL, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, 0)",
        )
        .bind(key)
        .bind(title)
        .bind(definition)
        .execute(pool)
        .await
        .unwrap();
    }
    // 受保护接口的授权头由接口用户数据承担（节点头覆写已取消），值携带
    // {{token}} 产物引用——执行期随变量解析链点亮
    sqlx::query(
        "INSERT INTO endpoint_user_data (service_id, key, body, params, headers, updated_at) \
         VALUES ('s1', 'GET /auth/me', NULL, '[]', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .bind(r#"[{"name":"Authorization","value":"Bearer {{token}}"}]"#)
    .execute(pool)
    .await
    .unwrap();
    let workflows = [
        ("wf_login", "登录链", login_chain_graph()),
        ("wf_failing", "必败断言", failing_assert_graph()),
        ("wf_broken", "坏图", broken_graph()),
        ("wf_sensitive", "敏感覆写", sensitive_override_graph()),
        ("wf_loose", "宽松引用", loose_reference_graph()),
    ];
    for (id, name, graph) in workflows {
        sqlx::query(
            "INSERT INTO workflows (id, workspace_id, name, graph, created_at, updated_at) \
             VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(id)
        .bind(&ws)
        .bind(name)
        .bind(graph)
        .execute(pool)
        .await
        .unwrap();
    }
    ctx.db.pool.close().await;
    dir
}

#[tokio::test]
async fn workflow_list_json_and_human_table() {
    let server = demo_server::spawn_ephemeral().await.unwrap();
    let dir = seeded_workflow_dir("wf-list", &server.base_url()).await;

    let out = run_cli(&["workflow", "list", "--json"], &dir);
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(value["success"], serde_json::Value::Bool(true));
    let items = value["data"]["items"].as_array().expect("items 数组");
    assert_eq!(items.len(), 5, "五条种子工作流");
    let broken = items
        .iter()
        .find(|item| item["id"] == "wf_broken")
        .expect("清单含坏图");
    assert_eq!(broken["name"], "坏图");
    assert!(
        broken["updatedAt"].is_string(),
        "清单行含 updatedAt（契约字段）"
    );

    // Human：表头＋行（空表＝表头也在）
    let out = run_cli(&["workflow", "list"], &dir);
    assert_eq!(exit_code(&out), 0);
    let text = stdout(&out);
    assert!(text.contains("ID"), "表头在: {text}");
    assert!(text.contains("NAME"), "表头在: {text}");
    assert!(text.contains("登录链"), "行在: {text}");
}

#[tokio::test]
async fn workflow_get_masks_sensitive_override_rows_and_reveals_with_flag() {
    let server = demo_server::spawn_ephemeral().await.unwrap();
    let dir = seeded_workflow_dir("wf-get", &server.base_url()).await;

    // 默认脱敏：Authorization 覆写行值掩码；Accept 行与结构字段原样
    let out = run_cli(&["workflow", "get", "wf_sensitive", "--json"], &dir);
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(value["success"], serde_json::Value::Bool(true));
    assert_eq!(value["data"]["id"], "wf_sensitive");
    assert!(
        value["data"]["graph"]["nodes"].is_array(),
        "graph 结构化输出（契约形态）"
    );
    let rows = value["data"]["graph"]["nodes"][1]["config"]["query"]
        .as_array()
        .expect("覆写行");
    assert_eq!(rows[0]["name"], "Authorization");
    assert_eq!(rows[0]["value"], "***", "敏感名单覆写行默认掩码");
    assert_eq!(rows[1]["value"], "application/json", "非名单行原样");
    assert!(
        !stdout(&out).contains("get-e2e-credential"),
        "凭据形态值不得明文外泄"
    );

    // --show-secrets 放行
    let out = run_cli(
        &[
            "workflow",
            "get",
            "wf_sensitive",
            "--show-secrets",
            "--json",
        ],
        &dir,
    );
    assert_eq!(exit_code(&out), 0);
    assert!(
        stdout(&out).contains("get-e2e-credential"),
        "放行后明文可见"
    );

    // not found → exit 3 稳定错误码
    let out = run_cli(&["workflow", "get", "wf_missing", "--json"], &dir);
    assert_eq!(exit_code(&out), 3);
    let value = assert_stdout_is_json_or_empty(&out).expect("错误包络在 stdout");
    assert_eq!(value["error"]["code"], "WORKFLOW_NOT_FOUND");

    // Human：键值行
    let out = run_cli(&["workflow", "get", "wf_sensitive"], &dir);
    assert_eq!(exit_code(&out), 0);
    let text = stdout(&out);
    assert!(text.contains("id: wf_sensitive"), "Human 键值行: {text}");
    assert!(text.contains("nodes: 3"), "Human 节点计数: {text}");
}

#[tokio::test]
async fn workflow_validate_reports_valid_invalid_and_not_found() {
    let server = demo_server::spawn_ephemeral().await.unwrap();
    let dir = seeded_workflow_dir("wf-validate", &server.base_url()).await;

    // 合法链：valid=true、issues 空、exit 0
    let out = run_cli(&["workflow", "validate", "wf_login", "--json"], &dir);
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(value["success"], serde_json::Value::Bool(true));
    assert_eq!(value["valid"], serde_json::Value::Bool(true));
    assert_eq!(value["issues"], serde_json::json!([]));

    // 坏图：valid=false、错误清单可定位（missingStart / orphanNode /
    // requestUnbound），命令仍 exit 0（有效性是数据不是命令失败）
    let out = run_cli(&["workflow", "validate", "wf_broken", "--json"], &dir);
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(value["valid"], serde_json::Value::Bool(false));
    let issues = value["issues"].as_array().expect("issues 数组");
    let codes: Vec<&str> = issues
        .iter()
        .map(|issue| issue["code"].as_str().expect("code 词表"))
        .collect();
    assert!(
        codes.contains(&"missingStart"),
        "缺 Start 在清单: {codes:?}"
    );
    assert!(codes.contains(&"orphanNode"), "孤立节点在清单: {codes:?}");
    assert!(
        codes.contains(&"requestUnbound"),
        "未绑定请求在清单: {codes:?}"
    );
    assert!(
        issues.iter().all(|issue| issue["message"].is_string()),
        "逐条问题带 message"
    );

    // 宽松引用图（引用键无上游产出者）：静态不判、校验放行（valid=true、
    // issues 空），运行时按既有变量缺失语义求值；命令 exit 0
    let out = run_cli(&["workflow", "validate", "wf_loose", "--json"], &dir);
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(
        value["valid"],
        serde_json::Value::Bool(true),
        "无上游产出的引用不拦截 valid"
    );
    assert_eq!(
        value["issues"],
        serde_json::json!([]),
        "引用键静态不可判定，不产生问题条目"
    );

    let out = run_cli(&["workflow", "validate", "wf_loose"], &dir);
    assert_eq!(exit_code(&out), 0);
    assert!(
        !stdout(&out).contains("nodeReference"),
        "Human 行不出现引用类问题: {}",
        stdout(&out)
    );

    // not found → exit 3
    let out = run_cli(&["workflow", "validate", "wf_missing", "--json"], &dir);
    assert_eq!(exit_code(&out), 3);
    let value = assert_stdout_is_json_or_empty(&out).expect("错误包络在 stdout");
    assert_eq!(value["error"]["code"], "WORKFLOW_NOT_FOUND");
}

#[tokio::test(flavor = "multi_thread")]
async fn workflow_run_login_chain_passes_with_full_masked_output() {
    let server = demo_server::spawn_ephemeral().await.unwrap();
    let dir = seeded_workflow_dir("wf-run", &server.base_url()).await;

    let out = run_cli(&["workflow", "run", "wf_login", "--json"], &dir);
    assert_eq!(exit_code(&out), 0);
    let text = stdout(&out);
    let value: serde_json::Value =
        serde_json::from_str(text.trim()).expect("run 输出恒为合法 JSON");
    assert_eq!(value["success"], serde_json::Value::Bool(true));
    assert_eq!(value["status"], "passed");

    // 顶层契约键集（schema 稳定，契约测试钉住）
    let mut keys: Vec<&str> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "completedAt",
            "durationMs",
            "errorCode",
            "errorMessage",
            "nodes",
            "runId",
            "startedAt",
            "status",
            "success",
            "workflowId",
        ]
    );
    let run_id = value["runId"].as_str().expect("runId 恒在").to_owned();
    assert!(run_id.starts_with("wexec_"), "工作流执行身份: {run_id}");
    assert_eq!(value["workflowId"], "wf_login");

    // 逐节点状态：全链 passed
    let nodes = value["nodes"].as_array().expect("nodes 数组");
    let node = |id: &str| {
        nodes
            .iter()
            .find(|node| node["nodeId"] == id)
            .unwrap_or_else(|| panic!("节点记录缺失: {id}"))
    };
    for id in ["start", "login", "extract", "me", "assert", "end"] {
        assert_eq!(node(id)["status"], "passed", "{id} 应通过");
    }

    // 请求明细：request（方法＋URL）与 response（状态码＋响应体掩码摘要）
    let login = node("login");
    assert_eq!(login["request"]["method"], "POST");
    assert!(
        login["request"]["url"]
            .as_str()
            .unwrap()
            .ends_with("/auth/login"),
        "最终 URL 在明细"
    );
    assert_eq!(login["response"]["status"], 200);
    let body = login["response"]["body"].as_str().expect("响应体摘要");
    assert!(body.contains("token"), "JSON 键名可见（诊断面）: {body}");

    // URL 携带 {{token}} 消费值 → 写时掩码；JWT 全程不得明文出现
    let me_request = node("me")["request"]["url"].as_str().unwrap();
    assert!(
        me_request.contains("token=***"),
        "URL Secret 消费值掩码: {me_request}"
    );
    assert!(
        me_request.contains("tokenType=Bearer"),
        "第二产物引用解析（非敏感明文）: {me_request}"
    );
    assert!(
        !text.contains("eyJ"),
        "JWT（base64url 前缀）不得出现在任何输出"
    );

    // 断言条目：期望 vs 实际
    let assertions = node("assert")["assertions"].as_array().expect("断言条目");
    assert_eq!(assertions.len(), 1);
    assert_eq!(assertions[0]["ruleKind"], "statusCode");
    assert_eq!(assertions[0]["expected"], "200");
    assert_eq!(assertions[0]["actual"], "200");
    assert_eq!(assertions[0]["passed"], serde_json::Value::Bool(true));

    // run status：终态可查（轻量信封）
    let out = run_cli(&["run", "status", &run_id, "--json"], &dir);
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(value["success"], serde_json::Value::Bool(true));
    assert_eq!(value["data"]["runId"], run_id.as_str());
    assert_eq!(value["data"]["status"], "passed");
    assert_eq!(value["data"]["workflowId"], "wf_login");

    // run status：未知 id → exit 3 RUN_NOT_FOUND
    let out = run_cli(&["run", "status", "wexec_MISSING", "--json"], &dir);
    assert_eq!(exit_code(&out), 3);
    let value = assert_stdout_is_json_or_empty(&out).expect("错误包络在 stdout");
    assert_eq!(value["error"]["code"], "RUN_NOT_FOUND");

    // Human 模式：摘要行＋逐节点行，脱敏口径不变
    let out = run_cli(&["workflow", "run", "wf_login"], &dir);
    assert_eq!(exit_code(&out), 0);
    let text = stdout(&out);
    assert!(text.contains("Workflow passed"), "总览行: {text}");
    assert!(text.contains("- login passed"), "逐节点行: {text}");
    assert!(!text.contains("eyJ"), "Human 输出同样脱敏");
}

#[tokio::test(flavor = "multi_thread")]
async fn workflow_run_failed_assert_exits_nonzero_with_details() {
    let server = demo_server::spawn_ephemeral().await.unwrap();
    let dir = seeded_workflow_dir("wf-fail", &server.base_url()).await;

    let out = run_cli(&["workflow", "run", "wf_failing", "--json"], &dir);
    assert_eq!(
        exit_code(&out),
        1,
        "断言失败＝非零退出（域内码走 fallback）"
    );
    let text = stdout(&out);
    let value: serde_json::Value = serde_json::from_str(text.trim()).expect("错误包络");
    assert_eq!(value["success"], serde_json::Value::Bool(false));
    assert_eq!(value["error"]["code"], "WORKFLOW_ASSERT_FAILED");
    // 逐节点明细随 details 下发（CI 失败路径可消费）
    let details = &value["error"]["details"];
    assert_eq!(details["status"], "failed");
    let nodes = details["nodes"].as_array().expect("失败路径带节点明细");
    let assert_node = nodes
        .iter()
        .find(|node| node["nodeId"] == "assert")
        .expect("断言节点记录");
    assert_eq!(assert_node["status"], "failed");
    let assertions = assert_node["assertions"].as_array().expect("断言条目");
    assert_eq!(assertions[0]["expected"], "418");
    assert_eq!(assertions[0]["actual"], "200");
    assert_eq!(assertions[0]["passed"], serde_json::Value::Bool(false));
    assert!(!text.contains("eyJ"), "失败路径同样不外泄响应体中的 token");
}

#[tokio::test(flavor = "multi_thread")]
async fn workflow_run_not_executable_lists_issues() {
    let server = demo_server::spawn_ephemeral().await.unwrap();
    let dir = seeded_workflow_dir("wf-noexec", &server.base_url()).await;

    // 校验失败不得启动：exit 4＋错误清单随 details.issues
    let out = run_cli(&["workflow", "run", "wf_broken", "--json"], &dir);
    assert_eq!(exit_code(&out), 4);
    let value = assert_stdout_is_json_or_empty(&out).expect("错误包络在 stdout");
    assert_eq!(value["error"]["code"], "WORKFLOW_NOT_EXECUTABLE");
    let issues = value["error"]["details"]["issues"]
        .as_array()
        .expect("问题清单随错误下发");
    assert!(!issues.is_empty(), "校验失败输出错误清单");

    // 执行未启动＝无执行记录：run status 未命中
    let out = run_cli(&["run", "status", "wexec_ANYTHING", "--json"], &dir);
    assert_eq!(exit_code(&out), 3);
}

#[tokio::test]
async fn project_info_counts_workflows() {
    let server = demo_server::spawn_ephemeral().await.unwrap();
    let dir = seeded_workflow_dir("wf-info", &server.base_url()).await;

    let out = run_cli(&["project", "info", "--json"], &dir);
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(
        value["data"]["workflows"], 5,
        "workflows 计数转实数（五条种子工作流）"
    );
}

// —— `--workspace` 指定参数（缺省路径逐字节钉住）——

/// 双空间种子：默认空间带服务A（GET /users），「流水线空间」带同名服务与
/// 同稳定键接口（跨空间数据隔离靶）。
async fn seeded_two_workspace_dir(tag: &str) -> PathBuf {
    let dir = temp_dir(tag);
    let ctx = AppContext::new(dir.clone()).await.unwrap();
    let pool = &ctx.db.pool;
    let (ws,): (String,) = sqlx::query_as("SELECT id FROM workspaces LIMIT 1")
        .fetch_one(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO workspaces (id, name, base_url, auth, sort_order, created_at, updated_at) \
         VALUES ('w-line', '流水线空间', NULL, NULL, 1, \
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .execute(pool)
    .await
    .unwrap();
    for (id, workspace_id, name) in [("s1", ws.as_str(), "服务A"), ("s2", "w-line", "服务A")] {
        sqlx::query(
            "INSERT INTO services (id, workspace_id, name, doc_url, doc_type, sort_order, created_at, updated_at) \
             VALUES (?, ?, ?, NULL, 'openapi', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(id)
        .bind(workspace_id)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    }
    for (service_id, key) in [("s1", "GET /users"), ("s2", "GET /users")] {
        sqlx::query(
            "INSERT INTO endpoints (service_id, key, title, category_id, definition, created_at, badge, sort_order) \
             VALUES (?, ?, ?, NULL, '{\"method\":\"GET\",\"path_template\":\"/users\"}', \
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, 0)",
        )
        .bind(service_id)
        .bind(key)
        .bind(key)
        .execute(pool)
        .await
        .unwrap();
    }
    ctx.db.pool.close().await;
    dir
}

/// 缺省路径零破坏：不带 `--workspace` 时输出与现状一致（默认空间独占可见）；
/// 指定空间后按目标空间解析（project info 换名、api list 隔离到目标空间）。
#[tokio::test]
async fn workspace_flag_targets_specified_workspace_and_default_path_unchanged() {
    let dir = seeded_two_workspace_dir("ws-flag").await;

    // 缺省：当前工作空间（默认空间），服务A 只见本空间一行
    let out = run_cli(&["api", "list", "--json"], &dir);
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    let items = value["data"].as_array().unwrap();
    assert_eq!(items.len(), 1, "缺省＝当前空间（既有脚本零破坏）");
    assert_eq!(items[0]["service"], "服务A");
    assert_eq!(items[0]["id"], "GET /users");

    // project info 缺省＝默认空间名
    let out = run_cli(&["project", "info", "--json"], &dir);
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(value["data"]["name"], "默认工作空间");

    // 指定名称：目标空间概要与清单（前后位置均可）
    let out = run_cli(
        &["project", "info", "--workspace", "流水线空间", "--json"],
        &dir,
    );
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(value["data"]["name"], "流水线空间");

    let out = run_cli(
        &["--workspace", "流水线空间", "api", "list", "--json"],
        &dir,
    );
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    let items = value["data"].as_array().unwrap();
    assert_eq!(items.len(), 1, "目标空间只见本空间接口");
    assert_eq!(items[0]["service"], "服务A", "跨空间同名服务按空间隔离");

    // workflow list 同样受益（指定空间内的工作流，缺省空间不受污染）
    let out = run_cli(
        &["workflow", "list", "--workspace", "流水线空间", "--json"],
        &dir,
    );
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(value["data"]["items"].as_array().unwrap().len(), 0);

    // 指定 id 与指定名称等价
    let out = run_cli(
        &["project", "info", "--workspace", "w-line", "--json"],
        &dir,
    );
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(value["data"]["name"], "流水线空间");
}

/// 不存在的空间名：`INVALID_ARGUMENT`（exit 2），错误消息不泄露现存空间
/// 的名称与数量；缺省空间数据不受影响。
#[tokio::test]
async fn workspace_flag_missing_reports_invalid_argument_without_leakage() {
    let dir = seeded_two_workspace_dir("ws-missing").await;

    let out = run_cli(
        &["api", "list", "--workspace", "不存在的空间", "--json"],
        &dir,
    );
    assert_eq!(exit_code(&out), 2);
    let text = stdout(&out);
    let value: serde_json::Value = serde_json::from_str(text.trim()).expect("错误包络在 stdout");
    assert_eq!(value["error"]["code"], "INVALID_ARGUMENT");
    let message = value["error"]["message"].as_str().unwrap();
    assert!(
        !message.contains("默认工作空间") && !message.contains("流水线空间"),
        "错误消息不得枚举现存空间: {message}"
    );

    // Human 模式：错误文本走 stderr，stdout 保持空
    let out = run_cli(&["api", "list", "--workspace", "不存在的空间"], &dir);
    assert_eq!(exit_code(&out), 2);
    assert!(stdout(&out).is_empty(), "Human 错误不得污染 stdout");
    assert!(stderr(&out).contains("INVALID_ARGUMENT"));

    // 失败后缺省路径仍然完好（参数解析不产生副作用）
    let out = run_cli(&["api", "list", "--json"], &dir);
    assert_eq!(exit_code(&out), 0);
}

// —— 契约夹具数据驱动 E2E（`tests/fixtures/cli/contract.json`）——
//
// 夹具是 `apilot --json` 命令执行面的事实源：每条目＝叶子命令路径＋参数
// 模板（种子 id 用 `{占位符}`，由本文件的种子上下文填充；`provides` 把前序
// 条目输出中的运行期 id 登记为后续条目的占位符）＋形态骨架。比对口径＝
// 键集全等（多一键、少一键都失败）：`nullable` 表达 Option 字段、`optional`
// 表达 serde `skip_serializing_if` 键、`const` 钉字面值。每条目同时断言输出
// 不变式：stdout 恰一个单行 JSON 文档、stderr 恒空、exit 与夹具一致。既有
// 场景式 E2E 验行为语义，本组只验形态，两者不互替。

#[derive(serde::Deserialize)]
struct ContractFile {
    commands: Vec<ContractEntry>,
}

#[derive(serde::Deserialize)]
struct ContractEntry {
    id: String,
    /// 叶子命令路径（空格分隔，如 `api get`）
    command: String,
    args: Vec<String>,
    exit: i32,
    shape: Shape,
    /// 占位符 → 输出 JSON 的点路径（运行期生成的 id 交给后续条目）
    #[serde(default)]
    provides: BTreeMap<String, String>,
}

/// 形态骨架节点：`type`（object / array / string / number / boolean / null /
/// any）、`keys`（object 键集）、`items`（array 元素）、`nullable`、
/// `optional`、`const`。
#[derive(serde::Deserialize)]
struct Shape {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    keys: BTreeMap<String, Shape>,
    #[serde(default)]
    items: Option<Box<Shape>>,
    #[serde(default)]
    nullable: bool,
    #[serde(default)]
    optional: bool,
    #[serde(rename = "const", default)]
    literal: Option<serde_json::Value>,
}

/// 键集全等比对器：任何偏差 panic 并报出 JSON 路径。
fn assert_shape(shape: &Shape, value: &serde_json::Value, path: &str) {
    if let Some(expected) = &shape.literal {
        assert_eq!(value, expected, "字面值不符 @ {path}");
        return;
    }
    let kind = shape
        .kind
        .as_deref()
        .unwrap_or_else(|| panic!("{path}: 形态节点须声明 type 或 const"));
    if kind == "any" {
        return;
    }
    if value.is_null() {
        assert!(
            kind == "null" || shape.nullable,
            "非可空字段为 null @ {path}"
        );
        return;
    }
    match kind {
        "null" => panic!("应为 null 却得到 {value} @ {path}"),
        "object" => {
            let object = value
                .as_object()
                .unwrap_or_else(|| panic!("应为 object @ {path}: {value}"));
            for key in object.keys() {
                assert!(
                    shape.keys.contains_key(key),
                    "多出夹具未登记的键 {key:?} @ {path}"
                );
            }
            for (key, sub) in &shape.keys {
                match object.get(key) {
                    Some(inner) => assert_shape(sub, inner, &format!("{path}.{key}")),
                    None => assert!(sub.optional, "缺少键 {key:?} @ {path}"),
                }
            }
        }
        "array" => {
            let items = value
                .as_array()
                .unwrap_or_else(|| panic!("应为 array @ {path}: {value}"));
            let item_shape = shape
                .items
                .as_deref()
                .unwrap_or_else(|| panic!("{path}: array 须声明 items"));
            for (index, item) in items.iter().enumerate() {
                assert_shape(item_shape, item, &format!("{path}[{index}]"));
            }
        }
        "string" => assert!(value.is_string(), "应为 string @ {path}: {value}"),
        "number" => assert!(value.is_number(), "应为 number @ {path}: {value}"),
        "boolean" => assert!(value.is_boolean(), "应为 boolean @ {path}: {value}"),
        other => panic!("未知形态类型 {other:?} @ {path}"),
    }
}

/// 参数模板填充：`{NAME}` 命中种子上下文才替换，其余按字面保留。
fn fill_placeholders(template: &str, context: &BTreeMap<String, String>) -> String {
    context
        .iter()
        .fold(template.to_owned(), |text, (name, value)| {
            text.replace(&format!("{{{name}}}"), value)
        })
}

/// 未填充的占位符形态（`{UPPER_SNAKE}` 整参）——与路径模板的 `{status}`
/// 等小写字面区分。
fn is_unfilled_placeholder(arg: &str) -> bool {
    arg.strip_prefix('{')
        .and_then(|rest| rest.strip_suffix('}'))
        .is_some_and(|inner| {
            !inner.is_empty() && inner.chars().all(|c| c.is_ascii_uppercase() || c == '_')
        })
}

/// 输出 JSON 的点路径取字符串（`provides` 用）。
fn json_path_string(value: &serde_json::Value, path: &str) -> String {
    path.split('.')
        .fold(value, |current, segment| &current[segment])
        .as_str()
        .unwrap_or_else(|| panic!("provides 路径 {path} 不是字符串"))
        .to_owned()
}

/// 比对器自检：键集全等口径下多键 / 少键 / 非可空 null / 字面值不符 /
/// 类型不符各自令断言变红；`nullable` / `optional` 恰好放行其声明的形态。
#[test]
fn shape_comparator_enforces_exact_key_set_and_markers() {
    let shape: Shape = serde_json::from_value(serde_json::json!({
        "type": "object",
        "keys": {
            "flag": { "const": true },
            "name": { "type": "string" },
            "note": { "type": "string", "nullable": true },
            "extra": { "type": "number", "optional": true }
        }
    }))
    .unwrap();
    let rejects = |value: serde_json::Value| {
        std::panic::catch_unwind(|| assert_shape(&shape, &value, "$")).is_err()
    };
    let accepts = |value: serde_json::Value| !rejects(value);

    assert!(accepts(
        serde_json::json!({ "flag": true, "name": "a", "note": null })
    ));
    assert!(accepts(
        serde_json::json!({ "flag": true, "name": "a", "note": "n", "extra": 1 })
    ));
    assert!(
        rejects(serde_json::json!({ "flag": true, "name": "a", "note": null, "more": 1 })),
        "多键"
    );
    assert!(
        rejects(serde_json::json!({ "flag": true, "note": null })),
        "少键"
    );
    assert!(
        rejects(serde_json::json!({ "flag": true, "name": null, "note": null })),
        "非可空 null"
    );
    assert!(
        rejects(serde_json::json!({ "flag": false, "name": "a", "note": null })),
        "字面值"
    );
    assert!(
        rejects(serde_json::json!({ "flag": true, "name": 1, "note": null })),
        "类型"
    );
    assert!(
        rejects(serde_json::json!({ "flag": true, "name": "a", "note": null, "extra": "x" })),
        "可选键存在时仍验类型"
    );
}

/// 夹具占位符的种子上下文（与 `seeded_contract_dir` 的种子同步）。
fn contract_placeholders() -> BTreeMap<String, String> {
    [
        ("API_USERS_ID", "GET /api/users"),
        ("API_SLOW_ID", "GET /api/slow"),
        ("ENDPOINT_MISSING_ID", "GET /nope"),
        ("WF_LOGIN_ID", "wf_login"),
        ("WF_BROKEN_ID", "wf_broken"),
        ("WF_SENSITIVE_ID", "wf_sensitive"),
        ("WF_MISSING_ID", "wf_missing"),
        ("WEXEC_MISSING_ID", "wexec_MISSING"),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_owned(), value.to_owned()))
    .collect()
}

/// 契约 E2E 与脱敏矩阵共用种子：默认空间 BaseUrl 指向靶机，服务「靶机」含
/// `GET /api/users`（用户数据带敏感头、分页参数与 body 字符串）、
/// `GET /api/slow`（接口级 timeout 1 秒，靶机默认延迟 5 秒→必超时，供传输
/// 失败条目）与登录链两端点（`GET /auth/me` 授权头引用 `{{token}}` 产物）；
/// 三条工作流（登录链 / 坏图 / 敏感覆写）。GUI 未运行，库由测试进程装配后
/// 交给子进程独占。
async fn seeded_contract_dir(tag: &str, base_url: &str) -> PathBuf {
    let dir = temp_dir(tag);
    let ctx = AppContext::new(dir.clone()).await.unwrap();
    let pool = &ctx.db.pool;
    let (ws,): (String,) = sqlx::query_as("SELECT id FROM workspaces LIMIT 1")
        .fetch_one(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE workspaces SET base_url = ? WHERE id = ?")
        .bind(base_url)
        .bind(&ws)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO services (id, workspace_id, name, doc_url, doc_type, sort_order, created_at, updated_at) \
         VALUES ('s1', ?, '靶机', NULL, 'openapi', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .bind(&ws)
    .execute(pool)
    .await
    .unwrap();
    let endpoints = [
        (
            "GET /api/users",
            "用户列表",
            r#"{"method":"GET","path_template":"/api/users"}"#,
        ),
        (
            "GET /api/slow",
            "慢速端点",
            r#"{"method":"GET","path_template":"/api/slow"}"#,
        ),
        (
            "POST /auth/login",
            "登录",
            r#"{"method":"POST","path_template":"/auth/login"}"#,
        ),
        (
            "GET /auth/me",
            "当前登录信息",
            r#"{"method":"GET","path_template":"/auth/me"}"#,
        ),
    ];
    for (key, title, definition) in endpoints {
        sqlx::query(
            "INSERT INTO endpoints (service_id, key, title, category_id, definition, created_at, badge, sort_order) \
             VALUES ('s1', ?, ?, NULL, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, 0)",
        )
        .bind(key)
        .bind(title)
        .bind(definition)
        .execute(pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO endpoint_user_data (service_id, key, body, params, headers, updated_at) \
         VALUES ('s1', 'GET /api/users', '{\"a\":1}', '[{\"name\":\"page\",\"value\":\"1\"}]', \
         '[{\"name\":\"Authorization\",\"value\":\"Bearer contract-secret-token\"},{\"name\":\"Accept\",\"value\":\"application/json\"}]', \
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO endpoint_user_data (service_id, key, body, params, headers, timeout_seconds, updated_at) \
         VALUES ('s1', 'GET /api/slow', NULL, '[]', '[]', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO endpoint_user_data (service_id, key, body, params, headers, updated_at) \
         VALUES ('s1', 'GET /auth/me', NULL, '[]', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .bind(r#"[{"name":"Authorization","value":"Bearer {{token}}"}]"#)
    .execute(pool)
    .await
    .unwrap();
    let workflows = [
        ("wf_login", "登录链", login_chain_graph()),
        ("wf_broken", "坏图", broken_graph()),
        ("wf_sensitive", "敏感覆写", sensitive_override_graph()),
    ];
    for (id, name, graph) in workflows {
        sqlx::query(
            "INSERT INTO workflows (id, workspace_id, name, graph, created_at, updated_at) \
             VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(id)
        .bind(&ws)
        .bind(name)
        .bind(graph)
        .execute(pool)
        .await
        .unwrap();
    }
    ctx.db.pool.close().await;
    dir
}

/// 夹具逐条目真跑：填充占位符 → 子进程执行 → exit / 单行 JSON / stderr 空 /
/// 形态键集全等；`provides` 登记运行期 id 供后续条目消费。
#[tokio::test(flavor = "multi_thread")]
async fn contract_fixture_entries_execute_with_pinned_shapes() {
    let server = demo_server::spawn_ephemeral().await.unwrap();
    let dir = seeded_contract_dir("contract", &server.base_url()).await;
    let fixture: ContractFile = serde_json::from_str(include_str!("fixtures/cli/contract.json"))
        .expect("契约夹具必须可解析");
    assert!(!fixture.commands.is_empty(), "夹具须含命令条目");
    let mut context = contract_placeholders();

    for entry in &fixture.commands {
        let args: Vec<String> = entry
            .args
            .iter()
            .map(|arg| fill_placeholders(arg, &context))
            .collect();
        for arg in &args {
            assert!(
                !is_unfilled_placeholder(arg),
                "[{}] 占位符 {arg} 未被种子上下文或前序 provides 填充",
                entry.id
            );
        }
        let mut argv: Vec<&str> = entry.command.split(' ').collect();
        argv.extend(args.iter().map(String::as_str));

        let out = run_cli(&argv, &dir);
        assert_eq!(exit_code(&out), entry.exit, "[{}] exit code", entry.id);
        let text = stdout(&out);
        assert!(
            text.ends_with('\n') && text.matches('\n').count() == 1,
            "[{}] stdout 须恰为一个单行 JSON 文档：{text:?}",
            entry.id
        );
        let value: serde_json::Value = serde_json::from_str(text.trim_end())
            .unwrap_or_else(|err| panic!("[{}] stdout 非合法 JSON: {err}\n{text}", entry.id));
        assert!(
            stderr(&out).is_empty(),
            "[{}] JSON 模式 stderr 须恒空：{}",
            entry.id,
            stderr(&out)
        );
        assert_shape(&entry.shape, &value, &entry.id);

        for (name, path) in &entry.provides {
            context.insert(name.clone(), json_path_string(&value, path));
        }
    }
}

// —— 脱敏矩阵（四命令 × 默认掩码 / `--show-secrets`）——
//
// 口径：`api get` / `workflow get` 放行明文；`api run` 放行请求镜像（URL、
// 请求头），响应头经同一掩码函数、响应体是服务端数据从不替换；
// `workflow run` 输出来自执行记录，写时掩码不可逆，`--show-secrets` 不放行。

#[tokio::test]
async fn redaction_matrix_api_get_masks_by_default_and_reveals_with_flag() {
    let dir = seeded_contract_dir("mask-api-get", "http://127.0.0.1:1").await;

    let out = run_cli(&["api", "get", "GET /api/users", "--json"], &dir);
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(value["data"]["headers"][0]["name"], "Authorization");
    assert_eq!(value["data"]["headers"][0]["value"], "***", "默认掩码");
    assert!(!stdout(&out).contains("contract-secret-token"));

    let out = run_cli(
        &["api", "get", "GET /api/users", "--show-secrets", "--json"],
        &dir,
    );
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(
        value["data"]["headers"][0]["value"], "Bearer contract-secret-token",
        "--show-secrets 放行明文"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn redaction_matrix_api_run_reveals_request_mirror_only() {
    let server = demo_server::spawn_ephemeral().await.unwrap();
    let dir = seeded_contract_dir("mask-api-run", &server.base_url()).await;
    let authorization = |value: &serde_json::Value| -> serde_json::Value {
        value["request"]["headers"]
            .as_array()
            .expect("请求镜像头数组")
            .iter()
            .find(|header| header["name"] == "Authorization")
            .expect("敏感头在请求镜像")["value"]
            .clone()
    };

    let masked = run_cli(&["api", "run", "GET /api/users", "--json"], &dir);
    assert_eq!(exit_code(&masked), 0);
    let masked_value = assert_stdout_is_json_or_empty(&masked).expect("应有 JSON 输出");
    assert_eq!(authorization(&masked_value), "***", "默认掩码请求头");
    assert!(!stdout(&masked).contains("contract-secret-token"));

    let shown = run_cli(
        &["api", "run", "GET /api/users", "--show-secrets", "--json"],
        &dir,
    );
    assert_eq!(exit_code(&shown), 0);
    let shown_value = assert_stdout_is_json_or_empty(&shown).expect("应有 JSON 输出");
    assert_eq!(
        authorization(&shown_value),
        "Bearer contract-secret-token",
        "--show-secrets 放行请求镜像"
    );

    // 响应侧：响应头与请求头走同一掩码函数，但靶机不返回名单内敏感头名
    // （`/api/users` 无凭证类响应头），此处可观测的口径是两态同形（掩码只
    // 作用于值、不增删条目）；响应体是服务端数据，两态逐字一致、不出现掩码标记
    let header_names = |value: &serde_json::Value| -> Vec<String> {
        value["response"]["headers"]
            .as_array()
            .expect("响应头数组")
            .iter()
            .map(|header| header["name"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(header_names(&masked_value), header_names(&shown_value));
    assert_eq!(
        masked_value["response"]["body"], shown_value["response"]["body"],
        "响应体从不替换"
    );
    assert!(
        !masked_value["response"]["body"]["excerpt"]
            .as_str()
            .unwrap()
            .contains("***")
    );
}

#[tokio::test]
async fn redaction_matrix_workflow_get_masks_by_default_and_reveals_with_flag() {
    let dir = seeded_contract_dir("mask-wf-get", "http://127.0.0.1:1").await;

    let out = run_cli(&["workflow", "get", "wf_sensitive", "--json"], &dir);
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    let rows = &value["data"]["graph"]["nodes"][1]["config"]["query"];
    assert_eq!(rows[0]["name"], "Authorization");
    assert_eq!(rows[0]["value"], "***", "名单覆写行默认掩码");
    assert_eq!(rows[1]["value"], "application/json", "非名单行原样");
    assert!(!stdout(&out).contains("get-e2e-credential"));

    let out = run_cli(
        &[
            "workflow",
            "get",
            "wf_sensitive",
            "--show-secrets",
            "--json",
        ],
        &dir,
    );
    assert_eq!(exit_code(&out), 0);
    let value = assert_stdout_is_json_or_empty(&out).expect("应有 JSON 输出");
    assert_eq!(
        value["data"]["graph"]["nodes"][1]["config"]["query"][0]["value"],
        "Bearer get-e2e-credential",
        "--show-secrets 放行明文"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn redaction_matrix_workflow_run_is_masked_regardless_of_flag() {
    let server = demo_server::spawn_ephemeral().await.unwrap();
    let dir = seeded_contract_dir("mask-wf-run", &server.base_url()).await;

    for args in [
        vec!["workflow", "run", "wf_login", "--json"],
        vec!["workflow", "run", "wf_login", "--show-secrets", "--json"],
    ] {
        let out = run_cli(&args, &dir);
        assert_eq!(exit_code(&out), 0, "{args:?}");
        let text = stdout(&out);
        let value: serde_json::Value =
            serde_json::from_str(text.trim()).expect("run 输出合法 JSON");
        let me_url = value["nodes"]
            .as_array()
            .expect("nodes 数组")
            .iter()
            .find(|node| node["nodeId"] == "me")
            .expect("me 节点记录")["request"]["url"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(
            me_url.contains("token=***"),
            "{args:?}: 写时掩码不可逆，Secret 消费值恒掩码：{me_url}"
        );
        assert!(
            !text.contains("eyJ"),
            "{args:?}: JWT 不得出现在任何输出（含 --show-secrets）"
        );
    }
}

// —— 元路径豁免（人类帮助面不受 `--json` 约束）——

/// `--help` / `--version` / 裸调用：stdout 纯文本（非 JSON）、exit 0、
/// stderr 空；clap 参数错误：stdout 空、exit 2、消息走 stderr。现行为即
/// 契约，零代码改动，锁定测试钉住。
#[test]
fn json_flag_does_not_bind_meta_paths() {
    let dir = temp_dir("meta-paths");
    for args in [
        vec!["--json", "--help"],
        vec!["--json", "--version"],
        vec!["--json"],
    ] {
        let out = run_cli(&args, &dir);
        assert_eq!(exit_code(&out), 0, "{args:?}");
        let text = stdout(&out);
        assert!(!text.trim().is_empty(), "{args:?}: 帮助面 stdout 非空");
        assert!(
            serde_json::from_str::<serde_json::Value>(text.trim()).is_err(),
            "{args:?}: 帮助面输出为纯文本而非 JSON：{text}"
        );
        assert!(stderr(&out).is_empty(), "{args:?}: 帮助面不写 stderr");
    }

    let out = run_cli(&["--json", "frobnicate"], &dir);
    assert_eq!(exit_code(&out), 2, "clap 参数错误 exit 2");
    assert!(stdout(&out).is_empty(), "参数错误不进 stdout");
    assert!(!stderr(&out).is_empty(), "参数错误消息走 stderr");
}
