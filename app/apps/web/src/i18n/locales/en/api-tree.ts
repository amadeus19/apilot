/**
 * API tree view (consumed by features/api-tree).
 * 与 zh-CN 侧成对文件同步维护。
 */
export const apiTree = {
  // Tree rows
  pinnedGroup: 'Pinned',
  manualEndpoint: 'Manual endpoint',
  docService: 'Document URL configured (sync enabled)',
  // Service reachability probe (tree badge; reachable shows briefly then exits,
  // re-probe via the counts-row refresh-all button)
  probeReachable: 'Service reachable',
  probeUnreachable: 'Service unreachable',
  probeUnknown: 'Reachability unknown',
  probeProbing: 'Probing…',
  // Badge short labels (prototype form; tooltip keeps the full keys above)
  probeTagReachable: 'Up',
  probeTagUnreachable: 'Down',
  probeTagUnknown: 'Unknown',
  probeTagProbing: 'Probing',
  // Sync badge (small label by endpoint name; written on apply, cleared on next sync)
  syncBadgeNew: 'New',
  syncBadgeChanged: 'Changed',
  syncBadgeNewHint: 'Endpoint added in the last sync; badge clears on the next sync',
  syncBadgeChangedHint: 'Endpoint updated in the last sync; badge clears on the next sync',
  countLine: '{services} services · {endpoints} endpoints',
  // Expand / collapse all (trailing action of the left-panel search row)
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  // Search without results
  searchNoResults: 'No matching endpoints',
  searchNoResultsHint: 'Try another keyword, or clear the search to restore the full tree.',
  searchClear: 'Clear search',
  // Context-menu actions (action labels carry no trailing ellipsis, per copy conventions)
  open: 'Open',
  newService: 'New service',
  newEndpoint: 'New endpoint',
  newCategory: 'New category',
  syncService: 'Sync this service',
  /** Trailing reason badge shown when 'Sync this service' is disabled */
  syncServiceNoDoc: 'No doc URL',
  probeRefreshAll: 'Refresh reachability',
  edit: 'Edit',
  rename: 'Rename',
  pin: 'Pin',
  unpin: 'Unpin',
  moveUp: 'Move up',
  moveDown: 'Move down',
  delete: 'Delete',
  // Service form (new / edit share one dialog)
  serviceFormNewTitle: 'New service',
  serviceFormEditTitle: 'Edit service',
  serviceNameLabel: 'Service name',
  serviceDocUrlLabel: 'Document URL (optional)',
  serviceDocUrlPlaceholder: 'https://example.com/openapi.json',
  // Category form
  categoryFormNewTitle: 'New category',
  categoryFormRenameTitle: 'Rename category',
  categoryNameLabel: 'Category name',
  // Endpoint form
  endpointFormNewTitle: 'New endpoint',
  endpointFormRenameTitle: 'Rename endpoint',
  endpointMethodLabel: 'Method',
  endpointPathLabel: 'Path template',
  endpointPathPlaceholder: '/users/{id}',
  endpointTitleLabel: 'Endpoint title',
  // Delete confirmations (cascade scope spelled out)
  deleteEndpointTitle: 'Delete endpoint',
  deleteEndpointDescription:
    'This permanently deletes "{title}" along with its user data (body, params, headers) and pinned state. This cannot be undone.',
  deleteCategoryTitle: 'Delete category',
  deleteCategoryDescription:
    'This deletes the category "{title}"; its endpoints move up to the service scatter level. Endpoint data is unaffected.',
  deleteServiceTitle: 'Delete service',
  deleteServiceDescription:
    'This permanently deletes the service "{title}" with all its categories, endpoints, user data and pinned state. This cannot be undone.',
  deleteEndpointRefsCount: 'Referenced by {count} workflow(s):',
  confirmDelete: 'Delete',
  cancel: 'Cancel',
  save: 'Save',
  // Tree load failure (retry action)
  loadFailedTitle: 'Failed to load the API tree',
  loadFailedRetry: 'Retry',
} as const
