/**
 * 草稿转正原语（「另存为新接口」）：内存草稿 → 落库实体＋用户数据 →
 * 新接口以常驻 Tab 打开。纯函数部分（plan）与执行序列（hook）分离——
 * plan 是可复用的单点口径（任何来源的草稿数据都能经它得出落库输入），
 * hook 分两层：执行核（usePromoteDraftData，不碰 Tab）供草稿 Tab 转正
 * 与接口编辑器「另存为新接口」共用，usePromoteDraft 在其上补草稿 Tab
 * 的关闭换装。
 */

import { toast } from '@workspace/ui/components'

import { useI18n } from '@/i18n'
import { useTreeMutations } from '@/features/api-tree/use-tree-mutations'
import { useCurrentWorkspaceTreeQuery } from '@/features/workspaces/api'
import { reportError } from '@/services/error-center'
import {
  userDataUpsert,
  type EndpointDto,
  type ManualEndpointInput,
} from '@/services/workbench-api'
import { useTabsStore } from '@/stores/tabs.store'

import { useDraftStore, type EndpointDraftData } from './draft.store'

/** 转正落库计划：实体输入（未分类散层）＋用户数据整包 */
export interface DraftPromotionPlan {
  endpoint: ManualEndpointInput
  userData: {
    body: string | null
    params: string
    headers: string
    timeoutSeconds: number | null
    auth: string | null
  }
}

/** 转正标题长度上限（与草稿 Tab 标题同视觉收敛） */
const PROMOTION_TITLE_MAX_CHARS = 80

/**
 * 草稿数据 → 落库计划（纯函数）：当前服务下未分类的新手工接口；超时与
 * 认证不随草稿（快照无此两列的意图面，转正后由接口编辑器显式配置）。
 */
export function draftPromotionPlan(data: EndpointDraftData, serviceId: string): DraftPromotionPlan {
  return {
    endpoint: {
      serviceId,
      method: data.method,
      pathTemplate: data.pathTemplate,
      title: `${data.method} ${data.pathTemplate}`.slice(0, PROMOTION_TITLE_MAX_CHARS),
      categoryId: null,
    },
    userData: {
      body: data.body,
      params: data.paramsJson,
      headers: data.headersJson,
      timeoutSeconds: null,
      auth: null,
    },
  }
}

/**
 * 转正执行核（任何来源的草稿数据共用）：落点判定 → 建实体 → 写用户数据，
 * 返回新建实体（失败已上报、返回 null）。Tab 换装不在内——由调用方按
 * 自己的宿主形态决定（草稿 Tab 关闭换装，接口 Tab 原样保留并另开新 Tab）。
 * 两步 IPC 非原子：实体创建成功而用户数据写失败时仍继续（不留在半途
 * 态让重复点击再造实体），失败上报——草稿内容可从历史快照再恢复一次
 * （历史是恢复动作的源头，天然兜底）。
 */
export function usePromoteDraftData(): (data: EndpointDraftData) => Promise<EndpointDto | null> {
  const { t } = useI18n()
  const treeQuery = useCurrentWorkspaceTreeQuery()
  const treeMutations = useTreeMutations(treeQuery.workspaceId ?? '')

  return async (data: EndpointDraftData) => {
    const services = treeQuery.data?.services ?? []
    if (services.length === 0) {
      // 无服务可落库：本地前置校验失败，走本地化中性提示——无对应后端
      // 错误，不伪造 IPC 错误码借字典映射
      toast.info(t('editor.promotionNoService'))
      return null
    }
    // 落点优先级：仍在树中的来源服务 → 树首个服务
    const target = services.find((service) => service.id === data.sourceServiceId) ?? services[0]!

    const plan = draftPromotionPlan(data, target.id)
    let created
    try {
      created = await treeMutations.endpointCreateMutation.mutateAsync(plan.endpoint)
    } catch (error) {
      reportError(error)
      return null
    }
    try {
      await userDataUpsert(
        created.serviceId,
        created.key,
        plan.userData.body,
        plan.userData.params,
        plan.userData.headers,
        plan.userData.timeoutSeconds,
        plan.userData.auth,
        null,
        null,
      )
    } catch (error) {
      // 实体已建：继续换装流程（见函数注释的取舍），只上报用户数据写失败
      reportError(error)
    }
    return created
  }
}

/**
 * 转正执行（草稿 Tab 工具行动作）：建实体 → 写用户数据 → Tab 换装。
 */
export function usePromoteDraft(): (draftTabId: string) => Promise<void> {
  const promoteData = usePromoteDraftData()

  return async (draftTabId: string) => {
    const data = useDraftStore.getState().drafts[draftTabId]
    if (!data) return
    const created = await promoteData(data)
    if (!created) return
    // Tab 换装：草稿 Tab 关闭（收缩信号自动清草稿条目）→ 常驻打开新接口
    useTabsStore.getState().close(draftTabId)
    useTabsStore
      .getState()
      .openEndpoint(
        { serviceId: created.serviceId, key: created.key, title: created.title },
        'persistent',
      )
  }
}
