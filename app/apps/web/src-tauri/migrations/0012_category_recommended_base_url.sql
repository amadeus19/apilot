-- 变量分类推荐 BaseUrl（环境-地址联动，17 号票定案）：
-- 分类可携带一个推荐地址（可空）——激活该分类时地址栏覆写可跟随切到
-- 推荐值（一个动作完成「变量＋地址」的环境切换）；推荐是分类的属性、
-- 1:1 关系，随分类行存列即可，不另立映射表。
-- 边界：全局分类（workspace_id NULL）不可激活，恒 NULL 不参与联动；
-- 推荐地址只作激活时的覆写建议值，不触碰 workspaces.base_url 生效值。
ALTER TABLE variable_categories ADD COLUMN recommended_base_url TEXT NULL;
