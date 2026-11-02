//! 敏感值脱敏纯函数（CLI 输出面，变量域可复用）：
//! 标准 HTTP 敏感头名单＋值掩码。名单不区分大小写；params 不脱敏
//! （查询参数非机密语义）。敏感值不入日志。

/// 标准 HTTP 敏感头名单（匹配不区分大小写、忽略大小写变体）：
/// 凭证 / 会话 / 代理凭证 / API 密钥 / CSRF 令牌。
pub const SENSITIVE_HEADER_NAMES: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api-key",
    "x-auth-token",
    "x-csrf-token",
    "x-xsrf-token",
];

/// 敏感 JSON 键名单（断言实际值 / 提取产物的名单式掩码口径）：响应体中
/// 凭证类载体的常见键名。匹配前键名先归一（ASCII 小写、剔除 `-` / `_` /
/// 空白分隔符——`accessToken` / `access_token` / `access-token` 同判），
/// 与归一后名单精确比对（`token_count` 等相邻词不误伤，保住非敏感值的
/// 诊断可见性）。
pub const SENSITIVE_KEY_NAMES: &[&str] = &[
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "password",
    "secret",
    "api_key",
];

/// 脱敏掩码（定值：不回显任何原始内容片段）。
pub const MASK: &str = "***";

/// 判定 header 名是否命中敏感名单（ASCII 大小写不敏感；前后空白截除）。
pub fn is_sensitive_header(name: &str) -> bool {
    let normalized = name.trim().to_ascii_lowercase();
    SENSITIVE_HEADER_NAMES.contains(&normalized.as_str())
}

/// 键名归一（敏感键判定的输入面）：截除前后空白、ASCII 小写、剔除
/// `-` / `_` / 空白分隔符，使 camelCase / snake_case / kebab-case 变体同判。
fn normalize_key(name: &str) -> String {
    name.trim()
        .chars()
        .filter(|c| !matches!(c, '-' | '_' | ' '))
        .flat_map(char::to_lowercase)
        .collect()
}

/// 判定 JSON 键名是否命中敏感名单（断言实际值 / 提取产物的名单式掩码
/// 判定）：敏感键名单命中，或敏感头名单命中（`authorization` 等凭证词
/// 作键名出现时同判）——键级口径与头级名单同源，不另立标准。
pub fn is_sensitive_key(name: &str) -> bool {
    let normalized = normalize_key(name);
    SENSITIVE_KEY_NAMES
        .iter()
        .chain(SENSITIVE_HEADER_NAMES.iter())
        .any(|candidate| normalize_key(candidate) == normalized)
}

/// 取值的敏感判定单点（断言实际值 / 提取产物摘要的名单式投影口径）：
/// 键名命中敏感名单，或取值文本命中本次执行的 Secret 消费清单，任一
/// 命中即敏感。空 Secret 值不入判定（空串模式会在每个字符边界误命中，
/// 与 [`mask_secret_values_in`] 的替换守卫同一纪律）。
///
/// 判定单点、粒度分面：断言「期望 vs 实际」对比面对回显命中做片段替换
/// （[`mask_secret_values_in`]，保留非敏感前后文）；提取产物摘要面命中
/// 即整值掩码（[`MASK`]，摘要不回显任何原始内容片段）。两消费面共用本
/// 判定，口径演进不漂移。
pub fn is_sensitive_value(key: Option<&str>, value: &str, secret_values: &[String]) -> bool {
    key.is_some_and(is_sensitive_key)
        || secret_values
            .iter()
            .any(|secret| !secret.is_empty() && value.contains(secret))
}

/// 错误信息 / 记录摘要内嵌的响应体前缀长度（诊断面有界）。
const BODY_EXCERPT_CHARS: usize = 200;

/// Secret 值全文替换（写时掩码核）：命中值逐个替换为掩码（空值跳过——
/// 空串模式会在每个字符边界误命中）。执行记录等无放行通道的落笔面用
/// 此核；CLI 读时掩码（`--show-secrets` 放行）在消费层包装。
pub fn mask_secret_values_in(text: &str, values: &[String]) -> String {
    if values.is_empty() {
        return text.to_string();
    }
    let mut out = text.to_string();
    for value in values {
        if !value.is_empty() {
            out = out.replace(value.as_str(), MASK);
        }
    }
    out
}

/// 响应体文本的掩码摘要：合法 JSON 保留结构——对象键名、数字、布尔、null
/// 原样（路径写错的诊断依据是键名），字符串值一律掩码（响应体是潜在敏感
/// 载体，明文不进呈现面）；非 JSON 文本无结构可保，整体掩码为体量摘要。
/// 摘要前缀截断（[`BODY_EXCERPT_CHARS`]）。
pub fn masked_body_excerpt(body_text: &str) -> String {
    let trimmed = body_text.trim();
    let excerpt = if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        serde_json::to_string(&masked_json_string_values(&value))
            .unwrap_or_else(|_| MASK.to_owned())
    } else {
        format!("(non-JSON text, {} chars)", trimmed.chars().count())
    };
    if excerpt.chars().count() <= BODY_EXCERPT_CHARS {
        excerpt
    } else {
        excerpt.chars().take(BODY_EXCERPT_CHARS).collect()
    }
}

/// JSON 值投影：字符串字面量 → 掩码，结构与标量保留（掩码摘要的递归面）。
fn masked_json_string_values(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::String(_) => serde_json::Value::String(MASK.to_owned()),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(masked_json_string_values).collect())
        }
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(key, inner)| (key.clone(), masked_json_string_values(inner)))
                .collect(),
        ),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_case_insensitively_and_trims() {
        for name in [
            "Authorization",
            "authorization",
            "AUTHORIZATION",
            "  Cookie  ",
            "Set-Cookie",
            "x-api-key",
        ] {
            assert!(is_sensitive_header(name), "{name}");
        }
        for name in [
            "accept",
            "Content-Type",
            "X-Custom-Header",
            "user-agent",
            "",
        ] {
            assert!(!is_sensitive_header(name), "{name}");
        }
    }

    /// 敏感键判定：键名单与头名单同源命中、分隔符归一变体同判、相邻词
    /// 不误伤（非敏感键保持明文的诊断可见性）。
    #[test]
    fn sensitive_key_judgment_covers_variants_without_false_hits() {
        for name in [
            "token",
            "Token",
            "access_token",
            "accessToken",
            "access-token",
            "refreshToken",
            "password",
            "Password",
            "secret",
            "api_key",
            "apiKey",
            // 头名单凭证词作键名（复用名单同源）
            "authorization",
            "x-api-key",
        ] {
            assert!(is_sensitive_key(name), "{name} 应命中敏感键名单");
        }
        for name in [
            "success",
            "message",
            "user",
            "token_count",
            "tokens",
            "secretive",
            "password_hint",
            "",
        ] {
            assert!(!is_sensitive_key(name), "{name} 不应误伤");
        }
    }

    /// 取值敏感判定单点：键名命中、回显命中、双未命中明文、空 Secret 值
    /// 不误命中（断言 / 提取两消费面共用的判定契约）。
    #[test]
    fn sensitive_value_judgment_unifies_key_list_and_secret_echo() {
        let secrets = vec!["sk-live-123".to_owned(), "另一值".to_owned()];
        // 键名命中：值内容无关（键名即敏感语义）
        assert!(is_sensitive_value(Some("token"), "plain-text", &secrets));
        assert!(is_sensitive_value(Some("accessToken"), "anything", &[]));
        // 键名未命中、回显命中：取值文本含 Secret 消费值
        assert!(is_sensitive_value(
            Some("note"),
            "Bearer sk-live-123",
            &secrets
        ));
        // 双未命中：明文
        assert!(!is_sensitive_value(Some("note"), "plain text", &secrets));
        assert!(!is_sensitive_value(Some("count"), "3", &secrets));
        assert!(!is_sensitive_value(None, "sk-live-123", &[]));
        // 空 Secret 值不入判定（空串模式会逐字符误命中）
        assert!(!is_sensitive_value(Some("note"), "x", &[String::new()]));
        // 部分匹配也算命中（消费值可能内嵌于更大文本）
        assert!(is_sensitive_value(
            Some("note"),
            "prefix-另一值-suffix",
            &secrets
        ));
    }

    #[test]
    fn mask_is_total() {
        assert_eq!(MASK, "***");
    }

    /// 错误摘要掩码口径：JSON 结构（键名 / 数字）可见、字符串值掩码、
    /// 非 JSON 整体摘要——诊断价值与敏感口径并存。
    #[test]
    fn masked_body_excerpt_keeps_structure_masks_values() {
        let masked = masked_body_excerpt(r#"{"data":{"token":"secret-value","n":1}}"#);
        assert!(masked.contains("\"data\""), "键名可见: {masked}");
        assert!(masked.contains("\"token\""), "键名可见: {masked}");
        assert!(masked.contains("1"), "数字可见: {masked}");
        assert!(
            !masked.contains("secret-value"),
            "字符串值必须掩码: {masked}"
        );
        assert!(masked.contains(MASK));
        let non_json = masked_body_excerpt("plain text body");
        assert!(
            non_json.contains("non-JSON"),
            "非 JSON 摘要为体量说明: {non_json}"
        );
        assert!(
            !non_json.contains("plain"),
            "非 JSON 文本不回显: {non_json}"
        );
    }

    /// Secret 值全文替换（写时掩码核）：多值逐个替换、空值跳过、
    /// 无值时原样返回。
    #[test]
    fn mask_secret_values_in_replaces_each_value() {
        let masked = mask_secret_values_in(
            "Bearer abc / q?token=xyz",
            &["abc".to_owned(), "xyz".to_owned()],
        );
        assert_eq!(masked, "Bearer *** / q?token=***");
        assert_eq!(mask_secret_values_in("plain", &[]), "plain");
        assert_eq!(
            mask_secret_values_in("a-empty", &[String::new()]),
            "a-empty",
            "空值跳过（空串模式会逐字符误命中）"
        );
    }

    /// 脱敏契约夹具（`src/test/fixtures/redact-contract.json`，与前端
    /// features/http 测试共享同一份表）——任一端改名单另一端立红。
    /// 名单演进通道：先改夹具（双端测试同红）再双端内化；单边改任一端
    /// 内化名单，该端立红（本地验证：从本名单临时删一项，本测试红而
    /// 前端测试仍绿，即暴露单边漂移；只改夹具名单，双端测试同红）。
    #[test]
    fn redact_contract_fixture_pinned() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Fixture {
            sensitive_header_names: Vec<String>,
            header_cases: Vec<HeaderCase>,
        }
        #[derive(serde::Deserialize)]
        struct HeaderCase {
            name: String,
            sensitive: bool,
        }
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../src/test/fixtures/redact-contract.json"
        ))
        .expect("redact contract fixture must parse");

        // 名单一致（排序比较：成员是契约，顺序不是）
        let mut mine: Vec<&str> = SENSITIVE_HEADER_NAMES.to_vec();
        let mut theirs: Vec<&str> = fixture
            .sensitive_header_names
            .iter()
            .map(String::as_str)
            .collect();
        mine.sort_unstable();
        theirs.sort_unstable();
        assert_eq!(mine, theirs, "敏感头名单与夹具漂移：须先改夹具再双端内化");

        // 头名判定用例：大小写异形命中、相似非名单名（如 apikey）不误伤
        assert!(!fixture.header_cases.is_empty(), "夹具须含头名用例");
        for case in &fixture.header_cases {
            assert_eq!(
                is_sensitive_header(&case.name),
                case.sensitive,
                "header={}",
                case.name
            );
        }
    }
}
