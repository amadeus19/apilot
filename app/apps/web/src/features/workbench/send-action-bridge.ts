/**
 * 发送动作桥（imperative 句柄模式，沿 send-bridge / panel-bridge 先例）：
 * 编辑器挂载时登记「发送 / 取消」动作（与发送按钮同一函数），卸载注销；
 * 发送命令（workbench.send，Ctrl+Enter）经 tabs store 取激活 tabId 后经此
 * 调用登记的动作。
 *
 * 为什么命令不直连发送编排：发送语义（草稿未就绪不发送、sending 态转取消、
 * 错误上报）只活在编辑器一处，命令只路由不复制；激活 Tab 编辑器未挂载时
 * 调用静默忽略（编辑器未就绪与发送按钮禁用同语义）。句柄表以打开 Tab 为界
 * （有界，卸载即摘）。
 */

/** 发送动作（编辑器登记，与发送按钮同源） */
export type SendAction = () => void

const actions = new Map<string, SendAction>()

/** 登记发送动作；返回注销函数（编辑器卸载时调用） */
export function registerSendAction(tabId: string, action: SendAction): () => void {
  actions.set(tabId, action)
  return () => {
    if (actions.get(tabId) === action) actions.delete(tabId)
  }
}

/** 调用该 Tab 登记的发送动作（未登记＝静默忽略） */
export function invokeSendAction(tabId: string): void {
  actions.get(tabId)?.()
}
