import { invoke } from '@/services/ipc'

/**
 * 响应快照小窗的前端契约面：窗口 label、命令对与载荷形态是与建窗侧
 * （Rust）对齐的写死契约，两侧不得单独漂移。
 */

/** 快照窗 label：boot 分流识别自身（主窗与快照窗共用同一 index.html 入口） */
export const SNAPSHOT_WINDOW_LABEL = 'response-snapshot'

/** 快照载荷：title＝窗口标题（接口 / Tab 名），content＝定格的 pretty 文本 */
export interface ResponseSnapshotPayload {
  title: string
  content: string
  contentType: 'json' | 'text'
}

/** 主窗入口：把当前响应 pretty 文本定格到独立快照小窗（建窗由 Rust 侧完成）。
 * 参数对象以 `payload` 为键包裹（命令签名按参数名取键，摊开会报
 * missing required key payload） */
export function openResponseSnapshot(payload: ResponseSnapshotPayload): Promise<void> {
  return invoke<void>('open_response_snapshot', { payload })
}

/** 快照窗入口：拉取定格载荷（null＝无定格内容，渲染空态） */
export function getResponseSnapshot(): Promise<ResponseSnapshotPayload | null> {
  return invoke<ResponseSnapshotPayload | null>('get_response_snapshot')
}
