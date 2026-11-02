//! 有序组内移动共享骨架：相邻交换（服务 / 分类）与 move_to 插入钳制
//! （服务 / 分类 / 接口），钳制 / 邻位选取 / 插入循环只此一份——各实体
//! 仅表名 / 组列 / 错误码不同。
//!
//! SQL 标识符（表名 / 组列）不能经绑定参数传值，只能内插：全部来自
//! 调用方的 `&'static str` 字面量（白名单常量），不存在注入面。

use sqlx::AssertSqlSafe;

use crate::domain::service::MoveDirection;
use crate::error::AppError;

/// 相邻交换的目标组描述（表与组列＝静态白名单字面量）。
pub(crate) struct AdjacentGroup {
    pub table: &'static str,
    /// 组归属列（同组内才有「相邻」语义：服务按 workspace_id、分类按 service_id）
    pub group_col: &'static str,
}

/// 相邻交换排序：与上/下相邻者互换 sort_order；已是组边界时不动（幂等）。
/// 存在性检查随首查完成，缺行时返回 `not_found`；事务边界归调用方。
pub(crate) async fn swap_adjacent(
    conn: &mut sqlx::SqliteConnection,
    group: AdjacentGroup,
    id: &str,
    direction: MoveDirection,
    not_found: AppError,
) -> Result<(), AppError> {
    // SQL 标识符（表名 / 组列）只能内插：值全部来自调用方的 &'static str
    // 白名单字面量，经 AssertSqlSafe 显式声明已审计无注入面
    let current: Option<(i64, String)> = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT sort_order, {} FROM {} WHERE id = ?",
        group.group_col, group.table
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((current_order, group_val)) = current else {
        return Err(not_found);
    };
    // 方向常量内插（白名单两值）：Up＝取更小序的最近者（逆序取一），Down 对称
    let (cmp, ordering) = match direction {
        MoveDirection::Up => ("<", "DESC"),
        MoveDirection::Down => (">", "ASC"),
    };
    let neighbor: Option<(String, i64)> = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT id, sort_order FROM {} WHERE {} = ? AND sort_order {} ? \
         ORDER BY sort_order {} LIMIT 1",
        group.table, group.group_col, cmp, ordering
    )))
    .bind(&group_val)
    .bind(current_order)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some((neighbor_id, neighbor_order)) = neighbor {
        sqlx::query(AssertSqlSafe(format!(
            "UPDATE {} SET sort_order = ? WHERE id = ?",
            group.table
        )))
        .bind(neighbor_order)
        .bind(id)
        .execute(&mut *conn)
        .await?;
        sqlx::query(AssertSqlSafe(format!(
            "UPDATE {} SET sort_order = ? WHERE id = ?",
            group.table
        )))
        .bind(current_order)
        .bind(&neighbor_id)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// move_to 插入位钳制：目标位越界收敛到组末。调用方持有「排除自身后的
/// 现序」，插入后整组按索引重写 sort_order。
pub(crate) fn insert_at_clamped(order: &mut Vec<String>, id: &str, index: i64) {
    let clamped = index.clamp(0, order.len() as i64) as usize;
    order.insert(clamped, id.to_owned());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::codes;

    #[test]
    fn insert_clamps_out_of_range_index_to_tail() {
        let mut order = vec!["a".to_owned(), "b".to_owned()];
        insert_at_clamped(&mut order, "c", 99);
        assert_eq!(order, vec!["a", "b", "c"]);
        insert_at_clamped(&mut order, "d", -3);
        assert_eq!(order, vec!["d", "a", "b", "c"]);
        insert_at_clamped(&mut order, "e", 2);
        assert_eq!(order, vec!["d", "a", "e", "b", "c"]);
    }

    #[test]
    fn not_found_error_carries_code() {
        let err = AppError::new(codes::SERVICE_NOT_FOUND, "test");
        assert_eq!(err.code, codes::SERVICE_NOT_FOUND);
    }
}
