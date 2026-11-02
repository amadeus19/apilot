/**
 * Request history view (consumed by features/history: flat list, search, refresh, selection and batch delete).
 */
export const history = {
  loadMore: 'Load more',
  refresh: 'Refresh',
  loading: 'Loading…',
  // Source chip (GUI / CLI records shown together)
  sourceGui: 'GUI',
  sourceCli: 'CLI',
  // Relative time tiers (plural node branches on count)
  relativeSeconds: { one: '{count} second ago', other: '{count} seconds ago' },
  relativeMinutes: { one: '{count} minute ago', other: '{count} minutes ago' },
  relativeHours: { one: '{count} hour ago', other: '{count} hours ago' },
  relativeDays: { one: '{count} day ago', other: '{count} days ago' },
  // Search without matches
  searchNoResults: 'No matching records',
  searchNoResultsHint: 'Try another keyword, or clear the search to see the full list.',
  searchClear: 'Clear search',
  // List load failure (retry action)
  loadFailedTitle: 'Failed to load history',
  loadFailedRetry: 'Retry',
  // Selection management: row checkbox accessibility label
  selectRow: 'Select this record',
  // Status chip words (cancelled / failed terminals carry no status code)
  statusCancelled: 'Cancelled',
  statusFailed: 'Failed',
  // Footer status bar (always visible): tri-state select-all, selection count, delete, total count
  selectAllVisible: 'Select all',
  deselectAll: 'Deselect all',
  selectedCount: '{count} selected',
  deleteSelected: 'Delete',
  loadedCount: '{count} in total',
  // Context menu (open / copy URL / delete)
  menuOpen: 'Open details',
  menuCopyUrl: 'Copy URL',
  menuDelete: 'Delete',
  // Delete confirmation (destructive)
  cancel: 'Cancel',
  confirmDelete: 'Delete',
  deleteConfirmTitle: 'Delete history records',
  deleteConfirmDescription: {
    one: 'Permanently delete {count} history record. Deleted records cannot be viewed again.',
    other: 'Permanently delete {count} history records. Deleted records cannot be viewed again.',
  },
} as const
