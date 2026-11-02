//! 最小 JSONPath 求值器：`$` 根、`.name` 属性、`[n]` 数组索引三要素的点
//! 路径子集（`$.data.token`、`$.list[0].id`），覆盖接口调试提取的主流形态。
//!
//! 设计边界：
//! - 过滤器（`[?(...)]`）、通配（`[*]` / `..`）、切片、多索引等高级语法
//!   不受支持——求值返回 `Unsupported`，调用方以失败呈现而非静默空值
//!   （fail-fast 与引擎 NOT_IMPLEMENTED 口径一致）；
//! - 未命中（键缺失 / 索引越界 / 类型不可达）与语法不受支持分列两种结果，
//!   调用方错误信息可区分「路径写错」与「数据没有」；
//! - 纯函数不接触 IO；输入由 serde_json 前置解析，本层不重复校验 JSON
//!   合法性。

use serde_json::Value;

/// 求值错误：路径语法不受支持（与「未命中」区分，调用方按需呈现）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedPath {
    /// 不受支持的片段原文（首个无法解析处，定位用）
    pub fragment: String,
}

/// 求值结果：命中取值（`Some`）、未命中（`None`）、语法不受支持（`Err`）。
pub type PathOutcome<'a> = Result<Option<&'a Value>, UnsupportedPath>;

/// 求值 JSONPath 于给定值。根符 `$` 可省（`data.token` 等价 `$.data.token`）。
/// 语法解析整体先行（不受支持的语法恒报错），求值阶段才允许未命中短路——
/// 「路径写错」与「数据没有」两类失败不互相掩盖。
pub fn evaluate<'a>(path: &str, root: &'a Value) -> PathOutcome<'a> {
    let trimmed = path.trim();
    // 起点归一：`$` 开头剥根符，其余原样（首段是否隐式属性由解析器判定）
    let mut rest = match trimmed.strip_prefix('$') {
        Some(rest) => rest,
        None => trimmed,
    };
    // 语法解析先行：整条路径全部解析成片段（不认识的形态即报错定位）
    let mut fragments = Vec::new();
    let mut at_start = true;
    while !rest.is_empty() {
        let (fragment, next) = parse_fragment(rest, at_start)?;
        fragments.push(fragment);
        rest = next;
        at_start = false;
    }
    // 求值：逐段下降，未命中（键缺失 / 索引越界 / 类型不可达）短路返回
    let mut current = root;
    for fragment in &fragments {
        let Some(next_value) = descend(current, fragment) else {
            return Ok(None);
        };
        current = next_value;
    }
    Ok(Some(current))
}

/// 路径片段（解析产物）：属性名或数组索引。
enum Fragment<'a> {
    Property(&'a str),
    Index(usize),
}

/// 解析下一段路径：`.name` / `['name']` / `[n]`。返回（片段，余段）。
/// 不认识的形态返回 `UnsupportedPath`（原文片段回传定位）。路径首段容忍
/// 省略 `.` 定界符（隐式属性，读到下一个 `.` / `[`）。
fn parse_fragment(rest: &str, at_start: bool) -> Result<(Fragment<'_>, &str), UnsupportedPath> {
    if at_start && !rest.starts_with('.') && !rest.starts_with('[') {
        let name_end = rest.find(|c| c == '.' || c == '[').unwrap_or(rest.len());
        if name_end == 0 {
            return Err(UnsupportedPath {
                fragment: rest.chars().take(4).collect(),
            });
        }
        return Ok((Fragment::Property(&rest[..name_end]), &rest[name_end..]));
    }
    if let Some(after) = rest.strip_prefix('.') {
        // `.` 后必须紧跟属性名（不含 `.` 与 `[`）；裸 `.` / `..` 不支持
        let name_end = after.find(|c| c == '.' || c == '[').unwrap_or(after.len());
        let name = &after[..name_end];
        if name.is_empty() {
            return Err(UnsupportedPath {
                fragment: rest.chars().take(4).collect(),
            });
        }
        return Ok((Fragment::Property(name), &after[name_end..]));
    }
    if let Some(after) = rest.strip_prefix('[') {
        // 括号形态：`[n]` 索引或 `['name']` 引号属性；其余（通配 / 过滤 /
        // 切片）不支持。索引与引号内容不含 `]`（转义括号名不支持——属性名
        // 用点路径书写即可覆盖）
        let Some(close) = after.find(']') else {
            return Err(UnsupportedPath {
                fragment: rest.chars().take(8).collect(),
            });
        };
        let inner = &after[..close];
        if let Some(quoted) = inner.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
            // 引号属性：内容为空或含引号 / 逗号（多键形态）均不支持
            if quoted.is_empty() || quoted.contains('\'') || quoted.contains(',') {
                return Err(UnsupportedPath {
                    fragment: rest.chars().take(8).collect(),
                });
            }
            return Ok((Fragment::Property(quoted), &after[close + 1..]));
        }
        return match inner.parse::<usize>() {
            Ok(index) => Ok((Fragment::Index(index), &after[close + 1..])),
            Err(_) => Err(UnsupportedPath {
                fragment: format!("[{inner}]"),
            }),
        };
    }
    Err(UnsupportedPath {
        fragment: rest.chars().take(4).collect(),
    })
}

/// 于当前值下降一段：命中返回子值；键缺失 / 越界 / 类型不可达返回 `None`。
fn descend<'a>(value: &'a Value, fragment: &Fragment<'_>) -> Option<&'a Value> {
    match fragment {
        Fragment::Property(name) => match value {
            Value::Object(map) => map.get(*name),
            _ => None,
        },
        Fragment::Index(index) => match value {
            Value::Array(items) => items.get(*index),
            _ => None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "data": { "token": "t-1", "nest": { "deep": "v" } },
            "list": [ { "id": 1 }, { "id": 2 } ],
            "status": 200
        })
    }

    #[test]
    fn dot_path_descends_objects() {
        let root = sample();
        assert_eq!(
            evaluate("$.data.token", &root).unwrap(),
            Some(&json!("t-1"))
        );
        assert_eq!(
            evaluate("$.data.nest.deep", &root).unwrap(),
            Some(&json!("v"))
        );
    }

    #[test]
    fn root_symbol_optional_and_trimmed() {
        let root = sample();
        assert_eq!(evaluate("data.token", &root).unwrap(), Some(&json!("t-1")));
        assert_eq!(evaluate("  $.status  ", &root).unwrap(), Some(&json!(200)));
        assert_eq!(evaluate("$", &root).unwrap(), Some(&root));
    }

    #[test]
    fn array_index_and_mixed_path() {
        let root = sample();
        assert_eq!(evaluate("$.list[0].id", &root).unwrap(), Some(&json!(1)));
        assert_eq!(evaluate("$.list[1].id", &root).unwrap(), Some(&json!(2)));
    }

    #[test]
    fn miss_returns_none_not_error() {
        let root = sample();
        // 键缺失、索引越界、对象上取索引、数组上取属性：一律未命中
        assert_eq!(evaluate("$.data.absent", &root).unwrap(), None);
        assert_eq!(evaluate("$.list[9]", &root).unwrap(), None);
        assert_eq!(evaluate("$.data[0]", &root).unwrap(), None);
        assert_eq!(evaluate("$.list.token", &root).unwrap(), None);
    }

    #[test]
    fn unsupported_syntax_is_distinct_from_miss() {
        let root = sample();
        for path in [
            "$..token",
            "$.list[*]",
            "$.list[?(@.id>1)]",
            "$.list[0:2]",
            "$.['a',  'b']",
        ] {
            let outcome = evaluate(path, &root);
            assert!(outcome.is_err(), "{path} 应判不受支持");
        }
    }

    #[test]
    fn empty_segments_unsupported() {
        let root = sample();
        assert!(evaluate("$..", &root).is_err());
        assert!(evaluate("$.a..b", &root).is_err());
        assert!(evaluate("$['']", &root).is_err());
    }
}
