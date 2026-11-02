//! 上传 / 下载：multipart 回显、按需生成的二进制与文本行流、内置 PDF / PNG /
//! SVG / HTML 媒体样本（不落盘、内存恒有界）。媒体样本的字节校验值（xref 偏移、
//! CRC、Adler-32）均在生成时由真实字节计算，不依赖手抄魔数。

use axum::body::{Body, Bytes};
use axum::extract::{Multipart, Query, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use serde::Deserialize;

use crate::auth::{bad_request, ErrorBody};
use crate::state::AppState;

/// 上传体积上限（DefaultBodyLimit 放宽到 32MB，覆盖大文件上传素材）
pub const MAX_UPLOAD_BYTES: usize = 32 * 1024 * 1024;
/// 二进制下载上限（size_mb 参数钳制）
const MAX_DOWNLOAD_MB: u64 = 200;
const MAX_TEXT_LINES: u64 = 1_000_000;

#[derive(Debug, serde::Serialize, utoipa::ToSchema)]
pub struct UploadFieldReport {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    pub size: u64,
}

#[derive(Debug, serde::Serialize, utoipa::ToSchema)]
pub struct UploadReport {
    pub fields: Vec<UploadFieldReport>,
}

/// POST /api/upload：multipart——回显 filename / size / content_type。
/// `Multipart` 是消耗性提取器，恒放参数列表最后。
#[utoipa::path(
    post,
    path = "/api/upload",
    summary = "multipart 上传回显",
    responses(
        (status = 200, description = "回显各字段元信息", body = UploadReport),
        (status = 400, description = "multipart 解析失败", body = ErrorBody),
    )
)]
pub async fn upload(
    State(_state): State<AppState>,
    mut multipart: Multipart,
) -> Result<axum::Json<UploadReport>, (StatusCode, axum::Json<ErrorBody>)> {
    let mut fields = Vec::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| bad_request(&format!("multipart 字段解析失败: {e}")))?
    {
        let name = field.name().unwrap_or("").to_string();
        let filename = field.file_name().map(str::to_string);
        let content_type = field.content_type().map(str::to_string);
        // bytes() 全量入内存：上限由路由级 DefaultBodyLimit(32MB) 兜住
        let bytes = field
            .bytes()
            .await
            .map_err(|e| bad_request(&format!("multipart 字段读取失败: {e}")))?;
        fields.push(UploadFieldReport {
            name,
            filename,
            content_type,
            size: bytes.len() as u64,
        });
    }
    Ok(axum::Json(UploadReport { fields }))
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct DownloadBinaryQuery {
    /// 生成体量（MB），上限 200
    size_mb: Option<u64>,
}

/// GET /api/download/binary：按需生成二进制流——不落盘、按 64KiB 块产出确定性字节。
#[utoipa::path(
    get,
    path = "/api/download/binary",
    summary = "下载二进制流",
    params(DownloadBinaryQuery),
    responses(
        (status = 200, description = "按需生成的二进制流", content_type = "application/octet-stream"),
        (status = 400, description = "size_mb 超出上限", body = ErrorBody),
    )
)]
pub async fn download_binary(
    Query(q): Query<DownloadBinaryQuery>,
) -> Result<Response, (StatusCode, axum::Json<ErrorBody>)> {
    let size_mb = q.size_mb.unwrap_or(1);
    if size_mb > MAX_DOWNLOAD_MB {
        return Err(bad_request(&format!("size_mb 上限 {MAX_DOWNLOAD_MB}")));
    }
    let total = size_mb * 1024 * 1024;
    // 64KiB 确定性图案块：非全零内容避免中间层压缩失真
    let chunk: Bytes = Bytes::from({
        let mut v = vec![0u8; 64 * 1024];
        for (i, b) in v.iter_mut().enumerate() {
            *b = (i % 251) as u8;
        }
        v
    });
    let stream = async_stream::stream! {
        let mut sent = 0u64;
        while sent < total {
            let n = chunk.len().min((total - sent) as usize);
            sent += n as u64;
            yield Ok::<_, std::io::Error>(chunk.slice(0..n));
        }
    };
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(Body::from_stream(stream))
        .expect("固定头值构建 Response 恒成功"))
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct DownloadTextQuery {
    /// 文本行数
    lines: Option<u64>,
}

/// GET /api/download/text：文本行流。
#[utoipa::path(
    get,
    path = "/api/download/text",
    summary = "下载文本行流",
    params(DownloadTextQuery),
    responses(
        (status = 200, description = "按需生成的文本行流", content_type = "text/plain; charset=utf-8"),
        (status = 400, description = "lines 超出上限", body = ErrorBody),
    )
)]
pub async fn download_text(
    Query(q): Query<DownloadTextQuery>,
) -> Result<Response, (StatusCode, axum::Json<ErrorBody>)> {
    let lines = q.lines.unwrap_or(10_000);
    if lines > MAX_TEXT_LINES {
        return Err(bad_request(&format!("lines 上限 {MAX_TEXT_LINES}")));
    }
    let stream = async_stream::stream! {
        for i in 1..=lines {
            let line = format!("line {i:06}: The quick brown fox jumps over the lazy dog.\n");
            yield Ok::<_, std::io::Error>(Bytes::from(line));
        }
    };
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from_stream(stream))
        .expect("固定头值构建 Response 恒成功"))
}

// —— 媒体样本端点（PDF / PNG / SVG / HTML） ——
//
// 三端点覆盖前端 Preview 三通道（application/pdf、image/*、text/html），
// Content-Type 与 previewKindFromContentType 白名单口径一一对应。内容恒为
// KB 级：按请求生成、不落盘、无跨请求常驻缓冲。

/// 内联 SVG 示例图：image/ 前缀命中前端图片通道白名单（含 image/svg+xml）。
/// 属性值含 `"#` 序列，定界符取双井号。
const SVG_SAMPLE: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 0 160 80"><rect width="160" height="80" fill="#1e90ff"/><text x="80" y="34" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#ffffff">APilot SVG 靶图</text><circle cx="80" cy="56" r="12" fill="#ffd700"/></svg>"##;

/// 自包含 HTML 示例页：中文标题、表格、链接、内联样式，供沙箱 iframe 渲染实测。
const HTML_SAMPLE: &str = r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>APilot HTML 靶页</title>
</head>
<body style="font-family: system-ui, sans-serif; margin: 24px; color: #1f2937;">
<h1 style="font-size: 20px; margin: 0 0 12px;">APilot HTML 靶页</h1>
<p>自包含示例页：用于响应区 iframe 沙箱通道的渲染实测。</p>
<table style="border-collapse: collapse; margin: 12px 0;">
<thead><tr>
<th style="border: 1px solid #9ca3af; padding: 4px 12px;">方法</th>
<th style="border: 1px solid #9ca3af; padding: 4px 12px;">路径</th>
<th style="border: 1px solid #9ca3af; padding: 4px 12px;">说明</th>
</tr></thead>
<tbody>
<tr><td style="border: 1px solid #9ca3af; padding: 4px 12px;">GET</td><td style="border: 1px solid #9ca3af; padding: 4px 12px;">/api/download/html</td><td style="border: 1px solid #9ca3af; padding: 4px 12px;">本页面</td></tr>
<tr><td style="border: 1px solid #9ca3af; padding: 4px 12px;">GET</td><td style="border: 1px solid #9ca3af; padding: 4px 12px;">/api/download/pdf</td><td style="border: 1px solid #9ca3af; padding: 4px 12px;">最小 PDF</td></tr>
<tr><td style="border: 1px solid #9ca3af; padding: 4px 12px;">GET</td><td style="border: 1px solid #9ca3af; padding: 4px 12px;">/api/download/image</td><td style="border: 1px solid #9ca3af; padding: 4px 12px;">PNG / SVG</td></tr>
</tbody>
</table>
<p><a href="/swagger-ui" style="color: #2563eb;">前往 Swagger UI</a></p>
</body>
</html>
"#;

/// 最小有效 PDF（单页静态文本）：xref 偏移在生成时确定性计算，文件头 /
/// xref / startxref / %%EOF 结构自洽，可被浏览器 iframe 与 WebView2 渲染。
/// 内容流用 Helvetica 仅支持 ASCII，中文示例由 HTML / SVG 端点承载。
fn build_minimal_pdf() -> Vec<u8> {
    let content: &[u8] = b"BT /F1 18 Tf 72 720 Td (APilot demo-server minimal PDF) Tj ET\n\
                           BT /F1 12 Tf 72 690 Td (Single page of static text for preview testing.) Tj ET";
    // 流对象体：/Length 只计 stream 关键字换行后到 endstream 前换行前的字节
    let stream_obj = {
        let mut body = format!("<< /Length {} >>\nstream\n", content.len()).into_bytes();
        body.extend_from_slice(content);
        body.extend_from_slice(b"\nendstream");
        body
    };
    let objects: [&[u8]; 5] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        &stream_obj,
    ];

    let mut out = Vec::with_capacity(1024);
    // 对象号（1..=5）→ 文件内字节偏移，xref 表按此回填
    let mut offsets = [0u32; 6];
    // 头后跟二进制标记注释：向解析器声明文件含二进制内容（规格建议写法）
    out.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    for (idx, body) in objects.iter().enumerate() {
        let num = idx + 1;
        offsets[num] = out.len() as u32;
        out.extend_from_slice(format!("{num} 0 obj\n").as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }

    // xref 表：每条恰 20 字节（10 位偏移 + 5 位代数 + 类型 + 2 字节行尾）；
    // 首条为空闲链表头（f），其余对象各一条在用项（n）
    let xref_offset = out.len() as u32;
    out.extend_from_slice(b"xref\n0 6\n");
    out.extend_from_slice(b"0000000000 65535 f \n");
    for offset in offsets.iter().skip(1) {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n");
    out.extend_from_slice(format!("{xref_offset}\n").as_bytes());
    out.extend_from_slice(b"%%EOF\n");
    out
}

/// CRC-32（IEEE 802.3 多项式）：PNG 区块校验算法，按位计算免查表。
fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// Adler-32：zlib 流校验和（a＝字节和加一，b＝历史 a 累和，模 65521）。
fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in data {
        a = (a + byte as u32) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}

/// PNG 纯色小图边长（像素）：肉眼可辨的最小方块，字节数恒几十级。
const PNG_EDGE: u32 = 8;

/// 追加一个 PNG 区块：长度 + 类型 + 数据 + CRC（CRC 覆盖类型与数据）。
fn png_chunk(out: &mut Vec<u8>, chunk_type: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(chunk_type);
    out.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(chunk_type);
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

/// 最小有效 PNG：8×8 纯红方块。签名 + IHDR + IDAT + IEND 全部运行期构造，
/// CRC / Adler-32 由真实字节算得，不引图片处理依赖。
fn build_minimal_png() -> Vec<u8> {
    let edge = PNG_EDGE as usize;
    // 扫描线原始数据：每行 1 字节滤波器（0＝None）+ 边长 × RGB 三通道
    let mut row = Vec::with_capacity(1 + 3 * edge);
    row.push(0x00);
    for _ in 0..edge {
        row.extend_from_slice(&[0xFF, 0x00, 0x00]);
    }
    let mut raw = Vec::with_capacity(edge * row.len());
    for _ in 0..edge {
        raw.extend_from_slice(&row);
    }
    // zlib 包装：0x78 0x01 头（CM=deflate、FLEVEL=0，头校验自洽）+
    // deflate 存储块（原样携带，免压缩实现）+ Adler-32；
    // 存储块单块上限 65535 字节，8×8 原始扫描线恒 200 字节
    let mut zlib = Vec::with_capacity(raw.len() + 11);
    zlib.extend_from_slice(&[0x78, 0x01]);
    zlib.extend_from_slice(&[0x01]);
    zlib.extend_from_slice(&(raw.len() as u16).to_le_bytes());
    zlib.extend_from_slice(&(!(raw.len() as u16)).to_le_bytes());
    zlib.extend_from_slice(&raw);
    zlib.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut png = Vec::with_capacity(zlib.len() + 57);
    png.extend_from_slice(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    // IHDR：宽高、位深 8、色型 2（真彩 RGB）、压缩 / 滤波 / 隔行均 0。
    // 宽高按 PNG 规范为 u32 大端（edge 是 usize，64 位平台 to_be_bytes 为
    // 8 字节，直接拷会长度失配）
    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&(edge as u32).to_be_bytes());
    ihdr[4..8].copy_from_slice(&(edge as u32).to_be_bytes());
    ihdr[8] = 8;
    ihdr[9] = 2;
    png_chunk(&mut png, b"IHDR", &ihdr);
    png_chunk(&mut png, b"IDAT", &zlib);
    png_chunk(&mut png, b"IEND", &[]);
    png
}

/// GET /api/download/pdf：内置最小有效 PDF（单页文本）——按需生成、不落盘。
#[utoipa::path(
    get,
    path = "/api/download/pdf",
    summary = "下载 PDF 样本",
    responses(
        (status = 200, description = "内置最小有效 PDF（单页静态文本）", content_type = "application/pdf"),
    )
)]
pub async fn download_pdf() -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, "application/pdf")
        .body(Body::from(build_minimal_pdf()))
        .expect("固定头值构建 Response 恒成功")
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct DownloadImageQuery {
    /// 图片类型：png（默认）或 svg
    r#type: Option<String>,
}

/// GET /api/download/image：最小位图，`type=svg` 时返回内联 SVG 文本。
/// 两种 Content-Type 均以 image/ 前缀命中前端图片通道白名单。
#[utoipa::path(
    get,
    path = "/api/download/image",
    summary = "下载图片样本",
    params(DownloadImageQuery),
    responses(
        (status = 200, description = "type=png（默认）返回最小位图，type=svg 返回内联 SVG 文本", content(
            ("image/png"),
            ("image/svg+xml; charset=utf-8"),
        )),
        (status = 400, description = "type 取值不合法", body = ErrorBody),
    )
)]
pub async fn download_image(
    Query(q): Query<DownloadImageQuery>,
) -> Result<Response, (StatusCode, axum::Json<ErrorBody>)> {
    match q.r#type.as_deref().unwrap_or("png") {
        "png" => Ok(Response::builder()
            .header(header::CONTENT_TYPE, "image/png")
            .body(Body::from(build_minimal_png()))
            .expect("固定头值构建 Response 恒成功")),
        "svg" => Ok(Response::builder()
            .header(header::CONTENT_TYPE, "image/svg+xml; charset=utf-8")
            .body(Body::from(SVG_SAMPLE))
            .expect("固定头值构建 Response 恒成功")),
        other => Err(bad_request(&format!(
            "type 仅支持 png / svg，收到 {other}"
        ))),
    }
}

/// GET /api/download/html：自包含示例页（中文标题、表格、链接、内联样式）。
#[utoipa::path(
    get,
    path = "/api/download/html",
    summary = "下载 HTML 示例页",
    responses(
        (status = 200, description = "自包含 HTML 示例页", content_type = "text/html; charset=utf-8"),
    )
)]
pub async fn download_html() -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(Body::from(HTML_SAMPLE))
        .expect("固定头值构建 Response 恒成功")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PDF 结构自洽：文件头 / %%EOF / startxref 回指 xref 表 /
    /// xref 各项回指对象头 / 流长度声明与实际字节一致（xref 错位即无法渲染）。
    #[test]
    fn minimal_pdf_structure_self_consistent() {
        let pdf = build_minimal_pdf();
        assert!(pdf.starts_with(b"%PDF-1.4\n"));
        assert!(pdf.ends_with(b"%%EOF\n"));

        // startxref 数值回指 xref 关键字
        let needle = b"startxref\n";
        let after = pdf
            .windows(needle.len())
            .rposition(|w| w == needle)
            .expect("startxref 必在")
            + needle.len();
        let digits = pdf[after..]
            .iter()
            .position(|b| !b.is_ascii_digit())
            .expect("startxref 后必为数字与换行");
        let xref_at: usize = std::str::from_utf8(&pdf[after..after + digits])
            .unwrap()
            .parse()
            .unwrap();
        assert!(pdf[xref_at..].starts_with(b"xref\n"));

        // xref 子表 0 6：空闲头一条 + 5 个对象各一条，每条 20 字节
        let table = xref_at + b"xref\n0 6\n".len();
        assert_eq!(&pdf[table..table + 20], b"0000000000 65535 f \n");
        for i in 1..=5usize {
            let entry = &pdf[table + i * 20..table + (i + 1) * 20];
            assert_eq!(&entry[10..11], b" ", "偏移与代数以空格分隔");
            assert_eq!(&entry[17..18], b"n", "对象项类型为 n（代数 5 位后隔空格）");
            let offset: usize = std::str::from_utf8(&entry[..10]).unwrap().parse().unwrap();
            assert!(
                pdf[offset..].starts_with(format!("{i} 0 obj").as_bytes()),
                "对象 {i} 的 xref 偏移回指对象头"
            );
        }

        // /Length 与 stream…endstream 间实际字节数一致
        let length_at = pdf
            .windows(8)
            .position(|w| w == b"/Length ")
            .expect("/Length 必在")
            + 8;
        let digits = pdf[length_at..]
            .iter()
            .position(|b| !b.is_ascii_digit())
            .unwrap();
        let declared: usize = std::str::from_utf8(&pdf[length_at..length_at + digits])
            .unwrap()
            .parse()
            .unwrap();
        let stream_start = pdf
            .windows(7)
            .position(|w| w == b"stream\n")
            .expect("stream 必在")
            + 7;
        let stream_end = pdf
            .windows(10)
            .position(|w| w == b"\nendstream")
            .expect("endstream 必在");
        assert_eq!(declared, stream_end - stream_start);
    }

    /// PNG 结构自洽：签名 / 区块 CRC 逐块校验 / IHDR 尺寸与色型 /
    /// zlib 存储块与 Adler-32 一致 / 扫描线为纯红。
    #[test]
    fn minimal_png_chunks_and_checksums_consistent() {
        let png = build_minimal_png();
        assert!(png.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));

        // 逐区块走查：长度 + 类型 + 数据 + CRC（CRC 覆盖类型与数据）
        let mut pos = 8;
        let mut types = Vec::new();
        while pos < png.len() {
            let len = u32::from_be_bytes(png[pos..pos + 4].try_into().unwrap()) as usize;
            let chunk_type = &png[pos + 4..pos + 8];
            let data = &png[pos + 8..pos + 8 + len];
            let crc = u32::from_be_bytes(png[pos + 8 + len..pos + 12 + len].try_into().unwrap());
            let mut crc_input = Vec::with_capacity(4 + len);
            crc_input.extend_from_slice(chunk_type);
            crc_input.extend_from_slice(data);
            assert_eq!(
                crc,
                crc32(&crc_input),
                "区块 {} CRC 不自洽",
                std::str::from_utf8(chunk_type).unwrap()
            );
            types.push(std::str::from_utf8(chunk_type).unwrap().to_string());
            pos += 12 + len;
        }
        assert_eq!(types, ["IHDR", "IDAT", "IEND"]);

        // IHDR：8×8、位深 8、真彩 RGB
        assert_eq!(&png[16..24], &[0, 0, 0, 8, 0, 0, 0, 8]);
        assert_eq!(&png[24..26], &[8, 2]);

        // IDAT 内部：zlib 头 + 存储块 + Adler-32 与原始扫描线自洽
        let idat_type = png.windows(4).position(|w| w == b"IDAT").unwrap();
        let len = u32::from_be_bytes(png[idat_type - 4..idat_type].try_into().unwrap()) as usize;
        let zlib = &png[idat_type + 4..idat_type + 4 + len];
        assert_eq!(&zlib[..2], &[0x78, 0x01], "zlib 头（CM=deflate）");
        assert_eq!(zlib[2], 0x01, "末块存储型 deflate（BFINAL=1、BTYPE=00）");
        let raw_len = u16::from_le_bytes([zlib[3], zlib[4]]) as usize;
        assert_eq!(u16::from_le_bytes([zlib[5], zlib[6]]), !(raw_len as u16), "NLEN 为 LEN 取反");
        assert_eq!(raw_len, zlib.len() - 11, "包裹 11 字节：头 2 + 块头 5 + 校验 4");
        let raw = &zlib[7..zlib.len() - 4];
        assert_eq!(&zlib[zlib.len() - 4..], &adler32(raw).to_be_bytes(), "Adler-32 自洽");
        assert_eq!(raw.len(), 8 * (1 + 8 * 3));
        assert_eq!(raw[0], 0, "行滤波器 None");
        assert_eq!(&raw[1..4], &[0xFF, 0x00, 0x00], "首像素纯红");
    }

    /// SVG / HTML 样本恒为 UTF-8 文本且含关键结构（文案锚点供契约测试引用）。
    #[test]
    fn svg_and_html_samples_keep_key_anchors() {
        assert!(SVG_SAMPLE.contains("<svg"));
        assert!(SVG_SAMPLE.contains("APilot SVG 靶图"));
        assert!(HTML_SAMPLE.starts_with("<!doctype html>"));
        assert!(HTML_SAMPLE.contains("APilot HTML 靶页"));
        assert!(HTML_SAMPLE.contains("<table"));
        assert!(HTML_SAMPLE.contains("<a href="));
    }
}
