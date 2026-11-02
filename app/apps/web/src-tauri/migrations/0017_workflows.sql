-- 工作流域：工作流成为可建、可存、可列、可开的一等实体。
-- 图（节点＋边）以 JSON 序列化整存于 graph 列，内含 schemaVersion 供未来
-- 结构变化经迁移处理；删除为硬删除，执行记录表（FK CASCADE 指向本表）
-- 随执行引擎落地时建表，级联一致性由外键统一保证。
CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    graph TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_workflows_workspace ON workflows(workspace_id);
