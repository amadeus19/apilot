import * as React from 'react'

import { useQueryClient, type QueryClient } from '@tanstack/react-query'

import { useTreeExpandedStore } from '@/features/api-tree/tree-state.store'
import { useWorkspacesStore } from '@/features/workspaces/workspaces.store'
import { registerExitFlusher } from '@/services/exit-flush'
import {
  workbenchKeys,
  sessionGet,
  sessionSave,
  type WorkspaceListDto,
} from '@/services/workbench-api'
import { WORKSPACE_SETTINGS_TAB_ID, useTabsStore } from '@/stores/tabs.store'
import { reportError } from '@/services/error-center'

/**
 * Tab 会话持久化接线（挂载于 AppShell，随当前工作空间切换）：
 * - 恢复：切换到某工作空间即无条件拉取其会话（Tab 顺序 / 激活态 / 预览标记 /
 *   树展开同一事务；被删服务的残留 Tab 已由 Rust 侧过滤）。恢复落地后以树
 *   选中行（用户最后的导航意图，跨恢复幸存）校正详情 Tab 的内容指针——
 *   会话里的指针停留在该空间上次查看的位置，直接落地会让刚做的导航被旧
 *   会话回跳（双击切换后右显旧空间）；恢复写入不回写（恢复失败兜底的空
 *   会话不得覆盖已存会话）；
 * - 保存：tabs 与树展开任一变化后防抖整包写；切换空间时在途防抖保存立即
 *   以旧空间 id 落库（闭包持有旧 id，旧空间快照绝不跨空间落库）；退出时
 *   由退出收尾注册表立即 flush；
 * - 「workspace.current」真值由 Rust 侧解析（见 workspace.list 的 currentId）。
 */

/** 会话保存防抖窗口（合并连发的开/关/切动作）。
 * 此处刻意不用 DebouncedWriter：它的语义是「dispose／切换即写出剩余值」，
 * 而会话保存要的恰是「切换工作空间即丢弃在途防抖」（旧空间快照不得在
 * 新空间恢复流程中途落库），外加恢复批次的抑存窗口——两者是恢复事务
 * 特有的取消语义，不与「最新值落库」模型混同。 */
const SESSION_SAVE_DEBOUNCE_MS = 300

export function useWorkspaceSession(workspaceId: string | null): void {
  // 详情指针校正读取工作空间清单缓存（名称回填），随宿主同源注入
  const queryClient = useQueryClient()
  const saveTimerRef = React.useRef<number | null>(null)
  // 最新 workspaceId 直读（flusher 闭包不依赖重渲染）：渲染后写入，
  // 消费方（防抖定时器与退出 flush）均在 effect 之后触发
  const workspaceIdRef = React.useRef<string | null>(workspaceId)
  React.useEffect(() => {
    workspaceIdRef.current = workspaceId
  })
  /** 恢复批次抑存在位：恢复写入的状态变化不是用户动作，不得触发回写（否则
   * 恢复失败兜底的空会话会立即回写，把工作空间已存会话覆盖掉） */
  const restoringRef = React.useRef(false)

  /** 立即落库（显式 id 优先）：省略 id 时取最新 workspaceId 直读（flusher
   *  闭包不依赖重渲染），切换清理路径必须显式传旧 id（cleanup 时机晚于
   *  ref 同步与否不作假设，防跨空间污染由参数保证） */
  const saveNow = React.useCallback(async (saveWorkspaceId?: string): Promise<void> => {
    const id = saveWorkspaceId ?? workspaceIdRef.current
    if (!id) return
    const { tabs, activeTabId } = useTabsStore.getState().serialize()
    const { expandedIds } = useTreeExpandedStore.getState()
    // tabs JSON＝对象形态（tabs 数组 + activeTabId）；Rust 侧残留过滤只按约定键读取
    await sessionSave(id, JSON.stringify({ tabs, activeTabId }), JSON.stringify(expandedIds))
  }, [])

  const scheduleSave = React.useCallback((): void => {
    if (restoringRef.current) return
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      saveNow().catch(reportError)
    }, SESSION_SAVE_DEBOUNCE_MS)
  }, [saveNow])

  // 恢复：工作空间切换即拉取该空间会话（无条件，不加设置开关）
  React.useEffect(() => {
    if (!workspaceId) {
      restoringRef.current = true
      try {
        useTabsStore.getState().restore({ tabs: [] })
        useTreeExpandedStore.getState().clear()
      } finally {
        restoringRef.current = false
      }
      return
    }
    let disposed = false
    void (async () => {
      try {
        const session = await sessionGet(workspaceId)
        if (disposed) return
        // 树展开与 Tab 同一事务恢复：会话缺失时两者一并清空；
        // 恢复前整体清空树会话态（选中行与挂起请求不跨工作空间残留）
        const expanded = session ? (JSON.parse(session.treeExpanded) as unknown) : []
        const payload = session ? parseTabsPayload(session.tabs) : null
        restoringRef.current = true
        try {
          useTabsStore.getState().restore({
            tabs: payload?.tabs ?? [],
            activeTabId: payload?.activeTabId ?? null,
          })
          useTreeExpandedStore.getState().clear()
          useTreeExpandedStore.getState().restore(expanded)
          // 详情指针向树选中校正（用户刚做的导航不被旧会话回跳）
          reconcileDetailPointer(queryClient)
        } finally {
          restoringRef.current = false
        }
      } catch (error) {
        // 恢复失败不炸启动：空工作台呈现（与无会话等价），错误统一上报；
        // 空态经抑存在位不触发回写，已存会话原地保留等下次恢复
        reportError(error)
        if (!disposed) {
          restoringRef.current = true
          try {
            useTabsStore.getState().restore({ tabs: [] })
            useTreeExpandedStore.getState().clear()
            reconcileDetailPointer(queryClient)
          } finally {
            restoringRef.current = false
          }
        }
      }
    })()
    return () => {
      disposed = true
      // 切换工作空间：在途防抖保存立即以旧空间 id 落库（用户在旧空间的最后
      // 变更不丢；显式传参保证旧空间快照绝不以新空间 id 落库）
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        void saveNow(workspaceId).catch(reportError)
      }
    }
  }, [workspaceId, queryClient, saveNow])

  // 保存：tabs / 树展开任一变化 → 防抖整包写（按工作空间隔离）
  React.useEffect(() => {
    const unsubscribeTabs = useTabsStore.subscribe(scheduleSave)
    const unsubscribeTree = useTreeExpandedStore.subscribe(scheduleSave)
    return () => {
      unsubscribeTabs()
      unsubscribeTree()
    }
  }, [scheduleSave])

  // 退出收尾：立即 flush（绕过防抖窗口），放行退出由闸门负责
  React.useEffect(() => registerExitFlusher('tabs-session', () => saveNow()), [saveNow])

  // 卸载清防抖定时器（资源四问）
  React.useEffect(
    () => () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    },
    [],
  )
}

/** 会话 JSON 容错解析：非对象形态按无会话处理（恢复动作自会清空） */
function parseTabsPayload(tabsJson: string): { tabs: unknown[]; activeTabId: unknown } | null {
  try {
    const parsed = JSON.parse(tabsJson) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    return {
      tabs: Array.isArray(record.tabs) ? record.tabs : [],
      activeTabId: record.activeTabId,
    }
  } catch {
    return null
  }
}

/**
 * 恢复落地后的详情指针校正：树选中行是用户最后的导航意图（restore 不触碰
 * workspaces 域会话态，树选中跨恢复幸存），而会话里的详情内容指针停留在
 * 该空间上次查看的位置——两者不一致时以树选中为准原位换内容（恢复集中无
 * 详情 Tab 记录则补开并激活），保证「树选中与右侧详情」一致；无树选中
 * （启动恢复 / 删除联动清空）不校正，会话按原样落地。须在恢复抑存在位内
 * 调用：校正写入不得触发回写。名称取清单缓存当前值，缓存未就绪时沿用
 * 会话里的既有标题兜底。
 */
function reconcileDetailPointer(queryClient: QueryClient): void {
  const selected = useWorkspacesStore.getState().treeSelectedWorkspaceId
  if (!selected) return
  const { tabs, openWorkspaceSettings } = useTabsStore.getState()
  const detail = tabs.find((tab) => tab.id === WORKSPACE_SETTINGS_TAB_ID)
  if (detail && detail.key === selected) return
  const name =
    queryClient
      .getQueryData<WorkspaceListDto>(workbenchKeys.workspaces())
      ?.items.find((item) => item.id === selected)?.name ??
    detail?.title ??
    ''
  openWorkspaceSettings({ workspaceId: selected, name, mode: 'persistent' })
}
