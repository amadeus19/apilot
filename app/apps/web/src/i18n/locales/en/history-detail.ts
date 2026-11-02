/**
 * History detail tab (read-only full record).
 */
export const historyDetail = {
  // Read-only notice (always at the top: the record is display-only; the
  // restore action only produces an in-memory draft copy)
  readOnlyNotice: 'Read-only record: shows everything about this run; restore it as a draft',
  // Restore action (disabled when the snapshot is missing)
  restoreAsDraft: 'Restore as draft',
  // State badge
  statePassed: 'Passed',
  stateFailed: 'Failed',
  stateCancelled: 'Cancelled',
  copyRunId: 'Copy run ID',
  // Summary table
  methodLabel: 'Method',
  urlLabel: 'URL',
  durationLabel: 'Duration',
  sourceLabel: 'Source',
  timeLabel: 'Time',
  errorCodeLabel: 'Error code',
  // Sections
  sectionSummary: 'Summary',
  sectionRequest: 'Sent request',
  requestBody: 'Request body',
  sectionResponse: 'Response snapshot',
  noSnapshot: 'Snapshot missing',
  noResponse: 'No response snapshot',
  // Error card (failed; TIMEOUT reuses the response pane copy) and cancelled neutral card
  errorCardTitle: 'Request failed',
  cancelledCard: 'The request was cancelled before completion; no response snapshot was kept',
  // Record not found (pruned by the retention cap)
  notFoundTitle: 'Record not found',
  notFoundDescription: 'This run record may have been pruned',
} as const
