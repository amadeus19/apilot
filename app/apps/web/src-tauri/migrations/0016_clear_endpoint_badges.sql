-- 清空存量同步徽标（2026-10-20 定案：徽标不再标记「上次同步变更」，
-- 应用完成的行不保留徽标，树面徽标呈现一并移除）。列保留（同步域
-- 内部历史字段，值自此恒 NULL），存量非空值一次性清空，避免残留
-- 标记永不过期。
UPDATE endpoints SET badge = NULL WHERE badge IS NOT NULL;
