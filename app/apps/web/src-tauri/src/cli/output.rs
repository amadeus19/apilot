//! Output Layer：命令 → Domain Result → Renderer（Human/Json）。
//! 命令内禁止 `println!`——一切输出经本层单点；通道纪律：
//! **JSON（成功与失败）→ stdout；Human 成功 → stdout、错误文本 → stderr**；
//! clap 参数错误走 clap 原生（stderr＋exit 2）；panic 走 Rust 默认
//! （stderr＋exit 101，不设 hook）。不变式：**--json 模式下 stdout 永远是
//! 合法 JSON 或空**——包络在命令 Result 后一次性渲染，中途无任何写 stdout。
//!
//! Human 渲染＝无边框空格对齐：列宽按显示宽度计算（`unicode-width`，
//! 东亚全角计 2），不做表格边框与多余修饰。

use std::io::Write;

use serde::Serialize;
use unicode_width::UnicodeWidthStr as _;

use crate::error::AppError;

/// 成功包络：`{"success":true,"data":<对象|数组>}`（不加版本字段）。
#[derive(serde::Serialize)]
pub(crate) struct SuccessEnvelope<'a, T> {
    pub success: bool,
    pub data: &'a T,
}

/// 输出选项（全局旗标）：输出模式与脱敏放行。
/// `show_secrets` 由 `api get` / `api run` / `workflow get` 消费，本层只承载。
pub(crate) struct Output {
    json: bool,
    show_secrets: bool,
}

impl Output {
    pub(crate) fn new(json: bool, show_secrets: bool) -> Self {
        Self { json, show_secrets }
    }

    /// 脱敏放行开关（`api get` / `api run` / `workflow get` 消费；
    /// `workflow run` 输出为写时掩码，不受此开关影响）。
    pub(crate) fn show_secrets(&self) -> bool {
        self.show_secrets
    }

    /// 成功输出（表格形态）：JSON＝data 包络（stdout）；
    /// Human＝无边框表格（stdout）。Human 列集允许少于 JSON 字段集
    /// （两视图对同一 Domain Result 各取所需，不做字段级拼装）。
    pub(crate) fn success_table<T: Serialize>(
        &self,
        json: &T,
        headers: &[&str],
        rows: &[Vec<String>],
    ) {
        if self.json {
            write_json(
                &mut std::io::stdout().lock(),
                &SuccessEnvelope {
                    success: true,
                    data: json,
                },
            );
        } else {
            write_table(&mut std::io::stdout().lock(), headers, rows);
        }
    }

    /// 成功输出（键值形态）：JSON＝data 包络（stdout）；
    /// Human＝「标签: 值」逐行（stdout）。
    pub(crate) fn success_kv<T: Serialize>(&self, json: &T, entries: &[(&str, String)]) {
        if self.json {
            write_json(
                &mut std::io::stdout().lock(),
                &SuccessEnvelope {
                    success: true,
                    data: json,
                },
            );
        } else {
            write_kv(&mut std::io::stdout().lock(), entries);
        }
    }

    /// 成功输出（自定契约形态）：JSON＝对象原文（自身含 `success:true`——
    /// `api run` 等顶层契约不套 data 包络）；Human＝逐行文本（stdout）。
    pub(crate) fn success_with_human<T: Serialize>(&self, json: &T, human_lines: &[String]) {
        if self.json {
            let mut bytes = serde_json::to_vec(json).expect("契约序列化不可失败（纯数据结构）");
            bytes.push(b'\n');
            let _ = std::io::stdout().lock().write_all(&bytes);
            let _ = std::io::stdout().lock().flush();
        } else {
            let mut out = String::new();
            for line in human_lines {
                out.push_str(line);
                out.push('\n');
            }
            let _ = std::io::stdout().lock().write_all(out.as_bytes());
            let _ = std::io::stdout().lock().flush();
        }
    }

    /// 失败输出：JSON＝错误包络（**stdout**）；Human＝错误文本（stderr）。
    /// 返回 exit code（error.rs 单点映射）。
    pub(crate) fn failure(&self, err: &AppError) -> i32 {
        if self.json {
            write_json(
                &mut std::io::stdout().lock(),
                &super::error::ErrorEnvelope::new(err),
            );
        } else {
            let _ = writeln!(
                std::io::stderr().lock(),
                "apilot: {}: {}",
                err.code,
                err.message
            );
        }
        super::error::exit_code_for(&err.code)
    }
}

/// 包络一次性写出（单行 JSON＋换行）。序列化失败只有自定义 `Serialize`
/// 一种来源，包络字段全为基本类型/引用——此边界可证明不可失败。
fn write_json<W: Write, E: serde::Serialize>(w: &mut W, envelope: &E) {
    let mut bytes = serde_json::to_vec(envelope).expect("envelope serialization cannot fail");
    bytes.push(b'\n');
    let _ = w.write_all(&bytes);
    let _ = w.flush();
}

/// 无边框空格对齐表格：列宽取各列显示宽度最大值；行数为零＝仅表头
/// 空行集＝仅表头（空表语义）。行短于表头以空串补位，超长列忽略。
fn write_table<W: Write>(w: &mut W, headers: &[&str], rows: &[Vec<String>]) {
    let widths: Vec<usize> = headers
        .iter()
        .enumerate()
        .map(|(i, h)| {
            rows.iter()
                .filter_map(|row| row.get(i))
                .map(|cell| cell.width())
                .max()
                .unwrap_or(0)
                .max(h.width())
        })
        .collect();
    let mut out = String::new();
    push_row(&mut out, headers, &widths);
    for row in rows {
        let cells: Vec<&str> = (0..headers.len())
            .map(|i| row.get(i).map(String::as_str).unwrap_or(""))
            .collect();
        push_row(&mut out, &cells, &widths);
    }
    let _ = w.write_all(out.as_bytes());
    let _ = w.flush();
}

fn push_row(out: &mut String, cells: &[&str], widths: &[usize]) {
    for (i, cell) in cells.iter().enumerate() {
        let width = widths.get(i).copied().unwrap_or(0);
        if i > 0 {
            out.push(' ');
        }
        out.push_str(cell);
        // 尾列不补空格（行尾不留白）
        if i + 1 < cells.len() {
            out.push_str(&" ".repeat(width.saturating_sub(cell.width())));
        }
    }
    out.push('\n');
}

/// 「标签: 值」逐行（值可多行，原样嵌入）。
fn write_kv<W: Write>(w: &mut W, entries: &[(&str, String)]) {
    for (label, value) in entries {
        let _ = writeln!(w, "{label}: {value}");
    }
    let _ = w.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_envelope_serializes_with_stable_schema() {
        let data = serde_json::json!({ "name": "默认工作空间", "apis": 12 });
        let mut buf: Vec<u8> = Vec::new();
        write_json(
            &mut buf,
            &SuccessEnvelope {
                success: true,
                data: &data,
            },
        );
        let value: serde_json::Value = serde_json::from_slice(&buf).unwrap();
        assert_eq!(value["success"], serde_json::Value::Bool(true));
        assert_eq!(value["data"]["name"], "默认工作空间");
        assert_eq!(value["data"]["apis"], 12);
        // 包络之外无任何键（schema 稳定，不加版本字段）
        assert_eq!(value.as_object().unwrap().len(), 2);
    }

    #[test]
    fn table_aligns_by_display_width_including_cjk() {
        let mut buf: Vec<u8> = Vec::new();
        write_table(
            &mut buf,
            &["ID", "METHOD", "PATH"],
            &[
                vec!["用户接口".into(), "GET".into(), "/users".into()],
                vec!["账号接口".into(), "POST".into(), "/accounts".into()],
            ],
        );
        let text = String::from_utf8(buf).unwrap();
        // 「用户接口/账号接口」显示宽度 8（CJK 计 2）→ METHOD 列从第 9 显示列起；
        // METHOD 列宽 6：GET/POST 各自补齐后再接 1 个分隔空格；尾列不补尾随空白
        assert_eq!(
            text, "ID       METHOD PATH\n用户接口 GET    /users\n账号接口 POST   /accounts\n",
            "列按显示宽度对齐（非字节/字符数）"
        );
    }

    #[test]
    fn table_with_zero_rows_prints_header_only() {
        let mut buf: Vec<u8> = Vec::new();
        write_table(&mut buf, &["ID", "METHOD"], &[]);
        assert_eq!(
            String::from_utf8(buf).unwrap(),
            "ID METHOD\n",
            "空表＝表头＋零行"
        );
    }

    #[test]
    fn kv_lines_render_label_and_value() {
        let mut buf: Vec<u8> = Vec::new();
        write_kv(
            &mut buf,
            &[("name", "默认工作空间".into()), ("base_url", "null".into())],
        );
        assert_eq!(
            String::from_utf8(buf).unwrap(),
            "name: 默认工作空间\nbase_url: null\n"
        );
    }
}
