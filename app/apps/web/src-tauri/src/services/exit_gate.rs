//! 退出闸门：CloseRequested 后给前端一次「保存会话 + flush 草稿」的机会。
//!
//! Rust 收到关窗请求即接管（prevent_close），向前端发 `app://close-requested`
//! 并挂起 shutdown；前端完成全部 flush 后经 `app.ready_to_exit` 命令放行。
//! 前端不可达（崩溃 / 无响应）时按超时兜底放行——退出绝不因收尾挂死。

use std::sync::Mutex;

use tokio::sync::oneshot;

/// 一次性闸门：每次关窗请求新建 channel，ack 即放行。
#[derive(Default)]
pub struct ExitGate {
    sender: Mutex<Option<oneshot::Sender<()>>>,
}

impl ExitGate {
    /// 挂起退出并取等待端（关窗请求路径调用；重复调用以最新为准）
    pub fn arm(&self) -> oneshot::Receiver<()> {
        let (sender, receiver) = oneshot::channel();
        *self.lock() = Some(sender);
        receiver
    }

    /// 前端收尾完成，放行退出（幂等：无挂起时静默）
    pub fn ack(&self) {
        if let Some(sender) = self.lock().take() {
            // 接收端可能已因超时被丢弃：发送失败即无等待者，语义等价于放行
            let _ = sender.send(());
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<oneshot::Sender<()>>> {
        self.sender
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn arm_then_ack_releases_the_gate() {
        let gate = ExitGate::default();
        let receiver = gate.arm();
        gate.ack();
        // ack 后接收端即就绪（不超时）
        tokio::time::timeout(Duration::from_millis(100), receiver)
            .await
            .expect("ack must release the gate")
            .expect("sender half alive until ack");
    }

    #[tokio::test]
    async fn ack_without_pending_is_silent_and_arm_twice_keeps_latest() {
        let gate = ExitGate::default();
        gate.ack(); // 无挂起：静默
        let first = gate.arm();
        let second = gate.arm();
        drop(first);
        gate.ack();
        // 第二次 arm 的接收端被放行；first 已 drop，重复 ack 幂等
        gate.ack();
        tokio::time::timeout(Duration::from_millis(100), second)
            .await
            .expect("latest arm must be released")
            .expect("sender half alive until ack");
    }

    #[tokio::test]
    async fn timeout_path_does_not_hang_shutdown() {
        let gate = ExitGate::default();
        let receiver = gate.arm();
        // 前端无响应：超时分支到点返回 Err，shutdown 不被挂死
        let result = tokio::time::timeout(Duration::from_millis(20), receiver).await;
        assert!(result.is_err(), "未 ack 时应走超时分支");
    }
}
