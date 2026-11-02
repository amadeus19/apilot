/**
 * Response pane (consumed by features/http: status line, three sections, error triage, SSE view);
 * paired with the zh-CN side file and kept in sync.
 */
export const response = {
  // Status line
  sending: 'Sending…',
  // Sending content-area placeholder (quiet hint: no action buttons — cancel lives in the address-bar button)
  waitingResponse: 'Waiting for response…',
  noResponse: 'No response',
  cancelled: 'Cancelled',
  // Three sections (Body / Headers stay untranslated per the never-translate list)
  sentRequest: 'Sent request',
  // Body view (Pretty / Raw stay untranslated)
  truncated: 'Truncated',
  // Tier badge (full body = the complete body is at hand; preview = prefix snippet only)
  tierFullMemory: 'Full body (memory)',
  tierFullFile: 'Full body (file)',
  tierPreview: 'Preview',
  tierFullMemoryHint: 'The full response body is held in memory',
  tierFullFileHint: 'The full response body is stored in a temp file',
  tierPreviewHint: 'Oversized responses keep only a prefix snippet and cannot be fully viewed',
  saveBody: 'Save',
  savedBody: 'Response body saved ({size})',
  saveCancelled: 'Save cancelled',
  loadFull: 'Load full',
  loadingFull: 'Loading {percent}%',
  backToPreview: 'Back to preview',
  sizeLimited: 'Full view is limited by size',
  toggleWrap: 'Word wrap',
  // Sent request section (redaction)
  showSecrets: 'Show secrets',
  hideSecrets: 'Hide secrets',
  copyUrl: 'Copy URL',
  copyAllHeaders: 'Copy all headers',
  copyAllHeadersHint: 'Sensitive header values are copied masked as ***',
  // Headers tab filter (substring, case-insensitive)
  headersFilterLabel: 'Filter headers',
  headersFilterPlaceholder: 'Filter headers…',
  headersFilterEmpty: 'No matching headers',
  // Header "save as variable" (row action + naming popover)
  headerVariable: {
    actionLabel: 'Save {name} as variable',
    title: 'Save as variable',
    nameLabel: 'Variable name',
    secretLabel: 'Secret',
    targetCategory: 'Into active category: {name}',
    overwriteHint: 'A variable with this name exists; saving updates its value',
    save: 'Save',
    noActiveCategory: 'No active category — activate one before saving',
    openVariables: 'Open variables view',
    savedToast: 'Saved as variable {key}',
  },
  // Error triage
  timeoutTitle: 'Request timed out',
  timeoutMessage: 'Terminated by the timeout setting',
  timeoutOpenSettings: 'Adjust timeout settings',
  errorTitle: 'Request failed',
  // SSE streaming view
  streamButton: 'Stream',
  streamStop: 'Stop',
  streamDone: 'Stream ended',
  streamCancelled: 'Stream cancelled',
  streamErrorTitle: 'Streaming failed',
  streamReceived: 'Received {size}',
  streamBackToLatest: 'Back to latest',
  // Empty-state "Send request" CTA (sends the current editor draft via the draft bridge)
  emptySendCta: 'Send request',
  // Preview view (renderable-type detection and hints)
  previewUnavailable:
    'Preview is only available for renderable types (HTML / images / PDF / text) — the current response is binary ({contentType}).',
  contentTypeNone: 'unknown type',
  previewFrameLabel: 'Response preview',
  // Format / charset selectors (view-layer concerns: highlighting, formatting availability, re-decoding)
  formatSelectorLabel: 'Body format',
  formatSelectorHint: 'Body format (affects highlighting and formatting availability)',
  charsetSelectorLabel: 'Body encoding',
  charsetSelectorHint: 'Body encoding (decodes the text again with this charset)',
  charsetDecodeFailed: 'Failed to decode as {charset}; showing UTF-8 instead.',
  // Endpoint doc preview drawer (data source = synced definition metadata; sync endpoints only)
  docButton: 'Endpoint docs',
  docTitle: 'Endpoint docs',
  docClose: 'Close the docs drawer',
  docLoading: 'Loading docs…',
  docLoadFailed: 'Failed to load docs; please retry',
  docEmpty: 'No doc data yet; generated on the first sync apply',
  docNoDescription: 'No description',
  docSummarySection: 'Summary',
  docParamsSection: 'Parameters',
  docParamLocation_path: 'Path parameters',
  docParamLocation_query: 'Query parameters',
  docParamLocation_header: 'Header parameters',
  docExamplePrefix: 'Example: ',
  docBodySection: 'Request body',
  docBodyNoFields: 'No field definitions',
  docBodyFormNoFields: 'Form request body (no field definitions)',
  docBodyExample: 'Request body example',
  docNoRequestBody: 'No request body',
  docResponsesSection: 'Responses',
  docResponseTrack: 'Presentation track',
  docTrackSample: 'Sample',
  docTrackStructure: 'Structure',
  docSourceDefined: 'Definition-side example',
  docSourceGenerated: 'Generated from schema',
  docResponseNoBody: 'No response body',
} as const
