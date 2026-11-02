//! 服务批量导入应用服务（Swashbuckle 入口页发现）：
//!
//! - 发现（`import_discover`）：入口页地址（相对工作空间 BaseUrl 或完整
//!   URL）→ reqwest 拉取 HTML → 收窄解析 Swashbuckle index 页注入的配置
//!   → 分组清单（分组名 + 文档绝对地址），不建服务。
//! - 落库（`import_create`）：勾选分组 → 单事务逐条建服务；导入服务必有
//!   文档地址，与现有服务重名自动追加序号（用户强行勾选重名分组的消歧）。
//!
//! 解析收窄原则：Swashbuckle（Swashbuckle.AspNetCore 5/6）注入 index.html
//! 的是 JSON 序列化文本（键恒带引号），故只认三种带引号键形态——
//! `"urls": [{url, name}]` 分组数组、`"configUrl": "..."` 独立配置页
//! （二次拉取 JSON）、顶格 `"url"` + `"name"` 单分组；其余（手写
//! swagger-ui dist、非引号 JS 字面量）显式拒绝（IMPORT_PAGE_UNRECOGNIZED），
//! 宁可拒绝不猜错。导入只建服务记录，接口入树归同步域后续交付。

use std::collections::HashSet;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::constants::MAX_BASE_URL_BYTES;
use crate::domain::endpoint::new_manual_identity;
use crate::domain::service::{DOC_TYPE_OPENAPI, NewService, Service};
use crate::domain::url::{resolve_document_url, resolve_entry_url};
use crate::domain::validate::normalize_name;
use crate::error::AppError;
use crate::error::codes;
use crate::infrastructure::{service_repo, workspace_repo};
use crate::services::service::{ServiceDto, to_dto};

/// 入口页 / 配置页拉取超时与重定向上限（发现是用户等待的即时动作，
/// 独立短命 Client；同步域探测链路的超时常量归同步域，此处不复用）。
const FETCH_TIMEOUT_MS: u64 = 10_000;
const FETCH_REDIRECT_LIMIT: usize = 5;

/// 单次批量导入条数上限（有界护栏：防误传巨型数组撑爆事务）。
const MAX_IMPORT_BATCH: usize = 50;

/// 发现分组：Swagger UI 分组名 + 文档绝对地址。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportGroupDto {
    pub name: String,
    pub doc_url: String,
}

/// service.import_discover 返回：补全后的入口页绝对地址（回显）+ 分组清单。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDiscoverDto {
    pub entry_url: String,
    pub groups: Vec<ImportGroupDto>,
}

/// service.import_create 输入项（文档地址必填：导入服务必有文档地址，
/// 无地址的纯手工容器只能手工新建）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportServiceInput {
    pub name: String,
    pub doc_url: String,
}

// —— 发现链路 ——

/// 拉取入口页并解析分组：不建任何服务、无副作用。
pub async fn discover(
    pool: &SqlitePool,
    workspace_id: &str,
    entry_url: &str,
) -> Result<ImportDiscoverDto, AppError> {
    let workspace = workspace_repo::get(pool, workspace_id)
        .await?
        .ok_or_else(|| {
            AppError::new(
                codes::WORKSPACE_NOT_FOUND,
                format!("workspace not found: {workspace_id}"),
            )
        })?;
    let entry_url = resolve_entry_url(entry_url, workspace.base_url.as_deref())?;
    let html = fetch_text(&entry_url).await?;
    let mut pairs = match parse_swashbuckle_index(&html) {
        Some(IndexParseOutcome::Groups(pairs)) => pairs,
        Some(IndexParseOutcome::ConfigUrl(config_url)) => {
            // 配置页是独立 JSON（swagger-config.json 形态）：二次拉取后解析其 urls
            let config_abs = resolve_document_url(&entry_url, &config_url)?;
            let config_json = fetch_text(&config_abs).await?;
            extract_urls_array(&config_json).ok_or_else(|| {
                AppError::new(
                    codes::IMPORT_PAGE_UNRECOGNIZED,
                    "config page has no urls array",
                )
            })?
        }
        None => {
            // 入口页不是 Swashbuckle 索引：回退按 OpenAPI/Swagger 文档 JSON
            // 直读——入口地址本身即文档（单分组导入，分组名取 info.title）；
            // 两者皆非才报未识别（引导改走「新建服务＋同步拉取」）
            match detect_openapi_document(&html) {
                Some(title) => vec![(title, entry_url.clone())],
                None => {
                    return Err(AppError::new(
                        codes::IMPORT_PAGE_UNRECOGNIZED,
                        "entry is neither a swagger UI index page nor an OpenAPI document; \
                         create the service manually and use sync fetch instead",
                    ));
                }
            }
        }
    };
    if pairs.is_empty() {
        return Err(AppError::new(
            codes::IMPORT_PAGE_UNRECOGNIZED,
            "entry page declares no swagger groups",
        ));
    }
    let groups = pairs
        .drain(..)
        .map(|(name, doc_url)| {
            let doc_url = resolve_document_url(&entry_url, &doc_url)?;
            Ok::<ImportGroupDto, AppError>(ImportGroupDto {
                name: name.unwrap_or_else(|| default_group_name(&doc_url)),
                doc_url,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ImportDiscoverDto { entry_url, groups })
}

/// 批量建服务：单事务逐条插入；与现有服务或本批已建名重名时追加
/// 「 (n)」序号消歧；任一条失败整体回滚（批量导入不产半批）。
pub async fn import_create(
    pool: &SqlitePool,
    workspace_id: &str,
    inputs: Vec<ImportServiceInput>,
) -> Result<Vec<ServiceDto>, AppError> {
    workspace_repo::get(pool, workspace_id)
        .await?
        .ok_or_else(|| {
            AppError::new(
                codes::WORKSPACE_NOT_FOUND,
                format!("workspace not found: {workspace_id}"),
            )
        })?;
    if inputs.is_empty() {
        return Err(AppError::new(
            codes::INVALID_ARGUMENT,
            "import batch is empty",
        ));
    }
    if inputs.len() > MAX_IMPORT_BATCH {
        return Err(AppError::new(
            codes::INVALID_ARGUMENT,
            format!("import batch exceeds {MAX_IMPORT_BATCH} items"),
        ));
    }

    let mut tx = pool.begin().await?;
    // 重名消歧的比对基线：库内现有名 + 本批已用名（事务内读，批内一致）
    let mut used: HashSet<String> = service_repo::list_by_workspace(&mut *tx, workspace_id)
        .await?
        .into_iter()
        .map(|service| service.name)
        .collect();
    let mut created = Vec::with_capacity(inputs.len());
    for input in inputs {
        let name = dedupe_name(normalize_name(&input.name)?, &used);
        let doc_url = normalize_doc_url(&input.doc_url)?;
        let service: Service = service_repo::insert(
            &mut *tx,
            &NewService {
                id: new_manual_identity(),
                workspace_id: workspace_id.to_owned(),
                name: name.clone(),
                doc_url: Some(doc_url),
                doc_type: DOC_TYPE_OPENAPI.to_owned(),
            },
        )
        .await?;
        used.insert(name);
        created.push(to_dto(service));
    }
    tx.commit().await?;
    Ok(created)
}

/// 导入服务文档地址规范化：trim 非空（必有）+ 长度上限（与 BaseUrl 同限）。
fn normalize_doc_url(raw: &str) -> Result<String, AppError> {
    let url = raw.trim();
    if url.is_empty() {
        return Err(AppError::new(
            codes::URL_INVALID,
            "import doc url must not be empty",
        ));
    }
    if url.len() > MAX_BASE_URL_BYTES {
        return Err(AppError::new(
            codes::URL_INVALID,
            format!("import doc url exceeds {MAX_BASE_URL_BYTES} bytes"),
        ));
    }
    Ok(url.to_owned())
}

/// 重名消歧：撞车时追加「 (2)」「 (3)」…直至不撞（用户强行勾选重名分组的
/// 既定语义；序号从 2 起取首个空位，批内多次消歧结果稳定可预期）。
fn dedupe_name(name: String, used: &HashSet<String>) -> String {
    if !used.contains(&name) {
        return name;
    }
    for n in 2.. {
        let candidate = format!("{name} ({n})");
        if !used.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!("used is finite, some counter must miss")
}

// —— 入口页 / 配置页拉取（网络薄封装，单测不覆盖；解析纯函数独立可测） ——

async fn fetch_text(url: &str) -> Result<String, AppError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(FETCH_TIMEOUT_MS))
        .redirect(reqwest::redirect::Policy::limited(FETCH_REDIRECT_LIMIT))
        .build()
        .map_err(|err| AppError::internal(format!("reqwest client build failed: {err}")))?;
    let response =
        client.get(url).send().await.map_err(|err| {
            AppError::new(codes::IMPORT_FETCH_FAILED, format!("fetch failed: {err}"))
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::new(
            codes::IMPORT_FETCH_FAILED,
            format!("fetch returned {status}"),
        ));
    }
    response.text().await.map_err(|err| {
        AppError::new(
            codes::IMPORT_FETCH_FAILED,
            format!("read body failed: {err}"),
        )
    })
}

// —— 解析纯函数 ——

/// 入口页解析结果（None＝未识别形态，显式拒绝）。
#[derive(Debug, PartialEq, Eq)]
enum IndexParseOutcome {
    /// 分组数组（name 可缺省：Swashbuckle 单分组顶格形态不带 name 时由调用方推导）
    Groups(Vec<(Option<String>, String)>),
    /// 独立配置页地址（需二次拉取 JSON）
    ConfigUrl(String),
}

/// 收窄解析 Swashbuckle index 页：优先找 `"urls"` 分组数组，其次
/// `"configUrl"`，最后顶格 `"url"`（+ 可选 `"name"`）。三者皆无＝None。
fn parse_swashbuckle_index(html: &str) -> Option<IndexParseOutcome> {
    if let Some(pairs) = extract_urls_array(html) {
        return Some(IndexParseOutcome::Groups(pairs));
    }
    if let Some(config_url) = read_json_string(html, "configUrl") {
        return Some(IndexParseOutcome::ConfigUrl(config_url));
    }
    if let Some(url) = read_json_string(html, "url") {
        let name = read_json_string(html, "name");
        return Some(IndexParseOutcome::Groups(vec![(name, url)]));
    }
    None
}

/// 提取 `"urls": [ ... ]` 数组：括号配对截取子串（字符串感知，跳过
/// `"..."` 内的括号与转义）后按 JSON 解析，每项取 url（缺 url 项丢弃）。
fn extract_urls_array(html: &str) -> Option<Vec<(Option<String>, String)>> {
    let start = find_key(html, "urls")?;
    let colon = skip_ws_then(html, start, b':')?;
    let open = skip_ws(html, colon + 1);
    if html.as_bytes().get(open) != Some(&b'[') {
        return None;
    }
    let close = match_bracket(html, open)?;
    let value: serde_json::Value = serde_json::from_str(&html[open..=close]).ok()?;
    let array = value.as_array()?;
    let pairs = array
        .iter()
        .filter_map(|item| {
            let url = item.get("url")?.as_str()?.trim().to_owned();
            if url.is_empty() {
                return None;
            }
            let name = item
                .get("name")
                .and_then(|n| n.as_str())
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .map(str::to_owned);
            Some((name, url))
        })
        .collect::<Vec<_>>();
    Some(pairs)
}

/// 读 `"key": "value"` 形态的 JSON 字符串值（引号内转义按 JSON 规则还原）。
fn read_json_string(html: &str, key: &str) -> Option<String> {
    let start = find_key(html, key)?;
    let colon = skip_ws_then(html, start, b':')?;
    let bytes = html.as_bytes();
    let mut i = colon + 1;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if bytes.get(i) != Some(&b'"') {
        return None;
    }
    // 扫描闭合引号（处理转义）截出完整 JSON 字符串子串，经 serde 还原转义
    let mut j = i + 1;
    while j < bytes.len() {
        match bytes[j] {
            b'\\' => j += 2,
            b'"' => {
                let parsed: serde_json::Value = serde_json::from_str(&html[i..=j]).ok()?;
                return parsed.as_str().map(str::to_owned);
            }
            _ => j += 1,
        }
    }
    None
}

/// 找 `"key"` 字面量（完整含引号），返回闭合引号后一字符的位置。
/// `"url"` 与 `"urls"` 天然互斥（闭合引号参与匹配）。
fn find_key(html: &str, key: &str) -> Option<usize> {
    let needle = format!("\"{key}\"");
    html.find(&needle).map(|pos| pos + needle.len())
}

/// 从 `pos` 起跳过空白后校验指定字符，返回其位置（值形态分派用）。
fn skip_ws_then(html: &str, pos: usize, expected: u8) -> Option<usize> {
    let bytes = html.as_bytes();
    let mut i = pos;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    (bytes.get(i) == Some(&expected)).then_some(i)
}

/// 从 `pos` 起跳过全部 ASCII 空白，返回停下的位置。
fn skip_ws(html: &str, pos: usize) -> usize {
    let bytes = html.as_bytes();
    let mut i = pos;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// 从 `[` 起做字符串感知的括号配对，返回匹配的 `]` 位置。
fn match_bracket(html: &str, open: usize) -> Option<usize> {
    let bytes = html.as_bytes();
    let mut depth = 0usize;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                // 字符串字面量整体跳过（处理转义）
                i += 1;
                while i < bytes.len() {
                    match bytes[i] {
                        b'\\' => i += 2,
                        b'"' => break,
                        _ => i += 1,
                    }
                }
            }
            b'[' | b'{' => depth += 1,
            b']' | b'}' => {
                depth -= 1;
                if depth == 0 {
                    return (bytes[i] == b']').then_some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// 入口内容本身即 OpenAPI/Swagger 文档的宽松判定：JSON 对象带 `openapi`
/// 或 `swagger` 版本字段即视作文档（真实结构校验在同步拉取链路）；命中
/// 返回 `info.title`（缺省 None→由分组名推导兜底），非文档返回 None。
fn detect_openapi_document(text: &str) -> Option<Option<String>> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let obj = value.as_object()?;
    if !obj.contains_key("openapi") && !obj.contains_key("swagger") {
        return None;
    }
    let title = obj
        .get("info")
        .and_then(|info| info.get("title"))
        .and_then(|title| title.as_str())
        .map(str::to_owned);
    Some(title)
}

/// 分组缺省名推导：`/swagger/v1/swagger.json` 形态取文档名段（v1）；
/// 其余取末段去扩展；都取不到用 "swagger"。
fn default_group_name(doc_url: &str) -> String {
    if let Some(rest) = doc_url.split_once("://").map(|(_, r)| r)
        && let Some(segments) = rest.split("/swagger/").nth(1)
    {
        // 形如 v1/swagger.json：取文档名段
        if let Some(first) = segments.split('/').next().filter(|s| !s.is_empty()) {
            return first.to_owned();
        }
    }
    let last = doc_url.rsplit('/').next().unwrap_or("");
    let stem = last.split('.').next().unwrap_or("");
    if stem.is_empty() {
        "swagger".to_owned()
    } else {
        stem.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::infrastructure::workspace_repo::test_support as ws_support;

    // —— 解析纯函数 ——

    /// Swashbuckle 6.x 实际注入形态：单行 JSON 配置、urls 分组数组
    #[test]
    fn parse_reads_urls_array_from_single_line_config() {
        let html = r##"
            <script>
            window.onload = function () {
              const config = {"dom_id":"#swagger-ui","deepLinking":true,"layout":"StandaloneLayout","urls":[{"url":"/swagger/v1/swagger.json","name":"V1"},{"url":"/swagger/admin/swagger.json","name":"Admin API"}]};
              window.ui = SwaggerUIBundle(config)
            }
            </script>
        "##;
        assert_eq!(
            parse_swashbuckle_index(html),
            Some(IndexParseOutcome::Groups(vec![
                (Some("V1".into()), "/swagger/v1/swagger.json".into()),
                (
                    Some("Admin API".into()),
                    "/swagger/admin/swagger.json".into()
                ),
            ]))
        );
    }

    /// 多行 pretty JSON（部分版本 / 中间件改写形态）
    #[test]
    fn parse_reads_pretty_printed_urls_array() {
        let html = r##"
            const ui = SwaggerUIBundle({
              "dom_id": "#swagger-ui",
              "urls": [
                { "url": "/swagger/v1/swagger.json",
                  "name": "V1" },
                { "url": "/swagger/v2/swagger.json",
                  "name": "V2" }
              ],
            })
        "##;
        assert_eq!(
            parse_swashbuckle_index(html),
            Some(IndexParseOutcome::Groups(vec![
                (Some("V1".into()), "/swagger/v1/swagger.json".into()),
                (Some("V2".into()), "/swagger/v2/swagger.json".into()),
            ]))
        );
    }

    /// configUrl 形态：入口页只指路，配置在独立 JSON（二次拉取）
    #[test]
    fn parse_reads_config_url_form() {
        let html = r##"
            <script>
              const config = {"configUrl":"/swagger/v1/swagger-config.json"};
            </script>
        "##;
        assert_eq!(
            parse_swashbuckle_index(html),
            Some(IndexParseOutcome::ConfigUrl(
                "/swagger/v1/swagger-config.json".into()
            ))
        );
    }

    /// 顶格 url 单分组（`"url"` 与 `"urls"` 键完整匹配互斥）
    #[test]
    fn parse_reads_top_level_url_with_name() {
        let html = r##"
            const config = {"url":"/swagger/v1/swagger.json","name":"V1","dom_id":"#swagger-ui"};
        "##;
        assert_eq!(
            parse_swashbuckle_index(html),
            Some(IndexParseOutcome::Groups(vec![(
                Some("V1".into()),
                "/swagger/v1/swagger.json".into()
            )]))
        );
    }

    /// 顶格 url 无 name：name 缺省待调用方推导
    #[test]
    fn parse_reads_top_level_url_without_name() {
        let html = r##"{"url":"/docs/openapi.json"}"##;
        assert_eq!(
            parse_swashbuckle_index(html),
            Some(IndexParseOutcome::Groups(vec![(
                None,
                "/docs/openapi.json".into()
            )]))
        );
    }

    /// 纯静态页 / 手写 swagger-ui dist（键不带引号）＝未识别，显式拒绝
    #[test]
    fn parse_rejects_plain_and_unquoted_pages() {
        assert_eq!(
            parse_swashbuckle_index("<html><body>hello</body></html>"),
            None
        );
        let hand_written = r##"
            window.ui = SwaggerUIBundle({
                url: '/swagger/v1/swagger.json',
                dom_id: '#swagger-ui'
            });
        "##;
        assert_eq!(parse_swashbuckle_index(hand_written), None);
    }

    /// urls 数组里缺 url 的项丢弃；url 为空串同样丢弃
    #[test]
    fn urls_array_drops_items_without_url() {
        let html = r##"{"urls":[{"name":"NoUrl"},{"url":"","name":"Empty"},{"url":"/swagger/v1/swagger.json"}]}"##;
        assert_eq!(
            parse_swashbuckle_index(html),
            Some(IndexParseOutcome::Groups(vec![(
                None,
                "/swagger/v1/swagger.json".into()
            )]))
        );
    }

    #[test]
    fn default_group_name_extracts_doc_segment_or_stem() {
        assert_eq!(
            default_group_name("https://host/swagger/v1/swagger.json"),
            "v1"
        );
        assert_eq!(
            default_group_name("https://host/swagger/admin/swagger.json"),
            "admin"
        );
        assert_eq!(
            default_group_name("https://host/docs/openapi.json"),
            "openapi"
        );
        assert_eq!(default_group_name("https://host/swagger.json"), "swagger");
    }

    /// 入口内容即 OpenAPI/Swagger 文档的宽松判定（discover 的回退通道）：
    /// 版本字段命中即文档、title 缺省回退分组名推导、非文档 None
    #[test]
    fn detect_openapi_document_loose_match() {
        assert_eq!(
            detect_openapi_document(r#"{"openapi":"3.0.0","info":{"title":"用户服务"}}"#),
            Some(Some("用户服务".into()))
        );
        assert_eq!(
            detect_openapi_document(r#"{"swagger":"2.0","paths":{}}"#),
            Some(None)
        );
        assert_eq!(detect_openapi_document("<html>not json</html>"), None);
        assert_eq!(
            detect_openapi_document(r##"{"dom_id":"#swagger-ui"}"##),
            None
        );
        assert_eq!(detect_openapi_document("[1,2]"), None);
    }

    // —— 重名消歧 ——

    #[test]
    fn dedupe_name_appends_counter_on_collision() {
        let used: HashSet<String> = ["V1".to_owned(), "V1 (2)".to_owned()].into_iter().collect();
        assert_eq!(dedupe_name("V1".into(), &used), "V1 (3)");
        let fresh: HashSet<String> = HashSet::new();
        assert_eq!(dedupe_name("V1".into(), &fresh), "V1");
    }

    // —— import_create（sqlite::memory:）——

    async fn memory_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        pool
    }

    fn input(name: &str, doc_url: &str) -> ImportServiceInput {
        ImportServiceInput {
            name: name.to_owned(),
            doc_url: doc_url.to_owned(),
        }
    }

    #[tokio::test]
    async fn import_create_inserts_batch_with_doc_urls() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        let created = import_create(
            &pool,
            "w1",
            vec![
                input("V1", "/swagger/v1/swagger.json"),
                input("Admin", "https://h/admin/swagger.json"),
            ],
        )
        .await
        .unwrap();
        assert_eq!(created.len(), 2);
        assert_eq!(created[0].name, "V1");
        assert_eq!(
            created[0].doc_url.as_deref(),
            Some("/swagger/v1/swagger.json")
        );
        assert_eq!(created[0].sort_order, 0);
        assert_eq!(created[1].sort_order, 1);
        assert_eq!(created[0].doc_type, DOC_TYPE_OPENAPI);
    }

    #[tokio::test]
    async fn import_create_disambiguates_against_existing_and_batch() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        crate::infrastructure::service_repo::test_support::seed_service(&pool, "s1", "w1", "V1")
            .await;
        let created = import_create(
            &pool,
            "w1",
            vec![
                input("V1", "/a.json"),
                input("V1", "/b.json"),
                input(" 新服务 ", "/c.json"),
            ],
        )
        .await
        .unwrap();
        // 既有 V1 撞车 → (2)；本批内再撞 → (3)；名称规范化生效
        assert_eq!(created[0].name, "V1 (2)");
        assert_eq!(created[1].name, "V1 (3)");
        assert_eq!(created[2].name, "新服务");
    }

    #[tokio::test]
    async fn import_create_rejects_empty_and_over_limit_batches() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        let err = import_create(&pool, "w1", vec![]).await.unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);
        let oversized: Vec<ImportServiceInput> = (0..MAX_IMPORT_BATCH + 1)
            .map(|i| input(&format!("s{i}"), "/doc.json"))
            .collect();
        let err = import_create(&pool, "w1", oversized).await.unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);
    }

    #[tokio::test]
    async fn import_create_rolls_back_whole_batch_on_invalid_item() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        // 第二条文档地址为空：整批回滚，首条不得落库
        let err = import_create(
            &pool,
            "w1",
            vec![input("好服务", "/a.json"), input("坏服务", "  ")],
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, codes::URL_INVALID);
        let list = service_repo::list_by_workspace(&pool, "w1").await.unwrap();
        assert!(list.is_empty(), "失败批量必须整体回滚");
    }

    #[tokio::test]
    async fn import_create_requires_workspace_and_name() {
        let pool = memory_pool().await;
        let err = import_create(&pool, "nope", vec![input("a", "/a.json")])
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::WORKSPACE_NOT_FOUND);
        ws_support::seed_workspace(&pool, "w1", "一").await;
        let err = import_create(&pool, "w1", vec![input(" ", "/a.json")])
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::NAME_INVALID);
    }

    /// import 与手工建混排后的排序序保持连续（insert 追加末尾语义复用）
    #[tokio::test]
    async fn import_create_appends_after_manual_services() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        crate::infrastructure::service_repo::test_support::seed_service(&pool, "s1", "w1", "手工")
            .await;
        import_create(&pool, "w1", vec![input("V1", "/v.json")])
            .await
            .unwrap();
        let list = service_repo::list_by_workspace(&pool, "w1").await.unwrap();
        assert_eq!(
            list.iter()
                .map(|s| (s.name.as_str(), s.sort_order))
                .collect::<Vec<_>>(),
            vec![("手工", 0), ("V1", 1)]
        );
    }
}
