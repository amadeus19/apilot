import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { en } from '../locales/en'
import { zhCN } from '../locales/zh-CN'

/**
 * 键集合对照测试（拆分防丢键）：下方快照固化自拆分前的单文件字典——
 * 每域「键数 + 域内升序键名清单的 sha256 摘要（前 16 位）」。
 * 任何丢键、键改名、结构漂移都会让键数或摘要失配而即刻失败，域级粒度直接定位；
 * 有意变更键集合时（如后续票在既有域新增文案），同批更新快照行再合入。
 * en 与 zh-CN 的结构同构另由编译期 en.ts `satisfies Dict` 保证，此处再以
 * 运行时互等断言双保险。
 */

/** 拆分前快照：域 → [键数, 域内升序键名清单的 sha256 摘要前 16 位] */
const SNAPSHOT: Readonly<Record<string, readonly [count: number, hash: string]>> = {
  apiTree: [61, '449438f05d07797a'],
  commandPalette: [33, 'cefba7e320332959'],
  common: [9, '6b0ed5edfac7169a'],
  contextmenu: [6, '0609797edca70db3'],
  editor: [101, '7a598ccdc028ac18'],
  errors: [78, '00b1d54c2526c3d8'],
  history: [29, 'd3991c5d4713c57d'],
  historyDetail: [22, '8b8471fe7208f397'],
  keybindings: [10, '5f169ca9f7c6937f'],
  response: [83, 'ab7312084878a8e2'],
  settings: [157, '65a5f2ca8d47caa4'],
  shell: [47, '372be7472a286fcb'],
  statusBar: [6, '89d24b7f5affa6cb'],
  sync: [59, 'da3dd1c45b8586c0'],
  tabs: [8, '934d9ee29bfa616f'],
  workspace: [55, '1815ea25d1f453c9'],
  workspaceSettings: [15, 'd2e0520c88db9b33'],
  variables: [145, 'c1578399d61b6135'],
  workflows: [227, '3b8330798684db8f'],
}

/** 拆分时总键数 556；变量域错误码随 01 号票 +5（errors 44→49）；
 * 02 号票 workspace 域首落文案 +45、导入错误码 +2（errors 49→51）；
 * 04 号票 variables 域首落文案 +72（预留空域转实域）；
 * 06 号票 variables 域变量解析预览 +6（72→78）；
 * 并行批次 sync 错误码 +2（errors 51→53，随合并态基线同步）；
 * 07 号票 diff 段 SYNC_NO_SNAPSHOT +1（errors 53→54）；
 * 08 号票接口文档抽屉 http 域 +24（response 48→72）；
 * 10 号票可达探测芯片 apiTree 域 +5（43→48）；
 * 12 号票体参数级合并裁决 sync 域首落文案 +19（预留空域转实域）；
 * 09 号票同步向导 sync 域 +49（19→68）、shell 域删占位提示 −1（54→53）；
 * 修复全跳过误导呈现 sync 域 +2（68→70，allSkipped 两键）；
 * 同步应用静默对齐（拍板）：合并裁决面整体移除——sync 域删 merge 组与
 * mergeSection/doneMerge/doneNoMerge 共 22 键（70→48），editor 域 +1
 * （entityLockedHint，105→106）；
 * 地址栏 BaseUrl 切换改纯地址选择（拍板）：override 组删 title/
 * followWorkspace/overridePlaceholder/apply/current 5 键、增 emptyBaseUrl
 * （variables 78→74）；
 * 服务状态徽标换原型形态：apiTree 域增 probeTag 四短词键（48→52）；
 * 接口文档抽屉请求体媒型归一：response 域增表单体占位键（72→73）；
 * 左栏工作空间树视图重构：workspace 域删切换器两入口/分节头/当前徽标/
 * 服务空态/上移下移 9 键、增加载失败两键（45→38）；
 * 工作空间详情参数化＋服务列表：workspaceSettings 域删说明/节标题×3/
 * BaseUrl 提示/认证说明 6 键、增空态 1 键（14→9）；workspace 域增服务
 * 列表表头两键与空态（38→41）；
 * 工作空间拖拽排序接线：workspace 域增上移/下移两键（41→43）；
 * 导入勾选步表头全选：workspace 域增全选无障碍名一键（43→44）；
 * 工作空间页视觉打磨：workspace 域增节标题/服务空态标题/当前徽章 3 键
 * （44→47）；
 * 变量树迁移两级树形态（TreePrimitive）：variables 域 tree 组删展开/收起/
 * 无变量提示 3 键、增菜单（打开/激活/取消激活/重命名/删除/两新建入口）与
 * 加载失败两键 9 键，renameDialog 组新增 5 键（74→85）；
 * 变量树去分组层（全局分类置顶）＋键值表行内改名：tree 组删分组两键与
 * 分组新建入口两键 −4，config 组增行内编辑 aria 与空态提示两键 +2（85→83）；
 * BaseUrl 候选跨空间删除拒绝（错误码补键）：errors 域 +1（54→55）；
 * 树行同步徽标可见化：apiTree 域 syncBadge 两短词键 +2（52→54）；
 * 环境快捷切换（地址栏环境块＋命令面板环境动态段）：variables 域增
 * quickSwitch 组 6 键（83→89）、commandPalette 域增分组头/动态段两行/
 * 命令名 4 键（20→24）；
 * `{{` 变量联想＋右键插入：variables 域增 tree.insertVariable 与
 * suggest.empty 两键（89→91）；
 * 同步向导增强（接口粒度勾选＋失败重试＋运行段取消提示）：sync 域增
 * runningCloseHint/retryButton/skippedSection/rowCheckLabel 4 键（48→52）；
 * 环境-BaseUrl 联动（推荐地址＋会话档＋跟随开关）：variables 域增
 * tree.recommendedUrl、recommendedDialog 组 7 键、override 组 7 键
 * （91→106）；
 * hover 变量解析（发送前可见）：variables 域增 hover 组 2 键（106→108）；
 * 变量工具集（导入导出＋批量新增＋分类排序＋生效集搜索）：variables 域增
 * tree.moveUp/moveDown、effective.searchPlaceholder/searchEmpty、transfer
 * 组 30 键（108→141）；
 * 单服务同步入口（树行右键直达）：apiTree 域增 syncService 一键（54→55）；
 * 散件交互包：apiTree 域增 probeRefreshAll（55→56）、variables 域增
 * deletedToast/undoDelete 两键（141→143）；
 * 工作空间详情页拍板版式（三卡分节＋横幅摘要）：workspaceSettings 域增
 * sectionBasic/sectionAuth、metaNoBaseUrl/metaAuthNone/metaServicesCount
 * 5 键（9→14）；
 * 变量页拍板版式（横幅＋居中键值表卡＋生效预览 Popover）：variables 域
 * config 组增 meta 摘要与生效预览入口 5 键、effective 组删面板标题键 −1
 * （143→147）；
 * 导入导出闭环加固（掩码回灌防御＋行级定位）：variables 域 transfer 组增
 * importInvalidJsonAt/importInvalidShapeAt/importMaskSkipped 3 键（147→150）；
 * 同步向导交互收口（混合终态＋应用段守卫＋色彩 token）：sync 域增
 * wizard.description/noChangesSkippedTitle/diffLoading 3 键（52→55）；
 * 详情页草稿同步与认证防抖（useDraftField）：variables 域 config 组增
 * deleteConfirmPending 1 键（150→151）、workspaceSettings 域增
 * nameEmptyError 1 键（14→15）；
 * 联想与浮层读屏语义打磨（combobox 全套＋量宽缓存）：variables 域
 * suggest 组增 listLabel 1 键（151→152）；
 * 左栏树杂项包（热区/校验/toast/虚拟化/页签语义/mutation 组收口）：
 * variables 域 recommendedDialog 组增 invalidUrl 1 键（152→153）、apiTree
 * 域增 syncServiceNoDoc/syncBadge 两释义 3 键（56→59）、workspace 域增
 * switchedToast/switchBack/doubleClickHint 3 键（47→50）；
 * 详情页版式原语提炼（DetailBanner/DetailSectionCard）：零新增键；
 * 树展开交互移至箭头（行点击开详情页）：variables 域 tree 组增
 * expand/collapse 2 键（153→155）、workspace 域增 expand/collapse 2 键
 * （50→52）；
 * PRD 偏差修正（「已移除」分组裁定不做，2026-10-14）：sync 域删
 * keepCardHint 1 键（55→54）、doneBadgeNote 改值对齐部分应用口径；
 * 右键菜单「插入变量」更名「复制变量」（动作实为复制引用，2026-10-14
 * 用户裁定）：variables 域 tree.insertVariable 改名 copyVariable（键数
 * 不变）；
 * 变量树搜索过滤接线（视图侧）：variables 域 tree 组增
 * searchNoResults/searchNoResultsHint/searchClear 三键（155→158）；
 * 工作空间树搜索过滤接线（视图侧）：workspace 域增搜索空态三键
 * searchNoResults/searchNoResultsHint/searchClear（52→55）；
 * KV 编辑器行补全重设计（占位行转正替代「添加」钮，2026-10-14 用户裁定）：
 * editor 域删 kvAddRow/kvEmptyHint/kvColumnActions 3 键（106→103）；
 * 回收站视图整体移除（左栏回到四视图）：shell 域删 viewTrash/
 * searchTrashPlaceholder/trashEmptyTitle/trashEmptyDescription 4 键
 * （53→49）；
 * 列头与占位文案改值不改键（名称/值 → 参数名/参数值）；
 * 备份域错误码补键（手动导出 / 恢复）：errors 域 +6（55→61）；
 * 同步应用横幅「复活」概念移除：sync 域删 revivedBadge 一键（54→53），
 * keepCardBody/doneCounts 改值对齐「移除后再导入」口径；
 * 设置组收敛为 7 组（编辑器 / 同步占位组移除，备份占位组转实两动作）：
 * settings 域删 navEditor/navEditorDesc/navSync/navSyncDesc 4 键、占位空态
 * 键改为搜索无命中（placeholderEmpty → searchNoResults）、增备份组动作与
 * 两段式确认文案 10 键（133→139）；
 * 分类推荐地址功能全链退役：variables 域删 tree.recommendedUrl、
 * recommendedDialog 组 8 键、override.recommendedBadge 与
 * override.followSwitch 共 11 键（158→147）；
 * 备份恢复重启提示改模态确认：settings 域删 backupRestoreStaged 一键、
 * 增重启确认模态 4 键（139→142）；
 * 状态栏四段重构与左栏空态死键清理：statusBar 域删 envNotConfigured/
 * reachabilityIdle 两键、增 workspaceNotSelected 与同步聚合档位四键
 * （4→7），shell 域删 variables/workspaces 空态四键（49→45）；
 * 用户反馈批次（同步超时移除＋行内取消＋状态栏同步段空态退役＋响应头
 * 存变量，2026-10-20）：statusBar 域删 syncIdle（7→6）、sync 域增
 * runCancelled/cancelFetch 两键（53→55）、response 域增 headerVariable
 * 组 11 键（73→84）；审查收尾删 headerVariable.actionTitle 死键（84→83）；
 * 同步向导 B 骨架（2026-10-21）：sync 域删 summaryAdded/Changed/Removed
 * 三键、增 selectFooterCount/runActivity/compareSelectedCount 三键（计数
 * 单点化，55 不变），全跳过态关闭按钮 closeWizardButton +1（55→56）；
 * 同步向导完成页收口与树刷新修复（2026-10-20）：sync 域删 doneCounts、
 * 增 doneUnchanged/lastSyncedAt（57→58）；apiTree 域键集合不变——同步
 * 徽标维持「应用写入、下次同步清旧」口径（应用后树查询即时失效重取）；
 * 变量树分类行去行尾激活开关（激活走右键菜单 / 命令面板，2026-10-21）：
 * variables 域 tree 组删 activateCategory/deactivateCategory 两键（147→145）；
 * 接口树一键展开 / 收起（2026-10-21）：apiTree 域增 expandAll/collapseAll
 * 两键（59→61）；
 * 可达徽标退场化（可达短暂展示后整体消失、徽标非交互化，2026-10-21）：
 * apiTree 域删 probeRefresh 一键（61→60）；
 * 变量详情横幅对齐工作空间形态（只读大标题＋改名弹窗，2026-10-21）：
 * variables 域删 config.nameAria、增 config.renameCategory（145 不变）；
 * 请求历史列表重做（平铺不分组＋常驻勾选＋底栏三态全选，2026-10-22）：
 * history 域删分组名/分组折叠/多选模式进出/清空确认共 11 键、增
 * selectedCount/loadedCount 两键（36→27）；
 * multipart 文件字段全链（行选择器＋发送文件 part＋cURL 两侧，2026-10-24）：
 * editor 域删 kvFileFieldHint/curlFileFieldNote/curlErrorFileData 3 键、增
 * kvPickFile/curlErrorFileSource 2 键（103→102）；
 * XML 格式化转实（xml kind 非空即可格式化，2026-10-24）：
 * editor 域删 bodyFormatHintXml 1 键（102→101）；
 * 工作流域首落（第五视图＋编辑 Tab 骨架，2026-10-24）：workflows 域首落
 * 23 键（预留空域转实域）、shell 域增视图与搜索占位两键（45→47）、errors
 * 域增工作流错误码两键（61→63）；
 * 画布编辑器同批（2026-10-24）：workflows 域增节点面板（五组名＋11 节点名
 * ＋搜索）/ 工具栏 / Inspector / 关闭确认 30 键（23→53）；审查收尾删死键
 * searchPlaceholder、增 rowRun 与 inspectorSelectedCount（53→54）；
 * 占位功能提示键（粘贴工作流菜单项与行内运行钮 title，2026-10-24）：
 * workflows 域增 comingSoon 一键（54→55）；
 * 请求节点与执行引擎串行核（2026-10-24）：workflows 域增请求节点引用态
 * 与覆写编辑 11 键（55→66）、errors 域增执行引擎错误码两键（63→65）；
 * 执行 UI 面与数据节点（2026-10-25）：workflows 域增
 * 运行/停止工具栏、执行面板、执行状态视觉、参数提取来源四选、存变量
 * 写回配置共 29 键（66→95）、commandPalette 域增工作流三命令名 3 键
 * （24→27）、errors 域增提取/存变量执行错误码 3 键（65→68）；
 * 存变量写回敏感开关与断言节点（2026-10-25）：workflows 域增写回敏感
 * 开关与断言规则编辑/结果呈现 16 键（95→111）、errors 域增断言错误码
 * 两键（68→70）；
 * 条件/并行/Join/延时/重试节点（2026-10-25）：workflows 域增条件分支
 * 编辑与 Join/延时/重试配置 21 键（111→132）、errors 域增条件/分支/Join
 * 错误码 3 键（70→73）；
 * 执行前校验清单与引用失效（2026-10-25）：workflows 域增校验错误定位
 * 14 键＋失效重接引导 2 键（132→148）、apiTree 域增删除接口引用清单
 * 1 键（60→61）、sync 域增将删除行引用计数 1 键（58→59）；
 * 评审收口（2026-10-25）：workflows 域删 JoinMode 短文案重复键
 * 2 键（148→146）；
 * 跨空间复制粘贴（2026-10-25）：workflows 域增复制入口 / 粘贴对话框与
 * 解析报告、工具栏复制共 14 键（146→160）；
 * 评审收口（2026-10-25）：workflows 域增工具栏复制语义提示 1 键（160→161）；
 * UX 段收口（2026-10-25）：workflows 域增分组树（建/改名/删/归组）
 * 13 键、自动布局与小地图 5 键、删 comingSoon/groupUngrouped/rowRunning/
 * groupNameExists 四键 −4（161→178）——重名文案归 errors 域单点，
 * commandPalette 域增自动布局/撤销/重做三命令名 3 键（27→30），errors 域
 * 增分组重名错误码 1 键（73→74）；
 * 节点面板键盘可达（条目按钮化＋面板容器无障碍名纠错，2026-10-26）：
 * workflows 域增 paletteLabel 1 键（178→179）；
 * 画布右键菜单（节点 / 边 / 空白面三类挂接，2026-10-26）：workflows 域增
 * 菜单项文案 6 键（179→185）；
 * 节点命名放开编辑（Inspector 名称行改 Input＋右键菜单 / F2 承载，
 * 2026-10-26）：workflows 域增 canvasMenuRename 一键（185→186）；
 * 编辑器工具栏撤销/重做双钮（键位揭示与栈态置灰，2026-10-26）：
 * workflows 域增 toolbarUndo/Redo 与两 Hint 4 键（186→190）；
 * 写回激活引导与重试语义提示（2026-10-26）：workflows 域增粘贴报告写回
 * 引导与执行面板写回清单条目/引导 3 键（190→193），retryHint 改值不改键；
 * 请求节点超时覆写（2026-10-26）：workflows 域增超时输入标签/继承占位/
 * 卡片摘要 3 键（193→196）；同批底部控制台双 tab 的标签/折叠 4 键随实现
 * 一并计入快照（196→198，两批合并态合计）；
 * 键位合一（画布复制/粘贴/重命名并入命令注册表，2026-10-26）：commandPalette
 * 域增三命令名 3 键（30→33）；
 * 节点名引用引导（条件表达式占位符升级＋可用字段提示＋两校验项文案，
 * 2026-10-26）：workflows 域增 validationNodeReference 两码与
 * conditionReferenceHint 3 键（198→201），conditionExpressionPlaceholder
 * 改值不改键；
 * 工作流导出导入（2026-10-26）：workflows 域增导出菜单项/导入入口/导出
 * toast/导入报告标题/掩码补值引导 5 键（201→206）、errors 域增导入版本
 * 拒收与导出落盘失败两码（74→76）；
 * 行内运行进度计数与写回标记（2026-10-26）：workflows 域增进度计数插值
 * 与写回 chip 短词/释义 3 键（206→209）；
 * 工作流域 UI 打磨（palette 去搜索、状态栏任务占位段移除，2026-10-26）：
 * workflows 域删 paletteSearchPlaceholder（209→208）、statusBar 域删
 * tasksIdle（6→5）；
 * 工作流树拖拽排序（2026-10-26）：workflows 域增行菜单上移/下移 2 键
 * （208→210）；
 * 清单行去徽标（第五视图裁定，2026-10-28）：workflows 域删失败徽标提示/
 * 写回 chip 短词/释义 3 键、增完成 toast 两键（210→209）；
 * 画布视觉层次重设计（2026-10-29）：workflows 域增空态标题/接口树拖入引导/
 * 节点面板引导/属性面板空态引导/节点分节名 5 键（209→214）；
 * 画布改 Postman Flow 式布局（2026-10-29）：workflows 域删节点面板标题/引导
 * 与属性面板九键（214→203），增悬浮工具栏「添加节点」标题/提示、节点选择
 * 面板搜索/空态与 11 类节点说明 15 键（203→218）；名称/接口/行增删四键
 * 随节点内编辑面改名（inspector*→nodeName/requestEndpoint/addRow/removeRow）。
 * 参数提取重设计与状态栏固定工作流（2026-11-01）：workflows 域净增 17 键（提取行
 * 三列/批量编辑/写回分支 8＋入参映射 7＋树行固定 Pin 两键，删存变量节点相关
 * 死键后净计）；errors 域删 setVar 输入缺失码（76→75）；statusBar 域增固定
 * 工作流运行提示（5→6）；
 * 参数提取单来源收口（2026-11-01）：workflows 域删提取行/批量编辑/变量键/
 * 写回提示/行间重复校验共 10 键、增写回值空态提示 1 键（235→226）；
 * 请求节点入参面深化（2026-11-01）：workflows 域删 Header 覆写标签与映射
 * Header 目标两键、增路径参数区/必填标记/值候选下拉/映射 Path 目标四键
 * （226→228）；连线占位卡标题条增「新节点」1 键（228→229）；
 * 总键 1141→1135。
 * 参数提取单来源多规则化（2026-11-01）：workflows 域增提取规则添加/移除
 * 两键（229→231）；
 * 总键 1135→1137。
 * 提取批量编辑与引用指引（2026-11-01）：workflows 域增批量编辑四键
 * （231→235）与未命名上游提示一键（235→236）；
 * 总键 1137→1142。
 * 工作流引用模型翻案（按连线识别上游，2026-11-01）：workflows 域删入参
 * 映射面板 8 键与 validationNodeReferenceUnresolved 死键共 9 键
 * （236→227），extractUpstreamHint 与 validationNodeReferenceAmbiguous
 * 改值不改键；
 * 总键 1142→1133。
 * CLI 开关 PATH 注册错误码分化（注册表取尺寸误判修复）：errors 域增
 * CLI_PATH_REGISTRY_FAILED 一键（75→76）；
 * 总键 1133→1134。
 * 设置页 CLI 状态完整版（开关注册表镜像＋三行状态块，2026-11-02）：settings
 * 域增状态块行名 / 复制路径 / 检测中 / 探测失败 / 二进制不可用 / 开发构建
 * 警示 / 注册态两词 / 遮蔽两态 / 残留提示共 13 键，删注册 / 注销失败兜底
 * 两死键（失败文案改经统一上报与弹窗本地化透传）（142→153）；
 * 总键 1134→1145。
 * 更新源解禁云端类型（类型两分 folder/cloud）：settings 域删
 * updateSourceLocal/updateSourceNetwork/updateSourceCloudPlaceholder 三键、增
 * updateSourceFolder、updateSourceBaseUrl/updateSourceBaseUrlDesc、
 * updateSourceMirrorPrefix/updateSourceMirrorPrefixDesc、updateSourceUrlInvalid
 * 与 checkUpdateAvailableCloud 七键（153→157）；
 * 总键 1145→1149。
 * 云端错误码映射补键（errors 域，随 Rust 侧云端拉取码登记）：
 * UPDATE_SOURCE_NOT_FOUND / UPDATE_SOURCE_RETRIES_EXHAUSTED（76→78）；
 * 总键 1149→1151。
 */
const TOTAL_KEYS = 1151

/** 与 core.ts lookup 同口径的叶子判定：string 或含 other 键的复数节点 */
function walkKeys(node: unknown, prefix: string, out: string[]): void {
  if (typeof node === 'string') {
    out.push(prefix)
    return
  }
  if (typeof node !== 'object' || node === null) return
  const record = node as Record<string, unknown>
  if (typeof record.other === 'string') {
    out.push(prefix)
    return
  }
  for (const key of Object.keys(record)) {
    walkKeys(record[key], prefix ? `${prefix}.${key}` : key, out)
  }
}

/** 全键清单按首段（功能域前缀）分组 */
function domainsOf(dict: unknown): Map<string, string[]> {
  const keys: string[] = []
  walkKeys(dict, '', keys)
  const domains = new Map<string, string[]>()
  for (const key of keys) {
    const domain = key.split('.')[0]
    const bucket = domains.get(domain)
    if (bucket) bucket.push(key)
    else domains.set(domain, [key])
  }
  return domains
}

/** 域内升序键名清单的摘要（与快照生成口径一致） */
function hashOf(keys: readonly string[]): string {
  return createHash('sha256')
    .update([...keys].sort().join('\n'))
    .digest('hex')
    .slice(0, 16)
}

function assertMatchesSnapshot(label: string, dict: unknown): void {
  const domains = domainsOf(dict)
  expect([...domains.keys()].sort(), `${label} 域清单应与快照一致（新增域请更新快照）`).toEqual(
    Object.keys(SNAPSHOT).sort(),
  )
  let total = 0
  for (const [domain, keys] of domains) {
    total += keys.length
    const [count, hash] = SNAPSHOT[domain] as readonly [number, string]
    expect(keys.length, `${label} 域 ${domain} 键数应与快照一致`).toBe(count)
    expect(hashOf(keys), `${label} 域 ${domain} 键名摘要应与快照一致`).toBe(hash)
  }
  expect(total, `${label} 总键数应与拆分前一致`).toBe(TOTAL_KEYS)
}

describe('i18n 字典键集合对照（拆分前快照固化，防迁移丢键）', () => {
  it('zh-CN：域级键数与键名摘要与拆分前完全一致', () => {
    assertMatchesSnapshot('zh-CN', zhCN)
  })

  it('en：域级键数与键名摘要与拆分前完全一致', () => {
    assertMatchesSnapshot('en', en)
  })

  it('两语言键集合运行时互等（编译期 satisfies Dict 的双保险）', () => {
    const zhKeys = domainsOf(zhCN)
    const enKeys = domainsOf(en)
    for (const [domain, keys] of zhKeys) {
      expect([...keys].sort(), `en 域 ${domain} 键集合应与 zh-CN 一致`).toEqual(
        [...(enKeys.get(domain) ?? [])].sort(),
      )
    }
    expect(enKeys.size).toBe(zhKeys.size)
  })
})
