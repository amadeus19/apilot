-- 工作流树拖拽排序：工作流（组内序 / 未分组序）与分组（组间序）各得
-- sort_order。存量行按空间内创建序回填连续序号——过滤到任一归属桶后，
-- 相对次序即迁移前的既有呈现序；新建走桶内尾插（MAX+1），移动整桶重写
-- 为 0..n——删除留空洞无碍（语义只看相对次序）。
ALTER TABLE workflows ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_groups ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

UPDATE workflows SET sort_order = (
    SELECT COUNT(*) FROM workflows w2
    WHERE w2.workspace_id = workflows.workspace_id
      AND (w2.created_at < workflows.created_at
           OR (w2.created_at = workflows.created_at AND w2.id < workflows.id))
);

UPDATE workflow_groups SET sort_order = (
    SELECT COUNT(*) FROM workflow_groups g2
    WHERE g2.workspace_id = workflow_groups.workspace_id
      AND (g2.created_at < workflow_groups.created_at
           OR (g2.created_at = workflow_groups.created_at AND g2.id < workflow_groups.id))
);
