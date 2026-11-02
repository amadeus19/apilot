//! 归一层：Swagger 2.0 与 OpenAPI 3.x → 统一内部模型。
//!
//! 选型定案：`openapiv3-extended` 作唯一解析依赖，3.0 走 crate 的
//! v3 模型、2.0 走 `v2` feature 模型，两个方向各自映射到 [`UnifiedDoc`]；
//! crate 自带的 `upgrade()`（2.0→3.0）会丢 v2 的 example 等字段，不采用。
//!
//! `$ref` 解析策略＝受控展开（访问集合＋深度上限）：
//! - schema 引用（2.0 `#/definitions/`、3.0 `#/components/schemas/`）就地
//!   查表展开；循环引用不死锁——展开路径上已见的引用名再次出现即截断
//!   （保留引用名与 truncated 标记），绝不朴素递归内联；
//! - 深度超 [`SYNC_SCHEMA_MAX_DEPTH`] 截断；悬空引用（查表未命中）宽容
//!   截断，不整份拒绝（半坏文档保留可用面）；纯内联深嵌套由 serde_json
//!   自身的递归上限在解析层拒绝（归 `SYNC_BAD_SWAGGER`）；
//! - 2.0 全局 `#/parameters/`、`#/responses/` 复用：crate 的 v2 模型在这两个
//!   位置不建模 `$ref`（强类型反序列化会静默产默认值），归一层先在 JSON 层
//!   内联展开再进模型；3.0 的 components.parameters / responses /
//!   requestBodies 直接查表归一。

use std::collections::HashSet;

use openapiv3 as v3;
use openapiv3::v2;

use crate::constants::SYNC_SCHEMA_MAX_DEPTH;
use crate::domain::endpoint::HttpMethod;
use crate::domain::sync::model::{
    METHOD_ORDER, UnifiedDoc, UnifiedOperation, UnifiedParamLocation, UnifiedParameter,
    UnifiedRequestBody, UnifiedResponse, UnifiedSchema,
};
use crate::error::AppError;
use crate::error::codes;

/// 把一份 swagger.json / openapi.json 原文归一为统一模型。
///
/// 校验口径：可解析 JSON、含 `swagger` / `openapi` 版本
/// 字段、版本在支持矩阵内；不满足＝`SYNC_BAD_SWAGGER`。路由模板走
/// [`crate::domain::endpoint::validate_path_template`]（非法模板整份拒绝——
/// 入树必须过同一校验，与其应用时炸不如拉取时报）。
pub fn normalize(raw: &str) -> Result<UnifiedDoc, AppError> {
    let mut value: serde_json::Value = serde_json::from_str(raw).map_err(|err| {
        AppError::new(
            codes::SYNC_BAD_SWAGGER,
            format!("document is not valid JSON: {err}"),
        )
    })?;
    match value.get("swagger").and_then(|v| v.as_str()) {
        Some(version) if version.starts_with("2") => {
            // v2 JSON 层预处理（进 crate 模型前）：
            // - 全局参数 / 响应引用内联（crate v2 模型在这两个位置不建模 $ref）
            // - `in: formData` 值规范化为小写（crate 的 ParameterLocation 按
            //   lowercase 反序列化，2.0 规范原文是驼峰 formData，不修会整份解析失败）
            if raw.contains("#/parameters/") || raw.contains("#/responses/") {
                let root = value.clone();
                inline_v2_global_refs(&mut value, &root, &mut HashSet::new());
            }
            if raw.contains("formData") {
                normalize_v2_form_data_location(&mut value);
            }
            let doc: v2::OpenAPI = serde_json::from_value(value).map_err(bad_swagger)?;
            normalize_v2(&doc)
        }
        Some(version) => Err(unsupported_version("swagger", version)),
        None => match value.get("openapi").and_then(|v| v.as_str()) {
            // 3.x 全系纳入（3.0 / 3.1 / 3.2——utoipa 等生成器已产 3.1+ 文档）。
            // 3.1 新语法面在 JSON 层降级为 3.0 形态后进 crate 模型（见
            // [`downgrade_31_type_arrays`]）；结构不兼容仍在强类型解析层
            // 报 SYNC_BAD_SWAGGER fail-fast——宽容纳版本、严守结构。
            Some(version) if version.starts_with("3") => {
                downgrade_31_type_arrays(&mut value);
                let doc: v3::OpenAPI = serde_json::from_value(value).map_err(bad_swagger)?;
                normalize_v3(&doc)
            }
            Some(version) => Err(unsupported_version("openapi", version)),
            None => Err(AppError::new(
                codes::SYNC_BAD_SWAGGER,
                "document has no swagger/openapi version field",
            )),
        },
    }
}

/// 3.1 形态降级（JSON 层预处理，进 crate 模型前）：`"type": ["string",
/// "null"]` 类型数组（3.1 语法，utoipa 对可空字段的产物）→ 取首个非 null
/// 类型为主类型＋`"nullable": true`（3.0 关键字，crate 的 SchemaData 消费）。
/// crate 按 3.0 建模（type 恒字符串，AnySchema.typ 同为 Option<String>），
/// 数组形态会使 SchemaKind 全 variant 落空而整份拒绝；可空语义不进统一
/// 模型契约（KeySnap 只承载主类型面），降级仅保解析与类型面可用。
fn downgrade_31_type_arrays(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            // 仅在 type 确为数组时摘除重建（字符串形态原样保留）
            if matches!(map.get("type"), Some(serde_json::Value::Array(_))) {
                let Some(serde_json::Value::Array(items)) = map.remove("type") else {
                    unreachable!("刚校验过 type 为数组");
                };
                let non_null: Vec<&serde_json::Value> = items
                    .iter()
                    .filter(|v| v.as_str() != Some("null"))
                    .collect();
                let main = non_null
                    .first()
                    .and_then(|v| v.as_str())
                    .unwrap_or("string");
                map.insert("type".into(), serde_json::Value::String(main.to_owned()));
                if non_null.len() != items.len() {
                    map.insert("nullable".into(), serde_json::Value::Bool(true));
                }
            }
            for child in map.values_mut() {
                downgrade_31_type_arrays(child);
            }
        }
        serde_json::Value::Array(items) => {
            for child in items.iter_mut() {
                downgrade_31_type_arrays(child);
            }
        }
        _ => {}
    }
}

fn bad_swagger(err: serde_json::Error) -> AppError {
    AppError::new(
        codes::SYNC_BAD_SWAGGER,
        format!("document does not match the declared spec shape: {err}"),
    )
}

fn unsupported_version(field: &str, version: &str) -> AppError {
    AppError::new(
        codes::SYNC_BAD_SWAGGER,
        format!("unsupported {field} version: {version} (expected swagger 2.x or openapi 3.0.x)"),
    )
    .with_details(serde_json::json!({ "field": field, "version": version }))
}

/// v2 全局引用内联：把树中任意位置的 `{"$ref": "#/parameters/Name"}` 与
/// `{"$ref": "#/responses/Name"}` 替换为根表对应节点的克隆（schema 的
/// `#/definitions/` 引用不动——那两个位置 crate 模型有建模，走受控展开）。
/// `visited` 防全局表内互相引用成环（参数引响应、响应引参数的死循环）。
fn inline_v2_global_refs(
    node: &mut serde_json::Value,
    root: &serde_json::Value,
    visited: &mut HashSet<String>,
) {
    let reference = node.as_object().and_then(|map| {
        let reference = map.get("$ref")?.as_str()?;
        (reference.starts_with("#/parameters/") || reference.starts_with("#/responses/"))
            .then_some(reference.to_owned())
    });
    if let Some(reference) = reference {
        if visited.insert(reference.clone()) {
            if let Some(target) = lookup_json_pointer(root, &reference) {
                // 替换后继续下钻：内联体自身可能还挂全局引用（有限层展开）
                let mut replacement = target.clone();
                inline_v2_global_refs(&mut replacement, root, visited);
                *node = replacement;
            }
            visited.remove(&reference);
        }
        return;
    }
    match node {
        serde_json::Value::Object(map) => {
            for (_, child) in map.iter_mut() {
                inline_v2_global_refs(child, root, visited);
            }
        }
        serde_json::Value::Array(items) => {
            for child in items.iter_mut() {
                inline_v2_global_refs(child, root, visited);
            }
        }
        _ => {}
    }
}

/// 收窄 JSON Pointer 查表：仅认 `#/parameters/Name` 与 `#/responses/Name`
/// 两段形态（名字段不再含 `/`，避免通用指针解析面）。
fn lookup_json_pointer<'a>(
    root: &'a serde_json::Value,
    reference: &str,
) -> Option<&'a serde_json::Value> {
    let (table, name) = reference.strip_prefix("#/")?.split_once('/')?;
    root.get(table)?.get(name)
}

/// v2 参数位置值规范化：`"in": "formData"` → `"in": "formdata"`（crate 的
/// lowercase 反序列化）。含 `"in"` 键且值恰为 `"formData"` 的对象几乎必是
/// 参数节点（x- 扩展撞同名同值形态可忽略），整树一次遍历。
fn normalize_v2_form_data_location(node: &mut serde_json::Value) {
    match node {
        serde_json::Value::Object(map) => {
            if let Some(location) = map.get_mut("in")
                && location.as_str() == Some("formData")
            {
                *location = serde_json::Value::String("formdata".to_owned());
            }
            for (_, child) in map.iter_mut() {
                normalize_v2_form_data_location(child);
            }
        }
        serde_json::Value::Array(items) => {
            for child in items.iter_mut() {
                normalize_v2_form_data_location(child);
            }
        }
        _ => {}
    }
}

// —— 受控展开状态 ——

/// 展开路径上的引用名集合＋引用链深度（「访问集合＋深度上限」的两件套）。
#[derive(Default)]
struct ExpandState {
    visiting: HashSet<String>,
    depth: usize,
}

impl ExpandState {
    fn new() -> Self {
        Self::default()
    }

    /// 引用链进层；超深度上限返回 false（调用方截断）。
    fn enter(&mut self) -> bool {
        self.depth += 1;
        self.depth <= SYNC_SCHEMA_MAX_DEPTH
    }

    fn exit(&mut self) {
        self.depth -= 1;
    }
}

/// 截断形态：保留引用名、无子结构（循环 / 深度 / 悬空共用）。
fn truncated_schema(ref_name: &str) -> UnifiedSchema {
    UnifiedSchema {
        truncated: true,
        ref_name: Some(ref_name.to_owned()),
        ..UnifiedSchema::empty()
    }
}

/// 空串描述统一收敛为 None（两套规范的必填 description 都允许空串）。
fn optional_str(raw: &str) -> Option<String> {
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_owned())
    }
}

fn non_empty(raw: String) -> Option<String> {
    if raw.is_empty() { None } else { Some(raw) }
}

/// `$ref` 尾段名（`#/definitions/User` → `User`）；无尾段＝None。
fn ref_tail(reference: &str) -> Option<&str> {
    reference.rsplit('/').next().filter(|s| !s.is_empty())
}

/// JSON 家族媒体类型的择优权重（越小越优先）：精确 application/json 最优先；
/// `+json` 后缀变体与 text/json 同属 JSON 家族居次；其余兜底。
fn json_family_rank(media_type: &str) -> u8 {
    let lowered = media_type.to_ascii_lowercase();
    if lowered == "application/json" {
        0
    } else if lowered.ends_with("+json") || lowered == "text/json" {
        1
    } else {
        2
    }
}

/// 多媒体类型候选择优：按 [`json_family_rank`] 取权重最小者（同权重保持
/// 声明序取先）。Swashbuckle 等生成器常见一个 requestBody / response 声明
/// 多个 JSON 媒型，而 JSON 对象键序使 `application/*+json` 之类变体排在
/// 精确 application/json 之前——直接取首键会选错媒型。
fn pick_media_type<'a>(candidates: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    let mut best: Option<(&'a str, u8)> = None;
    for candidate in candidates {
        let rank = json_family_rank(candidate);
        let take = match best {
            None => true,
            Some((_, best_rank)) => rank < best_rank,
        };
        if take {
            best = Some((candidate, rank));
        }
    }
    best.map(|(candidate, _)| candidate)
}

/// 参数按 name+location 去重覆盖（path 级先行、operation 级覆盖同名——规范语义）。
fn upsert_parameter(list: &mut Vec<UnifiedParameter>, incoming: UnifiedParameter) {
    if let Some(existing) = list
        .iter_mut()
        .find(|p| p.name == incoming.name && p.location == incoming.location)
    {
        *existing = incoming;
    } else {
        list.push(incoming);
    }
}

/// 组合分支合并（oneOf / anyOf / allOf）：各分支属性并集、required 并集、
/// 枚举拼接，description / example / format 取首个非空。互斥分支的 key 面
/// 并集正是参数级 / key 级 diff 关心的形态，取舍记录于此。
fn merge_schema_branches(branches: Vec<UnifiedSchema>) -> UnifiedSchema {
    let mut merged = UnifiedSchema::empty();
    let mut seen_props: HashSet<String> = HashSet::new();
    let mut seen_required: HashSet<String> = HashSet::new();
    let mut seen_enum: HashSet<String> = HashSet::new();
    for branch in branches {
        if branch.truncated {
            merged.truncated = true;
        }
        if merged.ref_name.is_none() {
            merged.ref_name = branch.ref_name.clone();
        }
        if merged.description.is_none() {
            merged.description = branch.description.clone();
        }
        if merged.example.is_none() {
            merged.example = branch.example.clone();
        }
        if merged.format.is_none() {
            merged.format = branch.format.clone();
        }
        if merged.schema_type.is_empty() {
            merged.schema_type = branch.schema_type.clone();
        }
        for (name, schema) in branch.properties {
            if seen_props.insert(name.clone()) {
                merged.properties.push((name, schema));
            }
        }
        for name in branch.required {
            if seen_required.insert(name.clone()) {
                merged.required.push(name);
            }
        }
        for value in branch.enum_values {
            if seen_enum.insert(value.clone()) {
                merged.enum_values.push(value);
            }
        }
        if merged.items.is_none() {
            merged.items = branch.items;
        }
    }
    // 分支带属性面 → 组合形态按 object 呈现（key 面）
    if !merged.properties.is_empty() {
        merged.schema_type = "object".to_owned();
    }
    merged
}

// ================================================================
// Swagger 2.0 方向
// ================================================================

fn normalize_v2(doc: &v2::OpenAPI) -> Result<UnifiedDoc, AppError> {
    let mut operations = Vec::new();
    for (path, item) in &doc.paths {
        // path 级参数先归一（全局 $ref 已在 JSON 层内联），operation 级覆盖同名
        let path_params: Vec<UnifiedParameter> = item
            .parameters
            .iter()
            .flatten()
            .filter(|param| param.location != v2::ParameterLocation::Body)
            .map(unify_v2_parameter)
            .collect();
        for method in METHOD_ORDER {
            let Some(op) = method_v2(item, method) else {
                continue;
            };
            operations.push(unify_v2_operation(path, method, op, &path_params, doc)?);
        }
    }
    Ok(UnifiedDoc {
        title: doc.info.title.clone().unwrap_or_default(),
        version: doc.info.version.clone().unwrap_or_default(),
        operations,
    })
}

/// v2 PathItem 按统一方法序取 operation。
fn method_v2(item: &v2::PathItem, method: HttpMethod) -> Option<&v2::Operation> {
    match method {
        HttpMethod::GET => item.get.as_ref(),
        HttpMethod::PUT => item.put.as_ref(),
        HttpMethod::POST => item.post.as_ref(),
        HttpMethod::DELETE => item.delete.as_ref(),
        HttpMethod::OPTIONS => item.options.as_ref(),
        HttpMethod::HEAD => item.head.as_ref(),
        HttpMethod::PATCH => item.patch.as_ref(),
    }
}

/// v2 参数归一（非 body 的四个位置；body 由 operation 归一处理）。
fn unify_v2_parameter(param: &v2::Parameter) -> UnifiedParameter {
    UnifiedParameter {
        name: param.name.clone(),
        location: v2_location(&param.location),
        // path 参数规范必 required，文档漏写也按 required 收（v3 同）
        required: param.required.unwrap_or(false)
            || matches!(param.location, v2::ParameterLocation::Path),
        description: param.description.clone(),
        param_type: param.type_.clone().unwrap_or_default(),
        format: param.format.clone(),
        example: None, // 2.0 规范无参数级 example（crate 模型亦不捕获 x-example）
    }
}

/// v2 参数位置映射（formData 保真保留；body 不会走到这里）。
fn v2_location(location: &v2::ParameterLocation) -> UnifiedParamLocation {
    match location {
        v2::ParameterLocation::Query => UnifiedParamLocation::Query,
        v2::ParameterLocation::Path => UnifiedParamLocation::Path,
        v2::ParameterLocation::Header => UnifiedParamLocation::Header,
        v2::ParameterLocation::FormData => UnifiedParamLocation::FormData,
        v2::ParameterLocation::Body => UnifiedParamLocation::Query,
    }
}

fn unify_v2_operation(
    path: &str,
    method: HttpMethod,
    op: &v2::Operation,
    path_params: &[UnifiedParameter],
    doc: &v2::OpenAPI,
) -> Result<UnifiedOperation, AppError> {
    let mut parameters = path_params.to_vec();
    let mut request_body: Option<UnifiedRequestBody> = None;
    for param in op.parameters.iter().flatten() {
        match param.location {
            // `in: body` 参数即请求体（规范单 body，后写覆盖先写）
            v2::ParameterLocation::Body => {
                if let Some(schema) = &param.schema {
                    request_body = Some(UnifiedRequestBody {
                        content_type: content_type_v2(
                            op.consumes.as_deref().unwrap_or(&[]),
                            doc.consumes.as_deref().unwrap_or(&[]),
                        ),
                        required: param.required.unwrap_or(false),
                        description: param.description.clone(),
                        schema: expand_v2_ref_or_schema(schema, doc, &mut ExpandState::new()),
                        example: None, // 2.0 无 MediaType.example，示例走 schema 级
                    });
                }
            }
            _ => upsert_parameter(&mut parameters, unify_v2_parameter(param)),
        }
    }

    let mut responses = Vec::new();
    for (status, response) in &op.responses {
        // 全局 $ref 已在 JSON 层内联，此处都是实体
        let mut state = ExpandState::new();
        let schema = response
            .schema
            .as_ref()
            .map(|schema| expand_v2_ref_or_schema(schema, doc, &mut state));
        responses.push(UnifiedResponse {
            status: status.clone(),
            description: optional_str(&response.description),
            content_type: schema.as_ref().map(|_| {
                content_type_v2(
                    op.produces.as_deref().unwrap_or(&[]),
                    doc.produces.as_deref().unwrap_or(&[]),
                )
            }),
            example: schema.as_ref().and_then(|s| s.example.clone()),
            schema,
        });
    }

    Ok(UnifiedOperation {
        key: crate::domain::sync::model::stable_key(method, path)?,
        method: method.as_str().to_owned(),
        path: path.to_owned(),
        // 回落为纯路径：方法由接口树行徽章承载，title 再带方法前缀会在树行
        // 呈现「GET /api/xxx」的冗余形态
        title: op.summary.clone().unwrap_or_else(|| path.to_owned()),
        category: op.tags.as_ref().and_then(|t| t.first().cloned()),
        description: op.description.clone(),
        parameters,
        request_body,
        responses,
    })
}

/// v2 请求/响应体类型：operation 级 consumes/produces 优先于全局（层级序
/// 参与择优），候选集内按 JSON 家族择优（见 [`pick_media_type`]），缺省
/// application/json。
fn content_type_v2(op_level: &[String], global: &[String]) -> String {
    pick_media_type(op_level.iter().chain(global.iter()).map(String::as_str))
        .unwrap_or("application/json")
        .to_owned()
}

// —— v2 schema 受控展开 ——

/// v2 引用或内联 schema 展开（`#/definitions/Name` 查表）。
fn expand_v2_ref_or_schema(
    target: &v2::ReferenceOrSchema,
    doc: &v2::OpenAPI,
    state: &mut ExpandState,
) -> UnifiedSchema {
    match target {
        v2::ReferenceOrSchema::Reference { reference } => {
            let Some(name) = ref_tail(reference) else {
                return truncated_schema(reference);
            };
            // 循环引用：展开路径上已见 → 截断（不死锁），保留浅层类型面
            if state.visiting.contains(name) {
                return shallow_truncated_v2(name, doc);
            }
            if !state.enter() {
                return shallow_truncated_v2(name, doc);
            }
            state.visiting.insert(name.to_owned());
            // 悬空引用宽容截断（查表未命中，无从取类型面）
            let expanded = doc
                .definitions
                .as_ref()
                .and_then(|defs| defs.get(name))
                .map(|schema| expand_v2_schema(schema, doc, state))
                .unwrap_or_else(|| truncated_schema(name));
            state.visiting.remove(name);
            state.exit();
            UnifiedSchema {
                ref_name: Some(name.to_owned()),
                ..expanded
            }
        }
        v2::ReferenceOrSchema::Item(schema) => expand_v2_schema(schema, doc, state),
    }
}

/// v2 循环 / 深度截断：保留引用目标的浅层类型面（type / format /
/// description，不递归子结构）——文档预览可呈现「User（循环引用）」带类型。
fn shallow_truncated_v2(name: &str, doc: &v2::OpenAPI) -> UnifiedSchema {
    let mut truncated = truncated_schema(name);
    if let Some(schema) = doc.definitions.as_ref().and_then(|defs| defs.get(name)) {
        truncated.schema_type = schema.schema_type.clone().unwrap_or_default();
        truncated.format = schema.format.clone();
        truncated.description = schema.description.clone();
    }
    truncated
}

/// v2 内联 schema 展开（allOf 并集合并；example 从 flatten `other` 自取）。
fn expand_v2_schema(
    schema: &v2::Schema,
    doc: &v2::OpenAPI,
    state: &mut ExpandState,
) -> UnifiedSchema {
    let mut unified = UnifiedSchema {
        schema_type: schema.schema_type.clone().unwrap_or_default(),
        format: schema.format.clone(),
        description: schema.description.clone(),
        example: schema.other.get("example").cloned(),
        enum_values: schema.enum_values.clone().unwrap_or_default(),
        required: schema.required.clone().unwrap_or_default(),
        ..UnifiedSchema::empty()
    };
    if let Some(properties) = &schema.properties {
        for (name, prop) in properties {
            unified
                .properties
                .push((name.clone(), expand_v2_ref_or_schema(prop, doc, state)));
        }
    }
    if let Some(items) = &schema.items {
        unified.items = Some(Box::new(expand_v2_ref_or_schema(items, doc, state)));
    }
    if let Some(all_of) = &schema.all_of {
        let mut branches = vec![unified];
        branches.extend(
            all_of
                .iter()
                .map(|branch| expand_v2_ref_or_schema(branch, doc, state)),
        );
        unified = merge_schema_branches(branches);
    }
    unified
}

// ================================================================
// OpenAPI 3.0 方向
// ================================================================

fn normalize_v3(doc: &v3::OpenAPI) -> Result<UnifiedDoc, AppError> {
    let mut operations = Vec::new();
    for (path, item) in doc.paths.iter() {
        // 路径级 $ref（`#/paths/...`）极罕见且 crate 不支持，跳过该路径
        let Some(item) = item.as_item() else {
            continue;
        };
        let mut path_params: Vec<UnifiedParameter> = Vec::new();
        for raw in &item.parameters {
            if let Some(param) = resolve_v3_parameter(raw, doc) {
                upsert_parameter(&mut path_params, unify_v3_parameter(param, doc));
            }
        }
        for method in METHOD_ORDER {
            let Some(op) = method_v3(item, method) else {
                continue;
            };
            operations.push(unify_v3_operation(path, method, op, &path_params, doc)?);
        }
    }
    Ok(UnifiedDoc {
        title: doc.info.title.clone(),
        version: doc.info.version.clone(),
        operations,
    })
}

/// v3 PathItem 按统一方法序取 operation（trace 不在七选，天然跳过）。
fn method_v3(item: &v3::PathItem, method: HttpMethod) -> Option<&v3::Operation> {
    match method {
        HttpMethod::GET => item.get.as_ref(),
        HttpMethod::PUT => item.put.as_ref(),
        HttpMethod::POST => item.post.as_ref(),
        HttpMethod::DELETE => item.delete.as_ref(),
        HttpMethod::OPTIONS => item.options.as_ref(),
        HttpMethod::HEAD => item.head.as_ref(),
        HttpMethod::PATCH => item.patch.as_ref(),
    }
}

/// v3 参数查表：`#/components/parameters/Name` → 实体；内联原样；悬空＝None。
fn resolve_v3_parameter<'a>(
    raw: &'a v3::RefOr<v3::Parameter>,
    doc: &'a v3::OpenAPI,
) -> Option<&'a v3::Parameter> {
    match raw {
        v3::RefOr::Reference { reference } => {
            ref_tail(reference).and_then(|name| doc.components.parameters.get2(name))
        }
        v3::RefOr::Item(param) => Some(param),
    }
}

/// v3 参数归一（cookie 保真保留；类型＝参数 schema 的归一类型，Content
/// 形态的复杂参数取不到＝空串）。
fn unify_v3_parameter(param: &v3::Parameter, doc: &v3::OpenAPI) -> UnifiedParameter {
    let location = match &param.kind {
        v3::ParameterKind::Query { .. } => UnifiedParamLocation::Query,
        v3::ParameterKind::Header { .. } => UnifiedParamLocation::Header,
        v3::ParameterKind::Path { .. } => UnifiedParamLocation::Path,
        v3::ParameterKind::Cookie { .. } => UnifiedParamLocation::Cookie,
    };
    let (param_type, format) = param
        .data
        .schema()
        .map(|schema| {
            let unified = expand_v3_ref_or_schema(schema, doc, &mut ExpandState::new());
            (unified.schema_type.clone(), unified.format.clone())
        })
        .unwrap_or((String::new(), None));
    UnifiedParameter {
        name: param.data.name.clone(),
        location,
        required: param.data.required || matches!(param.kind, v3::ParameterKind::Path { .. }),
        description: param.data.description.clone(),
        param_type,
        format,
        example: param.data.example.clone(),
    }
}

fn unify_v3_operation(
    path: &str,
    method: HttpMethod,
    op: &v3::Operation,
    path_params: &[UnifiedParameter],
    doc: &v3::OpenAPI,
) -> Result<UnifiedOperation, AppError> {
    let mut parameters = path_params.to_vec();
    for raw in &op.parameters {
        if let Some(param) = resolve_v3_parameter(raw, doc) {
            upsert_parameter(&mut parameters, unify_v3_parameter(param, doc));
        }
    }

    let request_body = op.request_body.as_ref().and_then(|raw| match raw {
        v3::RefOr::Reference { reference } => ref_tail(reference)
            .and_then(|name| doc.components.request_bodies.get2(name))
            .map(|body| unify_v3_request_body(body, doc)),
        v3::RefOr::Item(body) => Some(unify_v3_request_body(body, doc)),
    });

    let mut responses: Vec<UnifiedResponse> = Vec::new();
    for (status, raw) in &op.responses.responses {
        // 悬空响应引用跳过（宽容：不整份拒绝）
        if let Some(mut unified) = unify_v3_ref_response(raw, doc) {
            unified.status = status.to_string();
            responses.push(unified);
        }
    }
    // default 响应恒排尾部（v2 的 "default" 键按文档序，v3 独立字段收敛到尾）
    if let Some(raw) = &op.responses.default
        && let Some(mut unified) = unify_v3_ref_response(raw, doc)
    {
        unified.status = "default".to_owned();
        responses.push(unified);
    }

    Ok(UnifiedOperation {
        key: crate::domain::sync::model::stable_key(method, path)?,
        method: method.as_str().to_owned(),
        path: path.to_owned(),
        // 回落为纯路径：方法由接口树行徽章承载，title 再带方法前缀会在树行
        // 呈现「GET /api/xxx」的冗余形态
        title: op.summary.clone().unwrap_or_else(|| path.to_owned()),
        category: op.tags.first().cloned(),
        description: op.description.clone(),
        parameters,
        request_body,
        responses,
    })
}

/// v3 响应查表归一：`#/components/responses/Name` → 实体；内联原样；悬空跳过。
fn unify_v3_ref_response(
    raw: &v3::RefOr<v3::Response>,
    doc: &v3::OpenAPI,
) -> Option<UnifiedResponse> {
    let response = match raw {
        v3::RefOr::Reference { reference } => {
            ref_tail(reference).and_then(|name| doc.components.responses.get2(name))?
        }
        v3::RefOr::Item(response) => response,
    };
    Some(unify_v3_response(response, doc))
}

fn unify_v3_response(response: &v3::Response, doc: &v3::OpenAPI) -> UnifiedResponse {
    // 多 content 候选择优（生成器常见一个响应声明多个 JSON 媒型，键序字母
    // 序不可靠）：按 JSON 家族权重取先，schema / example 随所选媒型
    let picked = pick_media_type(response.content.iter().map(|(ct, _)| ct.as_str()));
    let picked_media = picked.and_then(|ct| response.content.get(ct));
    let schema = picked_media
        .and_then(|media| media.schema.as_ref())
        .map(|schema| expand_v3_ref_or_schema(schema, doc, &mut ExpandState::new()));
    UnifiedResponse {
        status: String::new(),
        description: optional_str(&response.description),
        content_type: picked.map(str::to_owned),
        example: picked_media
            .and_then(|media| media.example.clone())
            .or_else(|| schema.as_ref().and_then(|s| s.example.clone())),
        schema,
    }
}

fn unify_v3_request_body(body: &v3::RequestBody, doc: &v3::OpenAPI) -> UnifiedRequestBody {
    // 多 content 候选择优（生成器常见一个 requestBody 声明多个 JSON 媒型，
    // 键序字母序不可靠）：按 JSON 家族权重取先，schema / example 随所选媒型
    let picked = pick_media_type(body.content.iter().map(|(ct, _)| ct.as_str()));
    let picked_media = picked.and_then(|ct| body.content.get(ct));
    let content_type = picked
        .map(str::to_owned)
        .unwrap_or_else(|| "application/json".to_owned());
    let schema = picked_media
        .and_then(|media| media.schema.as_ref())
        .map(|schema| expand_v3_ref_or_schema(schema, doc, &mut ExpandState::new()))
        .unwrap_or_else(UnifiedSchema::empty);
    UnifiedRequestBody {
        content_type,
        required: body.required,
        description: body.description.clone(),
        // 定义侧示例双轨：MediaType.example 优先，回退 schema 自带 example
        example: picked_media
            .and_then(|media| media.example.clone())
            .or_else(|| schema.example.clone()),
        schema,
    }
}

// —— v3 schema 受控展开 ——

/// v3 引用或内联 schema 展开（`#/components/schemas/Name` 查表）。
fn expand_v3_ref_or_schema(
    target: &v3::RefOr<v3::Schema>,
    doc: &v3::OpenAPI,
    state: &mut ExpandState,
) -> UnifiedSchema {
    match target {
        v3::RefOr::Reference { reference } => {
            let Some(name) = ref_tail(reference) else {
                return truncated_schema(reference);
            };
            // 循环引用：展开路径上已见 → 截断（不死锁），保留浅层类型面
            if state.visiting.contains(name) {
                return shallow_truncated_v3(name, doc);
            }
            if !state.enter() {
                return shallow_truncated_v3(name, doc);
            }
            state.visiting.insert(name.to_owned());
            let expanded = doc
                .components
                .schemas
                .get2(name)
                .map(|schema| expand_v3_schema(schema, doc, state))
                .unwrap_or_else(|| truncated_schema(name));
            state.visiting.remove(name);
            state.exit();
            UnifiedSchema {
                ref_name: Some(name.to_owned()),
                ..expanded
            }
        }
        v3::RefOr::Item(schema) => expand_v3_schema(schema, doc, state),
    }
}

/// v3 循环 / 深度截断：保留引用目标的浅层类型面（与 v2 同语义）。
fn shallow_truncated_v3(name: &str, doc: &v3::OpenAPI) -> UnifiedSchema {
    let mut truncated = truncated_schema(name);
    if let Some(schema) = doc.components.schemas.get2(name) {
        let (schema_type, format) = v3_shallow_type_format(schema);
        truncated.schema_type = schema_type;
        truncated.format = format;
        truncated.description = schema.data.description.clone();
    }
    truncated
}

/// v3 schema 浅层类型提取（type + format；组合形态返回空类型）。
fn v3_shallow_type_format(schema: &v3::Schema) -> (String, Option<String>) {
    use v3::SchemaKind as K;
    use v3::Type as T;
    match &schema.kind {
        K::Type(T::String(t)) => ("string".to_owned(), non_empty(t.format.as_str().to_owned())),
        K::Type(T::Number(t)) => ("number".to_owned(), non_empty(number_format(&t.format))),
        K::Type(T::Integer(t)) => ("integer".to_owned(), non_empty(integer_format(&t.format))),
        K::Type(T::Boolean {}) => ("boolean".to_owned(), None),
        K::Type(T::Object(_)) => ("object".to_owned(), None),
        K::Type(T::Array(_)) => ("array".to_owned(), None),
        _ => (String::new(), None),
    }
}

/// v3 内联 schema 展开（组合 oneOf / anyOf / allOf 并集合并）。
fn expand_v3_schema(
    schema: &v3::Schema,
    doc: &v3::OpenAPI,
    state: &mut ExpandState,
) -> UnifiedSchema {
    use v3::SchemaKind as K;
    use v3::Type as T;

    let data = &schema.data;
    let mut unified = match &schema.kind {
        K::Type(T::String(t)) => UnifiedSchema {
            schema_type: "string".to_owned(),
            format: non_empty(t.format.as_str().to_owned()),
            enum_values: t.enumeration.clone(),
            ..UnifiedSchema::empty()
        },
        K::Type(T::Number(t)) => UnifiedSchema {
            schema_type: "number".to_owned(),
            format: non_empty(number_format(&t.format)),
            ..UnifiedSchema::empty()
        },
        K::Type(T::Integer(t)) => UnifiedSchema {
            schema_type: "integer".to_owned(),
            format: non_empty(integer_format(&t.format)),
            ..UnifiedSchema::empty()
        },
        K::Type(T::Boolean {}) => UnifiedSchema {
            schema_type: "boolean".to_owned(),
            ..UnifiedSchema::empty()
        },
        K::Type(T::Object(t)) => UnifiedSchema {
            schema_type: "object".to_owned(),
            required: t.required.clone(),
            ..UnifiedSchema::empty()
        },
        K::Type(T::Array(_)) => UnifiedSchema {
            schema_type: "array".to_owned(),
            ..UnifiedSchema::empty()
        },
        K::OneOf { one_of } | K::AnyOf { any_of: one_of } | K::AllOf { all_of: one_of } => {
            let branches = one_of
                .iter()
                .map(|branch| expand_v3_ref_or_schema(branch, doc, state))
                .collect::<Vec<_>>();
            merge_schema_branches(branches)
        }
        K::Not { .. } => UnifiedSchema::empty(),
        K::Any(any) => UnifiedSchema {
            schema_type: any.typ.clone().unwrap_or_default(),
            format: any.format.clone(),
            required: any.required.clone(),
            enum_values: any
                .enumeration
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect(),
            ..UnifiedSchema::empty()
        },
    };
    unified.description = unified.description.or_else(|| data.description.clone());
    unified.example = unified.example.or_else(|| data.example.clone());
    // object 属性与 array 元素按形态挂载（Any 形态两类都可能挂）
    match &schema.kind {
        K::Type(T::Object(t)) => {
            for (name, prop) in &t.properties {
                unified
                    .properties
                    .push((name.clone(), expand_v3_ref_or_schema(prop, doc, state)));
            }
        }
        K::Type(T::Array(t)) => {
            if let Some(items) = &t.items {
                unified.items = Some(Box::new(expand_v3_ref_or_schema(items, doc, state)));
            }
        }
        K::Any(any) => {
            for (name, prop) in &any.properties {
                unified
                    .properties
                    .push((name.clone(), expand_v3_ref_or_schema(prop, doc, state)));
            }
            if let Some(items) = &any.items {
                unified.items = Some(Box::new(expand_v3_ref_or_schema(items, doc, state)));
            }
        }
        _ => {}
    }
    unified
}

fn number_format(format: &v3::VariantOrUnknownOrEmpty<v3::NumberFormat>) -> String {
    match format {
        v3::VariantOrUnknownOrEmpty::Item(v3::NumberFormat::Float) => "float".to_owned(),
        v3::VariantOrUnknownOrEmpty::Item(v3::NumberFormat::Double) => "double".to_owned(),
        v3::VariantOrUnknownOrEmpty::Unknown(raw) => raw.clone(),
        v3::VariantOrUnknownOrEmpty::Empty => String::new(),
    }
}

fn integer_format(format: &v3::VariantOrUnknownOrEmpty<v3::IntegerFormat>) -> String {
    match format {
        v3::VariantOrUnknownOrEmpty::Item(v3::IntegerFormat::Int32) => "int32".to_owned(),
        v3::VariantOrUnknownOrEmpty::Item(v3::IntegerFormat::Int64) => "int64".to_owned(),
        v3::VariantOrUnknownOrEmpty::Unknown(raw) => raw.clone(),
        v3::VariantOrUnknownOrEmpty::Empty => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::sync::model::UnifiedParamLocation;

    const SWAGGER2_FIXTURE: &str = include_str!("../../../tests/fixtures/sync/swagger2.json");
    const OPENAPI3_FIXTURE: &str = include_str!("../../../tests/fixtures/sync/openapi3.json");
    /// demo-server 真实产物固化的 OpenAPI 3.2.0 文档（utoipa 生成）。
    const UTOIPA_OPENAPI32_FIXTURE: &str =
        include_str!("../../../tests/fixtures/sync/utoipa-openapi32.json");

    /// 核心：同一业务面的两套规范（Swagger 2.0 与 OpenAPI 3.0.x）产出等价
    /// 统一模型（本地 fixture，不依赖公网）。
    #[test]
    fn both_fixtures_normalize_to_identical_doc() {
        let v2 = normalize(SWAGGER2_FIXTURE).unwrap();
        let v3 = normalize(OPENAPI3_FIXTURE).unwrap();
        assert_eq!(v2, v3);
    }

    /// 归一骨架抽查：方法序、稳定键、tag→category、summary→title。
    #[test]
    fn operations_follow_method_order_and_key_rule() {
        let doc = normalize(OPENAPI3_FIXTURE).unwrap();
        let keys: Vec<&str> = doc.operations.iter().map(|op| op.key.as_str()).collect();
        assert_eq!(
            keys,
            vec![
                "GET /users",
                "POST /users",
                "GET /users/{id}",
                "DELETE /users/{id}"
            ]
        );
        assert_eq!(doc.title, "用户管理 API");
        assert_eq!(doc.version, "1.0.0");
        let list = &doc.operations[0];
        assert_eq!(list.title, "查询用户列表");
        assert_eq!(list.category.as_deref(), Some("用户"));
        assert_eq!(list.description.as_deref(), Some("分页返回全部用户"));
    }

    /// 靶机真文档（utoipa 生成的 OpenAPI 3.2.0）可归一——版本矩阵 3.x 全系
    /// 纳入的回归锚。曾因版本判定只认 `3.0` 前缀把 demo-server 文档拒为
    /// SYNC_BAD_SWAGGER，首次同步全跳过且被前端误呈现为「无变化」。
    #[test]
    fn utoipa_openapi32_document_normalizes() {
        let doc = normalize(UTOIPA_OPENAPI32_FIXTURE).unwrap();
        assert_eq!(doc.operations.len(), 17, "17 个操作全部产出");
        assert!(doc.operations.iter().all(|op| !op.title.is_empty()));
        // title＝靶机注解的中文接口名，不带方法前缀（方法由树行徽章承载，
        // 曾整树呈现「GET /api/xxx」形态）
        assert!(doc.operations.iter().all(|op| {
            !["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]
                .iter()
                .any(|m| op.title.starts_with(m))
        }));
        // 响应与 schema 面（文档抽屉 / 合并骨架供料）可达
        let with_body = doc
            .operations
            .iter()
            .find(|op| op.request_body.is_some())
            .expect("demo-server 文档必须含请求体操作");
        assert_eq!(
            with_body.request_body.as_ref().unwrap().schema.schema_type,
            "object"
        );
        // 可空字段（3.1 type 数组降级）：主类型保真
        let nullable = doc
            .operations
            .iter()
            .flat_map(|op| op.parameters.iter())
            .find(|p| p.param_type == "integer")
            .expect("参数类型面必须在降级后保留");
        assert_eq!(nullable.param_type, "integer");
    }

    /// 文档校验：非法 JSON / 缺版本字段 / 不支持版本（swagger 字段 3.x、
    /// openapi 字段 2.x）稳定报错。3.1+ 已纳入支持矩阵（见版本判定注释）。
    #[test]
    fn rejects_invalid_documents_with_stable_code() {
        for raw in [
            "not json at all",
            r##"{"foo": 1}"##,
            r##"{"swagger": "3.0.0", "paths": {}}"##,
            r##"{"openapi": "2.0.0", "paths": {}}"##,
        ] {
            let err = normalize(raw).unwrap_err();
            assert_eq!(err.code, codes::SYNC_BAD_SWAGGER, "input: {raw}");
        }
    }

    /// 循环引用不死锁：User.friends 自引用在第二层截断（truncated＋引用名）。
    #[test]
    fn circular_reference_is_truncated_not_deadlocked() {
        let doc = normalize(SWAGGER2_FIXTURE).unwrap();
        let get_one = doc
            .operations
            .iter()
            .find(|op| op.key == "GET /users/{id}")
            .unwrap();
        let user = get_one.responses[0].schema.as_ref().unwrap();
        // 第一层正常展开：friends 是 array
        let friends = user
            .properties
            .iter()
            .find(|(name, _)| name == "friends")
            .unwrap();
        assert_eq!(friends.1.schema_type, "array");
        // 第二层（items 再遇 User）截断
        let items = friends.1.items.as_ref().unwrap();
        assert_eq!(items.ref_name.as_deref(), Some("User"));
        assert!(items.truncated);
        assert!(items.properties.is_empty(), "截断分支不得再下钻");
        // 双向环（A→B→A）同样收敛
        let cyclic = r##"{"swagger":"2.0","info":{"title":"环","version":"1"},
            "paths":{"/a":{"get":{"responses":{"200":{"description":"ok",
            "schema":{"$ref":"#/definitions/A"}}}}}},
            "definitions":{
              "A":{"type":"object","properties":{"b":{"$ref":"#/definitions/B"}}},
              "B":{"type":"object","properties":{"a":{"$ref":"#/definitions/A"}}}}}"##;
        let doc = normalize(cyclic).unwrap();
        let a = doc.operations[0].responses[0].schema.as_ref().unwrap();
        assert_eq!(a.ref_name.as_deref(), Some("A"));
        let b = a.properties.iter().find(|(n, _)| n == "b").unwrap();
        assert_eq!(b.1.ref_name.as_deref(), Some("B"));
        let a2 = b.1.properties.iter().find(|(n, _)| n == "a").unwrap();
        assert!(a2.1.truncated, "环回引用必须截断");
    }

    /// 悬空引用宽容截断（不整份拒绝，保留可用面）。
    #[test]
    fn dangling_ref_is_tolerated_as_truncated() {
        let raw = r##"{"swagger":"2.0","info":{"title":"悬空","version":"1"},
            "paths":{"/a":{"get":{"responses":{"200":{"description":"ok",
            "schema":{"$ref":"#/definitions/Missing"}}}}}}}"##;
        let doc = normalize(raw).unwrap();
        let schema = doc.operations[0].responses[0].schema.as_ref().unwrap();
        assert_eq!(schema.ref_name.as_deref(), Some("Missing"));
        assert!(schema.truncated);
    }

    /// 2.0 全局参数 / 响应复用（`#/parameters/`、`#/responses/`）内联归一。
    #[test]
    fn v2_global_parameter_and_response_refs_are_inlined() {
        let raw = r##"{"swagger":"2.0","info":{"title":"全局复用","version":"1"},
            "paths":{"/items":{"get":{
              "parameters":[{"$ref":"#/parameters/PageParam"}],
              "responses":{"200":{"$ref":"#/responses/ItemList"}}}}},
            "parameters":{"PageParam":{"name":"page","in":"query","type":"integer","description":"页码"}},
            "responses":{"ItemList":{"description":"列表","schema":{"type":"array","items":{"type":"string"}}}}}"##;
        let doc = normalize(raw).unwrap();
        let op = &doc.operations[0];
        // $ref 参数已内联成实体（不因 crate 模型不建模引用而产空参数）
        assert_eq!(op.parameters.len(), 1);
        assert_eq!(op.parameters[0].name, "page");
        assert_eq!(op.parameters[0].location, UnifiedParamLocation::Query);
        assert_eq!(op.parameters[0].param_type, "integer");
        assert_eq!(op.parameters[0].description.as_deref(), Some("页码"));
        // $ref 响应内联
        let response = &op.responses[0];
        assert_eq!(response.status, "200");
        assert_eq!(response.description.as_deref(), Some("列表"));
        assert_eq!(response.schema.as_ref().unwrap().schema_type, "array");
    }

    /// 3.0 components 复用（parameters / requestBodies / responses）查表归一。
    #[test]
    fn v3_components_refs_resolve() {
        let raw = r##"{"openapi":"3.0.1","info":{"title":"组件复用","version":"1"},
            "paths":{"/items":{"post":{
              "parameters":[{"$ref":"#/components/parameters/Limit"}],
              "requestBody":{"$ref":"#/components/requestBodies/ItemBody"},
              "responses":{"200":{"$ref":"#/components/responses/ItemOut"}}}}},
            "components":{
              "parameters":{"Limit":{"name":"limit","in":"query","schema":{"type":"integer"}}},
              "requestBodies":{"ItemBody":{"required":true,"content":{"application/json":{
                "schema":{"type":"object","properties":{"name":{"type":"string"}}}}}}},
              "responses":{"ItemOut":{"description":"输出","content":{"application/json":{
                "schema":{"type":"string"}}}}}}}"##;
        let doc = normalize(raw).unwrap();
        let op = &doc.operations[0];
        assert_eq!(op.parameters[0].name, "limit");
        assert_eq!(op.parameters[0].param_type, "integer");
        let body = op.request_body.as_ref().unwrap();
        assert!(body.required);
        assert_eq!(body.schema.schema_type, "object");
        assert_eq!(op.responses[0].description.as_deref(), Some("输出"));
        assert_eq!(
            op.responses[0].schema.as_ref().unwrap().schema_type,
            "string"
        );
    }

    /// trace 不在方法七选内（2025-09-27 裁定）：v3 文档的 trace operation 跳过。
    #[test]
    fn trace_method_is_skipped() {
        let raw = r##"{"openapi":"3.0.1","info":{"title":"t","version":"1"},
            "paths":{"/a":{"get":{"responses":{"200":{"description":"ok"}}},
            "trace":{"responses":{"200":{"description":"ok"}}}}}}"##;
        let doc = normalize(raw).unwrap();
        assert_eq!(doc.operations.len(), 1);
        assert_eq!(doc.operations[0].key, "GET /a");
    }

    /// 非法路由模板整份拒绝（入树必须过同一校验，与其应用时炸不如拉取时报）。
    /// 注：v3 模型只收 `/` 开头的路径键，非斜杠键在其解析层已被丢弃；
    /// 本用例取「斜杠开头但含查询串」的非法形态（两套规范都能进到校验）。
    #[test]
    fn invalid_path_template_rejects_whole_document() {
        let raw = r##"{"openapi":"3.0.1","info":{"title":"t","version":"1"},
            "paths":{"/a?x=1":{"get":{"responses":{"200":{"description":"ok"}}}}}}"##;
        let err = normalize(raw).unwrap_err();
        assert_eq!(err.code, codes::INVALID_PATH_TEMPLATE);
    }

    /// allOf 组合按属性并集合并（继承形态的 key 面）。
    #[test]
    fn all_of_merges_branch_properties() {
        let raw = r##"{"swagger":"2.0","info":{"title":"组合","version":"1"},
            "paths":{"/a":{"get":{"responses":{"200":{"description":"ok",
            "schema":{"allOf":[
              {"$ref":"#/definitions/Base"},
              {"type":"object","properties":{"extra":{"type":"string"}},"required":["extra"]}]}}}}}},
            "definitions":{"Base":{"type":"object",
            "properties":{"id":{"type":"integer"}},"required":["id"]}}}"##;
        let doc = normalize(raw).unwrap();
        let schema = doc.operations[0].responses[0].schema.as_ref().unwrap();
        assert_eq!(schema.schema_type, "object");
        let names: Vec<&str> = schema.properties.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["id", "extra"]);
        assert_eq!(schema.required, vec!["id", "extra"]);
    }

    /// v3 default 响应恒排尾部；无 content 的响应（204）content/schema 为空。
    #[test]
    fn default_response_goes_last_and_empty_response_has_no_content() {
        let raw = r##"{"openapi":"3.0.1","info":{"title":"t","version":"1"},
            "paths":{"/a":{"delete":{
              "responses":{
                "204":{"description":"无内容"},
                "default":{"description":"兜底","content":{"application/json":{"schema":{"type":"string"}}}}}}}}}"##;
        let doc = normalize(raw).unwrap();
        let responses = &doc.operations[0].responses;
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0].status, "204");
        assert_eq!(responses[0].content_type, None);
        assert_eq!(responses[0].schema, None);
        assert_eq!(responses[1].status, "default");
        assert_eq!(responses[1].schema.as_ref().unwrap().schema_type, "string");
    }

    /// summary 缺省回落纯路径（title 恒非空；方法由树行徽章承载，不带前缀）。
    #[test]
    fn summary_fallback_derives_from_path_only() {
        let raw = r##"{"openapi":"3.0.1","info":{"title":"t","version":"1"},
            "paths":{"/a":{"get":{"responses":{"200":{"description":"ok"}}}}}}"##;
        let doc = normalize(raw).unwrap();
        assert_eq!(doc.operations[0].title, "/a");
        assert_eq!(doc.operations[0].category, None);
    }

    /// path 级参数先行、operation 级同名覆盖（name+location 判重）。
    #[test]
    fn operation_level_parameter_overrides_path_level() {
        let raw = r##"{"openapi":"3.0.1","info":{"title":"t","version":"1"},
            "paths":{"/a":{
              "parameters":[{"name":"verbose","in":"query","schema":{"type":"boolean"},"description":"路径级"}],
              "get":{
                "parameters":[{"name":"verbose","in":"query","schema":{"type":"boolean"},"description":"操作级"}],
                "responses":{"200":{"description":"ok"}}}}}}"##;
        let doc = normalize(raw).unwrap();
        let params = &doc.operations[0].parameters;
        assert_eq!(params.len(), 1);
        assert_eq!(params[0].description.as_deref(), Some("操作级"));
    }

    /// v3 参数级 example 一等公民可达（2.0 无此面，恒 None——不进对齐 fixture）。
    #[test]
    fn v3_parameter_example_is_carried() {
        let raw = r##"{"openapi":"3.0.1","info":{"title":"t","version":"1"},
            "paths":{"/a":{"get":{
              "parameters":[{"name":"lang","in":"query","schema":{"type":"string"},"example":"zh-CN"}],
              "responses":{"200":{"description":"ok"}}}}}}"##;
        let doc = normalize(raw).unwrap();
        assert_eq!(
            doc.operations[0].parameters[0].example,
            Some(serde_json::json!("zh-CN"))
        );
    }

    /// MediaType.example 优先于 schema example（定义侧示例双轨）。
    #[test]
    fn media_type_example_takes_precedence_over_schema_example() {
        let raw = r##"{"openapi":"3.0.1","info":{"title":"t","version":"1"},
            "paths":{"/a":{"post":{"requestBody":{"content":{"application/json":{
              "schema":{"type":"object","example":{"from":"schema"}},
              "example":{"from":"media"}}}},
              "responses":{"200":{"description":"ok"}}}}}}"##;
        let doc = normalize(raw).unwrap();
        let body = doc.operations[0].request_body.as_ref().unwrap();
        assert_eq!(body.example, Some(serde_json::json!({"from": "media"})));
    }

    /// 多 content 媒体类型择优（请求体）：Swashbuckle 产物四 JSON 媒型同现
    /// （serde_json Map 字母序使 `application/*+json` 排最前），按「精确
    /// application/json ＞ +json 变体与 text/json ＞ 其余」取先。
    #[test]
    fn request_body_picks_exact_json_among_multiple_media_types() {
        let raw = r##"{"openapi":"3.0.1","info":{"title":"t","version":"1"},
            "paths":{"/a":{"post":{"requestBody":{"content":{
              "application/*+json":{"schema":{"type":"object","properties":{"star":{"type":"string"}}}},
              "application/json":{"schema":{"type":"object","properties":{"exact":{"type":"string"}}}},
              "text/json":{"schema":{"type":"object","properties":{"text":{"type":"string"}}}},
              "application/json-patch+json":{"schema":{"type":"object","properties":{"patch":{"type":"string"}}}}
            }},"responses":{"200":{"description":"ok"}}}}}}"##;
        let doc = normalize(raw).unwrap();
        let body = doc.operations[0].request_body.as_ref().unwrap();
        assert_eq!(
            body.content_type, "application/json",
            "精确 application/json 最优先"
        );
        // schema 内容随所选媒型取（不残留其它媒型的 schema）
        let names: Vec<&str> = body
            .schema
            .properties
            .iter()
            .map(|(n, _)| n.as_str())
            .collect();
        assert_eq!(names, vec!["exact"]);
    }

    /// 多 content 媒体类型择优（响应侧同口径）：无精确 application/json 时
    /// +json 变体与 text/json 同属 JSON 家族按序取先。
    #[test]
    fn response_picks_json_family_among_multiple_media_types() {
        let raw = r##"{"openapi":"3.0.1","info":{"title":"t","version":"1"},
            "paths":{"/a":{"get":{"responses":{"200":{"description":"ok","content":{
              "application/*+json":{"schema":{"type":"string"}},
              "text/json":{"schema":{"type":"integer"}}}}}}}}}"##;
        let doc = normalize(raw).unwrap();
        let response = &doc.operations[0].responses[0];
        assert_eq!(
            response.content_type.as_deref(),
            Some("application/*+json"),
            "+json 变体先于 text/json"
        );
        assert_eq!(response.schema.as_ref().unwrap().schema_type, "string");
    }

    /// v2 consumes 多值同口径择优（operation 级优先语义保持，值内择优）。
    #[test]
    fn v2_consumes_multiple_values_pick_json_family() {
        let raw = r##"{"swagger":"2.0","info":{"title":"t","version":"1"},
            "paths":{"/a":{"post":{
              "consumes":["application/xml","application/*+json","application/json"],
              "parameters":[{"name":"body","in":"body","schema":{"type":"object"}}],
              "responses":{"200":{"description":"ok"}}}}}}"##;
        let doc = normalize(raw).unwrap();
        let body = doc.operations[0].request_body.as_ref().unwrap();
        assert_eq!(body.content_type, "application/json");
    }

    /// 2.0 的 `in: formData` 参数保真保留（form 系 body 行的参数面）。
    #[test]
    fn v2_form_data_parameter_is_preserved() {
        let raw = r##"{"swagger":"2.0","info":{"title":"t","version":"1"},
            "paths":{"/upload":{"post":{
              "parameters":[{"name":"file","in":"formData","required":true,"type":"file","description":"附件"}],
              "responses":{"200":{"description":"ok"}}}}}}"##;
        let doc = normalize(raw).unwrap();
        let param = &doc.operations[0].parameters[0];
        assert_eq!(param.location, UnifiedParamLocation::FormData);
        assert!(param.required);
        assert_eq!(param.param_type, "file");
    }
}
