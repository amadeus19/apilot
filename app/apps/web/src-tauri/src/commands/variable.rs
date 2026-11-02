//! 变量域 IPC 命令（点分域前缀）：变量分类（CRUD / 激活切换）、变量
//! （含 Secret 标记）、生效集合成、BaseUrl 候选清单；业务编排全部在
//! services 层。invoke_handler 注册行由调度者统一挂载。

use tauri::State;

use crate::AppState;
use crate::error::AppError;
use crate::services::variable::{
    self, BaseUrlListDto, EffectiveSetDto, VariableCategoriesDto, VariableListDto,
};

/// 取 DB 句柄引用（GUI 启动失败态统一拒绝）。
fn db_of<'a>(state: &'a State<'_, AppState>) -> Result<&'a crate::Db, AppError> {
    state.db.as_ref().map_err(Clone::clone)
}

/// variable.list_categories：分类清单（本空间＋全局，全局排后）＋激活指针。
#[tauri::command(rename = "variable.list_categories")]
pub async fn variable_list_categories(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<VariableCategoriesDto, AppError> {
    let db = db_of(&state)?;
    variable::list_categories(&db.pool, &workspace_id).await
}

/// variable.create_category：新建分类（global＝true 建全局行）。
#[tauri::command(rename = "variable.create_category")]
pub async fn variable_create_category(
    state: State<'_, AppState>,
    workspace_id: String,
    global: bool,
    name: String,
) -> Result<VariableCategoriesDto, AppError> {
    let db = db_of(&state)?;
    variable::create_category(&db.pool, &workspace_id, global, &name).await
}

/// variable.rename_category：重命名分类（全局行或本空间分类）。
#[tauri::command(rename = "variable.rename_category")]
pub async fn variable_rename_category(
    state: State<'_, AppState>,
    workspace_id: String,
    id: String,
    name: String,
) -> Result<VariableCategoriesDto, AppError> {
    let db = db_of(&state)?;
    variable::rename_category(&db.pool, &workspace_id, &id, &name).await
}

/// variable.delete_category：删除分类（其下变量级联；删激活分类自动回落
/// 「全不激活」）。
#[tauri::command(rename = "variable.delete_category")]
pub async fn variable_delete_category(
    state: State<'_, AppState>,
    workspace_id: String,
    id: String,
) -> Result<VariableCategoriesDto, AppError> {
    let db = db_of(&state)?;
    variable::delete_category(&db.pool, &workspace_id, &id).await
}

/// variable.set_active_category：激活切换（categoryId null＝取消激活；
/// 全局分类与跨空间分类拒绝）。
#[tauri::command(rename = "variable.set_active_category")]
pub async fn variable_set_active_category(
    state: State<'_, AppState>,
    workspace_id: String,
    category_id: Option<String>,
) -> Result<VariableCategoriesDto, AppError> {
    let db = db_of(&state)?;
    variable::set_active_category(&db.pool, &workspace_id, category_id.as_deref()).await
}

/// variable.move_category：移动分类到同层 `index` 位（全局组与本空间组
/// 各自成层、不相混；树拖拽排序通道，越界钳制到末尾）。
#[tauri::command(rename = "variable.move_category")]
pub async fn variable_move_category(
    state: State<'_, AppState>,
    workspace_id: String,
    category_id: String,
    index: i64,
) -> Result<VariableCategoriesDto, AppError> {
    let db = db_of(&state)?;
    variable::move_category(&db.pool, &workspace_id, &category_id, index).await
}

/// variable.list_variables：分类内变量清单。
#[tauri::command(rename = "variable.list_variables")]
pub async fn variable_list_variables(
    state: State<'_, AppState>,
    category_id: String,
) -> Result<VariableListDto, AppError> {
    let db = db_of(&state)?;
    variable::list_variables(&db.pool, &category_id).await
}

/// variable.create_variable：新建变量（同分类同 key 撞车稳定报错）。
#[tauri::command(rename = "variable.create_variable")]
pub async fn variable_create_variable(
    state: State<'_, AppState>,
    category_id: String,
    key: String,
    value: String,
    secret: bool,
) -> Result<VariableListDto, AppError> {
    let db = db_of(&state)?;
    variable::create_variable(&db.pool, &category_id, &key, &value, secret).await
}

/// variable.update_variable：更新变量值与敏感标记（身份不动）。
#[tauri::command(rename = "variable.update_variable")]
pub async fn variable_update_variable(
    state: State<'_, AppState>,
    category_id: String,
    key: String,
    value: String,
    secret: bool,
) -> Result<VariableListDto, AppError> {
    let db = db_of(&state)?;
    variable::update_variable(&db.pool, &category_id, &key, &value, secret).await
}

/// variable.rename_variable：重命名变量（key 是身份组成，原子改主键列；
/// 新 key 撞车稳定报错）。
#[tauri::command(rename = "variable.rename_variable")]
pub async fn variable_rename_variable(
    state: State<'_, AppState>,
    category_id: String,
    key: String,
    new_key: String,
) -> Result<VariableListDto, AppError> {
    let db = db_of(&state)?;
    variable::rename_variable(&db.pool, &category_id, &key, &new_key).await
}

/// variable.delete_variable：删除变量。
#[tauri::command(rename = "variable.delete_variable")]
pub async fn variable_delete_variable(
    state: State<'_, AppState>,
    category_id: String,
    key: String,
) -> Result<VariableListDto, AppError> {
    let db = db_of(&state)?;
    variable::delete_variable(&db.pool, &category_id, &key).await
}

/// variable.effective：兜底链合成（激活分类 → 全局分类 → 内置 baseUrl）。
#[tauri::command(rename = "variable.effective")]
pub async fn variable_effective(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<EffectiveSetDto, AppError> {
    let db = db_of(&state)?;
    variable::effective(&db.pool, &workspace_id).await
}

/// variable.list_base_urls：BaseUrl 候选清单（纯 GUI 备选）。
#[tauri::command(rename = "variable.list_base_urls")]
pub async fn variable_list_base_urls(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<BaseUrlListDto, AppError> {
    let db = db_of(&state)?;
    variable::list_base_urls(&db.pool, &workspace_id).await
}

/// variable.add_base_url：新增候选（同空间同 URL 撞车稳定报错；不触碰
/// workspaces.base_url 生效值）。
#[tauri::command(rename = "variable.add_base_url")]
pub async fn variable_add_base_url(
    state: State<'_, AppState>,
    workspace_id: String,
    url: String,
) -> Result<BaseUrlListDto, AppError> {
    let db = db_of(&state)?;
    variable::add_base_url(&db.pool, &workspace_id, &url).await
}

/// variable.delete_base_url：删除候选（不影响生效值）。
#[tauri::command(rename = "variable.delete_base_url")]
pub async fn variable_delete_base_url(
    state: State<'_, AppState>,
    workspace_id: String,
    id: String,
) -> Result<BaseUrlListDto, AppError> {
    let db = db_of(&state)?;
    variable::delete_base_url(&db.pool, &workspace_id, &id).await
}
