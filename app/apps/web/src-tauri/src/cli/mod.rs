//! `apilot` CLI（Mode B）：读写直连 SQLite，全程不依赖 GUI 运行；
//! 链接 GUI 宿主框架但不初始化。本模块及子模块**禁止引用宿主框架路径与
//! IPC 壳模块**（隔离断言脚本 `app/scripts/check-cli-isolation.sh`
//! 机械强制，注释亦不得书写这两个字面量以免误判）。
//!
//! 装配：自建 tokio Runtime（不碰宿主的异步运行时）；
//! 数据目录经 `infrastructure::data_dir` 解析（只允许本入口调用）；**不 init
//! 任何 tracing 装置**（no-op 丢弃，零输出污染——JSON 输出纯净性由 output
//! 层在命令 Result 后一次性渲染承担）。
//!
//! 骨架平铺七文件：`mod.rs`（入口 run＋分发＋权限拦截）/`project.rs`/
//! `api.rs`/`workflow.rs`/`run.rs`/`output.rs`/`error.rs`；另有测试专用的
//! `skill_contract.rs`（仓库根 Agent skill 与 CLI 契约的对账）。
//!
//! TaskRegistry 判定线：读命令毫秒级顺序完成即退，不进登记处；
//! 跨 await 可取消执行（api run / workflow run 等执行域命令）入
//! `TaskRegistry`。

mod api;
mod error;
mod output;
mod project;
mod run;
#[cfg(test)]
mod skill_contract;
mod workflow;

use clap::{CommandFactory, Parser, Subcommand};

use crate::app_context::AppContext;
use crate::domain::permission::PermissionLevel;
use crate::domain::workspace::Workspace;
use crate::error::AppError;
use crate::error::codes;
use crate::infrastructure::workspace_repo;
use crate::services::workspace;

/// `apilot`——APilot 2.0 命令行（不依赖 GUI 运行）。
#[derive(Debug, Parser)]
#[command(name = "apilot", version)]
struct Cli {
    /// 以 JSON 输出（默认 Human；命令前后位置均可）
    #[arg(short = 'j', long = "json", global = true)]
    json: bool,
    /// 放行敏感值明文输出（命令前后位置均可）
    #[arg(long = "show-secrets", global = true)]
    show_secrets: bool,
    /// 指定目标工作空间（名称或 id 精确匹配；命令前后位置均可），缺省＝当前工作空间
    #[arg(long = "workspace", value_name = "名称|id", global = true)]
    workspace: Option<String>,
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// 当前工作空间概要
    Project(project::ProjectCommand),
    /// 接口读取与执行命令组
    Api(api::ApiCommand),
    /// 工作流读取 / 校验 / 执行命令组
    Workflow(workflow::WorkflowCommand),
    /// 工作流执行状态查询命令组
    Run(run::RunCommand),
}

/// CLI 进程入口：clap 解析（`--help`/`--version`/参数错误由 clap 原生处理，
/// exit 2）→ 自建 Runtime → 装配 → 分发 → 按码退出。
pub fn run() {
    let cli = Cli::parse();
    let runtime = tokio::runtime::Runtime::new().expect("CLI tokio runtime must be constructible");
    let code = runtime.block_on(execute(cli));
    std::process::exit(code);
}

/// 装配 + 分发 + 连接池收尾。返回进程 exit code。
async fn execute(cli: Cli) -> i32 {
    let out = output::Output::new(cli.json, cli.show_secrets);
    let Some(command) = cli.command else {
        // 裸 `apilot`：打印用法到 stdout（用法即帮助，exit 0）
        let _ = Cli::command().print_help();
        return 0;
    };
    // 权限拦截：clap 解析后、分发前统一入口（Core Service 不感知权限）
    if let Err(err) = authorize(command.permission()) {
        return out.failure(&err);
    }
    let ctx = match assemble().await {
        Ok(ctx) => ctx,
        // 装配失败（目录解析 / DB）也走 output 层：JSON 模式错误包络到 stdout
        Err(err) => return out.failure(&err),
    };
    let code = dispatch(command, &ctx, &out, cli.workspace.as_deref()).await;
    // 最后一个连接干净退出：WAL checkpoint 并清 `-wal`/`-shm`（资源四问：
    // DB 连接谁释放——CLI 进程退出前显式关闭，不留残尾）
    ctx.db.pool.close().await;
    code
}

/// headless 装配链：目录解析 → AppContext。错误交 output 层渲染。
async fn assemble() -> Result<AppContext, crate::error::AppError> {
    let data_dir = crate::infrastructure::data_dir::resolve_data_dir()?;
    AppContext::new(data_dir).await
}

/// 默认策略：READ/EXECUTE 恒允许；WRITE 可配但配置未落地前按拒
/// （fail-closed，权限配置落点随首批写命令另定）；
/// DANGEROUS 恒拒（硬编码，不接受配置放行）。
fn authorize(level: PermissionLevel) -> Result<(), AppError> {
    match level {
        PermissionLevel::Read | PermissionLevel::Execute => Ok(()),
        PermissionLevel::Write => Err(AppError::new(
            codes::PERMISSION_DENIED,
            "write commands require permission configuration (not yet available)",
        )),
        PermissionLevel::Dangerous => Err(AppError::new(
            codes::PERMISSION_DENIED,
            "dangerous commands are rejected by the default policy",
        )),
    }
}

/// CLI 工作空间解析（全命令公共口径）。缺省＝当前工作空间：复用 services
/// 层 resolve_current_id（settings 键有效则用之；缺失或指向已删空间回落
/// 清单首位）；指定 `--workspace`＝按名称或 id 精确匹配只读定位目标空间
/// （解析与错误语义归 services 层单点，不改当前空间键）。None＝seeding
/// 前的防御边界（AppContext 装配链已含 seeding，正常不可达）→
/// `WORKSPACE_NOT_FOUND`（exit 3）。
async fn resolve_workspace(ctx: &AppContext, spec: Option<&str>) -> Result<Workspace, AppError> {
    let Some(spec) = spec else {
        let id = workspace::resolve_current_id(&ctx.db.pool, &ctx.db.cache)
            .await?
            .ok_or_else(|| AppError::new(codes::WORKSPACE_NOT_FOUND, "no workspace exists"))?;
        return workspace_repo::get(&ctx.db.pool, &id)
            .await?
            .ok_or_else(|| {
                AppError::new(
                    codes::WORKSPACE_NOT_FOUND,
                    format!("workspace not found: {id}"),
                )
            });
    };
    workspace::resolve_by_reference(&ctx.db.pool, spec).await
}

/// 命令→权限级别映射：match 穷尽性由编译器强制——新增命令臂必须显式定级。
impl Commands {
    fn permission(&self) -> PermissionLevel {
        match self {
            Commands::Project(project) => match project.command {
                project::ProjectSub::Info => PermissionLevel::Read,
            },
            Commands::Api(api) => match api.command {
                api::ApiSub::List | api::ApiSub::Search { .. } | api::ApiSub::Get { .. } => {
                    PermissionLevel::Read
                }
                // 执行域（资源消耗动作）：默认策略允许
                api::ApiSub::Run { .. } => PermissionLevel::Execute,
            },
            Commands::Workflow(workflow) => match workflow.command {
                workflow::WorkflowSub::List
                | workflow::WorkflowSub::Get { .. }
                | workflow::WorkflowSub::Validate { .. } => PermissionLevel::Read,
                // 执行域（资源消耗动作）：默认策略允许
                workflow::WorkflowSub::Run { .. } => PermissionLevel::Execute,
            },
            Commands::Run(run) => match run.command {
                run::RunSub::Status { .. } => PermissionLevel::Read,
            },
        }
    }
}

/// 分发命令。`ws`＝`--workspace` 指定值（None＝当前工作空间），穿参至各
/// 命令组的工作空间解析点。
/// 命令返回 Domain Result：成功 exit 0，失败统一交 output 层渲染＋映射 exit code。
async fn dispatch(
    command: Commands,
    ctx: &AppContext,
    out: &output::Output,
    ws: Option<&str>,
) -> i32 {
    let result = match command {
        Commands::Project(project) => match project.command {
            project::ProjectSub::Info => project::info(ctx, out, ws).await,
        },
        Commands::Api(api) => match api.command {
            api::ApiSub::List => api::list(ctx, out, ws).await,
            api::ApiSub::Search { keyword } => api::search(ctx, out, ws, &keyword).await,
            api::ApiSub::Get { id, service } => {
                api::get(ctx, out, ws, &id, service.as_deref()).await
            }
            api::ApiSub::Run(args) => api::run(ctx, out, ws, args).await,
        },
        Commands::Workflow(workflow) => match workflow.command {
            workflow::WorkflowSub::List => workflow::list(ctx, out, ws).await,
            workflow::WorkflowSub::Get { id } => workflow::get(ctx, out, ws, &id).await,
            workflow::WorkflowSub::Validate { id } => workflow::validate(ctx, out, ws, &id).await,
            workflow::WorkflowSub::Run { id } => workflow::run(ctx, out, ws, &id).await,
        },
        Commands::Run(run) => match run.command {
            run::RunSub::Status { run_id } => run::status(ctx, out, ws, &run_id).await,
        },
    };
    match result {
        Ok(()) => 0,
        Err(err) => out.failure(&err),
    }
}

/// CLI 契约夹具（`tests/fixtures/cli/contract.json`）的单测侧读取面：
/// 夹具是 `apilot --json` 命令执行面的事实源，内嵌单测据此做命令全集、
/// exit 全表与闭合词表的机械对账；形态骨架由子进程契约 E2E 消费，本层
/// 只读与之对账所需的字段。
#[cfg(test)]
pub(crate) mod contract_fixture {
    use std::collections::BTreeMap;

    pub(crate) const JSON: &str = include_str!("../../tests/fixtures/cli/contract.json");

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct ContractFixture {
        pub(crate) commands: Vec<ContractCommand>,
        pub(crate) exit_codes: BTreeMap<String, i32>,
        pub(crate) vocab: ContractVocab,
    }

    #[derive(serde::Deserialize)]
    pub(crate) struct ContractCommand {
        pub(crate) id: String,
        /// 叶子命令路径（空格分隔，如 `api get`）
        pub(crate) command: String,
        pub(crate) envelope: String,
        pub(crate) exit: i32,
        pub(crate) shape: serde_json::Value,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct ContractVocab {
        pub(crate) execution_status: Vec<String>,
        pub(crate) issue_codes: Vec<String>,
    }

    pub(crate) fn parse() -> ContractFixture {
        serde_json::from_str(JSON).expect("CLI 契约夹具必须是合法 JSON 且形态匹配")
    }

    /// 源码文本中 `pub const NAME: &str = "value";` 行的（名称, 取值）对
    /// ——Rust 运行期无法枚举模块常量，常量集对账走源码文本直读。
    pub(crate) fn string_consts(source: &str) -> Vec<(String, String)> {
        source
            .lines()
            .filter_map(|line| {
                let rest = line.trim_start().strip_prefix("pub const ")?;
                let (name, tail) = rest.split_once(':')?;
                let value = tail.split('"').nth(1)?;
                Some((name.trim().to_owned(), value.to_owned()))
            })
            .collect()
    }

    /// 从 `marker` 起到其后首个顶格 `}` 的源码块（模块体 / 函数体切片）。
    pub(crate) fn block_after<'a>(source: &'a str, marker: &str) -> &'a str {
        let start = source
            .find(marker)
            .unwrap_or_else(|| panic!("源码中找不到标记 {marker:?}"));
        let body = &source[start..];
        let end = body.find("\n}").expect("源码块必须以顶格 } 结束");
        &body[..end]
    }
}

/// clap 命令树的单测侧枚举面：契约夹具的命令全集对账与 Agent skill 对账
/// 共用同一枚举。根命令经 `build` 后 global 旗标已下沉到各子命令、clap
/// 内置 `--help` / `--version` 就位——旗标集即终端实际接受的长旗标。
#[cfg(test)]
pub(crate) mod command_surface {
    use std::collections::BTreeMap;

    use clap::CommandFactory;

    /// 已 build 的根命令。
    pub(crate) fn root() -> clap::Command {
        let mut cmd = super::Cli::command();
        cmd.build();
        cmd
    }

    /// 直接子命令（clap 内置 `help` 子命令不计）。
    pub(crate) fn subcommands(cmd: &clap::Command) -> impl Iterator<Item = &clap::Command> {
        cmd.get_subcommands().filter(|sub| sub.get_name() != "help")
    }

    /// 叶子命令路径全集（空格分隔、不含根名，如 `api get`）。
    pub(crate) fn leaf_paths(root: &clap::Command) -> Vec<String> {
        subcommands(root)
            .flat_map(|group| leaves_under(group, ""))
            .collect()
    }

    fn leaves_under(cmd: &clap::Command, prefix: &str) -> Vec<String> {
        let path = if prefix.is_empty() {
            cmd.get_name().to_owned()
        } else {
            format!("{prefix} {}", cmd.get_name())
        };
        let subs: Vec<&clap::Command> = subcommands(cmd).collect();
        if subs.is_empty() {
            return vec![path];
        }
        subs.into_iter()
            .flat_map(|sub| leaves_under(sub, &path))
            .collect()
    }

    /// 命令接受的长旗标（不含 `--` 前缀）→ 是否取值。
    pub(crate) fn long_flags(cmd: &clap::Command) -> BTreeMap<String, bool> {
        cmd.get_arguments()
            .filter_map(|arg| {
                let long = arg.get_long()?;
                Some((long.to_owned(), arg.get_action().takes_values()))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;
    use api::ApiSub;
    use clap::CommandFactory;

    /// 命令全集对账：clap 叶子命令集合＝夹具 `commands` 命令集合，且每个
    /// 叶子至少一条成功条目与一条错误条目——新增命令漏登夹具、夹具写错
    /// 命令名都在此变红。
    #[test]
    fn command_universe_matches_contract_fixture() {
        let fixture = contract_fixture::parse();
        let leaves: BTreeSet<String> = command_surface::leaf_paths(&command_surface::root())
            .into_iter()
            .collect();
        // 枚举器自身的独立锚点：四命令组展开恰为十个叶子，防止枚举漏叶与
        // 夹具漏条目恰好同向而相互掩盖
        assert_eq!(leaves.len(), 10, "叶子命令全集：{leaves:?}");

        let fixture_commands: BTreeSet<String> =
            fixture.commands.iter().map(|e| e.command.clone()).collect();
        assert_eq!(
            fixture_commands, leaves,
            "夹具命令集合必须与叶子命令全集全等"
        );
        for leaf in &leaves {
            assert!(
                fixture
                    .commands
                    .iter()
                    .any(|e| &e.command == leaf && e.exit == 0),
                "叶子 {leaf} 缺成功条目"
            );
            assert!(
                fixture
                    .commands
                    .iter()
                    .any(|e| &e.command == leaf && e.exit != 0),
                "叶子 {leaf} 缺代表性错误条目"
            );
        }
    }

    /// 夹具条目的包络族与形态骨架顶层键集一致：data 包络＝`success`＋`data`；
    /// 错误包络＝`success`＋`error`；顶层自定契约含 `success` 且不套 `data`。
    #[test]
    fn contract_entries_declare_consistent_envelope_family() {
        for entry in contract_fixture::parse().commands {
            let keys: BTreeSet<&str> = entry.shape["keys"]
                .as_object()
                .unwrap_or_else(|| panic!("{}: shape 顶层须为 object", entry.id))
                .keys()
                .map(String::as_str)
                .collect();
            match entry.envelope.as_str() {
                "data" => {
                    assert_eq!(keys, BTreeSet::from(["data", "success"]), "{}", entry.id);
                    assert_eq!(entry.exit, 0, "{}: data 包络恒为成功", entry.id);
                }
                "error" => {
                    assert_eq!(keys, BTreeSet::from(["error", "success"]), "{}", entry.id);
                    assert_ne!(entry.exit, 0, "{}: 错误包络恒为非零 exit", entry.id);
                }
                "topLevel" => {
                    assert!(keys.contains("success"), "{}", entry.id);
                    assert!(!keys.contains("data"), "{}: 顶层契约不套 data", entry.id);
                }
                other => panic!("{}: 未知包络族 {other}", entry.id),
            }
        }
    }

    /// 闭合词表对账：夹具 `vocab` 与 domain 源码常量集合相等（执行状态词
    /// 取 `STATUS_*`；校验问题码取 `issue_codes` 模块全部常量）——词表
    /// 扩值不同步夹具即失败。
    #[test]
    fn vocabulary_sets_match_domain_sources() {
        let fixture = contract_fixture::parse();
        let status_values: BTreeSet<String> =
            contract_fixture::string_consts(include_str!("../domain/workflow_execution.rs"))
                .into_iter()
                .filter(|(name, _)| name.starts_with("STATUS_"))
                .map(|(_, value)| value)
                .collect();
        assert_eq!(status_values.len(), 4, "执行状态词四值：{status_values:?}");
        assert_eq!(
            fixture
                .vocab
                .execution_status
                .into_iter()
                .collect::<BTreeSet<_>>(),
            status_values
        );

        let issue_values: BTreeSet<String> =
            contract_fixture::string_consts(contract_fixture::block_after(
                include_str!("../domain/workflow_validation.rs"),
                "pub mod issue_codes {",
            ))
            .into_iter()
            .map(|(_, value)| value)
            .collect();
        assert!(!issue_values.is_empty(), "校验问题码提取不得为空");
        assert_eq!(
            fixture
                .vocab
                .issue_codes
                .into_iter()
                .collect::<BTreeSet<_>>(),
            issue_values
        );
    }

    #[test]
    fn json_flag_is_global_in_both_positions() {
        let cli = Cli::try_parse_from(["apilot", "--json", "api", "list"]).unwrap();
        assert!(cli.json);
        let cli = Cli::try_parse_from(["apilot", "api", "list", "--json"]).unwrap();
        assert!(cli.json, "--json 放子命令之后同样生效（global）");
    }

    #[test]
    fn json_short_flag_and_show_secrets_are_global() {
        let cli = Cli::try_parse_from(["apilot", "-j", "project", "info"]).unwrap();
        assert!(cli.json && !cli.show_secrets);
        let cli = Cli::try_parse_from(["apilot", "project", "info", "--show-secrets"]).unwrap();
        assert!(cli.show_secrets && !cli.json);
    }

    /// `--workspace` 与 `--json` 同惯例：global 旗标，命令前后位置均可。
    #[test]
    fn workspace_flag_is_global_in_both_positions() {
        let cli = Cli::try_parse_from(["apilot", "--workspace", "流水线", "api", "list"]).unwrap();
        assert_eq!(cli.workspace.as_deref(), Some("流水线"));
        let cli =
            Cli::try_parse_from(["apilot", "workflow", "list", "--workspace", "w-1"]).unwrap();
        assert_eq!(cli.workspace.as_deref(), Some("w-1"));
    }

    /// 缺省路径钉住：不带 `--workspace` 时解析为 None——分发层走既有
    /// 「当前工作空间」链，既有 CI 脚本零破坏的解析侧保证。
    #[test]
    fn workspace_flag_defaults_to_none() {
        let cli = Cli::try_parse_from(["apilot", "api", "list"]).unwrap();
        assert!(cli.workspace.is_none());
        let cli = Cli::try_parse_from(["apilot", "workflow", "run", "wf_x"]).unwrap();
        assert!(cli.workspace.is_none());
    }

    /// 解析接线：缺省（None）＝当前工作空间（settings 链现状不变）；
    /// 指定名称 / id＝定位目标空间；不存在＝`INVALID_ARGUMENT`（exit 2）
    /// 且消息不携带现存空间名称（不泄露存在性）。
    #[tokio::test]
    async fn resolve_workspace_wires_spec_to_reference_lookup() {
        use crate::infrastructure::workspace_repo::test_support::seed_workspace;

        let dir = std::env::temp_dir().join(format!(
            "apilot2-cli-ws-resolve-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let ctx = AppContext::new(dir.clone()).await.unwrap();
        let current = resolve_workspace(&ctx, None).await.unwrap();
        assert_eq!(current.name, "默认工作空间", "缺省＝当前工作空间（现状链）");

        seed_workspace(&ctx.db.pool, "w-line", "流水线空间").await;

        // 按名称定位目标空间；缺省链不受影响（不改当前空间键）
        let by_name = resolve_workspace(&ctx, Some("流水线空间")).await.unwrap();
        assert_eq!(by_name.id, "w-line");
        let by_id = resolve_workspace(&ctx, Some("w-line")).await.unwrap();
        assert_eq!(by_id.id, "w-line");
        let still_current = resolve_workspace(&ctx, None).await.unwrap();
        assert_eq!(still_current.id, current.id, "只读定位不改当前空间");

        // 不存在：INVALID_ARGUMENT＋不泄露其他空间存在性
        let err = resolve_workspace(&ctx, Some("不存在的空间"))
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);
        assert_eq!(error::exit_code_for(&err.code), 2);
        assert!(
            !err.message.contains("默认工作空间") && !err.message.contains("流水线空间"),
            "错误消息不得枚举现存空间: {}",
            err.message
        );

        ctx.db.pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn command_tree_covers_all_commands() {
        // --help 验收的静态对偶：全部命令必须在树内
        let cmd = Cli::command();
        let api = cmd.find_subcommand("api").expect("api subcommand");
        let api_names: Vec<&str> = api.get_subcommands().map(|c| c.get_name()).collect();
        for name in ["list", "search", "get", "run"] {
            assert!(api_names.contains(&name), "api 组缺 {name}");
        }
        let project = cmd.find_subcommand("project").expect("project subcommand");
        assert!(project.get_subcommands().any(|c| c.get_name() == "info"));
        let workflow = cmd
            .find_subcommand("workflow")
            .expect("workflow subcommand");
        let workflow_names: Vec<&str> = workflow.get_subcommands().map(|c| c.get_name()).collect();
        for name in ["list", "get", "validate", "run"] {
            assert!(workflow_names.contains(&name), "workflow 组缺 {name}");
        }
        // run 组仅余 status（工作流执行状态查询；历史查询子命令已下架）
        let run = cmd.find_subcommand("run").expect("run subcommand");
        let run_names: Vec<&str> = run.get_subcommands().map(|c| c.get_name()).collect();
        assert_eq!(run_names, vec!["status"], "run 组仅余 status");
    }

    /// 裁剪回归：已下架的 run 组子命令与已移除的 `--env` 旗标均为 clap
    /// 用法错误（exit 2），不进入分发层。
    #[test]
    fn pruned_run_group_and_env_flag_are_usage_errors() {
        for args in [
            vec!["apilot", "run", "list"],
            vec!["apilot", "run", "get", "run_x"],
            vec!["apilot", "run", "result", "run_x"],
            vec!["apilot", "api", "run", "GET /users", "--env", "dev"],
        ] {
            let err = Cli::try_parse_from(args.clone()).unwrap_err();
            assert_eq!(err.exit_code(), 2, "{args:?}");
        }
    }

    /// `api run` 参数表静态断言：`--env` 移除后，覆写旗标集保持完整。
    #[test]
    fn api_run_argument_table_has_no_env_flag() {
        let cmd = Cli::command();
        let run_cmd = cmd
            .find_subcommand("api")
            .expect("api subcommand")
            .find_subcommand("run")
            .expect("run subcommand");
        let arg_ids: Vec<&str> = run_cmd
            .get_arguments()
            .map(|a| a.get_id().as_str())
            .collect();
        assert!(!arg_ids.contains(&"env"), "--env 已随变量域收归 GUI 而移除");
        for id in ["id", "service", "params", "queries", "headers", "body"] {
            assert!(arg_ids.contains(&id), "api run 缺参数 {id}");
        }
    }

    #[test]
    fn get_takes_optional_service_flag() {
        let cli = Cli::try_parse_from(["apilot", "api", "get", "GET /users"]).unwrap();
        match cli.command {
            Some(Commands::Api(api)) => match api.command {
                ApiSub::Get { id, service } => {
                    assert_eq!(id, "GET /users");
                    assert_eq!(service, None);
                }
                other => panic!("expected get, got {other:?}"),
            },
            other => panic!("expected api, got {other:?}"),
        }
        let cli = Cli::try_parse_from([
            "apilot",
            "api",
            "get",
            "GET /users",
            "--service",
            "用户服务",
        ])
        .unwrap();
        match cli.command {
            Some(Commands::Api(api)) => match api.command {
                ApiSub::Get { service, .. } => assert_eq!(service.as_deref(), Some("用户服务")),
                other => panic!("expected get, got {other:?}"),
            },
            other => panic!("expected api, got {other:?}"),
        }
    }

    #[test]
    fn version_and_name_are_pinned() {
        let cmd = Cli::command();
        assert_eq!(cmd.get_name(), "apilot");
        assert_eq!(cmd.get_version(), Some(env!("CARGO_PKG_VERSION")));
    }

    /// 四读命令全部映射 READ（权限表与命令树同源，编译器穷尽性兜底新增命令）。
    #[test]
    fn four_read_commands_map_to_read_level() {
        for args in [
            vec!["apilot", "project", "info"],
            vec!["apilot", "api", "list"],
            vec!["apilot", "api", "search", "用户"],
            vec!["apilot", "api", "get", "GET /users"],
        ] {
            let cli = Cli::try_parse_from(args.clone()).unwrap();
            let command = cli.command.expect("subcommand must parse");
            assert_eq!(command.permission(), PermissionLevel::Read, "{args:?}");
            assert!(authorize(command.permission()).is_ok(), "{args:?}");
        }
    }

    /// 执行域命令（api run＝资源消耗动作）映射 EXECUTE：默认策略放行，
    /// 不落 WRITE 的 fail-closed 拒绝线。
    #[test]
    fn api_run_maps_to_execute_level() {
        let cli = Cli::try_parse_from(["apilot", "api", "run", "GET /users"]).unwrap();
        let command = cli.command.expect("subcommand must parse");
        assert_eq!(command.permission(), PermissionLevel::Execute);
        assert!(authorize(command.permission()).is_ok());
    }

    /// 拒绝路径：WRITE（配置未落地 fail-closed）与 DANGEROUS（恒拒）均
    /// PERMISSION_DENIED，经 exit 映射为 5。
    #[test]
    fn write_and_dangerous_levels_are_rejected_with_permission_denied() {
        for level in [PermissionLevel::Write, PermissionLevel::Dangerous] {
            let err = authorize(level).unwrap_err();
            assert_eq!(err.code, codes::PERMISSION_DENIED, "{level:?}");
            assert_eq!(error::exit_code_for(&err.code), 5);
        }
        assert!(authorize(PermissionLevel::Execute).is_ok());
    }
}
