//! 同步计划（SyncPlan）：拉取→归一→对比→应用管线的单点决策面。
//!
//! 输入两侧都是归一后的统一模型（基准＝上一代快照归一面，新＝当前代）＋
//! 库内存量行键集。产出每稳定键一个动作（Insert / Update / Unchanged /
//! Delete）＋附 [`EndpointDiff`] 行集——对比服务据此呈现确认面，应用服务
//! 据此落库；两侧消费同一决策，确认面徽标 / 计数与应用结果不分叉。
//!
//! 对账谓词单点（只在本模块出现，服务层不得各自重写）：
//! - 插入：新文档的键在库内无行（首次同步与消失后回归同走此路径——凭
//!   稳定键 INSERT 天然重接既有用户数据与置顶）；
//! - 删除：库内同步键不在新文档 → 定义行直接删除（用户数据 / 置顶 /
//!   历史原地保留）；
//! - 手工身份（UUID 形态键）不属于同步对账面，存量与动作两侧一致排除
//!   （手工键天然不在新文档，不进删除）。
//!
//! 纯函数与数据结构：不接触数据库、不做网络；存量以键集（`HashSet<String>`，
//! 服务层从存量行集投影）传入，plan 按需计算即弃（不长期驻留）。

use std::collections::HashSet;

use super::diff::{self, DiffKind, DiffSummary, EndpointDiff};
use super::model::{UnifiedDoc, UnifiedOperation};
use crate::domain::endpoint::is_manual_identity;

/// 每稳定键一个动作（应用事务的落库语义；确认面的分组依据）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncActionKind {
    /// 库内无行 → 插入入树（badge=new；消失后回归同走此路径，用户数据
    /// 与置顶凭稳定键原地重接）
    Insert,
    /// 既有键定义面有变化 → 更新 definition（badge=changed）
    Update,
    /// 既有键定义面零变化（含仅 title / category 变化）→ 更新身份字段、
    /// 徽标清空
    Unchanged,
    /// 库内存量键不在新文档 → 删除定义行（用户数据 / 置顶 / 历史不动）
    Delete,
}

/// 单键动作（`op` 为当前代操作——Insert / Update / Unchanged 都有对应
/// 新文档操作；Delete 只有存量侧键，无 op）。
#[derive(Debug, Clone)]
pub struct SyncAction {
    pub key: String,
    pub kind: SyncActionKind,
    pub op: Option<UnifiedOperation>,
}

/// 同步计划：动作集＋diff 行集＋汇总（一次计算、双端消费、按需即弃）。
#[derive(Debug, Clone)]
pub struct SyncPlan {
    pub summary: DiffSummary,
    pub diffs: Vec<EndpointDiff>,
    pub actions: Vec<SyncAction>,
}

/// 计算同步计划。`base=None`（首次同步）时新文档全量 Added；动作序＝
/// 新文档序在前、删除动作追加其后（存量以键集传入，删除之间无序依赖）。
pub fn plan_sync(
    base: Option<&UnifiedDoc>,
    incoming: &UnifiedDoc,
    existing_keys: &HashSet<String>,
) -> SyncPlan {
    // 手工身份判定单点：同步对账只看稳定键值域（`方法 + 空格 + 路由模板`），
    // UUID 形态键整行排除——下游两侧不再各自判定
    let sync_keys: HashSet<&str> = existing_keys
        .iter()
        .map(String::as_str)
        .filter(|key| !is_manual_identity(key))
        .collect();

    let (diffs, summary) = diff::diff_docs(base, incoming);

    // 动作集：库内存量决定 Insert / 既有键两分；既有键的「有无变化」由
    // 快照双代 diff 分类决定（徽标与计数口径，与确认面同一来源）
    let changed_keys: HashSet<&str> = diffs
        .iter()
        .filter(|d| d.kind == DiffKind::Changed)
        .map(|d| d.key.as_str())
        .collect();
    let in_doc: HashSet<&str> = incoming
        .operations
        .iter()
        .map(|op| op.key.as_str())
        .collect();

    let mut actions = Vec::with_capacity(incoming.operations.len() + sync_keys.len());
    for op in &incoming.operations {
        let kind = if sync_keys.contains(op.key.as_str()) {
            if changed_keys.contains(op.key.as_str()) {
                SyncActionKind::Update
            } else {
                SyncActionKind::Unchanged
            }
        } else {
            SyncActionKind::Insert
        };
        actions.push(SyncAction {
            key: op.key.clone(),
            kind,
            op: Some(op.clone()),
        });
    }
    for key in existing_keys {
        // 删除只针对存量同步键；手工键（含不在新文档者）整行排除
        if sync_keys.contains(key.as_str()) && !in_doc.contains(key.as_str()) {
            actions.push(SyncAction {
                key: key.clone(),
                kind: SyncActionKind::Delete,
                op: None,
            });
        }
    }

    SyncPlan {
        summary,
        diffs,
        actions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::sync::model::{UnifiedDoc, UnifiedParamLocation, UnifiedParameter};

    fn op(key: &str) -> UnifiedOperation {
        UnifiedOperation {
            key: key.to_string(),
            method: "GET".to_string(),
            path: "/users".to_string(),
            title: "列表".to_string(),
            category: None,
            description: None,
            parameters: Vec::new(),
            request_body: None,
            responses: Vec::new(),
        }
    }

    fn doc(ops: Vec<UnifiedOperation>) -> UnifiedDoc {
        UnifiedDoc {
            title: "t".into(),
            version: "1".into(),
            operations: ops,
        }
    }

    /// 存量键集构造（对账面只看键，服务层从存量行集投影）
    fn keys(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn kinds(plan: &SyncPlan) -> Vec<(&str, SyncActionKind)> {
        plan.actions
            .iter()
            .map(|a| (a.key.as_str(), a.kind))
            .collect()
    }

    /// 首次同步（无基准、无存量）：全量 Added ＋ 全量 Insert。
    #[test]
    fn first_sync_is_all_insert() {
        let plan = plan_sync(
            None,
            &doc(vec![op("GET /users"), op("POST /users")]),
            &HashSet::new(),
        );
        assert_eq!(plan.summary.added, 2);
        assert_eq!(
            kinds(&plan),
            vec![
                ("GET /users", SyncActionKind::Insert),
                ("POST /users", SyncActionKind::Insert)
            ]
        );
    }

    /// 对账矩阵：库内无行→Insert（首次与消失后回归同路径）、既有键有
    /// 变化→Update、既有键零变化→Unchanged、存量键消失→Delete、手工键
    /// 无论是否在文档都无动作。
    #[test]
    fn reconciliation_matrix_produces_one_action_per_key() {
        let mut changed = op("PUT /users");
        changed.parameters.push(UnifiedParameter {
            name: "page".to_string(),
            location: UnifiedParamLocation::Query,
            required: false,
            description: None,
            param_type: "integer".to_string(),
            format: None,
            example: None,
        });
        // 基准（上一代快照）不含回归键：回归键在确认面是 Added（正常向导
        // 节奏下消失于上一代、回归于当前代）
        let base = doc(vec![op("GET /users"), op("PUT /users"), op("DELETE /kept")]);
        let incoming = doc(vec![
            op("GET /users"),
            changed,
            op("DELETE /gone"),
            op("PATCH /new"),
        ]);
        let existing = keys(&[
            "GET /users",                           // 既有零变化
            "PUT /users",                           // 既有有变化
            "DELETE /kept",                         // 存量消失 → 删除定义行
            "DELETE /lost",                         // 存量消失 → 删除定义行
            "019aaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa", // 手工键排除
        ]);
        let plan = plan_sync(Some(&base), &incoming, &existing);

        // 非删除动作保持新文档序
        let upserts: Vec<(&str, SyncActionKind)> = plan
            .actions
            .iter()
            .filter(|a| a.kind != SyncActionKind::Delete)
            .map(|a| (a.key.as_str(), a.kind))
            .collect();
        assert_eq!(
            upserts,
            vec![
                ("GET /users", SyncActionKind::Unchanged),
                ("PUT /users", SyncActionKind::Update),
                ("DELETE /gone", SyncActionKind::Insert),
                ("PATCH /new", SyncActionKind::Insert),
            ]
        );
        // 删除动作以键集断言（存量以键集传入，删除之间无序依赖）
        let deletes: HashSet<&str> = plan
            .actions
            .iter()
            .filter(|a| a.kind == SyncActionKind::Delete)
            .map(|a| a.key.as_str())
            .collect();
        assert_eq!(deletes, HashSet::from(["DELETE /kept", "DELETE /lost"]));
        // 确认面与应用结果同一来源：动作分类与 diff 汇总互洽
        assert_eq!(plan.summary.added, 2, "回归键与新键都算 Added");
        assert_eq!(plan.summary.changed, 1);
        assert_eq!(plan.summary.unchanged, 1);
        assert_eq!(plan.summary.removed, 1, "removed 只按快照双代 diff 计数");
        // 删除动作无当前代操作；其余动作各带操作
        assert!(
            plan.actions
                .iter()
                .find(|a| a.key == "DELETE /kept")
                .unwrap()
                .op
                .is_none()
        );
        assert!(
            plan.actions
                .iter()
                .find(|a| a.key == "GET /users")
                .unwrap()
                .op
                .is_some()
        );
    }

    /// 手工身份键整行排除：不产生任何动作（含删除），也不进 Insert 判定
    /// ——库内无同步行的键是 Insert（对账看库，与 diff 分类相互独立）。
    #[test]
    fn manual_identity_keys_are_excluded_whole() {
        let base = doc(vec![op("GET /users")]);
        let incoming = doc(vec![op("GET /users")]);
        let existing = keys(&["019aaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa", "e1"]);
        let plan = plan_sync(Some(&base), &incoming, &existing);
        assert_eq!(kinds(&plan), vec![("GET /users", SyncActionKind::Insert)]);
        assert_eq!(plan.summary.removed, 0);
    }

    /// 仅 title / category 变化的既有键＝Unchanged（不入徽标；身份字段由
    /// 应用事务照常更新）。
    #[test]
    fn title_only_change_is_unchanged_action() {
        let mut retitled = op("GET /users");
        retitled.title = "新标题".to_string();
        let base = doc(vec![op("GET /users")]);
        let plan = plan_sync(Some(&base), &doc(vec![retitled]), &keys(&["GET /users"]));
        assert_eq!(
            kinds(&plan),
            vec![("GET /users", SyncActionKind::Unchanged)]
        );
        assert_eq!(plan.summary.unchanged, 1);
    }
}
