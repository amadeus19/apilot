/**
 * Workspace and services domain dictionary (en): left-panel two-level tree
 * (context actions, create / rename / delete / switch, service edit & delete,
 * bulk import wizard) plus the title-bar switcher.
 * 与 zh-CN 侧成对文件同步维护。
 */
export const workspace = {
  // —— Tree view (load-failed & search-empty states) ——
  loadFailedTitle: 'Failed to load workspaces',
  loadFailedRetry: 'Retry',
  searchNoResults: 'No matching workspaces or services',
  searchNoResultsHint: 'Try another keyword, or clear the search to restore the full tree.',
  searchClear: 'Clear search',

  // —— Tree & bottom action ——
  newWorkspace: 'New workspace',
  newService: 'New service',
  importEntry: 'Bulk import',
  /** No doc URL = manual-only container, skipped by sync */
  serviceNoDoc: 'No doc URL',

  // —— Workspace detail service list ——
  serviceSectionTitle: 'Services',
  serviceEmptyTitle: 'No services yet',
  serviceStatusHeader: 'Status',
  serviceActionsHeader: 'Actions',
  serviceListEmpty: 'No services yet. Create one or bulk import from docs.',

  // —— Row actions (menu items) ——
  actionSetCurrent: 'Set as current',
  /** Header badge for the current workspace (the set-current button shows otherwise) */
  currentBadge: 'Current',
  actionRename: 'Rename',
  actionEdit: 'Edit',
  actionDelete: 'Delete',

  // —— Double-click to set current (row gesture feedback) ——
  /** One-shot toast on success (action slot switches back to the previous workspace) */
  switchedToast: 'Switched to "{name}"',
  switchBack: 'Switch back',
  /** Workspace row title: double-click gesture hint */
  doubleClickHint: 'Double-click to set as current workspace',
  /** Chevron tooltip on workspace rows (chevron is the only expand/collapse hit zone) */
  expand: 'Expand',
  collapse: 'Collapse',

  // —— Sort actions (keyboard alternative to drag & drop) ——
  moveUp: 'Move up',
  moveDown: 'Move down',

  // —— Shared form copy ——
  cancel: 'Cancel',
  save: 'Save',

  // —— Workspace form and delete confirm ——
  wsNewTitle: 'New workspace',
  wsRenameTitle: 'Rename workspace',
  wsNameLabel: 'Name',
  /** Cascade scope made explicit: deletion accepts data loss */
  wsDeleteTitle: 'Delete workspace',
  wsDeleteDescription:
    'This permanently deletes "{name}" with all its services, endpoints and test data. This cannot be undone.',
  wsDeleteConfirm: 'Delete',

  // —— Service form and delete confirm ——
  serviceNewTitle: 'New service',
  serviceEditTitle: 'Edit service',
  serviceNameLabel: 'Service name',
  serviceDocUrlLabel: 'Doc URL',
  serviceDocUrlPlaceholder: '/swagger/v1/swagger.json (optional)',
  serviceDeleteTitle: 'Delete service',
  serviceDeleteDescription:
    'This permanently deletes "{name}" with its endpoint definitions and test data. This cannot be undone.',
  serviceDeleteConfirm: 'Delete',

  // —— Bulk import wizard (Swashbuckle entry page discovery) ——
  importTitle: 'Bulk import services',
  importEntryLabel: 'Entry page URL',
  importEntryPlaceholder: '/swagger or https://host/swagger',
  importEntryHint: 'Fetches the Swashbuckle entry page and discovers swagger document groups.',
  importDiscoverAction: 'Discover',
  importDiscovering: 'Discovering…',
  importFoundCount: 'Discovered {count} groups',
  /** Bulk-select a11y name on the groups step header (name-colliding rows are always excluded) */
  importSelectAll: 'Select all groups',
  /** Name collides with an existing service (unchecked by default; force-checking appends a counter on import) */
  importExistsBadge: 'Exists',
  importUrlExistsBadge: 'Duplicate URL',
  importImportAction: 'Import {count} services',
  importImporting: 'Importing…',
  importBack: 'Back',
} as const
