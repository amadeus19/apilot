-- 接口级超时覆写（Phase 4 HTTP 设置组）：用户测试偏好归用户数据域
-- （同步不触碰、接口删除连带级联清除、不进定义表）。
--   NULL = 继承全局设置（默认）
--   0    = 显式不限制
--   >0   = 秒数（发送时 per-request timeout 覆写全局档）

ALTER TABLE endpoint_user_data ADD COLUMN timeout_seconds INTEGER;
