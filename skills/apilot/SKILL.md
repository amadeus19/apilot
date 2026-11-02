---
name: apilot
description: Inspects and runs the API endpoints and workflows saved in Apilot, a desktop API debugging and testing tool, through the apilot CLI. Use when the user mentions Apilot, or wants to look up, call, or debug an endpoint, or run or validate a workflow, kept in their Apilot workspace — even if they only name the endpoint ("call the login API", "why does the checkout workflow fail"). Changes to endpoints, workflows, variables, and Swagger sync are made in the Apilot app.
compatibility: Requires Apilot installed on Windows with the CLI enabled in Settings › Developer › Advanced / 设置 › 开发者 › 高级, so that apilot is on PATH.
---

# Apilot CLI

## 1. What this covers

`apilot` reads and executes the data of an Apilot workspace:

- the workspace profile and its entity counts
- API endpoints: list, search, inspect, and run them with overrides
- workflows: list, inspect, validate, and run them

Apilot is a desktop app. Creating or changing endpoints, workflows, variables, and Swagger sync happens in the app, not through this CLI. When the user asks for a change, describe the edit and ask them to make it in Apilot. Workspace switching also belongs to the app; use `--workspace <name-or-id>` to target one workspace for a single command.

Two facts to rely on:

- The CLI and the app share one data directory. Edits made in the app are visible to the CLI immediately, and requests or workflows run through the CLI appear in the app's History.
- Every command operates on the current workspace unless `--workspace <name-or-id>` is passed.

## 2. Before you start

Run `apilot --version`. If the command is not found, ask the user to enable the CLI in Settings › Developer › Advanced / 设置 › 开发者 › 高级, then open a new terminal or restart the agent session so PATH is picked up.

Confirm the target workspace with `apilot --json project info`. It returns the workspace name, base URL, and counts of APIs, workflows, and variable categories. Pass `--workspace` when the user names a different workspace.

## 3. Ground rules

- Always pass `--json`. In JSON mode stdout contains exactly one JSON document and stderr stays empty. A process that exits with code 2 and prints nothing to stdout rejected the arguments; the reason is on stderr.
- Read-only commands (`project info`, `api list`, `api search`, `api get`, `workflow list`, `workflow get`, `workflow validate`) are safe to run at any time.
- For `api run`, GET, HEAD, and OPTIONS requests run directly. For any other HTTP method, and for every `workflow run`, confirm with the user first unless they already asked to run that endpoint or workflow in this turn, and state the target base URL and the likely side effects. Workflows write extracted values back to variable categories.
- Sensitive values stay masked by default; the mask is `***`. Add `--show-secrets` only when the user explicitly asks to see a specific value. Never write revealed secrets into files, commits, or logs.
- If `apilot` rejects a command or flag you believe exists (exit 2, stdout empty), the installed Apilot may be older than this skill. Tell the user and continue with what `apilot <group> <command> --help` shows.

## 4. Find and inspect endpoints

An endpoint id is either its stable key — `"METHOD /path"` with a space, quoted in the shell — or a UUID. For example `"GET /users/{id}"`.

- `apilot --json api list` returns every endpoint in tree order.
- `apilot --json api search <keyword>` filters by title, path, category name, or method (case-insensitive substring). Use it when the workspace has many APIs; a blank keyword is rejected.
- `apilot --json api get <id>` returns the full definition, including saved params, headers, and body. Add `--service <name>` when the same stable key exists in more than one service.

## 5. Run an endpoint

`apilot --json api run <id>` sends the request. Overrides are optional: `--param K=V` to replace path parameters, `--query K=V` to replace query values, `--header K=V` to replace headers (each may repeat), and `--body <json>` to replace the body entirely. Overrides are never saved back to the user's data.

- The command exits 0 whenever a response arrives, including 4xx and 5xx. Read `response.status` and the body to judge the outcome.
- The response body in the result is a truncated preview. Check `truncated` and `totalSize` before assuming you saw everything.
- There is no timeout flag. The request uses the timeout configured in the app (unlimited by default), so wrap calls that might hang in the agent's own command timeout.

End-to-end example:

```bash
# When the name is uncertain, list candidates first
apilot --json api list

# Find the endpoint
apilot --json api search login

# Inspect it; the id is the stable key "METHOD /path"
apilot --json api get "POST /login" --service "Auth"

# Run it, overriding a query value and the whole body
apilot --json api run "POST /login" --query verbose=1 --body '{"user":"demo"}'

# Read the answer: success means a response arrived, not 2xx
# {"success":true,"runId":"...","request":{"method":"POST","url":"..."},
#  "response":{"status":200,"body":{"excerpt":"...","truncated":false}}}
```

## 6. Workflows

- `apilot --json workflow list` lists workflows with id, name, last status, and whether they write back variables.
- `apilot --json workflow get <id>` returns the graph: nodes, edges, and per-node configuration. Sensitive header and value rows are masked.
- `apilot --json workflow validate <id>` returns `valid` plus an `issues` array. A workflow that fails validation still exits 0 — read `valid` and relay the issues instead of treating the command as failed.
- `apilot --json workflow run <id>` blocks until the workflow reaches a terminal state. A passed run exits 0. A failed run exits non-zero with the per-node detail in `error.details`.
- A run writes extracted values back to variable categories as it goes. If the process is killed mid-run, some values may already be written back and no execution record is saved.

## 7. Reading results

Successful commands use one of two shapes:

- a data envelope: `{"success":true,"data":...}`
- a top-level result that carries `success` alongside its own fields (`api run`, `workflow validate`, `workflow run`)

Failures use the error envelope: `{"success":false,"error":{"code":"...","message":"...","details":...}}`.

Ignore fields you do not recognize — new fields are added without breaking the contract. Treat an unknown error code according to its exit family.

| Exit | Meaning |
|------|---------|
| `0` | Success, including empty results and any HTTP status from `api run`. |
| `1` | General failure: internal, storage, or workflow evaluation errors. |
| `2` | Usage error: bad arguments or an unknown command. |
| `3` | A resource was not found or is ambiguous. |
| `4` | Execution failed: transport, timeout, or the workflow was rejected before running. |
| `5` | Permission denied. |
| `130` | Cancelled by the user (Ctrl+C). |

Read `references/output.md` when you need the exact JSON shape of a command. Read `references/errors.md` when you need to explain a failure and decide what to try next.

## 8. Flags and syntax

Global flags are accepted before or after the command: `--json`, `--show-secrets`, `--workspace <name-or-id>`.

For any command, `apilot <group> <command> --help` prints its arguments. Help text is in Chinese; the JSON contract is stable regardless of the help language.
