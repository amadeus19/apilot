/**
 * Tauri IPC 统一封装。
 *
 * Rust 侧所有 Command 返回 `Result<T, AppError>`，Err 被 Tauri 序列化为
 * `{ kind: "apilot_error", code, message, details? }`。本模块负责：
 * 1. 解包：把该形态转换为前端统一异常 `IpcError`；
 * 2. 分类：`isBlockingCode` 判定阻断性错误（对话框呈现），其余为瞬态（Toast 呈现）；
 * 3. devMode：开启时错误呈现附带稳定 code（方便开发期定位）。
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core'

// Tauri invoke 的原始形态（@tauri-apps/api/core 无公开错误类型，此处按 AppError 序列化契约描述）
interface AppErrorPayload {
  kind: 'apilot_error'
  code: string
  message: string
  details?: unknown
}

/** 前端统一 IPC 异常：AppError 解包结果，或包装后的未知异常（code = "INTERNAL"） */
export class IpcError extends Error {
  /** 稳定错误码（Rust 侧 code，原样透传） */
  readonly code: string
  /** 结构化补充信息（插值用） */
  readonly details?: unknown
  /** 是否来自 Rust AppError（false = JS 侧未知异常） */
  readonly fromAppError: boolean

  constructor(payload: {
    code: string
    message: string
    details?: unknown
    fromAppError: boolean
  }) {
    super(payload.message)
    this.name = 'IpcError'
    this.code = payload.code
    this.details = payload.details
    this.fromAppError = payload.fromAppError
  }
}

/** 判定 invoke 抛出的值是否为 AppError 序列化形态 */
export function isAppErrorPayload(value: unknown): value is AppErrorPayload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return v.kind === 'apilot_error' && typeof v.code === 'string' && typeof v.message === 'string'
}

/** 任意 invoke 拒绝值 → IpcError（幂等：已是 IpcError 则原样返回） */
export function toIpcError(raw: unknown): IpcError {
  if (raw instanceof IpcError) return raw
  if (isAppErrorPayload(raw)) {
    return new IpcError({
      code: raw.code,
      message: raw.message,
      details: raw.details,
      fromAppError: true,
    })
  }
  // 未知异常（如 JS 侧抛错）：统一 INTERNAL，保留原信息
  const message = raw instanceof Error ? raw.message : String(raw)
  return new IpcError({ code: 'INTERNAL', message, fromAppError: false })
}

/**
 * 阻断性错误码集合：出现即要求用户确认 / 中断流程的错误。
 * 瞬态错误全部走 Toast；新增阻断码时在此登记。
 */
const BLOCKING_CODES: ReadonlySet<string> = new Set(['DB_CORRUPTED'])

export function isBlockingCode(code: string): boolean {
  return BLOCKING_CODES.has(code)
}

// —— devMode 门控（模块级标志承载，boot 流程灌入）——

let devMode = false

/** boot 流程读取设置后调用；设置面板切换时同步 */
export function setDevMode(enabled: boolean): void {
  devMode = enabled
}

export function isDevMode(): boolean {
  return devMode
}

/** invoke 调用：AppError 解包为 IpcError 抛出；成功值原样返回 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    // 无参调用不透传 undefined（保持命令调用形态与 Rust 侧签名一致）
    return args === undefined ? await tauriInvoke<T>(cmd) : await tauriInvoke<T>(cmd, args)
  } catch (raw) {
    throw toIpcError(raw)
  }
}

// —— Phase 1 命令的薄类型封装 ——

/** get_boot_settings 启动载荷（Rust BootSettings 的镜像） */
export interface BootSettings {
  /** settings 表全量（key → JSON value） */
  settings: Record<string, unknown>
  /** 操作系统语言（tauri_plugin_os::locale()，可能为 null） */
  systemLocale: string | null
  /** 主窗口创建时的 devtools 初值：true = F12 原生加速键在场（Rust 原生切换） */
  devtoolsNative: boolean
}

/** 启动批量读：settings 全量 + 系统语言（boot 流程消费） */
export function getBootSettings(): Promise<BootSettings> {
  return invoke<BootSettings>('get_boot_settings')
}

/** 单键写：白名单与长度上限由 Rust 侧校验（theme / locale / devMode / logLevel 及预留组） */
export function setSetting(key: string, value: unknown): Promise<void> {
  return invoke<void>('set_setting', { key, value })
}

// —— CLI（设置「开发者 › 高级」：PATH 注册 / 注销与状态探测）——

/**
 * CLI 状态 DTO（Rust CliStatus 的镜像，camelCase）。开关显示态唯一来自
 * `registered`（用户 PATH 注册表真值），settings 不持 cli 副本。
 */
export interface CliStatus {
  /** apilot.exe 完整路径（[复制 CLI 路径] 复制此值） */
  exePath: string
  /** 探测到的 CLI 版本（拉起失败 / 超时时为 null） */
  version: string | null
  /** 二进制可执行且版本与 GUI 同源；false＝S6「CLI 二进制不可用」 */
  binaryAvailable: boolean
  /** 安装目录为开发构建目录（cargo target 下）；true＝S7 警示 */
  isDevBuild: boolean
  /** 本安装目录是否在用户 PATH（开关显示态） */
  registered: boolean
  /** 终端解析到的 apilot.exe 所在目录；null＝未命中 */
  resolvedDir: string | null
  /** 解析命中的不是本目录时为该目录（S3 / S4 遮蔽），否则 null */
  shadowedBy: string | null
  /** 用户 PATH 中本目录之外、解析顺序在后的含 apilot.exe 条目（S5 残留） */
  staleDirs: string[]
}

/** 聚合探测（版本拉起至多 3 秒）：打开设置对话框查一次，注册 / 注销后失效重取 */
export function getCliStatus(): Promise<CliStatus> {
  return invoke<CliStatus>('get_cli_status')
}

/** 注册：本安装目录写入用户 PATH；失败抛 IpcError（弹窗原位停留＋重试） */
export function registerCliPath(): Promise<void> {
  return invoke<void>('register_cli_path')
}

/** 注销：从用户 PATH 移除本安装目录；失败抛 IpcError（开关回弹＋toast） */
export function unregisterCliPath(): Promise<void> {
  return invoke<void>('unregister_cli_path')
}

// —— 诊断（get_diagnostics；设置面板「复制诊断信息」消费）——

/** 诊断摘要 DTO（Rust Diagnostics 的镜像，camelCase） */
export interface Diagnostics {
  version: string
  platform: string
  arch: string
  family: string
  build: 'debug' | 'release'
  activeTasks: number
  log: { level: string; ringCount: number; ringCapacity: number }
}

/** 诊断摘要：版本 / 系统 / 运行环境 / 后台任务 / 日志统计（只读，无失败面） */
export function getDiagnostics(): Promise<Diagnostics> {
  return invoke<Diagnostics>('get_diagnostics')
}

// —— 系统能力（commands/system.rs）——

/**
 * 更新源保存前可达性校验：本机 / UNC 路径存在且为目录；
 * 不可达（不存在 / 非目录 / 网络超时）抛 IpcError（code = UPDATE_SOURCE_UNREACHABLE）。
 */
export function checkUpdateSource(path: string): Promise<void> {
  return invoke<void>('check_update_source', { path })
}

/** check_updates 结果（Rust CheckUpdatesResult 镜像，status 联合） */
export interface CheckUpdatesResult {
  status:
    | 'not_configured'
    | 'unreachable'
    | 'invalid_manifest'
    | 'up_to_date'
    | 'newer_available'
    | 'downgrade_available'
  latestVersion: string | null
  notes: string | null
}

/** 检查更新：读更新源清单并与当前版本比较（只读清单，不下载） */
export function checkUpdates(): Promise<CheckUpdatesResult> {
  return invoke<CheckUpdatesResult>('check_updates')
}

/**
 * 暂存更新包信息（Rust StagedUpdateInfo 镜像）：只含版本号——安装包路径
 * 由 Rust 侧从版本号按固定命名重构（类型即防线），路径不越过 IPC 边界。
 */
export interface StagedUpdateInfo {
  version: string
}

/** 下载更新包（两段式之一）：复制 + sha256/minisign 双校验落盘，失败抛 IpcError */
export function downloadUpdate(): Promise<StagedUpdateInfo> {
  return invoke<StagedUpdateInfo>('download_update')
}

/** 启动静默安装器（两段式之二）：以版本号重构暂存包并校验，暂存为待安装请求并
 * arm 退出闸门；调用方收尾后 ack（app.ready_to_exit）放行完整退出序列，序列末尾
 * spawn 安装器覆盖安装 */
export function installUpdate(version: string): Promise<void> {
  return invoke<void>('install_update', { version })
}

/** list_staged_updates 结果（Rust StagedUpdates 镜像）：临时目录就绪包扫描 */
export interface StagedUpdates {
  /** 版本大于当前：上次「稍后」留下的可安装包（boot 续接确认对话框） */
  ready: StagedUpdateInfo | null
  /** 版本等于当前：覆盖安装已完成标志（提示后 discard 清理） */
  finished: StagedUpdateInfo | null
  /** 上次安装未完成（一次性反馈，标记由 Rust 侧读即清；暂存包保留供重试） */
  installFailed: StagedUpdateInfo | null
}

/** 扫描临时目录就绪包（只读；陈旧残留与 .part 中态残留由 Rust 侧顺手清理） */
export function listStagedUpdates(): Promise<StagedUpdates> {
  return invoke<StagedUpdates>('list_staged_updates')
}

/** 删除指定就绪包（完成提示后调用；以版本号重构路径，命名空间外无法触达） */
export function discardStagedUpdate(version: string): Promise<void> {
  return invoke<void>('discard_staged_update', { version })
}

// —— 关闭行为（关闭确认弹窗消费；决策在 Rust 侧，前端只报告用户选择）——

/** 询问弹窗选「最小化到托盘」：Rust 侧隐藏窗口并常驻托盘（不走退出闸门） */
export function hideToTray(): Promise<void> {
  return invoke<void>('app.hide_to_tray')
}

/** 询问弹窗选「退出应用」：前端收尾 flush 完成后调用，Rust 放行完整退出序列 */
export function confirmExit(): Promise<void> {
  return invoke<void>('app.confirm_exit')
}
