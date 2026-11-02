-- 工作流分组：第五视图按用户分组折叠的树集（组内工作流、未分组尾置）。
-- 删除分组不删工作流：workflows.group_id ON DELETE SET NULL，组内成员
-- 回落未分组。组名空间按工作空间隔离：唯一索引是硬保证（并发建组 /
-- 改名的 check-then-act 窗口兜底），常规重名路径由服务层先查给友好
-- 错误码（WORKFLOW_GROUP_NAME_EXISTS）。
CREATE TABLE workflow_groups (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_workflow_groups_workspace ON workflow_groups(workspace_id);
CREATE UNIQUE INDEX idx_workflow_groups_ws_name ON workflow_groups(workspace_id, name);

ALTER TABLE workflows ADD COLUMN group_id TEXT REFERENCES workflow_groups(id) ON DELETE SET NULL;
