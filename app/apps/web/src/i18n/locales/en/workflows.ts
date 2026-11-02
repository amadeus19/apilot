/**
 * Workflow domain copy (fifth view / canvas editor / dialogs).
 * "Workflow" and "Join" are untranslated domain names.
 */
export const workflows = {
  // Fifth view
  emptyTitle: 'No workflows yet',
  emptyDescription:
    'Create a workflow to wrap a repeated sequence of API calls into one-click execution.',
  newWorkflow: 'New workflow',
  pasteWorkflow: 'Paste workflow',
  searchEmptyTitle: 'No matching workflows',
  searchClear: 'Clear search',
  newButton: 'New',
  newGroup: 'New group',
  rowRun: 'Run',
  rowStop: 'Stop',
  rowPin: 'Pin to status bar',
  rowUnpin: 'Unpin',
  rowMenuRename: 'Rename',
  rowMenuCopy: 'Copy',
  rowMenuDelete: 'Delete',
  rowMenuMoveUp: 'Move up',
  rowMenuMoveDown: 'Move down',
  rowMenuMoveToGroup: 'Move to group',
  rowMenuMoveOut: 'Move out of group',
  moveToGroupEmpty: 'No groups yet',
  runBlockedByIssues: 'This workflow has validation errors; open the editor to fix them first',
  runPassedToast: 'Workflow "{name}" passed',
  runFailedToast: 'Workflow "{name}" failed',
  rowRunningProgress: 'Running · {done}/{total}',
  copiedToast: 'Workflow "{name}" copied; switch workspaces to paste',
  pasteDisabledHint: 'Copy a workflow first (row context menu or editor toolbar)',

  // Groups (create / rename / delete / assign)
  groupCreateTitle: 'New group',
  groupCreateDescription: 'Groups fold workflows together; rename or delete them any time.',
  groupRenameTitle: 'Rename group',
  groupDeleteTitle: 'Delete group',
  groupDeleteDescription:
    'This deletes the group "{name}"; its workflows move to ungrouped and are not affected.',
  groupConfirm: 'Create',

  // Dialogs
  createTitle: 'New workflow',
  createDescription: 'Name it now; adjust any time in the editor.',
  nameLabel: 'Name',
  namePlaceholder: 'Enter workflow name',
  renameTitle: 'Rename workflow',
  createConfirm: 'Create',
  renameConfirm: 'Save',
  cancel: 'Cancel',
  deleteTitle: 'Delete workflow',
  deleteDescription: 'This deletes the workflow "{name}". This cannot be undone.',
  deleteConfirm: 'Delete',

  // Paste workflow (cross-workspace copy/paste)
  pasteDescription:
    'Paste "{name}" from the clipboard into this workspace; endpoint references resolve by stable key.',
  pasteNameSuffix: ' - Copy',
  pasteConfirm: 'Paste',
  pasteReportTitle: 'Pasted',
  pasteReportSummary: '{hits} endpoint references resolved · {misses} unresolved',
  pasteMissReasonNotFound: 'Endpoint not found in this workspace',
  pasteMissReasonAmbiguous: 'Same key exists in multiple services',
  pasteMissHint:
    'Unresolved nodes keep their stable keys and are marked invalid; open the editor to locate and rebind them.',
  pasteWritebackHint:
    'Categories written back to are not activated automatically; activate the target categories in the variables view after a run to make written values effective immediately.',
  pasteOpen: 'Open',
  pasteDone: 'Done',

  // Export / import (file distribution; import shares the paste resolve chain)
  rowMenuExport: 'Export',
  importWorkflow: 'Import workflow',
  exportedToast: 'Exported to {path}',
  importReportTitle: 'Imported',
  importMaskedHint:
    'Sensitive override values in the file were imported as masks and are unusable; open the editor to fill them in before running.',

  // Canvas editor
  canvasEmptyTitle: 'The canvas is empty',
  canvasEmptyHint: 'Right-click the canvas or use "Add node" below to start composing.',
  canvasEmptyDropHint: 'You can also drop an endpoint from the API tree to create a request node.',
  toolbarAddNode: 'Add node',
  toolbarAddNodeHint: 'Place a node on the canvas (or right-click the canvas)',
  toolbarSave: 'Save',
  toolbarSaveDirtyLabel: 'Save (unsaved changes)',
  toolbarCopy: 'Copy workflow',
  toolbarCopyHint: 'Copy the whole workflow to the in-app clipboard (pasteable across workspaces)',
  toolbarFitView: 'Fit view',
  toolbarAutoLayout: 'Auto layout',
  toolbarAutoLayoutHint: 'Tidy up node positions automatically (Ctrl+Shift+L)',
  toolbarMinimap: 'Minimap',
  toolbarMinimapOn: 'Hide minimap',
  toolbarMinimapOff: 'Show minimap',
  toolbarRun: 'Run',
  toolbarRunHint: 'Run workflow (F5)',
  toolbarStop: 'Stop',
  toolbarStopHint: 'Stop the running execution (Shift+F5)',
  toolbarUndo: 'Undo',
  toolbarUndoHint: 'Undo the last edit (Ctrl+Z)',
  toolbarRedo: 'Redo',
  toolbarRedoHint: 'Redo the undone edit (Ctrl+Y / Ctrl+Shift+Z)',

  // Node picker (right-click on blank canvas / floating toolbar "Add node")
  pickerSearchPlaceholder: 'Search blocks or nodes…',
  pickerEmpty: 'No matching nodes',
  tempNodeLabel: 'New node',
  nodeName: 'Name',

  // Canvas context menu (node / edge)
  canvasMenuCopy: 'Copy',
  canvasMenuPaste: 'Paste',
  canvasMenuRename: 'Rename',
  canvasMenuDelete: 'Delete',
  canvasMenuSelectAll: 'Select all',
  canvasMenuAutoLayout: 'Auto layout',
  canvasMenuRebind: 'Rebind from API tree',

  // Bottom console (validation / execution tab container)
  consoleTabValidation: 'Validation',
  consoleTabExecution: 'Execution',
  consoleCollapse: 'Collapse console',
  consoleExpand: 'Expand console',

  // Execution panel and execution visuals
  executionDuration: '{ms} ms',
  executionStatusPassed: 'Passed',
  executionStatusRunning: 'Running',
  executionStatusFailed: 'Failed',
  executionStatusQueued: 'Queued',
  executionStatusSkipped: 'Skipped',
  executionStatusCancelled: 'Cancelled',
  executionWritebackEntry: 'to "{category}" · value {value}',
  executionWritebackHint:
    'Writebacks do not activate categories; activate the target categories in the variables view for variable resolution to take effect immediately.',

  // Pre-execution validation (error list and locating)
  validationMissingStart: 'Start node is missing',
  validationOrphanNode: 'Node "{name}" is not connected to any edge',
  validationInvalidEdge: 'Invalid edge (source "{name}")',
  validationCycle: 'A cycle exists; execution would never terminate',
  validationConditionDefaultMissing: 'Condition node "{name}" lacks a Default outlet',
  validationParallelNoBranch: 'Parallel node "{name}" has no branches',
  validationJoinNoUpstream: 'Join node "{name}" does not converge any branch',
  validationRequestUnbound: 'Request node "{name}" is not bound to an endpoint',
  validationRequestInvalidRef: 'Endpoint referenced by request node "{name}" no longer exists',
  validationExpressionInvalid: 'Expression of condition node "{name}" cannot be parsed',
  validationVariableRefInvalid: 'Request node "{name}" contains an invalid variable reference',
  validationUpstreamNotRequest: 'Upstream of node "{name}" must be a request node',
  validationExtractRowInvalid: 'Extract node "{name}" lacks a product name',
  validationExtractWritebackIncomplete: 'Writeback branch of extract node "{name}" is incomplete',
  validationNodeReferenceAmbiguous:
    'The reference is ambiguous when multiple upstream nodes produce an output with the same name',

  // Invalid reference and rebinding
  requestInvalidHint: 'The referenced endpoint no longer exists.',
  requestRebindHint: 'Drag an endpoint from the API tree onto this node to rebind.',

  // Extract node (single source, multiple rules: source picked once per node,
  // value path and product name per rule)
  extractSourceLabel: 'Source',
  extractSourceJsonPath: 'Body',
  extractSourceHeader: 'Response header',
  extractSourceStatusCode: 'Status code',
  extractSourceText: 'Response text',
  extractPathLabel: 'Value path',
  extractPathPlaceholder: 'e.g. $.data.token',
  extractPathNotNeeded: 'No path',
  extractNameLabel: 'Product name',
  extractNamePlaceholder: 'e.g. token',
  extractAddRule: 'Add rule',
  extractRemoveRule: 'Remove rule',
  extractBulkEdit: 'Bulk edit',
  extractBulkHint: 'One "product: path" pair per line; same-name products update the path only',
  extractBulkApply: 'Apply',
  extractBulkCancel: 'Cancel',
  extractUpstreamHint:
    'The upstream must be a request node; the product is read from its response. Products are referenced downstream as {{product}} (resolved via the connection).',

  // Extract node writeback branch (variable storage merged into extraction)
  writebackLabel: 'Store variables',
  writebackProductLabel: 'Writeback value',
  writebackProductPlaceholder: 'Choose a product',
  writebackProductEmpty: 'Fill in the product name first',
  writebackCategoryLabel: 'Target category',
  writebackCategoryPlaceholder: 'Choose a variable category',
  writebackSecretLabel: 'Sensitive value',

  // Assert node (row-based rules with AND combination)
  assertRulesLabel: 'Assert rules',
  assertAddRule: 'Add rule',
  assertRuleStatusCode: 'Status code equals',
  assertRuleJsonPath: 'JSONPath expected value',
  assertRuleExists: 'Exists',
  assertRuleContains: 'Contains',
  assertExpectedStatusCode: 'e.g. 200',
  assertExpectedValue: 'Expected value',
  assertContainsValue: 'Contains text',
  assertPathPlaceholder: 'e.g. $.data.token',
  assertContainsPathPlaceholder: 'Value path (empty checks the response body)',
  assertRuleCount: '{count} rules',
  assertHint: 'All rules must pass; assertions apply to the upstream request response.',
  assertExpectedActual: 'Expected {expected} · Actual {actual}',
  assertActualOnly: 'Actual {actual}',

  // Condition node (branch expressions and Default fallback)
  conditionBranchesLabel: 'Condition branches (IF / ELSE IF)',
  conditionAddBranch: 'Add branch',
  conditionRemoveBranch: 'Remove branch',
  conditionBranchEmpty: 'No expression set',
  conditionExpressionPlaceholder: 'e.g. {{login.status}} == 200',
  conditionReferenceHint:
    'Use {{node.status}} (status code) and {{node.body}} (raw response) to reference reachable upstream request nodes.',
  conditionHint: 'Evaluated in order; the first matching branch takes its exit.',
  conditionDefaultHint: 'If nothing matches, the Default exit is taken.',
  branchDefault: 'Default',

  // Join / Parallel / Delay / Retry nodes
  joinModeLabel: 'Convergence mode',
  joinModeAll: 'Wait for all branches',
  joinModeAny: 'Any branch completes',
  joinHint: 'Converges parallel branches before continuing downstream.',
  delayDurationLabel: 'Wait duration (ms)',
  delayDurationShort: '{ms} ms',
  delayHint: 'Waits for a fixed duration, then continues downstream.',
  retryAttemptsLabel: 'Max retry attempts',
  retryIntervalLabel: 'Retry interval (ms)',
  retrySummary: '{attempts} × {interval} ms',
  retryHint:
    'Does not run on its own; it applies to the directly connected downstream node and retries it on failure with the configured attempts and interval.',

  // 请求节点：引用态与参数覆写（与 zh-CN 词条同批维护）
  requestUnbound: 'Unbound',
  requestBindHint: 'Drag an endpoint from the API tree onto this node to bind it.',
  requestEndpoint: 'Endpoint',
  overridePath: 'Path parameters',
  overrideQuery: 'Query parameters',
  overrideBody: 'Body override',
  overrideBodyPlaceholder: 'Raw request body; empty follows the endpoint',
  overrideNamePlaceholder: 'Name',
  overrideValuePlaceholder: 'Value',
  requiredMarkTitle: 'Required parameter',
  valueCandidatesLabel: 'Insert extract reference',
  overrideTimeoutLabel: 'Timeout (ms)',
  overrideTimeoutPlaceholder: 'Empty follows endpoint and global',
  requestTimeoutSummary: 'Timeout {ms} ms',
  addRow: 'Add row',
  removeRow: 'Remove row',

  closeConfirmTitle: 'Unsaved changes',
  closeConfirmDescription: '"{names}" has unsaved changes. Save before closing?',
  closeConfirmSave: 'Save and close',
  closeConfirmDiscard: 'Close without saving',

  // Node kinds (name / group / picker descriptions)
  groupFlow: 'Flow',
  groupRequest: 'Request',
  groupData: 'Data',
  groupLogic: 'Logic',
  groupControl: 'Control',
  nodeStart: 'Start',
  nodeEnd: 'End',
  nodeRequest: 'Request',
  nodeExtract: 'Extract',
  nodeCondition: 'Condition',
  nodeParallel: 'Parallel',
  nodeJoin: 'Join',
  nodeDelay: 'Delay',
  nodeRetry: 'Retry',
  nodeAssert: 'Assert',

  // One-line descriptions shown in the node picker
  nodeDescStart: 'Where the flow begins',
  nodeDescEnd: 'Where the flow ends',
  nodeDescRequest: 'Send an HTTP request and read the response',
  nodeDescExtract: 'Extract data from the upstream response, optionally stored as variables',
  nodeDescCondition: 'Route the flow by an expression',
  nodeDescParallel: 'Run multiple branches in parallel',
  nodeDescJoin: 'Wait for parallel branches to converge',
  nodeDescDelay: 'Wait for a fixed duration',
  nodeDescRetry: 'Retry the downstream node on failure',
  nodeDescAssert: 'Check the upstream response against expectations',
} as const
