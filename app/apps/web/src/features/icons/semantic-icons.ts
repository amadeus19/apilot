import {
  BookOpenIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CloudIcon,
  CloudOffIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  FolderOpenIcon,
  HistoryIcon,
  Layers2Icon,
  Link2Icon,
  LockIcon,
  PinIcon,
  RefreshCwIcon,
  RouteIcon,
  ServerIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SquarePenIcon,
  VariableIcon,
  type LucideIcon,
} from 'lucide-react'

/**
 * 语义图标单一常量源：一个语义一个图标。
 *
 * 导航 / 标题栏 / 标签栏 / 树行 / 空态 / 状态栏一律引用本表，业务侧不得
 * 自行从图标库 import 同类语义的图标——同一语义在两处各自取图，等于给
 * 图标选择留了两条可独立漂移的路径，收敛在此才谈得上「一个语义一个图标」。
 *
 * 选型理由随条目记在注释里：图标语义是否清晰取决于它和产品内既有视觉
 * 语言的关系（如变量用花括号呼应 `{{变量}}` 芯片），不取决于图标库的命名。
 */
export const SEMANTIC_ICONS = {
  /** 工作空间：标题栏切换器与左栏视图恒用同一图标；层叠形态表达多空间并存 */
  workspace: Layers2Icon,
  /** 接口树视图：与工作空间内服务节点同图标（树以服务为一级组织），入口与内容视觉一致 */
  apiTree: ServerIcon,
  /** 请求历史视图：时钟回旋＝已发生请求的时间线 */
  requestHistory: HistoryIcon,
  /** 变量 / 变量树：数学变量符（斜 x），`{{变量}}` 插值的领域语义 */
  variables: VariableIcon,
  /** 服务：服务端集合语义，轮廓与「分类」的文件夹形状可辨 */
  service: ServerIcon,
  /** 分类（收起态） */
  category: FolderIcon,
  /** 分类（展开态）：同语义的状态变体，不算第二个图标 */
  categoryExpanded: FolderOpenIcon,
  /** 置顶组：与「置顶」动作同名 */
  pinnedGroup: PinIcon,
  /** 手工接口：仅在服务内来源混合时呈现 */
  manualEndpoint: SquarePenIcon,
  /** 服务配置了文档地址（同步来源） */
  docSource: BookOpenIcon,
  /** 同步 */
  sync: CloudIcon,
  /** 同步不可用 / 未接通 */
  syncUnavailable: CloudOffIcon,
  /** 刷新、重发请求：与「同步」是不同语义，不复用云图标 */
  refresh: RefreshCwIcon,
  /** 应用设置（设置面板） */
  settings: SettingsIcon,
  /** 工作空间级配置：与「应用设置」的齿轮区分，避免同图标两义 */
  workspaceSettings: SlidersHorizontalIcon,
  /** Secret 变量标记：锁＝敏感值默认掩码（树行 / 键值表 / 生效集共用） */
  secret: LockIcon,
  /** Secret 明文切换（显态）：同语义的状态变体，不算第二个图标 */
  secretReveal: EyeIcon,
  /** Secret 明文切换（隐态） */
  secretHide: EyeOffIcon,
  /** 认证字面量转 Secret 变量动作：盾＋勾＝「收编为受保护变量」 */
  secretConvert: ShieldCheckIcon,
  /** BaseUrl 指向切换（设置页候选下拉与接口级覆写入口共用语义） */
  baseUrlSwitch: Link2Icon,
  /** 树全展开（左栏视图头部动作）：双箭头上下张开 */
  treeExpandAll: ChevronsUpDownIcon,
  /** 树全收起（左栏视图头部动作）：同语义的状态变体，不算第二个图标 */
  treeCollapseAll: ChevronsDownUpIcon,
  /** 工作流视图 / 工作流域：路线折线与节点＝节点编排后的执行路径 */
  workflow: RouteIcon,
  /** 状态栏固定工作流（树行固定动作与状态栏段共用）：钉住＝固定语义；
   * 与「置顶组」同为 Pin 形态，语境不同（接口树置顶 / 工作流树与状态栏固定） */
  pinnedWorkflow: PinIcon,
} as const satisfies Record<string, LucideIcon>
