import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'

// —— IPC 替换：run.list 走桩（按 page 参数分派）；workspace.list 回当前空间 w1 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

// —— 剪贴板替换（jsdom 无 navigator.clipboard；菜单「复制 URL」消费） ——
const writeTextMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))

import { HistoryPanel } from '../history-panel'
import { HISTORY_PAGE_SIZE, type RunListItemDto } from '../history-api'
import { createQueryWrapper } from '@/test/render-providers'
import { useAppStore } from '@/stores/app.store'
import { useTabsStore } from '@/stores/tabs.store'

/** 历史行夹具：ageMs＝距今毫秒（createdAt 由真实当前时间回推，相对时间随构造稳定） */
function makeItem(
  runId: string,
  ageMs: number,
  overrides?: Partial<RunListItemDto>,
): RunListItemDto {
  return {
    runId,
    state: 'passed',
    method: 'GET',
    url: `http://localhost:8080/api/${runId}?page=1`,
    statusCode: 200,
    durationMs: 340,
    source: 'gui',
    createdAt: new Date(Date.now() - ageMs).toISOString(),
    endpointName: null,
    ...overrides,
  }
}

/** 三条样本（不同 method / 状态 / 来源 / 年龄，供行字段与过滤断言） */
function sampleRows(): RunListItemDto[] {
  return [
    makeItem('r-today', 3_000),
    makeItem('r-yesterday', 26 * 3_600_000, {
      method: 'POST',
      statusCode: 404,
      source: 'cli',
    }),
    makeItem('r-earlier', 5 * 86_400_000, {
      statusCode: null,
      durationMs: null,
      state: 'cancelled',
    }),
  ]
}

/** run.list 桩：pages＝按页码的数据表；未登记页返回空（面板数据作用域＝w1） */
function stubRunList(pages: Record<number, RunListItemDto[]>): void {
  invokeMock.mockImplementation((cmd: string, args?: { page?: number }) => {
    if (cmd === 'workspace.list') {
      return Promise.resolve({ items: [], currentId: 'w1' })
    }
    if (cmd === 'run.list') {
      const page = args?.page ?? 1
      return Promise.resolve(pages[page] ?? [])
    }
    return Promise.resolve(undefined)
  })
}

/** 可持引用 QueryClient 的渲染包装器（切空间用例需经缓存驱动清单重取） */
function renderWithClient(ui: ReactElement): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  render(ui, { wrapper: Wrapper })
  return queryClient
}

beforeEach(() => {
  invokeMock.mockReset()
  writeTextMock.mockClear()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: writeTextMock },
  })
  useTabsStore.setState({ tabs: [], activeTabId: null })
})

describe('历史列表：行字段与接口名', () => {
  it('平铺不分组；行字段齐全（方法 / source 芯片 / 路径 / 状态芯片 / 耗时 / 相对时间）', async () => {
    stubRunList({ 1: sampleRows() })
    render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(3)
    })

    // 平铺：无分组头
    expect(screen.queryByText('今天')).not.toBeInTheDocument()
    expect(screen.queryByText('昨天')).not.toBeInTheDocument()

    // 方法徽标（GET×2 / POST×1）与 source 芯片（GUI×2 / CLI×1）
    expect(screen.getAllByText('POST')).toHaveLength(1)
    expect(screen.getAllByText('GET')).toHaveLength(2)
    expect(screen.getAllByText('GUI')).toHaveLength(2)
    expect(screen.getAllByText('CLI')).toHaveLength(1)
    // 行内首行顺序＝source 芯片在前、方法徽章在后（GUI POST）
    const firstRow = screen.getAllByTestId('history-row')[0]!
    const source = firstRow.querySelector('[data-testid="history-row-source"]')!
    expect(
      source.compareDocumentPosition(firstRow.querySelector('[data-testid="history-row-path"]')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(source.nextElementSibling).toHaveTextContent('GET')
    // 相对时间（今天条目＝3 秒前构造）
    expect(screen.getByText(/3 秒前/)).toBeInTheDocument()
  })

  it('次行接口名：endpointName 有值显示接口名，落空回落 path 段（不含 query）', async () => {
    stubRunList({
      1: [makeItem('r-named', 3_000, { endpointName: '用户列表' }), makeItem('r-fallback', 20_000)],
    })
    render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(2)
    })

    const metaOf = (runId: string) =>
      screen
        .getAllByTestId('history-row')
        .find((row) => row.dataset.runId === runId)!
        .querySelector('[data-testid="history-row-meta"]')!
    expect(metaOf('r-named').textContent).toBe('340ms · 3 秒前 · 用户列表')
    expect(metaOf('r-fallback').textContent).toBe('340ms · 20 秒前 · /api/r-fallback')
  })

  it('状态芯片着色：2xx 绿 / 4xx 琥珀 / 5xx 红 / 取消灰（成词）；耗时与相对时间并陈', async () => {
    stubRunList({
      1: [
        makeItem('r-2xx', 3_000, { statusCode: 200 }),
        makeItem('r-4xx', 3_600_000, { statusCode: 404 }),
        makeItem('r-5xx', 3_700_000, { statusCode: 502 }),
        makeItem('r-none', 86_400_000 * 3, { statusCode: null, state: 'cancelled' }),
      ],
    })
    render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(4)
    })

    const statusOf = (runId: string) =>
      screen
        .getAllByTestId('history-row')
        .find((row) => row.dataset.runId === runId)!
        .querySelector('[data-testid="history-row-status"]')!
    expect(statusOf('r-2xx').className).toContain('text-success')
    expect(statusOf('r-4xx').className).toContain('text-warning')
    expect(statusOf('r-5xx').className).toContain('text-destructive')
    expect(statusOf('r-none').className).toContain('text-muted-foreground')
    // 取消行成词显示（不是裸 —）
    expect(statusOf('r-none')).toHaveTextContent('取消')

    // 次行元信息：耗时 · 相对时间 · 接口名（回落 path 段）
    const metaOf = (runId: string) =>
      screen
        .getAllByTestId('history-row')
        .find((row) => row.dataset.runId === runId)!
        .querySelector('[data-testid="history-row-meta"]')!
    expect(metaOf('r-2xx').textContent).toBe('340ms · 3 秒前 · /api/r-2xx')
    // 取消行无耗时：元信息从相对时间起头
    expect(metaOf('r-none').textContent).toContain('3 天前')
  })

  it('路径列显示 path＋query，title 提示完整 URL；方法徽标原样呈现', async () => {
    stubRunList({
      1: [
        makeItem('r1', 3_000, { method: 'DELETE', url: 'http://localhost:8080/api/orders/42?x=1' }),
      ],
    })
    render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })
    await waitFor(() => {
      expect(screen.getByTestId('history-row-path')).toBeInTheDocument()
    })
    expect(screen.getByTestId('history-row-path')).toHaveTextContent('/api/orders/42?x=1')
    expect(screen.getByTestId('history-row-path')).toHaveAttribute(
      'title',
      'http://localhost:8080/api/orders/42?x=1',
    )
    expect(screen.getByText('DELETE')).toBeInTheDocument()
  })
})

describe('历史列表：搜索过滤', () => {
  it('路径子串过滤（平铺列表行数随命中收敛）', async () => {
    stubRunList({ 1: sampleRows() })
    const { rerender } = render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(3)
    })

    rerender(<HistoryPanel searchQuery="r-yesterday" onSearchChange={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(1)
    })
    expect(screen.getAllByTestId('history-row')[0]!.dataset.runId).toBe('r-yesterday')

    // 无匹配：过滤空态＋清除入口
    rerender(<HistoryPanel searchQuery="no-such-path" onSearchChange={vi.fn()} />)
    expect(screen.getByText('无匹配记录')).toBeInTheDocument()
    const onSearchChange = vi.fn()
    rerender(<HistoryPanel searchQuery="no-such-path" onSearchChange={onSearchChange} />)
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
    expect(onSearchChange).toHaveBeenCalledWith('')
  })
})

describe('历史列表：点击行与单例详情 Tab', () => {
  it('点击行打开单例历史详情 Tab（不勾选）；再点另一行原位替换内容指针并保持单例', async () => {
    stubRunList({ 1: sampleRows() })
    render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(3)
    })

    const rows = () => screen.getAllByTestId('history-row')
    act(() => {
      fireEvent.click(rows().find((row) => row.dataset.runId === 'r-today')!)
    })
    let tabs = useTabsStore.getState().tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ id: 'historyDetail', kind: 'historyDetail', key: 'r-today' })
    expect(useTabsStore.getState().activeTabId).toBe('historyDetail')
    // 选中行线索：左侧强调条（沿树选中行惯例）；行点击不改勾选
    expect(
      rows()
        .find((row) => row.dataset.runId === 'r-today')!
        .querySelector('.bg-primary'),
    ).not.toBeNull()
    expect(rows().find((row) => row.dataset.runId === 'r-today')!.dataset.checked).toBeUndefined()

    act(() => {
      fireEvent.click(rows().find((row) => row.dataset.runId === 'r-yesterday')!)
    })
    tabs = useTabsStore.getState().tabs
    expect(tabs).toHaveLength(1) /* 单例：不新增 Tab */
    expect(tabs[0]!.key).toBe('r-yesterday')
  })
})

describe('历史列表：分页（页容量 50＋加载更多）', () => {
  it('满页显示「加载更多」；点击追加下一页；短页到底按钮消失', async () => {
    const page1 = Array.from({ length: HISTORY_PAGE_SIZE }, (_, index) =>
      makeItem(`p1-${index}`, 3_000),
    )
    const page2 = [makeItem('p2-0', 3_600_000), makeItem('p2-1', 3_700_000)]
    stubRunList({ 1: page1, 2: page2 })
    render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })
    await waitFor(() => {
      expect(screen.getByTestId('history-load-more')).toBeInTheDocument()
    })
    expect(screen.getAllByTestId('history-row')).toHaveLength(HISTORY_PAGE_SIZE)

    fireEvent.click(screen.getByTestId('history-load-more'))
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(HISTORY_PAGE_SIZE + 2)
    })
    // 第二页短页（2 < 50）：到底，按钮消失
    expect(screen.queryByTestId('history-load-more')).not.toBeInTheDocument()
    // 翻页请求按页码分派
    expect(invokeMock).toHaveBeenCalledWith('run.list', { page: 2, pageSize: HISTORY_PAGE_SIZE })
  })

  it('首页短页：无「加载更多」按钮', async () => {
    stubRunList({ 1: sampleRows() })
    render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(3)
    })
    expect(screen.queryByTestId('history-load-more')).not.toBeInTheDocument()
  })
})

describe('历史列表：工作空间作用域', () => {
  it('切换工作空间：键随 currentId 变化，面板不重挂载即按新空间重新拉取并展示新数据', async () => {
    const w1Rows = [makeItem('r-w1', 3_000)]
    const w2Rows = [makeItem('r-w2', 3_000)]
    let currentId: string | null = 'w1'
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'workspace.list') return Promise.resolve({ items: [], currentId })
      if (cmd === 'run.list') return Promise.resolve(currentId === 'w1' ? w1Rows : w2Rows)
      return Promise.resolve(undefined)
    })
    const queryClient = renderWithClient(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('history-row')).toHaveAttribute('data-run-id', 'r-w1')
    })

    // 模拟标题栏切换器：翻转清单 currentId 后重取清单查询（与切换 mutation
    // 成功后失效 ['workspaces'] 的通道同款），面板随清单重渲染换键重取
    currentId = 'w2'
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['workspaces'] })
    })
    await waitFor(() => {
      expect(screen.getByTestId('history-row')).toHaveAttribute('data-run-id', 'r-w2')
    })
    // 新缓存域无数据：首页恰好再发一次（无多余请求抖动）
    const listCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'run.list')
    expect(listCalls).toHaveLength(2)
  })

  it('切换工作空间重置翻页进度：上一空间已加载的多页不带入新空间', async () => {
    const page1 = Array.from({ length: HISTORY_PAGE_SIZE }, (_, index) =>
      makeItem(`w1-p1-${index}`, 3_000),
    )
    const page2 = [makeItem('w1-p2-0', 3_600_000)]
    const w2Rows = [makeItem('r-w2', 3_000)]
    let currentId: string | null = 'w1'
    invokeMock.mockImplementation((cmd: string, args?: { page?: number }) => {
      if (cmd === 'workspace.list') return Promise.resolve({ items: [], currentId })
      if (cmd === 'run.list') {
        if (currentId === 'w2') return Promise.resolve(w2Rows)
        return Promise.resolve((args?.page ?? 1) === 1 ? page1 : page2)
      }
      return Promise.resolve(undefined)
    })
    const page2CallCount = () =>
      invokeMock.mock.calls.filter(
        ([cmd, args]) => cmd === 'run.list' && (args as { page?: number } | undefined)?.page === 2,
      ).length
    const queryClient = renderWithClient(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('history-load-more')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('history-load-more'))
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(HISTORY_PAGE_SIZE + 1)
    })
    expect(page2CallCount()).toBe(1)

    // 切到 w2：翻页进度归位，只拉首页；w2 短页无「加载更多」，也无新的第 2 页请求
    currentId = 'w2'
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['workspaces'] })
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(1)
    })
    expect(screen.queryByTestId('history-load-more')).not.toBeInTheDocument()
    expect(page2CallCount()).toBe(1)
  })

  it('工作空间未加载（currentId null）：历史查询保持门控，不发请求、面板停留加载态', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'workspace.list') return Promise.resolve({ items: [], currentId: null })
      return Promise.resolve(undefined)
    })
    const queryClient = renderWithClient(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />)
    // 清单查询已回（currentId null）后仍无历史请求：空身份键不空转一轮
    await waitFor(() => {
      expect(queryClient.getQueryState(['workspaces'])?.status).toBe('success')
    })
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'run.list')).toBe(false)
    expect(screen.getByText('加载中…')).toBeInTheDocument()
  })
})

describe('历史列表：刷新与空态', () => {
  it('手动刷新按钮：失效前缀触发已加载页重取（刷新 B 确定性兜底）', async () => {
    stubRunList({ 1: sampleRows() })
    render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(3)
    })
    const callsBefore = invokeMock.mock.calls.filter(([cmd]) => cmd === 'run.list').length
    expect(callsBefore).toBe(1)

    fireEvent.click(screen.getByTestId('history-refresh'))
    await waitFor(() => {
      const callsAfter = invokeMock.mock.calls.filter(([cmd]) => cmd === 'run.list').length
      expect(callsAfter).toBeGreaterThan(callsBefore)
    })
  })

  it('空列表：空态文案（搜索行与底栏恒在场——空列表也要能手动刷新与读总数）', async () => {
    stubRunList({ 1: [] })
    render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })
    await waitFor(() => {
      expect(screen.getByText('暂无请求记录')).toBeInTheDocument()
    })
    expect(screen.getByText('发送请求后，历史记录将在此显示')).toBeInTheDocument()
    expect(screen.getByTestId('history-refresh')).toBeInTheDocument()
    expect(screen.getByTestId('history-footer')).toBeInTheDocument()
    expect(screen.getByTestId('history-total-count')).toHaveTextContent('共 0 条')
  })

  it('加载失败：错误空态＋重试', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'run.list') return Promise.reject(new Error('db busy'))
      if (cmd === 'workspace.list') return Promise.resolve({ items: [], currentId: 'w1' })
      return Promise.resolve(undefined)
    })
    render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })
    await waitFor(() => {
      expect(screen.getByText('历史加载失败')).toBeInTheDocument()
    })
    expect(screen.getByText('db busy')).toBeInTheDocument()

    // 重试＝重发首页查询
    stubRunList({ 1: sampleRows() })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(3)
    })
  })
})

/** 渲染并等到行就绪（多数管理用例的前置） */
async function renderWithRows(pages: Record<number, RunListItemDto[]>) {
  stubRunList(pages)
  render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
    wrapper: createQueryWrapper(),
  })
  const rowCount = Object.values(pages).reduce((sum, page) => sum + page.length, 0)
  await waitFor(() => {
    expect(screen.getAllByTestId('history-row')).toHaveLength(rowCount)
  })
  const rowOf = (runId: string) =>
    screen.getAllByTestId('history-row').find((row) => row.dataset.runId === runId)!
  return { rowOf }
}

/** 已选计数文本断言 */
function expectCount(count: number) {
  return waitFor(() => {
    expect(screen.getByTestId('history-selection-count')).toHaveTextContent(`已选 ${count} 条`)
  })
}

/** 勾选指定行的行首 Checkbox */
function checkRow(runId: string): void {
  const checkbox = screen
    .getAllByTestId('history-row')
    .find((row) => row.dataset.runId === runId)!
    .querySelector('[data-testid="history-row-check"]')!
  fireEvent.click(checkbox)
}

describe('历史列表：常驻勾选（Checkbox 唯一入口）', () => {
  it('Checkbox 常驻每行（无多选模式进出）；点击勾选且不打开详情 Tab', async () => {
    await renderWithRows({ 1: sampleRows() })

    // 常驻：渲染即全行有 Checkbox，无「进入多选」触发按钮
    expect(screen.getAllByTestId('history-row-check')).toHaveLength(3)
    expect(screen.queryByTestId('history-select-toggle')).not.toBeInTheDocument()

    act(() => {
      checkRow('r-today')
    })
    await expectCount(1)
    expect(
      screen.getAllByTestId('history-row').find((row) => row.dataset.runId === 'r-today')!.dataset
        .checked,
    ).toBe('true')
    // Checkbox 点击不打开详情
    expect(useTabsStore.getState().tabs).toHaveLength(0)
  })

  it('行点击不改勾选（勾选唯一入口＝Checkbox）：点击行只打开详情', async () => {
    const { rowOf } = await renderWithRows({ 1: sampleRows() })

    act(() => {
      fireEvent.click(rowOf('r-today'), { ctrlKey: true })
      fireEvent.click(rowOf('r-yesterday'), { shiftKey: true })
    })
    // 修饰键点击也只走详情（勾选与修饰键解耦）
    await waitFor(() => {
      expect(useTabsStore.getState().tabs).toHaveLength(1)
    })
    await waitFor(() => {
      expect(screen.queryByTestId('history-selection-count')).not.toBeInTheDocument()
    })
  })

  it('取消勾选：计数与行勾选态同步回落', async () => {
    await renderWithRows({ 1: sampleRows() })

    act(() => {
      checkRow('r-today')
      checkRow('r-yesterday')
    })
    await expectCount(2)
    act(() => {
      checkRow('r-today')
    })
    await expectCount(1)
    expect(
      screen.getAllByTestId('history-row').find((row) => row.dataset.runId === 'r-today')!.dataset
        .checked,
    ).toBeUndefined()
  })

  it('三态判定按命中集逐项覆盖：命中集外的勾选不误判为全选态', async () => {
    stubRunList({ 1: sampleRows() })
    const { rerender } = render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(3)
    })

    // 勾选 r-earlier 后过滤到只剩未勾选的 r-today：中间杆而非全选
    act(() => {
      checkRow('r-earlier')
    })
    await expectCount(1)
    rerender(<HistoryPanel searchQuery="r-today" onSearchChange={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(1)
    })
    const box = screen.getByTestId('history-select-all')
    expect(box).toHaveAttribute('data-indeterminate')
    expect(box).not.toHaveAttribute('data-checked')

    // 点击＝全选当前命中集（选择集整体替换为命中集，计数收敛到 1）
    fireEvent.click(box)
    await expectCount(1)
    expect(
      screen.getAllByTestId('history-row').find((row) => row.dataset.runId === 'r-today')!.dataset
        .checked,
    ).toBe('true')
  })

  it('搜索过滤不改勾选集（跨过滤存续）', async () => {
    stubRunList({ 1: sampleRows() })
    const { rerender } = render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(3)
    })
    act(() => {
      checkRow('r-earlier')
    })
    await expectCount(1)

    // 过滤后 r-earlier 不在场：勾选集保留
    rerender(<HistoryPanel searchQuery="r-today" onSearchChange={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(1)
    })
    await expectCount(1)
  })
})

describe('历史列表：底部状态栏（常驻）', () => {
  it('三态全选框：未选→部分选（横杆）→全选→点击清空；全选作用当前列表已加载数据', async () => {
    await renderWithRows({ 1: sampleRows() })
    const selectAll = () => screen.getByTestId('history-select-all')

    // 未选：未勾选态、计数与删除按钮不显现
    expect(selectAll()).not.toHaveAttribute('data-checked')
    expect(selectAll()).not.toHaveAttribute('data-indeterminate')
    expect(screen.queryByTestId('history-selection-count')).not.toBeInTheDocument()
    expect(screen.queryByTestId('history-delete-selected')).not.toBeInTheDocument()

    // 勾选一行：部分选＝横杆
    act(() => {
      checkRow('r-today')
    })
    await expectCount(1)
    expect(selectAll()).toHaveAttribute('data-indeterminate')

    // 点击横杆：全选当前列表（3 条）
    fireEvent.click(selectAll())
    await expectCount(3)
    expect(selectAll()).toHaveAttribute('data-checked')
    expect(selectAll()).not.toHaveAttribute('data-indeterminate')
    expect(
      screen.getAllByTestId('history-row').find((row) => row.dataset.runId === 'r-earlier')!.dataset
        .checked,
    ).toBe('true')

    // 全选态再点：清空
    fireEvent.click(selectAll())
    await waitFor(() => {
      expect(screen.queryByTestId('history-selection-count')).not.toBeInTheDocument()
    })
    expect(selectAll()).not.toHaveAttribute('data-checked')
  })

  it('全选口径＝搜索命中集：过滤后全选只勾可见行', async () => {
    stubRunList({ 1: sampleRows() })
    const { rerender } = render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(3)
    })

    rerender(<HistoryPanel searchQuery="r-" onSearchChange={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(3)
    })
    rerender(<HistoryPanel searchQuery="r-yesterday" onSearchChange={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(1)
    })

    fireEvent.click(screen.getByTestId('history-select-all'))
    await expectCount(1)
    expect(
      screen.getAllByTestId('history-row').find((row) => row.dataset.runId === 'r-yesterday')!
        .dataset.checked,
    ).toBe('true')
  })

  it('总数恒显（未过滤全集口径）；删除按钮为纯文字、有勾选才显现', async () => {
    await renderWithRows({ 1: sampleRows() })

    expect(screen.getByTestId('history-total-count')).toHaveTextContent('共 3 条')
    expect(screen.queryByTestId('history-delete-selected')).not.toBeInTheDocument()

    act(() => {
      checkRow('r-today')
    })
    await expectCount(1)
    const deleteButton = screen.getByTestId('history-delete-selected')
    expect(deleteButton).toHaveTextContent('删除')
    expect(deleteButton.querySelector('svg')).toBeNull()
  })

  it('删除所选：确认后批量 invoke，勾选集修剪、计数消失、列表刷新无幽灵行', async () => {
    const { rowOf } = await renderWithRows({ 1: sampleRows() })

    act(() => {
      checkRow('r-today')
      checkRow('r-yesterday')
    })
    await expectCount(2)

    act(() => {
      fireEvent.click(screen.getByTestId('history-delete-selected'))
    })
    await waitFor(() => {
      expect(screen.getByText('将永久删除 2 条历史记录，删除后不可再查看。')).toBeInTheDocument()
    })
    stubRunList({ 1: sampleRows().filter((row) => row.runId === 'r-earlier') })
    act(() => {
      fireEvent.click(screen.getByTestId('history-delete-confirm'))
    })
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('run.delete', {
        ids: ['r-today', 'r-yesterday'],
      })
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(1)
    })
    // 勾选集修剪到 0：计数与删除按钮消失、三态框回未选态（底栏常驻）
    await waitFor(() => {
      expect(screen.queryByTestId('history-selection-count')).not.toBeInTheDocument()
    })
    expect(screen.queryByTestId('history-delete-selected')).not.toBeInTheDocument()
    expect(screen.getByTestId('history-select-all')).not.toHaveAttribute('data-checked')
    expect(rowOf('r-earlier')).toBeInTheDocument()
  })
})

describe('历史列表：右键菜单', () => {
  it('右键行打开菜单（打开详情 / 复制 URL / 删除三项）；「打开详情」打开单例 Tab', async () => {
    const { rowOf } = await renderWithRows({ 1: sampleRows() })

    fireEvent.contextMenu(rowOf('r-today'))
    await waitFor(() => {
      expect(screen.getByText('打开详情')).toBeInTheDocument()
    })
    expect(screen.getByText('复制 URL')).toBeInTheDocument()
    expect(screen.getByText('删除')).toBeInTheDocument()

    act(() => {
      fireEvent.click(screen.getByText('打开详情'))
    })
    const tabs = useTabsStore.getState().tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ kind: 'historyDetail', key: 'r-today' })
  })

  it('菜单「复制 URL」写入剪贴板（完整 URL 口径）', async () => {
    const { rowOf } = await renderWithRows({ 1: sampleRows() })

    fireEvent.contextMenu(rowOf('r-yesterday'))
    await waitFor(() => {
      expect(screen.getByText('复制 URL')).toBeInTheDocument()
    })
    act(() => {
      fireEvent.click(screen.getByText('复制 URL'))
    })
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('http://localhost:8080/api/r-yesterday?page=1')
    })
  })

  it('菜单「删除」走确认对话框，确认后 invoke run.delete 单条并刷新列表', async () => {
    const { rowOf } = await renderWithRows({ 1: sampleRows() })

    fireEvent.contextMenu(rowOf('r-today'))
    await waitFor(() => {
      expect(screen.getByText('删除')).toBeInTheDocument()
    })
    act(() => {
      fireEvent.click(screen.getByText('删除'))
    })
    // 确认对话框（destructive）：标题＋计数描述＋确认动作
    await waitFor(() => {
      expect(screen.getByText('删除历史记录')).toBeInTheDocument()
    })
    expect(screen.getByText('将永久删除 1 条历史记录，删除后不可再查看。')).toBeInTheDocument()

    // 确认前先把桩换成删除后的数据（invalidate 重取读新表）
    stubRunList({ 1: sampleRows().filter((row) => row.runId !== 'r-today') })
    act(() => {
      fireEvent.click(screen.getByTestId('history-delete-confirm'))
    })
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('run.delete', { ids: ['r-today'] })
    })
    // 失效重取：被删行消失（无幽灵行）
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(2)
    })
    expect(screen.queryByTestId('history-delete-confirm')).not.toBeInTheDocument()
  })

  it('删除确认可取消（不触发 IPC）', async () => {
    const { rowOf } = await renderWithRows({ 1: sampleRows() })

    fireEvent.contextMenu(rowOf('r-today'))
    await waitFor(() => {
      expect(screen.getByText('删除')).toBeInTheDocument()
    })
    act(() => {
      fireEvent.click(screen.getByText('删除'))
    })
    await waitFor(() => {
      expect(screen.getByText('删除历史记录')).toBeInTheDocument()
    })
    act(() => {
      // role 收窄：状态芯片「取消」与对话框按钮同文案（取消行成词显示）
      fireEvent.click(screen.getByRole('button', { name: '取消' }))
    })
    await waitFor(() => {
      expect(screen.queryByText('删除历史记录')).not.toBeInTheDocument()
    })
    expect(invokeMock).not.toHaveBeenCalledWith('run.delete', expect.anything())
    expect(screen.getAllByTestId('history-row')).toHaveLength(3)
  })
})

describe('历史列表：roving tabindex（方向键焦点导航）', () => {
  it('列表仅一个 Tab 停靠（默认首行）；↑↓ 移动焦点并交接停靠', async () => {
    await renderWithRows({ 1: sampleRows() })

    const rows = () => screen.getAllByTestId('history-row')
    const stops = () => rows().filter((row) => row.tabIndex === 0)
    expect(stops()).toHaveLength(1)
    expect(rows()[0]!.tabIndex).toBe(0)

    // 聚焦首行（onFocus 登记 focusedId），↓ 移到第二行：焦点交接、停靠交接
    act(() => {
      fireEvent.focus(rows()[0]!)
    })
    fireEvent.keyDown(screen.getByTestId('history-list'), { key: 'ArrowDown' })
    await waitFor(() => {
      expect(document.activeElement).toBe(rows()[1]!)
    })
    expect(rows()[0]!.tabIndex).toBe(-1)
    expect(rows()[1]!.tabIndex).toBe(0)

    // ↑ 回到首行
    fireEvent.keyDown(screen.getByTestId('history-list'), { key: 'ArrowUp' })
    await waitFor(() => {
      expect(document.activeElement).toBe(rows()[0]!)
    })
  })

  it('Enter 打开详情（键盘可达）；Space 无选择语义不响应（勾选键盘路径＝Checkbox）', async () => {
    await renderWithRows({ 1: sampleRows() })

    const rows = () => screen.getAllByTestId('history-row')
    fireEvent.keyDown(rows()[0]!, { key: 'Enter' })
    await waitFor(() => {
      expect(useTabsStore.getState().tabs).toHaveLength(1)
    })
    expect(useTabsStore.getState().tabs[0]).toMatchObject({ kind: 'historyDetail', key: 'r-today' })

    // 行 Space＝无操作（勾选不挂行上；Checkbox 自身可聚焦勾选）
    fireEvent.keyDown(rows()[0]!, { key: ' ' })
    expect(useTabsStore.getState().tabs).toHaveLength(1)
    expect(screen.queryByTestId('history-selection-count')).not.toBeInTheDocument()
  })
})

describe('历史列表：空态 CTA 与加载指示', () => {
  it('空态「去发送第一个请求」：无打开 Tab 时聚焦左栏接口树', async () => {
    useAppStore.setState({ leftView: 'history' })
    stubRunList({ 1: [] })
    render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })
    const cta = await screen.findByTestId('history-empty-cta')
    expect(cta).toHaveTextContent('去发送第一个请求')

    act(() => {
      fireEvent.click(cta)
    })
    expect(useAppStore.getState().leftView).toBe('apis')
  })

  it('空态 CTA：已有接口 Tab 时激活之（回到工作台），不切视图', async () => {
    useAppStore.setState({ leftView: 'history' })
    useTabsStore.setState({
      tabs: [
        {
          id: 'endpoint:s1:k1',
          kind: 'endpoint',
          title: '接口',
          serviceId: 's1',
          key: 'k1',
          preview: false,
        },
      ],
      activeTabId: null,
    })
    stubRunList({ 1: [] })
    render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })
    fireEvent.click(await screen.findByTestId('history-empty-cta'))
    expect(useTabsStore.getState().activeTabId).toBe('endpoint:s1:k1')
    expect(useAppStore.getState().leftView).toBe('history')
  })

  it('刷新指示仅首屏旋转：首查在途转、数据到场停、后台重取（手动刷新）不转', async () => {
    // 受控 promise：run.list 每次调用登记一个 resolver，用例手工放行
    const pending: Array<(rows: RunListItemDto[]) => void> = []
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'workspace.list') return Promise.resolve({ items: [], currentId: 'w1' })
      if (cmd === 'run.list') return new Promise((resolve) => pending.push(resolve))
      return Promise.resolve(undefined)
    })
    render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })

    // svg 的 className 是 SVGAnimatedString，断言走 class 属性
    const iconClass = () =>
      screen.getByTestId('history-refresh').querySelector('svg')!.getAttribute('class') ?? ''

    // 首屏初次加载（无数据、在途）：旋转
    await waitFor(() => expect(pending).toHaveLength(1))
    expect(iconClass()).toContain('animate-spin')

    // 数据到场：停止
    act(() => {
      pending[0]!(sampleRows())
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(3)
    })
    expect(iconClass()).not.toContain('animate-spin')

    // 手动刷新触发后台重取（已有数据）：在途窗口不旋转
    fireEvent.click(screen.getByTestId('history-refresh'))
    await waitFor(() => expect(pending).toHaveLength(2))
    expect(iconClass()).not.toContain('animate-spin')
    act(() => {
      pending[1]!(sampleRows())
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(3)
    })
  })
})

describe('历史列表：加载更多边界（总数恰为页容量倍数）', () => {
  it('下一页返回 0 条：一次点击后按钮立即收敛（不要求点第二次）', async () => {
    const page1 = Array.from({ length: HISTORY_PAGE_SIZE }, (_, index) =>
      makeItem(`p1-${index}`, 3_000),
    )
    stubRunList({ 1: page1, 2: [] })
    render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })
    await waitFor(() => {
      expect(screen.getByTestId('history-load-more')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('history-load-more'))
    // 空页到达：无新行、按钮消失（一次点击收敛）
    await waitFor(() => {
      expect(screen.queryByTestId('history-load-more')).not.toBeInTheDocument()
    })
    expect(screen.getAllByTestId('history-row')).toHaveLength(HISTORY_PAGE_SIZE)
    expect(invokeMock).toHaveBeenCalledWith('run.list', { page: 2, pageSize: HISTORY_PAGE_SIZE })
  })
})

describe('历史列表：搜索口径（method / 状态码并列命中）', () => {
  it('method 与状态码关键词在列表过滤生效', async () => {
    stubRunList({ 1: sampleRows() })
    const { rerender } = render(<HistoryPanel searchQuery="" onSearchChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(3)
    })

    // method 命中：仅 POST 行（r-yesterday）
    rerender(<HistoryPanel searchQuery="post" onSearchChange={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(1)
    })
    expect(screen.getAllByTestId('history-row')[0]!.dataset.runId).toBe('r-yesterday')

    // 状态码命中：404 行（r-yesterday）
    rerender(<HistoryPanel searchQuery="404" onSearchChange={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(1)
    })
    expect(screen.getAllByTestId('history-row')[0]!.dataset.runId).toBe('r-yesterday')

    // 状态码命中（数字串子串）：'20' 命中 200（r-today），404 与无状态码行不中
    rerender(<HistoryPanel searchQuery="20" onSearchChange={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(1)
    })
    expect(screen.getAllByTestId('history-row')[0]!.dataset.runId).toBe('r-today')
  })
})
