//! 用户请求体与文档骨架的静默对齐引擎（纯 domain，无 IO）。
//!
//! 输入＝用户当前请求体 JSON 值＋新文档请求体骨架（统一模型 schema）；
//! 输出＝对齐后 JSON。规则（静默对齐口径，无预览行集、无裁决载荷）：
//! - 键同时存在于骨架与用户值 → 保留用户值（「用户值永不被覆盖」由
//!   结构保证——对齐从不改写骨架内用户已有值；显式 null 也是用户值，
//!   不做自愈）；
//! - 键仅存在于新骨架 → 补示例值（schema example 优先，缺则按类型占位：
//!   数组铺 `[首元素骨架]`、对象铺字段骨架或空对象壳）；
//! - 键在用户值中、骨架已删除 → 剔除；
//! - 骨架无 properties 的对象（字典 / Map 形态，键集合归用户）→ 用户已
//!   持有的对象整体保留；
//! - 嵌套对象递归同规则；用户已持有的数组整体保留（元素面变化由 Schema
//!   diff 呈现，不在本对齐下钻），未填的数组按 items 铺首元素骨架；
//! - 同名键类型变化 → 保留用户值（结构冲突面交由用户手动处理）。

use crate::constants::SYNC_BODY_SKELETON_MAX_BYTES;

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
        "array" if !schema.truncated => walk_array(schema, user, &path),
        // 缺 type 但有子结构声明的骨架（normalize 不推断类型字段，归一后
        // schema_type 为空串）：有 properties 按 object、有 items 按 array
        // 下钻。只在 merge 侧兜底、不动 normalize——避免已同步用户的下次
        // diff 出现类型字段变更噪音。
        _ if !schema.truncated && !schema.properties.is_empty() => walk_object(schema, user, path),
        _ if !schema.truncated && schema.items.is_some() => walk_array(schema, user, &path),
        // 叶子（string / integer / number / boolean / 未知空串 / 截断形态）
        _ => walk_leaf(schema, user, &path),
    }
}

/// object 节点：声明序下钻 properties（子键对齐）；骨架已删的用户键剔除。
/// 骨架无 properties（字典 / Map 形态）时用户已持有的对象整体保留。
fn walk_object(
    schema: &UnifiedSchema,
    user: Option<&serde_json::Value>,
    path: String,
) -> Option<serde_json::Value> {
    let Some(user_obj) = user.and_then(|v| v.as_object()) else {
        // 用户值缺失或类型不匹配（骨架 object、用户标量/数组）：缺失 →
        // 声明序全量铺底；类型不匹配（含显式 null）→ 整体保留用户值。
        return match user {
            None => {
                let mut merged = serde_json::Map::new();
                for (name, child) in &schema.properties {
                    if let Some(v) = walk(child, None, join_path(&path, name)) {
                        merged.insert(name.clone(), v);
                    }
                }
                // 嵌套层空 properties（字典 / Map 形态）铺空对象占位——键
                // 不因骨架无 properties 而从用户体中消失；根级（path 为空）
                // 维持「无内容可铺」返回 None，是否铺请求体由调用方根级
                // 判定把关。
                if merged.is_empty() && path.is_empty() {
                    return None;
                }
                Some(serde_json::Value::Object(merged))
            }
            Some(v) => Some(v.clone()),
        };
    };

    // 字典 / Map 形态（骨架无 properties）：骨架不声明任何键、键集合由用户
    // 决定——按声明序对齐会把用户已填内容全部剔除，故用户对象原样保留
    // （「用户值永不被覆盖」不变式；嵌套层与根级同规则）
    if schema.properties.is_empty() {
        return Some(serde_json::Value::Object(user_obj.clone()));
    }

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

/// array 节点：用户已持有的数组整体保留（显式 null 也是用户值，不做自愈
/// ——元素面变化归 Schema diff 呈现，不在对齐下钻）；用户未填时铺
/// `[首元素骨架]`（骨架生成单点在 [`array_skeleton`]）。
fn walk_array(
    schema: &UnifiedSchema,
    user: Option<&serde_json::Value>,
    path: &str,
) -> Option<serde_json::Value> {
    match user {
        Some(v) => Some(v.clone()),
        None => Some(array_skeleton(schema, path)),
    }
}

/// 数组骨架生成单点（walk_array 与 fill_value 的 array 分支共用，不两处
/// 分叉）：schema example 优先；否则按 items 生成单元素骨架包成 `[elem]`
/// ——对象数组的元素铺出其字段的一层骨架（子对象递归同规则，深度受归一
/// 层 [`crate::constants::SYNC_SCHEMA_MAX_DEPTH`] 截断约束）；items 缺失
/// 或截断回落 `[]`。
///
/// 体量护栏：单元素骨架为线性展开（每数组仅取 1 元素），总量由字段数与
/// example 体量决定，宽 schema 理论上可能顶到
/// [`crate::constants::MAX_USER_DATA_BYTES`]（1MB，超限整包回滚属既有
/// fail-hard 行为）——骨架序列化超 [`SYNC_BODY_SKELETON_MAX_BYTES`] 时
/// 回落 `[]`，宁可少铺不阻断同步应用。
fn array_skeleton(schema: &UnifiedSchema, path: &str) -> serde_json::Value {
    if let Some(example) = &schema.example {
        return example.clone();
    }
    let Some(items) = schema.items.as_deref().filter(|items| !items.truncated) else {
        return serde_json::Value::Array(Vec::new());
    };
    let elem = walk(items, None, format!("{path}[]")).unwrap_or(serde_json::Value::Null);
    let skeleton = serde_json::Value::Array(vec![elem]);
    if serde_json::to_string(&skeleton).is_ok_and(|text| text.len() > SYNC_BODY_SKELETON_MAX_BYTES)
    {
        return serde_json::Value::Array(Vec::new());
    }
    skeleton
}

/// 叶子节点：用户值在则保留、缺则补值。
fn walk_leaf(
    schema: &UnifiedSchema,
    user: Option<&serde_json::Value>,
    path: &str,
) -> Option<serde_json::Value> {
    match user {
        Some(v) => Some(v.clone()),
        None => Some(fill_value(schema, path)),
    }
}

/// 补值：schema example 优先，缺则按类型占位。
///
/// 非截断节点到达此处时无子结构（带 properties / items 的已由 [`walk`]
/// 分派下钻）；截断节点（循环引用 / 深度超限 / 悬空引用，分派层不下钻）
/// 按结构铺壳：object 铺空对象、array 铺数组骨架；空串类型（缺 type）与
/// [`walk`] 分派同口径——有 properties 按 object、有 items 按 array。结构
/// 无从判定的形态（未知类型、无子结构的悬空引用）补 null。
fn fill_value(schema: &UnifiedSchema, path: &str) -> serde_json::Value {
    if let Some(example) = &schema.example {
        return example.clone();
    }
    match schema.schema_type.as_str() {
        "string" => serde_json::Value::String(String::new()),
        "integer" => serde_json::Value::from(0),
        "number" => serde_json::Value::from(0.0),
        "boolean" => serde_json::Value::Bool(false),
        // 截断 object：空对象壳占位（键保留）
        "object" => serde_json::Value::Object(serde_json::Map::new()),
        // 截断 array：复用数组骨架生成单点（example 已在上方消费；items
        // 缺失或截断回落 []）
        "array" => array_skeleton(schema, path),
        // 缺 type 的截断节点（如组合分支含循环引用的合并形态）：按子结构铺壳
        "" if !schema.properties.is_empty() => serde_json::Value::Object(serde_json::Map::new()),
        "" if schema.items.is_some() => array_skeleton(schema, path),
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
            "根级空骨架维持无内容可铺（根级是否铺请求体由调用方判定把关）"
        );
    }

    #[test]
    fn nested_dict_object_without_properties_keeps_key_as_empty_object() {
        // 嵌套层字典对象（无 properties）：用户未填时键铺空对象占位、保留在请求体中
        let schema = object(
            vec![("meta", object(vec![], &[])), ("name", leaf("string"))],
            &[],
        );
        let user = json(r#"{"name":"张三"}"#);
        assert_eq!(
            align(Some(&user), &schema),
            json(r#"{"name":"张三","meta":{}}"#),
            "字典对象嵌套层铺空对象、不丢键"
        );
    }

    #[test]
    fn user_held_dict_object_kept_whole() {
        // 字典对象（骨架无 properties，键集合归用户）：用户已持有的对象原样
        // 保留，嵌套层与根级同规则
        let schema = object(
            vec![("meta", object(vec![], &[])), ("name", leaf("string"))],
            &[],
        );
        let user = json(r#"{"name":"张三","meta":{"k1":"v1"}}"#);
        assert_eq!(
            align(Some(&user), &schema),
            user,
            "嵌套层字典对象的用户内容原样保留"
        );
        let user = json(r#"{"k1":"v1"}"#);
        assert_eq!(
            align(Some(&user), &object(vec![], &[])),
            user,
            "根级字典对象的用户内容原样保留"
        );
    }

    #[test]
    fn truncated_object_fills_empty_object_shell() {
        // 截断 object（循环引用 / 深度超限时保留类型面）：铺空对象壳
        let mut truncated = object(vec![], &[]);
        truncated.truncated = true;
        let schema = object(vec![("cycle", truncated), ("name", leaf("string"))], &[]);
        assert_eq!(
            align(None, &schema),
            json(r#"{"cycle":{},"name":""}"#),
            "截断 object 键保留空对象形态"
        );
    }

    #[test]
    fn truncated_array_fills_empty_array() {
        // 截断数组（items 已随截断清空）：回落空数组，不落 null
        let mut items = leaf("integer");
        items.truncated = true;
        let mut truncated_array = array_of(items);
        truncated_array.truncated = true;
        let schema = object(vec![("tags", truncated_array)], &[]);
        assert_eq!(align(None, &schema), json(r#"{"tags":[]}"#));
    }

    #[test]
    fn truncated_missing_type_node_fills_shell_by_structure() {
        // 截断且缺 type 的节点（组合分支含循环引用时的合并形态）：与 walk 分派
        // 同口径按子结构铺壳——有 properties 铺空对象、有 items 铺数组骨架；
        // items 自身为截断空节点（悬空引用形态）时数组骨架为 []
        let mut with_props = UnifiedSchema {
            properties: vec![("id".to_owned(), leaf("integer"))],
            ..UnifiedSchema::empty()
        };
        with_props.truncated = true;
        let mut with_items = UnifiedSchema {
            items: Some(Box::new(leaf("string"))),
            ..UnifiedSchema::empty()
        };
        with_items.truncated = true;
        let mut dangling = UnifiedSchema::empty();
        dangling.truncated = true;
        let mut with_truncated_items = UnifiedSchema {
            items: Some(Box::new(dangling)),
            ..UnifiedSchema::empty()
        };
        with_truncated_items.truncated = true;
        let schema = object(
            vec![
                ("owner", with_props),
                ("tags", with_items),
                ("refs", with_truncated_items),
            ],
            &[],
        );
        assert_eq!(
            align(None, &schema),
            json(r#"{"owner":{},"tags":[""],"refs":[]}"#),
            "截断节点按子结构铺壳，不依赖 schema_type 声明"
        );
    }

    #[test]
    fn truncated_node_without_structure_fills_null() {
        // 无子结构的截断空节点（悬空引用、缺 type 定义的循环截断）：结构无从
        // 判定，补 null 占位
        let mut dangling = UnifiedSchema::empty();
        dangling.truncated = true;
        let schema = object(vec![("ref", dangling)], &[]);
        assert_eq!(align(None, &schema), json(r#"{"ref":null}"#));
    }

    #[test]
    fn missing_type_with_properties_walks_as_object() {
        // 缺 type 只有 properties（normalize 不推断，schema_type 空串）：
        // merge 侧按 object 下钻铺底
        let schema = UnifiedSchema {
            schema_type: String::new(),
            properties: vec![("city".to_owned(), leaf("string"))],
            ..UnifiedSchema::empty()
        };
        let schema = object(vec![("addr", schema)], &[]);
        assert_eq!(
            align(None, &schema),
            json(r#"{"addr":{"city":""}}"#),
            "缺 type 有 properties 按 object 铺底"
        );
    }

    #[test]
    fn missing_type_with_items_walks_as_array() {
        // 缺 type 只有 items：merge 侧按 array 铺首元素骨架
        let schema = UnifiedSchema {
            schema_type: String::new(),
            items: Some(Box::new(leaf("string"))),
            ..UnifiedSchema::empty()
        };
        let schema = object(vec![("tags", schema)], &[]);
        assert_eq!(align(None, &schema), json(r#"{"tags":[""]}"#));
    }

    // —— 数组铺底：[首元素骨架] ——

    #[test]
    fn scalar_array_fills_single_element_skeleton() {
        let schema = object(
            vec![
                ("ids", array_of(leaf("integer"))),
                ("names", array_of(leaf("string"))),
            ],
            &[],
        );
        assert_eq!(
            align(None, &schema),
            json(r#"{"ids":[0],"names":[""]}"#),
            "标量数组铺首元素类型占位"
        );
    }

    #[test]
    fn object_array_fills_one_element_object_skeleton() {
        // 对象数组：元素铺出其字段的一层对象骨架（嵌套递归同规则）
        let schema = object(
            vec![(
                "users",
                array_of(object(
                    vec![("name", leaf("string")), ("age", leaf("integer"))],
                    &[],
                )),
            )],
            &[],
        );
        assert_eq!(
            align(None, &schema),
            json(r#"{"users":[{"name":"","age":0}]}"#)
        );
    }

    #[test]
    fn array_skeleton_prefers_example() {
        let mut arr = array_of(leaf("integer"));
        arr.example = Some(json(r#"["高","中"]"#));
        let schema = object(vec![("levels", arr)], &[]);
        assert_eq!(align(None, &schema), json(r#"{"levels":["高","中"]}"#));
    }

    #[test]
    fn array_without_items_fills_empty_array() {
        // items 缺失：回落空数组
        let schema = UnifiedSchema {
            schema_type: "array".into(),
            ..UnifiedSchema::empty()
        };
        let schema = object(vec![("tags", schema)], &[]);
        assert_eq!(align(None, &schema), json(r#"{"tags":[]}"#));
    }

    #[test]
    fn array_with_truncated_items_fills_empty_array() {
        // items 截断（循环引用 / 深度超限）：元素骨架不可得，回落空数组
        let mut items = object(vec![], &[]);
        items.truncated = true;
        let schema = object(vec![("friends", array_of(items))], &[]);
        assert_eq!(align(None, &schema), json(r#"{"friends":[]}"#));
    }

    #[test]
    fn root_level_array_body_fills_element_skeleton() {
        // 根级 array body：铺出 [首元素骨架] 请求体
        assert_eq!(align(None, &array_of(leaf("integer"))), json(r#"[0]"#));
        assert_eq!(
            align(None, &array_of(object(vec![("name", leaf("string"))], &[]))),
            json(r#"[{"name":""}]"#)
        );
    }

    #[test]
    fn user_held_null_is_not_self_healed() {
        // 不做 null 自愈：用户显式写入的 null 是用户值，重新同步不覆盖
        let schema = object(
            vec![("a", leaf("string")), ("bList", array_of(leaf("integer")))],
            &[],
        );
        let user = json(r#"{"a":"a","bList":null}"#);
        assert_eq!(
            align(Some(&user), &schema),
            user,
            "已写入的 null 保持原样（用户值永不被覆盖）"
        );
    }

    #[test]
    fn missing_nested_object_fills_recursively() {
        // 用户没填嵌套对象：递归铺全（对象、数组、标量全铺）
        let schema = object(
            vec![(
                "addr",
                object(
                    vec![("city", leaf("string")), ("tags", array_of(leaf("string")))],
                    &[],
                ),
            )],
            &[],
        );
        let user = json(r#"{"other":1}"#);
        assert_eq!(
            align(Some(&user), &schema),
            json(r#"{"addr":{"city":"","tags":[""]}}"#),
            "缺键的嵌套对象递归铺全"
        );
    }
}
