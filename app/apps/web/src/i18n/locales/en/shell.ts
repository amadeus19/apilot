/**
 * App Shell copy.
 */
export const shell = {
  workspaceSwitcherLabel: 'Workspace',
  workspaceSwitcherEmpty: 'No workspace yet',
  workspaceSettingsEntry: 'Workspace settings',
  panelToggle: 'Toggle side panel',
  syncButton: 'Sync',
  settingsButton: 'Settings',
  themeToggleToDark: 'Switch to dark',
  themeToggleToLight: 'Switch to light',
  themeToggleHint: 'Toggle theme (follow system is in Settings)',
  minimize: 'Minimize',
  maximize: 'Maximize',
  restore: 'Restore',
  close: 'Close',

  viewApis: 'API tree',
  viewHistory: 'Request history',
  viewVariables: 'Variable tree',
  viewWorkspaces: 'Workspaces',
  viewWorkflows: 'Workflows',
  leftNavLabel: 'Left panel views',
  panelResizeLabel: 'Resize left panel',
  panelCollapseLabel: 'Collapse left panel',
  panelExpandLabel: 'Expand left panel',

  searchApisPlaceholder: 'Search APIs',
  searchHistoryPlaceholder: 'Search request history',
  searchVariablesPlaceholder: 'Search variables',
  searchWorkspacesPlaceholder: 'Search workspaces',
  searchWorkflowsPlaceholder: 'Search workflows',

  apisEmptyTitle: 'No services yet',
  apisEmptyDescription:
    'Create a service in the current workspace, or sync API definitions from its document URL.',
  apisCreateService: 'New service',
  // Empty states (consumed by the API tree / request history panels)
  historyEmptyTitle: 'No request history yet',
  historyEmptyDescription: 'Send a request to see its history here',
  historyEmptyCta: 'Send your first request',

  searchClearInput: 'Clear search',
  tabbarLabel: 'Tabs',
  tabbarEmpty: 'No open tabs',
  welcomeDescription: 'Open or create an API from the sidebar to start debugging',
  responseResizeLabel: 'Resize response panel',
  responseTitle: 'Response',
  responseCollapseLabel: 'Collapse response panel',
  responseEmptyDescription: 'Send a request to see the response here',
  responseStatusLabel: 'Response panel collapsed',
  responseExpandLabel: 'Expand response panel',

  bootErrorTitle: 'Database unavailable',
  bootErrorDescription:
    'The app data file is corrupted or unreadable. Loading has stopped to protect your data. Open the log directory for diagnostics.',
  bootErrorOpenLogs: 'Open log directory',
  bootErrorRetry: 'Retry',
} as const
