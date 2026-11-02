//! `apilot` CLI 入口薄壳：全部逻辑在 lib `cli` 模块，
//! 与 GUI main 同构一行转发。不写 `windows_subsystem`——CLI 必须保留
//! 控制台输出。
fn main() {
    app_lib::cli::run();
}
