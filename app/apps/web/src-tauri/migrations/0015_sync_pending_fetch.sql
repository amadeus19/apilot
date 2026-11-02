-- 同步域待应用拉取暂存（2026-10-21 快照滚动时点定案：滚动改到全量应用）：
--   pending_fetches：拉取成功只写待应用暂存（不推进快照代）——未采用的
--     变更不得刷新快照；diff＝待应用 vs 当前已应用代；全量应用事务内
--     转正（snapshots 滚动写新代＋两代之外删除）并清除暂存行；部分应用
--     （勾选集未覆盖全部变更行）不转正、暂存保留，未勾选行下次同步仍在
--     清单（曾因「拉取即滚动」把未应用变更永久遮蔽）；
--   - 每服务至多一行（service_id 主键，重复拉取覆盖）；
--   - 与 snapshots 同族的服务从属数据：FK 挂 services(id) ON DELETE CASCADE。

CREATE TABLE pending_fetches (
  service_id  TEXT PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,                     -- swagger.json 原文（整体存储）
  sha256      TEXT NOT NULL,                     -- 原文摘要
  fetched_at  TEXT NOT NULL
);
