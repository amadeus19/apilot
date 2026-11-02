//! 用户数据行 / 信封契约：params / headers 列与 body 信封的 JSON 形态
//! 读写单点（纯 domain，无 IO）。
//!
//! 双端契约——JSON 形态与前端 `kv-rows.ts` / `body-envelope.ts` 镜像，以
//! kv-contract 夹具双端对锚；前端行模型加字段时本模块是 Rust 侧唯一要
//! 跟进的位置（铺行静默缺字段在此直测兜底）。消费方：发送合成
//! （`services/http/request`）、同步铺行（`services/sync_apply`）。
//!
//! 读侧纪律（用户数据铁律的形态面）：不可解析 / 非契约形态一律原文保真
//! （`parse_kv_rows` 返回 None 由调用方不改写），不报错不丢数据；写侧
//! 铁律：铺行值恒空、默认启用，type / description 取文档定义，此后文档
//! 更新不再触碰既有行。

use serde_json::Value;

/// KV 行（参数 / 头 / 覆写的统一行模型）。`enabled` 行级启停：读侧缺失或
/// 非布尔形态缺省启用；禁用行发送面全链路过滤（path 填充 / query / 头 /
/// 表单体与镜像）。`type_` / `description` 为可选标注（type 合法域约束在
/// UI 层，此处不做用途校验）：容忍缺失或非字符串形态，发送面不消费
/// （query / path / 头 / 表单值恒字符串上线），为 API 文档同步与后续阶段供料。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KvRow {
    pub key: String,
    pub value: String,
    pub type_: Option<String>,
    pub description: Option<String>,
    pub enabled: bool,
}

impl KvRow {
    pub fn new(key: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            value: value.into(),
            type_: None,
            description: None,
            enabled: true,
        }
    }
}

/// body 信封 kind（六值；写入形态由 GUI 组装，读侧未知 kind 回落 legacy 纯文本）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyEnvelopeKind {
    None,
    Json,
    Xml,
    Text,
    FormUrlEncoded,
    FormData,
}

/// body 信封解析产物：text 供 Raw 三 kind（保原文，不再 trim），rows 供表单两 kind。
#[derive(Debug, Clone, PartialEq)]
pub struct BodyEnvelope {
    pub kind: BodyEnvelopeKind,
    pub text: Option<String>,
    pub rows: Vec<KvRow>,
}

/// 可选字符串字段（缺失 / null / 非字符串一律 None——读侧容忍，不报错）。
fn optional_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

/// 可选布尔字段（缺失 / null / 非布尔一律 None——读侧容忍，不报错）。
fn optional_bool(value: Option<&Value>) -> Option<bool> {
    value.and_then(Value::as_bool)
}

/// 行 JSON → [`KvRow`]（params / headers 列与信封 rows 共用的行读取单点）：
/// name / value 必须字符串（否则 None＝非法行，由调用方决定报错或回落）；
/// type / description 容忍缺失或非字符串（归 None），enabled 缺省启用。
pub(crate) fn kv_row_from_json(row: &serde_json::Map<String, Value>) -> Option<KvRow> {
    Some(KvRow {
        key: row.get("name")?.as_str()?.to_string(),
        value: row.get("value")?.as_str()?.to_string(),
        type_: optional_string(row.get("type")),
        description: optional_string(row.get("description")),
        enabled: optional_bool(row.get("enabled")).unwrap_or(true),
    })
}

/// body 列信封识别：合法 JSON 对象且 kind 为已知六值之一，否则 None（＝legacy
/// 纯文本，读侧嗅探回填）。容忍面：text / rows 缺失或 null 按空处理，行内
/// type / description 缺失或非字符串归 None；rows 行 name / value 非字符串时
/// 整体回落 legacy（原文照发，不报错不丢数据）。同步应用侧读用户 body 列
/// 复用同一解析（双端同一信封契约）。
pub fn parse_body_envelope(raw: &str) -> Option<BodyEnvelope> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let obj = parsed.as_object()?;
    let kind = match obj.get("kind")?.as_str()? {
        "none" => BodyEnvelopeKind::None,
        "json" => BodyEnvelopeKind::Json,
        "xml" => BodyEnvelopeKind::Xml,
        "text" => BodyEnvelopeKind::Text,
        "urlencoded" => BodyEnvelopeKind::FormUrlEncoded,
        "form-data" => BodyEnvelopeKind::FormData,
        // 未知 kind：回落 legacy 纯文本（读侧容忍，不报错）
        _ => return None,
    };
    let text = optional_string(obj.get("text"));
    let mut rows = Vec::new();
    match obj.get("rows") {
        None | Some(Value::Null) => {}
        Some(Value::Array(items)) => {
            for item in items {
                // 行 name / value 非字符串时整体回落 legacy（原文照发，不报错不丢数据）
                rows.push(kv_row_from_json(item.as_object()?)?);
            }
        }
        Some(_) => return None,
    }
    Some(BodyEnvelope { kind, text, rows })
}

/// JSON 骨架的信封写回（与前端 serializeBodyDraft 契约一致）：紧凑 JSON、
/// text 非空才携带、rows 不带。
pub fn write_json_envelope(text: &str) -> String {
    let mut envelope = serde_json::Map::new();
    envelope.insert("kind".into(), Value::String("json".into()));
    if !text.is_empty() {
        envelope.insert("text".into(), Value::String(text.into()));
    }
    Value::Object(envelope).to_string()
}

/// 用户 KV 行列解析（params / headers 列共用）：合法 JSON 行数组返回行集，
/// 其余形态（含坏 JSON、JSON 对象等非数组）一律 None——调用方原文保真，
/// 不改写不可解析的用户数据。
pub fn parse_kv_rows(raw: &str) -> Option<Vec<Value>> {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(rows)) => Some(rows),
        _ => None,
    }
}

/// 行集序列化（与解析对称的列形态）。
pub fn serialize_kv_rows(rows: Vec<Value>) -> String {
    Value::Array(rows).to_string()
}

/// 铺一行参数（同步补缺行）：值恒空、默认启用，type / description 取文档
/// 定义（此后文档更新不再触碰既有行）。行字段序与前端 KvRow 序列化对齐。
pub fn scaffold_kv_row(name: &str, param_type: &str, description: Option<&str>) -> Value {
    let mut row = serde_json::Map::new();
    row.insert("name".into(), Value::String(name.to_owned()));
    row.insert("value".into(), Value::String(String::new()));
    row.insert("enabled".into(), Value::Bool(true));
    if !param_type.is_empty() {
        row.insert("type".into(), Value::String(param_type.to_owned()));
    }
    if let Some(description) = description {
        row.insert("description".into(), Value::String(description.to_owned()));
    }
    Value::Object(row)
}

/// headers 读侧归一：零键空对象 `{}` 不是用户键值数据（历史铺行的遗留初值
/// 形态），视同空行集 `"[]"` 参与对齐——补行时以行数组形态写回；非空对象
/// 是用户真实键值对，维持原文保真（原串返回）。
pub fn empty_object_as_empty_rows(headers: &str) -> &str {
    match serde_json::from_str::<Value>(headers) {
        Ok(Value::Object(map)) if map.is_empty() => "[]",
        _ => headers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 铺行契约：值恒空、默认启用、type/description 有值才携带（键序＝
    /// serde_json Map 字母序，前端按字段名取值不依赖键序；加字段时的双端
    /// 对锚点）。
    #[test]
    fn scaffold_row_shape_matches_front_end_contract() {
        let row = scaffold_kv_row("page", "integer", Some("页码")).to_string();
        assert_eq!(
            row,
            r#"{"description":"页码","enabled":true,"name":"page","type":"integer","value":""}"#
        );

        let bare = scaffold_kv_row("q", "", None).to_string();
        assert_eq!(
            bare, r#"{"enabled":true,"name":"q","value":""}"#,
            "空 type 不携带键"
        );
    }

    /// 行列解析边界：行数组进、其余形态（对象 / 坏 JSON / legacy 纯文本）
    /// 一律 None（原文保真的判定输入）。
    #[test]
    fn parse_kv_rows_only_accepts_row_arrays() {
        assert!(parse_kv_rows(r#"[{"name":"a","value":"1"}]"#).is_some());
        assert!(parse_kv_rows("{}").is_none());
        assert!(parse_kv_rows("not json").is_none());
    }

    /// json 信封写读 roundtrip：text 非空携带、空 text 只有 kind（与前端
    /// serializeBodyDraft 同构）。
    #[test]
    fn json_envelope_roundtrip() {
        let envelope = parse_body_envelope(&write_json_envelope(r#"{"a":1}"#)).unwrap();
        assert_eq!(envelope.kind, BodyEnvelopeKind::Json);
        assert_eq!(envelope.text.as_deref(), Some(r#"{"a":1}"#));

        let empty = parse_body_envelope(&write_json_envelope("")).unwrap();
        assert_eq!(empty.text, None, "空 text 不携带键");
    }

    /// 空对象归一：`{}`→`"[]"`、非空对象与坏 JSON 原样返回。
    #[test]
    fn empty_headers_object_normalizes_to_empty_row_set() {
        assert_eq!(empty_object_as_empty_rows("{}"), "[]");
        assert_eq!(empty_object_as_empty_rows(r#"{"a":"1"}"#), r#"{"a":"1"}"#);
        assert_eq!(empty_object_as_empty_rows("[]"), "[]");
    }
}
