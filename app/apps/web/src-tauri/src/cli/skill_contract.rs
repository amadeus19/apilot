//! 仓库根 Agent skill（`skills/apilot/`）与 CLI 契约的对账。
//!
//! 本模块是 `app/` 内唯一读取仓库根文件的测试：只读、构建不依赖它。
//! CLI 契约删改而 skill 未同步时 `cargo test` 变红，五项对账：
//! ① 文件集合恰为约定三文件；② frontmatter 合规与行数上限；
//! ③ 错误码与 exit 族对契约夹具；④ 命令与旗标对 clap 命令面；
//! ⑤ 输出参考的字段名对夹具键集与闭合词表。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use clap::Command;

use super::command_surface;
use super::contract_fixture::{self, ContractFixture};

/// skill 文件夹内允许的文件全集（相对路径，`/` 分隔）。
const SKILL_FILES: [&str; 3] = ["SKILL.md", "references/errors.md", "references/output.md"];

/// 反引号内的全大写词不都是错误码（HTTP 方法、通用缩写等）。
/// 只有列在此处的非码词豁免；未列出的全大写词一律按错误码对夹具。
const NON_CODE_TOKENS: [&str; 19] = [
    "API", "CLI", "DELETE", "GET", "GUI", "HEAD", "HTTP", "HTTPS", "ID", "JSON", "METHOD",
    "OPTIONS", "PATCH", "PATH", "POST", "PUT", "SKILL", "URL", "YAML",
];

/// 输出参考里允许出现的非字段反引号词（JSON 字面量与工具名）。
const NON_FIELD_TOKENS: [&str; 4] = ["apilot", "false", "null", "true"];

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(4)
        .expect("仓库根须可由 CARGO_MANIFEST_DIR 上溯四级定位")
        .to_path_buf()
}

fn skill_root() -> PathBuf {
    repo_root().join("skills").join("apilot")
}

fn read_skill_file(relative: &str) -> String {
    let path = skill_root().join(relative);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("skill 文件不可读 {}: {err}", path.display()))
}

fn collect_files(dir: &Path, prefix: &Path, out: &mut BTreeSet<String>) {
    for entry in std::fs::read_dir(dir)
        .unwrap_or_else(|err| panic!("skill 目录不可读 {}: {err}", dir.display()))
    {
        let path = entry.expect("目录项可读").path();
        let relative = prefix.join(path.file_name().expect("目录项必有文件名"));
        if path.is_dir() {
            collect_files(&path, &relative, out);
        } else {
            out.insert(relative.to_string_lossy().replace('\\', "/"));
        }
    }
}

/// frontmatter 字段（`key: value` 行，值去首尾空白与可选的成对双引号）。
fn frontmatter(text: &str) -> BTreeMap<String, String> {
    let mut lines = text.lines();
    assert_eq!(
        lines.next(),
        Some("---"),
        "frontmatter 必须自文件第一行开始"
    );
    let mut fields = BTreeMap::new();
    for line in lines {
        if line.trim() == "---" {
            return fields;
        }
        let (key, value) = line
            .split_once(':')
            .unwrap_or_else(|| panic!("frontmatter 行缺少冒号: {line:?}"));
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|inner| inner.strip_suffix('"'))
            .unwrap_or(value);
        fields.insert(key.trim().to_owned(), value.to_owned());
    }
    panic!("frontmatter 缺少结束分隔线");
}

/// 单行内反引号包裹的片段（围栏代码块整体跳过——块内是示例，不是字段名）。
fn inline_code_spans(text: &str) -> Vec<String> {
    let mut spans = Vec::new();
    let mut in_fence = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let mut rest = line;
        while let Some(start) = rest.find('`') {
            let after = &rest[start + 1..];
            let Some(end) = after.find('`') else { break };
            spans.push(after[..end].to_owned());
            rest = &after[end + 1..];
        }
    }
    spans
}

fn is_upper_code_token(token: &str) -> bool {
    token.len() >= 4
        && token.chars().next().is_some_and(|c| c.is_ascii_uppercase())
        && token
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && !NON_CODE_TOKENS.contains(&token)
}

/// 围栏代码块内的行（不含围栏行本身）。
fn fenced_lines(text: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let mut in_fence = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            lines.push(line);
        }
    }
    lines
}

/// 按非字母数字下划线切分后留下的全大写词——代码块里的错误码示例同样入账。
fn uppercase_tokens(line: &str) -> BTreeSet<String> {
    line.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|token| is_upper_code_token(token))
        .map(str::to_owned)
        .collect()
}

fn code_tokens(text: &str) -> BTreeSet<String> {
    let mut tokens: BTreeSet<String> = inline_code_spans(text)
        .into_iter()
        .filter(|span| is_upper_code_token(span))
        .collect();
    for line in fenced_lines(text) {
        tokens.extend(uppercase_tokens(line));
    }
    tokens
}

fn exit_heading(line: &str) -> Option<i32> {
    let rest = line.strip_prefix("## Exit ")?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// SKILL.md exit 表（`| \`N\` | ...` 行）列出的 exit 值。
fn skill_exit_table(text: &str) -> BTreeSet<i32> {
    let mut exits = BTreeSet::new();
    for line in text.lines() {
        let Some(rest) = line.trim_start().strip_prefix("| `") else {
            continue;
        };
        let Some(end) = rest.find('`') else { continue };
        if let Ok(exit) = rest[..end].parse::<i32>() {
            exits.insert(exit);
        }
    }
    exits
}

/// skill 中出现的 `apilot ...` 调用：围栏代码块逐行＋行内反引号片段。
fn apilot_invocations(text: &str) -> Vec<String> {
    let mut invocations = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("apilot ") {
            invocations.push(trimmed.to_owned());
        }
    }
    for span in inline_code_spans(text) {
        if span.starts_with("apilot ") {
            invocations.push(span);
        }
    }
    invocations
}

/// shell 风格分词：空白分隔，单 / 双引号内的空白保留（不处理转义）。
fn split_shell(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in input.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => current.push(ch),
            None => match ch {
                '\'' | '"' => quote = Some(ch),
                c if c.is_whitespace() => {
                    if !current.is_empty() {
                        tokens.push(std::mem::take(&mut current));
                    }
                }
                _ => current.push(ch),
            },
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn find_leaf(root: &Command, group: &str, command: &str) -> Option<Command> {
    root.find_subcommand(group)?
        .find_subcommand(command)
        .cloned()
}

/// 命令接受的旗标是否取值：命令已解析时用叶子表，否则用根表。
fn flag_takes_value(
    command_path: &[String],
    root_flags: &BTreeMap<String, bool>,
    leaves: &BTreeMap<String, Command>,
    flag: &str,
) -> bool {
    if command_path.len() == 2 {
        let key = format!("{} {}", command_path[0], command_path[1]);
        if let Some(leaf) = leaves.get(&key) {
            if let Some(takes) = command_surface::long_flags(leaf).get(flag) {
                return *takes;
            }
        }
    }
    root_flags.get(flag).copied().unwrap_or(false)
}

/// 递归取夹具 `shape` 的全部键（`keys` 对象、`items` 与嵌套对象）。
fn collect_shape_keys(value: &serde_json::Value, keys: &mut BTreeSet<String>) {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::Object(fields)) = map.get("keys") {
                for (key, child) in fields {
                    keys.insert(key.clone());
                    collect_shape_keys(child, keys);
                }
            }
            for (key, child) in map {
                if key != "keys" {
                    collect_shape_keys(child, keys);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_shape_keys(item, keys);
            }
        }
        _ => {}
    }
}

fn fixture_keys(fixture: &ContractFixture) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    for command in &fixture.commands {
        collect_shape_keys(&command.shape, &mut keys);
    }
    keys
}

fn is_field_identifier(span: &str) -> bool {
    !span.is_empty()
        && span.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && span.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// ① 文件集合恰为约定三文件（防杂项混入 skill 文件夹）。
#[test]
fn skill_folder_has_exactly_the_agreed_files() {
    let mut files = BTreeSet::new();
    collect_files(&skill_root(), Path::new(""), &mut files);
    let expected: BTreeSet<String> = SKILL_FILES.iter().map(|file| (*file).to_owned()).collect();
    assert_eq!(
        files, expected,
        "skills/apilot 只允许约定三文件，说明放文件夹之外"
    );
}

/// ② frontmatter 只用规范字段、name 与文件夹同名、长度上限、SKILL.md ≤200 行。
#[test]
fn skill_frontmatter_is_valid_and_within_limits() {
    let text = read_skill_file("SKILL.md");
    let fields = frontmatter(&text);
    let keys: BTreeSet<&str> = fields.keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        BTreeSet::from(["compatibility", "description", "name"]),
        "frontmatter 只允许 name / description / compatibility"
    );

    let folder_name = skill_root()
        .file_name()
        .expect("skill 目录必有文件名")
        .to_string_lossy()
        .into_owned();
    assert_eq!(fields["name"], folder_name, "name 必须与父目录同名");

    let description = &fields["description"];
    assert!(!description.is_empty(), "description 不得为空");
    assert!(
        description.chars().count() <= 1024,
        "description 超 1024 字符：{}",
        description.chars().count()
    );

    let compatibility = &fields["compatibility"];
    assert!(!compatibility.is_empty(), "compatibility 不得为空");
    assert!(
        compatibility.chars().count() <= 500,
        "compatibility 超 500 字符：{}",
        compatibility.chars().count()
    );

    assert!(
        text.lines().count() <= 200,
        "SKILL.md 超 200 行：{}",
        text.lines().count()
    );
}

/// ③ 错误码全在契约夹具 exit 全表；errors.md 的 exit 族与夹具一致；
/// SKILL.md exit 表恰为夹具出现的值再加 0。
#[test]
fn skill_error_codes_and_exit_families_match_contract_fixture() {
    let fixture = contract_fixture::parse();

    let mut mentioned = BTreeSet::new();
    for file in SKILL_FILES {
        mentioned.extend(code_tokens(&read_skill_file(file)));
    }
    assert!(!mentioned.is_empty(), "skill 应提到常见错误码");
    for code in &mentioned {
        assert!(
            fixture.exit_codes.contains_key(code),
            "skill 提到的错误码 {code} 不在契约夹具 exitCodes 中"
        );
    }

    let errors = read_skill_file("references/errors.md");
    let mut current_exit: Option<i32> = None;
    let mut section_exits = BTreeSet::new();
    let mut checked = BTreeSet::new();
    for line in errors.lines() {
        if let Some(exit) = exit_heading(line) {
            current_exit = Some(exit);
            section_exits.insert(exit);
            continue;
        }
        if line.starts_with("## ") {
            current_exit = None;
        }
        let Some(exit) = current_exit else { continue };
        for code in code_tokens(line) {
            assert_eq!(
                fixture.exit_codes[&code], exit,
                "errors.md 把 {code} 归错 exit 族（夹具为 {}）",
                fixture.exit_codes[&code]
            );
            checked.insert(code);
        }
    }
    assert!(!checked.is_empty(), "errors.md 的 exit 族缺错误码");
    let fixture_families: BTreeSet<i32> = fixture.exit_codes.values().copied().collect();
    assert_eq!(
        section_exits, fixture_families,
        "errors.md 的 exit 族须覆盖夹具全部取值"
    );

    let mut expected_families = fixture_families;
    expected_families.insert(0);
    assert_eq!(
        skill_exit_table(&read_skill_file("SKILL.md")),
        expected_families,
        "SKILL.md exit 表须恰为夹具取值加 0"
    );
}

/// ④ 提到的 apilot 调用都是 clap 叶子命令，旗标都在对应命令上；
/// output.md 为每个叶子命令保留章节。
#[test]
fn skill_commands_and_flags_exist_on_clap_surface() {
    let root = command_surface::root();
    let root_flags = command_surface::long_flags(&root);
    let leaves: BTreeSet<String> = command_surface::leaf_paths(&root).into_iter().collect();
    let mut leaf_commands: BTreeMap<String, Command> = BTreeMap::new();
    let mut all_flags = root_flags.clone();
    for path in &leaves {
        let (group, command) = path.split_once(' ').expect("叶子路径形如「组 命令」");
        let leaf =
            find_leaf(&root, group, command).unwrap_or_else(|| panic!("clap 命令面缺叶子 {path}"));
        all_flags.extend(command_surface::long_flags(&leaf));
        leaf_commands.insert(path.clone(), leaf);
    }

    let mut mentioned_commands = BTreeSet::new();
    let mut invocation_count = 0;
    for file in SKILL_FILES {
        for invocation in apilot_invocations(&read_skill_file(file)) {
            let tokens = split_shell(&invocation);
            if tokens.first().map(String::as_str) != Some("apilot") {
                continue;
            }
            invocation_count += 1;

            let mut command_path: Vec<String> = Vec::new();
            let mut flags: Vec<String> = Vec::new();
            let mut index = 1;
            while index < tokens.len() {
                let token = &tokens[index];
                if let Some(flag) = token.strip_prefix("--") {
                    let name = flag.split('=').next().unwrap_or(flag).to_owned();
                    flags.push(name.clone());
                    if flag_takes_value(&command_path, &root_flags, &leaf_commands, &name) {
                        index += 1;
                    }
                } else if command_path.len() < 2 {
                    command_path.push(token.clone());
                }
                index += 1;
            }

            if command_path.is_empty() {
                // 根级元路径（--version / --help）或裸调用：只核对根旗标。
                for flag in &flags {
                    assert!(
                        root_flags.contains_key(flag),
                        "根命令不接受 --{flag}（skill 调用：{invocation}）"
                    );
                }
                continue;
            }
            if command_path.iter().any(|token| token.starts_with('<')) {
                // 语法占位式（`apilot <group> <command> --help`）不指向具体命令。
                continue;
            }
            assert_eq!(
                command_path.len(),
                2,
                "无法从 apilot 调用解析命令：{invocation}"
            );
            let path = format!("{} {}", command_path[0], command_path[1]);
            assert!(
                leaves.contains(&path),
                "skill 提到不存在的命令 {path}（调用：{invocation}）"
            );
            let leaf_flags = command_surface::long_flags(&leaf_commands[&path]);
            for flag in &flags {
                assert!(
                    leaf_flags.contains_key(flag) || root_flags.contains_key(flag),
                    "{path} 不接受 --{flag}（调用：{invocation}）"
                );
            }
            mentioned_commands.insert(path);
        }
    }
    assert!(invocation_count > 0, "skill 中未找到任何 apilot 调用");
    assert!(
        mentioned_commands.len() >= 8,
        "skill 应覆盖主要命令面：{mentioned_commands:?}"
    );

    let mut standalone_flags = BTreeSet::new();
    for file in SKILL_FILES {
        for span in inline_code_spans(&read_skill_file(file)) {
            if let Some(rest) = span.strip_prefix("--") {
                let name = rest
                    .split(|c: char| c.is_whitespace() || c == '=')
                    .next()
                    .unwrap_or("");
                if !name.is_empty() {
                    standalone_flags.insert(name.to_owned());
                }
            }
        }
    }
    for flag in &standalone_flags {
        assert!(
            all_flags.contains_key(flag),
            "skill 提到不存在的旗标 --{flag}"
        );
    }

    let output_reference = read_skill_file("references/output.md");
    for path in &leaves {
        let heading = format!("## {path}");
        assert!(
            output_reference.lines().any(|line| line.trim() == heading),
            "references/output.md 缺 {path} 的 JSON 形态章节"
        );
    }
}

/// ⑤ output.md 反引号包裹的字段名属于夹具键集、闭合词表或显式白名单。
#[test]
fn output_reference_field_names_belong_to_the_contract() {
    let fixture = contract_fixture::parse();
    let mut allowed = fixture_keys(&fixture);
    allowed.extend(fixture.vocab.execution_status.iter().cloned());
    allowed.extend(fixture.vocab.issue_codes.iter().cloned());
    allowed.extend(NON_FIELD_TOKENS.iter().map(|token| (*token).to_owned()));

    let mut checked = 0;
    for span in inline_code_spans(&read_skill_file("references/output.md")) {
        if !is_field_identifier(&span) {
            continue;
        }
        checked += 1;
        assert!(
            allowed.contains(&span),
            "references/output.md 提到契约之外的字段 {span}"
        );
    }
    assert!(checked > 50, "字段名提取过少（{checked}），检查提取口径");
}
