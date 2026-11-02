//! Run Record 实体与终态语义。
//!
//! 终态单次写入：运行中不落库（pending / running 枚举位为长执行预留）。
//! 状态语义（快照与 CLI 输出一致，是消费者语义的分界）：
//! - `passed`＝收到 HTTP 响应（任意状态码含 4xx/5xx——传输执行成功）；
//! - `failed`＝传输层失败（连接拒绝 / DNS / TLS / 构建失败），超时归此
//!   （error_code=TIMEOUT，系统按配置终止非用户取消）；
//! - `cancelled`＝用户主动取消，不留响应快照。
//!
//! 来源（source）：GUI 发送与 CLI run 双入口同源写入、互可见。

use serde::{Deserialize, Serialize};

/// 记录来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunSource {
    Gui,
    Cli,
}

impl RunSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Gui => "gui",
            Self::Cli => "cli",
        }
    }
}

/// 终态（pending / running 为长执行异步查询预留，现不落库）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunState {
    Passed,
    Failed,
    Cancelled,
}

impl RunState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "passed" => Some(Self::Passed),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_roundtrip() {
        for state in [RunState::Passed, RunState::Failed, RunState::Cancelled] {
            assert_eq!(RunState::parse(state.as_str()), Some(state));
        }
        assert_eq!(RunState::parse("pending"), None);
        assert_eq!(RunState::parse(""), None);
    }

    #[test]
    fn source_str_values() {
        assert_eq!(RunSource::Gui.as_str(), "gui");
        assert_eq!(RunSource::Cli.as_str(), "cli");
    }
}
