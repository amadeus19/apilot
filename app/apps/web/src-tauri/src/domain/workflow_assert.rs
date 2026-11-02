//! 断言求值器：行式规则对上游请求响应的纯函数判定。
//!
//! 语义（判定定案）：断言对象＝上游请求节点的响应；规则全部满足（AND）
//! 才通过；求值失败（响应体非 JSON / 路径语法不受支持 / 路径未命中）＝该
//! 规则不通过——断言是判定面，「判不过」就是结果，不另设错误通道。
//!
//! 判定与呈现分离：期望值比较 / 包含判定恒对明文进行（执行内上下文），
//! 输出的 actual 是呈现面——字符串取值按名单式口径投影（路径尾段键名命中
//! 敏感键名单、或取值文本命中本次执行的 Secret 消费清单才掩码；未命中的
//! 非敏感字符串明文呈现，「期望 vs 实际」并列可见），布尔 / 数字 / null
//! 标量原样保留（判定依据可见），响应体整体摘要保留结构。

use serde_json::Value;

use crate::domain::json_path;
use crate::domain::redact;
use crate::domain::workflow::{AssertNodeConfig, AssertRule};
use crate::domain::workflow_execution::AssertionEntry;

/// 求值断言节点全部规则（AND 组合的逐条结果；顺序＝配置序）。
///
/// `status` 为上游响应状态码，`body_text` 为响应体 Preview 前缀文本，
/// `secret_values` 为上游请求本次消费的 Secret 变量值清单（请求快照随带，
/// 供取值文本的回显判定）。响应体在首个 JSONPath 类规则需要时才解析
/// （状态码-only 的断言不为响应体付解析成本）。
pub fn evaluate_assertions(
    config: &AssertNodeConfig,
    status: u16,
    body_text: &str,
    secret_values: &[String],
) -> Vec<AssertionEntry> {
    let mut parsed_body: Option<Option<Value>> = None;
    let mut body = |text: &str| -> Option<Value> {
        parsed_body
            .get_or_insert_with(|| serde_json::from_str(text).ok())
            .clone()
    };
    config
        .rules
        .iter()
        .map(|rule| match rule {
            AssertRule::StatusCode { expected } => {
                let actual = status.to_string();
                let passed = expected.trim() == actual;
                entry("statusCode", None, Some(expected.clone()), actual, passed)
            }
            AssertRule::JsonPath { path, expected } => path_rule_outcome(
                "jsonPath",
                path,
                Some(expected.clone()),
                body(body_text),
                |hit| {
                    (
                        masked_scalar(hit, path, secret_values),
                        scalar_text(hit) == expected.as_str(),
                    )
                },
            ),
            AssertRule::Exists { path } => path_rule_outcome(
                "exists",
                path,
                None,
                body(body_text),
                // 「存在」＝非缺失且非 null（null 值按不存在口径判定）
                |hit| {
                    (
                        masked_scalar(hit, path, secret_values),
                        !matches!(hit, Value::Null),
                    )
                },
            ),
            AssertRule::Contains { path, value } => match path.as_deref().map(str::trim) {
                Some(path) if !path.is_empty() => path_rule_outcome(
                    "contains",
                    path,
                    Some(value.clone()),
                    body(body_text),
                    |hit| {
                        (
                            masked_scalar(hit, path, secret_values),
                            scalar_text(hit).contains(value.as_str()),
                        )
                    },
                ),
                // 无定位路径：查响应体文本包含；体文本是潜在敏感载体，
                // 摘要按结构保留口径掩码（键名 / 标量可见、字符串值掩码）
                _ => {
                    let actual = redact::masked_body_excerpt(body_text);
                    let passed = body_text.contains(value.as_str());
                    entry("contains", None, Some(value.clone()), actual, passed)
                }
            },
        })
        .collect()
}

/// 带定位路径规则的共用求值骨架：解析体缺失（非 JSON）→ 路径语法不受
/// 支持 → 路径未命中三类失败分列，命中交给规则自身的判定闭包
/// （返回呈现面 actual 与 passed——判定对明文进行、呈现已按掩码口径投影）。
fn path_rule_outcome(
    rule_kind: &str,
    path: &str,
    expected: Option<String>,
    body: Option<Value>,
    on_hit: impl FnOnce(&Value) -> (String, bool),
) -> AssertionEntry {
    match body {
        Some(root) => match json_path::evaluate(path, &root) {
            Ok(Some(hit)) => {
                let (actual, passed) = on_hit(hit);
                entry(rule_kind, Some(path.to_owned()), expected, actual, passed)
            }
            Ok(None) => entry(
                rule_kind,
                Some(path.to_owned()),
                expected,
                actual_missing(),
                false,
            ),
            Err(unsupported) => entry(
                rule_kind,
                Some(path.to_owned()),
                expected,
                actual_unsupported(&unsupported.fragment),
                false,
            ),
        },
        None => entry(
            rule_kind,
            Some(path.to_owned()),
            expected,
            actual_invalid_json(),
            false,
        ),
    }
}

/// 规则求值结果条目构造（词表与掩码口径的单点）。
fn entry(
    rule_kind: &str,
    path: Option<String>,
    expected: Option<String>,
    actual: String,
    passed: bool,
) -> AssertionEntry {
    AssertionEntry {
        rule_kind: rule_kind.to_owned(),
        path,
        expected,
        actual,
        passed,
    }
}

/// 取值的明文文本化（判定输入面）：字符串原样、null 字面化，其余 serde_json
/// 序列化形态——与提取节点的产物文本化同口径。
fn scalar_text(hit: &Value) -> String {
    match hit {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_owned(),
        other => other.to_string(),
    }
}

/// 取值的呈现投影（记录 / 事件面，名单式口径）：字符串值经
/// [`redact::is_sensitive_value`] 单点判定（键名命中 ∨ Secret 消费值
/// 回显），未命中明文呈现；命中后按命中来源分掩码粒度——键名命中整值
/// 掩码（键名即敏感语义），仅回显命中片段替换（与请求镜像的全文替换核
/// 同源，保留非敏感前后文作对比依据）。布尔 / 数字 / null 标量原样保留
/// ——期望值与实际值的对比依据不因掩码失真。判定恒对明文（执行内上下
/// 文）进行。
fn masked_scalar(hit: &Value, path: &str, secret_values: &[String]) -> String {
    match hit {
        Value::String(text) => {
            let key = path_tail_key(path);
            if !redact::is_sensitive_value(key, text, secret_values) {
                return text.clone();
            }
            if key.is_some_and(redact::is_sensitive_key) {
                redact::MASK.to_owned()
            } else {
                redact::mask_secret_values_in(text, secret_values)
            }
        }
        Value::Null => "null".to_owned(),
        other => other.to_string(),
    }
}

/// JSONPath 的尾段键名提取（敏感键名单判定的输入面）：取路径中最后一个
/// 属性段——`$.data.token` → `token`、`$.list[0].id` → `id`、`$.list[0]`
/// 回落 `list`（数组元素以其所属键为敏感语境）；`$` 根或无法解析的形态
/// 返回 None（无键可判，值清单判定仍生效）。引号属性 `['k']` 同样解析。
pub(crate) fn path_tail_key(path: &str) -> Option<&str> {
    let trimmed = path.trim();
    let mut rest = trimmed.strip_prefix('$').unwrap_or(trimmed);
    let mut tail: Option<&str> = None;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix('.') {
            // 属性名读到下一个定界符（`.` 开启后续段 / `[` 开启索引段）
            let end = after.find(['.', '[']).unwrap_or(after.len());
            if end == 0 {
                return None;
            }
            tail = Some(&after[..end]);
            rest = &after[end..];
        } else if let Some(after) = rest.strip_prefix('[') {
            let close = after.find(']')?;
            let inner = &after[..close];
            if let Some(quoted) = inner.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
                tail = Some(quoted);
            }
            rest = &after[close + 1..];
        } else {
            // 根符省略的首段隐式属性（`data.token` 的 `data`）
            let end = rest.find(['.', '[']).unwrap_or(rest.len());
            tail = Some(&rest[..end]);
            rest = &rest[end..];
        }
    }
    tail.filter(|key| !key.is_empty())
}

fn actual_missing() -> String {
    "(missing)".to_owned()
}

fn actual_invalid_json() -> String {
    "(invalid JSON)".to_owned()
}

fn actual_unsupported(fragment: &str) -> String {
    format!("(unsupported path syntax: {fragment})")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(rules: Vec<AssertRule>) -> AssertNodeConfig {
        AssertNodeConfig { rules }
    }

    #[test]
    fn status_code_rule_matches_trimmed_expected() {
        let ok = evaluate_assertions(
            &rules(vec![AssertRule::StatusCode {
                expected: "200".into(),
            }]),
            200,
            "irrelevant",
            &[],
        );
        assert_eq!(ok.len(), 1);
        assert!(ok[0].passed);
        assert_eq!(ok[0].actual, "200");

        let bad = evaluate_assertions(
            &rules(vec![AssertRule::StatusCode {
                expected: "500".into(),
            }]),
            200,
            "irrelevant",
            &[],
        );
        assert!(!bad[0].passed);
        assert_eq!(bad[0].expected.as_deref(), Some("500"));
        assert_eq!(bad[0].actual, "200");
    }

    #[test]
    fn json_path_rule_projects_actual_by_key_list() {
        let body = r#"{"success":true,"count":3,"token":"secret-value","message":"welcome"}"#;
        // 布尔标量：明文呈现、可判定
        let ok = evaluate_assertions(
            &rules(vec![AssertRule::JsonPath {
                path: "$.success".into(),
                expected: "true".into(),
            }]),
            200,
            body,
            &[],
        );
        assert!(ok[0].passed);
        assert_eq!(ok[0].actual, "true");
        // 数字标量同理
        let ok = evaluate_assertions(
            &rules(vec![AssertRule::JsonPath {
                path: "$.count".into(),
                expected: "3".into(),
            }]),
            200,
            body,
            &[],
        );
        assert!(ok[0].passed);
        // 敏感键（token 命中名单）：判定对明文进行，呈现面整值掩码
        let ok = evaluate_assertions(
            &rules(vec![AssertRule::JsonPath {
                path: "$.token".into(),
                expected: "secret-value".into(),
            }]),
            200,
            body,
            &[],
        );
        assert!(ok[0].passed, "字符串取值判定对明文进行");
        assert_eq!(ok[0].actual, redact::MASK, "敏感键取值整值掩码");
        // 期望不符同样成立
        let bad = evaluate_assertions(
            &rules(vec![AssertRule::JsonPath {
                path: "$.token".into(),
                expected: "other-value".into(),
            }]),
            200,
            body,
            &[],
        );
        assert!(!bad[0].passed);
        assert_eq!(bad[0].actual, redact::MASK);
        // 非敏感字符串键：明文呈现——「期望 vs 实际」并列可见
        let ok = evaluate_assertions(
            &rules(vec![AssertRule::JsonPath {
                path: "$.message".into(),
                expected: "welcome".into(),
            }]),
            200,
            body,
            &[],
        );
        assert!(ok[0].passed);
        assert_eq!(ok[0].actual, "welcome", "非敏感字符串实际值明文");
        // 期望不符：实际值同样明文（失败修复闭环的对比依据）
        let bad = evaluate_assertions(
            &rules(vec![AssertRule::JsonPath {
                path: "$.message".into(),
                expected: "other".into(),
            }]),
            200,
            body,
            &[],
        );
        assert!(!bad[0].passed);
        assert_eq!(bad[0].actual, "welcome");
    }

    /// 取值文本命中本次执行的 Secret 消费清单：键名未命中名单也掩码
    /// （响应回显变量值的口径；片段替换与请求镜像的替换核同源）。
    #[test]
    fn value_matching_consumed_secret_is_masked() {
        let body = r#"{"echo":"Bearer sk-live-abc123","note":"plain text"}"#;
        let secrets = ["sk-live-abc123".to_owned()];
        let entries = evaluate_assertions(
            &rules(vec![AssertRule::JsonPath {
                path: "$.echo".into(),
                expected: "Bearer sk-live-abc123".into(),
            }]),
            200,
            body,
            &secrets,
        );
        assert!(entries[0].passed, "判定对明文进行");
        assert_eq!(entries[0].actual, "Bearer ***", "Secret 消费值片段替换");
        // 非敏感且不回显 Secret 的值不受清单影响
        let entries = evaluate_assertions(
            &rules(vec![AssertRule::JsonPath {
                path: "$.note".into(),
                expected: "plain text".into(),
            }]),
            200,
            body,
            &secrets,
        );
        assert!(entries[0].passed);
        assert_eq!(entries[0].actual, "plain text");
    }

    #[test]
    fn path_tail_key_extracts_last_property_segment() {
        assert_eq!(path_tail_key("$.data.token"), Some("token"));
        assert_eq!(path_tail_key("$.list[0].id"), Some("id"));
        assert_eq!(
            path_tail_key("$.list[0]"),
            Some("list"),
            "索引尾段回落所属键"
        );
        assert_eq!(path_tail_key("$['access_token']"), Some("access_token"));
        assert_eq!(path_tail_key("data.token"), Some("token"), "根符省略形态");
        assert_eq!(path_tail_key("$"), None);
        assert_eq!(path_tail_key(""), None);
    }

    #[test]
    fn json_path_miss_and_broken_body_and_syntax_fail_the_rule() {
        let config = rules(vec![AssertRule::JsonPath {
            path: "$.absent".into(),
            expected: "x".into(),
        }]);
        let miss = evaluate_assertions(&config, 200, r#"{"a":1}"#, &[]);
        assert!(!miss[0].passed);
        assert_eq!(miss[0].actual, "(missing)");

        let broken = evaluate_assertions(&config, 200, "not json at all", &[]);
        assert!(!broken[0].passed);
        assert_eq!(broken[0].actual, "(invalid JSON)");

        let config = rules(vec![AssertRule::JsonPath {
            path: "$.a[?(x)]".into(),
            expected: "x".into(),
        }]);
        let syntax = evaluate_assertions(&config, 200, r#"{"a":1}"#, &[]);
        assert!(!syntax[0].passed);
        assert!(
            syntax[0].actual.contains("unsupported"),
            "{}",
            syntax[0].actual
        );
    }

    #[test]
    fn exists_rule_treats_null_as_absent() {
        let body = r#"{"present":"v","nulled":null}"#;
        let ok = evaluate_assertions(
            &rules(vec![AssertRule::Exists {
                path: "$.present".into(),
            }]),
            200,
            body,
            &[],
        );
        assert!(ok[0].passed);
        assert_eq!(ok[0].actual, "v", "非敏感字符串存在值明文呈现");
        // null 与缺失同判不存在；null 的呈现保留值形态（比 missing 更可诊断）
        let nulled = evaluate_assertions(
            &rules(vec![AssertRule::Exists {
                path: "$.nulled".into(),
            }]),
            200,
            body,
            &[],
        );
        assert!(!nulled[0].passed, "null 不应判存在");
        assert_eq!(nulled[0].actual, "null");
        let absent = evaluate_assertions(
            &rules(vec![AssertRule::Exists {
                path: "$.absent".into(),
            }]),
            200,
            body,
            &[],
        );
        assert!(!absent[0].passed, "缺失不应判存在");
        assert_eq!(absent[0].actual, "(missing)");
    }

    #[test]
    fn contains_rule_without_path_checks_body_text_with_structured_mask() {
        let ok = evaluate_assertions(
            &rules(vec![AssertRule::Contains {
                path: None,
                value: r#""ok""#.into(),
            }]),
            200,
            r#"{"msg":"ok"}"#,
            &[],
        );
        assert!(ok[0].passed);
        // 呈现面掩码（结构保留），但判定对原文进行
        assert!(ok[0].actual.contains("msg"));

        let bad = evaluate_assertions(
            &rules(vec![AssertRule::Contains {
                path: None,
                value: "absent-marker".into(),
            }]),
            200,
            r#"{"msg":"fine"}"#,
            &[],
        );
        assert!(!bad[0].passed);
    }

    #[test]
    fn contains_rule_with_path_checks_masked_value() {
        let ok = evaluate_assertions(
            &rules(vec![AssertRule::Contains {
                path: Some("$.note".into()),
                value: "part".into(),
            }]),
            200,
            r#"{"note":"the-part-inside"}"#,
            &[],
        );
        // 判定对明文进行（contains 命中），非敏感键明文呈现
        assert!(ok[0].passed);
        assert_eq!(ok[0].actual, "the-part-inside");

        // 敏感键命中名单：整值掩码
        let secret = evaluate_assertions(
            &rules(vec![AssertRule::Contains {
                path: Some("$.password".into()),
                value: "part".into(),
            }]),
            200,
            r#"{"password":"the-part-inside"}"#,
            &[],
        );
        assert!(secret[0].passed);
        assert_eq!(secret[0].actual, redact::MASK);

        // 数字取值：标量保留、字符串 contains 语义按文本形态
        let num = evaluate_assertions(
            &rules(vec![AssertRule::Contains {
                path: Some("$.n".into()),
                value: "42".into(),
            }]),
            200,
            r#"{"n":42}"#,
            &[],
        );
        assert!(num[0].passed);
        assert_eq!(num[0].actual, "42");
    }

    #[test]
    fn and_combination_requires_all_rules_to_pass() {
        let config = rules(vec![
            AssertRule::StatusCode {
                expected: "200".into(),
            },
            AssertRule::Exists {
                path: "$.data.id".into(),
            },
            AssertRule::JsonPath {
                path: "$.success".into(),
                expected: "true".into(),
            },
            AssertRule::Contains {
                path: None,
                value: "welcome".into(),
            },
        ]);
        let body = r#"{"success":true,"data":{"id":"u1"},"msg":"welcome"}"#;
        let all = evaluate_assertions(&config, 200, body, &[]);
        assert_eq!(all.len(), 4);
        assert!(all.iter().all(|entry| entry.passed), "全部满足才 AND 通过");

        // 任一失败即不通过（其他规则不受影响仍逐条呈现）
        let body = r#"{"success":false,"data":{"id":"u1"},"msg":"welcome"}"#;
        let mixed = evaluate_assertions(&config, 200, body, &[]);
        assert!(mixed[0].passed);
        assert!(mixed[1].passed);
        assert!(!mixed[2].passed, "jsonPath 失败");
        assert!(mixed[3].passed);
    }

    #[test]
    fn status_code_only_assertion_skips_body_parsing() {
        // 响应体非 JSON 但只断言状态码：不因体解析失败牵连
        let all = evaluate_assertions(
            &rules(vec![AssertRule::StatusCode {
                expected: "200".into(),
            }]),
            200,
            "plain text body",
            &[],
        );
        assert!(all[0].passed);
    }

    #[test]
    fn empty_rule_set_is_vacuously_passed() {
        // 空规则集＝AND 空集语义（恒通过）；「断言节点无规则」是否视为配置
        // 错误归执行前校验器把关，求值器不另设判定
        let all = evaluate_assertions(&rules(Vec::new()), 200, "anything", &[]);
        assert!(all.is_empty());
    }
}
