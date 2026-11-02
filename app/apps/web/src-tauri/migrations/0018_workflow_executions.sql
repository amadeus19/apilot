-- 工作流执行记录：每工作流仅存最近一次（新执行覆盖、取消与失败同留痕），
-- workflow_id UNIQUE 约束即「恒一条」的物理保证（同时充当索引），覆盖写
-- 经 UPSERT 单语句完成。逐节点记录以 JSON 序列化整存（执行记录是过程数据
-- 而非编辑模型，内部结构演进灵活；行级有界——每工作流覆盖写不增长）。
-- 删除工作流级联清记录。
CREATE TABLE workflow_executions (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL UNIQUE REFERENCES workflows(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    duration_ms INTEGER,
    error_code TEXT,
    error_message TEXT,
    nodes_json TEXT NOT NULL DEFAULT '[]'
);
