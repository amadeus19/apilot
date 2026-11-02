import type { TreeDropMode } from '@workspace/ui/components'

import type { WorkflowNavIndex, WorkflowNavNode } from './workflow-nav-tree'

/**
 * 工作流树拖拽落点判定（纯函数，单测点）。
 *
 * 层级约束：工作流拖到分组行＝移入该组尾部（整行视为进入，分组序列位置
 * 对工作流无语义）；拖到工作流行＝插到其前 / 后，桶随目标行（同组内重排
 * 与跨组移动共用同一语义）；分组只能落在分组行做组间序列重排，分组不
 * 嵌套也不落工作流行。序号基线＝排除被拖项后的桶现序（与后端 move 通道
 * 的插入基线一致）；越界钳制归后端。
 */

/** 一条可执行的拖拽落点动作（与 workflow.move / workflow.group_move 参数对应） */
export type WorkflowDropAction =
  | { kind: 'workflow'; id: string; groupId: string | null; index: number }
  | { kind: 'group'; id: string; index: number }

/** 工作流行所属桶（组 id；未分组＝null） */
export function workflowBucketOf(index: WorkflowNavIndex, id: string): string | null {
  for (const [groupId, children] of index.groupChildren) {
    if (children.includes(id)) return groupId
  }
  return null
}

/** 桶内工作流序（排除被拖项后即插入基线；未分组桶取根子级中的工作流段） */
function workflowBucketSiblings(
  index: WorkflowNavIndex,
  groupId: string | null,
  excludeId: string,
): string[] {
  if (groupId === null) {
    return index.rootChildren.filter((id) => {
      if (id === excludeId) return false
      return index.nodes.get(id)?.kind === 'workflow'
    })
  }
  return (index.groupChildren.get(groupId) ?? []).filter((id) => id !== excludeId)
}

/**
 * 行在序列内的相邻移动落点（右键「上移 / 下移」与键盘等价路径共用）；
 * null＝该方向已到边界。序号基线＝排除自身后的序列，与 move 通道一致。
 */
function neighborIndexes(
  siblings: readonly string[],
  id: string,
): { up: number | null; down: number | null } {
  const at = siblings.indexOf(id)
  if (at < 0) return { up: null, down: null }
  return {
    up: at > 0 ? at - 1 : null,
    down: at < siblings.length - 1 ? at + 1 : null,
  }
}

/** 工作流行上移 / 下移落点（含所属桶）；搜索过滤态序号不可信，调用方禁用 */
export function workflowMoveNeighbors(
  index: WorkflowNavIndex,
  id: string,
): { bucket: string | null; up: number | null; down: number | null } {
  const bucket = workflowBucketOf(index, id)
  // 空串排除项不命中任何行＝取含自身的完整桶序
  const siblings = workflowBucketSiblings(index, bucket, '')
  return { bucket, ...neighborIndexes(siblings, id) }
}

/** 分组行上移 / 下移落点；搜索过滤态序号不可信，调用方禁用 */
export function groupMoveNeighbors(
  index: WorkflowNavIndex,
  id: string,
): { up: number | null; down: number | null } {
  const groupIds = index.rootChildren.filter((rowId) => index.nodes.get(rowId)?.kind === 'group')
  return neighborIndexes(groupIds, id)
}

/**
 * 计算拖拽落点：返回 null＝此处不可落（不显示指示器）；
 * 返回值携带指示器形态与可直接下发的移动动作。
 */
export function computeWorkflowTreeDrop(
  source: WorkflowNavNode,
  target: WorkflowNavNode,
  /** 悬停点在目标行内的纵向比例（0 顶 1 底） */
  ratio: number,
  index: WorkflowNavIndex,
): { indicator: TreeDropMode; action: WorkflowDropAction } | null {
  if (source.id === target.id) return null

  if (source.kind === 'workflow') {
    if (target.kind === 'group') {
      // 进目标分组尾部（整行视为进入）
      return {
        indicator: 'inside',
        action: {
          kind: 'workflow',
          id: source.id,
          groupId: target.id,
          index: workflowBucketSiblings(index, target.id, source.id).length,
        },
      }
    }
    // 目标工作流行：插其前 / 后，桶随目标行（组内或未分组）
    const bucket = workflowBucketOf(index, target.id)
    const siblings = workflowBucketSiblings(index, bucket, source.id)
    const at = siblings.indexOf(target.id)
    if (at < 0) return null
    const mode: TreeDropMode = ratio < 0.5 ? 'before' : 'after'
    return {
      indicator: mode,
      action: {
        kind: 'workflow',
        id: source.id,
        groupId: bucket,
        index: mode === 'before' ? at : at + 1,
      },
    }
  }

  // 源＝分组：只可落在分组行做组间重排（不嵌套、不落工作流行）
  if (target.kind !== 'group') return null
  const groupSiblings = index.rootChildren.filter((id) => {
    if (id === source.id) return false
    return index.nodes.get(id)?.kind === 'group'
  })
  const at = groupSiblings.indexOf(target.id)
  if (at < 0) return null
  const mode: TreeDropMode = ratio < 0.5 ? 'before' : 'after'
  return {
    indicator: mode,
    action: { kind: 'group', id: source.id, index: mode === 'before' ? at : at + 1 },
  }
}
