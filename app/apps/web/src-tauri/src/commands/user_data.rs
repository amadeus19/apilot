//! 用户数据（草稿）域 IPC 命令（user_data.*）：挂载读一次 + 整包防抖写。

use serde::Deserialize;
use tauri::State;

use crate::AppState;
use crate::error::AppError;
use crate::services::user_data::{self, UserDataDto};

/// user_data.get：按 (service_id, key) 读草稿；无记录返回 null。
#[tauri::command(rename = "user_data.get")]
pub async fn user_data_get(
    state: State<'_, AppState>,
    service_id: String,
    key: String,
) -> Result<Option<UserDataDto>, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    user_data::get(&db.pool, &service_id, &key).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserDataUpsertArgs {
    pub service_id: String,
    pub key: String,
    pub body: Option<String>,
    /// 前端组装的 JSON 字符串，Rust 不感知字段语义
    pub params: String,
    pub headers: String,
    /// 接口级超时覆写（null 继承全局 / 0 不限制 / >0 秒）
    pub timeout_seconds: Option<i64>,
    /// 请求级认证配置 JSON（前端组装；null＝继承工作空间级）
    pub auth: Option<String>,
    /// 路径覆写（null＝跟随接口定义；空白串由服务层归一为 null）
    pub path_override: Option<String>,
    /// 方法覆写（null＝跟随接口定义；空白串由服务层归一为 null）
    pub method_override: Option<String>,
}

/// user_data.upsert：整包写（body / params / headers / timeout_seconds / auth /
/// path_override，非增量 patch）；不失效任何查询键。
#[tauri::command(rename = "user_data.upsert")]
pub async fn user_data_upsert(
    state: State<'_, AppState>,
    args: UserDataUpsertArgs,
) -> Result<UserDataDto, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    user_data::upsert(
        &db.pool,
        &args.service_id,
        &args.key,
        args.body,
        args.params,
        args.headers,
        args.timeout_seconds,
        args.auth,
        args.path_override,
        args.method_override,
    )
    .await
}
