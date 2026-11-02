-- 工作空间排序：左栏两级树与切换器清单的用户可控顺序（拖拽放落的落库基础）。
-- 排序粒度＝全局单序列（工作空间无分组归属）；
-- 存量行按原清单顺序（created_at, id 升序）回填连续序号。
ALTER TABLE workspaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

UPDATE workspaces SET sort_order = (
    SELECT COUNT(*) FROM workspaces AS w2
    WHERE w2.created_at < workspaces.created_at
       OR (w2.created_at = workspaces.created_at AND w2.id < workspaces.id)
);
