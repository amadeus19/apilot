//! 工作流域 Application Service：编辑模型 CRUD 与空间作用域读取面
//! （GUI 与 CLI 的共同业务面，Command / CLI 皆薄壳）。
//!
//! 职责：名称校验、图 JSON 解析单点（读侧损坏报 `WORKFLOW_GRAPH_INVALID`
//! 不静默）、存在性校验（not-found 族，含「跨空间 id 视同不存在、不泄露
//! 存在性」的作用域读取语义）、执行终态记录的空间作用域查询；不做执行、
//! 不做执行前校验——两者分属执行引擎与校验器的职责面。

use serde::Serialize;
use sqlx::SqlitePool;

use crate::domain::endpoint::new_manual_identity;
use crate::domain::validate::normalize_name;
use crate::domain::workflow::{
    GRAPH_SCHEMA_VERSION, NewWorkflow, Workflow, WorkflowGraph, WorkflowNodeConfig,
    has_enabled_category_writeback, masked_graph_for_display, referenced_endpoint_keys,
};
use crate::domain::workflow_execution::WorkflowExecution;
use crate::error::AppError;
use crate::error::codes;
use crate::infrastructure::workflow_execution_repo;
use crate::infrastructure::workflow_repo;
use crate::infrastructure::workspace_repo;

/// 工作流清单行 DTO（第五视图行渲染面；不含图）。
/// groupId None＝未分组；lastStatus＝最近一次执行终态词（无记录＝None；
/// running 过程态不入清单——在途态由事件流驱动；清单行不呈现，随清单
/// 下发的元数据）；hasWriteback＝图内任一存变量节点开启分类写回（图配置
/// 判定非执行态，同为下发的元数据）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSummaryDto {
    pub id: String,
    pub name: String,
    pub group_id: Option<String>,
    pub last_status: Option<String>,
    pub has_writeback: bool,
    pub updated_at: String,
}

/// 工作流清单 DTO。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowListDto {
    pub items: Vec<WorkflowSummaryDto>,
}

/// 工作流完整 DTO（编辑 Tab 加载面：图随行）。groupId None＝未分组。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDto {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub graph: WorkflowGraph,
    pub group_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 粘贴未命中条目（跨空间粘贴的解析报告行）：定位单元＝引用节点，稳定键
/// 原样留痕（失效节点的重接与展示锚点），reason 区分未命中原因。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPasteMiss {
    pub node_id: String,
    pub endpoint_key: String,
    /// notFound（目标空间无此键）| ambiguous（多服务撞车，同校验失效语义）
    pub reason: String,
}

/// 粘贴未命中原因词表（前端按词表走 i18n 词典，未知值回落 key 原文）。
pub mod paste_miss_reasons {
    pub const NOT_FOUND: &str = "notFound";
    pub const AMBIGUOUS: &str = "ambiguous";
}

/// 跨空间粘贴报告：落地实体＋引用解析统计（命中计数＋未命中清单）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPasteReport {
    pub workflow: WorkflowDto,
    pub hit_count: u32,
    pub misses: Vec<WorkflowPasteMiss>,
}

/// 存储行 → 清单 DTO。写回标记经 [`parse_graph`] 解析 graph 列判定（清单
/// SELECT 已带列）；损坏图回落 false——清单不因单行损坏整页报错，读侧拒绝
/// 语义留在 [`dto_of`] 的 `WORKFLOW_GRAPH_INVALID`（两层分工：清单尽力呈现，
/// 加载面拒绝损坏数据）。
fn summary_of(row: workflow_repo::WorkflowListRow) -> WorkflowSummaryDto {
    let has_writeback = crate::domain::workflow::parse_graph(&row.workflow.graph)
        .map(|graph| has_enabled_category_writeback(&graph))
        .unwrap_or(false);
    WorkflowSummaryDto {
        id: row.workflow.id,
        name: row.workflow.name,
        group_id: row.workflow.group_id,
        last_status: row.last_status,
        has_writeback,
        updated_at: row.workflow.updated_at,
    }
}

/// 存储行 → 完整 DTO；graph 解析失败报 `WORKFLOW_GRAPH_INVALID`（读侧拒绝）。
fn dto_of(row: Workflow) -> Result<WorkflowDto, AppError> {
    let graph = parse_or_graph_invalid(&row.graph, &row.id)?;
    Ok(WorkflowDto {
        id: row.id,
        workspace_id: row.workspace_id,
        name: row.name,
        graph,
        group_id: row.group_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

/// 按 id 取工作流；不存在转 `WORKFLOW_NOT_FOUND`（校验编排等域内服务共用）。
pub(crate) async fn get_or_not_found(pool: &SqlitePool, id: &str) -> Result<Workflow, AppError> {
    workflow_repo::get(pool, id).await?.ok_or_else(|| {
        AppError::new(
            codes::WORKFLOW_NOT_FOUND,
            format!("workflow not found: {id}"),
        )
    })
}

/// 确认目标空间存在；不存在转 `WORKSPACE_NOT_FOUND`（写入类操作共用前置）。
async fn ensure_workspace(pool: &SqlitePool, workspace_id: &str) -> Result<(), AppError> {
    workspace_repo::get(pool, workspace_id)
        .await?
        .ok_or_else(|| {
            AppError::new(
                codes::WORKSPACE_NOT_FOUND,
                format!("workspace not found: {workspace_id}"),
            )
        })?;
    Ok(())
}

/// graph 列 JSON → 图模型（服务层读侧单点：损坏报 `WORKFLOW_GRAPH_INVALID`）。
pub(crate) fn parse_or_graph_invalid(raw: &str, id: &str) -> Result<WorkflowGraph, AppError> {
    crate::domain::workflow::parse_graph(raw).map_err(|err| {
        AppError::new(
            codes::WORKFLOW_GRAPH_INVALID,
            format!("workflow graph is corrupt: {err}"),
        )
        .with_details(serde_json::json!({ "workflowId": id }))
    })
}

/// 工作空间内工作流清单（创建序；行含分组归属与最近一次执行终态）。
pub async fn list(pool: &SqlitePool, workspace_id: &str) -> Result<WorkflowListDto, AppError> {
    let rows = workflow_repo::list_with_last_status(pool, workspace_id).await?;
    Ok(WorkflowListDto {
        items: rows.into_iter().map(summary_of).collect(),
    })
}

/// 加载工作流完整图（编辑 Tab 打开面）。
pub async fn load(pool: &SqlitePool, id: &str) -> Result<WorkflowDto, AppError> {
    dto_of(get_or_not_found(pool, id).await?)
}

/// 空间作用域读取单工作流：跨空间 id 与不存在同报 `WORKFLOW_NOT_FOUND`
/// （不泄露存在性；作用域语义的单点，GUI 多窗口定位与 CLI 读取共用）。
pub async fn get_in_workspace(
    pool: &SqlitePool,
    id: &str,
    workspace_id: &str,
) -> Result<Workflow, AppError> {
    workflow_repo::get(pool, id)
        .await?
        .filter(|row| row.workspace_id == workspace_id)
        .ok_or_else(|| {
            AppError::new(
                codes::WORKFLOW_NOT_FOUND,
                format!("workflow not found: {id}"),
            )
        })
}

/// 空间作用域读取工作流执行终态记录：跨空间执行与不存在同报
/// `RUN_NOT_FOUND`（不泄露存在性；作用域过滤在基础设施 JOIN 单点）。
pub async fn get_execution_in_workspace(
    pool: &SqlitePool,
    run_id: &str,
    workspace_id: &str,
) -> Result<WorkflowExecution, AppError> {
    workflow_execution_repo::get_by_id_in_workspace(pool, run_id, workspace_id)
        .await?
        .ok_or_else(|| AppError::new(codes::RUN_NOT_FOUND, format!("run not found: {run_id}")))
}

/// 新建工作流（空图起步；名称经 normalize 校验）。
pub async fn create(
    pool: &SqlitePool,
    workspace_id: &str,
    name: &str,
) -> Result<WorkflowDto, AppError> {
    let name = normalize_name(name)?;
    ensure_workspace(pool, workspace_id).await?;
    let created = workflow_repo::insert(
        pool,
        &NewWorkflow {
            id: new_manual_identity(),
            workspace_id: workspace_id.to_owned(),
            name,
            graph: serde_json::to_string(&WorkflowGraph::empty())
                .map_err(|err| AppError::internal(format!("empty graph encode failed: {err}")))?,
            group_id: None,
        },
    )
    .await?;
    dto_of(created)
}

/// 跨空间粘贴：图原样落地为全新工作流（与本地新建零差异、无来源标记），
/// 名称由调用方决定（前端预填「副本」后缀、可改）。请求引用按稳定键在
/// 目标空间树内解析——唯一命中计入命中数；0 / 多命中逐节点记入未命中清单
/// （节点保持稳定键留痕转失效态，失效本身是校验解析派生态不落库）。命中
/// 不改写引用（稳定键跨空间同构即同键）。未绑定请求节点无解析面，不进报告。
pub async fn paste(
    pool: &SqlitePool,
    workspace_id: &str,
    name: &str,
    graph: &WorkflowGraph,
) -> Result<WorkflowPasteReport, AppError> {
    let name = normalize_name(name)?;
    ensure_workspace(pool, workspace_id).await?;
    let mut hit_count = 0u32;
    let mut misses = Vec::new();
    for key in referenced_endpoint_keys(graph) {
        let hits =
            crate::services::workflow_validate::resolve_endpoint_hits(pool, workspace_id, &key)
                .await?;
        match hits.len() {
            1 => hit_count += 1,
            0 => push_misses(graph, &key, paste_miss_reasons::NOT_FOUND, &mut misses),
            _ => push_misses(graph, &key, paste_miss_reasons::AMBIGUOUS, &mut misses),
        }
    }
    let raw = serde_json::to_string(graph)
        .map_err(|err| AppError::internal(format!("workflow graph encode failed: {err}")))?;
    let created = workflow_repo::insert(
        pool,
        &NewWorkflow {
            id: new_manual_identity(),
            workspace_id: workspace_id.to_owned(),
            name,
            graph: raw,
            group_id: None,
        },
    )
    .await?;
    Ok(WorkflowPasteReport {
        workflow: dto_of(created)?,
        hit_count,
        misses,
    })
}

/// 同一键的全部引用节点逐个记入未命中清单（清单可定位到节点，一键多节点
/// 各占一行）。
fn push_misses(
    graph: &WorkflowGraph,
    key: &str,
    reason: &str,
    misses: &mut Vec<WorkflowPasteMiss>,
) {
    for node in &graph.nodes {
        if let WorkflowNodeConfig::Request(config) = &node.config
            && config.endpoint_key.as_deref() == Some(key)
        {
            misses.push(WorkflowPasteMiss {
                node_id: node.id.clone(),
                endpoint_key: key.to_owned(),
                reason: reason.to_owned(),
            });
        }
    }
}

// —— 导出 / 导入（文件分发面：文件格式＝封皮＋图原样，导入复用粘贴解析链） ——

/// 导出文件封皮格式版本（封皮自身演进版本，与图结构版本解耦）。
pub const EXPORT_FORMAT_VERSION: u32 = 1;

/// 工作流导出文件（`.json`）完整形态：最小封皮＋图原样（节点＋边＋覆写＋
/// 提取/存变量配置＋分类快照名）。导出落盘前图经 [`masked_graph_for_display`]
/// 读时脱敏投影——敏感覆写字面量替换为掩码，文件可直接分发；导入按封皮
/// `schema_version` 做版本闸（高于当前支持 → 拒收）后走粘贴解析链。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowExportFile {
    pub format_version: u32,
    pub name: String,
    /// 描述（工作流模型暂无描述字段，导出恒 None；封皮前向兼容位）
    pub description: Option<String>,
    /// 导出时的图结构版本（导入版本闸的判定单点）
    pub schema_version: u32,
    pub graph: WorkflowGraph,
}

/// 导出结果 DTO（IPC 面）：落盘路径回显（路径由前端系统对话框选定）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowExportResultDto {
    pub path: String,
}

/// 导出工作流到指定路径：空间作用域读取（跨空间 id 与不存在同报
/// `WORKFLOW_NOT_FOUND`，不泄露存在性——与导入的目标空间前置同口径）；
/// 图取落库态（文件分发语义，编辑会话态不入导出），序列化前经
/// [`masked_graph_for_display`] 投影——敏感覆写值替换为掩码字面量（与
/// CLI get 头行同源，不另立标准），落库本体不被投影改动。
pub async fn export(
    pool: &SqlitePool,
    workspace_id: &str,
    id: &str,
    path: &str,
) -> Result<WorkflowExportResultDto, AppError> {
    let row = get_in_workspace(pool, id, workspace_id).await?;
    let graph = parse_or_graph_invalid(&row.graph, &row.id)?;
    let file = WorkflowExportFile {
        format_version: EXPORT_FORMAT_VERSION,
        name: row.name,
        description: None,
        schema_version: GRAPH_SCHEMA_VERSION,
        graph: masked_graph_for_display(&graph),
    };
    let json = serde_json::to_string_pretty(&file)
        .map_err(|err| AppError::internal(format!("workflow export encode failed: {err}")))?;
    tokio::fs::write(path, json).await.map_err(|err| {
        AppError::new(
            codes::WORKFLOW_EXPORT_WRITE_FAILED,
            format!("workflow export write failed: {err}"),
        )
    })?;
    Ok(WorkflowExportResultDto {
        path: path.to_owned(),
    })
}

/// 从导出文件导入为全新工作流：封皮图结构版本高于当前支持 → 拒收
/// （`WORKFLOW_IMPORT_VERSION_UNSUPPORTED`，不静默降级）；低版本 / 相等 →
/// 尽力解析（serde 缺字段回落）。解析后复用 [`paste`] 解析链——请求引用按
/// 稳定键在目标空间解析、未命中转失效＋报告，与粘贴报告同形态。文件读取
/// 与封皮解析失败一律报 `WORKFLOW_GRAPH_INVALID`（所选文件不是可导入的
/// 导出文件，不区分损坏原因细节）。
pub async fn import(
    pool: &SqlitePool,
    workspace_id: &str,
    path: &str,
) -> Result<WorkflowPasteReport, AppError> {
    let raw = tokio::fs::read_to_string(path).await.map_err(|err| {
        AppError::new(
            codes::WORKFLOW_GRAPH_INVALID,
            format!("workflow import file unreadable: {err}"),
        )
    })?;
    let file: WorkflowExportFile = serde_json::from_str(&raw).map_err(|err| {
        AppError::new(
            codes::WORKFLOW_GRAPH_INVALID,
            format!("workflow import file invalid: {err}"),
        )
    })?;
    if file.schema_version > GRAPH_SCHEMA_VERSION {
        return Err(AppError::new(
            codes::WORKFLOW_IMPORT_VERSION_UNSUPPORTED,
            format!(
                "workflow export schema version {} is newer than supported {}",
                file.schema_version, GRAPH_SCHEMA_VERSION
            ),
        )
        .with_details(serde_json::json!({
            "schemaVersion": file.schema_version,
            "supported": GRAPH_SCHEMA_VERSION,
        })));
    }
    paste(pool, workspace_id, &file.name, &file.graph).await
}

/// 重命名。
pub async fn rename(pool: &SqlitePool, id: &str, name: &str) -> Result<WorkflowDto, AppError> {
    let name = normalize_name(name)?;
    get_or_not_found(pool, id).await?;
    let renamed = workflow_repo::rename(pool, id, &name).await?;
    dto_of(renamed)
}

/// 保存图（编辑器 Ctrl+S 通道；保存不做执行前校验——半成品可留）。
/// 图的合法性门槛＝反序列化成功（判别联合闭合）；语义校验归执行前校验器。
pub async fn save(
    pool: &SqlitePool,
    id: &str,
    graph: &WorkflowGraph,
) -> Result<WorkflowDto, AppError> {
    get_or_not_found(pool, id).await?;
    let raw = serde_json::to_string(graph)
        .map_err(|err| AppError::internal(format!("workflow graph encode failed: {err}")))?;
    let saved = workflow_repo::save_graph(pool, id, &raw).await?;
    dto_of(saved)
}

/// 删除工作流（硬删除）。
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    if !workflow_repo::delete(pool, id).await? {
        return Err(AppError::new(
            codes::WORKFLOW_NOT_FOUND,
            format!("workflow not found: {id}"),
        ));
    }
    Ok(())
}

// —— 分组（第五视图分组树；组内成员随组删回落未分组） ——

/// 工作流分组 DTO。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowGroupDto {
    pub id: String,
    pub name: String,
    pub created_at: String,
}

/// 分组清单 DTO。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowGroupListDto {
    pub items: Vec<WorkflowGroupDto>,
}

fn group_dto_of(row: crate::domain::workflow::WorkflowGroup) -> WorkflowGroupDto {
    WorkflowGroupDto {
        id: row.id,
        name: row.name,
        created_at: row.created_at,
    }
}

/// 分组清单（创建序＝树内组序）。
pub async fn list_groups(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Result<WorkflowGroupListDto, AppError> {
    let rows = workflow_repo::list_groups(pool, workspace_id).await?;
    Ok(WorkflowGroupListDto {
        items: rows.into_iter().map(group_dto_of).collect(),
    })
}

/// 新建分组（同空间组名唯一；重名报 `WORKFLOW_GROUP_NAME_EXISTS`）。
pub async fn create_group(
    pool: &SqlitePool,
    workspace_id: &str,
    name: &str,
) -> Result<WorkflowGroupDto, AppError> {
    let name = normalize_name(name)?;
    ensure_workspace(pool, workspace_id).await?;
    ensure_group_name_free(pool, workspace_id, &name, None).await?;
    let created = workflow_repo::insert_group(
        pool,
        &crate::domain::workflow::NewWorkflowGroup {
            id: new_manual_identity(),
            workspace_id: workspace_id.to_owned(),
            name,
        },
    )
    .await?;
    Ok(group_dto_of(created))
}

/// 分组重命名（唯一性校验排除自身）。
pub async fn rename_group(
    pool: &SqlitePool,
    id: &str,
    name: &str,
) -> Result<WorkflowGroupDto, AppError> {
    let name = normalize_name(name)?;
    let group = workflow_repo::get_group(pool, id).await?.ok_or_else(|| {
        AppError::new(
            codes::WORKFLOW_NOT_FOUND,
            format!("workflow group not found: {id}"),
        )
    })?;
    ensure_group_name_free(pool, &group.workspace_id, &name, Some(id)).await?;
    let renamed = workflow_repo::rename_group(pool, id, &name).await?;
    Ok(group_dto_of(renamed))
}

/// 删除分组（硬删除；组内工作流经 FK SET NULL 回落未分组，工作流本体不动）。
pub async fn delete_group(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    if !workflow_repo::delete_group(pool, id).await? {
        return Err(AppError::new(
            codes::WORKFLOW_NOT_FOUND,
            format!("workflow group not found: {id}"),
        ));
    }
    Ok(())
}

/// 设置工作流所属分组（groupId None＝移出分组；组必须存在且属同一空间）。
pub async fn set_group(
    pool: &SqlitePool,
    id: &str,
    group_id: Option<&str>,
) -> Result<WorkflowDto, AppError> {
    let workflow = get_or_not_found(pool, id).await?;
    if let Some(group_id) = group_id {
        let group = workflow_repo::get_group(pool, group_id)
            .await?
            .ok_or_else(|| {
                AppError::new(
                    codes::WORKFLOW_NOT_FOUND,
                    format!("workflow group not found: {group_id}"),
                )
            })?;
        if group.workspace_id != workflow.workspace_id {
            return Err(AppError::new(
                codes::WORKFLOW_NOT_FOUND,
                format!("workflow group not in workflow workspace: {group_id}"),
            ));
        }
    }
    let updated = workflow_repo::set_group(pool, id, group_id).await?;
    dto_of(updated)
}

/// 移动工作流到目标分组（None＝未分组）的目标位置（树拖拽排序通道）：
/// 目标分组可选且必须存在且属同一空间；index 越界钳制归 repo。
pub async fn move_workflow(
    pool: &SqlitePool,
    id: &str,
    target_group_id: Option<&str>,
    index: i64,
) -> Result<(), AppError> {
    let workflow = get_or_not_found(pool, id).await?;
    if let Some(group_id) = target_group_id {
        let group = workflow_repo::get_group(pool, group_id)
            .await?
            .ok_or_else(|| {
                AppError::new(
                    codes::WORKFLOW_NOT_FOUND,
                    format!("workflow group not found: {group_id}"),
                )
            })?;
        if group.workspace_id != workflow.workspace_id {
            return Err(AppError::new(
                codes::WORKFLOW_NOT_FOUND,
                format!("workflow group not in workflow workspace: {group_id}"),
            ));
        }
    }
    workflow_repo::move_workflow(&mut *pool.acquire().await?, id, target_group_id, index).await
}

/// 移动分组到空间内分组序列的目标位置（树拖拽排序通道；不跨空间）。
pub async fn move_group(pool: &SqlitePool, id: &str, index: i64) -> Result<(), AppError> {
    if workflow_repo::get_group(pool, id).await?.is_none() {
        return Err(AppError::new(
            codes::WORKFLOW_NOT_FOUND,
            format!("workflow group not found: {id}"),
        ));
    }
    workflow_repo::move_group(&mut *pool.acquire().await?, id, index).await
}

/// 同空间组名唯一性闸门（新建与改名共用；命中报 `WORKFLOW_GROUP_NAME_EXISTS`）。
async fn ensure_group_name_free(
    pool: &SqlitePool,
    workspace_id: &str,
    name: &str,
    exclude_id: Option<&str>,
) -> Result<(), AppError> {
    if workflow_repo::group_name_exists(pool, workspace_id, name, exclude_id).await? {
        return Err(AppError::new(
            codes::WORKFLOW_GROUP_NAME_EXISTS,
            format!("workflow group name already exists: {name}"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::domain::workflow::{
        self, OverrideRow, Position, RequestNodeConfig, WorkflowEdge, WorkflowNode,
        WorkflowNodeConfig,
    };
    use sqlx::SqlitePool;

    async fn memory_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        pool
    }

    async fn seeded_pool() -> SqlitePool {
        let pool = memory_pool().await;
        crate::infrastructure::workspace_repo::test_support::seed_workspace(&pool, "w1", "空间")
            .await;
        pool
    }

    /// CRUD 全链：新建 → 清单可见 → 重命名 → 加载图一致 → 删除后清单为空。
    #[tokio::test]
    async fn create_list_rename_load_delete_roundtrip() {
        let pool = seeded_pool().await;
        let created = create(&pool, "w1", "登录链").await.unwrap();
        assert_eq!(created.name, "登录链");
        assert_eq!(created.workspace_id, "w1");
        assert_eq!(created.graph.schema_version, workflow::GRAPH_SCHEMA_VERSION);
        assert!(created.graph.nodes.is_empty());

        let listing = list(&pool, "w1").await.unwrap();
        assert_eq!(listing.items.len(), 1);
        assert_eq!(listing.items[0].id, created.id);
        assert_eq!(listing.items[0].name, "登录链");

        let renamed = rename(&pool, &created.id, "登录链 · 二").await.unwrap();
        assert_eq!(renamed.name, "登录链 · 二");
        // 加载面图不变
        let loaded = load(&pool, &created.id).await.unwrap();
        assert_eq!(loaded.graph, created.graph);
        // Tab 标题同步面：重命名后 updated_at 刷新
        assert!(renamed.updated_at >= created.updated_at);

        delete(&pool, &created.id).await.unwrap();
        assert!(list(&pool, "w1").await.unwrap().items.is_empty());
        // 删除后加载转 not found
        let err = load(&pool, &created.id).await.unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_NOT_FOUND);
    }

    /// 图保存与加载往返：节点 / 边 / 位置 / 判别配置零丢失。
    #[tokio::test]
    async fn save_graph_roundtrip() {
        let pool = seeded_pool().await;
        let created = create(&pool, "w1", "链").await.unwrap();
        let graph = WorkflowGraph {
            schema_version: workflow::GRAPH_SCHEMA_VERSION,
            nodes: vec![
                WorkflowNode {
                    id: "a".into(),
                    name: "开始".into(),
                    position: Position { x: 1.5, y: -2.25 },
                    config: WorkflowNodeConfig::Start,
                },
                WorkflowNode {
                    id: "b".into(),
                    name: "请求".into(),
                    position: Position { x: 10.0, y: 20.0 },
                    config: WorkflowNodeConfig::Request(RequestNodeConfig {
                        endpoint_key: Some("get /healthz".into()),
                        ..Default::default()
                    }),
                },
            ],
            edges: vec![WorkflowEdge {
                id: "e1".into(),
                source: "a".into(),
                target: "b".into(),
                label: None,
            }],
        };
        let saved = save(&pool, &created.id, &graph).await.unwrap();
        assert_eq!(saved.graph, graph);
        // 重开（新 load 路径）同样一致
        let loaded = load(&pool, &created.id).await.unwrap();
        assert_eq!(loaded.graph, graph);
    }

    /// 名称校验：空白拒绝（NAME_INVALID）、trim 生效。
    #[tokio::test]
    async fn create_rejects_invalid_name() {
        let pool = seeded_pool().await;
        let err = create(&pool, "w1", "   ").await.unwrap_err();
        assert_eq!(err.code, codes::NAME_INVALID);
        let ok = create(&pool, "w1", "  名  ").await.unwrap();
        assert_eq!(ok.name, "名");
    }

    /// 工作空间不存在拒绝建流；清单与计数按空间隔离。
    #[tokio::test]
    async fn create_requires_existing_workspace_and_scopes_lists() {
        let pool = seeded_pool().await;
        let err = create(&pool, "missing", "链").await.unwrap_err();
        assert_eq!(err.code, codes::WORKSPACE_NOT_FOUND);

        crate::infrastructure::workspace_repo::test_support::seed_workspace(&pool, "w2", "二")
            .await;
        create(&pool, "w2", "别家链").await.unwrap();
        assert_eq!(list(&pool, "w1").await.unwrap().items.len(), 0);
        assert_eq!(list(&pool, "w2").await.unwrap().items.len(), 1);
    }

    /// 重命名 / 保存 / 删除不存在的 id 转 `WORKFLOW_NOT_FOUND`。
    #[tokio::test]
    async fn mutations_on_missing_workflow_report_not_found() {
        let pool = seeded_pool().await;
        let err = rename(&pool, "nope", "名").await.unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_NOT_FOUND);
        let err = save(&pool, "nope", &WorkflowGraph::empty())
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_NOT_FOUND);
        // delete 对缺失 id 报 not found（不静默成功）
        let err = delete(&pool, "nope").await.unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_NOT_FOUND);
    }

    /// graph 列损坏：加载报 `WORKFLOW_GRAPH_INVALID`（读侧拒绝不静默）。
    #[tokio::test]
    async fn corrupt_graph_reports_graph_invalid() {
        let pool = seeded_pool().await;
        let created = create(&pool, "w1", "链").await.unwrap();
        sqlx::query("UPDATE workflows SET graph = '{broken'")
            .bind(&created.id)
            .execute(&pool)
            .await
            .unwrap();
        let err = load(&pool, &created.id).await.unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_GRAPH_INVALID);
    }

    /// 空间作用域读取工作流：本空间命中原样返回；跨空间 id 与不存在同报
    /// `WORKFLOW_NOT_FOUND`（不泄露存在性）。
    #[tokio::test]
    async fn get_in_workspace_hides_other_workspace_rows() {
        let pool = seeded_pool().await;
        let created = create(&pool, "w1", "链").await.unwrap();
        let hit = get_in_workspace(&pool, &created.id, "w1").await.unwrap();
        assert_eq!(hit.id, created.id);
        assert_eq!(hit.workspace_id, "w1");

        crate::infrastructure::workspace_repo::test_support::seed_workspace(&pool, "w2", "二")
            .await;
        let elsewhere = create(&pool, "w2", "别家链").await.unwrap();
        let cases: [(&str, &str, &str); 3] = [
            (&created.id, "w2", "他空间行"),
            (&elsewhere.id, "w1", "本空间查他空间 id"),
            ("wf_missing", "w1", "不存在"),
        ];
        for (id, workspace_id, label) in cases {
            let err = get_in_workspace(&pool, id, workspace_id).await.unwrap_err();
            assert_eq!(err.code, codes::WORKFLOW_NOT_FOUND, "{label}");
            assert!(err.message.contains(id), "消息定位到请求 id: {err:?}");
        }
    }

    /// 空间作用域查询执行终态记录：本空间命中、跨空间执行与未知 id 同报
    /// `RUN_NOT_FOUND`（不泄露存在性）。
    #[tokio::test]
    async fn get_execution_in_workspace_scopes_by_workspace() {
        let pool = seeded_pool().await;
        let created = create(&pool, "w1", "链").await.unwrap();
        sqlx::query(
            "INSERT INTO workflow_executions \
             (id, workflow_id, status, started_at, completed_at, nodes_json) \
             VALUES ('wexec_x', ?, 'passed', 't0', 't1', '[]')",
        )
        .bind(&created.id)
        .execute(&pool)
        .await
        .unwrap();

        let hit = get_execution_in_workspace(&pool, "wexec_x", "w1")
            .await
            .unwrap();
        assert_eq!(hit.workflow_id, created.id);
        assert_eq!(hit.status, "passed");

        crate::infrastructure::workspace_repo::test_support::seed_workspace(&pool, "w2", "二")
            .await;
        for (run_id, workspace_id) in [("wexec_x", "w2"), ("wexec_missing", "w1")] {
            let err = get_execution_in_workspace(&pool, run_id, workspace_id)
                .await
                .unwrap_err();
            assert_eq!(err.code, codes::RUN_NOT_FOUND, "{run_id}/{workspace_id}");
        }
    }

    /// 删除工作空间连带清工作流（FK CASCADE）。
    #[tokio::test]
    async fn deleting_workspace_cascades_workflows() {
        let pool = seeded_pool().await;
        let created = create(&pool, "w1", "链").await.unwrap();
        sqlx::query("DELETE FROM workspaces WHERE id = 'w1'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            workflow_repo::get(&pool, &created.id)
                .await
                .unwrap()
                .is_none()
        );
    }

    // ── 跨空间粘贴（三路径：全命中 / 全未命中 / 混合） ──

    /// 请求节点构造器（键 None＝未绑定占位）。
    fn request_node(id: &str, key: Option<&str>) -> WorkflowNode {
        WorkflowNode {
            id: id.into(),
            name: String::new(),
            position: Position { x: 0.0, y: 0.0 },
            config: WorkflowNodeConfig::Request(RequestNodeConfig {
                endpoint_key: key.map(str::to_owned),
                ..Default::default()
            }),
        }
    }

    /// 双请求链图（start → r1 → r2 → end；r1/r2 键由调用方给定）。
    fn chain_graph(key1: Option<&str>, key2: Option<&str>) -> WorkflowGraph {
        WorkflowGraph {
            schema_version: workflow::GRAPH_SCHEMA_VERSION,
            nodes: vec![
                WorkflowNode {
                    id: "start".into(),
                    name: String::new(),
                    position: Position { x: 0.0, y: 0.0 },
                    config: WorkflowNodeConfig::Start,
                },
                request_node("r1", key1),
                request_node("r2", key2),
                WorkflowNode {
                    id: "end".into(),
                    name: String::new(),
                    position: Position { x: 3.0, y: 0.0 },
                    config: WorkflowNodeConfig::End,
                },
            ],
            edges: vec![
                WorkflowEdge {
                    id: "e1".into(),
                    source: "start".into(),
                    target: "r1".into(),
                    label: None,
                },
                WorkflowEdge {
                    id: "e2".into(),
                    source: "r1".into(),
                    target: "r2".into(),
                    label: None,
                },
                WorkflowEdge {
                    id: "e3".into(),
                    source: "r2".into(),
                    target: "end".into(),
                    label: None,
                },
            ],
        }
    }

    async fn seed_w2_with_service(pool: &SqlitePool) {
        crate::infrastructure::workspace_repo::test_support::seed_workspace(pool, "w2", "二空间")
            .await;
        crate::infrastructure::service_repo::test_support::seed_service(
            pool,
            "t1",
            "w2",
            "目标服务",
        )
        .await;
    }

    async fn seed_endpoint(pool: &SqlitePool, service_id: &str, key: &str) {
        let (method, path) = key.split_once(' ').unwrap();
        let definition = crate::domain::endpoint::Definition::new(
            crate::domain::endpoint::HttpMethod::parse(method).unwrap(),
            path,
        )
        .unwrap();
        crate::infrastructure::endpoint_repo::test_support::seed_endpoint_with_definition(
            pool, service_id, key, definition, "接口",
        )
        .await;
    }

    /// 全命中：报告零未命中；落地实体与本地新建零差异（图逐字段一致、
    /// 落库 JSON 无任何来源标记字段）；校验全绿（直接可运行）。
    #[tokio::test]
    async fn paste_all_hits_lands_identical_workflow() {
        let pool = seeded_pool().await;
        seed_w2_with_service(&pool).await;
        seed_endpoint(&pool, "t1", "GET /healthz").await;
        seed_endpoint(&pool, "t1", "POST /api/auth/login").await;

        let graph = chain_graph(Some("GET /healthz"), Some("POST /api/auth/login"));
        let report = paste(&pool, "w2", "登录链 - 副本", &graph).await.unwrap();
        assert_eq!(report.hit_count, 2);
        assert!(report.misses.is_empty(), "{:?}", report.misses);
        assert_eq!(report.workflow.name, "登录链 - 副本");
        assert_eq!(report.workflow.workspace_id, "w2");
        assert_eq!(report.workflow.graph, graph, "图原样落地零差异");

        // 落库 JSON 顶层无来源标记字段（与本地新建同形）
        let row = workflow_repo::get(&pool, &report.workflow.id)
            .await
            .unwrap()
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&row.graph).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["edges", "nodes", "schemaVersion"]);

        // 命中即直接可运行：执行前校验全绿
        let issues = crate::services::workflow_validate::validate(&pool, &report.workflow.id, None)
            .await
            .unwrap();
        assert!(issues.is_empty(), "{issues:?}");
    }

    /// 全未命中：照常落地；清单逐节点可定位（未绑定占位不进清单——无解析面）；
    /// 落地流的校验面报 requestInvalidRef（节点已转失效态）。
    #[tokio::test]
    async fn paste_all_misses_lands_with_locatable_misses() {
        let pool = seeded_pool().await;
        seed_w2_with_service(&pool).await;

        let mut graph = chain_graph(Some("GET /gone"), Some("POST /missing"));
        // 同键第二引用节点（清单按节点定位，一键多节点各占一行）
        let extra = request_node("r3", Some("GET /gone"));
        graph.nodes.push(extra);
        graph.edges.push(WorkflowEdge {
            id: "e4".into(),
            source: "r2".into(),
            target: "r3".into(),
            label: None,
        });
        // 未绑定占位：不进报告
        let unbound = request_node("r4", None);
        graph.nodes.push(unbound);

        let report = paste(&pool, "w2", "链 - 副本", &graph).await.unwrap();
        assert_eq!(report.hit_count, 0);
        let miss_ids: Vec<&str> = report.misses.iter().map(|m| m.node_id.as_str()).collect();
        assert_eq!(miss_ids, vec!["r1", "r3", "r2"], "定位单元＝节点");
        assert!(report.misses.iter().all(|m| m.reason == "notFound"));
        assert!(
            report.misses.iter().all(|m| m.endpoint_key != ""),
            "稳定键原样留痕"
        );

        // 照常落地：读回一致，失效态由校验派生（三个键引用节点）
        let loaded = load(&pool, &report.workflow.id).await.unwrap();
        assert_eq!(loaded.graph, graph);
        let issues = crate::services::workflow_validate::validate(&pool, &report.workflow.id, None)
            .await
            .unwrap();
        let invalid_count = issues
            .iter()
            .filter(|issue| {
                issue.code == crate::domain::workflow_validation::issue_codes::REQUEST_INVALID_REF
            })
            .count();
        assert_eq!(invalid_count, 3, "{issues:?}");
    }

    /// 混合路径：命中、未命中（notFound）、撞车（ambiguous）并存；命中计数
    /// 按键、未命中清单按节点，互不混叠。
    #[tokio::test]
    async fn paste_mixed_reports_hits_not_found_and_ambiguous() {
        let pool = seeded_pool().await;
        seed_w2_with_service(&pool).await;
        // 同键两服务＝撞车面
        crate::infrastructure::service_repo::test_support::seed_service(
            &pool,
            "t2",
            "w2",
            "撞车服务",
        )
        .await;
        seed_endpoint(&pool, "t1", "GET /healthz").await;
        seed_endpoint(&pool, "t1", "GET /dupe").await;
        seed_endpoint(&pool, "t2", "GET /dupe").await;

        let mut graph = chain_graph(Some("GET /healthz"), Some("GET /dupe"));
        graph.nodes.push(request_node("r3", Some("GET /gone")));

        let report = paste(&pool, "w2", "链", &graph).await.unwrap();
        assert_eq!(report.hit_count, 1, "仅 healthz 唯一命中");
        // 未命中清单按节点序、键按 BTreeSet 序（dupe 先于 gone）
        let reasons: Vec<(&str, &str)> = report
            .misses
            .iter()
            .map(|m| (m.node_id.as_str(), m.reason.as_str()))
            .collect();
        assert_eq!(
            reasons,
            vec![("r2", "ambiguous"), ("r3", "notFound")],
            "未命中按节点、原因按解析结果"
        );
    }

    /// 粘贴的名称校验与目标空间存在性（与 create 同口径）。
    #[tokio::test]
    async fn paste_rejects_invalid_name_and_missing_workspace() {
        let pool = seeded_pool().await;
        let graph = chain_graph(None, None);
        let err = paste(&pool, "w1", "   ", &graph).await.unwrap_err();
        assert_eq!(err.code, codes::NAME_INVALID);
        let err = paste(&pool, "nope", "名", &graph).await.unwrap_err();
        assert_eq!(err.code, codes::WORKSPACE_NOT_FOUND);
    }

    // ── 导出 / 导入（文件分发面） ──

    /// 测试专用临时目录（stdlib 组合，不引 tempfile 依赖）。
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("apilot2-wf-io-test-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 给图内 r1 请求节点追加覆写行：敏感样例名与 redact 名单同源生成
    /// （名单首项），确保断言的是名单判定本身而非硬编码猜测。
    fn with_override_rows(graph: &mut WorkflowGraph) {
        let sensitive = crate::domain::redact::SENSITIVE_HEADER_NAMES[0];
        let WorkflowNodeConfig::Request(config) = &mut graph.nodes[1].config else {
            panic!("r1 应为请求节点");
        };
        config.path_params.push(OverrideRow {
            name: sensitive.to_owned(),
            value: "Bearer live-token".into(),
        });
        config.query.push(OverrideRow {
            name: sensitive.to_owned(),
            value: "plain-key".into(),
        });
        config.query.push(OverrideRow {
            name: "page".into(),
            value: "1".into(),
        });
    }

    /// 导出脱敏往返：敏感覆写值不落明文（样例与 redact 名单同源生成，文件
    /// 中掩码出现、凭据字面量零出现）；封皮字段完整、图结构原样；落库本体
    /// 不被投影改动。
    #[tokio::test]
    async fn export_masks_sensitive_overrides_and_roundtrips() {
        let pool = seeded_pool().await;
        let created = create(&pool, "w1", "登录链").await.unwrap();
        let mut graph = chain_graph(Some("GET /healthz"), None);
        with_override_rows(&mut graph);
        save(&pool, &created.id, &graph).await.unwrap();

        let dir = temp_dir("export");
        let path = dir.join("导出.json");
        let result = export(&pool, "w1", &created.id, path.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(result.path, path.to_str().unwrap());

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("Bearer live-token"), "敏感覆写明文不落盘");
        assert!(!raw.contains("plain-key"), "敏感 query 明文不落盘");
        assert!(raw.contains(crate::domain::redact::MASK), "掩码出现");

        let file: WorkflowExportFile = serde_json::from_str(&raw).unwrap();
        assert_eq!(file.format_version, EXPORT_FORMAT_VERSION);
        assert_eq!(file.name, "登录链");
        assert_eq!(file.description, None);
        assert_eq!(file.schema_version, GRAPH_SCHEMA_VERSION);
        // 导出图恒等于读时脱敏投影（边 / 位置等非覆写结构随投影原样保留）
        assert_eq!(file.graph, masked_graph_for_display(&graph));
        let WorkflowNodeConfig::Request(config) = &file.graph.nodes[1].config else {
            panic!("请求节点形态");
        };
        assert_eq!(config.path_params[0].value, crate::domain::redact::MASK);
        assert_eq!(config.query[0].value, crate::domain::redact::MASK);
        assert_eq!(config.query[1].value, "1", "非名单行原样");

        // 落库本体不被读时投影改动
        let loaded = load(&pool, &created.id).await.unwrap();
        assert_eq!(loaded.graph, graph);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 导出空间作用域：不存在 id、跨空间 id、目标空间不存在三面同报
    /// `WORKFLOW_NOT_FOUND`（不泄露存在性——空间作用域读取单点同口径）。
    #[tokio::test]
    async fn export_missing_or_cross_workspace_reports_not_found() {
        let pool = seeded_pool().await;
        let created = create(&pool, "w1", "链").await.unwrap();
        crate::infrastructure::workspace_repo::test_support::seed_workspace(&pool, "w2", "二")
            .await;
        let dir = temp_dir("export-missing");
        let path = dir.join("x.json");
        let cases: [(&str, &str, &str); 3] = [
            ("nope", "w1", "不存在"),
            (&created.id, "w2", "他空间导他空间 id"),
            (&created.id, "missing", "目标空间不存在"),
        ];
        for (id, workspace_id, label) in cases {
            let err = export(&pool, workspace_id, id, path.to_str().unwrap())
                .await
                .unwrap_err();
            assert_eq!(err.code, codes::WORKFLOW_NOT_FOUND, "{label}");
        }
        // 合法空间组合不受误伤（导出成功）
        export(&pool, "w1", &created.id, path.to_str().unwrap())
            .await
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 导入解析链：命中稳定键计数、未命中转失效留痕——报告与粘贴同形态；
    /// 落地名称取封皮名称。
    #[tokio::test]
    async fn import_resolves_stable_keys_and_reports_like_paste() {
        let pool = seeded_pool().await;
        seed_w2_with_service(&pool).await;
        seed_endpoint(&pool, "t1", "GET /healthz").await;

        let dir = temp_dir("import");
        let path = dir.join("链.json");
        let file = WorkflowExportFile {
            format_version: EXPORT_FORMAT_VERSION,
            name: "导入链".into(),
            description: None,
            schema_version: GRAPH_SCHEMA_VERSION,
            graph: chain_graph(Some("GET /healthz"), Some("GET /gone")),
        };
        std::fs::write(&path, serde_json::to_string_pretty(&file).unwrap()).unwrap();

        let report = import(&pool, "w2", path.to_str().unwrap()).await.unwrap();
        assert_eq!(report.hit_count, 1);
        assert_eq!(report.misses.len(), 1);
        assert_eq!(report.misses[0].node_id, "r2");
        assert_eq!(report.misses[0].reason, paste_miss_reasons::NOT_FOUND);
        assert_eq!(report.workflow.name, "导入链", "落地名称取封皮");
        assert_eq!(report.workflow.workspace_id, "w2");
        assert_eq!(report.workflow.graph, file.graph, "图原样落地");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 版本闸：封皮图结构版本高于当前支持 → `WORKFLOW_IMPORT_VERSION_UNSUPPORTED`
    /// 拒收，目标空间不落地任何实体。
    #[tokio::test]
    async fn import_rejects_newer_schema_version_without_landing() {
        let pool = seeded_pool().await;
        let dir = temp_dir("import-newer");
        let path = dir.join("newer.json");
        let file = WorkflowExportFile {
            format_version: EXPORT_FORMAT_VERSION,
            name: "未来链".into(),
            description: None,
            schema_version: GRAPH_SCHEMA_VERSION + 1,
            graph: chain_graph(None, None),
        };
        std::fs::write(&path, serde_json::to_string(&file).unwrap()).unwrap();

        let err = import(&pool, "w1", path.to_str().unwrap())
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_IMPORT_VERSION_UNSUPPORTED);
        assert!(
            list(&pool, "w1").await.unwrap().items.is_empty(),
            "拒收不落地"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 低版本尽力解析：封皮 schemaVersion=1、图缺 v2 新增字段（timeoutMs）
    /// → serde default 回落继承，导入成功；旧图残留的 `header` 覆写键由
    /// serde 读侧忽略（零迁移）。
    #[tokio::test]
    async fn import_tolerates_older_graph_version() {
        let pool = seeded_pool().await;
        let dir = temp_dir("import-older");
        let path = dir.join("v1.json");
        let raw = r#"{
            "formatVersion": 1,
            "name": "旧版链",
            "description": null,
            "schemaVersion": 1,
            "graph": {
                "schemaVersion": 1,
                "nodes": [
                    { "id": "a", "name": "请求", "position": { "x": 0.0, "y": 0.0 },
                      "config": { "type": "request", "endpointKey": null,
                                  "query": [], "header": [], "body": null } }
                ],
                "edges": []
            }
        }"#;
        std::fs::write(&path, raw).unwrap();

        let report = import(&pool, "w1", path.to_str().unwrap()).await.unwrap();
        assert_eq!(report.workflow.name, "旧版链");
        let WorkflowNodeConfig::Request(config) = &report.workflow.graph.nodes[0].config else {
            panic!("请求节点形态");
        };
        assert_eq!(config.timeout_ms, None, "缺字段回落继承");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 损坏文件拒收：非法 JSON 与封皮缺字段同报 `WORKFLOW_GRAPH_INVALID`。
    #[tokio::test]
    async fn import_rejects_invalid_file() {
        let pool = seeded_pool().await;
        let dir = temp_dir("import-broken");
        let path = dir.join("broken.json");
        std::fs::write(&path, "{not json").unwrap();
        let err = import(&pool, "w1", path.to_str().unwrap())
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_GRAPH_INVALID);

        // 合法 JSON 但封皮缺图字段
        std::fs::write(&path, r#"{"formatVersion":1,"name":"残缺"}"#).unwrap();
        let err = import(&pool, "w1", path.to_str().unwrap())
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_GRAPH_INVALID);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 分组 CRUD 全链：建组入清单 → 工作流入组（清单行带 groupId）→
    /// 改名 → 删组后成员回落未分组（FK SET NULL，本体不动）。
    #[tokio::test]
    async fn group_crud_and_member_falls_back_to_ungrouped() {
        let pool = seeded_pool().await;
        let group = create_group(&pool, "w1", "登录链").await.unwrap();
        assert_eq!(group.name, "登录链");

        let created = create(&pool, "w1", "冒烟").await.unwrap();
        let grouped = set_group(&pool, &created.id, Some(&group.id))
            .await
            .unwrap();
        assert_eq!(grouped.group_id.as_deref(), Some(group.id.as_str()));

        let renamed = rename_group(&pool, &group.id, "核心链路").await.unwrap();
        assert_eq!(renamed.name, "核心链路");

        delete_group(&pool, &group.id).await.unwrap();
        let after = load(&pool, &created.id).await.unwrap();
        assert_eq!(after.group_id, None, "组删成员回落未分组");
        assert!(list_groups(&pool, "w1").await.unwrap().items.is_empty());
        // 跨空间组 id 不可作归属目标（不存在与越界同语义）
        let err = set_group(&pool, &created.id, Some("missing-group"))
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_NOT_FOUND);
    }

    /// 同空间组名唯一：新建与改名都拦；改名保留自身名放行；跨空间不冲突。
    #[tokio::test]
    async fn group_name_unique_within_workspace() {
        let pool = seeded_pool().await;
        create_group(&pool, "w1", "组").await.unwrap();
        let err = create_group(&pool, "w1", " 组 ").await.unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_GROUP_NAME_EXISTS);

        crate::infrastructure::workspace_repo::test_support::seed_workspace(&pool, "w2", "二")
            .await;
        create_group(&pool, "w2", "组").await.unwrap();

        let second = create_group(&pool, "w1", "另组").await.unwrap();
        let ok = rename_group(&pool, &second.id, "组 ").await;
        assert!(ok.is_err(), "改名为他组占用名被拦");
        let kept = rename_group(&pool, &second.id, "另组").await.unwrap();
        assert_eq!(kept.name, "另组", "排除自身后重名放行");
    }

    /// 树拖拽排序：工作流组内重排、跨组移动（归属＋目标位连带）、
    /// 未分组桶钳制尾插；目标组不存在报 `WORKFLOW_NOT_FOUND`。
    #[tokio::test]
    async fn move_workflow_reorders_within_bucket_and_moves_across() {
        let pool = seeded_pool().await;
        let group_a = create_group(&pool, "w1", "甲组").await.unwrap();
        let group_b = create_group(&pool, "w1", "乙组").await.unwrap();
        let w1 = create(&pool, "w1", "一").await.unwrap();
        let w2 = create(&pool, "w1", "二").await.unwrap();
        let w3 = create(&pool, "w1", "三").await.unwrap();
        for w in [&w1, &w2, &w3] {
            set_group(&pool, &w.id, Some(&group_a.id)).await.unwrap();
        }

        // 组内重排：三移到甲组队首
        move_workflow(&pool, &w3.id, Some(&group_a.id), 0)
            .await
            .unwrap();
        async fn bucket(pool: &SqlitePool, group_id: Option<&str>) -> Vec<String> {
            list(pool, "w1")
                .await
                .unwrap()
                .items
                .into_iter()
                .filter(|item| item.group_id.as_deref() == group_id)
                .map(|item| item.name)
                .collect()
        }
        assert_eq!(
            bucket(&pool, Some(group_a.id.as_str())).await,
            vec!["三", "一", "二"],
            "组内按目标位重排"
        );

        // 跨组移动：二进乙组（空桶）
        move_workflow(&pool, &w2.id, Some(&group_b.id), 0)
            .await
            .unwrap();
        assert_eq!(
            bucket(&pool, Some(group_a.id.as_str())).await,
            vec!["三", "一"]
        );
        assert_eq!(bucket(&pool, Some(group_b.id.as_str())).await, vec!["二"]);

        // 移出分组（未分组桶）＋越界 index 钳制尾插
        move_workflow(&pool, &w1.id, None, 99).await.unwrap();
        assert_eq!(bucket(&pool, None).await, vec!["一"]);

        let err = move_workflow(&pool, &w1.id, Some("missing-group"), 0)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_NOT_FOUND);
    }

    /// 移动通道的空间隔离：未分组桶的 group_id 全为 NULL，目标桶查询必须
    /// 按空间限定——否则他空间的未分组工作流被卷入同一序列，整桶重写会
    /// 越权改动其 sort_order 与归属。
    #[tokio::test]
    async fn move_workflow_keeps_other_workspace_ungrouped_bucket_untouched() {
        let pool = seeded_pool().await;
        crate::infrastructure::workspace_repo::test_support::seed_workspace(&pool, "w2", "二")
            .await;
        create(&pool, "w2", "他甲").await.unwrap();
        create(&pool, "w2", "他乙").await.unwrap();

        let group = create_group(&pool, "w1", "甲组").await.unwrap();
        let mine_a = create(&pool, "w1", "一").await.unwrap();
        let mine_b = create(&pool, "w1", "二").await.unwrap();

        async fn raw_order(
            pool: &SqlitePool,
            workspace_id: &str,
        ) -> Vec<(String, Option<String>, i64)> {
            sqlx::query_as(
                "SELECT id, group_id, sort_order FROM workflows \
                 WHERE workspace_id = ? ORDER BY sort_order, id",
            )
            .bind(workspace_id)
            .fetch_all(pool)
            .await
            .unwrap()
        }
        let before = raw_order(&pool, "w2").await;

        // 未分组内重排＋移入分组：两条通道都不得触及其他空间
        move_workflow(&pool, &mine_b.id, None, 0).await.unwrap();
        move_workflow(&pool, &mine_a.id, Some(&group.id), 0)
            .await
            .unwrap();

        assert_eq!(
            raw_order(&pool, "w2").await,
            before,
            "他空间未分组行的归属与序号原样保留"
        );
        let items = list(&pool, "w1").await.unwrap().items;
        let ungrouped: Vec<&str> = items
            .iter()
            .filter(|item| item.group_id.is_none())
            .map(|item| item.name.as_str())
            .collect();
        let grouped: Vec<&str> = items
            .iter()
            .filter(|item| item.group_id.as_deref() == Some(group.id.as_str()))
            .map(|item| item.name.as_str())
            .collect();
        assert_eq!(ungrouped, vec!["二"]);
        assert_eq!(grouped, vec!["一"]);
    }

    /// 右键归组与拖拽同语义：落位＝目标桶尾（不沿用源桶旧序），
    /// 反复归组按到达顺序排。
    #[tokio::test]
    async fn set_group_appends_to_target_bucket_tail() {
        let pool = seeded_pool().await;
        let group = create_group(&pool, "w1", "甲组").await.unwrap();
        let first = create(&pool, "w1", "一").await.unwrap();
        let _second = create(&pool, "w1", "二").await.unwrap();
        let third = create(&pool, "w1", "三").await.unwrap();

        // 创建序 0/1/2；按 三 → 一 的顺序归组，组内序应为到达序
        for id in [&third.id, &first.id] {
            set_group(&pool, id, Some(&group.id)).await.unwrap();
        }
        let grouped: Vec<String> = list(&pool, "w1")
            .await
            .unwrap()
            .items
            .into_iter()
            .filter(|item| item.group_id.as_deref() == Some(group.id.as_str()))
            .map(|item| item.name)
            .collect();
        assert_eq!(grouped, vec!["三", "一"], "组内序＝归组到达序");

        // 移出分组回落未分组桶尾（二仍在未分组，序：二 → 一）
        set_group(&pool, &first.id, None).await.unwrap();
        let ungrouped: Vec<String> = list(&pool, "w1")
            .await
            .unwrap()
            .items
            .into_iter()
            .filter(|item| item.group_id.is_none())
            .map(|item| item.name)
            .collect();
        assert_eq!(ungrouped, vec!["二", "一"], "移出即未分组桶尾");
    }

    /// 树拖拽排序：分组序列重排（尾组拖到队首）；组不存在报
    /// `WORKFLOW_NOT_FOUND`。
    #[tokio::test]
    async fn move_group_reorders_group_sequence() {
        let pool = seeded_pool().await;
        let _g1 = create_group(&pool, "w1", "一").await.unwrap();
        let _g2 = create_group(&pool, "w1", "二").await.unwrap();
        let g3 = create_group(&pool, "w1", "三").await.unwrap();

        move_group(&pool, &g3.id, 0).await.unwrap();
        let names: Vec<String> = list_groups(&pool, "w1")
            .await
            .unwrap()
            .items
            .into_iter()
            .map(|group| group.name)
            .collect();
        assert_eq!(names, vec!["三", "一", "二"]);

        let err = move_group(&pool, "missing-group", 0).await.unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_NOT_FOUND);
    }

    /// 清单行随执行记录带最近终态（无记录 None、有记录取终态词），
    /// 分组归属同行返回。
    #[tokio::test]
    async fn list_carries_group_and_last_status() {
        let pool = seeded_pool().await;
        let group = create_group(&pool, "w1", "组").await.unwrap();
        let created = create(&pool, "w1", "链").await.unwrap();
        set_group(&pool, &created.id, Some(&group.id))
            .await
            .unwrap();

        let items = list(&pool, "w1").await.unwrap().items;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].group_id.as_deref(), Some(group.id.as_str()));
        assert_eq!(items[0].last_status, None, "无执行记录＝未运行");

        sqlx::query(
            "INSERT INTO workflow_executions \
             (id, workflow_id, status, started_at, completed_at, nodes_json) \
             VALUES ('wx', ?, 'failed', 't0', 't1', '[]')",
        )
        .bind(&created.id)
        .execute(&pool)
        .await
        .unwrap();
        let items = list(&pool, "w1").await.unwrap().items;
        assert_eq!(items[0].last_status.as_deref(), Some("failed"));
    }

    /// 清单行带写回标记：任一提取节点开启写回分支即 true；空图 / 全关闭
    /// 为 false；损坏图回落 false 且清单不报错（读侧拒绝留在 load）。
    #[tokio::test]
    async fn list_carries_writeback_flag() {
        let pool = seeded_pool().await;
        let created = create(&pool, "w1", "链").await.unwrap();
        let items = list(&pool, "w1").await.unwrap().items;
        assert!(!items[0].has_writeback, "空图＝无写回");

        // 提取节点开启写回分支
        let mut graph = chain_graph(None, None);
        graph.nodes.insert(
            1,
            WorkflowNode {
                id: "ex1".into(),
                name: "存 token".into(),
                position: Position { x: 0.0, y: 0.0 },
                config: WorkflowNodeConfig::Extract(workflow::ExtractNodeConfig {
                    source: workflow::ExtractSource::JsonPath,
                    rules: vec![workflow::ExtractRule {
                        path: "$.token".into(),
                        name: "token".into(),
                    }],
                    writeback: workflow::ExtractWriteback {
                        enabled: true,
                        product_path: "token".into(),
                        key: "token".into(),
                        category_name: Some("登录态".into()),
                        secret: true,
                    },
                }),
            },
        );
        save(&pool, &created.id, &graph).await.unwrap();
        let items = list(&pool, "w1").await.unwrap().items;
        assert!(items[0].has_writeback, "任一提取节点开写回即标记");

        // 关闭唯一写回开关 → 回落 false
        let WorkflowNodeConfig::Extract(config) = &mut graph.nodes[1].config else {
            panic!("ex1 应为提取节点");
        };
        config.writeback.enabled = false;
        save(&pool, &created.id, &graph).await.unwrap();
        let items = list(&pool, "w1").await.unwrap().items;
        assert!(!items[0].has_writeback, "全关闭＝无标记");

        // 损坏图：清单不报错、回落 false；加载面仍按读侧拒绝报错
        sqlx::query("UPDATE workflows SET graph = 'not json' WHERE id = ?")
            .bind(&created.id)
            .execute(&pool)
            .await
            .unwrap();
        let items = list(&pool, "w1").await.unwrap().items;
        assert!(!items[0].has_writeback, "损坏图回落 false 不炸清单");
        let err = load(&pool, &created.id).await.unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_GRAPH_INVALID);
    }
}
