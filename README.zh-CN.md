# APilot

**Windows 优先的桌面 API 调试 / 接口测试 / 工作空间管理 / 接口工作流工具，基于 Tauri 2 + React + Rust 从零构建。**

[English](./README.md) | 简体中文

[![平台](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4.svg)](#下载安装)
[![架构](https://img.shields.io/badge/architecture-x64%20%7C%20ARM64-5C2D91.svg)](#下载安装)
[![协议](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

<!-- TODO: screenshot -->

APilot 把接口、环境变量、请求历史和多步工作流收进一个本地桌面应用。所有数据保存在本机 SQLite 数据库中——不需要账号，也不依赖云端。随应用附带的 `apilot` CLI 读取同一份数据，编码 agent 可以直接在终端里查找、调用、调试接口并运行工作流。

## 核心功能

### HTTP 调试

- 编辑请求：header、query 与 path 参数、JSON / 表单 / multipart 请求体（含文件上传）、XML 格式化；支持 cURL 导入与导出。
- 认证（Bearer、Basic 等）支持请求级与工作空间级两级继承。
- 响应按体积分级：小响应进内存、大响应流式接收、超大响应落临时文件，界面只展示预览。可查看并保存文本、图片、PDF、HTML 响应，SSE 长连接流式实时显示。
- 每次请求自动进入当前工作空间的历史——可搜索、可恢复到草稿重新编辑、可批量清理。
- 全局 HTTP 设置（超时、重定向、TLS 校验、代理）之外，单个接口可覆写超时。

### 环境变量

- 变量按分类组织，激活即生效；以 `{{name}}` 引用，编辑器提供联想与悬停解析。
- 内置兜底链：激活分类 → 全局分类 → `{{baseUrl}}`，变量预览展示当前生效值集。
- Secret 变量全路径默认脱敏，应用内与 CLI 输出一致。
- 变量集支持导入与导出。

### 工作空间与 OpenAPI 同步

- 多工作空间，每个空间下挂多个服务：可新建、排序，也可从 Swagger/OpenAPI 入口页批量导入。
- 面向 Swagger 2.0 与 OpenAPI 3.0.x 文档，提供拉取、对比、确认、应用四段引导式同步流程。
- 合并只更新定义，永不覆盖你保存的参数值。
- 被同步移除的接口做软删除、可复活；文档抽屉直接展示同步定义侧的接口摘要、参数说明与响应结构。

### 可视化工作流

- 在画布上编排多步接口流程；执行由 Rust 引擎完成，进度实时推送到界面。
- 十一种节点——请求、提取、变量赋值、条件、并行与汇合、延迟、断言、重试——覆盖串行、分支与扇出。
- 提取值随执行写回变量分类，断言判定通过与否；每次执行前先校验，执行后留记录。
- 工作流可跨工作空间复制。

### CLI 与 Agent skill

- 随应用附带的 `apilot` CLI 在任意终端读取并执行当前工作空间的接口与工作流（见[命令行使用](#命令行使用)）。
- [`skills/apilot/`](./skills/apilot/SKILL.md) 提供英文 Agent skill，教编码 agent 使用 CLI。

## 下载安装

从[最新 Release](https://github.com/amadeus19/apilot/releases/latest) 下载安装包：

| 架构 | 推荐（NSIS） | 备选（MSI） |
| --- | --- | --- |
| x64 | `APilot_<version>_x64-setup.exe` | `APilot_<version>_x64_en-US.msi` |
| ARM64 | `APilot_<version>_arm64-setup.exe` | `APilot_<version>_arm64_en-US.msi` |

- NSIS `setup.exe` 是推荐下载；MSI 仅作手动安装备选。
- **ARM64 版本为实验性**：已完成构建与产物校验，但尚未在实体 ARM64 硬件上验证。
- 安装包未做代码签名，Windows SmartScreen 会弹出「Windows 已保护你的电脑」告警——点击**更多信息** → **仍要运行**即可继续。
- NSIS 安装器按当前用户安装，无需管理员权限、不弹 UAC；MSI 按整机安装，需要管理员权限。
- 需要 Windows 10 或 11 以及 WebView2 运行时（Windows 11 预装；NSIS 安装器在缺失时会自动下载）。

## 命令行使用

在 **设置 › 开发者 › 高级** 中开启 CLI，即可把 `apilot` 注册到当前用户的 PATH。CLI 与应用共享同一数据目录，任何一侧的改动对另一侧即时可见。

```bash
apilot --json project info
apilot --json api list                  # 只读查看
apilot --json api get "POST /login"
apilot --json api run "POST /login" --query verbose=1
apilot --json workflow validate <id>
apilot --json workflow run <id>
```

- `--json` 切换到稳定的 JSON 契约，配套明确的 exit code；敏感值默认掩码，需要查看具体值时显式传 `--show-secrets`。
- `--workspace <name-or-id>` 可为单条命令指定工作空间；切换当前工作空间在应用内完成。
- CLI 负责读取与执行；接口、工作流、变量的编辑都在应用内进行。

### Agent skill

把 `skills/apilot/` 整个文件夹拷贝进编码 agent 的 skills 目录（文件夹名不要改），例如 `~/.claude/skills/` 或 `~/.agents/skills/`。升级 APilot 后请重新从本仓库拉取，保持它与 CLI 契约一致。详见 [`skills/README.md`](./skills/README.md)。

## 从源码构建

前置条件：Node.js 22+、pnpm 10、Rust stable 工具链（MSVC target），运行于 Windows 10 或 11。

```bash
git clone https://github.com/amadeus19/apilot.git
cd apilot/app
pnpm install
pnpm tauri build
```

前端是根位于 `app/` 的 pnpm + Turbo 工作区；`pnpm tauri build` 会先构建 Web 产物，再构建 Rust 外壳。安装包输出到：

```text
app/apps/web/src-tauri/target/release/bundle/nsis/
app/apps/web/src-tauri/target/release/bundle/msi/
```

构建 ARM64 版本时追加 target triple：

```bash
pnpm tauri build --target aarch64-pc-windows-msvc
```

本地开发在 `app/` 下运行 `pnpm tauri dev`，Vite 与 Tauri 外壳会带热更新一起启动。

## 开源协议

[MIT](./LICENSE)
