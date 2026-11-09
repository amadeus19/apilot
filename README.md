# APilot

**A Windows-first desktop app for API debugging, endpoint testing, workspace management, and API workflows — built from scratch with Tauri 2, React, and Rust.**

English | [简体中文](./README.zh-CN.md)

[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4.svg)](#download-and-install)
[![Architecture](https://img.shields.io/badge/architecture-x64%20%7C%20ARM64-5C2D91.svg)](#download-and-install)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

<!-- TODO: screenshot -->

APilot keeps your API endpoints, environments, request history, and multi-step workflows in one local desktop app. Everything lives in a local SQLite database — no account and no cloud. The bundled `apilot` CLI reads the same data, so your coding agent can look up, call, and debug endpoints and run workflows straight from the terminal.

## Features

### HTTP debugging

- Compose requests with headers, query and path parameters, JSON / form / multipart bodies (including file uploads), and XML formatting; import from and export to cURL.
- Request-level and workspace-level authentication (Bearer, Basic, and more) with a two-level inheritance chain.
- Memory-tiered responses: small bodies stay in memory, large ones stream, oversized ones go to a temp file while the UI shows a preview. View and save text, image, PDF, and HTML responses, and follow Server-Sent Events as they stream in.
- Every request is recorded in a per-workspace history — search it, restore any run back into an editable draft, or clean up entries in batches.
- Per-endpoint timeout overrides on top of global HTTP settings (timeouts, redirects, TLS verification, proxy).

### Environments and variables

- Group variables into categories, activate the one you need, and reference them as `{{name}}` with editor autocomplete and hover resolution.
- A built-in fallback chain — active category, then global category, then `{{baseUrl}}` — with a variable preview that shows the effective value set.
- Secret variables are masked everywhere by default, in the app and in CLI output.
- Import and export variable sets.

### Workspaces and OpenAPI sync

- Multiple workspaces, each with its own services: create, reorder, and bulk-import them from a Swagger/OpenAPI entry page.
- Pull, diff, review, and apply definitions from Swagger 2.0 or OpenAPI 3.0.x documents in a guided four-step flow.
- Merging is value-preserving: sync updates definitions but never overwrites the parameter values you saved yourself.
- Removed endpoints are soft-deleted and can be revived, and a documentation drawer shows summaries, parameter docs, and response schemas straight from the synced definitions.

### Visual workflows

- Orchestrate multi-step API flows on a canvas; execution runs in a Rust engine and streams progress to the UI.
- Eleven node types — request, extract, set variable, condition, parallel and join, delay, assert, and retry — cover sequencing, branching, and fan-out.
- Extracted values are written back to variable categories as a run proceeds, assertions decide pass or fail, and every run is validated up front and recorded afterwards.
- Copy workflows between workspaces.

### CLI and agent skill

- The bundled `apilot` CLI reads and runs the current workspace's endpoints and workflows from any terminal (see [Use from the command line](#use-from-the-command-line)).
- An English agent skill under [`skills/apilot/`](./skills/apilot/SKILL.md) teaches coding agents to operate the CLI.

## Download and install

Grab the installers from the [latest release](https://github.com/amadeus19/apilot/releases/latest):

| Architecture | Installer |
| --- | --- |
| x64 | `APilot_<version>_x64-setup.exe` |
| ARM64 | `APilot_<version>_arm64-setup.exe` |

- The NSIS `setup.exe` is the only installer flavor.
- **ARM64 is experimental**: it is built and artifact-checked, but has not been verified on physical ARM64 hardware yet.
- Installers are not code-signed, so Windows SmartScreen shows a "Windows protected your PC" warning. Click **More info** → **Run anyway** to proceed.
- The NSIS installer is per-user: no administrator rights or UAC prompt required.
- Requires Windows 10 or 11 with the WebView2 Runtime (preinstalled on Windows 11; the NSIS installer downloads it automatically if missing).

## Use from the command line

Enable the CLI once in **Settings › Developer › Advanced**; this registers `apilot` on your user PATH. The CLI and the app share one data directory, so anything either side changes is immediately visible to the other.

```bash
apilot --json project info
apilot --json api list                  # read-only inspection
apilot --json api get "POST /login"
apilot --json api run "POST /login" --query verbose=1
apilot --json workflow validate <id>
apilot --json workflow run <id>
```

- `--json` switches to a stable JSON contract with defined exit codes; sensitive values stay masked unless you pass `--show-secrets`.
- `--workspace <name-or-id>` targets a single workspace for one command; switching the current workspace happens in the app.
- Every command operates on the current workspace — the CLI is for reading and running, while editing endpoints, workflows, and variables belongs to the app.

### Agent skill

Copy `skills/apilot/` into your coding agent's skills directory (keep the folder name), for example `~/.claude/skills/` or `~/.agents/skills/`. Re-pull it from this repository after upgrading APilot so it stays in sync with the CLI contract. See [`skills/README.md`](./skills/README.md) for details.

## Build from source

Prerequisites: Node.js 22+, pnpm 10, and a Rust stable toolchain with the MSVC target, on Windows 10 or 11.

```bash
git clone https://github.com/amadeus19/apilot.git
cd apilot/app
pnpm install
pnpm tauri build
```

The frontend is a pnpm + Turbo workspace rooted at `app/`; `pnpm tauri build` builds the web bundle first, then the Rust shell. The installers land in:

```text
app/apps/web/src-tauri/target/release/bundle/nsis/
```

For an ARM64 build, add the target triple:

```bash
pnpm tauri build --target aarch64-pc-windows-msvc
```

For development, run `pnpm tauri dev` from `app/` to start Vite and the Tauri shell with hot reload.

## License

[MIT](./LICENSE)
