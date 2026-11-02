//! 条件表达式求值器：条件判断节点 IF / ELSE IF 行式的纯函数判定核。
//!
//! 语法（单行表达式）：`<操作数> <二元操作符> <操作数>` 或
//! `<操作数> <一元操作符>`。操作符全集：`==` `!=` `>` `>=` `<` `<=`
//! `contains` `startsWith` `endsWith`（二元）与 `exists` `isEmpty`（一元）。
//! 操作数：`{{变量}}` 引用、引号字符串（`"..."` / `'...'`，无转义）、
//! 数字、`true` / `false` 布尔字面量、裸词（按原文文本参与比较）。
//!
//! 类型容忍口径：两侧值统一文本化后比较——`==` / `!=` 按文本相等
//! （`"200" == 200` 成立，数字字面量文本化即匹配）；`>` 族先尝试两侧
//! 数值化（f64）比较，任一侧非数字回落字典序；布尔字面量即文本
//! `true` / `false`。变量缺失是独立取值态：`exists` 判 false、`isEmpty`
//! 判 true（缺失即无值即空）、参与其余比较一律不满足。
//!
//! 短路语义：分支序列按配置序求值，首个真值分支即命中；未求值到的
//! 分支不解析（执行前全量校验归校验器，求值器只对实际执行路径负责）。

use crate::domain::workflow::ConditionBranch;

/// Default 兜底出边的 label：条件节点全不满足时的激活目标（出边标注、
/// 引擎选边与校验边合法性判定的共享词）。
pub const DEFAULT_EDGE_LABEL: &str = "DEFAULT";

/// 分支序列求值结果：命中的分支（None = 全不满足，走 Default 兜底出口）。
#[derive(Debug, Clone, PartialEq)]
pub struct ConditionOutcome {
    /// 命中分支 id；None = Default
    pub branch_id: Option<String>,
    /// 命中分支的原始表达式（Default 时为空串）
    pub expression: String,
    /// 命中分支的求值结果（恒 true；Default 时 false）
    pub result: bool,
}

/// 对分支序列短路求值：首个真值分支即命中；全部不满足 = Default。
/// 任一被求值分支的表达式解析失败即整错（错误信息携带原表达式与原因）。
pub fn evaluate_branches(
    branches: &[ConditionBranch],
    resolve: &dyn Fn(&str) -> Option<String>,
) -> Result<ConditionOutcome, String> {
    for branch in branches {
        if evaluate_expression(&branch.expression, resolve)? {
            return Ok(ConditionOutcome {
                branch_id: Some(branch.id.clone()),
                expression: branch.expression.clone(),
                result: true,
            });
        }
    }
    Ok(ConditionOutcome {
        branch_id: None,
        expression: String::new(),
        result: false,
    })
}

/// 操作数取值态：变量缺失是独立值（exists / isEmpty 与其余比较分别消费）。
#[derive(Debug, Clone, PartialEq)]
enum OperandValue {
    Missing,
    Text(String),
}

impl OperandValue {
    /// 比较用文本化（缺失无文本，调用方先判 Missing）。
    fn text(&self) -> &str {
        match self {
            OperandValue::Missing => "",
            OperandValue::Text(text) => text,
        }
    }
}

/// 求值单行表达式。失败时错误信息携带原因（原表达式由调用方附记）。
pub fn evaluate_expression(
    expression: &str,
    resolve: &dyn Fn(&str) -> Option<String>,
) -> Result<bool, String> {
    let tokens = tokenize(expression)?;
    match tokens.as_slice() {
        [left, Token::Operator(op), right] => evaluate_binary(left, op, right, resolve),
        // 一元分支只收一元操作符；`x ==` 这类残缺二元落 default 报结构错误
        [operand, Token::Operator(op)] if matches!(op, Operator::Exists | Operator::IsEmpty) => {
            evaluate_unary(operand, op, resolve)
        }
        _ => Err(
            "expected `<operand> <operator> <operand>` or `<operand> exists|isEmpty`".to_owned(),
        ),
    }
}

/// 词元：操作数（变量引用 / 字面量）或操作符词。
#[derive(Debug, Clone, PartialEq)]
enum Token {
    Operand(Operand),
    Operator(Operator),
}

/// 操作数：`{{变量}}` 引用（按名解析）或字面量文本。
#[derive(Debug, Clone, PartialEq)]
enum Operand {
    Var(String),
    Lit(String),
}

/// 操作符词表（精确拼写；大小写敏感——表达式是配置面而非自由文本）。
#[derive(Debug, Clone, Copy, PartialEq)]
enum Operator {
    Eq,
    Ne,
    Gt,
    Ge,
    Lt,
    Le,
    Contains,
    StartsWith,
    EndsWith,
    Exists,
    IsEmpty,
}

fn parse_operator(word: &str) -> Option<Operator> {
    match word {
        "==" => Some(Operator::Eq),
        "!=" => Some(Operator::Ne),
        ">" => Some(Operator::Gt),
        ">=" => Some(Operator::Ge),
        "<" => Some(Operator::Lt),
        "<=" => Some(Operator::Le),
        "contains" => Some(Operator::Contains),
        "startsWith" => Some(Operator::StartsWith),
        "endsWith" => Some(Operator::EndsWith),
        "exists" => Some(Operator::Exists),
        "isEmpty" => Some(Operator::IsEmpty),
        _ => None,
    }
}

/// 词法切分：空白分隔；`{{...}}` 变量段与引号段内部不按空白切（未闭合
/// 即报错）；裸词按操作符表归 Operator、其余归字面量。
fn tokenize(expression: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let bytes = expression.as_bytes();
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        let byte = bytes[cursor];
        if byte.is_ascii_whitespace() {
            cursor += 1;
            continue;
        }
        if expression[cursor..].starts_with("{{") {
            let close = expression[cursor + 2..]
                .find("}}")
                .ok_or_else(|| "unclosed variable reference: missing `}}`".to_owned())?;
            let key = expression[cursor + 2..cursor + 2 + close].trim();
            if key.is_empty() {
                return Err("empty variable reference: `{{}}`".to_owned());
            }
            tokens.push(Token::Operand(Operand::Var(key.to_owned())));
            cursor += 2 + close + 2;
            continue;
        }
        if byte == b'"' || byte == b'\'' {
            // 入口已限定引号为 ASCII（0x22 / 0x27），as char 不会截断多字节字符
            let quote_char = byte as char;
            let close = expression[cursor + 1..]
                .find(quote_char)
                .ok_or_else(|| "unclosed quoted string".to_owned())?;
            tokens.push(Token::Operand(Operand::Lit(
                expression[cursor + 1..cursor + 1 + close].to_owned(),
            )));
            cursor += close + 2;
            continue;
        }
        // 裸词读到下一空白（find 返回相对偏移，落回绝对位置）
        let end = expression[cursor..]
            .find(char::is_whitespace)
            .map(|offset| cursor + offset)
            .unwrap_or(expression.len());
        let word = &expression[cursor..end];
        cursor = end;
        tokens.push(match parse_operator(word) {
            Some(op) => Token::Operator(op),
            None => Token::Operand(Operand::Lit(word.to_owned())),
        });
    }
    if tokens.is_empty() {
        return Err("empty expression".to_owned());
    }
    Ok(tokens)
}

/// 操作数取值：变量引用按解析闭包取值（缺失 = Missing），字面量恒文本。
fn operand_value(operand: &Operand, resolve: &dyn Fn(&str) -> Option<String>) -> OperandValue {
    match operand {
        Operand::Var(key) => resolve(key)
            .map(OperandValue::Text)
            .unwrap_or(OperandValue::Missing),
        Operand::Lit(text) => OperandValue::Text(text.clone()),
    }
}

fn evaluate_binary(
    left: &Token,
    op: &Operator,
    right: &Token,
    resolve: &dyn Fn(&str) -> Option<String>,
) -> Result<bool, String> {
    let (left, right) = match (left, right) {
        (Token::Operand(left), Token::Operand(right)) => (left, right),
        _ => return Err("binary operator requires two operands".to_owned()),
    };
    let left = operand_value(left, resolve);
    let right = operand_value(right, resolve);
    let result = match op {
        Operator::Eq => left == right,
        Operator::Ne => left != right,
        // 缺失参与序比较与文本谓词一律不满足（不可比较即判否，不另设错误通道）
        Operator::Gt | Operator::Ge | Operator::Lt | Operator::Le => {
            both_text(&left, &right) && compare_ordered(left.text(), right.text(), op)
        }
        Operator::Contains => both_text(&left, &right) && left.text().contains(right.text()),
        Operator::StartsWith => both_text(&left, &right) && left.text().starts_with(right.text()),
        Operator::EndsWith => both_text(&left, &right) && left.text().ends_with(right.text()),
        Operator::Exists | Operator::IsEmpty => {
            return Err("unary operator requires a single operand".to_owned());
        }
    };
    Ok(result)
}

/// 两侧取值均为文本（序比较与文本谓词的缺失守卫）。
fn both_text(left: &OperandValue, right: &OperandValue) -> bool {
    matches!(left, OperandValue::Text(_)) && matches!(right, OperandValue::Text(_))
}

/// 序比较：两侧先尝试数值化（f64）比较——`100 > 20` 按数值成立；
/// 任一侧非数字回落字典序（纯文本比较面）。
fn compare_ordered(left: &str, right: &str, op: &Operator) -> bool {
    match (left.parse::<f64>(), right.parse::<f64>()) {
        (Ok(lhs), Ok(rhs)) => match op {
            Operator::Gt => lhs > rhs,
            Operator::Ge => lhs >= rhs,
            Operator::Lt => lhs < rhs,
            Operator::Le => lhs <= rhs,
            _ => false,
        },
        _ => match op {
            Operator::Gt => left > right,
            Operator::Ge => left >= right,
            Operator::Lt => left < right,
            Operator::Le => left <= right,
            _ => false,
        },
    }
}

fn evaluate_unary(
    operand: &Token,
    op: &Operator,
    resolve: &dyn Fn(&str) -> Option<String>,
) -> Result<bool, String> {
    let operand = match operand {
        Token::Operand(operand) => operand,
        _ => return Err("unary operator requires a single operand".to_owned()),
    };
    let result = match operand {
        // 字面量恒存在；isEmpty 对字面量按原文文本判定
        Operand::Lit(text) => match op {
            Operator::Exists => true,
            Operator::IsEmpty => text.is_empty(),
            _ => return Err("unary operator requires `exists` or `isEmpty`".to_owned()),
        },
        Operand::Var(key) => match resolve(key) {
            Some(value) => match op {
                Operator::Exists => true,
                Operator::IsEmpty => value.is_empty(),
                _ => return Err("unary operator requires `exists` or `isEmpty`".to_owned()),
            },
            None => match op {
                Operator::Exists => false,
                // 缺失即无值即空
                Operator::IsEmpty => true,
                _ => return Err("unary operator requires `exists` or `isEmpty`".to_owned()),
            },
        },
    };
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 变量表构造器（None 值 = 缺失变量）。
    fn make_vars(pairs: &[(&str, Option<&str>)]) -> impl Fn(&str) -> Option<String> {
        let table: std::collections::HashMap<&str, Option<String>> = pairs
            .iter()
            .map(|(key, value)| (*key, value.map(str::to_owned)))
            .collect();
        move |key: &str| table.get(key).cloned().flatten()
    }

    fn eval(expression: &str, resolve: &dyn Fn(&str) -> Option<String>) -> bool {
        evaluate_expression(expression, resolve).unwrap_or_else(|err| panic!("{expression}: {err}"))
    }

    fn eval_err(expression: &str, resolve: &dyn Fn(&str) -> Option<String>) -> String {
        evaluate_expression(expression, resolve).expect_err("表达式应解析失败")
    }

    #[test]
    fn equality_operators_compare_as_text_with_numeric_tolerance() {
        let vars = make_vars(&[("status", Some("200")), ("token", Some("abc"))]);
        // 数字字面量文本化即匹配（数字 / 字符串 / 布尔统一文本口径）
        assert!(eval("{{status}} == 200", &vars));
        assert!(eval("{{status}} == \"200\"", &vars));
        assert!(eval("{{status}} != 404", &vars));
        assert!(eval("{{token}} == abc", &vars));
        assert!(eval("{{token}} == 'abc'", &vars));
        assert!(!eval("{{token}} == abx", &vars));
        assert!(eval("{{token}} != abx", &vars));
        // 双缺失 == 成立（同值态）；缺失 != 文本成立
        let none = make_vars(&[]);
        assert!(eval("{{absent}} == {{also-absent}}", &none));
        assert!(eval("{{absent}} != x", &none));
        assert!(!eval("{{absent}} == x", &none));
    }

    #[test]
    fn boolean_and_bare_word_literals_compare_as_text() {
        let vars = make_vars(&[("success", Some("true")), ("mode", Some("fast"))]);
        assert!(eval("{{success}} == true", &vars));
        assert!(eval("{{success}} == \"true\"", &vars));
        assert!(eval("{{mode}} == fast", &vars));
        assert!(eval("{{mode}} != slow", &vars));
    }

    #[test]
    fn ordered_operators_prefer_numeric_then_lexicographic() {
        let vars = make_vars(&[("count", Some("100")), ("word", Some("abc"))]);
        assert!(eval("{{count}} > 20", &vars), "数值比较而非字典序");
        assert!(eval("{{count}} >= 100", &vars));
        assert!(eval("{{count}} < 101", &vars));
        assert!(eval("{{count}} <= 100", &vars));
        // 非数字回落字典序
        assert!(!eval("{{word}} > abc", &vars), "同词序比较不成立");
        assert!(eval("{{word}} > ab", &vars));
        assert!(eval("{{word}} < ad", &vars));
        // 缺失参与序比较不满足
        let none = make_vars(&[]);
        assert!(!eval("{{absent}} > 1", &none));
        assert!(!eval("{{absent}} < 1", &none));
    }

    #[test]
    fn string_predicate_operators_work_on_text() {
        let vars = make_vars(&[("token", Some("Bearer abc123"))]);
        assert!(eval("{{token}} contains abc", &vars));
        assert!(eval("{{token}} startsWith Bearer", &vars));
        assert!(eval("{{token}} endsWith 123", &vars));
        assert!(!eval("{{token}} startsWith bearer", &vars), "大小写敏感");
        assert!(!eval("{{token}} contains zzz", &vars));
        // 缺失参与文本谓词不满足
        let none = make_vars(&[]);
        assert!(!eval("{{absent}} contains a", &none));
    }

    #[test]
    fn unary_operators_judge_presence_and_emptiness() {
        let vars = make_vars(&[("token", Some("t")), ("blank", Some("")), ("absent", None)]);
        assert!(eval("{{token}} exists", &vars));
        assert!(!eval("{{absent}} exists", &vars));
        assert!(eval("{{blank}} exists", &vars), "空串值仍是存在");
        assert!(eval("{{blank}} isEmpty", &vars));
        assert!(eval("{{absent}} isEmpty", &vars), "缺失即无值即空");
        assert!(!eval("{{token}} isEmpty", &vars));
        // 字面量：恒存在；引号空串即空
        assert!(eval("\"anything\" exists", &vars));
        assert!(eval("\"\" isEmpty", &vars));
        assert!(!eval("\"x\" isEmpty", &vars));
    }

    #[test]
    fn variable_references_resolve_without_whitespace_inside() {
        let vars = make_vars(&[("login_status", Some("200"))]);
        assert!(eval("{{login_status}} == 200", &vars));
    }

    #[test]
    fn malformed_expressions_fail_with_reasons() {
        let vars = make_vars(&[("a", Some("1"))]);
        // 未闭合变量引用 / 引号
        assert!(eval_err("{{a == 200", &vars).contains("unclosed variable"));
        assert!(eval_err("{{}} == 200", &vars).contains("empty variable"));
        assert!(eval_err("{{a}} == \"200", &vars).contains("unclosed quoted"));
        // 结构不完整 / 操作符未知
        assert!(eval_err("{{a}} ==", &vars).contains("expected"));
        assert!(eval_err("{{a}}", &vars).contains("expected"));
        assert!(eval_err("", &vars).contains("empty expression"));
        assert!(eval_err("{{a}} ~~ 1", &vars).contains("expected"));
        // 一元操作符带两个操作数、二元残缺为两词元，各自报结构错误
        assert!(eval_err("{{a}} exists 1", &vars).contains("unary operator"));
        assert!(eval_err("{{a}} contains", &vars).contains("expected"));
    }

    #[test]
    fn branch_sequence_short_circuits_on_first_truth() {
        let branches = |list: &[(&str, &str)]| {
            list.iter()
                .map(|(id, expression)| ConditionBranch {
                    id: (*id).to_owned(),
                    expression: (*expression).to_owned(),
                })
                .collect::<Vec<_>>()
        };
        let vars = make_vars(&[("status", Some("500"))]);

        // 首个真值分支命中；后续分支不求值（坏表达式不被触达）
        let outcome = evaluate_branches(
            &branches(&[
                ("b1", "{{status}} == 200"),
                ("b2", "{{status}} >= 500"),
                ("b3", "broken expression ~~"),
            ]),
            &vars,
        )
        .unwrap();
        assert_eq!(
            outcome,
            ConditionOutcome {
                branch_id: Some("b2".to_owned()),
                expression: "{{status}} >= 500".to_owned(),
                result: true,
            }
        );

        // 全不满足 = Default
        let outcome = evaluate_branches(&branches(&[("b1", "{{status}} == 200")]), &vars).unwrap();
        assert_eq!(
            outcome,
            ConditionOutcome {
                branch_id: None,
                expression: String::new(),
                result: false,
            }
        );

        // 空分支序列 = Default
        let outcome = evaluate_branches(&[], &vars).unwrap();
        assert_eq!(outcome.branch_id, None);
    }
}
