import { WorkspaceWelcome } from '@/components/layout/WorkspaceWelcome'
import { HistoryDetailPane } from '@/features/history/history-detail-pane'
import { VariableConfigPage } from '@/features/variables/variable-config-page'
import { WorkflowEditorPage } from '@/features/workflow/workflow-editor'
import { DraftEditor } from '@/features/workbench/draft-editor'
import { EndpointEditor } from '@/features/workbench/endpoint-editor'
import { WorkspaceSettingsPane } from '@/features/workbench/workspace-settings-pane'
import { selectActiveTab, useTabsStore, type TabMeta } from '@/stores/tabs.store'

/**
 * 主区内容宿主：无激活 Tab＝欢迎空态（形态沿用，出现与否由 tabs store 驱动）；
 * 有激活 Tab＝仅挂载激活 Tab 的内容组件（非激活只留元数据 + 恢复指针，
 * 卸载即组件树销毁——关/切 Tab 清理五项的「组件卸载」由 React 语义保证）。
 * 切换过渡＝新内容淡入（150ms，无位移分量）：key 随激活 Tab 变化重挂载
 * 即重放；旧内容即时卸载（不交叉淡出——双内容并存与卸载清理纪律冲突）。
 */
export function WorkbenchContent() {
  const activeTab = useTabsStore(selectActiveTab)

  if (!activeTab) {
    return <WorkspaceWelcome />
  }
  return (
    <div
      key={activeTab.id}
      data-testid="tab-content"
      data-tab-kind={activeTab.kind}
      className="flex h-full min-h-0 animate-in flex-col duration-150 fade-in"
    >
      <TabContent tab={activeTab} />
    </div>
  )
}

/** Tab 类型 → 内容组件分发（endpoint 编辑器 / 草稿编辑器 / 工作空间设置页 / 变量配置页 / 历史详情页 / 工作流编辑器已实装） */
function TabContent({ tab }: { tab: TabMeta }) {
  if (tab.kind === 'endpoint') {
    if (!tab.serviceId || !tab.key) return null
    return <EndpointEditor tab={tab as TabMeta & { serviceId: string; key: string }} />
  }
  // 草稿 Tab：无实体身份，内容＝内存草稿 store（键＝tab.id）
  if (tab.kind === 'draft') {
    return <DraftEditor tab={tab} />
  }
  if (tab.kind === 'workspaceSettings') {
    // key＝正在查看的工作空间 id（单例原位换内容的内容指针）；
    // React key 随指针变更重挂载详情组件——表单草稿与防抖 writer 实例
    // 随查看对象隔离，切换时旧实例 dispose 把剩余编辑落回原空间
    if (!tab.key) return null
    return <WorkspaceSettingsPane key={tab.key} workspaceId={tab.key} />
  }
  // 变量配置 Tab：key＝分类 id（配置页自行拉分类元数据与键值表）
  if (tab.kind === 'variables') {
    if (!tab.key) return null
    return <VariableConfigPage categoryId={tab.key} />
  }
  if (tab.kind === 'historyDetail') {
    // key＝当前展示的 runId（单例原位换内容的内容指针）
    if (!tab.key) return null
    return <HistoryDetailPane runId={tab.key} />
  }
  // 工作流编辑 Tab：key＝工作流 id（每工作流单实例）
  if (tab.kind === 'workflow') {
    if (!tab.key) return null
    return <WorkflowEditorPage workflowId={tab.key} />
  }
  return <p className="p-4 text-sm text-muted-foreground">{tab.title}</p>
}
