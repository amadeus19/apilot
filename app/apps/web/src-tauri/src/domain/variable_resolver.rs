//! 变量解析公共构件：`{{变量名}}` 模板的解析纯函数。
//!
//! 消费方：GUI 发送链（services::http::request 合成）、发送前解析预览
//! （Variable Preview，随发送响应附带的命中记录）、CLI `api run`（同一
//! 发送链零独立逻辑）、工作流（Phase 6 接入）。本层只做「输入契约 →
//! 解析结果」的纯函数，不接触数据库。
//!
//! 语义定案（spec「变量域」）：
//! - 位置白名单：URL 各段 / params·headers 的值列 / 认证值 / body——由
//!   调用方决定在哪些位置调用本构件；Key 列与 doc_url 不解析（不调用即不解析）；
//! - 未命中模板原样保留（`{{placeholder}}` 留给下游服务的占位符不被吞掉）；
//! - 变量值不递归解析（值中出现 `{{...}}` 按字面输出，防循环注入）；
//! - Secret 消费记录：命中且 `secret` 标记的变量值进入消费清单，由发送链
//!   并入 redactions（展示与输出面全文替换掩码；快照仍存明文）。

use crate::domain::variable::EffectiveVariable;

/// 模板定界：起始 `{{`、终止 `}}`（三括号病态形态由「未命中原样保留」兜底）
const TEMPLATE_START: &str = "{{";
const TEMPLATE_END: &str = "}}";

/// 单次模板解析的消费记录（预览与 Secret 清单的统一素材；序列化形态即
/// 发送响应附带契约，camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionHit {
    /// 模板原文的规范形态（`{{key}}`；空白容忍后按 trim 键呈现）
    pub template: String,
    /// 变量名（trim 后）
    pub key: String,
    /// 解析后值；未命中＝模板原样输出
    pub resolved: String,
    /// 是否命中生效变量集
    pub hit: bool,
    /// 命中的变量是否标记 Secret（前端据此掩码 resolved 值）
    pub secret: bool,
}

/// 解析产出：替换后文本＋消费记录（未命中也记录——预览要展示未命中标示）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResolvedText {
    pub text: String,
    pub hits: Vec<ResolutionHit>,
}

impl ResolvedText {
    /// 本次消费的 Secret 值清单（命中且 secret 标记的变量值，按消费序、去重）。
    /// 供发送链并入 redactions，展示与输出面据此对请求镜像全文替换掩码。
    pub fn secret_values(&self) -> Vec<String> {
        secret_values_from_hits(&self.hits)
    }
}

/// 从命中记录提取 Secret 消费清单（命中且 secret 标记的值，按记录序、去重）。
/// 单源算法：解析产物（`ResolvedText::secret_values`）与合成装配
/// （`synthesize` 汇总多位置命中后）共用，口径不随消费方分叉。
pub(crate) fn secret_values_from_hits(hits: &[ResolutionHit]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for hit in hits {
        if hit.hit && hit.secret && !out.contains(&hit.resolved) {
            out.push(hit.resolved.clone());
        }
    }
    out
}

/// Secret 消费清单合并（保序去重：重复值不入列）。合成与两级认证值的
/// 多路清单经此并为单份，供 redactions 消费。
pub(crate) fn merge_secret_values(
    target: &mut Vec<String>,
    source: impl IntoIterator<Item = String>,
) {
    for value in source {
        if !target.contains(&value) {
            target.push(value);
        }
    }
}

/// 查找生效变量（同名键在合成链上已收敛为单条；此处按名精确匹配）
fn find_variable<'a>(
    variables: &'a [EffectiveVariable],
    key: &str,
) -> Option<&'a EffectiveVariable> {
    variables.iter().find(|v| v.key == key)
}

/// 深层引用求值（`{{产物名.字段}}` 的解析器侧入口）：精确键未命中时
/// 按点切分最长前缀优先——前缀命中变量且值为合法 JSON 时，其余段作字段
/// 路径惰性求值；命中继承前缀变量的敏感标记。核心语义单点在
/// [`crate::domain::workflow_execution::resolve_deep_reference`]，此处只
/// 做自身数据形态的桥接。命中为 None＝未命中（模板原样保留）。
fn resolve_deep(variables: &[EffectiveVariable], key: &str) -> Option<(String, bool)> {
    let lookup = |prefix: &str| find_variable(variables, prefix).map(|v| v.value.clone());
    let (value, prefix) = crate::domain::workflow_execution::resolve_deep_reference(&lookup, key)?;
    let secret = find_variable(variables, &prefix)
        .map(|v| v.secret)
        .unwrap_or(false);
    Some((value, secret))
}

/// 值列模板解析：`{{name}}` 命中替换、未命中原样保留、值不递归。
/// 模板名 trim 后匹配（`{{ token }}` 等价 `{{token}}`）；`{{}}` 空名恒未命中。
/// 精确键未命中再走深层引用求值（提取产物 `{{产物名.字段}}`）。
pub fn resolve_value(text: &str, variables: &[EffectiveVariable]) -> ResolvedText {
    let mut out = String::with_capacity(text.len());
    let mut hits: Vec<ResolutionHit> = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(TEMPLATE_START) {
        // 起始定界前的字面段直通
        out.push_str(&rest[..start]);
        let after = &rest[start + TEMPLATE_START.len()..];
        let Some(end) = after.find(TEMPLATE_END) else {
            // 无闭合定界：余段（含起始 `{{`）全为字面
            out.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let inner = &after[..end];
        let template_end = TEMPLATE_START.len() + end + TEMPLATE_END.len();
        let key = inner.trim();
        let resolved = (!key.is_empty())
            .then(|| {
                find_variable(variables, key)
                    .map(|variable| (variable.value.clone(), variable.secret))
            })
            .flatten()
            .or_else(|| resolve_deep(variables, key));
        let Some((value, secret)) = resolved else {
            // 未命中（含空名与病态三括号）：模板原样保留，同样入记录（预览标示）
            let raw = &rest[start..start + template_end];
            hits.push(ResolutionHit {
                template: format!("{{{{{key}}}}}"),
                key: key.to_owned(),
                resolved: raw.to_owned(),
                hit: false,
                secret: false,
            });
            out.push_str(raw);
            rest = &rest[start + template_end..];
            continue;
        };
        hits.push(ResolutionHit {
            template: format!("{{{{{key}}}}}"),
            key: key.to_owned(),
            resolved: value.clone(),
            hit: true,
            secret,
        });
        out.push_str(&value);
        rest = &rest[start + template_end..];
    }
    out.push_str(rest);
    ResolvedText { text: out, hits }
}

// —— JSON body 结构级解析 ——

/// JSON 文本内的字符串字面量 span（含引号的起止偏移）＋是否属性名位置。
struct StringSpan {
    start: usize,
    /// 闭引号后一偏移（半开区间；slice = text[start..end] 为完整字面量）
    end: usize,
    /// 属性名位置（字面量后第一个非空白字符是 `:`）：Key 列口径，不解析
    is_key: bool,
}

/// 扫描 JSON 文本的字符串字面量（状态机处理 `\\` 转义；文本已验证为合法
/// JSON，扫描器只需正确跳过转义，不承担合法性判定）。
fn json_string_spans(text: &str) -> Vec<StringSpan> {
    let bytes = text.as_bytes();
    let mut spans = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                let start = i;
                i += 1;
                let mut escaped = false;
                while i < bytes.len() {
                    let byte = bytes[i];
                    i += 1;
                    if escaped {
                        escaped = false;
                    } else if byte == b'\\' {
                        escaped = true;
                    } else if byte == b'"' {
                        break;
                    }
                }
                // 属性名判定：闭引号后第一个非空白字符是 `:`
                let mut probe = i;
                while probe < bytes.len() && matches!(bytes[probe], b' ' | b'\t' | b'\n' | b'\r') {
                    probe += 1;
                }
                let is_key = probe < bytes.len() && bytes[probe] == b':';
                spans.push(StringSpan {
                    start,
                    end: i,
                    is_key,
                });
            }
            // 字符串外的字符（含数字 / 布尔 / 结构符与字符串间空白）直通
            _ => i += 1,
        }
    }
    spans
}

/// JSON body 解析：合法 JSON → 结构级替换（只在字符串字面量值内替换，属性名
/// 与数字 / 布尔 / null 不动；字面量解码后替换再重编码，替换值含引号或换行
/// 也能保持合法 JSON，其余文本含缩进排版逐字节保留）；parse 失败 → 降级
/// 值列文本级替换（`resolve_value`）。
pub fn resolve_json_body(text: &str, variables: &[EffectiveVariable]) -> ResolvedText {
    if serde_json::from_str::<serde_json::Value>(text).is_err() {
        return resolve_value(text, variables);
    }
    let spans = json_string_spans(text);
    let mut out = String::with_capacity(text.len());
    let mut hits: Vec<ResolutionHit> = Vec::new();
    let mut cursor = 0usize;
    for span in spans {
        // 字面量前的字面段直通（保排版）
        out.push_str(&text[cursor..span.start]);
        cursor = span.end;
        if span.is_key {
            // Key 列口径：属性名不解析
            out.push_str(&text[span.start..span.end]);
            continue;
        }
        // 字面量（含引号）经 serde_json 解码为值 → 值列解析 → 命中则重编码
        let literal = &text[span.start..span.end];
        let Ok(decoded) = serde_json::from_str::<String>(literal) else {
            // 合法 JSON 验证过，此分支不可达（防御：字面量原样保留）
            out.push_str(literal);
            continue;
        };
        let resolved = resolve_value(&decoded, variables);
        hits.extend(resolved.hits);
        if resolved.text == decoded {
            out.push_str(literal);
        } else {
            // 序列化产出含引号与转义的完整字面量（转义正确性由 serde_json 保证）
            out.push_str(
                &serde_json::to_string(&resolved.text).expect("string serialization cannot fail"),
            );
        }
    }
    out.push_str(&text[cursor..]);
    ResolvedText { text: out, hits }
}

// —— 认证配置 JSON 的值字段解析 ——

/// 认证配置 JSON 的值字段解析（白名单：认证值）：bearer·token / basic·
/// username·password / apiKey·value 逐字段做值列解析；type / position /
/// apiKey·key（注入名，非值）不解析。非法 JSON 原样返回（调用方 apply_auth
/// 将以原 JSON fail-fast，解析层不吞认证配置错误）；重序列化产物交认证
/// 注入（字段顺序不保证保留，parse 按字段名取值、顺序无消费方）。
pub fn resolve_auth_json(raw: &str, variables: &[EffectiveVariable]) -> ResolvedText {
    let mut value: serde_json::Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => {
            return ResolvedText {
                text: raw.to_owned(),
                hits: Vec::new(),
            };
        }
    };
    let type_name = value
        .as_object()
        .and_then(|obj| obj.get("type"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let value_fields: &[&str] = match type_name.as_str() {
        "bearer" => &["token"],
        "basic" => &["username", "password"],
        "apiKey" => &["value"],
        // inherit / none 无值字段；未知类型交 apply_auth 报错
        _ => &[],
    };
    let mut hits: Vec<ResolutionHit> = Vec::new();
    if let Some(obj) = value.as_object_mut() {
        for field in value_fields {
            let Some(current) = obj.get(*field).and_then(serde_json::Value::as_str) else {
                continue;
            };
            let resolved = resolve_value(current, variables);
            hits.extend(resolved.hits);
            if resolved.text != current {
                obj.insert(field.to_string(), serde_json::Value::String(resolved.text));
            }
        }
    }
    let text = serde_json::to_string(&value).expect("value serialization cannot fail");
    ResolvedText { text, hits }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::variable::VariableSource;

    fn var(key: &str, value: &str, secret: bool) -> EffectiveVariable {
        EffectiveVariable {
            key: key.to_owned(),
            value: value.to_owned(),
            secret,
            source: VariableSource::Active,
        }
    }

    // —— 值列解析 ——

    #[test]
    fn resolve_value_replaces_hits_and_keeps_misses() {
        let vars = vec![
            var("host", "https://api.example.com", false),
            var("n", "7", false),
        ];
        let resolved = resolve_value("{{host}}/items/{{n}}/{{missing}}", &vars);
        assert_eq!(resolved.text, "https://api.example.com/items/7/{{missing}}");
        assert_eq!(resolved.hits.len(), 3);
        assert!(resolved.hits[0].hit && resolved.hits[1].hit);
        let missed = &resolved.hits[2];
        assert!(!missed.hit);
        assert_eq!(missed.resolved, "{{missing}}", "未命中 resolved＝原样输出");
        assert_eq!(missed.key, "missing");
    }

    #[test]
    fn resolve_value_trims_key_and_keeps_empty_and_unterminated() {
        let vars = vec![var("k", "v", false)];
        assert_eq!(
            resolve_value("{{ k }}", &vars).text,
            "v",
            "模板名 trim 后匹配"
        );
        assert_eq!(
            resolve_value("{{}}", &vars).text,
            "{{}}",
            "空名恒未命中原样"
        );
        assert_eq!(resolve_value("{{k", &vars).text, "{{k", "无闭合定界原样");
        // 三括号病态形态：inner 以 { 起头匹配不到变量名，原样保留
        assert_eq!(resolve_value("{{{k}}}", &vars).text, "{{{k}}}");
    }

    /// 变量值不递归解析：值中出现模板形态按字面输出（防循环注入）
    #[test]
    fn resolve_value_does_not_recurse_into_values() {
        let vars = vec![var("outer", "{{inner}}", false), var("inner", "x", false)];
        let resolved = resolve_value("{{outer}}", &vars);
        assert_eq!(resolved.text, "{{inner}}");
        assert_eq!(resolved.hits.len(), 1);
    }

    /// Secret 消费清单：命中且 secret 标记的值按消费序去重入清单；
    /// 未命中与非 Secret 命中不入
    #[test]
    fn secret_values_collect_consumed_secrets_deduped() {
        let vars = vec![var("tok", "t1", true), var("plain", "p", false)];
        let resolved = resolve_value("{{tok}}/{{plain}}/{{tok}}/{{miss}}", &vars);
        assert_eq!(resolved.secret_values(), vec!["t1".to_owned()]);
        assert_eq!(resolved.text, "t1/p/t1/{{miss}}");
    }

    /// 多路 Secret 清单合并：保序（先到定位）、去重（重复值不入列）
    #[test]
    fn merge_secret_values_keeps_order_and_dedupes() {
        let mut target: Vec<String> = vec!["a".to_owned(), "b".to_owned()];
        merge_secret_values(
            &mut target,
            ["b".to_owned(), "c".to_owned(), "a".to_owned()],
        );
        // b / a 已在目标清单（去重不入）；c 为新增值按源序追加
        assert_eq!(target, vec!["a".to_owned(), "b".to_owned(), "c".to_owned()]);
    }

    // —— 深层引用（提取产物 {{产物名.字段}}）——

    /// 精确键未命中时按深层引用求值：JSON 前缀命中即字段路径下钻，secret
    /// 标记继承前缀变量；非 JSON 前缀与彻底未命中原样保留
    #[test]
    fn deep_reference_resolves_extract_product_fields() {
        let vars = vec![
            var("login.data", r#"{"token":"t-1"}"#, true),
            var("plain", "x", false),
        ];
        // 对象产物整体引用走精确键；字段引用走深层求值
        assert_eq!(
            resolve_value("{{login.data.token}}", &vars).text,
            "t-1",
            "深层字段命中产物内的值"
        );
        let resolved = resolve_value("{{login.data.token}}", &vars);
        assert!(
            resolved.secret_values().contains(&"t-1".to_owned()),
            "深层命中继承前缀的敏感标记"
        );
        // 前缀非 JSON：原样保留（与变量缺失同语义）
        assert_eq!(
            resolve_value("{{plain.field}}", &vars).text,
            "{{plain.field}}"
        );
        // 前缀不存在：原样保留
        assert_eq!(resolve_value("{{ghost.x}}", &vars).text, "{{ghost.x}}");
    }

    /// 精确键优先于深层求值：存在同名精确键时不做字段下钻
    #[test]
    fn exact_key_wins_over_deep_reference() {
        let vars = vec![
            var("a.b", "exact", false),
            var("a", r#"{"b":"deep"}"#, false),
        ];
        assert_eq!(
            resolve_value("{{a.b}}", &vars).text,
            "exact",
            "精确键命中优先"
        );
    }

    // —— JSON body 结构级解析 ——

    /// 结构级替换：字符串值内替换、属性名与数字不动、排版保留、命中 Secret
    /// 值清单产出
    #[test]
    fn json_body_replaces_string_values_only_and_keeps_layout() {
        let vars = vec![var("name", "Ada", false), var("note", "hi", false)];
        let body =
            "{\n  \"name\": \"{{name}}\",\n  \"{{name}}\": \"kept\",\n  \"count\": \"{{note}}\"\n}";
        let resolved = resolve_json_body(body, &vars);
        // 值位置替换；属性名位置的 {{name}} 是 Key 列，不解析
        assert_eq!(
            resolved.text,
            "{\n  \"name\": \"Ada\",\n  \"{{name}}\": \"kept\",\n  \"count\": \"hi\"\n}"
        );
        assert_eq!(resolved.hits.len(), 2, "属性名不产生命中记录");
    }

    /// 转义保真：替换值含引号 / 反斜杠 / 换行，替换后仍是合法 JSON 且解码回原值
    #[test]
    fn json_body_escapes_replaced_values_staying_valid_json() {
        let vars = vec![var("q", "a\"b\\c\nd", false)];
        let resolved = resolve_json_body(r#"{"query":"{{q}}"}"#, &vars);
        let parsed: serde_json::Value =
            serde_json::from_str(&resolved.text).expect("替换后必须仍是合法 JSON");
        assert_eq!(parsed["query"], "a\"b\\c\nd");
    }

    /// 原文转义形态的模板：解码后匹配（\u 转义的变量名命中）
    #[test]
    fn json_body_matches_after_decode() {
        let vars = vec![var("k", "v", false)];
        // "{{k}}" 的 k 用 \u006b 转义书写
        let resolved = resolve_json_body(r#"{"a":"{{\u006b}}"}"#, &vars);
        assert_eq!(resolved.text, r#"{"a":"v"}"#);
    }

    /// parse 失败降级文本级替换（直接字符串替换，不再保证 JSON 合法性——
    /// 非 JSON body 本就无该约束）
    #[test]
    fn json_body_falls_back_to_plain_text_when_not_json() {
        let vars = vec![var("k", "\"x\"", false)];
        let resolved = resolve_json_body("plain {{k}} text", &vars);
        assert_eq!(resolved.text, "plain \"x\" text");
        assert_eq!(resolved.hits.len(), 1);
    }

    #[test]
    fn json_body_without_templates_is_untouched() {
        let body = r#"{"a":1,"b":[true,null,"s"]}"#;
        assert_eq!(resolve_json_body(body, &[]).text, body);
        // 非 JSON 且无模板同样原样
        assert_eq!(resolve_json_body("hello", &[]).text, "hello");
    }

    // —— 认证配置 JSON 值字段解析 ——

    #[test]
    fn auth_json_resolves_value_fields_only() {
        let vars = vec![var("token", "tk", true), var("user", "ada", false)];
        let bearer = resolve_auth_json(r#"{"type":"bearer","token":"{{token}}"}"#, &vars);
        let parsed: serde_json::Value = serde_json::from_str(&bearer.text).unwrap();
        assert_eq!(parsed["type"], "bearer");
        assert_eq!(parsed["token"], "tk");
        assert_eq!(bearer.secret_values(), vec!["tk".to_owned()]);

        let basic = resolve_auth_json(
            r#"{"type":"basic","username":"{{user}}","password":"{{token}}"}"#,
            &vars,
        );
        let parsed: serde_json::Value = serde_json::from_str(&basic.text).unwrap();
        assert_eq!(parsed["username"], "ada");
        assert_eq!(parsed["password"], "tk");

        // apiKey：value 解析、key（注入名）不解析、position 不动
        let api_key = resolve_auth_json(
            r#"{"type":"apiKey","position":"header","key":"{{token}}","value":"{{user}}"}"#,
            &vars,
        );
        let parsed: serde_json::Value = serde_json::from_str(&api_key.text).unwrap();
        assert_eq!(parsed["key"], "{{token}}", "注入名按 Key 列口径不解析");
        assert_eq!(parsed["value"], "ada");
        assert_eq!(parsed["position"], "header");
        // key 未解析 → 不产生命中记录；value 命中一条
        assert_eq!(api_key.hits.len(), 1);
    }

    /// inherit / none 无值字段零解析；非法 JSON 原样返回（fail-fast 交调用方）
    #[test]
    fn auth_json_passes_through_fieldless_types_and_dirty_json() {
        for raw in [r#"{"type":"inherit"}"#, r#"{"type":"none"}"#] {
            let resolved = resolve_auth_json(raw, &[var("token", "tk", false)]);
            assert_eq!(resolved.text, raw);
            assert!(resolved.hits.is_empty());
        }
        let dirty = resolve_auth_json("{bad", &[var("token", "tk", false)]);
        assert_eq!(dirty.text, "{bad");
        assert!(dirty.hits.is_empty());
    }
}
