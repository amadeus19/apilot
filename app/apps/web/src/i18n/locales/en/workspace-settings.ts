/**
 * Workspace detail page (workspace detail tab content): banner + centered
 * three cards (final layout); field labels are the semantic anchors, no
 * explanatory filler copy.
 */
export const workspaceSettings = {
  sectionBasic: 'General',
  sectionAuth: 'Authentication',
  nameLabel: 'Workspace name',
  baseUrlLabel: 'BaseUrl',
  baseUrlPlaceholder: 'https://api.example.com',
  authTypeLabel: 'Auth type',
  /** Empty state when the tab content pointer refers to a deleted/unreachable workspace */
  notFound: 'Workspace does not exist or has been deleted',
  // Save state echo: autosave must not be silent; saving / saved / failed always visible
  saveSaving: 'Saving…',
  saveSaved: 'Saved',
  saveFailed: 'Save failed',
  saveRetry: 'Retry',
  /** Inline validation for an empty name (empty names are not written; waiting for valid input) */
  nameEmptyError: 'Name cannot be empty',
  // Banner meta summary line (BaseUrl · auth type · service count)
  metaNoBaseUrl: 'No BaseUrl set',
  metaAuthNone: 'No auth configured',
  metaServicesCount: '{count} services',
} as const
