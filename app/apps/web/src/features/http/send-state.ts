/**
 * 发送状态机（纯函数）：发送按钮与响应面板共用的 phase 转移裁决点。
 *
 * phase 语义：
 * - idle：从未发送（条目尚未建立）；
 * - sending：在途（http.send 与 sse.start 共用此态——两者共用 Tab 任务键）；
 * - done / failed / cancelled：终态，对应 RunResult.state（passed 映射 done）。
 *
 * failed 与 cancelled 的区分是错误三分的依据：failed 走错误卡片（errorCode
 * + message，TIMEOUT 有专属文案与设置入口），cancelled 是中性提示。
 */

export type SendPhase = 'idle' | 'sending' | 'done' | 'failed' | 'cancelled'

/** RunResult.state 镜像（http-api 的 DTO 与此结构一致；此处独立声明保持纯函数层零依赖） */
export type RunOutcome = 'passed' | 'failed' | 'cancelled'

export function isTerminalPhase(phase: SendPhase): boolean {
  return phase !== 'idle' && phase !== 'sending'
}

/** 发起发送的转移：idle 或任意终态 → sending；sending 恒拒绝（并发由后端取消链裁决，UI 只允许取消） */
export function beginSendPhase(phase: SendPhase): SendPhase | null {
  return phase === 'sending' ? null : 'sending'
}

/** 结果落定的转移：passed → done；failed / cancelled 同名终态 */
export function finishSendPhase(outcome: RunOutcome): SendPhase {
  return outcome === 'passed' ? 'done' : outcome
}

/** 错误三分判定：超时失败（TIMEOUT 专属卡片与设置入口的触发条件） */
export function isTimeoutFailure(phase: SendPhase, errorCode: string | null): boolean {
  return phase === 'failed' && errorCode === 'TIMEOUT'
}
