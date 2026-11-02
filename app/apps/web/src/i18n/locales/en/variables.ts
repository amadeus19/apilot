/**
 * Variables domain dictionary (en): left variables tree, variable config page
 * (key-value table + effective set), BaseUrl candidates and per-tab override,
 * auth-to-secret conversion, variable config tab title.
 * 落位约定：与 zh-CN 侧成对文件同步维护（键集合一致由编译期 satisfies 保证）。
 */
export const variables = {
  // Left panel · variables tree (two-layer tree: global categories on top + workspace ones; row menu and activation toggle)
  tree: {
    newCategory: 'New category',
    open: 'Open',
    activate: 'Activate',
    deactivate: 'Deactivate',
    rename: 'Rename',
    delete: 'Delete',
    copyVariable: 'Copy variable',
    moveUp: 'Move up',
    moveDown: 'Move down',
    loadFailedTitle: 'Failed to load variable categories',
    loadFailedRetry: 'Retry',
    emptyTitle: 'No variable categories',
    emptyDescription: 'Create a category to group environment variables and switch them as a set',
    /** Chevron tooltip on category rows (chevron is the only expand/collapse hit zone) */
    expand: 'Expand',
    collapse: 'Collapse',
    // Tree search empty result (clearing goes back to the left panel search box)
    searchNoResults: 'No matching categories or variables',
    searchNoResultsHint: 'Try another keyword, or clear the search to restore the full tree.',
    searchClear: 'Clear search',
  },
  // Rename category dialog
  renameDialog: {
    title: 'Rename category',
    description: 'The tree name and the config tab title update together',
    nameLabel: 'Category name',
    confirm: 'Rename',
    cancel: 'Cancel',
  },
  // New category dialog
  newCategoryDialog: {
    title: 'New variable category',
    description: 'A category is a set of environment variables switched together',
    nameLabel: 'Category name',
    namePlaceholder: 'Enter category name…',
    globalLabel: 'Global category',
    globalHint: 'Global categories back every workspace and cannot be activated',
    create: 'Create',
    cancel: 'Cancel',
  },
  // Variable config page (banner + key-value card)
  config: {
    activeBadge: 'Active',
    globalBadge: 'Global',
    activate: 'Activate',
    deactivate: 'Deactivate',
    renameCategory: 'Rename category',
    deleteCategory: 'Delete category',
    deleteConfirmTitle: 'Delete variable category',
    deleteConfirmDescription:
      'This deletes "{name}" and all its variables; if it is active, activation is cleared as well. This cannot be undone.',
    deleteConfirmAction: 'Delete',
    deleteConfirmPending: 'Deleting…',
    cancel: 'Cancel',
    keyColumn: 'Variable',
    valueColumn: 'Value',
    secretColumn: 'Secret',
    addVariable: 'Add variable',
    addDialogTitle: 'Add variable',
    addDialogDescription: 'Variable names must be unique within a category',
    addKeyLabel: 'Variable name',
    addKeyPlaceholder: 'Enter variable name…',
    addValueLabel: 'Value',
    addValuePlaceholder: 'Enter variable value…',
    addSecretLabel: 'Mark as Secret',
    addSecretHint: 'Secret variables are masked by default in views and outputs',
    add: 'Add',
    deleteVariable: 'Delete variable {key}',
    deletedToast: 'Deleted variable {key}',
    undoDelete: 'Undo',
    editKey: 'Edit variable name {key}',
    emptyVariables: 'No variables',
    emptyVariablesHint:
      'Use "Add variable" to create key-value pairs; they take effect as a set once the category is activated',
    // Secret value column: masked by default, eye toggles plaintext, copy yields plaintext
    showSecret: 'Show plaintext',
    hideSecret: 'Hide plaintext',
    copySecret: 'Copy plaintext',
    categoryMissing: 'Category does not exist or has been deleted',
    // Banner meta summary: variable count + effective-set participation
    metaVariableCount: '{count} variables',
    metaActiveChain: 'Highest priority in the effective set',
    metaNotInChain: 'Not activated; excluded from the effective set',
    metaGlobalChain: 'Global fallback in the effective set',
    effectivePreview: 'Effective preview',
  },
  // Effective preview panel (always masked, sources by fallback chain)
  effective: {
    priorityLabel: 'Effective priority',
    noActive: 'Not activated',
    finalLabel: 'Final set',
    sourceActive: 'Active category',
    sourceGlobal: 'Global',
    sourceBuiltin: 'Built-in',
    empty: 'No effective variables',
    searchPlaceholder: 'Search keys or values…',
    searchEmpty: 'No matching variables',
  },
  // Variable bulk transfer (category export / import + bulk add tab; export masked by default)
  transfer: {
    exportButton: 'Export JSON',
    importButton: 'Import variables',
    exportTitle: 'Export "{name}"',
    exportDescription: 'Copies JSON to the clipboard; paste it into another category to import',
    exportSecretLabel: 'Include Secret plaintext values',
    exportSecretHint:
      'Exports masked (***) by default; when checked the clipboard carries Secret plaintext — paste with care',
    exportCopy: 'Copy JSON',
    importTitle: 'Import variables',
    importDescription:
      'Paste exported JSON ({ "variables": […] } or a bare array) to import rows into this category',
    importPasteLabel: 'JSON content',
    importPastePlaceholder: 'Paste JSON…',
    importInvalidJson: 'Not valid JSON — check the pasted content',
    importInvalidJsonAt: 'Line {line} is not valid JSON — check the pasted content',
    importInvalidShape: 'JSON does not match the variable list shape (a key field is required)',
    importInvalidShapeAt:
      'Entry {index} does not match the variable list shape (a key field is required)',
    importMaskSkipped: 'Value looks like an export mask; not imported',
    importStrategyLabel: 'Duplicate keys',
    importStrategySkip: 'Skip (keep existing values)',
    importStrategyOverwrite: 'Overwrite (imported values replace existing)',
    importSubmit: 'Import',
    importRowError: '{key}: {message}',
    importDone: 'Imported {count} variables',
    modeSingle: 'Single',
    modeBulk: 'Bulk',
    bulkLabel: 'Bulk key-value pairs',
    bulkPlaceholder: 'token: abc123\nhost: https://api.example.com',
    bulkHint: 'One pair per line, split at the first colon; bulk rows are created as non-Secret',
    bulkSubmit: 'Add in bulk',
    bulkMissingColon: 'Missing "key: value" separator colon',
    bulkEmptyKey: 'No key before the colon',
    bulkDuplicate: 'Duplicate variable name (within this batch)',
    bulkRowError: 'Line {line}: {message}',
  },
  // Variable config tab title (rendered by TabBar; name = category name)
  tabTitle: 'Variables · {name}',
  // BaseUrl candidate dropdown (workspace settings page)
  baseUrlPicker: {
    openLabel: 'BaseUrl candidates',
    title: 'BaseUrl candidates',
    empty: 'No candidate URLs',
    addPlaceholder: 'Enter a new URL…',
    add: 'Add',
    remove: 'Delete candidate {url}',
  },
  // Per-tab BaseUrl switch (URL-row address block; in-memory tab session state, plain address picker)
  override: {
    buttonLabel: 'Switch BaseUrl',
    activeButtonLabel: 'BaseUrl switched to {url}',
    emptyBaseUrl: 'BaseUrl not configured',
    sessionSection: 'This session · all tabs',
    sessionEmpty: 'Not set · follows workspace',
    sessionClear: 'Clear session URL',
    pickSession: 'Set as session URL (all tabs): {url}',
    tabSection: 'This tab override',
  },
  // 环境快捷切换（地址栏环境块；激活分类＝环境整组切换）
  quickSwitch: {
    title: 'Environments',
    triggerLabel: 'Switch active environment',
    triggerActiveLabel: 'Current environment {name}, click to switch',
    noActive: 'None active',
    empty: 'No workspace categories yet',
    deactivateAll: 'Deactivate all',
  },
  // `{{` variable suggest popup (triggered by typing `{{` in editor inputs; Secret values always masked)
  suggest: {
    empty: 'No matching variables',
    listLabel: 'Variable suggestions',
  },
  // Hover variable resolution (closed {{key}} references show resolved value on hover, before sending)
  hover: {
    secretBadge: 'Secret variable',
    undefinedBadge: 'Undefined',
  },
  // Convert auth literal to Secret variable (inline entry in Auth tab)
  toSecret: {
    buttonLabel: 'Convert to Secret variable',
    noCategoryError: 'No variable category available',
    converted: 'Converted to Secret variable {key}',
  },
  // Variable resolution preview ("Sent request" tab; resolved info rides on the send response)
  preview: {
    title: 'Variable resolution',
    resolvedUrlLabel: 'Resolved URL',
    copyUrl: 'Copy resolved URL',
    missedBadge: 'Unresolved',
    secretBadge: 'Secret',
    empty: 'No variables consumed in this send',
  },
} as const
