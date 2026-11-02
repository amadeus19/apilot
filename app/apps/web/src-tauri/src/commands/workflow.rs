//! 工作流域 IPC 命令（点分域前缀）：编辑模型 CRUD（清单 / 新建 / 重命名 /
//! 删除 / 加载 / 保存图）、文件导出导入与执行（execute / cancel，事件经
//! `workflow:event` 推送）；业务编排全部在 services 层。
//! invoke_handler 注册行由调度者统一挂载。

use tauri::State;

use crate::AppState;
use crate::domain::workflow::WorkflowGraph;
use crate::domain::workflow_validation::WorkflowIssue;
use crate::error::AppError;
use crate::services::workflow::{
    self, WorkflowDto, WorkflowExportResultDto, WorkflowGroupDto, WorkflowGroupListDto,
    WorkflowListDto, WorkflowPasteReport,
};
use crate::services::workflow_engine::{
    self as engine, WorkflowEngineCtx, WorkflowEventSink, WorkflowExecutionDto,
};
use crate::services::workflow_refs;
use crate::services::workflow_refs::WorkflowRefUsage;
use crate::services::workflow_validate;

/// 取 DB 句柄引用（GUI 启动失败态统一拒绝）。
fn db_of<'a>(state: &'a State<'_, AppState>) -> Result<&'a crate::Db, AppError> {
    state.db.as_ref().map_err(Clone::clone)
}

/// workflow.list：工作空间内工作流清单（创建序）。
#[tauri::command(rename = "workflow.list")]
pub async fn workflow_list(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<WorkflowListDto, AppError> {
    let db = db_of(&state)?;
    workflow::list(&db.pool, &workspace_id).await
}

/// workflow.load：加载工作流完整图（编辑 Tab 打开面）。
#[tauri::command(rename = "workflow.load")]
pub async fn workflow_load(
    state: State<'_, AppState>,
    id: String,
) -> Result<WorkflowDto, AppError> {
    let db = db_of(&state)?;
    workflow::load(&db.pool, &id).await
}

/// workflow.create：新建工作流（空图起步）。
#[tauri::command(rename = "workflow.create")]
pub async fn workflow_create(
    state: State<'_, AppState>,
    workspace_id: String,
    name: String,
) -> Result<WorkflowDto, AppError> {
    let db = db_of(&state)?;
    workflow::create(&db.pool, &workspace_id, &name).await
}

/// workflow.paste：跨空间粘贴（应用内剪贴板的图在目标空间落地为全新工作流；
/// 请求引用按稳定键在目标空间解析，报告随实体返回）。
#[tauri::command(rename = "workflow.paste")]
pub async fn workflow_paste(
    state: State<'_, AppState>,
    workspace_id: String,
    name: String,
    graph: WorkflowGraph,
) -> Result<WorkflowPasteReport, AppError> {
    let db = db_of(&state)?;
    workflow::paste(&db.pool, &workspace_id, &name, &graph).await
}

/// workflow.export：导出工作流为 `.json` 文件（路径由前端系统对话框选定）；
/// 空间作用域读取（跨空间 id 视同不存在）＋落盘前读时脱敏投影，敏感覆写
/// 字面量不进文件。
#[tauri::command(rename = "workflow.export")]
pub async fn workflow_export(
    state: State<'_, AppState>,
    workspace_id: String,
    id: String,
    path: String,
) -> Result<WorkflowExportResultDto, AppError> {
    let db = db_of(&state)?;
    workflow::export(&db.pool, &workspace_id, &id, &path).await
}

/// workflow.import：从导出文件导入为全新工作流（封皮版本闸后复用粘贴
/// 解析链；报告与粘贴同形态）。
#[tauri::command(rename = "workflow.import")]
pub async fn workflow_import(
    state: State<'_, AppState>,
    workspace_id: String,
    path: String,
) -> Result<WorkflowPasteReport, AppError> {
    let db = db_of(&state)?;
    workflow::import(&db.pool, &workspace_id, &path).await
}

/// workflow.rename：重命名。
#[tauri::command(rename = "workflow.rename")]
pub async fn workflow_rename(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<WorkflowDto, AppError> {
    let db = db_of(&state)?;
    workflow::rename(&db.pool, &id, &name).await
}

/// workflow.save：保存图（编辑器 Ctrl+S 通道；不做执行前校验）。
#[tauri::command(rename = "workflow.save")]
pub async fn workflow_save(
    state: State<'_, AppState>,
    id: String,
    graph: WorkflowGraph,
) -> Result<WorkflowDto, AppError> {
    let db = db_of(&state)?;
    workflow::save(&db.pool, &id, &graph).await
}

/// workflow.delete：删除工作流（硬删除）。
#[tauri::command(rename = "workflow.delete")]
pub async fn workflow_delete(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let db = db_of(&state)?;
    workflow::delete(&db.pool, &id).await
}

// —— workflow.group_*（第五视图分组树；组删连带成员回落未分组） ——

/// workflow.group_list：工作空间内分组清单（创建序）。
#[tauri::command(rename = "workflow.group_list")]
pub async fn workflow_group_list(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<WorkflowGroupListDto, AppError> {
    let db = db_of(&state)?;
    workflow::list_groups(&db.pool, &workspace_id).await
}

/// workflow.group_create：新建分组（同空间组名唯一）。
#[tauri::command(rename = "workflow.group_create")]
pub async fn workflow_group_create(
    state: State<'_, AppState>,
    workspace_id: String,
    name: String,
) -> Result<WorkflowGroupDto, AppError> {
    let db = db_of(&state)?;
    workflow::create_group(&db.pool, &workspace_id, &name).await
}

/// workflow.group_rename：分组重命名。
#[tauri::command(rename = "workflow.group_rename")]
pub async fn workflow_group_rename(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<WorkflowGroupDto, AppError> {
    let db = db_of(&state)?;
    workflow::rename_group(&db.pool, &id, &name).await
}

/// workflow.group_delete：删除分组（组内工作流回落未分组，本体不动）。
#[tauri::command(rename = "workflow.group_delete")]
pub async fn workflow_group_delete(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let db = db_of(&state)?;
    workflow::delete_group(&db.pool, &id).await
}

/// workflow.set_group：设置工作流所属分组（groupId 缺省＝移出分组）。
#[tauri::command(rename = "workflow.set_group")]
pub async fn workflow_set_group(
    state: State<'_, AppState>,
    id: String,
    group_id: Option<String>,
) -> Result<WorkflowDto, AppError> {
    let db = db_of(&state)?;
    workflow::set_group(&db.pool, &id, group_id.as_deref()).await
}

/// workflow.move：移动工作流到目标分组（groupId 缺省＝未分组）的目标位置
/// （树拖拽排序通道；同组内重排与跨组移动共用）。
#[tauri::command(rename = "workflow.move")]
pub async fn workflow_move(
    state: State<'_, AppState>,
    id: String,
    group_id: Option<String>,
    index: i64,
) -> Result<(), AppError> {
    let db = db_of(&state)?;
    workflow::move_workflow(&db.pool, &id, group_id.as_deref(), index).await
}

/// workflow.group_move：移动分组到空间内分组序列的目标位置（树拖拽排序
/// 通道；分组不跨空间）。
#[tauri::command(rename = "workflow.group_move")]
pub async fn workflow_group_move(
    state: State<'_, AppState>,
    id: String,
    index: i64,
) -> Result<(), AppError> {
    let db = db_of(&state)?;
    workflow::move_group(&db.pool, &id, index).await
}

/// workflow.validate：执行前校验（编辑会话当前图优先——传 graph 校验未保存
/// 编辑态，缺省校验落库图；保存不被校验拦截，问题清单只在执行前与错误
/// 定位面消费）。
#[tauri::command(rename = "workflow.validate")]
pub async fn workflow_validate(
    state: State<'_, AppState>,
    id: String,
    graph: Option<WorkflowGraph>,
) -> Result<Vec<WorkflowIssue>, AppError> {
    let db = db_of(&state)?;
    workflow_validate::validate(&db.pool, &id, graph.as_ref()).await
}

/// workflow.endpoint_usage：稳定键 → 引用工作流清单（删除接口确认框与
/// 同步向导「将删除」计数的反查面；未列入结果表的键＝无引用）。
#[tauri::command(rename = "workflow.endpoint_usage")]
pub async fn workflow_endpoint_usage(
    state: State<'_, AppState>,
    workspace_id: String,
    keys: Vec<String>,
) -> Result<std::collections::BTreeMap<String, Vec<WorkflowRefUsage>>, AppError> {
    let db = db_of(&state)?;
    workflow_refs::endpoint_usage(&db.pool, &workspace_id, &keys).await
}

/// workflow.execute：执行工作流至终态（阻塞语义同 http.send）。事件经
/// `workflow:event` 实时推送；执行记录落库（每工作流仅最近一次）后返回。
#[tauri::command(rename = "workflow.execute")]
pub async fn workflow_execute(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<WorkflowExecutionDto, AppError> {
    let db = db_of(&state)?;
    let sink: WorkflowEventSink = std::sync::Arc::new(move |value| {
        use tauri::Emitter;
        let _ = app.emit("workflow:event", value);
    });
    let ctx = WorkflowEngineCtx {
        pool: &db.pool,
        registry: &state.tasks,
        http: &state.http,
        sink: Some(sink),
    };
    engine::execute(&ctx, &id).await
}

/// workflow.cancel：取消在途执行（无在途任务时静默幂等；返回是否有任务
/// 被取消）。
#[tauri::command(rename = "workflow.cancel")]
pub async fn workflow_cancel(state: State<'_, AppState>, id: String) -> Result<bool, AppError> {
    Ok(engine::cancel(&state.tasks, &id))
}

/// workflow.last_execution：取工作流最近一次执行记录（执行面板回看面；
/// 无记录＝null）。
#[tauri::command(rename = "workflow.last_execution")]
pub async fn workflow_last_execution(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<WorkflowExecutionDto>, AppError> {
    let db = db_of(&state)?;
    engine::last_execution(&db.pool, &id).await
}
