//! 工作流执行事件词表与执行记录 DTO（引擎对前端的契约面）：
//! 事件经 `workflow:event` 单通道推送，tag＝事件词、字段 camelCase；
//! 落库状态与事件一一对应。

use crate::domain::workflow_execution::{AssertionEntry, NodeExecutionRecord, WorkflowExecution};

/// 执行事件出口（`workflow:event` 单通道；commands 层经 AppHandle.emit
/// 装配，服务层与单测注入 None 或收集闭包）。
pub type WorkflowEventSink = std::sync::Arc<dyn Fn(serde_json::Value) + Send + Sync>;

/// 执行事件（强类型 DTO；tag＝事件词，字段 camelCase）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "event")]
pub enum WorkflowEvent {
    #[serde(rename = "workflow.started", rename_all = "camelCase")]
    WorkflowStarted {
        execution_id: String,
        workflow_id: String,
    },
    #[serde(rename = "node.queued", rename_all = "camelCase")]
    NodeQueued {
        execution_id: String,
        node_id: String,
    },
    #[serde(rename = "node.started", rename_all = "camelCase")]
    NodeStarted {
        execution_id: String,
        node_id: String,
    },
    #[serde(rename = "node.completed", rename_all = "camelCase")]
    NodeCompleted {
        execution_id: String,
        node_id: String,
        duration_ms: u64,
        /// 节点产物摘要（提取 / 存变量 / 条件命中分支），已按敏感口径掩码；无产物＝None
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        /// 断言逐规则结果（断言节点专用；实时呈现面——执行结束后面板数据
        /// 不重播种，断言结果必须随事件到达；空＝非断言节点不携带）
        #[serde(skip_serializing_if = "Vec::is_empty")]
        assertions: Vec<AssertionEntry>,
    },
    #[serde(rename = "node.failed", rename_all = "camelCase")]
    NodeFailed {
        execution_id: String,
        node_id: String,
        error_code: String,
        error_message: String,
        /// 断言逐规则结果（断言节点失败专用——失败判定同样必须随事件
        /// 实时到达；空＝其他失败不携带）
        #[serde(skip_serializing_if = "Vec::is_empty")]
        assertions: Vec<AssertionEntry>,
    },
    #[serde(rename = "node.cancelled", rename_all = "camelCase")]
    NodeCancelled {
        execution_id: String,
        node_id: String,
    },
    #[serde(rename = "node.skipped", rename_all = "camelCase")]
    NodeSkipped {
        execution_id: String,
        node_id: String,
    },
    #[serde(rename = "edge.activated", rename_all = "camelCase")]
    EdgeActivated {
        execution_id: String,
        edge_id: String,
    },
    #[serde(rename = "workflow.completed", rename_all = "camelCase")]
    WorkflowCompleted {
        execution_id: String,
        workflow_id: String,
        duration_ms: u64,
    },
    #[serde(rename = "workflow.failed", rename_all = "camelCase")]
    WorkflowFailed {
        execution_id: String,
        workflow_id: String,
        duration_ms: u64,
        error_code: Option<String>,
        error_message: Option<String>,
    },
    #[serde(rename = "workflow.cancelled", rename_all = "camelCase")]
    WorkflowCancelled {
        execution_id: String,
        workflow_id: String,
        duration_ms: u64,
    },
}

/// 推送事件（序列化失败静默跳过：事件是尽力而为的推送面，终态以执行
/// 记录为准，不因序列化异常中断执行）。
pub(super) fn emit(sink: &Option<WorkflowEventSink>, event: &WorkflowEvent) {
    if let Some(sink) = sink {
        if let Ok(value) = serde_json::to_value(event) {
            sink(value);
        }
    }
}

/// 执行记录 DTO（命令返回面；camelCase 与前端契约对齐）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowExecutionDto {
    pub id: String,
    pub workflow_id: String,
    pub status: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub nodes: Vec<NodeExecutionRecord>,
}

impl From<WorkflowExecution> for WorkflowExecutionDto {
    fn from(exec: WorkflowExecution) -> Self {
        Self {
            id: exec.id,
            workflow_id: exec.workflow_id,
            status: exec.status,
            started_at: exec.started_at,
            completed_at: exec.completed_at,
            duration_ms: exec.duration_ms,
            error_code: exec.error_code,
            error_message: exec.error_message,
            nodes: exec.nodes,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};

    use serde_json::{Map, Value};

    use super::*;
    use crate::domain::workflow_execution::{
        STATUS_CANCELLED, STATUS_FAILED, STATUS_PASSED, STATUS_SKIPPED,
    };

    /// 事件契约夹具（`src/test/fixtures/workflow-event-contract.json`，与前端
    /// `features/workflow/__tests__/workflow-event-contract.test.ts` 共享同一
    /// 份表——任一端改事件词或字段键集，另一端立红）。演进通道：先改夹具
    /// （双端测试同红）再双端内化；单边改任一端，该端立红。
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        /// 事件词全集
        events: Vec<String>,
        /// 事件词 → 序列化恒存在的键（含 serde tag 键 `event`）
        required_keys: BTreeMap<String, Vec<String>>,
        /// 事件词 → skip 两态键（None / 空时键不存在，Some / 非空时键存在）
        optional_keys: BTreeMap<String, Vec<String>>,
        /// 终态事件词 → 状态词
        status_map: BTreeMap<String, String>,
        /// 逐词样例（携带的可选键状态驱动本侧构造形态；本体由前端归约消费）
        samples: Vec<Map<String, Value>>,
    }

    /// 样例元数据键（仅夹具侧标注，不属事件键集）
    const SAMPLE_META_KEYS: &[&str] = &["name"];

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!(
            "../../../../src/test/fixtures/workflow-event-contract.json"
        ))
        .expect("workflow event contract fixture must parse")
    }

    /// 集合语义比较：排序去重（成员是契约，顺序不是）
    fn sorted(items: impl IntoIterator<Item = String>) -> Vec<String> {
        let mut items: Vec<String> = items.into_iter().collect();
        items.sort();
        items.dedup();
        items
    }

    fn str_field(sample: &Map<String, Value>, key: &str) -> String {
        sample
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("样例缺字符串键 {key}"))
            .to_owned()
    }

    fn u64_field(sample: &Map<String, Value>, key: &str) -> u64 {
        sample
            .get(key)
            .and_then(Value::as_u64)
            .unwrap_or_else(|| panic!("样例缺数值键 {key}"))
    }

    /// 可空字符串键：缺省与 null 均为 None（节点产物的 skip 缺省态与
    /// workflow.failed 的 null 恒存在键共用同一取值口径）
    fn opt_str_field(sample: &Map<String, Value>, key: &str) -> Option<String> {
        sample.get(key).and_then(Value::as_str).map(str::to_owned)
    }

    /// 断言条目键：缺省为空 Vec（skip 缺省态）
    fn assertions_field(sample: &Map<String, Value>) -> Vec<AssertionEntry> {
        sample
            .get("assertions")
            .map(|value| {
                serde_json::from_value(value.clone()).expect("样例 assertions 须为断言条目数组")
            })
            .unwrap_or_default()
    }

    /// 变体 → 事件词。穷尽 match 是契约测试的编译期前哨：新增变体未登记
    /// 此处即编译失败——届时同批补齐夹具（events / requiredKeys /
    /// optionalKeys / 样例）、下方 [`construct`] 的分发臂与前端事件词常量。
    fn tag_of(event: &WorkflowEvent) -> &'static str {
        match event {
            WorkflowEvent::WorkflowStarted { .. } => "workflow.started",
            WorkflowEvent::NodeQueued { .. } => "node.queued",
            WorkflowEvent::NodeStarted { .. } => "node.started",
            WorkflowEvent::NodeCompleted { .. } => "node.completed",
            WorkflowEvent::NodeFailed { .. } => "node.failed",
            WorkflowEvent::NodeCancelled { .. } => "node.cancelled",
            WorkflowEvent::NodeSkipped { .. } => "node.skipped",
            WorkflowEvent::EdgeActivated { .. } => "edge.activated",
            WorkflowEvent::WorkflowCompleted { .. } => "workflow.completed",
            WorkflowEvent::WorkflowFailed { .. } => "workflow.failed",
            WorkflowEvent::WorkflowCancelled { .. } => "workflow.cancelled",
        }
    }

    /// 按样例构造对应变体（字段取自样例；可选键的携带状态由样例决定——
    /// 缺省态构造 None / 空 Vec，携带态构造 Some / 非空，skip 两态由此覆盖）
    fn construct(sample: &Map<String, Value>) -> WorkflowEvent {
        let tag = str_field(sample, "event");
        let execution_id = str_field(sample, "executionId");
        match tag.as_str() {
            "workflow.started" => WorkflowEvent::WorkflowStarted {
                execution_id,
                workflow_id: str_field(sample, "workflowId"),
            },
            "node.queued" => WorkflowEvent::NodeQueued {
                execution_id,
                node_id: str_field(sample, "nodeId"),
            },
            "node.started" => WorkflowEvent::NodeStarted {
                execution_id,
                node_id: str_field(sample, "nodeId"),
            },
            "node.completed" => WorkflowEvent::NodeCompleted {
                execution_id,
                node_id: str_field(sample, "nodeId"),
                duration_ms: u64_field(sample, "durationMs"),
                output: opt_str_field(sample, "output"),
                assertions: assertions_field(sample),
            },
            "node.failed" => WorkflowEvent::NodeFailed {
                execution_id,
                node_id: str_field(sample, "nodeId"),
                error_code: str_field(sample, "errorCode"),
                error_message: str_field(sample, "errorMessage"),
                assertions: assertions_field(sample),
            },
            "node.cancelled" => WorkflowEvent::NodeCancelled {
                execution_id,
                node_id: str_field(sample, "nodeId"),
            },
            "node.skipped" => WorkflowEvent::NodeSkipped {
                execution_id,
                node_id: str_field(sample, "nodeId"),
            },
            "edge.activated" => WorkflowEvent::EdgeActivated {
                execution_id,
                edge_id: str_field(sample, "edgeId"),
            },
            "workflow.completed" => WorkflowEvent::WorkflowCompleted {
                execution_id,
                workflow_id: str_field(sample, "workflowId"),
                duration_ms: u64_field(sample, "durationMs"),
            },
            "workflow.failed" => WorkflowEvent::WorkflowFailed {
                execution_id,
                workflow_id: str_field(sample, "workflowId"),
                duration_ms: u64_field(sample, "durationMs"),
                error_code: opt_str_field(sample, "errorCode"),
                error_message: opt_str_field(sample, "errorMessage"),
            },
            "workflow.cancelled" => WorkflowEvent::WorkflowCancelled {
                execution_id,
                workflow_id: str_field(sample, "workflowId"),
                duration_ms: u64_field(sample, "durationMs"),
            },
            other => panic!("样例事件词 {other} 无对应分发臂（新增事件词须同批补臂）"),
        }
    }

    fn serialized_keys(event: &WorkflowEvent) -> Vec<String> {
        let value = serde_json::to_value(event).expect("事件序列化必须成功");
        let object = value.as_object().expect("事件须序列化为对象");
        sorted(object.keys().cloned())
    }

    fn sample_keys(sample: &Map<String, Value>) -> Vec<String> {
        sorted(
            sample
                .keys()
                .filter(|key| !SAMPLE_META_KEYS.contains(&key.as_str()))
                .cloned(),
        )
    }

    /// 断言一：事件词集合——样例构造出的变体 tag 集合与夹具 events 相等
    /// （多一个、少一个都失败），requiredKeys / optionalKeys 恰覆盖全集。
    #[test]
    fn event_kinds_match_fixture() {
        let fixture = fixture();
        let events = sorted(fixture.events.iter().cloned());
        assert_eq!(events.len(), fixture.events.len(), "夹具事件词全集不得重复");
        assert_eq!(
            sorted(fixture.required_keys.keys().cloned()),
            events,
            "requiredKeys 须恰覆盖事件词全集"
        );
        assert_eq!(
            sorted(fixture.optional_keys.keys().cloned()),
            events,
            "optionalKeys 须恰覆盖事件词全集"
        );

        let mut tags: Vec<String> = Vec::new();
        for sample in &fixture.samples {
            let event = construct(sample);
            let tag = tag_of(&event);
            let value = serde_json::to_value(&event).expect("事件序列化必须成功");
            // serde tag ＝ 变体事件词 ＝ 样例 event（rename、分发臂、夹具三方一致）
            assert_eq!(value["event"], tag, "serde tag 与变体事件词不一致");
            assert_eq!(
                str_field(sample, "event"),
                tag,
                "样例 event 与构造变体不一致"
            );
            tags.push(tag.to_owned());
        }
        // 每事件词至少一条样例，且样例不含夹具外事件词
        assert_eq!(sorted(tags), events, "样例覆盖的事件词集合须与夹具全集相等");
    }

    /// 断言二：每样例构造的变体序列化键集＝夹具必有键 ∪ 样例携带的可选键
    /// （skip 两态：缺省态 None / 空 Vec 时键不存在，携带态 Some / 非空时
    /// 键存在）；样例自身不得携带声明外的键；有可选键的事件词两态样例齐备。
    #[test]
    fn variant_key_sets_match_fixture() {
        let fixture = fixture();
        for sample in &fixture.samples {
            let tag = str_field(sample, "event");
            let name = str_field(sample, "name");
            let required = fixture
                .required_keys
                .get(&tag)
                .unwrap_or_else(|| panic!("event={tag} 缺 requiredKeys 声明"));
            let optional = fixture
                .optional_keys
                .get(&tag)
                .unwrap_or_else(|| panic!("event={tag} 缺 optionalKeys 声明"));
            let declared: BTreeSet<&str> = required
                .iter()
                .chain(optional)
                .map(String::as_str)
                .collect();
            for key in sample_keys(sample) {
                assert!(
                    declared.contains(key.as_str()),
                    "event={tag} 样例「{name}」键 {key} 不在必有 ∪ 可选声明内"
                );
            }
            let carried = sample_keys(sample)
                .into_iter()
                .filter(|key| optional.contains(key));
            let expected = sorted(required.iter().cloned().chain(carried));
            assert_eq!(
                serialized_keys(&construct(sample)),
                expected,
                "event={tag} 样例「{name}」序列化键集与夹具漂移"
            );
        }
        // 两态齐备：缺省（不携带任何可选键）与携带（携带全部可选键）各至少一条
        for (tag, optional) in &fixture.optional_keys {
            if optional.is_empty() {
                continue;
            }
            let carried_sets: Vec<BTreeSet<&str>> = fixture
                .samples
                .iter()
                .filter(|sample| sample.get("event").and_then(Value::as_str) == Some(tag.as_str()))
                .map(|sample| {
                    sample
                        .keys()
                        .filter(|key| optional.contains(*key))
                        .map(String::as_str)
                        .collect()
                })
                .collect();
            assert!(
                carried_sets.iter().any(BTreeSet::is_empty),
                "event={tag} 缺可选键缺省态样例"
            );
            assert!(
                carried_sets.iter().any(|set| set.len() == optional.len()),
                "event={tag} 缺可选键全携带态样例"
            );
        }
    }

    /// 断言三：夹具终态对应表的状态词 ⊆ `STATUS_*` 常量集（直读常量对账，
    /// domain 词表演进时本测与夹具同红）；对应表事件词 ⊆ 事件词全集。
    #[test]
    fn status_map_words_are_status_constants() {
        let fixture = fixture();
        let statuses = [
            STATUS_PASSED,
            STATUS_FAILED,
            STATUS_CANCELLED,
            STATUS_SKIPPED,
        ];
        assert!(!fixture.status_map.is_empty(), "夹具须含终态对应表");
        for (event, status) in &fixture.status_map {
            assert!(
                fixture.events.contains(event),
                "对应表事件词 {event} 不在事件词全集"
            );
            assert!(
                statuses.contains(&status.as_str()),
                "event={event} 状态词 {status} 不在 STATUS_* 词表"
            );
        }
    }

    /// workflow.failed 的 errorCode / errorMessage 无 skip：None 序列化为 null
    /// 且键仍存在（与节点产物键的 skip 缺省态形成对照；前端镜像据此声明
    /// `string | null` 而非可选键）。
    #[test]
    fn workflow_failed_error_fields_serialize_null_not_absent() {
        let failed = |error: Option<&str>| {
            serde_json::to_value(WorkflowEvent::WorkflowFailed {
                execution_id: "e1".into(),
                workflow_id: "wf1".into(),
                duration_ms: 1,
                error_code: error.map(str::to_owned),
                error_message: error.map(str::to_owned),
            })
            .unwrap()
        };
        let absent = failed(None);
        let keys = absent.as_object().unwrap();
        assert!(
            keys.contains_key("errorCode"),
            "None 时 errorCode 键须仍存在"
        );
        assert!(
            keys.contains_key("errorMessage"),
            "None 时 errorMessage 键须仍存在"
        );
        assert_eq!(absent["errorCode"], Value::Null);
        assert_eq!(absent["errorMessage"], Value::Null);
        let present = failed(Some("HTTP_REQUEST_FAILED"));
        assert_eq!(present["errorCode"], "HTTP_REQUEST_FAILED");
        assert_eq!(present["errorMessage"], "HTTP_REQUEST_FAILED");
    }
}
