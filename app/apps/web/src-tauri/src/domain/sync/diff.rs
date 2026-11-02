//! 同步·结构化 diff 引擎与 EndpointDiff 契约（纯 domain，无 IO）。
//!
//! 输入两侧都是归一后的统一模型：新拉取文档 vs 基准文档（上一代快照的
//! 归一结果——库里 `endpoints.definition` 的定义侧元数据扩容随应用事务
//! 落库，diff 不依赖库表；基准＝该服务当前快照）。
//!
//! 契约纪律：
//! - 纯结构化：不含呈现文本、不含 JSON 序列化字符串；
//! - 判定规则收敛「任何定义侧字段变化即 Changed」，无例外清单（参数级
//!   含 description；请求体粒度收敛为 key 增删 / 类型 / required，
//!   示例变化不算——示例只用于合并补值）；
//! - 仅 title / category 变化不算接口级 Changed（不入徽标）；
//! - 序列化锚定「struct 声明序＋空值省略（Option skip）」，键序由双端
//!   fixture 钉住（`tests/fixtures/sync/endpoint-diff-contract.json` 与
//!   apps/web 侧镜像锚定测试）；
//! - 行级 `old` / `new` 双快照承载全量行（含 Unchanged 行）：前端据此
//!   重建 Monaco JSON diff 的旧 / 新两侧文本（Added 行只进新侧、Removed
//!   只进旧侧），契约自身不携带序列化文本。

use std::collections::HashMap;

use serde::Serialize;

use super::model::{UnifiedDoc, UnifiedOperation, UnifiedParameter, UnifiedSchema};

// —— 契约类型（序列化锚定面：字段序即声明序，勿随意重排）——

/// 接口级变更种类。Unchanged 接口不产出 [`EndpointDiff`] 行，只进
/// [`DiffSummary::unchanged`] 计数（徽标与分组都只关心三值）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffKind {
    Added,
    Changed,
    Removed,
}

/// 明细行级变更种类（参数 / 请求体 key / 响应行通用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RowChange {
    Added,
    Removed,
    Changed,
    Unchanged,
}

/// 参数快照（行级 old / new 载荷）。example 不进 diff 契约（示例变化
/// 不算 Changed，示例归合并补值与文档抽屉消费）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamSnap {
    pub location: String,
    pub required: bool,
    /// 参数类型（空串＝未知）
    pub param_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// 请求体 / 响应 schema 的叶子 key 快照（粒度＝类型 + required）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySnap {
    /// schema 类型（object / array / string / integer / number / boolean /
    /// 空串＝未知或组合）
    pub schema_type: String,
    /// 本 key 是否在父 object 的 required 列表
    pub required: bool,
}

/// 参数行（全量行：含 Unchanged；Added 行 old=None、Removed 行 new=None）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamChange {
    pub name: String,
    pub change: RowChange,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old: Option<ParamSnap>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new: Option<ParamSnap>,
}

/// 请求体 key 行（key_path 为嵌套点路径，array 元素以 `[]` 后缀展开）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyKeyChange {
    pub key_path: String,
    pub change: RowChange,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old: Option<KeySnap>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new: Option<KeySnap>,
}

/// 响应行（行＝状态码；keys 为该状态码 schema 的 key 级明细）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseChange {
    /// 状态码字符串（"200" / "default" / "4XX" 原样保留）
    pub status: String,
    pub change: RowChange,
    /// 状态码行级描述变化承载（description 属定义侧元数据，变化计入）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_description: Option<String>,
    /// schema key 级明细（无响应体的状态码为空集）
    pub keys: Vec<BodyKeyChange>,
}

/// 单接口 diff（Removed 接口明细为空集，呈现走保留卡不用 diff）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointDiff {
    pub key: String,
    pub kind: DiffKind,
    pub title: String,
    pub category: String,
    pub params: Vec<ParamChange>,
    pub body_keys: Vec<BodyKeyChange>,
    pub responses: Vec<ResponseChange>,
}

/// 单服务 diff 汇总（多服务聚合与服务级 unchanged / skipped 计数归向导
/// 编排层，本域只做单服务粒度）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    pub added: usize,
    pub changed: usize,
    pub removed: usize,
    /// 键匹配但定义面零变化（含仅 title / category 变化）的接口计数
    pub unchanged: usize,
}

// —— 引擎 ——

/// 对比两份归一文档，产出接口级 diff 行集（声明序：Added / Changed 按
/// 新文档序，Removed 按基准文档序追加在后——与向导三组清单的稳定呈现序
/// 一致）。`base=None`（首次同步）时全部接口为 Added。
pub fn diff_docs(
    base: Option<&UnifiedDoc>,
    incoming: &UnifiedDoc,
) -> (Vec<EndpointDiff>, DiffSummary) {
    let base_ops: HashMap<&str, &UnifiedOperation> = base
        .map(|doc| {
            doc.operations
                .iter()
                .map(|op| (op.key.as_str(), op))
                .collect()
        })
        .unwrap_or_default();
    let mut summary = DiffSummary::default();
    let mut diffs = Vec::new();

    for op in &incoming.operations {
        match base_ops.get(op.key.as_str()) {
            None => {
                summary.added += 1;
                diffs.push(EndpointDiff {
                    key: op.key.clone(),
                    kind: DiffKind::Added,
                    title: op.title.clone(),
                    category: op.category.clone().unwrap_or_default(),
                    params: op
                        .parameters
                        .iter()
                        .map(|p| ParamChange {
                            name: p.name.clone(),
                            change: RowChange::Added,
                            old: None,
                            new: Some(param_snap(p)),
                        })
                        .collect(),
                    body_keys: body_keys_added(op),
                    responses: op
                        .responses
                        .iter()
                        .map(|r| ResponseChange {
                            status: r.status.clone(),
                            change: RowChange::Added,
                            old_description: None,
                            new_description: r.description.clone(),
                            keys: r
                                .schema
                                .as_ref()
                                .map(|s| {
                                    flatten(s, String::new())
                                        .into_iter()
                                        .map(added_key_row)
                                        .collect()
                                })
                                .unwrap_or_default(),
                        })
                        .collect(),
                });
            }
            Some(prev) => {
                let (row, changed) = diff_operation(prev, op);
                if changed {
                    summary.changed += 1;
                    diffs.push(row);
                } else {
                    summary.unchanged += 1;
                }
            }
        }
    }

    // Removed：基准有而新文档无（按基准文档序追加在末尾）
    if let Some(base) = base {
        let new_keys: HashMap<&str, ()> = incoming
            .operations
            .iter()
            .map(|op| (op.key.as_str(), ()))
            .collect();
        for prev in &base.operations {
            if !new_keys.contains_key(prev.key.as_str()) {
                summary.removed += 1;
                diffs.push(EndpointDiff {
                    key: prev.key.clone(),
                    kind: DiffKind::Removed,
                    title: prev.title.clone(),
                    category: prev.category.clone().unwrap_or_default(),
                    params: Vec::new(),
                    body_keys: Vec::new(),
                    responses: Vec::new(),
                });
            }
        }
    }

    (diffs, summary)
}

/// 单接口对比：产出全量明细行并判定接口级是否 Changed（任何定义侧字段
/// 变化即 Changed；仅 title / category 变化不算）。
fn diff_operation(prev: &UnifiedOperation, new: &UnifiedOperation) -> (EndpointDiff, bool) {
    let params = diff_param_rows(&prev.parameters, &new.parameters);
    let body_keys = diff_key_rows(
        prev.request_body.as_ref().map(|b| &b.schema),
        new.request_body.as_ref().map(|b| &b.schema),
    );
    let responses = diff_response_rows(&prev.responses, &new.responses);
    let changed = params.iter().any(|r| r.change != RowChange::Unchanged)
        || body_keys.iter().any(|r| r.change != RowChange::Unchanged)
        || responses.iter().any(|r| r.change != RowChange::Unchanged);
    (
        EndpointDiff {
            key: new.key.clone(),
            // 调用方只在 changed=true 时保留本行，kind 恒为 Changed
            kind: DiffKind::Changed,
            title: new.title.clone(),
            category: new.category.clone().unwrap_or_default(),
            params,
            body_keys,
            responses,
        },
        changed,
    )
}

// —— 参数级 ——

fn param_snap(p: &UnifiedParameter) -> ParamSnap {
    ParamSnap {
        location: format!("{:?}", p.location).to_lowercase(),
        required: p.required,
        param_type: p.param_type.clone(),
        format: p.format.clone(),
        description: p.description.clone(),
    }
}

/// 参数行按 name 对齐（同名不同 location 视为同一行的「in 变化」）；
/// 行序＝基准序在前、新增行按新文档序追加（全量行含 Unchanged）。
fn diff_param_rows(prev: &[UnifiedParameter], new: &[UnifiedParameter]) -> Vec<ParamChange> {
    let new_map: HashMap<&str, &UnifiedParameter> =
        new.iter().map(|p| (p.name.as_str(), p)).collect();
    let mut rows = Vec::new();
    let mut consumed_new: HashMap<&str, ()> = HashMap::new();
    for p in prev {
        match new_map.get(p.name.as_str()) {
            Some(n) => {
                consumed_new.insert(n.name.as_str(), ());
                let (old_snap, new_snap) = (param_snap(p), param_snap(n));
                let change = if old_snap == new_snap {
                    RowChange::Unchanged
                } else {
                    RowChange::Changed
                };
                rows.push(ParamChange {
                    name: p.name.clone(),
                    change,
                    old: Some(old_snap),
                    new: Some(new_snap),
                });
            }
            None => rows.push(ParamChange {
                name: p.name.clone(),
                change: RowChange::Removed,
                old: Some(param_snap(p)),
                new: None,
            }),
        }
    }
    for n in new {
        if !consumed_new.contains_key(n.name.as_str()) {
            rows.push(ParamChange {
                name: n.name.clone(),
                change: RowChange::Added,
                old: None,
                new: Some(param_snap(n)),
            });
        }
    }
    rows
}

// —— key 级（请求体 / 响应 schema 共用）——

/// 扁平化 schema 为「点路径 → 快照」序列（保持声明序；array 元素以
/// `[]` 后缀下钻 items；截断 / 未知类型以叶子行承载其类型面）。
fn flatten(schema: &UnifiedSchema, prefix: String) -> Vec<(String, KeySnap)> {
    let mut out = Vec::new();
    let required_here = |name: &str| schema.required.iter().any(|r| r == name);
    for (name, child) in &schema.properties {
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}.{name}")
        };
        out.push((
            path.clone(),
            KeySnap {
                schema_type: child.schema_type.clone(),
                required: required_here(name),
            },
        ));
        out.extend(flatten(child, path));
    }
    if let Some(items) = &schema.items {
        let path = format!("{prefix}[]");
        out.push((
            path.clone(),
            KeySnap {
                schema_type: items.schema_type.clone(),
                required: false,
            },
        ));
        out.extend(flatten(items, path));
    }
    out
}

fn added_key_row((key_path, snap): (String, KeySnap)) -> BodyKeyChange {
    BodyKeyChange {
        key_path,
        change: RowChange::Added,
        old: None,
        new: Some(snap),
    }
}

/// key 行按 key_path 对齐（声明序承载于两侧序列，对齐后行序＝基准序
/// 在前、新增行按新文档序追加）。
fn diff_key_rows(prev: Option<&UnifiedSchema>, new: Option<&UnifiedSchema>) -> Vec<BodyKeyChange> {
    let prev_rows = prev.map(|s| flatten(s, String::new())).unwrap_or_default();
    let new_rows = new.map(|s| flatten(s, String::new())).unwrap_or_default();
    let new_map: HashMap<&str, KeySnap> = new_rows
        .iter()
        .map(|(k, s)| (k.as_str(), s.clone()))
        .collect();
    let mut rows = Vec::new();
    let mut consumed: HashMap<&str, ()> = HashMap::new();
    for (path, old_snap) in &prev_rows {
        match new_map.get(path.as_str()) {
            Some(new_snap) => {
                consumed.insert(path.as_str(), ());
                let change = if new_snap == old_snap {
                    RowChange::Unchanged
                } else {
                    RowChange::Changed
                };
                rows.push(BodyKeyChange {
                    key_path: path.clone(),
                    change,
                    old: Some(old_snap.clone()),
                    new: Some(new_snap.clone()),
                });
            }
            None => rows.push(BodyKeyChange {
                key_path: path.clone(),
                change: RowChange::Removed,
                old: Some(old_snap.clone()),
                new: None,
            }),
        }
    }
    for (path, new_snap) in &new_rows {
        if !consumed.contains_key(path.as_str()) {
            rows.push(BodyKeyChange {
                key_path: path.clone(),
                change: RowChange::Added,
                old: None,
                new: Some(new_snap.clone()),
            });
        }
    }
    rows
}

fn body_keys_added(op: &UnifiedOperation) -> Vec<BodyKeyChange> {
    op.request_body
        .as_ref()
        .map(|b| {
            flatten(&b.schema, String::new())
                .into_iter()
                .map(added_key_row)
                .collect()
        })
        .unwrap_or_default()
}

// —— 响应级 ——

fn diff_response_rows(
    prev: &[super::model::UnifiedResponse],
    new: &[super::model::UnifiedResponse],
) -> Vec<ResponseChange> {
    let new_map: HashMap<&str, &super::model::UnifiedResponse> =
        new.iter().map(|r| (r.status.as_str(), r)).collect();
    let mut rows = Vec::new();
    let mut consumed: HashMap<&str, ()> = HashMap::new();
    for p in prev {
        match new_map.get(p.status.as_str()) {
            Some(n) => {
                consumed.insert(n.status.as_str(), ());
                let keys = diff_key_rows(p.schema.as_ref(), n.schema.as_ref());
                let desc_changed =
                    p.description != n.description || p.content_type != n.content_type;
                let change =
                    if desc_changed || keys.iter().any(|k| k.change != RowChange::Unchanged) {
                        RowChange::Changed
                    } else {
                        RowChange::Unchanged
                    };
                rows.push(ResponseChange {
                    status: p.status.clone(),
                    change,
                    old_description: p.description.clone(),
                    new_description: n.description.clone(),
                    keys,
                });
            }
            None => rows.push(ResponseChange {
                status: p.status.clone(),
                change: RowChange::Removed,
                old_description: p.description.clone(),
                new_description: None,
                keys: Vec::new(),
            }),
        }
    }
    for n in new {
        if !consumed.contains_key(n.status.as_str()) {
            rows.push(ResponseChange {
                status: n.status.clone(),
                change: RowChange::Added,
                old_description: None,
                new_description: n.description.clone(),
                keys: n
                    .schema
                    .as_ref()
                    .map(|s| {
                        flatten(s, String::new())
                            .into_iter()
                            .map(added_key_row)
                            .collect()
                    })
                    .unwrap_or_default(),
            });
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::sync::model::*;

    fn op(key: &str) -> UnifiedOperation {
        UnifiedOperation {
            key: key.to_string(),
            method: "GET".to_string(),
            path: "/users".to_string(),
            title: "列表".to_string(),
            category: None,
            description: None,
            parameters: Vec::new(),
            request_body: None,
            responses: Vec::new(),
        }
    }

    fn doc(ops: Vec<UnifiedOperation>) -> UnifiedDoc {
        UnifiedDoc {
            title: "t".into(),
            version: "1".into(),
            operations: ops,
        }
    }

    #[test]
    fn first_sync_marks_everything_added() {
        let (diffs, summary) = diff_docs(None, &doc(vec![op("GET /users"), op("POST /users")]));
        assert_eq!(summary.added, 2);
        assert!(diffs.iter().all(|d| d.kind == DiffKind::Added));
    }

    #[test]
    fn identical_docs_are_all_unchanged() {
        let d = doc(vec![op("GET /users")]);
        let (diffs, summary) = diff_docs(Some(&d), &d);
        assert!(diffs.is_empty());
        assert_eq!(summary.unchanged, 1);
    }

    #[test]
    fn title_only_change_is_not_changed() {
        let mut changed_title = op("GET /users");
        changed_title.title = "新标题".into();
        let (diffs, summary) = diff_docs(
            Some(&doc(vec![op("GET /users")])),
            &doc(vec![changed_title]),
        );
        assert!(diffs.is_empty());
        assert_eq!(summary.unchanged, 1);
    }

    #[test]
    fn missing_in_incoming_is_removed() {
        let (diffs, summary) = diff_docs(
            Some(&doc(vec![op("GET /users"), op("DELETE /users/{id}")])),
            &doc(vec![op("GET /users")]),
        );
        assert_eq!(summary.removed, 1);
        assert_eq!(diffs[0].kind, DiffKind::Removed);
        assert_eq!(diffs[0].key, "DELETE /users/{id}");
    }

    #[test]
    fn param_description_change_counts() {
        let mut base = op("GET /users");
        base.parameters = vec![param("page", "查询页码")];
        let mut new = op("GET /users");
        new.parameters = vec![param("page", "页码（从 1 起）")];
        let (diffs, summary) = diff_docs(Some(&doc(vec![base])), &doc(vec![new]));
        assert_eq!(summary.changed, 1);
        assert_eq!(diffs[0].params[0].change, RowChange::Changed);
    }

    #[test]
    fn param_location_change_counts() {
        let mut base = op("GET /users");
        base.parameters = vec![param("page", "页码")];
        let mut new = op("GET /users");
        let mut moved = param("page", "页码");
        moved.location = UnifiedParamLocation::Header;
        new.parameters = vec![moved];
        let (diffs, summary) = diff_docs(Some(&doc(vec![base])), &doc(vec![new]));
        assert_eq!(summary.changed, 1);
        let row = &diffs[0].params[0];
        assert_eq!(row.change, RowChange::Changed);
        assert_eq!(row.old.as_ref().unwrap().location, "query");
        assert_eq!(row.new.as_ref().unwrap().location, "header");
    }

    fn param(name: &str, desc: &str) -> UnifiedParameter {
        UnifiedParameter {
            name: name.to_string(),
            location: UnifiedParamLocation::Query,
            required: false,
            description: Some(desc.to_string()),
            param_type: "integer".to_string(),
            format: None,
            example: None,
        }
    }

    #[test]
    fn body_key_added_removed_and_unchanged() {
        let mut base = op("POST /users");
        base.request_body = Some(body(object(
            vec![("name", leaf("string")), ("age", leaf("integer"))],
            &["name"],
        )));
        let mut new = op("POST /users");
        new.request_body = Some(body(object(
            vec![("name", leaf("string")), ("email", leaf("string"))],
            &["name", "email"],
        )));
        let (diffs, summary) = diff_docs(Some(&doc(vec![base])), &doc(vec![new]));
        assert_eq!(summary.changed, 1);
        let keys = &diffs[0].body_keys;
        let by_path = |p: &str| keys.iter().find(|k| k.key_path == p).expect(p);
        assert_eq!(by_path("name").change, RowChange::Unchanged);
        assert_eq!(by_path("age").change, RowChange::Removed);
        assert_eq!(by_path("email").change, RowChange::Added);
        // required 进出也计入：email 在新文档 required
        assert!(by_path("email").new.as_ref().unwrap().required);
    }

    #[test]
    fn nested_key_required_change_counts() {
        let addr = |req: &[&str]| object(vec![("city", leaf("string"))], req);
        let mut base = op("POST /users");
        base.request_body = Some(body(object(vec![("addr", addr(&["city"]))], &["addr"])));
        let mut new = op("POST /users");
        new.request_body = Some(body(object(vec![("addr", addr(&[]))], &["addr"])));
        let (diffs, summary) = diff_docs(Some(&doc(vec![base])), &doc(vec![new]));
        assert_eq!(summary.changed, 1);
        let city = diffs[0]
            .body_keys
            .iter()
            .find(|k| k.key_path == "addr.city")
            .unwrap();
        assert_eq!(city.change, RowChange::Changed);
        assert!(city.old.as_ref().unwrap().required);
        assert!(!city.new.as_ref().unwrap().required);
    }

    #[test]
    fn array_items_key_paths_carry_suffix() {
        let mut base = op("POST /users");
        base.request_body = Some(body(object(
            vec![("tags", array_of(leaf("string")))],
            &["tags"],
        )));
        let d = doc(vec![base]);
        let (diffs, summary) = diff_docs(Some(&d), &d);
        assert_eq!(summary.unchanged, 1);
        assert!(diffs.is_empty());
        // 锚定形态经序列化测试覆盖（tags[] 行存在性在此直证）
        let mut probe = op("POST /users");
        probe.request_body = Some(body(object(
            vec![("tags", array_of(leaf("integer")))],
            &["tags"],
        )));
        let (diffs, _) = diff_docs(Some(&d), &doc(vec![probe]));
        let tags = diffs[0]
            .body_keys
            .iter()
            .find(|k| k.key_path == "tags[]")
            .unwrap();
        assert_eq!(tags.change, RowChange::Changed);
    }

    #[test]
    fn response_status_and_schema_changes_count() {
        let mut base = op("GET /users");
        base.responses = vec![response(
            "200",
            Some(object(vec![("total", leaf("integer"))], &["total"])),
        )];
        let mut new = op("GET /users");
        new.responses = vec![
            response(
                "200",
                Some(object(vec![("total", leaf("integer"))], &["total"])),
            ),
            response("404", None),
        ];
        let (diffs, summary) = diff_docs(Some(&doc(vec![base])), &doc(vec![new]));
        assert_eq!(summary.changed, 1);
        let by_status = |s: &str| diffs[0].responses.iter().find(|r| r.status == s).expect(s);
        assert_eq!(by_status("200").change, RowChange::Unchanged);
        assert_eq!(by_status("404").change, RowChange::Added);
    }

    #[test]
    fn response_description_change_counts() {
        let mut base = op("GET /users");
        base.responses = vec![response_with_desc(
            "200",
            Some("成功"),
            Some(object(vec![], &[])),
        )];
        let mut new = op("GET /users");
        new.responses = vec![response_with_desc(
            "200",
            Some("成功返回列表"),
            Some(object(vec![], &[])),
        )];
        let (diffs, summary) = diff_docs(Some(&doc(vec![base])), &doc(vec![new]));
        assert_eq!(summary.changed, 1);
        assert_eq!(diffs[0].responses[0].change, RowChange::Changed);
    }

    // —— 测试用料（属性名与 required 由 helper 成对维护，语义即字面）——

    fn leaf(ty: &str) -> UnifiedSchema {
        UnifiedSchema {
            schema_type: ty.to_string(),
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

    fn object(props: Vec<(&str, UnifiedSchema)>, required: &[&str]) -> UnifiedSchema {
        UnifiedSchema {
            required: required.iter().map(|s| s.to_string()).collect(),
            properties: props.into_iter().map(|(n, s)| (n.to_string(), s)).collect(),
            ..leaf("object")
        }
    }

    fn array_of(items: UnifiedSchema) -> UnifiedSchema {
        UnifiedSchema {
            items: Some(Box::new(items)),
            ..leaf("array")
        }
    }

    fn body(schema: UnifiedSchema) -> UnifiedRequestBody {
        UnifiedRequestBody {
            content_type: "application/json".into(),
            required: true,
            description: None,
            schema,
            example: None,
        }
    }

    fn response(status: &str, schema: Option<UnifiedSchema>) -> UnifiedResponse {
        response_with_desc(status, None, schema)
    }

    // —— 序列化锚定（契约面：struct 声明序＋空值省略）——

    /// 契约样例：Changed 行四态齐全（嵌套点路径＋array 后缀）、Added、
    /// Removed（明细空集）与 summary 全字段。
    fn contract_sample() -> (Vec<EndpointDiff>, DiffSummary) {
        let mut base = op("POST /users");
        base.parameters = vec![
            {
                let mut p = param("page", "页码");
                p.param_type = "integer".into();
                p
            },
            param("size", "每页数量"),
            param("lang", "语言"),
            param("trace", "链路追踪头"),
        ];
        base.request_body = Some(body(object(
            vec![
                ("name", leaf("string")),
                ("age", leaf("integer")),
                ("addr", object(vec![("city", leaf("string"))], &["city"])),
                ("tags", array_of(leaf("string"))),
            ],
            &["name"],
        )));
        base.responses = vec![response_with_desc(
            "200",
            Some("成功"),
            Some(object(vec![("total", leaf("integer"))], &[])),
        )];

        let mut new = op("POST /users");
        let mut moved_trace = param("trace", "链路追踪头");
        moved_trace.location = UnifiedParamLocation::Header;
        new.parameters = vec![
            {
                let mut p = param("page", "页码（从 1 起）");
                p.param_type = "integer".into();
                p
            },
            param("size", "每页数量"),
            moved_trace,
            param("verbose", "详细输出"),
        ];
        new.request_body = Some(body(object(
            vec![
                ("name", leaf("string")),
                ("email", leaf("string")),
                ("addr", object(vec![("city", leaf("string"))], &[])),
                ("tags", array_of(leaf("integer"))),
            ],
            &["name", "email"],
        )));
        new.responses = vec![
            response_with_desc(
                "200",
                Some("成功"),
                Some(object(vec![("total", leaf("integer"))], &[])),
            ),
            response_with_desc("404", Some("未找到"), None),
        ];

        let mut readded = op("GET /users/{id}");
        readded.parameters = vec![param("id", "用户 ID")];

        let removed = op("DELETE /users/{id}");

        let docs_base = doc(vec![base, removed]);
        let docs_new = doc(vec![new, readded]);
        diff_docs(Some(&docs_base), &docs_new)
    }

    /// 双端钉键序：`src/test/fixtures/sync-diff-contract.json`（前端
    /// features/sync 锚定测试共享同一份表）——任一端改契约声明序或空值
    /// 省略口径，另一端立红。首次运行生成夹具后入库；此后恒走对照分支。
    #[test]
    fn contract_serialization_pinned() {
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Fixture {
            summary: DiffSummary,
            diffs: Vec<EndpointDiff>,
        }
        let (diffs, summary) = contract_sample();
        let fixture = Fixture { summary, diffs };
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "\\..\\src\\test\\fixtures\\sync-diff-contract.json"
        );
        let rendered = serde_json::to_string_pretty(&fixture).expect("sample must serialize");
        match std::fs::read_to_string(path) {
            Ok(existing) => {
                // 锚定：声明序＋空值省略口径逐字节对照（CRLF 归一后）
                assert_eq!(existing.replace("\r\n", "\n"), rendered);
            }
            Err(_) => {
                std::fs::write(path, &rendered).expect("generate fixture on first run");
                panic!("fixture generated on first run; re-run to pin");
            }
        }
    }

    fn response_with_desc(
        status: &str,
        desc: Option<&str>,
        schema: Option<UnifiedSchema>,
    ) -> UnifiedResponse {
        UnifiedResponse {
            status: status.to_string(),
            description: desc.map(|d| d.to_string()),
            content_type: schema.as_ref().map(|_| "application/json".to_string()),
            schema,
            example: None,
        }
    }
}
