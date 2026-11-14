/**
 * 设置面板：8 组信息架构的组名、设置行与动作文案。
 */
export const settings = {
  title: '设置',
  description: '应用偏好与功能配置',
  searchPlaceholder: '搜索设置…',

  // 8 组导航（组名 + 描述）
  navGeneral: '通用',
  navGeneralDesc: '窗口关闭等应用行为',
  navAppearance: '外观',
  navAppearanceDesc: '主题与强调色',
  navLanguage: '语言',
  navLanguageDesc: '界面显示语言',
  navKeybindings: '快捷键',
  navKeybindingsDesc: '命令键位自定义',
  navHttp: 'HTTP',
  navHttpDesc: '超时、重定向、TLS 与代理',
  navBackup: '备份',
  navBackupDesc: '手动导出与恢复全部数据；备份包含明文凭据',
  navDeveloper: '开发者',
  navDeveloperDesc: '诊断与调试工具',
  advancedTitle: '高级',
  cliLabel: '命令行界面',
  cliDescription: '允许从命令行与Apilot交互',
  cliDialogTitle: '设置CLI以在终端中使用',
  cliDialogDescription: '将“apilot”注册到PATH中，以便在终端的任意位置都能访问“apilot”命令',
  cliSkip: '跳过',
  cliRegister: '注册',
  cliRegistering: '注册中…',
  cliRegisteredToast: '已注册，重启终端后生效',
  cliRegisteredDevToast: '已注册开发构建目录，重启终端后生效（正式安装后请重新注册）',
  cliRetry: '重试',
  cliCancel: '取消',
  // CLI 状态块（开关行下方恒显三行：版本 / 路径 / PATH）
  cliStatusVersion: '版本',
  cliStatusPath: '路径',
  cliStatusPathEnv: 'PATH',
  cliCopyPath: '复制 CLI 路径',
  cliStatusLoading: '检测中…',
  cliStatusFailed: '无法获取 CLI 状态',
  cliBinaryUnavailable: 'CLI 二进制不可用，修复安装或重装应用',
  cliDevBuildWarning: '开发构建目录，正式安装后需重新注册',
  cliPathRegistered: '已注册',
  cliPathUnregistered: '未注册',
  cliShadowedUnregistered: '终端的 apilot 来自 {dir}',
  cliShadowedRegistered: '终端优先解析到 {dir}，如需立即使用可复制 CLI 路径全路径执行',
  cliStaleHint: '注册表另有含 apilot.exe 的失效条目（旧安装遗留，无害）',
  navAbout: '关于',
  navAboutDesc: '版本与许可信息',

  // 搜索无命中（导航空态与内容回落共用）
  searchNoResults: '没有匹配的设置项',

  // 通用组（关闭按钮行为）
  closeBehaviorLabel: '关闭按钮行为',
  closeBehaviorDesc: '点击窗口关闭按钮时的动作',
  closeBehaviorAsk: '每次询问',
  closeBehaviorTray: '最小化到托盘',
  closeBehaviorExit: '退出应用',

  // 关闭确认弹窗（ask 态关闭请求时呈现；两动作外 Esc / 点外＝取消）
  closeConfirmTitle: '要关闭 APilot 吗？',
  closeConfirmDesc: '选择点击关闭按钮后的动作；之后可在设置的「通用 → 关闭按钮行为」中修改。',
  closeConfirmTray: '最小化到托盘',
  closeConfirmExit: '退出应用',
  closeConfirmRemember: '记住我的选择',

  // 外观组
  themeLabel: '主题',
  themeDesc: '选择浅色、深色或跟随系统',
  themeLight: '浅色',
  themeDark: '深色',
  themeSystem: '跟随系统',
  themeSystemResolved: '当前跟随系统解析为：{value}',
  accentLabel: '强调色',
  accentDesc: '界面主色即时切换',
  accentIndigo: '靛蓝',
  accentTeal: '青碧',
  accentViolet: '紫罗兰',
  accentOrange: '橙',
  accentRose: '玫红',
  accentGraphite: '石墨',

  // 语言组
  languageLabel: '界面语言',
  languageDesc: '切换即时生效，无需重启',
  languageZh: '中文',
  languageEn: 'English',
  languageSystem: '跟随系统',
  languageResolved: '当前解析为：{value}',

  // HTTP 组
  httpTimeoutLabel: '超时',
  httpTimeoutDesc: '请求等待响应的时间上限，超时按失败终止',
  httpTimeoutUnlimited: '不限制',
  httpTimeoutOption: '{seconds} 秒',
  httpRedirectLabel: '跟随重定向',
  httpRedirectDesc: '自动跟随 3xx 重定向（最多 10 次）',
  httpTlsLabel: '校验 TLS 证书',
  httpTlsDesc: '关闭后接受自签名或无效证书',
  httpProxyLabel: '代理',
  httpProxyDesc: '经代理服务器发送请求，地址支持 http / https / socks5',
  httpProxyNone: '不使用',
  httpProxyCustom: '自定义',
  httpProxyUrlLabel: '代理地址',
  httpProxyUrlPlaceholder: 'socks5://127.0.0.1:1080',

  // 备份组（手动导出 / 恢复）
  backupExport: '导出备份',
  backupExportDesc: '把全部数据导出为单个备份包',
  backupExportDone: '备份已导出（{size}）：{path}',
  backupRestore: '恢复备份',
  backupRestoreDesc: '从备份包恢复数据，重启应用后生效',
  backupRestoreConfirmTitle: '恢复此备份？',
  backupRestoreConfirmDesc:
    '恢复将把工作空间、接口、变量等数据整体回滚到备份时点，设置与请求历史保留。操作不可撤销，建议先导出当前数据。确认后需重启应用生效。',
  backupRestoreConfirmAction: '确认恢复',
  backupCancel: '取消',
  // 暂存成功后的重启确认模态：显式化「必须重启才继续」与窗口期写入丢失风险
  backupRestartTitle: '恢复已受理',
  backupRestartDesc: '重启应用后生效；受理后到重启前的数据写入将被备份内容替换，请尽快重启。',
  backupRestartAcknowledge: '知道了',
  backupRestartNow: '立即重启',

  // 开发者组
  devModeLabel: '开发者模式',
  devModeDesc: '开启后按 F12 打开 DevTools',
  logLevelLabel: '日志级别',
  logLevelDesc: '写入日志文件与诊断缓冲的最低级别',
  copyDiagnostics: '复制诊断信息',
  workbenchDiagnostics: '工作台诊断',
  workbenchDiagnosticsDesc: '当前打开标签页数：{tabs}，注册命令数：{commands}',
  copyDiagnosticsDesc: '版本、系统与运行环境摘要',
  copyDiagnosticsDone: '诊断信息已复制',
  copyDiagnosticsFailed: '复制失败，请手动复制',
  openLogDir: '打开日志目录',
  openLogDirDesc: '滚动日志文件的存放位置',
  logDirLabel: '日志目录',
  logDirChange: '更改目录',
  logDirReset: '恢复默认',
  logDirRestart: '日志目录已更新，重启应用后生效',
  updateSourceLabel: '更新源',
  updateSourceDesc: '软件版本更新的来源渠道（与接口同步无关）',
  updateSourceFolder: '文件夹',
  updateSourceCloud: '云服务',
  updateSourceChoose: '选择目录',
  updateSourcePathPlaceholder: '例如 \\\\server\\public\\apilot-updates',
  updateSourceSave: '保存',
  updateSourceNone: '未配置',
  updateSourceSaved: '更新源已保存',
  updateSourceBaseUrl: '仓库地址',
  updateSourceBaseUrlDesc: '留空使用默认官方仓库地址',
  updateSourceMirrorPrefix: '镜像前缀',
  updateSourceMirrorPrefixDesc: '留空直连官方源；可填镜像前缀（以 / 结尾）加速访问',
  updateSourceUrlInvalid: '地址无效，需以 http:// 或 https:// 开头',

  // 关于组
  versionLabel: '版本',
  buildDebug: '调试构建',
  buildRelease: '正式构建',
  checkUpdates: '检查更新',
  checkUpdateAvailable: '发现新版本 {version}，可在更新源获取安装包',
  checkUpdateAvailableCloud: '发现新版本 {version}，可下载安装',
  checkUpdateDowngradeAvailable: '发现可回滚版本 {version}，可降级安装（当前更新源已指回该版本）',
  checkUpdateUpToDate: '当前已是最新版本',
  checkUpdateNotConfigured: '尚未配置更新源：开启开发者模式后在「开发者 → 更新源」配置',
  checkUpdateUnreachable: '更新源不可达，请检查目录或网络',
  checkUpdateInvalidManifest: '更新源清单无效或缺少当前平台条目',
  autoCheckUpdates: '自动检查更新',
  autoCheckUpdatesDesc: '启动后自动检查更新源的新版本',
  updateAvailableBadge: '发现新版本 {version}，已通过校验即可安装',
  updateDowngradeBadge: '可回滚到 {version}，降级安装会覆盖当前版本',
  downloadAndInstall: '下载并安装',
  updateVerified: 'v{version} 下载完成，校验通过',
  updateInstalling: '正在启动安装，应用即将关闭…',
  updateReadyTitle: '更新已就绪',
  updateReadyDesc:
    'v{version} 已下载并通过校验。要立即重启并安装吗？应用将关闭，安装完成后请重新打开。',
  updateInstallNow: '立即安装',
  updateLater: '稍后',
  updateCompletedToast: '已成功更新到 v{version}',
  updateInstallFailed: '上次安装（v{version}）未完成，可重新安装',
  licenseLink: '开源许可',
  docsLink: '文档',
  changelogTitle: '更新日志',
  changelogNew: '新增',
  changelogImproved: '改进',
  changelogFixed: '修复',
  changelogV010Date: '2026-09',
  changelogV010Intro: 'APilot 2.0 首个里程碑：全新架构地基落地。',
  changelogV010Item1: 'Tauri 2 + React 全新跨平台架构，SQLite 设置持久化与启动载荷协议',
  changelogV010Item2: '应用 Shell：标题栏、左栏三视图、标签栏与状态栏骨架',
  changelogV010Item3: '主题系统：三态跟随、六强调色、防闪启动与 F12 诊断通道',
  changelogV010Item4: '中英双语界面与三级缺失键兜底',
  changelogV010Item5: '日志装置：按日滚动文件、环形缓冲与诊断信息一键复制',
  changelogV010Item6: '任务登记处与统一退出序列：取消链路与资源清理保障',
  // v0.9.1 条目抄录自该版 release 说明（导语双语两行，\n 经 whitespace-pre-line 渲染）
  changelogV091Date: '2026-11',
  changelogV091Intro:
    '0.9.0 发布后实测反馈的体验修复批次。\nExperience fixes from real-world feedback after v0.9.0.',
  changelogV091Item1:
    '安装器图标：安装与卸载器不再显示 NSIS 默认图标，换为应用图标（已装旧版机器如快捷方式仍显示旧图，为 Windows 图标缓存残留，重装并刷新图标缓存即恢复）。',
  changelogV091Item2:
    '同步铺底类型识别：数组字段不再铺 null，按首元素生成骨架（标量数组铺 [0]/[""]，对象数组铺一层对象骨架）；嵌套对象不再丢键或落 null；POST 请求体直接为数组时正常生成请求体；首次铺底优先使用文档的请求体级 example。已写入的 null 与用户已填内容（含字典形态）重新同步后保持原样。',
  changelogV091Item3:
    '接口文档示例可划选复制：请求体/响应示例与参数示例值支持鼠标划选（含右键复制）与悬浮复制按钮。',
  changelogV091Item4:
    '历史详情请求/响应格式化：JSON 请求/响应体展示为缩进格式（带语法着色），可划选复制；截断或非 JSON 内容保持原文。',
  changelogV091Item5:
    '从 cURL 导入弹窗：粘贴长命令不再撑爆窗口，超出后内部滚动（变量批量添加、变量导入、提取节点批量编辑同口径修复）。',
  changelogV091Item6:
    '工作流 Body 覆写光标：在文本中间编辑时光标不再跳到末尾（同样修复节点名称与各覆写行输入）。',
  changelogV091Item7:
    '关闭按钮行为：点击右上角关闭时可选「最小化到托盘」或「退出应用」，可勾选「记住我的选择」；可在 设置 › 通用 › 关闭按钮行为 中修改。',
  changelogV091Item8:
    '系统托盘：常驻托盘图标，左键单击唤起主窗口，菜单支持「显示 APilot / 退出」（菜单语言跟随界面语言设置）。',
  changelogV091Item9: '防双开：重复启动不再开启第二个实例，自动唤起已有窗口。',
  changelogV091Item10:
    '工作空间认证（Bearer Token）默认占位由 {{access_token}} 改为 {{access-token}}（仅影响新创建的工作空间；已创建的工作空间不受影响）。',
  // v0.9.2 条目预写本批 CLI 四项；日期为待发布占位，发布时与终稿一并定版
  changelogV092Date: '待发布',
  changelogV092Intro:
    '0.9.1 发布后聚焦 CLI 与脚本集成的功能批次。\nFeature batch focused on CLI and scripting integration after v0.9.1.',
  changelogV092Item1:
    'CLI 请求体旗标：apilot api run 新增 --body-file（从文件读取请求体，语义与 --body 一致）与 --form / --form-file（表单文本字段与文件上传的行级覆写），长请求体与 multipart 场景不再依赖终端行内转义。',
  changelogV092Item2:
    'Agent skill PowerShell 指引：附带的 Agent skill 补充 PowerShell 下的引号指引——内联 JSON 的双引号在 PowerShell 中会被剥离，请求体优先写入本地文件走 --body-file，编码代理在 PowerShell 中也能正确拼出命令。',
  changelogV092Item3:
    'CLI 工作空间指定：--workspace 指定空间时，接口定位、base_url、变量与认证全链改从指定空间取数（原先仅接口查找用指定空间，发送装配仍按当前空间，两者不同时会请求发错目标）。',
  changelogV092Item4:
    'CLI 请求体类型：--body / --body-file 覆写请求体时，Content-Type 自动继承接口保存的请求体类型（json/xml/text/urlencoded 各自映射，multipart 边界由引擎生成），接口未保存请求体时才按内容嗅探（如 XML 接口的覆写请求体不再被当作纯文本发送）。',
} as const
