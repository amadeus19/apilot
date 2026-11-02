import { open as openFileDialog } from '@tauri-apps/plugin-dialog'

import { invoke } from './ipc'

import { reportError } from './error-center'

/**
 * 目录系统能力收口：
 * - 打开日志目录（BootErrorScreen 出口与设置面板「打开日志目录」共用）：
 *   走 Rust 命令 `open_log_dir`（Rust 侧 canonicalize 后直调 opener，绕开前端
 *   ACL 对 Windows 路径形态的 scope 匹配不确定性）；
 * - 系统文件夹选择器（日志目录与更新源本机类型共用）：tauri-plugin-dialog，
 *   capability 仅 dialog:allow-open。
 * 打开失败不静默：经统一错误协议以瞬态 Toast 呈现（调用方语义收在此）。
 */
export async function openLogDirectory(): Promise<void> {
  try {
    await invoke('open_log_dir')
  } catch (error) {
    reportError(error)
  }
}

/** 系统文件夹选择器：返回所选绝对路径；null = 用户取消（正常路径，静默） */
export async function pickDirectory(): Promise<string | null> {
  const picked = await openFileDialog({ directory: true, multiple: false })
  return typeof picked === 'string' ? picked : null
}
