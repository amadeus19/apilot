//! 同步域统一内部模型：Swagger 2.0 与 OpenAPI 3.0.x 归一后的接口定义面。
//!
//! 归一由 [`crate::domain::sync::normalize`] 完成；本模型是 diff（参数 /
//! 请求体 key / 响应 key 三粒度）与接口文档预览的共同供料，按需从快照
//! 原文重归一（库为事实源），不跨 IPC 暂存。
//!
//! 定义侧元数据（description / 类型 / required / example）全权写入本模型
//! （元数据属定义侧，随 `endpoints.definition` 同步写入）；
//! 字段序列化按 struct 声明序、空集合不省略（Option 省略），与 EndpointDiff
//! 契约的序列化锚定口径一致。

use serde::{Deserialize, Serialize};

use crate::domain::endpoint::{Definition, HttpMethod};
use crate::error::AppError;

/// 一份归一后的 OpenAPI 文档（一个服务的拉取产物）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedDoc {
    /// 文档 info.title
    pub title: String,
    /// 文档 info.version
    pub version: String,
    /// 全部 operation（paths 序 × 方法序，两套规范同一迭代序）
    pub operations: Vec<UnifiedOperation>,
}

/// 一个接口的完整定义侧描述（统一 operation）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedOperation {
    /// 稳定键（`方法 + 空格 + 路由模板`，生成规则复用 [`Definition::stable_key`]
    /// 且不可变——definition 扩容只加元数据，不动身份）
    pub key: String,
    /// 方法（七选，恒大写）
    pub method: String,
    /// 路由模板（`{param}` 保留原样）
    pub path: String,
    /// swagger summary（缺省由方法 + 路径推导）
    pub title: String,
    /// swagger tags 首个（tag→category 映射；无 tags 为 None＝散层）
    pub category: Option<String>,
    pub description: Option<String>,
    pub parameters: Vec<UnifiedParameter>,
    pub request_body: Option<UnifiedRequestBody>,
    pub responses: Vec<UnifiedResponse>,
}

/// 参数（path / query / header / formData / cookie 五位置归一保真）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedParameter {
    pub name: String,
    pub location: UnifiedParamLocation,
    pub required: bool,
    pub description: Option<String>,
    /// 参数类型（string / integer / number / boolean / array / 空串＝未知）
    pub param_type: String,
    pub format: Option<String>,
    /// 定义侧示例（OpenAPI 3.0 一等公民；2.0 规范无参数级 example，恒 None）
    pub example: Option<serde_json::Value>,
}

/// 参数位置（Swagger 2.0 的 formData 与 OpenAPI 3.0 的 cookie 都保真保留，
/// 供体参数级合并与文档预览按需消费）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UnifiedParamLocation {
    Query,
    Path,
    Header,
    FormData,
    Cookie,
}

/// 请求体（2.0 的 `in: body` 参数与 3.0 的 requestBody 归一）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedRequestBody {
    /// 2.0 取 consumes 候选按 JSON 家族择优（缺省 application/json）；3.0 取
    /// content 候选同口径择优（精确 application/json ＞ +json 变体与 text/json）
    pub content_type: String,
    pub required: bool,
    pub description: Option<String>,
    pub schema: UnifiedSchema,
    /// 定义侧示例（3.0 MediaType.example 优先，回退 schema 自带 example）
    pub example: Option<serde_json::Value>,
}

/// 响应（2.0 的 responses 项与 3.0 的 responses 项归一）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedResponse {
    /// 状态码字符串（"200" / "default" / "4XX" 区段形态原样保留）
    pub status: String,
    pub description: Option<String>,
    /// 响应体类型（2.0 取 produces 候选按 JSON 家族择优；3.0 取 content 候选
    /// 同口径择优；无响应体为 None）
    pub content_type: Option<String>,
    pub schema: Option<UnifiedSchema>,
    /// 定义侧示例（同请求体双轨：MediaType.example 优先，回退 schema example）
    pub example: Option<serde_json::Value>,
}

/// 统一 schema：`$ref` 受控展开后的产物。
///
/// 展开语义（归一层保证）：
/// - 常规引用就地展开（definitions / components.schemas 查表）；
/// - 循环引用不死锁：展开路径上已见过的引用名再次出现 → 该分支截断
///   （[`Self::ref_name`] 保留引用名、[`Self::truncated`] 置位，不再下钻）；
/// - 深度超 [`crate::constants::SYNC_SCHEMA_MAX_DEPTH`] 同样截断；
/// - 悬空引用（查表未命中）宽容截断（保留引用名），不整份拒绝；
/// - oneOf / anyOf / allOf 组合按「分支属性并集」合并（互斥分支的 key 面
///   并集正是参数级 / key 级 diff 关心的形态，取舍记录于此）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedSchema {
    /// schema 类型（object / array / string / integer / number / boolean /
    /// 空串＝未知或组合）
    pub schema_type: String,
    pub format: Option<String>,
    /// 本 schema 由哪个 `$ref` 展开而来（None＝内联 schema）
    pub ref_name: Option<String>,
    /// 循环 / 深度 / 悬空截断标记（截断分支不再有子结构）
    pub truncated: bool,
    pub description: Option<String>,
    /// object 必填属性名列表（object 级；参数级 required 在 [`UnifiedParameter`]）
    pub required: Vec<String>,
    /// 定义侧示例
    pub example: Option<serde_json::Value>,
    /// 枚举值（string enum）
    pub enum_values: Vec<String>,
    /// object 属性（保持文档声明序）
    pub properties: Vec<(String, UnifiedSchema)>,
    /// array 元素 schema
    pub items: Option<Box<UnifiedSchema>>,
}

impl UnifiedSchema {
    /// 空统一 schema（截断与未知形态的基底）。
    pub fn empty() -> Self {
        Self {
            schema_type: String::new(),
            format: None,
            ref_name: None,
            truncated: false,
            description: None,
            required: Vec::new(),
            example: None,
            enum_values: Vec::new(),
            properties: Vec::new(),
            items: None,
        }
    }
}

/// 归一层统一的方法迭代序（两套规范各自模型的字段序不同，归一结果以本序
/// 钉死，保证同一业务面的两套规范产出等价统一模型）。
pub const METHOD_ORDER: [HttpMethod; 7] = [
    HttpMethod::GET,
    HttpMethod::PUT,
    HttpMethod::POST,
    HttpMethod::DELETE,
    HttpMethod::OPTIONS,
    HttpMethod::HEAD,
    HttpMethod::PATCH,
];

/// 按稳定键生成规则构造（复用 [`Definition::stable_key`]，规则不可变）。
pub fn stable_key(method: HttpMethod, path: &str) -> Result<String, AppError> {
    Ok(Definition::new(method, path)?.stable_key())
}
