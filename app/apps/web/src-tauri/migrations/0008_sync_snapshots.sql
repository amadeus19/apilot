-- 同步域快照表（Phase 5 同步·拉取交付）：
--   snapshots：每服务保存当前代与上一代 swagger.json 原文（generation 连续
--     两值），是 diff 基准与「回看上次同步变化」的数据源；新代写入时滚动，
--     两代之外删除（滚动语义在 repo 层单事务实现）；
--   - 快照原文以 TEXT 整体存储（32MB 上限内，超限拉取侧稳定报错），
--     不做增量存储；
--   - 快照不是用户数据：清空、重建、跳代均为同步内部行为；
--   - 服务从属数据：FK 挂 services(id) ON DELETE CASCADE——删除服务连带
--     清快照（与删除服务连带清接口定义 / 用户数据同一语义）。

CREATE TABLE snapshots (
  service_id  TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  generation  INTEGER NOT NULL,                  -- 单调递增，新代 = 当前最大 +1
  content     TEXT NOT NULL,                     -- swagger.json 原文（整体存储）
  sha256      TEXT NOT NULL,                     -- 原文摘要（滚动与对账用）
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (service_id, generation)
);
