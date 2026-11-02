/**
 * HTTP 执行域 IPC 薄封装：http.* / sse.* 命令的参数与 DTO 类型镜像
 * （与 Rust command 签名一一对应，camelCase，沿 workbench-api.ts 惯例）。
 *
 * query key 约定（单一事实源，组件不自拼键）：
 * - ['http', 'history', workspaceId, page]：请求历史分页（History 视图消费；
 *   数据作用域隐式跟随后端当前空间，workspaceId 入键后缓存域随空间隔离，
 *   切空间＝新键即重取，不依赖失效通道）
 * 发送完成（普通与 SSE 同链落 Run Record）统一经 invalidateHistory 失效前缀。
 */

import { queryClient } from '@/app/query-client'
import { invoke } from '@/services/ipc'

import type { RunOutcome } from './send-state'

// —— DTO 类型（Rust 序列化形态镜像，camelCase） ——

/** body 快照口径：excerpt ≤64KB（utf8 lossy）＋truncated＋总量 */
export interface BodyExcerptDto {
  excerpt: string
  truncated: boolean
  totalSize: number
  /**
   * 原始字节的 base64：仅内存档响应携带（≤2MB 有界，超出只给 excerpt），
   * 是编码选择器重解码与 Preview 渲染的原始字节源；缺省＝需经
   * httpReadRange 分段读原始字节（文件档）。
   */
  rawBase64?: string
}

/** 认证派生的脱敏提示（敏感头名 / query 键 / 本次消费的 Secret 变量值；
 * 展示层据此默认脱敏——Secret 值对请求镜像全文替换掩码） */
export interface RedactionHintsDto {
  headerNames: string[]
  queryKeys: string[]
  secretValues: string[]
}

/** 单次模板解析的消费记录（命中 / 未命中标示；secret 行的 resolved 值展示端掩码） */
export interface ResolutionHitDto {
  template: string
  key: string
  resolved: string
  hit: boolean
  secret: boolean
}

/** 变量解析预览（随发送响应附带：解析后 URL＋命中记录＋本次消费的 Secret 值清单） */
export interface ResolvedPreviewDto {
  url: string
  hits: ResolutionHitDto[]
  /** 本次消费的 Secret 变量值清单（与镜像 redactions 同一来源）：预览 URL
   *  的掩码输入用它（展示端不从 hits 推导——同一概念一种来源） */
  secretValues: string[]
}

export interface RequestSnapshotDto {
  method: string
  url: string
  headers: [string, string][]
  body: BodyExcerptDto | null
  redactions: RedactionHintsDto
}

export interface ResponseSnapshotDto {
  status: number
  headers: [string, string][]
  contentType: string | null
  body: BodyExcerptDto
}

/** 单次发送完整结果（GUI 响应面板与 CLI 输出共用 DTO） */
export interface RunResultDto {
  runId: string
  state: RunOutcome
  statusCode: number | null
  durationMs: number | null
  errorCode: string | null
  errorMessage: string | null
  /** 实际发送镜像（最终 URL / headers 全量 / 脱敏提示） */
  request: RequestSnapshotDto
  /** 响应快照（failed / cancelled＝null） */
  response: ResponseSnapshotDto | null
  /** 大响应锚 id（文件档时的 range-read 凭据；内存档＝null） */
  responseId: string | null
  /** 变量解析预览（发送前确认命中情况；合成失败＝空 url 空记录） */
  resolved: ResolvedPreviewDto
}

// —— 命令参数（http.send 与 sse.start 同构：身份＋草稿五列＋覆写） ——

export interface SendArgs {
  serviceId: string
  key: string
  tabId: string
  body: string | null
  params: string
  headers: string
  timeoutSeconds: number | null
  auth: string | null
  /** 路径覆写（用户数据层；null＝跟随接口定义） */
  pathOverride: string | null
  /** 方法覆写（用户数据层；null＝跟随接口定义） */
  methodOverride: string | null
  /** 接口级 BaseUrl 覆写（variable store 的 Tab 会话态；null＝跟随工作空间） */
  baseUrlOverride: string | null
}

/** 普通发送：后端先整包落草稿再发送（编辑器防抖写与发送竞速时以此整包为准） */
export function httpSend(args: SendArgs): Promise<RunResultDto> {
  return invoke<RunResultDto>('http.send', { ...args })
}

/** 取消 Tab 作用域的在途请求（普通发送与 SSE 同键；幂等） */
export function httpCancel(tabId: string): Promise<boolean> {
  return invoke<boolean>('http.cancel', { tabId })
}

/**
 * 关 Tab 清理：取消该 Tab 在途请求（幂等）＋单键删除其响应临时文件。
 * 关 Tab / 关闭其他 / 关闭右侧 / 关闭全部 / 切工作空间（restore 整体替换）
 * 都经 tabs 收缩信号逐死 Tab 调用（fire-and-forget，失败静默不阻塞 UI）。
 */
export function httpTabClosed(tabId: string): Promise<boolean> {
  return invoke<boolean>('http.tab_closed', { tabId })
}

/** 大响应全量查看的分段读取（后端单段上限 1MB；文件缺失返回空段） */
export function httpReadRange(
  responseId: string,
  offset: number,
  len: number,
): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('http.read_range', { responseId, offset, len })
}

// —— 响应体保存 ——

/** 保存响应体结果（Rust SaveResponseDto 镜像）：写出字节数 */
export interface SaveResponseDto {
  savedBytes: number
}

/**
 * 保存响应体原始字节到用户选定路径（路径来自保存对话框，不落库）：
 * 文件档（responseId 携带）Rust 从临时文件分段拼装写盘（50MB 上限护栏）；
 * 内存档（contentBase64 携带 DTO rawBase64 原样回传）解码写盘。
 */
export function httpSaveResponse(args: {
  responseId: string | null
  contentBase64: string | null
  targetPath: string
}): Promise<SaveResponseDto> {
  return invoke<SaveResponseDto>('http.save_response', { ...args })
}

// —— SSE（事件流）——

export interface SseStartDto {
  streamId: string
}

export function sseStart(args: SendArgs): Promise<SseStartDto> {
  return invoke<SseStartDto>('sse.start', { ...args })
}

/** SSE 首事件（seq=0）携带的响应元信息 */
export interface SseMetaDto {
  status: number
  headers: [string, string][]
  contentType: string | null
}

/** SSE 事件 payload（事件名＝`sse://<streamId>`；序列号单调递增） */
export interface SseEventDto {
  seq: number
  /** 增量文本（utf8 lossy；各事件累计＝已接收全文） */
  text: string
  /** 终态：流正常结束 */
  done: boolean
  /** 终态：用户取消（已收部分保留） */
  cancelled: boolean
  /** 终态：传输失败（连接层错误） */
  error: { code: string; message: string } | null
  /** 仅 seq=0 携带 */
  meta: SseMetaDto | null
}

/** SSE 升级告知事件 payload（事件名＝`sse-upgrade://<tabId>`）：普通发送
 * （http.send）命中事件流响应时后端即时推送——invoke 在流终态才返回，前端
 * 在返回前无从得知流 id（runId），经此 tab 作用域事件提前拿到流身份与
 * 响应元信息，发送中立起流式视图 */
export interface SseUpgradeDto {
  streamId: string
  meta: SseMetaDto
}

// —— query key 工厂（单一事实源） ——

export const httpKeys = {
  /** workspaceId 入键（缓存域随空间隔离）；null 空间期间由调用方以 '' 占位并
   * enabled 门控（沿 workspaces 域 tree 键的同款约定） */
  history: (workspaceId: string, page: number) => ['http', 'history', workspaceId, page] as const,
  /** 历史前缀（发送完成后整体失效：新 Run Record 落库，任意空间任意分页都可能过期） */
  historyRoot: () => ['http', 'history'] as const,
}

/** 发送完成联动：Run Record 已由编排层落库，前端失效历史缓存即可 */
export function invalidateHistory(): void {
  void queryClient.invalidateQueries({ queryKey: httpKeys.historyRoot() })
}
