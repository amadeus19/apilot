//! 用户请求体与文档骨架的静默对齐引擎（纯 domain，无 IO）。
//!
//! 输入＝用户当前请求体 JSON 值＋新文档请求体骨架（统一模型 schema）；
//! 输出＝对齐后 JSON。规则（静默对齐口径，无预览行集、无裁决载荷）：
//! - 键同时存在于骨架与用户值 → 保留用户值（「用户值永不被覆盖」由
//!   结构保证——对齐从不改写骨架内用户已有值）；
//! - 键仅存在于新骨架 → 补示例值（schema example 优先，缺则按类型占位）；
//! - 键在用户值中、骨架已删除 → 剔除；
//! - 嵌套对象递归同规则；数组整体保留用户值，元素面变化由 Schema diff
//!   呈现，不在本对齐下钻；
//! - 同名键类型变化 → 保留用户值（结构冲突面交由用户手动处理）。

use super::model::UnifiedSchema;

/// 用户值 × 骨架 → 对齐后 JSON（无内容可铺时为 Null）。
pub fn align(user: Option<&serde_json::Value>, schema: &UnifiedSchema) -> serde_json::Value {
    walk(schema, user, String::new()).unwrap_or(serde_json::Value::Null)
}

/// 递归对齐一个骨架节点：返回 `None` ＝ 该子树无内容可铺（父对象不落此键）。
fn walk(
    schema: &UnifiedSchema,
    user: Option<&serde_json::Value>,
    path: String,
) -> Option<serde_json::Value> {
    match schema.schema_type.as_str() {
        "object" if !schema.truncated => walk_object(schema, user, path),
        "array" if !schema.truncated => walk_array(schema, user),
        // 叶子（string / integer / number / boolean / 未知空串 / 截断形态）
        _ => walk_leaf(schema, user),
    }
}

/// object 节点：声明序下钻 properties（子键对齐）；骨架已删的用户键剔除。
fn walk_object(
    schema: &UnifiedSchema,
    user: Option<&serde_json::Value>,
    path: String,
) -> Option<serde_json::Value> {
    let Some(user_obj) = user.and_then(|v| v.as_object()) else {
        // 用户值缺失或类型不匹配（骨架 object、用户标量/数组）：缺失 →
        // 声明序全量铺底；类型不匹配 → 整体保留用户值。
        return match user {
            None => {
                let mut merged = serde_json::Map::new();
                for (name, child) in &schema.properties {
                    if let Some(v) = walk(child, None, join_path(&path, name)) {
                        merged.insert(name.clone(), v);
                    }
                }
                (!merged.is_empty()).then_some(serde_json::Value::Object(merged))
            }
            Some(v) => Some(v.clone()),
        };
    };

    let mut merged = serde_json::Map::new();
    for (name, child) in &schema.properties {
        if let Some(v) = walk(child, user_obj.get(name), join_path(&path, name)) {
            merged.insert(name.clone(), v);
        }
    }
    // 用户多余键（骨架已删）整子树剔除；用户显式持有的父键本身保留
    // （结构归用户——空对象也是用户的结构选择）。
    Some(serde_json::Value::Object(merged))
}

/// array 节点：数组整体保留用户值（元素面变化归 Schema diff 呈现，不在
/// 对齐下钻——「数组按首元素骨架呈现明细、数组本身保留用户值」）。
fn walk_array(
    schema: &UnifiedSchema,
    user: Option<&serde_json::Value>,
) -> Option<serde_json::Value> {
    match user {
        Some(v) => Some(v.clone()),
        None => Some(fill_value(schema)),
    }
}

/// 叶子节点：用户值在则保留、缺则补值。
fn walk_leaf(
    schema: &UnifiedSchema,
    user: Option<&serde_json::Value>,
) -> Option<serde_json::Value> {
    match user {
        Some(v) => Some(v.clone()),
        None => Some(fill_value(schema)),
    }
}

/// 补值：schema example 优先，缺则按类型占位（未知类型补 null）。
fn fill_value(schema: &UnifiedSchema) -> serde_json::Value {
    if let Some(example) = &schema.example {
        return example.clone();
    }
    match schema.schema_type.as_str() {
        "string" => serde_json::Value::String(String::new()),
        "integer" => serde_json::Value::from(0),
        "number" => serde_json::Value::from(0.0),
        "boolean" => serde_json::Value::Bool(false),
        _ => serde_json::Value::Null,
    }
}

fn join_path(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}.{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::sync::model::UnifiedSchema;

    fn leaf(schema_type: &str) -> UnifiedSchema {
        UnifiedSchema {
            schema_type: schema_type.to_string(),
            ..UnifiedSchema::empty()
        }
    }

    fn leaf_with_example(schema_type: &str, example: serde_json::Value) -> UnifiedSchema {
        UnifiedSchema {
            example: Some(example),
            ..leaf(schema_type)
        }
    }

    fn object(properties: Vec<(&str, UnifiedSchema)>, required: &[&str]) -> UnifiedSchema {
        UnifiedSchema {
            schema_type: "object".into(),
            required: required.iter().map(|s| s.to_string()).collect(),
            properties: properties
                .into_iter()
                .map(|(n, s)| (n.to_string(), s))
                .collect(),
            ..UnifiedSchema::empty()
        }
    }

    fn array_of(items: UnifiedSchema) -> UnifiedSchema {
        UnifiedSchema {
            schema_type: "array".into(),
            items: Some(Box::new(items)),
            ..UnifiedSchema::empty()
        }
    }

    fn json(v: &str) -> serde_json::Value {
        serde_json::from_str(v).unwrap()
    }

    #[test]
    fn kept_key_preserves_user_value() {
        let schema = object(vec![("name", leaf("string"))], &["name"]);
        let user = json(r#"{"name":"张三"}"#);
        assert_eq!(align(Some(&user), &schema), user);
    }

    #[test]
    fn skeleton_only_key_fills_example_then_type_default() {
        let schema = object(
            vec![
                ("email", leaf_with_example("string", json(r#""a@b.c""#))),
                ("age", leaf("integer")),
            ],
            &[],
        );
        let user = json(r#"{}"#);
        assert_eq!(
            align(Some(&user), &schema),
            json(r#"{"email":"a@b.c","age":0}"#)
        );
    }

    #[test]
    fn user_only_key_dropped_from_result() {
        let schema = object(vec![("name", leaf("string"))], &[]);
        let user = json(r#"{"name":"张三","legacy":"旧字段"}"#);
        assert_eq!(
            align(Some(&user), &schema),
            json(r#"{"name":"张三"}"#),
            "骨架已删的键被剔除"
        );
    }

    #[test]
    fn nested_object_aligns_recursively() {
        let schema = object(
            vec![("addr", object(vec![("city", leaf("string"))], &["city"]))],
            &[],
        );
        let user = json(r#"{"addr":{"city":"杭州","zip":"310000"}}"#);
        assert_eq!(
            align(Some(&user), &schema),
            json(r#"{"addr":{"city":"杭州"}}"#),
            "嵌套层同规则：保留 city、剔除 zip"
        );
    }

    #[test]
    fn array_kept_whole_user_value() {
        let schema = object(vec![("tags", array_of(leaf("integer")))], &[]);
        let user = json(r#"{"tags":["a","b"]}"#);
        assert_eq!(
            align(Some(&user), &schema),
            user,
            "数组整体保留用户值（元素类型不匹配也不动）"
        );
    }

    #[test]
    fn type_mismatch_keeps_user_value() {
        let schema = object(vec![("count", leaf("integer"))], &[]);
        let user = json(r#"{"count":"很多"}"#);
        assert_eq!(
            align(Some(&user), &schema),
            user,
            "类型变化保留用户值（结构冲突面交用户处理）"
        );
    }

    #[test]
    fn scalar_user_body_against_object_skeleton_kept_whole() {
        let schema = object(vec![("name", leaf("string"))], &[]);
        let user = json(r#"[1,2,3]"#);
        assert_eq!(
            align(Some(&user), &schema),
            user,
            "标量对 object 骨架＝整体保留"
        );
    }

    #[test]
    fn missing_user_body_fills_pure_skeleton() {
        let schema = object(
            vec![("name", leaf("string")), ("page", leaf("integer"))],
            &["name"],
        );
        assert_eq!(align(None, &schema), json(r#"{"name":"","page":0}"#));
    }

    #[test]
    fn empty_object_user_value_fills_children() {
        let schema = object(
            vec![("addr", object(vec![("city", leaf("string"))], &["city"]))],
            &[],
        );
        let user = json(r#"{"addr":{}}"#);
        // 用户持有 addr（空对象）：子键照常铺底；父对象是用户的结构选择，保留
        assert_eq!(align(Some(&user), &schema), json(r#"{"addr":{"city":""}}"#));
    }

    #[test]
    fn object_without_properties_and_no_user_yields_null() {
        let schema = object(vec![], &[]);
        assert_eq!(
            align(None, &schema),
            serde_json::Value::Null,
            "空骨架无内容可铺"
        );
    }

    #[test]
    fn array_skeleton_fill_defaults_null() {
        // 无 example 的 array / 未知类型骨架铺 null 占位（父对象落 null 值键）
        let schema = object(vec![("tags", array_of(leaf("integer")))], &[]);
        assert_eq!(align(None, &schema), json(r#"{"tags":null}"#));
    }
}
