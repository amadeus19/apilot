//! 接口树 DTO 组装：一条命令拉全树（服务 + 分类 + 接口 + 置顶标记）。
//!
//! 层级＝服务 › 分类 › 接口；分类实体与散层接口都以服务为父级返回，
//! 混排与展开语义由前端 selector 组装。badge（同步徽标）随行进 DTO 供
//! 树行呈现（下次同步滚动清旧）；定义 JSON 脏数据行跳过（warn 留痕，
//! 不炸整树）。

use serde::Serialize;
use sqlx::SqlitePool;

use crate::domain::endpoint::Definition;
use crate::error::AppError;
use crate::error::codes;
use crate::infrastructure::{category_repo, endpoint_repo, service_repo, workspace_repo};

/// 全树 DTO。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeDto {
    pub workspace_id: String,
    pub services: Vec<ServiceNodeDto>,
}

/// 服务节点（含其分类与接口）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceNodeDto {
    pub id: String,
    pub name: String,
    pub doc_url: Option<String>,
    pub doc_type: String,
    pub sort_order: i64,
    pub categories: Vec<CategoryNodeDto>,
    pub endpoints: Vec<EndpointNodeDto>,
}

/// 分类节点。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryNodeDto {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
}

/// 接口节点（pinned 供置顶组组装，is_manual 供行渲染的手工标识）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointNodeDto {
    pub service_id: String,
    pub key: String,
    pub title: String,
    pub category_id: Option<String>,
    pub definition: DefinitionNodeDto,
    pub is_manual: bool,
    pub pinned: bool,
    /// 同步徽标（"new" / "changed"；随上次同步应用写入，下次同步滚动清旧）。
    /// 手工接口与未参与同步的行恒 None。
    pub badge: Option<String>,
}

/// 定义节点。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionNodeDto {
    pub method: String,
    pub path_template: String,
}

/// 组装工作空间全树；工作空间不存在报 WORKSPACE_NOT_FOUND。
pub async fn get_tree(pool: &SqlitePool, workspace_id: &str) -> Result<TreeDto, AppError> {
    workspace_repo::get(pool, workspace_id)
        .await?
        .ok_or_else(|| {
            AppError::new(
                codes::WORKSPACE_NOT_FOUND,
                format!("workspace not found: {workspace_id}"),
            )
        })?;

    let services = service_repo::list_by_workspace(pool, workspace_id).await?;
    // 每服务两条清单查询：单用户桌面量级 + 单连接池，JOIN 反范式组装无收益
    let mut nodes = Vec::with_capacity(services.len());
    for service in services {
        let categories = category_repo::list_by_service(pool, &service.id).await?;
        let endpoints = endpoint_repo::list_by_service(pool, &service.id).await?;
        let pinned = endpoint_repo::list_pinned(pool, &service.id).await?;

        let category_nodes = categories
            .into_iter()
            .map(|category| CategoryNodeDto {
                id: category.id,
                name: category.name,
                sort_order: category.sort_order,
            })
            .collect();
        let mut endpoint_nodes = Vec::with_capacity(endpoints.len());
        for endpoint in endpoints {
            let Ok(definition) = serde_json::from_str::<Definition>(&endpoint.definition) else {
                tracing::warn!(
                    service_id = %endpoint.service_id,
                    key = %endpoint.key,
                    "endpoint definition is corrupt, skipped from tree"
                );
                continue;
            };
            let is_pinned = pinned.contains(&endpoint.key);
            endpoint_nodes.push(EndpointNodeDto {
                is_manual: crate::domain::endpoint::is_manual_identity(&endpoint.key),
                service_id: endpoint.service_id,
                key: endpoint.key,
                title: endpoint.title,
                category_id: endpoint.category_id,
                definition: DefinitionNodeDto {
                    method: definition.method.as_str().to_owned(),
                    path_template: definition.path_template,
                },
                pinned: is_pinned,
                badge: endpoint.badge,
            });
        }
        nodes.push(ServiceNodeDto {
            id: service.id,
            name: service.name,
            doc_url: service.doc_url,
            doc_type: service.doc_type,
            sort_order: service.sort_order,
            categories: category_nodes,
            endpoints: endpoint_nodes,
        });
    }
    Ok(TreeDto {
        workspace_id: workspace_id.to_owned(),
        services: nodes,
    })
}

/// 树行视图的接口行：按树遍历序摊平（**数据序**——置顶不提升，`pinned`
/// 仅作字段输出；提升到顶层置顶组是 GUI 树的呈现语义）。CLI 读命令与
/// 后续树读消费方（同步徽标、导出）的共同行形状。
#[derive(Debug)]
pub struct EndpointRow {
    pub key: String,
    pub title: String,
    pub method: String,
    pub path_template: String,
    pub service_name: String,
    pub category_name: Option<String>,
    pub pinned: bool,
}

/// 树 DTO → 树遍历序行视图（纯函数，无 IO）。
/// 序＝服务 DTO 序（sort_order）→ 分类 DTO 序（组内接口按 DTO 序＝repo 序）
/// → 散层接口（排分类之后）；分类已删的脏 `categoryId` 退散层（不丢行）；
/// 定义脏数据行已在 `get_tree` 单点跳过（warn 留痕）——本函数是「树遍历序」
/// 在 Rust 侧的单一事实源，`get_tree` 是唯一 DB 读链。
pub fn traversal_rows(tree: &TreeDto) -> Vec<EndpointRow> {
    let mut rows = Vec::new();
    for service in &tree.services {
        let category_name = |id: &str| {
            service
                .categories
                .iter()
                .find(|c| c.id == id)
                .map(|c| c.name.clone())
        };
        // 分类组（键序：分类 DTO 序 → 组内接口 DTO 序）
        for category in &service.categories {
            for endpoint in service
                .endpoints
                .iter()
                .filter(|e| e.category_id.as_deref() == Some(category.id.as_str()))
            {
                rows.push(row_of(endpoint, &service.name, category_name(&category.id)));
            }
        }
        // 散层（无分类；分类已删的脏 categoryId 同样退回散层，不丢行）
        for endpoint in service.endpoints.iter().filter(|e| {
            e.category_id
                .as_deref()
                .is_none_or(|id| !service.categories.iter().any(|c| c.id == id))
        }) {
            rows.push(row_of(endpoint, &service.name, None));
        }
    }
    rows
}

fn row_of(
    endpoint: &EndpointNodeDto,
    service_name: &str,
    category_name: Option<String>,
) -> EndpointRow {
    EndpointRow {
        key: endpoint.key.clone(),
        title: endpoint.title.clone(),
        method: endpoint.definition.method.clone(),
        path_template: endpoint.definition.path_template.clone(),
        service_name: service_name.to_owned(),
        category_name,
        pinned: endpoint.pinned,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::infrastructure::category_repo::test_support as category_support;
    use crate::infrastructure::endpoint_repo::test_support as endpoint_support;
    use crate::infrastructure::service_repo::test_support as service_support;
    use crate::infrastructure::user_data_repo;
    use crate::infrastructure::workspace_repo::test_support as ws_support;

    async fn memory_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn assembles_services_categories_endpoints_and_pinned() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        service_support::seed_service(&pool, "s1", "w1", "服务A").await;
        service_support::seed_service(&pool, "s2", "w1", "服务B").await;
        category_support::seed_category(&pool, "c1", "s1", "分类一").await;
        category_support::seed_category(&pool, "c2", "s1", "分类二").await;
        endpoint_support::seed_endpoint_in_category(&pool, "s1", "e1", Some("c1"), "在分类").await;
        endpoint_support::seed_endpoint(&pool, "s1", "e2", "散层").await;
        endpoint_support::seed_endpoint(&pool, "s2", "e3", "他服务").await;
        endpoint_repo::set_pinned(&pool, "s1", "e2", true)
            .await
            .unwrap();
        user_data_repo::test_support::seed_user_data(&pool, "s1", "e1").await;
        // 徽标随上次同步应用写入（"new"/"changed"），树 DTO 原样带出
        sqlx::query(
            "UPDATE endpoints SET badge = 'changed' WHERE service_id = 's1' AND key = 'e1'",
        )
        .execute(&pool)
        .await
        .unwrap();

        let tree = get_tree(&pool, "w1").await.unwrap();
        assert_eq!(tree.workspace_id, "w1");
        assert_eq!(tree.services.len(), 2);

        let s1 = tree.services.iter().find(|s| s.id == "s1").unwrap();
        assert_eq!(s1.categories.len(), 2);
        assert_eq!(s1.endpoints.len(), 2);
        let e1 = s1.endpoints.iter().find(|e| e.key == "e1").unwrap();
        assert_eq!(e1.category_id.as_deref(), Some("c1"));
        assert!(!e1.pinned);
        assert_eq!(e1.badge.as_deref(), Some("changed"), "同步徽标进树 DTO");
        let e2 = s1.endpoints.iter().find(|e| e.key == "e2").unwrap();
        assert!(e2.pinned, "置顶标记进树 DTO");
        assert_eq!(e2.category_id, None);
        assert_eq!(e2.badge, None, "未参与同步的行无徽标");

        let s2 = tree.services.iter().find(|s| s.id == "s2").unwrap();
        assert_eq!(s2.endpoints.len(), 1);
        assert!(s2.categories.is_empty());
    }

    #[tokio::test]
    async fn missing_workspace_reports_not_found() {
        let pool = memory_pool().await;
        let err = get_tree(&pool, "nope").await.unwrap_err();
        assert_eq!(err.code, codes::WORKSPACE_NOT_FOUND);
    }

    #[tokio::test]
    async fn corrupt_definition_rows_are_skipped() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        service_support::seed_service(&pool, "s1", "w1", "服务").await;
        endpoint_support::seed_endpoint(&pool, "s1", "e1", "正常").await;
        sqlx::query("INSERT INTO endpoints (service_id, key, title, definition, created_at) VALUES ('s1', 'e2', '脏数据', 'not-json', '2026-01-01T00:00:00.000Z')")
            .execute(&pool)
            .await
            .unwrap();

        let tree = get_tree(&pool, "w1").await.unwrap();
        let keys: Vec<&str> = tree.services[0]
            .endpoints
            .iter()
            .map(|e| e.key.as_str())
            .collect();
        assert_eq!(keys, vec!["e1"], "定义脏数据行跳过不炸整树");
    }

    // ── 树行视图（traversal_rows）：纯函数，构造 DTO 直测 ──

    fn dto_category(id: &str, name: &str) -> CategoryNodeDto {
        CategoryNodeDto {
            id: id.to_owned(),
            name: name.to_owned(),
            sort_order: 0,
        }
    }

    fn dto_endpoint(
        service_id: &str,
        key: &str,
        title: &str,
        category_id: Option<&str>,
    ) -> EndpointNodeDto {
        EndpointNodeDto {
            service_id: service_id.to_owned(),
            key: key.to_owned(),
            title: title.to_owned(),
            category_id: category_id.map(str::to_owned),
            definition: DefinitionNodeDto {
                method: "GET".to_owned(),
                path_template: format!("/{key}"),
            },
            is_manual: false,
            pinned: false,
            badge: None,
        }
    }

    fn dto_service(
        id: &str,
        name: &str,
        categories: Vec<CategoryNodeDto>,
        mut endpoints: Vec<EndpointNodeDto>,
    ) -> ServiceNodeDto {
        endpoints
            .iter_mut()
            .for_each(|e| e.service_id = id.to_owned());
        ServiceNodeDto {
            id: id.to_owned(),
            name: name.to_owned(),
            doc_url: None,
            doc_type: "openapi".to_owned(),
            sort_order: 0,
            categories,
            endpoints,
        }
    }

    fn tree_of(services: Vec<ServiceNodeDto>) -> TreeDto {
        TreeDto {
            workspace_id: "w1".to_owned(),
            services,
        }
    }

    /// 序＝服务序 → 分类序（组内接口序）→ 散层尾；脏 categoryId 退散层；
    /// 行字段携带服务名与分类名（散层无）。
    #[test]
    fn traversal_rows_orders_by_tree_traversal() {
        let tree = tree_of(vec![
            dto_service(
                "s1",
                "服务一",
                vec![dto_category("c1", "分类一"), dto_category("c2", "分类二")],
                vec![
                    dto_endpoint("s1", "e-scatter", "散层", None),
                    dto_endpoint("s1", "e-c1", "分类一内", Some("c1")),
                    dto_endpoint("s1", "e-c2", "分类二内", Some("c2")),
                    dto_endpoint("s1", "e-dirty", "脏分类", Some("c-gone")),
                ],
            ),
            dto_service(
                "s2",
                "服务二",
                vec![],
                vec![dto_endpoint("s2", "e-other", "他服务", None)],
            ),
        ]);
        let rows = traversal_rows(&tree);
        let keys: Vec<&str> = rows.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(
            keys,
            vec!["e-c1", "e-c2", "e-scatter", "e-dirty", "e-other"]
        );
        assert_eq!(rows[0].service_name, "服务一");
        assert_eq!(rows[0].category_name.as_deref(), Some("分类一"));
        assert_eq!(rows[2].category_name, None, "散层无分类名");
        // 脏 categoryId 退散层且不丢行
        assert_eq!(rows[3].category_name, None, "已删分类退散层");
        assert_eq!(rows[4].service_name, "服务二");
    }

    /// 置顶仅作字段输出（数据序不提升——提升是 GUI 树的呈现语义）。
    #[test]
    fn traversal_rows_keeps_pinned_in_place_as_field() {
        let mut pinned = dto_endpoint("s1", "e-pin", "置顶项", Some("c1"));
        pinned.pinned = true;
        let tree = tree_of(vec![dto_service(
            "s1",
            "服务",
            vec![dto_category("c1", "分类")],
            vec![pinned, dto_endpoint("s1", "e-plain", "普通项", None)],
        )]);
        let rows = traversal_rows(&tree);
        let keys: Vec<&str> = rows.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(keys, vec!["e-pin", "e-plain"], "置顶保持原位，不提升到最前");
        assert!(rows[0].pinned, "pinned 作为字段输出");
        assert!(!rows[1].pinned);
    }

    /// 空树（无服务）＝空行集。
    #[test]
    fn traversal_rows_on_empty_tree_is_empty() {
        let tree = tree_of(vec![]);
        assert!(traversal_rows(&tree).is_empty());
    }
}
