//! CRUD 域：内存态用户资源——query（分页＋子串过滤）/ body / path / header 四形态素材。

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::{bad_request, error_body, ErrorBody};
use crate::state::{AppState, User};

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListUsersQuery {
    /// 页码，从 1 起
    page: Option<u64>,
    /// 页容量
    size: Option<u64>,
    /// name / email 子串过滤
    keyword: Option<String>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct UsersPage {
    /// 当前页码（从 1 起，缺省 1）
    pub page: u64,
    /// 页容量（缺省 20，上限 100）
    pub size: u64,
    /// 过滤后的总条数（分页前的全量计数，非本页条数）
    pub total: u64,
    /// 当前页用户列表
    pub items: Vec<User>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct CreateUserRequest {
    /// 用户显示名（trim 后不得为空；可作为 keyword 子串过滤的命中字段）
    pub name: String,
    /// 邮箱地址（trim 后不得为空；可作为 keyword 子串过滤的命中字段）
    pub email: String,
}

/// GET /api/users：query 形态——分页＋子串过滤。
#[utoipa::path(
    get,
    path = "/api/users",
    summary = "分页查询用户列表",
    params(ListUsersQuery),
    responses(
        (status = 200, description = "分页用户列表", body = UsersPage),
    )
)]
pub async fn list_users(
    State(state): State<AppState>,
    Query(q): Query<ListUsersQuery>,
) -> Json<UsersPage> {
    let page = q.page.unwrap_or(1).max(1);
    let size = q.size.unwrap_or(20).clamp(1, 100);
    let all = state.list_users(q.keyword.as_deref());
    let total = all.len() as u64;
    let items = all
        .into_iter()
        .skip(((page - 1) * size) as usize)
        .take(size as usize)
        .collect();
    Json(UsersPage { page, size, total, items })
}

/// POST /api/users：JSON body 形态——内存态创建，重启即重置。
#[utoipa::path(
    post,
    path = "/api/users",
    summary = "创建用户",
    request_body = CreateUserRequest,
    responses(
        (status = 201, description = "创建成功", body = User),
        (status = 400, description = "字段为空", body = ErrorBody),
    )
)]
pub async fn create_user(
    State(state): State<AppState>,
    Json(req): Json<CreateUserRequest>,
) -> Result<(StatusCode, Json<User>), (StatusCode, Json<ErrorBody>)> {
    if req.name.trim().is_empty() || req.email.trim().is_empty() {
        return Err(bad_request("name 与 email 均不得为空"));
    }
    let user = state.create_user(req.name, req.email);
    Ok((StatusCode::CREATED, Json(user)))
}

/// GET /api/users/{id}：path 形态；不存在 404 样本。
#[utoipa::path(
    get,
    path = "/api/users/{id}",
    summary = "查询用户详情",
    params(("id" = u64, Path, description = "用户 ID")),
    responses(
        (status = 200, description = "用户详情", body = User),
        (status = 404, description = "用户不存在", body = ErrorBody),
    )
)]
pub async fn get_user(
    State(state): State<AppState>,
    Path(id): Path<u64>,
) -> Result<Json<User>, (StatusCode, Json<ErrorBody>)> {
    state.get_user(id).map(Json).ok_or_else(|| not_found_user(id))
}

/// PUT /api/users/{id}：body＋path＋header 三形态——要求 `X-Request-Id` 头，缺失 400。
#[utoipa::path(
    put,
    path = "/api/users/{id}",
    summary = "更新用户",
    request_body = CreateUserRequest,
    params(
        ("id" = u64, Path, description = "用户 ID"),
        ("X-Request-Id" = String, Header, description = "必填请求头，缺失返回 400"),
    ),
    responses(
        (status = 200, description = "更新成功", body = User),
        (status = 400, description = "缺少 X-Request-Id 头", body = ErrorBody),
        (status = 404, description = "用户不存在", body = ErrorBody),
    )
)]
pub async fn update_user(
    State(state): State<AppState>,
    Path(id): Path<u64>,
    headers: HeaderMap,
    Json(req): Json<CreateUserRequest>,
) -> Result<Json<User>, (StatusCode, Json<ErrorBody>)> {
    // HeaderMap 键匹配大小写不敏感：x-request-id 同样命中
    if !headers.contains_key("x-request-id") {
        return Err(bad_request("缺少 X-Request-Id 请求头"));
    }
    state
        .update_user(id, req.name, req.email)
        .map(Json)
        .ok_or_else(|| not_found_user(id))
}

/// DELETE /api/users/{id}：204 无体。
#[utoipa::path(
    delete,
    path = "/api/users/{id}",
    summary = "删除用户",
    params(("id" = u64, Path, description = "用户 ID")),
    responses(
        (status = 204, description = "删除成功，无响应体"),
        (status = 404, description = "用户不存在", body = ErrorBody),
    )
)]
pub async fn delete_user(
    State(state): State<AppState>,
    Path(id): Path<u64>,
) -> Result<StatusCode, (StatusCode, Json<ErrorBody>)> {
    if state.delete_user(id) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(not_found_user(id))
    }
}

fn not_found_user(id: u64) -> (StatusCode, Json<ErrorBody>) {
    (
        StatusCode::NOT_FOUND,
        error_body("not_found", &format!("用户 {id} 不存在")),
    )
}
