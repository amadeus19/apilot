//! 请求合成：接口定义＋用户数据＋覆写 → [`RequestModel`]（引擎的纯输入）。
//!
//! 用户数据 params / headers 的 JSON 契约（行 / 信封模型与解析单点在
//! [`crate::domain::user_data_codec`]；kv-editor 组装 ⇄ 此处解析，双端由
//! 共享契约夹具 `src/test/fixtures/kv-contract.json` 钉住）：字符串字段对象数组
//! `[{"name":"a","value":"1","type"?:string,"description"?:string,"enabled"?:bool}]`
//! （type / description 为可选标注，容忍缺失或非字符串形态；form-data 行的
//! `type=="file"` 在发送面分流为文件 part，其余标注不进发送语义；
//! enabled 为行级启停，容忍缺失或非布尔形态——缺省启用，禁用行发送面全链路
//! 过滤：不进 path 填充、不进 query、不进头、不进表单体）；空 name
//! 行保存但发送时跳过；结构性非法形态（非数组 / 非字符串 name/value）解析
//! 拒绝（fail-fast，不改写用户数据）。
//!
//! 用户数据 body 列的类型信封（kv-editor 组装 ⇄ 此处解析）：紧凑 JSON
//! `{"kind":"none"|"json"|"xml"|"text"|"urlencoded"|"form-data","text"?:string,
//! "rows"?:[{name,value,type?,description?,enabled?}]}`——urlencoded / form-data
//! 用 rows，其余用 text（none 可两字段皆无）。行 enabled 与 params/headers
//! 同一口径（缺失 / 非布尔缺省启用，禁用行不进表单体）。读侧容忍（迁移口径，
//! 不加列不做写库迁移，下次保存自然升级为信封）：读到非信封旧纯文本时按
//! 内容嗅探回填分类，但发送行为与信封化之前完全一致——显式类型化自信封
//! 写入形态始，Body 类型集不含 auto，嗅探只作读侧迁移口径。
//!
//! 参数位置分治：param 行名命中路径模板占位符 `{name}` 即 path 参数（填充占位、
//! 不进 query），其余为 query 参数。`{{变量}}` 引用原样透传（变量解析点亮后生效）。

use crate::domain::endpoint::{Definition, HttpMethod};
use crate::domain::user_data_codec::{
    BodyEnvelope, BodyEnvelopeKind, KvRow, kv_row_from_json, parse_body_envelope,
};
use crate::domain::variable::EffectiveVariable;
use crate::domain::variable_resolver::{
    ResolutionHit, resolve_json_body, resolve_value, secret_values_from_hits,
};
use crate::error::AppError;
use crate::error::codes;

/// Body 判别联合五形态。synthesize 按信封 kind 构造（None / Raw / FormUrlEncoded /
/// Multipart）；用户 json kind 走 Raw 保原文（用户排版不因发送改变，不走
/// `Json(Value)` 的重序列化），`Json(Value)` 无用户构造面，供 Workflow 域后续点亮。
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq)]
pub enum BodyKind {
    None,
    Json(serde_json::Value),
    FormUrlEncoded(Vec<KvRow>),
    Multipart(Vec<MultipartField>),
    Raw {
        bytes: Vec<u8>,
        content_type: String,
    },
}

/// multipart 字段两形态：文本字段直传值；文件字段以完整路径承载（行 value
/// 即路径，发送时文件名＝路径 basename、mime 按扩展名推断，见引擎侧）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MultipartField {
    Text { name: String, value: String },
    File { name: String, path: String },
}

/// 旧纯文本嗅探分类（读侧迁移口径；不进入发送合成的 Content-Type 判定）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LegacyBodyKind {
    None,
    Json,
    Xml,
    Text,
}

/// legacy 纯文本读侧嗅探（迁移口径）：空→None；合法 JSON→Json；XML 形态
/// （`<?xml` 声明或元素起头，trim 后以 `<` 开头）→Xml；其余→Text。
fn sniff_legacy_kind(text: &str) -> LegacyBodyKind {
    if text.trim().is_empty() {
        return LegacyBodyKind::None;
    }
    if serde_json::from_str::<serde_json::Value>(text).is_ok() {
        return LegacyBodyKind::Json;
    }
    if text.trim_start().starts_with('<') {
        return LegacyBodyKind::Xml;
    }
    LegacyBodyKind::Text
}

/// 解析用户数据 params / headers 的 JSON 列为 KV 行（契约见模块注释）。
/// type / description 为可选标注、enabled 为行级启停：三者均容忍缺失或
/// 形态不符（标注归 None、enabled 缺省启用，不报错）。
/// 结构性非法形态返回 `HTTP_SYNTHESIS_INVALID`（调用方 fail-fast，不静默丢弃数据）。
pub fn parse_kv_json(raw: &str, field: &str) -> Result<Vec<KvRow>, AppError> {
    let parsed: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
        AppError::new(
            codes::HTTP_SYNTHESIS_INVALID,
            format!("user data {field} column is not valid JSON: {e}"),
        )
    })?;
    let serde_json::Value::Array(items) = parsed else {
        return Err(AppError::new(
            codes::HTTP_SYNTHESIS_INVALID,
            format!("user data {field} column must be a JSON array of {{name, value}}"),
        ));
    };
    let mut rows = Vec::with_capacity(items.len());
    for item in items {
        let invalid = || {
            AppError::new(
                codes::HTTP_SYNTHESIS_INVALID,
                format!(
                    "user data {field} column rows must be objects with string name/value fields"
                ),
            )
        };
        let obj = item.as_object().ok_or_else(invalid)?;
        rows.push(kv_row_from_json(obj).ok_or_else(invalid)?);
    }
    Ok(rows)
}

/// CLI 发送覆写：同名替换＋后值胜；`--body` 整体替换（不与用户数据合并）；
/// 覆写永不写回用户数据。
#[derive(Debug, Clone, Default)]
pub struct SendOverrides {
    /// 参数行覆写（--param / --query 同名合并进同一组行；行是 path 参数还是
    /// query 参数由 build_url 的路径模板占位符命中分流，名字不预设位置）
    pub param_rows: Vec<KvRow>,
    /// 头覆写（--header）
    pub headers: Vec<KvRow>,
    /// 请求体整体替换（--body 原文）
    pub body: Option<String>,
}

/// 合成输入：接口定义＋工作空间 BaseUrl＋接口级覆写＋用户数据三列＋覆写＋
/// 生效变量集（Resolver 输入；空集＝不解析，`{{...}}` 原样透传的既有语义）。
pub struct SynthesisInput<'a> {
    pub definition: &'a Definition,
    /// 工作空间 BaseUrl（`workspaces.base_url` 列；恒字面，不解析模板）
    pub base_url: Option<&'a str>,
    /// 接口级 BaseUrl 覆写（GUI Tab 会话态；按值列口径解析后优先于 base_url，
    /// 空白值视同未覆写——回落工作空间生效值）
    pub base_url_override: Option<&'a str>,
    /// 用户数据 body 列（None＝未编辑）
    pub user_body: Option<&'a str>,
    /// 用户数据 params 列 JSON
    pub user_params: &'a str,
    /// 用户数据 headers 列 JSON
    pub user_headers: &'a str,
    /// 路径覆写（用户数据层；非空值优先于 definition.path_template，空白视同未覆写）
    pub path_override: Option<&'a str>,
    /// 方法覆写（用户数据层；非空值优先于 definition.method，空白视同未覆写）
    pub method_override: Option<&'a str>,
    pub overrides: &'a SendOverrides,
    /// 生效变量集（兜底链合成结果；GUI 发送、Variable Preview、CLI 同一输入源）
    pub variables: &'a [EffectiveVariable],
}

/// 合成产物：引擎输入模型＋变量解析记录（预览素材与 Secret 消费清单）。
#[derive(Debug, Clone, PartialEq)]
pub struct SynthesisOutput {
    pub model: RequestModel,
    /// 本次合成的全部模板命中记录（含未命中；认证值解析归编排层另行并入）
    pub hits: Vec<ResolutionHit>,
    /// 本次消费的 Secret 值清单（并入 redactions，展示与输出面全文替换掩码）
    pub secret_values: Vec<String>,
}

/// 合成产物：引擎输入（auth 注入前的用户意图模型——认证头由编排层在
/// 用户头之上叠加，见 auth 模块）。
#[derive(Debug, Clone, PartialEq)]
pub struct RequestModel {
    pub method: HttpMethod,
    /// 最终 URL（BaseUrl＋路径填充＋query 拼接）
    pub url: String,
    pub headers: Vec<KvRow>,
    pub body: BodyKind,
}

/// 同名替换＋后值胜合并（overrides 内部先去重，再覆盖 user 同名行）。
fn merge_rows(user: Vec<KvRow>, overrides: &[KvRow]) -> Vec<KvRow> {
    let mut merged: Vec<KvRow> = user;
    for ov in overrides {
        if let Some(existing) = merged.iter_mut().find(|r| r.key == ov.key) {
            *existing = ov.clone();
        } else {
            merged.push(ov.clone());
        }
    }
    merged
}

/// 覆写行集内部去重（同 key 后值胜）：CLI 重复传同一 key 时只保留最后一个。
fn dedupe_last(rows: &[KvRow]) -> Vec<KvRow> {
    let mut out: Vec<KvRow> = Vec::with_capacity(rows.len());
    for row in rows {
        if let Some(existing) = out.iter_mut().find(|r| r.key == row.key) {
            *existing = row.clone();
        } else {
            out.push(row.clone());
        }
    }
    out
}

/// 百分号编码（query 值 / path 段）：非保留字符直通，其余按 UTF-8 百分号编码。
/// 空格编码为 `%20`（URL 语义，非表单 `+`）。
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// urlencoded 体序列化（发送与镜像共用的单源口径）：enabled 且 key 非空的行
/// 参与，键值经 [`percent_encode`] 编码（空格 `%20`、中文按 UTF-8 百分号编码、
/// `=` / `&` 等结构字符编码后不破坏 `k=v&…` 形态）。发送体与请求镜像都由此
/// 生成，二者逐字节一致，镜像不留痕与发送形态的偏差。
pub fn serialize_urlencoded(rows: &[KvRow]) -> String {
    rows.iter()
        .filter(|r| r.enabled && !r.key.is_empty())
        .map(|r| format!("{}={}", percent_encode(&r.key), percent_encode(&r.value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// 提取路径模板的占位符名（`{id}` → `id`；`{{变量}}` 双括号是变量引用，跳过）。
fn template_placeholders(template: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('}') else { break };
        let inner = &after[..end];
        // 双括号 {{...}} 是变量引用占位（变量域点亮前原样透传），不是 path 参数
        if !inner.starts_with('{') {
            names.push(inner.to_string());
        }
        rest = &after[end + 1..];
    }
    names
}

/// URL 构建：BaseUrl ＋ path template 占位替换 ＋ query 拼接。
/// 未命中的占位符原样保留（透传语义，服务端 404 即真实反馈）。
/// 模板为绝对 URL 形态（`http://` / `https://` 开头）时完全绕过 BaseUrl
/// （未配置 / 非法配置均不校验、不拼接）——host 已在模板内，跨主机请求
/// 与无 BaseUrl 工作空间均可发送；相对模板维持「BaseUrl 必配且必为
/// http(s) scheme」的既有约束。
pub fn build_url(
    base_url: Option<&str>,
    template: &str,
    params: &[KvRow],
) -> Result<String, AppError> {
    // path 占位替换：参数行按名匹配（enabled 且非空 key）
    let placeholders = template_placeholders(template);
    let mut path = template.to_string();
    let mut consumed: Vec<&str> = Vec::new();
    for name in &placeholders {
        if let Some(row) = params
            .iter()
            .find(|r| r.enabled && r.key == *name && !r.value.is_empty())
        {
            path = path.replace(&format!("{{{name}}}"), &percent_encode(&row.value));
            consumed.push(name.as_str());
        }
    }

    // query 拼接：未被 path 消费、key 非空、enabled 的行
    let mut query = String::new();
    for row in params {
        if !row.enabled || row.key.is_empty() || consumed.contains(&row.key.as_str()) {
            continue;
        }
        // 同名 query 多值：全部保留（数组语义交服务端）
        if !query.is_empty() {
            query.push('&');
        }
        query.push_str(&percent_encode(&row.key));
        query.push('=');
        query.push_str(&percent_encode(&row.value));
    }

    // 绝对 URL 模板：host 已在模板内，不拼 BaseUrl（配置缺省亦放行）
    let is_absolute_url = template.starts_with("http://") || template.starts_with("https://");
    let mut url = if is_absolute_url {
        path
    } else {
        let base = base_url
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .ok_or_else(|| {
                AppError::new(codes::URL_INVALID, "workspace base url is not configured")
            })?;
        let base = base.trim_end_matches('/');
        if !base.starts_with("http://") && !base.starts_with("https://") {
            return Err(AppError::new(
                codes::URL_INVALID,
                format!("workspace base url must start with http:// or https://: {base}"),
            ));
        }
        format!("{base}{path}")
    };
    if !query.is_empty() {
        url.push('?');
        url.push_str(&query);
    }
    Ok(url)
}

/// 信封 → BodyKind 合成。Raw 三 kind 的默认 Content-Type 按 kind 取值；
/// 显式 Content-Type 头恒优先（现有语义对全部 kind 保持）：有显式头时模型内
/// content_type 让位为空（引擎照发用户头）。表单两形态的模型变体不含
/// content_type，传输层默认头由引擎既有行为处理。
fn envelope_body_kind(envelope: BodyEnvelope, has_explicit_content_type: bool) -> BodyKind {
    let raw = |text: Option<String>, default: &str| match text {
        Some(text) if !text.trim().is_empty() => BodyKind::Raw {
            bytes: text.into_bytes(),
            content_type: if has_explicit_content_type {
                // 显式头由引擎照发；模型内记录仅作镜像素材
                String::new()
            } else {
                default.to_string()
            },
        },
        // 空体信封容忍：与「空体为 None」的全局语义对齐
        _ => BodyKind::None,
    };
    match envelope.kind {
        BodyEnvelopeKind::None => BodyKind::None,
        BodyEnvelopeKind::Json => raw(envelope.text, "application/json"),
        BodyEnvelopeKind::Xml => raw(envelope.text, "application/xml"),
        BodyEnvelopeKind::Text => raw(envelope.text, "text/plain"),
        BodyEnvelopeKind::FormUrlEncoded => BodyKind::FormUrlEncoded(envelope.rows),
        BodyEnvelopeKind::FormData => BodyKind::Multipart(
            // 行 type=="file" 分流为文件 part（路径即行 value），其余按文本；
            // 禁用行与空名行不进 multipart 体（urlencoded 侧由
            // serialize_urlencoded 同口径过滤，cURL 导出侧同一过滤）
            envelope
                .rows
                .into_iter()
                .filter(|row| row.enabled && !row.key.is_empty())
                .map(|row| match row.type_.as_deref() {
                    Some("file") => MultipartField::File {
                        name: row.key,
                        path: row.value,
                    },
                    _ => MultipartField::Text {
                        name: row.key,
                        value: row.value,
                    },
                })
                .collect(),
        ),
    }
}

/// legacy 纯文本的合成（读侧嗅探回填，发送行为与信封化之前逐字段一致）：
/// JSON 文本→application/json，其余（XML 与普通文本）→text/plain——XML 不因
/// 嗅探回填改判 application/xml，显式类型化自信封写入形态始。
fn legacy_body_kind(text: &str, has_explicit_content_type: bool) -> BodyKind {
    match sniff_legacy_kind(text) {
        // 外层已滤空白，此分支为嗅探函数完备性的防御面
        LegacyBodyKind::None => BodyKind::None,
        kind => BodyKind::Raw {
            bytes: text.as_bytes().to_vec(),
            content_type: if has_explicit_content_type {
                // 显式头由引擎照发；模型内记录仅作镜像素材
                String::new()
            } else if kind == LegacyBodyKind::Json {
                "application/json".to_string()
            } else {
                "text/plain".to_string()
            },
        },
    }
}

/// 合成（定义＋用户数据＋覆写＋变量解析 → Model＋解析记录）。Body 取值：
/// 覆写 body 整体替换 ＞ 用户 body 列；空体为 None。CLI `--body` 覆写恒走
/// legacy 纯文本路径（CLI 面口径：覆写值即字面文本，不解析信封——CLI 传纯
/// 文本覆写 GUI 信封草稿时按文本语义发送）；GUI 信封草稿按 kind 合成，非信封
/// 旧纯文本嗅探回填、行为零变化。Content-Type 未显式设置时的默认仅服务 DX
/// （信封按 kind、legacy 嗅探 JSON），显式头恒优先。
///
/// 变量解析位置白名单（spec「变量域」）：params·headers 的值列 / body /
/// URL 逐段（路径模板、覆写值）；Key 列不解析；未命中原样保留。URL 次序＝
/// 逐段先解析后组合：判绝对在解析后（`build_url` 收到的已是解析后模板，
/// 解析结果以 http(s):// 开头即直发、绕过 BaseUrl）；工作空间 base_url 恒
/// 字面不解析。
pub fn synthesize(input: &SynthesisInput<'_>) -> Result<SynthesisOutput, AppError> {
    let user_params = parse_kv_json(input.user_params, "params")?;
    let user_headers = parse_kv_json(input.user_headers, "headers")?;
    let mut params = merge_rows(user_params, &dedupe_last(&input.overrides.param_rows));
    let mut headers = merge_rows(user_headers, &dedupe_last(&input.overrides.headers));
    let mut hits: Vec<ResolutionHit> = Vec::new();

    // 值列解析（params / headers 的 value；Key 列不动）
    for row in &mut params {
        let resolved = resolve_value(&row.value, input.variables);
        hits.extend(resolved.hits);
        row.value = resolved.text;
    }
    for row in &mut headers {
        let resolved = resolve_value(&row.value, input.variables);
        hits.extend(resolved.hits);
        row.value = resolved.text;
    }

    // URL 逐段先解析后组合：模板解析 → 覆写值解析（值列口径）→ 基址取值
    // （覆写优先、恒以解析后形态参与；工作空间 base_url 恒字面）。路径模板
    // 取覆写优先：非空 path_override 顶替定义模板（变量解析口径不变），空白
    // 视同未覆写
    let template = input
        .path_override
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .unwrap_or(&input.definition.path_template);
    let resolved_template = resolve_value(template, input.variables);
    hits.extend(resolved_template.hits);
    let effective_base: Option<String> = match input.base_url_override.map(str::trim) {
        Some(override_value) if !override_value.is_empty() => {
            let resolved = resolve_value(override_value, input.variables);
            hits.extend(resolved.hits);
            Some(resolved.text)
        }
        _ => input.base_url.map(str::to_owned),
    };
    let url = build_url(effective_base.as_deref(), &resolved_template.text, &params)?;

    // 方法取覆写优先：非空 method_override 顶替定义方法（七选解析口径与
    // 写侧一致），空白视同未覆写
    let method = match input
        .method_override
        .map(str::trim)
        .filter(|m| !m.is_empty())
    {
        Some(override_method) => HttpMethod::parse(override_method)?,
        None => input.definition.method,
    };

    let has_explicit_content_type = headers
        .iter()
        .any(|r| r.enabled && r.key.eq_ignore_ascii_case("content-type"));

    // body 解析挂接：文本载体（信封 text / legacy / CLI 覆写）合法 JSON 走
    // 结构级替换（属性名与转义保真），否则降级文本级；表单 rows 值列解析
    let body = if let Some(text) = input
        .overrides
        .body
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
    {
        // 覆写 body 整体替换（整体优先级 ＞ 用户 body 列）：恒 legacy 纯文本语义
        let resolved = resolve_json_body(text, input.variables);
        hits.extend(resolved.hits);
        legacy_body_kind(&resolved.text, has_explicit_content_type)
    } else if let Some(text) = input.user_body.map(str::trim).filter(|b| !b.is_empty()) {
        match parse_body_envelope(text) {
            Some(mut envelope) => {
                if let Some(text) = envelope.text.take() {
                    let resolved = resolve_json_body(&text, input.variables);
                    hits.extend(resolved.hits);
                    envelope.text = Some(resolved.text);
                }
                for row in &mut envelope.rows {
                    let resolved = resolve_value(&row.value, input.variables);
                    hits.extend(resolved.hits);
                    row.value = resolved.text;
                }
                envelope_body_kind(envelope, has_explicit_content_type)
            }
            None => {
                let resolved = resolve_json_body(text, input.variables);
                hits.extend(resolved.hits);
                legacy_body_kind(&resolved.text, has_explicit_content_type)
            }
        }
    } else {
        BodyKind::None
    };

    let secret_values = secret_values_from_hits(&hits);
    Ok(SynthesisOutput {
        model: RequestModel {
            method,
            url,
            headers,
            body,
        },
        hits,
        secret_values,
    })
}

#[cfg(test)]
mod tests {
    // 测试夹具以 Default + 单点字段覆盖表达用例焦点；改结构体字面量会把
    // 每个用例淹没在无关字段里（可读性优先的定向豁免）
    #![allow(clippy::field_reassign_with_default)]
    use super::*;

    fn definition(method: HttpMethod, path: &str) -> Definition {
        Definition::new(method, path).unwrap()
    }
    #[test]
    fn synthesize_method_override_takes_precedence_over_definition() {
        let definition = definition(HttpMethod::GET, "/users");
        let input = SynthesisInput {
            definition: &definition,
            base_url: Some("https://api.example.com"),
            base_url_override: None,
            user_body: None,
            user_params: "[]",
            user_headers: "[]",
            path_override: None,
            method_override: Some("post"),
            overrides: &SendOverrides::default(),
            variables: &[],
        };
        let output = synthesize(&input).unwrap();
        assert_eq!(output.model.method, HttpMethod::POST, "覆写方法规范化生效");
        // 空白覆写视同未覆写
        let blank = SynthesisInput {
            method_override: Some("   "),
            ..input
        };
        let output = synthesize(&blank).unwrap();
        assert_eq!(output.model.method, HttpMethod::GET, "空白覆写回落定义");
    }

    fn rows(pairs: &[(&str, &str)]) -> Vec<KvRow> {
        pairs.iter().map(|(k, v)| KvRow::new(*k, *v)).collect()
    }

    #[test]
    fn kv_contract_fixture_cases() {
        // 契约夹具（与前端 kv-editor 测试共用同一文件）双端钉住；
        // 夹具 rows 用存储形态字段（name/value/type?/description?/enabled?），
        // 此处映射为引擎行模型（enabled 缺失＝启用）
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FixtureCase {
            json: String,
            #[serde(default)]
            rows: Vec<FixtureRow>,
            #[serde(default)]
            invalid: bool,
        }
        #[derive(serde::Deserialize)]
        struct FixtureRow {
            name: String,
            value: String,
            #[serde(default, rename = "type")]
            type_: Option<String>,
            #[serde(default)]
            description: Option<String>,
            #[serde(default)]
            enabled: Option<bool>,
        }
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../src/test/fixtures/kv-contract.json"
        ))
        .unwrap();
        let cases: Vec<FixtureCase> = serde_json::from_value(fixture["cases"].clone()).unwrap();
        assert!(!cases.is_empty());
        for case in &cases {
            let parsed = parse_kv_json(&case.json, "params");
            if case.invalid {
                let err = parsed.expect_err("非法形态必须拒绝");
                assert_eq!(err.code, codes::HTTP_SYNTHESIS_INVALID);
            } else {
                let got = parsed.unwrap();
                let expect: Vec<KvRow> = case
                    .rows
                    .iter()
                    .map(|r| KvRow {
                        key: r.name.clone(),
                        value: r.value.clone(),
                        type_: r.type_.clone(),
                        description: r.description.clone(),
                        enabled: r.enabled.unwrap_or(true),
                    })
                    .collect();
                assert_eq!(got, expect, "case json={}", case.json);
            }
        }
    }

    /// 禁用行不参与发送（enabled 全链路口径）：params 禁用行不进 path 填充
    /// 也不进 query；headers 禁用行不进模型头集；body 信封 form 系禁用行
    /// 不进表单体（urlencoded / multipart 同口径）。
    #[test]
    fn disabled_rows_are_not_sent_anywhere() {
        let def = definition(HttpMethod::POST, "/api/users/{id}");
        let model = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("http://x.test"),
            user_body: Some(
                r#"{"kind":"urlencoded","rows":[{"name":"a","value":"1"},{"name":"b","value":"2","enabled":false}]}"#,
            ),
            user_params: r#"[
                {"name":"id","value":"7","enabled":false},
                {"name":"q","value":"v"},
                {"name":"off","value":"x","enabled":false}
            ]"#,
            user_headers: r#"[
                {"name":"X-Keep","value":"yes"},
                {"name":"X-Off","value":"no","enabled":false}
            ]"#,
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            base_url_override: None,
            variables: &[],
        })
        .unwrap().model;
        // path 占位不被禁用行填充（原样保留），query 只含启用行
        assert_eq!(model.url, "http://x.test/api/users/{id}?q=v");
        // 头集保留禁用行本体（模型层不丢数据），发送面过滤在引擎；
        // 引擎行为由 sent_mirror / build_request 既有 enabled 过滤钉住
        assert_eq!(model.headers.len(), 2);
        assert!(model.headers.iter().any(|r| r.key == "X-Off" && !r.enabled));
        match model.body {
            BodyKind::FormUrlEncoded(rows) => {
                assert_eq!(rows.len(), 2, "模型层保留禁用行，序列化时过滤");
                assert_eq!(serialize_urlencoded(&rows), "a=1");
            }
            other => panic!("期望 FormUrlEncoded body，得到 {other:?}"),
        }

        // form-data：禁用行在信封合成映射即滤除（multipart 无行级序列化单源）
        let model = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("http://x.test"),
            user_body: Some(
                r#"{"kind":"form-data","rows":[{"name":"f","value":"v"},{"name":"g","value":"w","enabled":false}]}"#,
            ),
            user_params: "[]",
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            base_url_override: None,
            variables: &[],
        })
        .unwrap().model;
        match model.body {
            BodyKind::Multipart(fields) => {
                assert_eq!(
                    fields,
                    vec![MultipartField::Text {
                        name: "f".into(),
                        value: "v".into()
                    }]
                );
            }
            other => panic!("期望 Multipart body，得到 {other:?}"),
        }
    }

    /// form-data file 行合成：type=="file" 分流为文件字段（路径即行 value），
    /// 其余（含缺失 / 未知标注）按文本；禁用 file 行与禁用文本行同一过滤。
    /// 旧数据兼容：type=file 而 value 非有效路径的行同样转文件字段，由
    /// 发送面以文件不存在报稳定错误（不静默跳过、不改写用户数据）。
    #[test]
    fn form_data_file_rows_map_to_file_fields() {
        let def = definition(HttpMethod::POST, "/upload");
        let model = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("http://x.test"),
            user_body: Some(
                r#"{"kind":"form-data","rows":[
                    {"name":"","value":"anon"},
                    {"name":"note","value":"hi"},
                    {"name":"attach","value":"C:\\tmp\\a.png","type":"file"},
                    {"name":"off","value":"/tmp/b.bin","type":"file","enabled":false},
                    {"name":"typed","value":"7","type":"integer"}
                ]}"#,
            ),
            user_params: "[]",
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            base_url_override: None,
            variables: &[],
        })
        .unwrap()
        .model;
        match model.body {
            BodyKind::Multipart(fields) => {
                assert_eq!(
                    fields,
                    vec![
                        MultipartField::Text {
                            name: "note".into(),
                            value: "hi".into()
                        },
                        MultipartField::File {
                            name: "attach".into(),
                            path: "C:\\tmp\\a.png".into()
                        },
                        // 非 file 标注（含显式类型化）照走文本，不受 file 分流影响
                        MultipartField::Text {
                            name: "typed".into(),
                            value: "7".into()
                        },
                    ],
                    "禁用 file 行与空名行滤除、type=file 分流、其余标注按文本"
                );
            }
            other => panic!("期望 Multipart body，得到 {other:?}"),
        }
    }

    /// 最终 URL 组合口径契约夹具（与前端 url-draft.ts 的 composeFinalUrl 测试
    /// 共享同一份 `src/test/fixtures/url-compose-contract.json`）：build_url
    /// 的占位填充 / query 拼接 / 绝对模板绕过 BaseUrl / 编码行为由夹具双端
    /// 钉住，任一端改口径另一端立红。错误 case 按 message 关键词区分两种
    /// URL_INVALID 形态（未配置 / 非 http(s) scheme）。
    #[test]
    fn url_compose_contract_fixture_cases() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FixtureCase {
            #[serde(default)]
            name: String,
            base_url: Option<String>,
            path_template: String,
            #[serde(default)]
            params: Vec<FixtureParam>,
            #[serde(default)]
            expect_url: Option<String>,
            #[serde(default)]
            expect_error: Option<String>,
        }
        #[derive(serde::Deserialize)]
        struct FixtureParam {
            name: String,
            value: String,
        }
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../src/test/fixtures/url-compose-contract.json"
        ))
        .unwrap();
        let cases: Vec<FixtureCase> = serde_json::from_value(fixture["cases"].clone()).unwrap();
        assert!(!cases.is_empty());
        for case in &cases {
            let params: Vec<KvRow> = case
                .params
                .iter()
                .map(|p| KvRow::new(&p.name, &p.value))
                .collect();
            let result = build_url(case.base_url.as_deref(), &case.path_template, &params);
            if let Some(expected) = &case.expect_url {
                assert_eq!(result.unwrap(), *expected, "case={}", case.name);
            } else {
                let err = result.expect_err("错误 case 必须失败");
                assert_eq!(err.code, codes::URL_INVALID, "case={}", case.name);
                let keyword = match case.expect_error.as_deref() {
                    Some("no-base-url") => "not configured",
                    _ => "must start with",
                };
                assert!(
                    err.message.contains(keyword),
                    "case={} expect_error={:?} got={}",
                    case.name,
                    case.expect_error,
                    err.message
                );
            }
        }
    }

    /// 六 kind 信封合成矩阵：各 kind→预期 BodyKind（含 Content-Type 断言、
    /// json 保原文断言）。
    #[test]
    fn envelope_synthesis_matrix_covers_all_kinds() {
        let def = definition(HttpMethod::POST, "/a");
        let send_with_body = |body: &str| -> BodyKind {
            synthesize(&SynthesisInput {
                definition: &def,
                base_url: Some("http://x.test"),
                user_body: Some(body),
                user_params: "[]",
                user_headers: "[]",
                path_override: None,
                method_override: None,
                overrides: &SendOverrides::default(),
                base_url_override: None,
                variables: &[],
            })
            .unwrap()
            .model
            .body
        };

        // none（可两字段皆无）
        assert_eq!(send_with_body(r#"{"kind":"none"}"#), BodyKind::None);

        // json：保原文不重序列化（用户排版原样进 Raw 字节）
        let pretty = "{\n  \"name\": \"Ada\"\n}";
        let envelope = format!(
            r#"{{"kind":"json","text":{}}}"#,
            serde_json::to_string(pretty).unwrap()
        );
        match send_with_body(&envelope) {
            BodyKind::Raw {
                bytes,
                content_type,
            } => {
                assert_eq!(bytes, pretty.as_bytes().to_vec(), "json kind 保原文");
                assert_eq!(content_type, "application/json");
            }
            other => panic!("期望 Raw body，得到 {other:?}"),
        }

        // xml / text：按 kind 取默认 Content-Type
        match send_with_body(r#"{"kind":"xml","text":"<root><a>1</a></root>"}"#) {
            BodyKind::Raw {
                bytes,
                content_type,
            } => {
                assert_eq!(bytes, b"<root><a>1</a></root>".to_vec());
                assert_eq!(content_type, "application/xml");
            }
            other => panic!("期望 Raw body，得到 {other:?}"),
        }
        match send_with_body(r#"{"kind":"text","text":"plain body"}"#) {
            BodyKind::Raw {
                bytes,
                content_type,
            } => {
                assert_eq!(bytes, b"plain body".to_vec());
                assert_eq!(content_type, "text/plain");
            }
            other => panic!("期望 Raw body，得到 {other:?}"),
        }

        // urlencoded：rows → FormUrlEncoded
        match send_with_body(
            r#"{"kind":"urlencoded","rows":[{"name":"a","value":"1"},{"name":"b","value":"2"}]}"#,
        ) {
            BodyKind::FormUrlEncoded(rows) => {
                assert_eq!(rows, vec![KvRow::new("a", "1"), KvRow::new("b", "2")]);
            }
            other => panic!("期望 FormUrlEncoded body，得到 {other:?}"),
        }

        // form-data：rows → Multipart 文本字段（file 行分流见专项用例）
        match send_with_body(r#"{"kind":"form-data","rows":[{"name":"payload","value":"hi"}]}"#) {
            BodyKind::Multipart(fields) => {
                assert_eq!(
                    fields,
                    vec![MultipartField::Text {
                        name: "payload".into(),
                        value: "hi".into()
                    }]
                );
            }
            other => panic!("期望 Multipart body，得到 {other:?}"),
        }

        // 信封 rows 行携带 type / description（urlencoded 发送面不消费行标注，
        // 供文档同步供料；form-data 的 file 分流见专项用例）
        match send_with_body(
            r#"{"kind":"urlencoded","rows":[{"name":"page","value":"1","type":"integer","description":"页码"}]}"#,
        ) {
            BodyKind::FormUrlEncoded(rows) => {
                assert_eq!(rows[0].key, "page");
                assert_eq!(rows[0].type_.as_deref(), Some("integer"));
                assert_eq!(rows[0].description.as_deref(), Some("页码"));
            }
            other => panic!("期望 FormUrlEncoded body，得到 {other:?}"),
        }

        // 空体信封容忍：Raw 三 kind 的 text 为空时与「空体为 None」对齐
        assert_eq!(
            send_with_body(r#"{"kind":"json","text":""}"#),
            BodyKind::None
        );
        assert_eq!(send_with_body(r#"{"kind":"text"}"#), BodyKind::None);
    }

    /// 旧纯文本读侧嗅探（迁移口径四分支）＋发送行为与信封化之前一致的对照
    /// 断言（legacy 输入合成产物＝改造前口径：JSON→application/json，
    /// XML 与普通文本→text/plain）。
    #[test]
    fn legacy_plain_text_sniffs_and_keeps_pre_envelope_behavior() {
        // 嗅探四分支（迁移口径分类，不进入发送的 Content-Type 判定）
        assert_eq!(sniff_legacy_kind(""), LegacyBodyKind::None);
        assert_eq!(sniff_legacy_kind("   \n\t"), LegacyBodyKind::None);
        assert_eq!(sniff_legacy_kind(r#"{"a":1}"#), LegacyBodyKind::Json);
        assert_eq!(
            sniff_legacy_kind("<?xml version=\"1.0\"?><root/>"),
            LegacyBodyKind::Xml
        );
        assert_eq!(sniff_legacy_kind("<root>elem</root>"), LegacyBodyKind::Xml);
        assert_eq!(sniff_legacy_kind("plain text"), LegacyBodyKind::Text);

        let def = definition(HttpMethod::POST, "/a");
        let send_with_body = |body: &str| -> BodyKind {
            synthesize(&SynthesisInput {
                definition: &def,
                base_url: Some("http://x.test"),
                user_body: Some(body),
                user_params: "[]",
                user_headers: "[]",
                path_override: None,
                method_override: None,
                overrides: &SendOverrides::default(),
                base_url_override: None,
                variables: &[],
            })
            .unwrap()
            .model
            .body
        };

        // 空（含纯空白）→ None
        assert_eq!(send_with_body("   "), BodyKind::None);
        // 合法 JSON → Raw{application/json}（改造前口径）
        match send_with_body(r#"{"a":1}"#) {
            BodyKind::Raw {
                bytes,
                content_type,
            } => {
                assert_eq!(bytes, br#"{"a":1}"#.to_vec());
                assert_eq!(content_type, "application/json");
            }
            other => panic!("期望 Raw body，得到 {other:?}"),
        }
        // XML → 嗅探回填 xml 分类，但发送仍 text/plain（改造前口径）
        match send_with_body("<?xml version=\"1.0\"?><root/>") {
            BodyKind::Raw { content_type, .. } => assert_eq!(content_type, "text/plain"),
            other => panic!("期望 Raw body，得到 {other:?}"),
        }
        // 其余 → Raw{text/plain}（改造前口径）
        match send_with_body("plain text") {
            BodyKind::Raw {
                bytes,
                content_type,
            } => {
                assert_eq!(bytes, b"plain text".to_vec());
                assert_eq!(content_type, "text/plain");
            }
            other => panic!("期望 Raw body，得到 {other:?}"),
        }
    }

    /// 显式 Content-Type 头恒优先语义全 kind 保持：Raw 三 kind 模型内
    /// content_type 让位为空（引擎照发用户头）；表单两形态模型变体不受影响；
    /// none 无体。
    #[test]
    fn explicit_content_type_header_wins_for_every_kind() {
        let def = definition(HttpMethod::POST, "/a");
        let send_with_body = |body: &str| -> BodyKind {
            synthesize(&SynthesisInput {
                definition: &def,
                base_url: Some("http://x.test"),
                user_body: Some(body),
                user_params: "[]",
                user_headers: r#"[{"name":"Content-Type","value":"text/csv"}]"#,
                path_override: None,
                method_override: None,
                overrides: &SendOverrides::default(),
                base_url_override: None,
                variables: &[],
            })
            .unwrap()
            .model
            .body
        };

        for body in [
            r#"{"kind":"json","text":"{}"}"#,
            r#"{"kind":"xml","text":"<a/>"}"#,
            r#"{"kind":"text","text":"hi"}"#,
        ] {
            match send_with_body(body) {
                BodyKind::Raw { content_type, .. } => {
                    assert_eq!(content_type, "", "显式头恒优先: body={body}");
                }
                other => panic!("期望 Raw body，得到 {other:?}"),
            }
        }
        match send_with_body(r#"{"kind":"urlencoded","rows":[{"name":"a","value":"1"}]}"#) {
            BodyKind::FormUrlEncoded(rows) => assert_eq!(rows, vec![KvRow::new("a", "1")]),
            other => panic!("期望 FormUrlEncoded body，得到 {other:?}"),
        }
        match send_with_body(r#"{"kind":"form-data","rows":[{"name":"f","value":"v"}]}"#) {
            BodyKind::Multipart(fields) => {
                assert_eq!(
                    fields,
                    vec![MultipartField::Text {
                        name: "f".into(),
                        value: "v".into()
                    }]
                )
            }
            other => panic!("期望 Multipart body，得到 {other:?}"),
        }
        assert_eq!(send_with_body(r#"{"kind":"none"}"#), BodyKind::None);

        // legacy 纯文本在显式头下同样让位（信封化前后同语义）
        match send_with_body("plain text") {
            BodyKind::Raw { content_type, .. } => assert_eq!(content_type, ""),
            other => panic!("期望 Raw body，得到 {other:?}"),
        }
    }

    /// CLI `--body` 覆写恒按纯文本语义发送（legacy 路径）：覆写值即使呈信封
    /// 形态也按字面文本发送，并整体压过 GUI 信封草稿。
    #[test]
    fn override_body_is_plain_text_even_if_envelope_shaped() {
        let def = definition(HttpMethod::POST, "/a");
        let mut overrides = SendOverrides::default();
        overrides.body = Some(r#"{"kind":"text","text":"hi"}"#.into());
        let model = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("http://x.test"),
            user_body: Some(r#"{"kind":"json","text":"{}"}"#),
            user_params: "[]",
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &overrides,
            base_url_override: None,
            variables: &[],
        })
        .unwrap()
        .model;
        match model.body {
            BodyKind::Raw {
                bytes,
                content_type,
            } => {
                assert_eq!(
                    bytes,
                    br#"{"kind":"text","text":"hi"}"#.to_vec(),
                    "覆写值按字面文本发送"
                );
                assert_eq!(content_type, "application/json", "合法 JSON 文本按现状嗅探");
            }
            other => panic!("期望 Raw body，得到 {other:?}"),
        }
    }

    #[test]
    fn build_url_fills_placeholders_and_appends_query() {
        let def = definition(HttpMethod::GET, "/api/users/{id}/posts");
        let model = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("http://127.0.0.1:18080/"),
            user_body: None,
            user_params: &serde_json::to_string(&serde_json::json!([
                {"name": "id", "value": "42"},
                {"name": "verbose", "value": "true"},
                {"name": "", "value": "skip-me"}
            ]))
            .unwrap(),
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            base_url_override: None,
            variables: &[],
        })
        .unwrap()
        .model;
        assert_eq!(
            model.url,
            "http://127.0.0.1:18080/api/users/42/posts?verbose=true"
        );
    }

    #[test]
    fn unfilled_placeholder_stays_literal() {
        let url = build_url(
            Some("http://x.test"),
            "/api/users/{id}",
            &[KvRow::new("other", "1")],
        )
        .unwrap();
        // 占位符原样保留（透传语义；非法 URL 字符由引擎侧 Url 解析统一编码）
        assert_eq!(url, "http://x.test/api/users/{id}?other=1");
    }

    #[test]
    fn build_url_requires_base_url() {
        let err = build_url(None, "/a", &[]).unwrap_err();
        assert_eq!(err.code, codes::URL_INVALID);
        let err = build_url(Some("ftp://x"), "/a", &[]).unwrap_err();
        assert_eq!(err.code, codes::URL_INVALID);
    }

    /// 绝对 URL 模板契约（历史恢复→另存为新接口→发送的最终 URL 一致性）：
    /// host 已在模板内时完全绕过 BaseUrl——已配置（合法 / 非法）与未配置
    /// 三种形态下，最终 URL 恒＝模板＋占位填充＋query 拼接，不双重拼接。
    #[test]
    fn absolute_url_template_bypasses_base_url() {
        for base in [
            Some("https://other.test/prefix"),
            Some("ftp://broken"),
            None,
        ] {
            let url = build_url(base, "https://api.example.com/v1/users", &[]).unwrap();
            assert_eq!(url, "https://api.example.com/v1/users", "base={base:?}");
        }
        // 占位替换与 query 拼接对绝对模板同等生效
        let url = build_url(
            None,
            "https://api.example.com/v1/users/{id}",
            &[KvRow::new("id", "7"), KvRow::new("verbose", "true")],
        )
        .unwrap();
        assert_eq!(url, "https://api.example.com/v1/users/7?verbose=true");
        // 相对模板不受影响（BaseUrl 缺省仍报错）
        let err = build_url(None, "/a", &[]).unwrap_err();
        assert_eq!(err.code, codes::URL_INVALID);
    }

    #[test]
    fn override_replaces_same_key_last_wins() {
        let def = definition(HttpMethod::GET, "/api/users");
        let mut overrides = SendOverrides::default();
        overrides.param_rows = rows(&[("k", "second")]);
        let model = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("http://x.test"),
            user_body: None,
            user_params: r#"[{"name":"k","value":"first"},{"name":"keep","value":"v"}]"#,
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &overrides,
            base_url_override: None,
            variables: &[],
        })
        .unwrap()
        .model;
        assert!(model.url.contains("k=second"));
        assert!(model.url.contains("keep=v"));
        // dedupe_last：覆写内同名后值胜
        let mut dup = SendOverrides::default();
        dup.param_rows = rows(&[("k", "a"), ("k", "b")]);
        let params = merge_rows(vec![], &dedupe_last(&dup.param_rows));
        assert_eq!(params, rows(&[("k", "b")]));
    }

    #[test]
    fn override_body_replaces_whole_body() {
        let def = definition(HttpMethod::POST, "/api/users");
        let mut overrides = SendOverrides::default();
        overrides.body = Some(r#"{"name":"override"}"#.into());
        let model = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("http://x.test"),
            user_body: Some(r#"{"name":"user"}"#),
            user_params: "[]",
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &overrides,
            base_url_override: None,
            variables: &[],
        })
        .unwrap()
        .model;
        match model.body {
            BodyKind::Raw {
                bytes,
                content_type,
            } => {
                assert_eq!(bytes, br#"{"name":"override"}"#.to_vec());
                assert_eq!(content_type, "application/json");
            }
            other => panic!("期望 Raw body，得到 {other:?}"),
        }
    }

    #[test]
    fn body_content_type_respects_explicit_header_and_sniffs_default() {
        let def = definition(HttpMethod::POST, "/a");
        // 显式 Content-Type：模型不覆盖
        let model = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("http://x.test"),
            user_body: Some("{\"a\":1}"),
            user_params: "[]",
            user_headers: r#"[{"name":"Content-Type","value":"text/csv"}]"#,
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            base_url_override: None,
            variables: &[],
        })
        .unwrap()
        .model;
        match model.body {
            BodyKind::Raw { content_type, .. } => assert_eq!(content_type, ""),
            other => panic!("期望 Raw body，得到 {other:?}"),
        }
        // 非 JSON 且未显式：嗅探 text/plain
        let model = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("http://x.test"),
            user_body: Some("plain text"),
            user_params: "[]",
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            base_url_override: None,
            variables: &[],
        })
        .unwrap()
        .model;
        match model.body {
            BodyKind::Raw { content_type, .. } => assert_eq!(content_type, "text/plain"),
            other => panic!("期望 Raw body，得到 {other:?}"),
        }
        // 空白体 → None
        let model = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("http://x.test"),
            user_body: Some("   "),
            user_params: "[]",
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            base_url_override: None,
            variables: &[],
        })
        .unwrap()
        .model;
        assert_eq!(model.body, BodyKind::None);
    }

    #[test]
    fn variable_reference_braces_are_not_path_params() {
        let placeholders = template_placeholders("/a/{{var}}/b/{id}");
        assert_eq!(placeholders, vec!["id".to_string()]);
    }

    #[test]
    fn query_values_are_percent_encoded() {
        let url = build_url(Some("http://x.test"), "/a", &[KvRow::new("q", "a b&c=1")]).unwrap();
        assert_eq!(url, "http://x.test/a?q=a%20b%26c%3D1");
    }

    /// urlencoded 体序列化夹具（发送与镜像同源口径）：RFC 3986 非保留字符
    /// 直通，中文按 UTF-8 百分号编码，空格 `%20`，`&` / `=` 等结构字符编码后
    /// 不破坏 `k=v&…` 形态；禁用行与空 key 行不参与（与发送过滤同口径）。
    #[test]
    fn urlencoded_serialization_matches_percent_encode_semantics() {
        let rows = vec![
            KvRow::new("kept", "a-b.c~d"),
            KvRow::new("space and 中文", "值 & = ?"),
            KvRow::new("", "skipped-empty-key"),
            KvRow {
                enabled: false,
                ..KvRow::new("disabled", "x")
            },
        ];
        assert_eq!(
            serialize_urlencoded(&rows),
            "kept=a-b.c~d&space%20and%20%E4%B8%AD%E6%96%87=%E5%80%BC%20%26%20%3D%20%3F",
        );
        // 空行集＝空体字符串（发送侧得零字节体，不携带误导性占位）
        assert_eq!(serialize_urlencoded(&[]), "");
    }

    #[test]
    fn invalid_user_json_fails_fast() {
        let def = definition(HttpMethod::GET, "/a");
        let err = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("http://x.test"),
            user_body: None,
            user_params: "{\"name\":\"a\"}",
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            base_url_override: None,
            variables: &[],
        })
        .unwrap_err();
        assert_eq!(err.code, codes::HTTP_SYNTHESIS_INVALID);
    }

    // —— 变量解析（spec「变量域」：位置白名单 / URL 次序 / Secret 清单）——

    fn var(key: &str, value: &str, secret: bool) -> crate::domain::variable::EffectiveVariable {
        crate::domain::variable::EffectiveVariable {
            key: key.to_owned(),
            value: value.to_owned(),
            secret,
            source: crate::domain::variable::VariableSource::Active,
        }
    }

    /// URL 次序：逐段先解析后组合；判绝对在解析后（解析结果以 http(s)://
    /// 开头即直发、绕过 BaseUrl——工作空间 base_url 已配置也不参与拼接）
    #[test]
    fn url_resolves_each_segment_then_judges_absolute() {
        let vars = vec![var("host", "https://api.example.com", false)];
        // 模板以变量开头不满足写路径校验的「/ 或 http(s):// 字面开头」约束，
        // 但历史数据 / 导入等旁路可产生——合成层契约按字面量构造直测
        // （解析结果判绝对是 Resolver 的行为，不依赖写路径放行）
        let def = Definition {
            method: HttpMethod::GET,
            path_template: "{{host}}/v1/items".to_owned(),
            doc: None,
        };
        let output = synthesize(&SynthesisInput {
            definition: &def,
            // 工作空间 base_url 合法但被绝对模板绕过
            base_url: Some("https://workspace.example.com"),
            base_url_override: None,
            user_body: None,
            user_params: "[]",
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            variables: &vars,
        })
        .unwrap();
        assert_eq!(output.model.url, "https://api.example.com/v1/items");
        // 相对模板照常拼接（base_url 恒字面）
        let def = definition(HttpMethod::GET, "/items/{{id}}");
        let vars = vec![var("id", "7", false)];
        let output = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("https://workspace.example.com"),
            base_url_override: None,
            user_body: None,
            user_params: "[]",
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            variables: &vars,
        })
        .unwrap();
        assert_eq!(output.model.url, "https://workspace.example.com/items/7");
    }

    /// 工作空间 base_url 恒字面：其中的 `{{...}}` 不解析（原样参与拼接）；
    /// 接口级覆写值按值列口径解析后优先于工作空间生效值（空白覆写回落）
    #[test]
    fn base_url_literal_while_override_resolves() {
        let vars = vec![var("mirror", "https://mirror.example.com", false)];
        let def = definition(HttpMethod::GET, "/a");
        // base_url 内的模板不解析：{{host}} 字面进入最终 URL
        let output = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("https://{{host}}.example.com"),
            base_url_override: None,
            user_body: None,
            user_params: "[]",
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            variables: &vars,
        })
        .unwrap();
        assert_eq!(output.model.url, "https://{{host}}.example.com/a");

        // 覆写值解析命中：优先于工作空间生效值参与拼接
        let output = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("https://workspace.example.com"),
            base_url_override: Some("{{mirror}}"),
            user_body: None,
            user_params: "[]",
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            variables: &vars,
        })
        .unwrap();
        assert_eq!(output.model.url, "https://mirror.example.com/a");

        // 空白覆写＝未覆写（回落工作空间生效值）
        let output = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("https://workspace.example.com"),
            base_url_override: Some("   "),
            user_body: None,
            user_params: "[]",
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            variables: &vars,
        })
        .unwrap();
        assert_eq!(output.model.url, "https://workspace.example.com/a");
    }

    /// 位置白名单：params·headers 值列解析、Key 列不解析；未命中原样保留；
    /// 命中记录（含未命中）与 Secret 值清单产出
    #[test]
    fn value_columns_resolve_keys_do_not() {
        let vars = vec![var("token", "tk", true), var("page", "2", false)];
        let def = definition(HttpMethod::GET, "/a");
        let output = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("http://x.test"),
            base_url_override: None,
            user_body: None,
            user_params: r#"[{"name":"page","value":"{{page}}"},{"name":"{{page}}","value":"1"},{"name":"miss","value":"{{miss}}"}]"#,
            user_headers: r#"[{"name":"X-Token","value":"{{token}}"}]"#,
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            variables: &vars,
        })
        .unwrap();
        // 值列命中替换、未命中原样；Key 列的 {{page}} 不解析（保持行名）
        assert_eq!(
            output.model.url, "http://x.test/a?page=2&%7B%7Bpage%7D%7D=1&miss=%7B%7Bmiss%7D%7D",
            "query 值未命中模板原样保留（拼接时经 percent 编码）"
        );
        assert!(
            output
                .model
                .headers
                .iter()
                .any(|r| r.key == "X-Token" && r.value == "tk")
        );
        // 记录：page 命中、miss 未命中（Key 列不产生记录）、token 命中
        let keys: Vec<&str> = output.hits.iter().map(|h| h.key.as_str()).collect();
        assert_eq!(keys, vec!["page", "miss", "token"]);
        assert_eq!(output.secret_values, vec!["tk".to_owned()]);
    }

    /// body 解析：信封 text 合法 JSON 走结构级（属性名与转义保真）、rows
    /// 值列解析、CLI 覆写 body 同一降级链
    #[test]
    fn body_envelope_and_rows_resolve() {
        let vars = vec![var("name", "A\"da", false), var("f", "v", false)];
        let def = definition(HttpMethod::POST, "/a");
        // 信封 json text：结构级替换＋转义（替换后仍合法 JSON）
        let output = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("http://x.test"),
            base_url_override: None,
            user_body: Some(r#"{"kind":"json","text":"{\"user\":\"{{name}}\"}"}"#),
            user_params: "[]",
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            variables: &vars,
        })
        .unwrap();
        match output.model.body {
            BodyKind::Raw { bytes, .. } => {
                let parsed: serde_json::Value =
                    serde_json::from_slice(&bytes).expect("替换后仍是合法 JSON");
                assert_eq!(parsed["user"], "A\"da");
            }
            other => panic!("期望 Raw body，得到 {other:?}"),
        }

        // 信封 urlencoded rows：值列解析
        let output = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("http://x.test"),
            base_url_override: None,
            user_body: Some(r#"{"kind":"urlencoded","rows":[{"name":"field","value":"{{f}}"}]}"#),
            user_params: "[]",
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            variables: &vars,
        })
        .unwrap();
        match output.model.body {
            BodyKind::FormUrlEncoded(rows) => {
                assert_eq!(serialize_urlencoded(&rows), "field=v");
            }
            other => panic!("期望 FormUrlEncoded body，得到 {other:?}"),
        }

        // CLI 覆写 body（legacy 纯文本语义）：合法 JSON 同样走结构级
        let mut overrides = SendOverrides::default();
        overrides.body = Some(r#"{"q":"{{f}}"}"#.into());
        let output = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("http://x.test"),
            base_url_override: None,
            user_body: None,
            user_params: "[]",
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &overrides,
            variables: &vars,
        })
        .unwrap();
        match output.model.body {
            BodyKind::Raw { bytes, .. } => {
                let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(parsed["q"], "v");
            }
            other => panic!("期望 Raw body，得到 {other:?}"),
        }
    }

    /// 空变量集＝既有透传语义：`{{...}}` 原样出现在 URL 与值列（Phase 4
    /// 「双括号透传」在变量域点亮后对空集保持不变）
    #[test]
    fn empty_variable_set_keeps_passthrough_semantics() {
        let def = definition(HttpMethod::GET, "/a/{{var}}");
        let output = synthesize(&SynthesisInput {
            definition: &def,
            base_url: Some("http://x.test"),
            base_url_override: None,
            user_body: None,
            user_params: r#"[{"name":"q","value":"{{var}}"}]"#,
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            variables: &[],
        })
        .unwrap();
        // path 段模板原样（不经 percent 编码）；query 值经编码
        assert_eq!(
            output.model.url,
            "http://x.test/a/{{var}}?q=%7B%7Bvar%7D%7D"
        );
        // 未命中记录仍在（预览可标示）
        assert_eq!(output.hits.len(), 2);
        assert!(output.hits.iter().all(|h| !h.hit));
    }
}
