/**
 * F12 原生加速键在场标记：主窗口创建时的
 * devtools 初值，boot 时由 get_boot_settings 载荷写入，会话内恒定。
 *
 * true = F12 由 WebView2 原生加速键接管（开/关切换完整），前端不绑定；
 * false = 创建时关闭，devMode 开启后由前端 F12 → internal_toggle_devtools
 * 打开（OpenDevToolsWindow 无视 AreDevToolsEnabled；关闭走 DevTools
 * 窗口自身，重启后恢复原生完整切换）。
 */

let native = false

export function setDevtoolsNative(value: boolean): void {
  native = value
}

export function isDevtoolsNative(): boolean {
  return native
}
