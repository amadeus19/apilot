-- settings：Phase 1 唯一业务前驱表（theme-system.md §四 / spec §6.7）
-- value 为 JSON 字符串；白名单与大小上限由服务层校验（services/settings.rs）
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
