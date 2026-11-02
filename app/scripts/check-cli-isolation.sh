#!/bin/sh
# src/cli/ 与 GUI 宿主的隔离断言。
#
# CLI 是 Mode B 直连 SQLite 的独立入口：链接 tauri 但**不初始化**，
# 且不经过 Tauri IPC 壳——`src/cli/**/*.rs` 中出现以下任一 import 即违规：
#   - `tauri::`    （破坏「链接不初始化」承诺，会把 GUI 宿主拖进 CLI 路径）
#   - `commands::` （Tauri Command 壳不得进入 CLI 分发，CLI 直调 services）
# 注释里的字样不算 import，但为免误判脚本统一不豁免——cli 模块注释请勿书写
# 这两个字面量（写「GUI 宿主」「IPC 壳」即可）。
#
# 双道防线：本脚本接 pre-commit（提交期早反馈）；`tests/cli_isolation.rs`
# 以同口径断言随 `cargo test` 进质量门禁（兜底 --no-verify 旁路与未装钩子
# 的环境）。
#
# 用法：app/scripts/check-cli-isolation.sh   （exit 0 = 通过；1 = 有违规）

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SRC="$ROOT/app/apps/web/src-tauri/src/cli"

if [ ! -d "$SRC" ]; then
  echo "[cli-isolation] $SRC 不存在，跳过"
  exit 0
fi

VIOLATIONS=$(grep -rnE '\b(tauri|commands)::' "$SRC" 2>/dev/null || true)
if [ -n "$VIOLATIONS" ]; then
  echo "[cli-isolation] src/cli/ 出现违规 import（tauri:: / commands::）：" >&2
  echo "$VIOLATIONS" >&2
  echo "[cli-isolation] CLI 禁止依赖 GUI 宿主与 Tauri IPC 壳" >&2
  exit 1
fi

echo "[cli-isolation] ok"
