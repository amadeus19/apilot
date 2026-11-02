-- Run Record 统一模型（Phase 4）：GUI 发送与 CLI api run 双入口同源留痕。
-- 边界约定：
--   - 终态单次写入：运行中不落库（state 当前恒 passed/failed/cancelled；
--     pending/running 枚举位为长执行异步查询预留，Phase 6 起消费）；
--   - status_code NULL＝传输层失败（failed 且无响应）；response_json NULL＝
--     cancelled（用户取消不留响应快照）；
--   - request_json / response_json 的 body 均 excerpt ≤64KB＋truncated 标记
--     （headers 全量；快照存明文，展示与输出脱敏）；
--   - id＝run_<ULID>（双进程无协调生成、时间可排序）；
--   - 与工作台表无外键（身份跨表语义：接口删除后历史行保留）；
--   - 时间戳统一由 SQL 侧 strftime 生成（RFC3339 UTC，单时钟源）；
--   - 封顶 1000 条：写入路径单事务 INSERT＋修剪删最旧（完整淘汰策略归后续版本）。

CREATE TABLE run_records (
  id            TEXT PRIMARY KEY,   -- run_<ULID>
  workspace_id  TEXT NOT NULL,
  service_id    TEXT NOT NULL,
  endpoint_key  TEXT NOT NULL,      -- 稳定键或 UUID 原样
  method        TEXT NOT NULL,
  url           TEXT NOT NULL,
  status_code   INTEGER,            -- NULL＝传输层失败
  duration_ms   INTEGER,
  state         TEXT NOT NULL,      -- passed / failed / cancelled
  error_code    TEXT,
  error_message TEXT,
  request_json  TEXT NOT NULL,      -- 实际发送镜像
  response_json TEXT,               -- NULL＝cancelled 等无响应态
  source        TEXT NOT NULL,      -- gui / cli
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_run_records_created ON run_records(created_at DESC);
CREATE INDEX idx_run_records_workspace_created ON run_records(workspace_id, created_at DESC);
