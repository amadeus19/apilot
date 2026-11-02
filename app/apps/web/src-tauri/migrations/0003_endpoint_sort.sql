-- 接口排序：树内手动排序（拖拽 / 上移下移）的持久化基础。
-- 排序粒度＝(service_id, category_id) 分组内（散层与各分类是独立序列）；
-- 存量行按原显示顺序（同分组内 created_at, key 升序）回填连续序号。
ALTER TABLE endpoints ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

UPDATE endpoints SET sort_order = (
    SELECT COUNT(*) FROM endpoints AS e2
    WHERE e2.service_id = endpoints.service_id
      AND e2.category_id IS endpoints.category_id
      AND (e2.created_at < endpoints.created_at
           OR (e2.created_at = endpoints.created_at AND e2.key < endpoints.key))
);
