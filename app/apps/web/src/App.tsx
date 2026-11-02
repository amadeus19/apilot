import { QueryClientProvider } from '@tanstack/react-query'

import { queryClient } from '@/app/query-client'
import { Toaster } from '@workspace/ui/components'

import { AppShell } from '@/components/layout/AppShell'
import { ErrorDialogHost } from '@/components/common/ErrorDialogHost'
import { TextContextMenuHost } from '@/components/common/TextContextMenuHost'
import { useWindowFocusBridge } from '@/features/history/focus-bridge'
import { SettingsDialog } from '@/features/settings'
import { useExitFlush } from '@/services/exit-flush'

export function App() {
  // 退出收尾单点：CloseRequested → 全量 flush（会话保存 + 草稿）→ 放行退出
  useExitFlush()
  // 窗口焦点 → 查询重取桥接（全局一次安装；仅历史域查询启用聚焦重取）
  useWindowFocusBridge()
  return (
    // 异步 / 服务端状态宿主（三类状态分治）：IPC 查询与变更经此收口
    <QueryClientProvider client={queryClient}>
      {/* App Shell：标题栏 / 左栏三视图 / 标签栏 / 主区 / 状态栏 */}
      <AppShell />
      {/* 错误呈现宿主：瞬态 → Toast（右下角），阻断 → 模态对话框 */}
      <ErrorDialogHost />
      {/* 设置面板：标题栏设置按钮 / Ctrl+, 触发 */}
      <SettingsDialog />
      {/* 全局文本右键菜单：拦截原生菜单，文本语境弹撤销 / 剪切 / 复制 / 粘贴等 */}
      <TextContextMenuHost />
      <Toaster />
    </QueryClientProvider>
  )
}
