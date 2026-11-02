import type { PanelImperativeHandle } from 'react-resizable-panels'

import {
  DEFAULT_LEFT_PANEL_WIDTH,
  RESPONSE_COLLAPSED_HEIGHT,
  RESPONSE_DEFAULT_PERCENT,
} from '@/stores/app.store'

/**
 * 分栏 imperative 桥（ADR-0005「库管几何，store 管语义」）：
 * 控制类动作（Ctrl+B / 标题栏图标 / 命令面板 / 状态行点击）不直接改 store，
 * 经此向分栏库下发分步 resize，几何事实源在库、语义镜像经 onResize 上提回
 * store。
 *
 * 折叠/展开动画：库实拖无过渡，命令式动作经 requestAnimationFrame 分步
 * resize 逼近目标尺寸（easeOutCubic）。不用 CSS transition——面板几何的
 * 中间态会被库的尺寸观察回吸为布局状态（反馈污染），分步 resize 的每一步
 * 都是库认可的合法布局，观察与状态始终自洽。`prefers-reduced-motion` 下
 * 直接跳到终值。左栏展开语义＝一律回默认宽度：拖动宽度视为会话内临时
 * 调整，收起即重置；响应区展开＝恢复折叠前高度。
 *
 * 动画互斥：同一面板同一时刻至多一条动画链在驱动（分面板令牌制）——新
 * 动画启动即令同面板旧链自行中止，连打 Ctrl+B / 折叠中点展开不会出现
 * 两条链互相覆盖尺寸。
 *
 * 资源所有权：桥由持有对应 Panel 的布局组件在挂载时登记、卸载时以 null
 * 清除（见 AppShell 的 panelRef 回调）；句柄缺位时动作静默忽略。动画循
 * 环每帧校验句柄仍为登记实例，面板卸载（句柄置 null / 更换）即中止，
 * 不持有失效 DOM 引用。
 */

let leftPanelApi: PanelImperativeHandle | null = null
let responsePanelApi: PanelImperativeHandle | null = null

/**
 * 响应区折叠记忆（单一 owner）：「按钮折叠恢复原高 / 拖拽折叠回默认占比」
 * 的全部状态与翻转规则只此一份（AppShell 只做几何镜像，不参与记忆推进）——
 * - lastHeight：展开态最近高度（按钮折叠的恢复目标）；动画中间帧与
 *   折叠态尺寸不入记忆（防中间态污染恢复目标）；
 * - viaButton：本次折叠是否来自按钮通道（拖拽 snap 折叠无「原位」可言，
 *   翻转沿把恢复目标置空，展开回默认占比）；
 * - animationTicket：在跑动画票据（非 null 时高度镜像不入记忆）。
 */
const responseCollapseMemory = {
  lastHeight: null as number | null,
  viaButton: false,
  animationTicket: null as symbol | null,
}

/** 分面板动画令牌（盒装引用）：递增使同面板旧链失效 */
const leftAnimationToken = { value: 0 }
const responseAnimationToken = { value: 0 }

/** 面板几何动画时长（ms）：Slow 档（布局级转换） */
const PANEL_TRANSITION_MS = 200

/** 左栏 Panel 挂载登记 / 卸载清除（panelRef 回调） */
export function setLeftPanelApi(api: PanelImperativeHandle | null): void {
  leftPanelApi = api
}

/** 响应区 Panel 挂载登记 / 卸载清除（panelRef 回调） */
export function setResponsePanelApi(api: PanelImperativeHandle | null): void {
  responsePanelApi = api
}

/**
 * 折叠翻转沿（AppShell 在 store 折叠镜像 false→true 时调用）：按钮折叠
 * 的记忆已在镜像中正确（点击条带恢复折叠前高度）；拖拽 snap 折叠＝用户
 * 把面板拖没了，无「原位」可言——记忆置空，展开走默认占比。
 */
export function notifyResponseCollapsed(): void {
  if (!responseCollapseMemory.viaButton) responseCollapseMemory.lastHeight = null
  responseCollapseMemory.viaButton = false
}

/**
 * 响应区展开态高度镜像（AppShell 的 onResize 调用）：持续记录最近一次
 * 展开高度作为按钮折叠的恢复目标。响应区动画中间帧与折叠态尺寸不入记忆。
 */
export function rememberResponseHeight(size: number): void {
  if (responseCollapseMemory.animationTicket !== null) return
  if (size > RESPONSE_COLLAPSED_HEIGHT) responseCollapseMemory.lastHeight = size
}

/**
 * 初始高度入记忆（AppShell 在响应区挂载时调用，返回清理函数）：库对
 * 初始布局不触发 onResize，缺这一步首次折叠前的记忆为空、恢复无从谈起。
 * 双 rAF 等初始布局落定后读取一次——这一库私有行为的补偿知识归本模块，
 * 库升级若改为派发初始 onResize，只需调整此处。
 */
export function initResponseRestoreMemory(): () => void {
  let cancelled = false
  const frame = requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (cancelled) return
      const api = responsePanelApi
      if (api && !api.isCollapsed()) {
        responseCollapseMemory.lastHeight = Math.round(api.getSize().inPixels)
      }
    }),
  )
  return () => {
    cancelled = true
    cancelAnimationFrame(frame)
  }
}

/**
 * 分步 resize 动画：每帧向库下发一次合法尺寸，缓动逼近目标；同面板新动画
 * 启动（令牌递增）或句柄被替换 / 清除（面板卸载）即刻中止并回调 onDone。
 * 动画写入的尺寸序列以终值为准（onResize 防抖持久化天然取最后一帧）。
 */
function animatePanelResize(
  registered: () => PanelImperativeHandle | null,
  api: PanelImperativeHandle,
  fromPx: number,
  toPx: number,
  tokenRef: { value: number },
  onDone?: () => void,
): void {
  const token = ++tokenRef.value
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    api.resize(`${Math.round(toPx)}px`)
    onDone?.()
    return
  }
  const start = performance.now()
  const step = (now: number): void => {
    // 被同面板新动画取代或面板已卸载 / 重挂：中止，不驱动失效几何
    if (token !== tokenRef.value || registered() !== api) {
      onDone?.()
      return
    }
    const t = Math.min(1, (now - start) / PANEL_TRANSITION_MS)
    const eased = 1 - Math.pow(1 - t, 3)
    api.resize(`${Math.round(fromPx + (toPx - fromPx) * eased)}px`)
    if (t < 1) requestAnimationFrame(step)
    else onDone?.()
  }
  requestAnimationFrame(step)
}

/** 切换左栏收展（Ctrl+B / 标题栏应用图标共用通道）；展开一律回默认宽度 */
export function toggleLeftPanelGeometry(): void {
  const api = leftPanelApi
  if (!api) return
  const from = api.getSize().inPixels
  const to = api.isCollapsed() ? DEFAULT_LEFT_PANEL_WIDTH : 0
  // 收起终态＝collapsedSize（0），尺寸到达后库的 isCollapsed 语义随之翻转
  animatePanelResize(() => leftPanelApi, api, from, to, leftAnimationToken)
}

/** 展开左栏（收起态恢复默认宽度；本就展开时不动） */
export function expandLeftPanel(): void {
  const api = leftPanelApi
  if (!api || !api.isCollapsed()) return
  animatePanelResize(
    () => leftPanelApi,
    api,
    api.getSize().inPixels,
    DEFAULT_LEFT_PANEL_WIDTH,
    leftAnimationToken,
  )
}

/** 展开响应区（折叠态状态行点击）：按钮折叠恢复折叠前高度；拖拽折叠
 * （记忆被翻转沿置空）回到默认占比——与「响应区尺寸会话态不持久化、
 * 重启回默认」同一语义。 */
export function expandResponsePanel(): void {
  const api = responsePanelApi
  if (!api || !api.isCollapsed()) return
  const target = responseCollapseMemory.lastHeight
  if (target !== null && target > RESPONSE_COLLAPSED_HEIGHT) {
    const ticket = Symbol()
    responseCollapseMemory.animationTicket = ticket
    animatePanelResize(
      () => responsePanelApi,
      api,
      api.getSize().inPixels,
      target,
      responseAnimationToken,
      () => {
        if (responseCollapseMemory.animationTicket === ticket) {
          responseCollapseMemory.animationTicket = null
        }
      },
    )
  } else {
    api.resize(`${RESPONSE_DEFAULT_PERCENT}%`)
  }
}

/** 折叠响应区（展开态面板头按钮；折叠前高度已由高度镜像持续记录） */
export function collapseResponsePanel(): void {
  const api = responsePanelApi
  if (!api || api.isCollapsed()) return
  const from = api.getSize().inPixels
  responseCollapseMemory.viaButton = true
  const ticket = Symbol()
  responseCollapseMemory.animationTicket = ticket
  animatePanelResize(
    () => responsePanelApi,
    api,
    from,
    RESPONSE_COLLAPSED_HEIGHT,
    responseAnimationToken,
    () => {
      // 自然结束 / 被新动画取代 / 面板卸载中止，都放行高度镜像；
      // 被取代时票据已被新动画顶替，比对防误清新动画的抑制态
      if (responseCollapseMemory.animationTicket === ticket) {
        responseCollapseMemory.animationTicket = null
      }
    },
  )
}
