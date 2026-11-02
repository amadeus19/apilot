-- 变量分类推荐 BaseUrl 退役（环境-地址联动概念整体移除）：激活分类只换
-- 变量集，不再动地址栏。该列由 0012 ADD，此迁移仅去此列；变量分类其余
-- 列、variables 与 workspace_base_urls 两表不受影响。
ALTER TABLE variable_categories DROP COLUMN recommended_base_url;
