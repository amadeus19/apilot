-- endpoints.removed_at 退役：同步对已移除接口直接删除定义行（用户数据 /
-- 置顶 / 历史三张表不受影响，同键回归凭稳定键 INSERT 重接），软删除标记
-- 机制整体移除、不留死列。
-- 升级存量先收敛：旧版本置标隐藏（removed_at 非空）的行在升级时即按
-- 运行时同语义删除，不留待下次同步才消失。
DELETE FROM endpoints WHERE removed_at IS NOT NULL;
ALTER TABLE endpoints DROP COLUMN removed_at;
