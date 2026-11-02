//! CLI 隔离断言（架构不变式的第二道门，随 `cargo test` 进质量门禁）：
//! `src/cli/` 不得引用宿主框架路径（`tauri::`）与 IPC 壳模块（`commands::`）
//! ——Mode B「CLI 可脱离 GUI 宿主演化」的结构前提。检测口径与提交期脚本
//! `app/scripts/check-cli-isolation.sh` 逐字一致（`\b(tauri|commands)::`，
//! 注释中的字面量同样不豁免）；本测试兜底脚本可达性之外的路径
//! （`--no-verify` 旁路、新 clone 未装钩子、无 CI 环境）。

use std::path::{Path, PathBuf};

/// 词边界子串检查：与 `\b(tauri|commands)::` 语义一致——命中字面量且其前
/// 一字符非词字符（字母数字下划线）才算模块路径引用。
fn violates_isolation(text: &str) -> Option<String> {
    for literal in ["tauri::", "commands::"] {
        if let Some(pos) = text.find(literal) {
            let boundary = pos == 0 || {
                let prev = text[..pos].chars().next_back().expect("pos>0 checked");
                !prev.is_alphanumeric() && prev != '_'
            };
            if boundary {
                let line = text[..pos].lines().count() + 1;
                return Some(format!("'{literal}' at line {line}"));
            }
        }
    }
    None
}

fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("src/cli must be readable") {
        let path = entry.expect("dir entry must be readable").path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn cli_module_is_isolated_from_host_framework_and_ipc_shell() {
    let cli_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("cli");
    let mut files = Vec::new();
    collect_rs_files(&cli_dir, &mut files);
    assert!(
        !files.is_empty(),
        "src/cli 目录不可达或为空：{}",
        cli_dir.display()
    );

    let mut violations = Vec::new();
    for file in &files {
        let text = std::fs::read_to_string(file).expect("source file must be readable");
        if let Some(found) = violates_isolation(&text) {
            violations.push(format!("{}: {found}", file.display()));
        }
    }
    assert!(
        violations.is_empty(),
        "src/cli 违反隔离不变式（不得引用宿主框架路径与 IPC 壳模块）：\n{}",
        violations.join("\n")
    );
}
