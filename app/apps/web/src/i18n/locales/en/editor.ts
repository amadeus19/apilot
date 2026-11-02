/**
 * Endpoint tab editor (consumed by features/workbench).
 */
export const editor = {
  send: 'Send',
  // Button label while sending (clicking cancels the in-flight request)
  sendCancel: 'Cancel',
  // Body tab: type row (segment labels are protocol names, always English,
  // not localized), the none empty state and the text-kind tools
  // (formatting / word wrap)
  bodyEmpty: 'This request has no body',
  bodyFormat: 'Format',
  bodyFormatHintPlainText: 'Plain text needs no formatting',
  bodyFormatHintInvalidJson: 'Content is not valid JSON and cannot be formatted',
  bodyWordWrap: 'Word wrap',
  // "More" menu and delete confirmation (hard delete removes user data in
  // the same transaction; the cascade scope is spelled out in the copy)
  moreButton: 'More',
  deleteEndpoint: 'Delete',
  deleteConfirmTitle: 'Delete endpoint',
  deleteConfirmDescription:
    'This permanently deletes "{title}" along with its user data (body, params, headers) and pinned state. This cannot be undone.',
  deleteConfirmCancel: 'Cancel',
  deleteConfirmAction: 'Delete',
  // Request-level auth (Auth tab): seven pure-injection types (unsupported
  // types are never shown in the UI)
  authTypeLabel: 'Auth type',
  authTypeInherit: 'Inherit from workspace',
  authTypeNone: 'No auth',
  authTypeBearer: 'Bearer Token',
  authTypeBasic: 'Basic Auth',
  authTypeApiKeyHeader: 'API Key · Header',
  authTypeApiKeyQuery: 'API Key · Query',
  authTypeApiKeyCookie: 'API Key · Cookie',
  authInheritHint: 'Uses the auth configured in the workspace settings.',
  authNoneHint: 'This request is sent without authentication.',
  authTokenLabel: 'Token',
  authUsernameLabel: 'Username',
  authPasswordLabel: 'Password',
  authKeyLabel: 'Key',
  authValueLabel: 'Value',
  authFieldPlaceholder: 'Literal or {{variable}}',
  kvNamePlaceholder: 'Parameter',
  kvValuePlaceholder: 'Value',
  kvRemoveRow: 'Remove this row',
  kvRawModeHint:
    'This content cannot be parsed as key–value pairs and is being edited as raw text (saved as-is, no reformatting).',
  kvTypeLabel: 'Type',
  kvDescriptionLabel: 'Description',
  kvDescriptionPlaceholder: 'Description (for API doc sync)',
  // System file picker entry for file rows (picked path is stored in the row
  // value; the file name is displayed)
  kvPickFile: 'Choose File',
  // KV table column headers (host panes converge the type column away for Headers)
  kvColumnName: 'Parameter',
  kvColumnValue: 'Value',
  kvColumnType: 'Type',
  kvColumnDescription: 'Description',
  // Row enable toggle (disabled rows are kept in the draft but not sent)
  kvRowEnabled: 'Enable this row',
  // Drag handle (row reorder: native drag or Alt+↑/↓ on the handle)
  kvReorderLabel: 'Reorder',
  kvReorderHint: 'Drag or press Alt+↑/↓ to move this row',
  // Path parameter chip (row name matches a path template placeholder)
  kvPathChipHint: 'Path parameter: fills the path template placeholder, not the query string',
  // Bulk edit (tab toolbar toggle between table and one-pair-per-line text)
  kvBulkEdit: 'Bulk Edit',
  kvBulkHint: 'One "Parameter: Value" per line; existing rows only update the value',
  kvBulkApply: 'Apply',
  kvBulkCancel: 'Cancel',
  kvBulkMaskedHint: 'Sensitive values are masked; reveal them before bulk editing',
  settingsButton: 'Endpoint settings',
  settingsTitle: 'Endpoint settings',
  settingsClose: 'Close endpoint settings',
  entityTitleLabel: 'Title',
  entityCategoryLabel: 'Category',
  entityLockedHint: 'Title and category follow the synced document',
  categoryNone: 'Uncategorized',
  // Per-endpoint timeout override (user_data domain, drawer "Timeout" row):
  // null inherits the global setting / 0 disables the limit / >0 means seconds
  timeoutLabel: 'Request timeout',
  timeoutInherit: 'Inherit global',
  timeoutUnlimited: 'No limit',
  timeoutCustom: 'Custom',
  timeoutCustomLabel: 'Custom seconds',
  timeoutSecondsPlaceholder: '1–86400',
  breadcrumbLabel: 'Breadcrumb',
  breadcrumbLocateHint: 'Locate "{name}" in the API tree',
  draftLoadFailedTitle: 'Failed to load the draft',
  retry: 'Retry',
  // Draft tab (restored from history): promotion action and in-page notices
  saveAsEndpoint: 'Save as new endpoint',
  promotionNoService: 'No service to save into yet. Create a service first.',
  draftHeaderNotice:
    'Draft restored from history · not persisted until saved; discarded when closed',
  draftBodyTruncatedNotice:
    'The body exceeded the snapshot retention and only the truncated prefix is restored',
  headersMaskedHint: 'Sensitive header values are masked; the values are kept as-is',
  showSecrets: 'Show secrets',
  hideSecrets: 'Hide secrets',
  // Final URL preview row (read-only composition, same rules as the send side)
  finalUrlLabel: 'Final URL',
  finalUrlCopy: 'Copy final URL',
  previewNoBaseUrl: 'No workspace BaseUrl configured; set one in workspace settings before sending',
  previewInvalidBaseUrl: 'The workspace BaseUrl must start with http:// or https://',
  // Inline hint for an invalid path template shape (paired with the input's
  // error ring; valid shapes cover both relative paths and absolute URLs,
  // {name} placeholders are template syntax)
  pathInvalidHint:
    'The path must start with / or be a full http(s):// URL ({placeholder} supported); spaces and ? are not allowed',
  // cURL interop (copy action = toolbar button; import = more menu + paste dialog)
  copyAsCurl: 'Copy as cURL',
  curlImportMenu: 'Import from cURL',
  curlImportTitle: 'Import from cURL',
  curlImportDescription:
    'Paste a curl command to parse it into a new draft tab. Nothing is persisted until you save it as a new endpoint.',
  curlImportPlaceholder: "curl 'https://api.example.com/v1/users?page=1' …",
  curlImportCancel: 'Cancel',
  curlImportSubmit: 'Import',
  // Import rejection reasons ("Argument {position}" prefix is prepended by position)
  curlErrorAt: 'Argument {position}',
  curlErrorNotCurl: 'The command must start with curl.',
  curlErrorUnterminatedQuote: 'A quote is not closed.',
  curlErrorBadSyntax: 'The command cannot be parsed (e.g. a trailing backslash).',
  curlErrorMissingUrl: 'A URL argument is missing.',
  curlErrorMultipleUrl: 'Multiple URL arguments found.',
  curlErrorInvalidUrl: 'The URL must start with http:// or https://.',
  curlErrorUnsupportedFlag:
    'Unsupported option (only -X / -H / the -d family / --data-urlencode / -F and the URL are supported).',
  curlErrorMissingValue: 'This option is missing its value.',
  curlErrorBadMethod: 'The -X value must be one of the seven HTTP methods.',
  curlErrorBadHeader: '-H must be in the "Name: Value" form.',
  curlErrorFileSource: 'Using @file as the request data source is not supported.',
  curlErrorBadForm: '-F must be a field in the "name=value" or "name=@path" form.',
  curlErrorBadUrlencoded: '--data-urlencode must be in the "name=value" form.',
  curlErrorMixedBody: '-d and -F cannot be mixed.',
} as const
