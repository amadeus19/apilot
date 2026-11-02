-- 工作台领域七表（单张迁移装齐）：
--   workspaces / services / categories / endpoints / endpoint_user_data /
--   pinned_endpoints / workspace_sessions
-- 边界约定：
--   - snapshots（同步域产物）不建，同步域图自建；
--   - services 不建 last_reachability 列（可达状态是会话态内存数据，不落库）；
--   - endpoints.badge / removed_at 仅同步接口消费，建列不消费（同步域零 ALTER）；
--   - endpoint_user_data / pinned_endpoints 与 endpoints 无跨表外键（身份跨表
--     语义：同步稳定键与手工 UUID 值域不撞），连带清除由服务层在同一事务内
--     显式执行；
--   - 时间戳统一由 SQL 侧 strftime 生成（RFC3339 UTC，单时钟源）。

CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  base_url   TEXT,                 -- 可空
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE services (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  doc_url      TEXT,               -- NULL = 纯手工容器
  doc_type     TEXT NOT NULL,      -- 默认 'openapi'，其他协议留判别字段不建抽象
  sort_order   INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE categories (          -- 手工分类实体；删除时接口 SET NULL 上移散层
  id         TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE endpoints (
  service_id  TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,       -- 稳定键（同步）或 UUID（手工），值域不撞
  title       TEXT NOT NULL,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,  -- NULL = 散层直挂
  definition  TEXT NOT NULL,       -- 统一内部模型 JSON（方法/路径模板等结构）
  created_at  TEXT NOT NULL,       -- 树散层显示顺序＝创建时间升序
  badge       TEXT,                -- 'new'|'changed'|NULL；仅同步接口，建列不消费
  removed_at  TEXT,                -- 软删除标记；仅同步接口，同上
  PRIMARY KEY (service_id, key)
);

CREATE TABLE endpoint_user_data (  -- 草稿＝本表（编辑实时防抖整包写）
  service_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  body       TEXT,
  params     TEXT NOT NULL,        -- JSON
  headers    TEXT NOT NULL,        -- JSON
  updated_at TEXT NOT NULL,
  PRIMARY KEY (service_id, key)
);

CREATE TABLE pinned_endpoints (
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  PRIMARY KEY (service_id, key)
);

CREATE TABLE workspace_sessions (  -- 一行一工作空间＝整个「工作现场」
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  tabs         TEXT NOT NULL,      -- JSON：Tab 列表+激活+预览标记
  tree_expanded TEXT NOT NULL,     -- JSON：树展开节点 id 数组
  updated_at   TEXT NOT NULL
);
