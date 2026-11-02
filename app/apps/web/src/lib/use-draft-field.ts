import * as React from 'react'

/**
 * 「跟随真值直到用户触碰」的草稿字段 seam。
 *
 * 修一类 bug：详情页草稿「一次性播种」不随外部真值同步——页面开着时他处
 * （左栏 / 全局对话框）改名直写缓存后，页面草稿仍持旧值，用户一点进点出
 * 输入框就以旧值为基线触发写库，静默回滚他处改名。本 seam 把播种模型换成
 * 跟随模型：
 *
 * - 未触碰（无草稿）＝显示值直接派生自 server 真值，真值随缓存刷新自动
 *   跟上——没有需要同步的本地状态，也就没有失同步；
 * - 触碰（focus / 首键，经 begin / set）才建立草稿，并记录「建立时的真值
 *   基线」——此后真值变化不再覆盖用户草稿（用户拥有编辑会话）；
 * - 落盘（commitIfChanged）以基线判变：草稿期间真值被外部改写，只要用户
 *   相对基线没有实际改动就不上抛，随后回跟随呈现外部新值——脏写回滚路径
 *   由此封死；
 * - 撤销（reset）丢弃草稿回跟随（Esc 语义）。
 *
 * 本 hook 纯状态推导、无 effect 同步外部系统，播种 / 回落不经 effect 内
 * setState；调用方把 begin / set 挂到 focus / 首键事件、commitIfChanged 挂
 * 到 blur、reset 挂到 Esc 即得完整编辑会话语义。
 */

/** 草稿字段实例（value 每渲染重算，方法引用仅供事件回调直调） */
export interface DraftField<T> {
  /** 当前应显示的值：用户草稿优先；未触碰时跟随 server 真值 */
  readonly value: T
  /** 用户草稿是否在场（触碰后、提交 / 撤销前） */
  readonly hasDraft: boolean
  /** 进入草稿态：以当前显示值播种草稿并记录基线（已在场则保持不动） */
  begin: () => void
  /** 编辑草稿（首键路径：未建立时等价 begin 后更新值） */
  set: (next: T) => void
  /** 撤销草稿回跟随（Esc 语义） */
  reset: () => void
  /**
   * 落盘：草稿相对基线有实际改动才把草稿值上抛给 commit；无论上抛与否
   * 都退出草稿态回跟随。返回是否上抛。
   */
  commitIfChanged: (commit: (draft: T) => void) => boolean
}

/** 草稿内部形态：用户值＋建立时的真值基线 */
interface DraftEntry<T> {
  value: T
  baseline: T
}

export function useDraftField<T>(
  serverValue: T,
  equals: (a: T, b: T) => boolean = Object.is,
): DraftField<T> {
  const [draft, setDraft] = React.useState<DraftEntry<T> | null>(null)

  const begin = () => {
    setDraft((current) => current ?? { value: serverValue, baseline: serverValue })
  }

  const set = (next: T) => {
    setDraft((current) =>
      current === null ? { value: next, baseline: serverValue } : { ...current, value: next },
    )
  }

  const reset = () => {
    setDraft(null)
  }

  const commitIfChanged = (commit: (draft: T) => void): boolean => {
    if (draft === null) return false
    const changed = !equals(draft.value, draft.baseline)
    if (changed) commit(draft.value)
    setDraft(null)
    return changed
  }

  return {
    value: draft === null ? serverValue : draft.value,
    hasDraft: draft !== null,
    begin,
    set,
    reset,
    commitIfChanged,
  }
}
