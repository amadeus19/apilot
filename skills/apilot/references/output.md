# apilot JSON output reference

All examples assume `--json`. Every command prints one JSON document on stdout and exits with one of the codes listed in `SKILL.md`. Key order and extra fields may vary; the key sets below are stable, and unknown fields must be ignored.

## Shared envelopes

Data-envelope commands wrap their payload in `data`:

```json
{"success": true, "data": null}
```

Top-level commands (`api run`, `workflow validate`, `workflow run`) put their fields next to `success`.

Errors:

```json
{"success": false, "error": {"code": "ENDPOINT_NOT_FOUND", "message": "endpoint not found: GET /missing", "details": null}}
```

`details` is always present; it is `null` when there is nothing extra to report.

## project info

`data` fields: `name`, `baseUrl` (nullable), `apis`, `workflows`, `environments`. The counts refer to the selected workspace.

## api list

`data` is an array; each item has `id`, `name`, `method`, `path`, `service`, `category` (nullable), and `pinned`. An empty array is a successful result.

## api search

`data` has the same array shape as `api list`, filtered by the keyword. No matches yields an empty array, not an error.

## api get

`data` fields: `id`, `name`, `method`, `path`, `service`, `category` (nullable), `manual` (true for endpoints created by hand rather than synced), `params`, `headers`, `body` (nullable).

`params` and `headers` are arrays of `{"name": ..., "value": ...}`. A sensitive header value is rendered as `***` unless `--show-secrets` is passed. If a stored value cannot be parsed, that field falls back to its raw string.

## api run

Top-level fields: `success`, `runId`, `request`, `response`, `extracted`, `assertions`.

`request` has `method`, `url`, and `headers` (array of `name` and `value`). `response` has `status`, `durationMs`, `headers`, and `body`; `body` has `excerpt`, `truncated`, `totalSize`, and `contentType` (nullable).

`success` is true whenever a response arrived, including 4xx and 5xx. The request URL and headers are masked by default; `--show-secrets` reveals them. Response content is server data and is not masked. `extracted` and `assertions` are present but empty for a single endpoint run.

## workflow list

`data` has one field, `items`, an array of `id`, `name`, `groupId` (nullable), `lastStatus` (nullable), `hasWriteback`, and `updatedAt`.

## workflow get

`data` fields: `id`, `workspaceId`, `name`, `graph`, `groupId` (nullable), `createdAt`, `updatedAt`.

`graph` has `schemaVersion`, `nodes`, and `edges`. A node has `id`, `name`, `position` (`x`, `y`), and `config`; the config shape depends on the node type. An edge has `id`, `source`, `target`, and `label` (nullable). Sensitive override rows are masked unless `--show-secrets` is passed.

## workflow validate

Top-level fields: `success`, `valid`, `issues`. Each issue has `code`, `message`, and usually `nodeId`. Validation problems are data: `valid` may be false while the process exits 0.

## workflow run

Top-level fields: `success`, `runId`, `workflowId`, `status`, `startedAt`, `completedAt`, `durationMs`, `errorCode`, `errorMessage`, `nodes`.

A passed run exits 0 with `success` true and `status` `"passed"`. A failed run exits non-zero; the same payload moves to `error.details`. `status` is `"passed"`, `"failed"`, or `"cancelled"`; individual nodes may also be `"skipped"`.

Each node has `nodeId`, `status`, `startedAt`, `completedAt`, `durationMs`, `errorCode`, `errorMessage`, `output`, `request`, `response`, `writebacks`, and `assertions`. `request` (`method`, `url`) and `response` (`status`, `body`) are null for nodes that do not send HTTP. A writeback has `key`, `categoryName`, `secret`, and `value`; an assertion has `ruleKind`, `path`, `expected`, `actual`, and `passed`.

Values produced by a workflow run are masked when the execution record is written, so `--show-secrets` does not reveal them.

## run status

`data` fields: `runId`, `workflowId`, `status`, `startedAt`, `completedAt`, `durationMs`, `errorCode`. Use it to recover the terminal record of a workflow run by its `runId`; only workflow executions are stored, and in-flight runs have no record.
