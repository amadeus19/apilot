//! 服务文档地址约定：入口页 / 文档地址相对 BaseUrl 的解析纯函数。
//!
//! 归属服务 / 工作空间域概念（doc_url 相对工作空间 BaseUrl 解析），
//! 导入发现、服务探测、同步拉取三条链路同向依赖本模块（services 不再
//! 横向依赖 import 模块）。收窄 RFC 3986：无 url crate，手写常用形态。

use crate::error::AppError;
use crate::error::codes;

/// 入口页地址解析：`http(s)://` 开头＝完整 URL 原样；相对地址须有工作空间
/// BaseUrl 可依（无 BaseUrl 传相对地址＝URL_INVALID，消息明示补救方向）。
/// 服务探测与同步拉取复用（doc_url 相对工作空间 BaseUrl 解析，同一地址约定）。
pub fn resolve_entry_url(
    entry: &str,
    workspace_base_url: Option<&str>,
) -> Result<String, AppError> {
    let entry = entry.trim();
    if is_absolute_http(entry) {
        return Ok(entry.to_owned());
    }
    let Some(base) = workspace_base_url.map(str::trim).filter(|b| !b.is_empty()) else {
        return Err(AppError::new(
            codes::URL_INVALID,
            "relative entry url requires workspace base url",
        ));
    };
    resolve_document_url(base, entry)
}

/// 相对引用解析（相对 `base`）：绝对 http(s) 原样；`/` 开头＝根相对
/// （替换 base 路径）；其余＝base 目录相对（`.`/`..` 段折叠）。查询串
/// 保留；协议相对 `//` 与无 scheme 基址等形态拒绝（收窄）。
pub fn resolve_document_url(base: &str, href: &str) -> Result<String, AppError> {
    let href = href.trim();
    if is_absolute_http(href) {
        return Ok(href.to_owned());
    }
    if href.starts_with("//") {
        return Err(AppError::new(
            codes::URL_INVALID,
            format!("protocol-relative url is not supported: {href}"),
        ));
    }
    let (scheme, authority, base_path) = split_base(base)?;
    let (path_part, query) = match href.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (href, None),
    };
    let merged = if let Some(stripped) = path_part.strip_prefix('/') {
        // 根相对：丢弃 base 路径，从根重组
        fold_segments(&[], stripped)
    } else {
        // 目录相对：base 路径去掉末段（文件名）作为目录基
        let dir = match base_path.rfind('/') {
            Some(pos) => &base_path[..pos],
            None => "",
        };
        let dir_segments: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
        fold_segments(&dir_segments, path_part)
    };
    let mut url = format!("{scheme}://{authority}/{merged}");
    if let Some(q) = query {
        url.push('?');
        url.push_str(q);
    }
    Ok(url)
}

/// `http(s)://host[:port]/path` 拆三段；无 `://` 或 authority 为空＝非法基址。
fn split_base(base: &str) -> Result<(&str, &str, &str), AppError> {
    let (scheme, rest) = base
        .split_once("://")
        .ok_or_else(|| AppError::new(codes::URL_INVALID, format!("malformed base url: {base}")))?;
    if scheme != "http" && scheme != "https" {
        return Err(AppError::new(
            codes::URL_INVALID,
            format!("unsupported scheme: {scheme}"),
        ));
    }
    let (authority, path) = match rest.split_once('/') {
        Some((a, p)) => (a, p),
        None => (rest, ""),
    };
    if authority.is_empty() {
        return Err(AppError::new(
            codes::URL_INVALID,
            format!("base url has empty authority: {base}"),
        ));
    }
    Ok((scheme, authority, path))
}

/// 段折叠：基段 + 引用段，遇 `.` 跳过、`..` 弹栈（越顶不折叠，保守保留）。
/// 返回不含首尾斜杠的路径串。
fn fold_segments(base_segments: &[&str], href_path: &str) -> String {
    let mut stack: Vec<&str> = base_segments.to_vec();
    for segment in href_path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            other => stack.push(other),
        }
    }
    stack.join("/")
}

fn is_absolute_http(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::codes;

    #[test]
    fn resolve_document_url_handles_absolute_root_and_relative() {
        // 绝对原样
        assert_eq!(
            resolve_document_url("https://h/swagger/index.html", "http://other/doc.json").unwrap(),
            "http://other/doc.json"
        );
        // 根相对：替换路径
        assert_eq!(
            resolve_document_url(
                "https://h:5001/swagger/index.html",
                "/swagger/v1/swagger.json"
            )
            .unwrap(),
            "https://h:5001/swagger/v1/swagger.json"
        );
        // 目录相对：相对入口页所在目录
        assert_eq!(
            resolve_document_url("https://h/swagger/index.html", "v1/swagger.json").unwrap(),
            "https://h/swagger/v1/swagger.json"
        );
        // `..` 上折
        assert_eq!(
            resolve_document_url("https://h/a/b/index.html", "../c/doc.json").unwrap(),
            "https://h/a/c/doc.json"
        );
        // 查询串保留
        assert_eq!(
            resolve_document_url("https://h/swagger/", "/doc.json?x=1").unwrap(),
            "https://h/doc.json?x=1"
        );
    }

    #[test]
    fn resolve_document_url_rejects_protocol_relative() {
        let err = resolve_document_url("https://h/", "//cdn.example.com/doc.json").unwrap_err();
        assert_eq!(err.code, codes::URL_INVALID);
    }

    #[test]
    fn resolve_entry_url_requires_base_for_relative() {
        assert_eq!(
            resolve_entry_url(" https://h/swagger ", None).unwrap(),
            "https://h/swagger"
        );
        assert_eq!(
            resolve_entry_url("/swagger", Some("https://h")).unwrap(),
            "https://h/swagger"
        );
        let err = resolve_entry_url("/swagger", None).unwrap_err();
        assert_eq!(err.code, codes::URL_INVALID);
    }
}
