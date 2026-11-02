import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryWrapper } from '@/test/render-providers'

import { WorkspacesDialogHost } from '../workspaces-dialogs'
import { useWorkspacesStore } from '../workspaces.store'

// —— IPC invoke 替换：按命令名分派 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const WORKSPACES = {
  items: [{ id: 'w1', name: '默认工作空间', baseUrl: null, auth: null, isCurrent: true }],
  currentId: 'w1',
}

beforeEach(() => {
  vi.clearAllMocks()
  useWorkspacesStore.setState({ dialog: null })
  invokeMock.mockImplementation(() => Promise.resolve(WORKSPACES))
})

/**
 * 新建工作空间的创建预置（产品默认值，2026-10-21 用户裁定）：弹窗保持纯
 * 名称表单；提交＝单次 workspace.create 携带 BaseUrl（本地 Flask 型服务）
 * 与 bearer 令牌变量认证——新建即开箱可发请求，详情页随时可改。
 */
describe('新建工作空间：创建预置默认值', () => {
  it('名称弹窗提交＝单次 create 载荷携带 BaseUrl 与 bearer 认证预置', async () => {
    render(<WorkspacesDialogHost />, { wrapper: createQueryWrapper() })
    act(() => {
      useWorkspacesStore.getState().openDialog({ type: 'ws-new' })
    })
    await userEvent.type(await screen.findByLabelText('名称'), '预置空间')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('workspace.create', {
        name: '预置空间',
        baseUrl: 'http://127.0.0.1:5000',
        auth: '{"type":"bearer","token":"{{access_token}}"}',
      })
    })
  })
})
