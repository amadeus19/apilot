/**
 * Settings panel: group names, setting rows and action copy for the 8-group information architecture.
 */
export const settings = {
  title: 'Settings',
  description: 'App preferences and feature configuration',
  searchPlaceholder: 'Search settings…',

  navGeneral: 'General',
  navGeneralDesc: 'App behaviors such as window closing',
  navAppearance: 'Appearance',
  navAppearanceDesc: 'Theme and accent color',
  navLanguage: 'Language',
  navLanguageDesc: 'UI display language',
  navKeybindings: 'Keybindings',
  navKeybindingsDesc: 'Customize command shortcuts',
  navHttp: 'HTTP',
  navHttpDesc: 'Timeout, redirects, TLS and proxy',
  navBackup: 'Backup',
  navBackupDesc: 'Export and restore all data manually; backups contain plaintext credentials',
  navDeveloper: 'Developer',
  navDeveloperDesc: 'Diagnostics and debugging tools',
  advancedTitle: 'Advanced',
  cliLabel: 'Command line interface',
  cliDescription: 'Interact with Apilot from the command line',
  cliDialogTitle: 'Set up the CLI for your terminal',
  cliDialogDescription:
    'Register "apilot" in your PATH so that the "apilot" command is available anywhere in your terminal',
  cliSkip: 'Skip',
  cliRegister: 'Register',
  cliRegistering: 'Registering…',
  cliRegisteredToast: 'Registered. Restart your terminal for it to take effect',
  cliRegisteredDevToast:
    'Registered the dev build directory. Restart your terminal to apply (re-register after installing a release build)',
  cliRetry: 'Retry',
  cliCancel: 'Cancel',
  cliStatusVersion: 'Version',
  cliStatusPath: 'Path',
  cliStatusPathEnv: 'PATH',
  cliCopyPath: 'Copy CLI path',
  cliStatusLoading: 'Checking…',
  cliStatusFailed: 'Could not get CLI status',
  cliBinaryUnavailable: 'CLI binary is unavailable. Repair the installation or reinstall the app',
  cliDevBuildWarning: 'Development build directory. Re-register after installing a release build',
  cliPathRegistered: 'Registered',
  cliPathUnregistered: 'Not registered',
  cliShadowedUnregistered: 'The apilot in your terminal comes from {dir}',
  cliShadowedRegistered:
    'Your terminal resolves apilot from {dir} first. Copy the CLI path to run it directly',
  cliStaleHint:
    'PATH also has stale entries containing apilot.exe (left over from an old install; harmless)',
  navAbout: 'About',
  navAboutDesc: 'Version and license',

  searchNoResults: 'No matching settings',

  // General group (close button behavior)
  closeBehaviorLabel: 'Close button behavior',
  closeBehaviorDesc: 'What happens when the window close button is clicked',
  closeBehaviorAsk: 'Ask every time',
  closeBehaviorTray: 'Minimize to tray',
  closeBehaviorExit: 'Exit the app',

  // Close confirmation dialog (shown for close requests in ask mode;
  // Esc / clicking outside cancels — no action bound)
  closeConfirmTitle: 'Close APilot?',
  closeConfirmDesc:
    'Choose what the close button does; you can change it later under Settings → General → Close button behavior.',
  closeConfirmTray: 'Minimize to tray',
  closeConfirmExit: 'Exit the app',
  closeConfirmRemember: 'Remember my choice',

  themeLabel: 'Theme',
  themeDesc: 'Choose light, dark, or follow the system',
  themeLight: 'Light',
  themeDark: 'Dark',
  themeSystem: 'Follow system',
  themeSystemResolved: 'System resolves to: {value}',
  accentLabel: 'Accent color',
  accentDesc: 'Instant switching of the UI primary color',
  accentIndigo: 'Indigo',
  accentTeal: 'Teal',
  accentViolet: 'Violet',
  accentOrange: 'Orange',
  accentRose: 'Rose',
  accentGraphite: 'Graphite',

  languageLabel: 'UI language',
  languageDesc: 'Applies instantly, no restart needed',
  languageZh: '中文',
  languageEn: 'English',
  languageSystem: 'Follow system',
  languageResolved: 'Resolves to: {value}',

  httpTimeoutLabel: 'Timeout',
  httpTimeoutDesc: 'Maximum time to wait for a response before failing the request',
  httpTimeoutUnlimited: 'No limit',
  httpTimeoutOption: '{seconds}s',
  httpRedirectLabel: 'Follow redirects',
  httpRedirectDesc: 'Follow 3xx redirects automatically (up to 10)',
  httpTlsLabel: 'Verify TLS certificates',
  httpTlsDesc: 'When off, self-signed or invalid certificates are accepted',
  httpProxyLabel: 'Proxy',
  httpProxyDesc: 'Send requests through a proxy; supports http / https / socks5',
  httpProxyNone: 'No proxy',
  httpProxyCustom: 'Custom',
  httpProxyUrlLabel: 'Proxy address',
  httpProxyUrlPlaceholder: 'socks5://127.0.0.1:1080',

  // Backup group (manual export / restore)
  backupExport: 'Export backup',
  backupExportDesc: 'Export all data into a single backup archive',
  backupExportDone: 'Backup exported ({size}): {path}',
  backupRestore: 'Restore backup',
  backupRestoreDesc: 'Restore data from a backup archive; takes effect after restart',
  backupRestoreConfirmTitle: 'Restore this backup?',
  backupRestoreConfirmDesc:
    'Restoring rolls workspaces, endpoints, variables and the rest of your data back to the backup point; settings and request history are kept. This cannot be undone — consider exporting the current data first. A restart is required afterwards.',
  backupRestoreConfirmAction: 'Restore',
  backupCancel: 'Cancel',
  // Restart confirmation modal after the restore is staged: makes "a restart is
  // required to continue" and the write-loss window explicit
  backupRestartTitle: 'Restore accepted',
  backupRestartDesc:
    'It takes effect after the app restarts. Data written between now and the restart will be replaced by the backup contents — restart soon.',
  backupRestartAcknowledge: 'Got it',
  backupRestartNow: 'Restart now',

  devModeLabel: 'Developer mode',
  devModeDesc: 'F12 opens DevTools when enabled',
  logLevelLabel: 'Log level',
  logLevelDesc: 'Minimum level written to log files and the diagnostic buffer',
  copyDiagnostics: 'Copy diagnostics',
  workbenchDiagnostics: 'Workbench diagnostics',
  workbenchDiagnosticsDesc: 'Open tab count: {tabs}, registered commands: {commands}',
  copyDiagnosticsDesc: 'Version, system and runtime summary',
  copyDiagnosticsDone: 'Diagnostics copied',
  copyDiagnosticsFailed: 'Copy failed; copy manually instead',
  openLogDir: 'Open log directory',
  openLogDirDesc: 'Where the rolling log files live',
  logDirLabel: 'Log directory',
  logDirChange: 'Change folder',
  logDirReset: 'Reset to default',
  logDirRestart: 'Log directory updated; restart the app to apply',
  updateSourceLabel: 'Update source',
  updateSourceDesc: 'Where software updates come from (unrelated to API sync)',
  updateSourceFolder: 'Folder',
  updateSourceCloud: 'Cloud',
  updateSourceChoose: 'Choose folder',
  updateSourcePathPlaceholder: 'e.g. \\\\server\\public\\apilot-updates',
  updateSourceSave: 'Save',
  updateSourceNone: 'Not configured',
  updateSourceSaved: 'Update source saved',
  updateSourceBaseUrl: 'Repository URL',
  updateSourceBaseUrlDesc: 'Leave blank to use the default official repository',
  updateSourceMirrorPrefix: 'Mirror prefix',
  updateSourceMirrorPrefixDesc:
    'Leave blank for direct access; set a mirror prefix (ending with /) to speed up downloads',
  updateSourceUrlInvalid: 'Invalid URL; must start with http:// or https://',

  versionLabel: 'Version',
  buildDebug: 'Debug build',
  buildRelease: 'Release build',
  checkUpdates: 'Check for updates',
  checkUpdateAvailable: 'New version {version} found; grab the installer from the update source',
  checkUpdateAvailableCloud: 'New version {version} found; ready to download and install',
  checkUpdateDowngradeAvailable:
    'Rollback version {version} found; the update source now points to it and a downgrade install is possible',
  checkUpdateUpToDate: 'You are on the latest version',
  checkUpdateNotConfigured:
    'No update source configured: enable developer mode and set it under Developer → Update source',
  checkUpdateUnreachable: 'Update source is unreachable; check the folder or network',
  checkUpdateInvalidManifest:
    'Update source manifest is invalid or lacks the current platform entry',
  autoCheckUpdates: 'Check for updates automatically',
  autoCheckUpdatesDesc: 'Check the update source for new versions after startup',
  updateAvailableBadge: 'New version {version} found; verified and ready to install',
  updateDowngradeBadge:
    'Rollback to {version} available; a downgrade install replaces the current version',
  downloadAndInstall: 'Download & install',
  updateVerified: 'v{version} downloaded and verified',
  updateInstalling: 'Launching the installer; the app will close…',
  updateReadyTitle: 'Update ready',
  updateReadyDesc:
    'v{version} has been downloaded and verified. Restart now to install? The app will close — reopen it once the installer finishes.',
  updateInstallNow: 'Install now',
  updateLater: 'Later',
  updateCompletedToast: 'Successfully updated to v{version}',
  updateInstallFailed: 'The previous install (v{version}) did not complete; you can retry',
  licenseLink: 'License',
  docsLink: 'Docs',
  changelogTitle: 'Changelog',
  changelogNew: 'New',
  changelogImproved: 'Improved',
  changelogFixed: 'Fixed',
  changelogV010Date: '2026-09',
  changelogV010Intro: 'First milestone of APilot 2.0: the new architecture foundation.',
  changelogV010Item1:
    'New Tauri 2 + React cross-platform architecture with SQLite-backed settings and the boot payload protocol',
  changelogV010Item2:
    'App Shell: title bar, three left-panel views, tab bar and status bar skeleton',
  changelogV010Item3:
    'Theme system: three-state following, six accent colors, flash-free boot and the F12 diagnostics channel',
  changelogV010Item4:
    'Bilingual UI (Chinese/English) with a three-level missing-key fallback chain',
  changelogV010Item5: 'Logging: daily rolling files, ring buffer and one-click diagnostics copy',
  changelogV010Item6:
    'Task registry and unified shutdown: cancellation chains and resource cleanup guarantees',
  // v0.9.1 entries transcribed from that release's notes (bilingual two-line intro,
  // rendered via whitespace-pre-line)
  changelogV091Date: '2026-11',
  changelogV091Intro:
    '0.9.0 发布后实测反馈的体验修复批次。\nExperience fixes from real-world feedback after v0.9.0.',
  changelogV091Item1:
    'Installer icon: the installer and uninstaller now show the app icon instead of the default NSIS one (on machines with an older version installed, shortcuts may still show the old icon — a Windows icon cache residue; reinstall and refresh the icon cache to restore).',
  changelogV091Item2:
    'Sync scaffolding types: array fields are no longer scaffolded as null; skeletons are generated from the first element (scalar arrays get [0]/[""], object arrays get a one-level object skeleton); nested objects no longer lose keys or fall back to null; POST bodies that are arrays directly now scaffold correctly; the first scaffold prefers the document\'s request-body-level example. Nulls already written and user-filled content (including dictionary forms) are preserved as-is after re-syncing.',
  changelogV091Item3:
    'Selectable API docs examples: request/response examples and parameter example values support text selection (including right-click copy) and a hover copy button.',
  changelogV091Item4:
    'History detail formatting: JSON request/response bodies render indented with syntax highlighting and are selectable for copying; truncated or non-JSON content stays verbatim.',
  changelogV091Item5:
    'cURL import dialog: pasting long commands no longer stretches the window; content scrolls internally once it overflows (batch variable add, variable import and extractor node batch editing fixed with the same approach).',
  changelogV091Item6:
    'Workflow body override cursor: editing in the middle of the text no longer jumps the cursor to the end (node names and each override input fixed as well).',
  changelogV091Item7:
    'Close button behavior: clicking the top-right close now offers "Minimize to tray" or "Quit app", with a "Remember my choice" option; change it later under Settings › General › Close button behavior.',
  changelogV091Item8:
    'System tray: a resident tray icon; left-click restores the main window, and the menu supports "Show APilot / Quit" (menu language follows the UI language setting).',
  changelogV091Item9:
    'Single instance: launching again no longer opens a second instance; the existing window is brought up instead.',
  changelogV091Item10:
    'The workspace auth (Bearer Token) default placeholder changed from {{access_token}} to {{access-token}} (affects newly created workspaces only; existing workspaces are unaffected).',
  // v0.9.2 entries pre-written for this batch's CLI items; date is an
  // unreleased placeholder, finalized together with the release notes
  changelogV092Date: 'Unreleased',
  changelogV092Intro:
    '0.9.1 发布后聚焦 CLI 与脚本集成的功能批次。\nFeature batch focused on CLI and scripting integration after v0.9.1.',
  changelogV092Item1:
    'CLI body flags: apilot api run gains --body-file (reads the request body from a file, same semantics as --body) and --form / --form-file (line-level overrides for form text fields and file uploads); long bodies and multipart no longer depend on inline terminal escaping.',
  changelogV092Item2:
    'Agent skill PowerShell guide: the bundled Agent skill adds quoting guidance for PowerShell — inline JSON double quotes get stripped there, so request bodies should prefer a local file via --body-file, letting coding agents build correct commands in PowerShell.',
  changelogV092Item3:
    'CLI workspace selection: with --workspace set, endpoint lookup, base_url, variables and auth now all resolve from the selected workspace (previously only endpoint lookup used it while the send chain still assembled from the current workspace, so requests could hit the wrong target when the two differed).',
  changelogV092Item4:
    "CLI body content type: when --body / --body-file overrides the request body, Content-Type now inherits the endpoint's saved body type (json/xml/text/urlencoded each mapped; multipart boundaries are engine-generated); content sniffing applies only when the endpoint has no saved body (e.g. an XML endpoint's overridden body is no longer sent as plain text).",
} as const
