# apilot error handling

Failures arrive in the error envelope. Use `error.code` for a precise diagnosis and the exit code to decide how to react. This page covers the common codes; a code not listed here still follows its exit family.

## Exit 1 — general failure

Common codes: `INTERNAL`, `DB_BUSY`, `DB_QUERY_FAILED`, `WORKFLOW_ASSERT_FAILED`, `WORKFLOW_EXTRACT_EVAL_FAILED`, `WORKFLOW_CONDITION_EVAL_FAILED`, `WORKFLOW_GRAPH_INVALID`.

- `DB_BUSY`: the database was locked. Retry once after a short pause.
- `INTERNAL`, or a database code other than `DB_BUSY`: report the message and stop; retrying the same command is unlikely to help.
- A workflow evaluation or assertion code means the workflow ran but a node's assertion, extraction, or condition failed. Read the per-node detail in `error.details` when present and relay the failing node, rule, and expected versus actual values.
- `WORKFLOW_GRAPH_INVALID`: the stored graph cannot be executed. Run `workflow validate` and relay the issues.

## Exit 2 — usage error

Common codes: `INVALID_ARGUMENT`, `NOT_IMPLEMENTED`.

- Check the argument names and values with `apilot <group> <command> --help`.
- A usage error with empty stdout came from the CLI parser, not from Apilot; the message on stderr names the offending argument.
- If a command or flag from this skill is rejected, the installed Apilot may be older than the skill. Tell the user and fall back to the help output.

## Exit 3 — not found or ambiguous

Common codes: `WORKSPACE_NOT_FOUND`, `ENDPOINT_NOT_FOUND`, `ENDPOINT_AMBIGUOUS`, `SERVICE_NOT_FOUND`, `WORKFLOW_NOT_FOUND`, `RUN_NOT_FOUND`.

- `WORKSPACE_NOT_FOUND`: the workspace name or id does not match. Ask the user for the exact value; the error does not reveal which workspaces exist.
- `ENDPOINT_NOT_FOUND`: search again with `api search <keyword>` and use the returned `id` verbatim.
- `ENDPOINT_AMBIGUOUS`: the stable key exists in several services. Pass `--service <name>` using one of the candidates in `error.details`.
- `SERVICE_NOT_FOUND`: the `--service` name does not match exactly; find the right service name in the workspace and retry.
- `WORKFLOW_NOT_FOUND`: the id does not exist in the selected workspace. Re-run `workflow list` and use its `id`.
- `RUN_NOT_FOUND`: no terminal workflow execution matches the id. Only completed, failed, or cancelled runs are stored.

## Exit 4 — execution failure

Common codes: `TIMEOUT`, `HTTP_REQUEST_FAILED`, `HTTP_SYNTHESIS_INVALID`, `WORKFLOW_NOT_EXECUTABLE`.

- `TIMEOUT` or `HTTP_REQUEST_FAILED`: check the workspace base URL, network reachability, and the timeout configured in the app.
- `HTTP_SYNTHESIS_INVALID`: the request could not be built from the endpoint definition and overrides. Inspect the endpoint with `api get` and check the override syntax.
- `WORKFLOW_NOT_EXECUTABLE`: validation refused the run. Read the `issues` in `error.details`, fix the workflow in the app, and validate again.

## Exit 5 — permission denied

`PERMISSION_DENIED` means the CLI policy rejected the command. Read and execute commands are allowed; write and dangerous commands are denied by default. Report this to the user; no CLI flag overrides the policy.

## Exit 130 — cancelled

`CANCELLED` means the user interrupted the run with Ctrl+C. A workflow may already have written back some values; tell the user that partial writeback is possible and that no execution record was saved.
