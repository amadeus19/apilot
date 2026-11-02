//! 认证域：JWT 签发（HS256 演示密钥）与受保护接口。
//! 覆盖素材：登录成功（token 响应头＋响应体双形态）、错误凭据 401、
//! 缺头 / 伪 token 的受保护 401 样本。

use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

/// HS256 固定演示密钥——仅测试/演示用途，不承载任何真实安全语义。
/// 靶机是本地回环演示服务，密钥公开在源码中是有意为之（CLI / GUI 示例可对照）。
const JWT_SECRET: &[u8] = b"apilot-demo-secret-not-for-production";

/// 演示账号：admin / 123456（与 CLI 文档示例对齐）
const DEMO_USERNAME: &str = "admin";
const DEMO_PASSWORD: &str = "123456";

/// token 有效期（秒），登录响应的 expires_in 与 claims.exp 同源
const TOKEN_EXPIRES_IN: u64 = 3600;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub iat: u64,
    pub exp: u64,
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 签发演示 token（HS256 对家用密钥与合法 claims 恒成功，演示语境允许 expect）
fn issue_token(username: &str) -> String {
    let now = unix_now();
    let claims = Claims {
        sub: username.to_string(),
        iat: now,
        exp: now + TOKEN_EXPIRES_IN,
    };
    encode(&Header::default(), &claims, &EncodingKey::from_secret(JWT_SECRET))
        .expect("HS256 签发在合法 claims 下恒成功")
}

/// 校验 token：有效返回 claims；过期 / 伪造 / 格式错均返回 None（401 语义）
fn verify_token(token: &str) -> Option<Claims> {
    decode::<Claims>(token, &DecodingKey::from_secret(JWT_SECRET), &Validation::default())
        .ok()
        .map(|data| data.claims)
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct LoginResponse {
    pub token: String,
    #[serde(rename = "tokenType")]
    pub token_type: String,
    #[serde(rename = "expiresIn")]
    pub expires_in: u64,
}

/// 4xx 响应的统一错误体
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ErrorBody {
    pub error: String,
    pub message: String,
}

pub(crate) fn error_body(error: &str, message: &str) -> Json<ErrorBody> {
    Json(ErrorBody {
        error: error.to_string(),
        message: message.to_string(),
    })
}

pub(crate) fn unauthorized(message: &str) -> (StatusCode, Json<ErrorBody>) {
    (StatusCode::UNAUTHORIZED, error_body("unauthorized", message))
}

pub(crate) fn bad_request(message: &str) -> (StatusCode, Json<ErrorBody>) {
    (StatusCode::BAD_REQUEST, error_body("bad_request", message))
}

/// POST /auth/login：正确凭据 200——token 经响应头 `access-token` 与响应体双形态返回；
/// 错误凭据 401。
#[utoipa::path(
    post,
    path = "/auth/login",
    summary = "登录获取演示 token",
    request_body = LoginRequest,
    responses(
        (status = 200, description = "登录成功：token 在响应头 access-token 与响应体双形态返回", body = LoginResponse),
        (status = 401, description = "凭据错误", body = ErrorBody),
    )
)]
pub async fn login(Json(req): Json<LoginRequest>) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    if req.username != DEMO_USERNAME || req.password != DEMO_PASSWORD {
        return (
            StatusCode::UNAUTHORIZED,
            HeaderMap::new(),
            serde_json::json!({"error": "unauthorized", "message": "用户名或密码错误"}).into(),
        );
    }
    let token = issue_token(&req.username);
    let mut headers = HeaderMap::new();
    // 双形态之一：响应头 access-token（JWT 为 ASCII base64url 串，HeaderValue 转换恒成功）
    headers.insert(
        "access-token",
        axum::http::HeaderValue::from_str(&token).expect("JWT 为 ASCII，恒可转 HeaderValue"),
    );
    let body = serde_json::json!({
        "token": token,
        "tokenType": "Bearer",
        "expiresIn": TOKEN_EXPIRES_IN,
    });
    (StatusCode::OK, headers, Json(body))
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ClaimsEcho {
    pub sub: String,
    pub iat: u64,
    pub exp: u64,
    pub message: String,
}

/// GET /auth/me：Bearer 受保护接口。claims 回显；缺头 / 伪 token 401。
#[utoipa::path(
    get,
    path = "/auth/me",
    summary = "查询当前登录信息",
    responses(
        (status = 200, description = "claims 回显", body = ClaimsEcho),
        (status = 401, description = "缺少 Authorization 头或 token 无效", body = ErrorBody),
    )
)]
pub async fn me(headers: HeaderMap) -> Result<Json<ClaimsEcho>, (StatusCode, Json<ErrorBody>)> {
    let auth = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| unauthorized("缺少 Authorization 头"))?;
    let token = auth
        .strip_prefix("Bearer ")
        .ok_or_else(|| unauthorized("Authorization 头须为 Bearer 形态"))?;
    let claims = verify_token(token).ok_or_else(|| unauthorized("token 无效或已过期"))?;
    Ok(Json(ClaimsEcho {
        sub: claims.sub,
        iat: claims.iat,
        exp: claims.exp,
        message: "token 有效，claims 如下".to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_and_verify_roundtrip() {
        let token = issue_token(DEMO_USERNAME);
        let claims = verify_token(&token).expect("刚签发的 token 必须可验证");
        assert_eq!(claims.sub, DEMO_USERNAME);
        assert_eq!(claims.exp - claims.iat, TOKEN_EXPIRES_IN);
    }

    #[test]
    fn fake_token_rejected() {
        assert!(verify_token("not-a-jwt").is_none());
        assert!(verify_token("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.zzz").is_none());
    }
}
