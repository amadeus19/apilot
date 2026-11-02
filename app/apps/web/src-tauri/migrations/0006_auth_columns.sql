-- 认证存储（Phase 4 认证交付）：
--   endpoint_user_data 扩第四列 auth（JSON，前端组装、整包读写模式下写路径不
--     感知语义；发送时由 services/http/auth 解析消费；NULL＝未配置＝继承上级）；
--   workspaces 增 auth 列（JSON，NULL＝未配置＝链根无认证）。
-- 凭据字面量随用户数据入库（数据目录自包含）；展示 / 导出 / 日志 / CLI 输出
-- 默认脱敏由消费端按快照 redactions 提示执行（--show-secrets 放行）。

ALTER TABLE endpoint_user_data ADD COLUMN auth TEXT;
ALTER TABLE workspaces ADD COLUMN auth TEXT;
