-- 变量域四表（Phase 5 变量域交付）：
--   variable_categories：变量分类；workspace_id NULL＝全局行（全局行不可激活，
--     激活校验在服务层，全局行跨工作空间共享）；
--   variables：变量，复合主键 (category_id, key)——同分类下 key 唯一，
--     撞车即约束冲突（稳定错误码在 repo 层转换）；secret 是变量级敏感标记，
--     值恒明文入库（2026-10-02 定案：数据目录自包含优先，不做加密变换）；
--   workspaces.active_category_id：激活分类指针；可空外键 ON DELETE SET NULL
--     （NULL＝全不激活；删除分类自动回落到「无激活」，兜底链只剩全局＋内置）；
--   workspace_base_urls：BaseUrl 候选清单（纯 GUI 备选；删除候选不影响
--     workspaces.base_url 生效值——两表无联动）。
-- 边界约定：
--   - 变量域不触碰 endpoint_user_data 等既有用户数据表；
--   - 分类名不做 UNIQUE 约束（spec DDL 无此约束，同名分类允许并存）；
--   - 时间戳统一由 SQL 侧 strftime 生成（RFC3339 UTC，单时钟源）。

CREATE TABLE variable_categories (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,  -- NULL＝全局行
  name         TEXT NOT NULL,
  sort_order   INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE variables (
  category_id TEXT NOT NULL REFERENCES variable_categories(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  secret      INTEGER NOT NULL DEFAULT 0,  -- 变量级敏感标记（展示端掩码，值恒明文）
  sort_order  INTEGER NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (category_id, key)
);

ALTER TABLE workspaces ADD COLUMN active_category_id TEXT
  REFERENCES variable_categories(id) ON DELETE SET NULL;  -- NULL＝全不激活

CREATE TABLE workspace_base_urls (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (workspace_id, url)
);
