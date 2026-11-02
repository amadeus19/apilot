//! 变量域实体与兜底链合成纯函数。
//!
//! 职责边界：实体类型 + 生效集合成 + key 校验；不接触数据库（SQL 全收
//! infrastructure 层）、不做编排（services 层职责）。
//! Secret 是变量级敏感标记：值恒明文入库，掩码 / 脱敏由展示与发送链消费端
//! 负责（本层只透传标记）。

use std::collections::BTreeMap;

use sqlx::FromRow;

use crate::constants::MAX_ENTITY_NAME_BYTES;
use crate::error::AppError;
use crate::error::codes;

/// 内置变量键：BaseUrl 生效值（兜底链最底层，来源＝`workspaces.base_url` 列）。
pub const BUILTIN_BASE_URL_KEY: &str = "baseUrl";

/// 变量分类。`workspace_id` 为 None＝全局行（跨工作空间共享、不可激活）。
#[derive(Debug, Clone, FromRow)]
pub struct VariableCategory {
    pub id: String,
    pub workspace_id: Option<String>,
    pub name: String,
    pub sort_order: i64,
    pub created_at: String,
}

/// 新建变量分类的输入（身份与时间戳由 repo 生成；workspace_id None＝全局行）。
pub struct NewVariableCategory {
    pub id: String,
    pub workspace_id: Option<String>,
    pub name: String,
}

/// 存储的变量（复合主键 (category_id, key) 的行形态）。
/// `secret` 是敏感标记：值恒明文，掩码由消费端按标记执行。
#[derive(Debug, Clone, FromRow)]
pub struct StoredVariable {
    pub category_id: String,
    pub key: String,
    pub value: String,
    pub secret: bool,
    pub sort_order: i64,
    pub updated_at: String,
}

/// 新建变量的输入（身份 (category_id, key) 由调用方组装）。
pub struct NewVariable {
    pub category_id: String,
    pub key: String,
    pub value: String,
    pub secret: bool,
}

/// BaseUrl 候选行（纯 GUI 备选清单；与 `workspaces.base_url` 生效值无联动）。
#[derive(Debug, Clone, FromRow)]
pub struct BaseUrlCandidate {
    pub id: String,
    pub workspace_id: String,
    pub url: String,
    pub created_at: String,
}

/// 新建 BaseUrl 候选的输入。
pub struct NewBaseUrlCandidate {
    pub id: String,
    pub workspace_id: String,
    pub url: String,
}

/// 生效变量的来源层（兜底链上的位置；前端渲染徽标用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VariableSource {
    /// 激活分类（最高优先级）
    Active,
    /// 全局分类（居中）
    Global,
    /// 内置变量（兜底；当前仅 baseUrl）
    Builtin,
}

/// 合成后的生效变量（GUI 生效集右栏与 Resolver 的公共输入）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveVariable {
    pub key: String,
    pub value: String,
    pub secret: bool,
    pub source: VariableSource,
}

/// 兜底链合成：激活分类 → 全局分类 → 内置（baseUrl）。
///
/// - 同名键前者覆盖后者（激活 > 全局 > 内置）；
/// - `global` 传入时按序迭代、先到先占（多全局分类同名键按分类稳定序取先者）；
/// - `workspace_base_url` 为 None 时内置条目不出现（无值可合成）；
/// - 输出按键字典序稳定排列（BTreeMap 语义）。
pub fn compose_effective(
    active: &[StoredVariable],
    global: &[StoredVariable],
    workspace_base_url: Option<&str>,
) -> Vec<EffectiveVariable> {
    // 铺层顺序＝优先级从低到高：后铺者覆盖先铺者
    let mut layered: BTreeMap<String, EffectiveVariable> = BTreeMap::new();
    if let Some(url) = workspace_base_url {
        layered.insert(
            BUILTIN_BASE_URL_KEY.to_owned(),
            EffectiveVariable {
                key: BUILTIN_BASE_URL_KEY.to_owned(),
                value: url.to_owned(),
                secret: false,
                source: VariableSource::Builtin,
            },
        );
    }
    // 全局层先横向合并：多全局分类同名键先到先占（调用方保证按分类稳定序
    // 传入）；合并后的层再整体覆盖铺入（全局 > 内置的纵向优先级）
    let mut global_layer: BTreeMap<String, &StoredVariable> = BTreeMap::new();
    for variable in global {
        global_layer.entry(variable.key.clone()).or_insert(variable);
    }
    for (_, variable) in global_layer {
        layered.insert(
            variable.key.clone(),
            EffectiveVariable {
                key: variable.key.clone(),
                value: variable.value.clone(),
                secret: variable.secret,
                source: VariableSource::Global,
            },
        );
    }
    for variable in active {
        layered.insert(
            variable.key.clone(),
            EffectiveVariable {
                key: variable.key.clone(),
                value: variable.value.clone(),
                secret: variable.secret,
                source: VariableSource::Active,
            },
        );
    }
    layered.into_values().collect()
}

/// 变量 key 规范化与校验：去首尾空白 → 非空 → 长度上限。
/// 返回规范化后的 key，调用方以返回值为准落库（不得使用原值）。
pub fn normalize_variable_key(raw: &str) -> Result<String, AppError> {
    let key = raw.trim();
    if key.is_empty() {
        return Err(AppError::new(
            codes::NAME_INVALID,
            "variable key must not be empty",
        ));
    }
    if key.len() > MAX_ENTITY_NAME_BYTES {
        return Err(AppError::new(
            codes::NAME_INVALID,
            format!("variable key exceeds {MAX_ENTITY_NAME_BYTES} bytes"),
        ));
    }
    Ok(key.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn var(key: &str, value: &str, secret: bool) -> StoredVariable {
        StoredVariable {
            category_id: "c1".into(),
            key: key.into(),
            value: value.into(),
            secret,
            sort_order: 0,
            updated_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    /// 铺层序对同名键的覆盖方向：全局先占、激活后铺覆盖全局
    #[test]
    fn active_overrides_global_on_same_key() {
        let active = vec![var("host", "https://active.example.com", false)];
        let global = vec![var("host", "https://global.example.com", false)];
        let effective = compose_effective(&active, &global, None);
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].value, "https://active.example.com");
        assert_eq!(effective[0].source, VariableSource::Active);
    }

    /// 全局覆盖内置：同名 baseUrl 时内置条目让位
    #[test]
    fn global_overrides_builtin_base_url() {
        let global = vec![var(
            BUILTIN_BASE_URL_KEY,
            "https://global.example.com",
            false,
        )];
        let effective = compose_effective(&[], &global, Some("https://workspace.example.com"));
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].value, "https://global.example.com");
        assert_eq!(effective[0].source, VariableSource::Global);
    }

    /// 无激活只用全局＋内置：三层各自独立成条
    #[test]
    fn no_active_uses_global_and_builtin_only() {
        let global = vec![var("token", "abc", true)];
        let effective = compose_effective(&[], &global, Some("https://workspace.example.com"));
        assert_eq!(effective.len(), 2);
        // 字典序：baseUrl < token
        assert_eq!(effective[0].key, BUILTIN_BASE_URL_KEY);
        assert_eq!(effective[0].source, VariableSource::Builtin);
        assert_eq!(effective[1].key, "token");
        assert!(effective[1].secret, "secret 标记必须随行透传");
        assert_eq!(effective[1].source, VariableSource::Global);
    }

    /// 无激活且无 base_url：只剩全局条目，内置不出现
    #[test]
    fn builtin_absent_when_base_url_is_none() {
        let global = vec![var("token", "abc", false)];
        let effective = compose_effective(&[], &global, None);
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].key, "token");
    }

    /// 多全局分类同名键：按传入序先到先占（调用方保证分类稳定序）
    #[test]
    fn multiple_global_categories_first_wins() {
        let global = vec![var("k", "first", false), var("k", "second", false)];
        let effective = compose_effective(&[], &global, None);
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].value, "first");
    }

    /// 全空输入：合成空集（无激活、无全局、无 base_url）
    #[test]
    fn empty_inputs_yield_empty_set() {
        assert!(compose_effective(&[], &[], None).is_empty());
    }

    #[test]
    fn normalize_variable_key_trims_and_validates() {
        assert_eq!(normalize_variable_key("  apiKey  ").unwrap(), "apiKey");
        assert_eq!(
            normalize_variable_key("").unwrap_err().code,
            codes::NAME_INVALID
        );
        assert_eq!(
            normalize_variable_key("   ").unwrap_err().code,
            codes::NAME_INVALID
        );
        let long = "k".repeat(MAX_ENTITY_NAME_BYTES + 1);
        assert_eq!(
            normalize_variable_key(&long).unwrap_err().code,
            codes::NAME_INVALID
        );
    }
}
