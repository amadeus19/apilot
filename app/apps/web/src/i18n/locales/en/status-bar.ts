/**
 * Status bar: workspace / sync / pinned-workflow segments; sync tiers aggregate
 * the sync wizard run state (no idle copy — the segment is not rendered
 * when no sync ran this session). The pinned segment is the only clickable
 * one (click runs the pinned workflow). Keep in sync with the zh-CN counterpart.
 */
export const statusBar = {
  workspaceNotSelected: 'No workspace selected',
  syncRunning: 'Syncing…',
  syncDone: { one: 'Synced {count} service', other: 'Synced {count} services' },
  syncPartialFailed: 'Synced {synced} · Failed {failed}',
  syncFailed: 'Sync failed',
  pinnedRun: 'Run pinned workflow',
} as const
