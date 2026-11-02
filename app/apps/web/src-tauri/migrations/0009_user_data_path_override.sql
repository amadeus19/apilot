-- 接口级路径覆写（NULL＝跟随接口定义）：
-- 同步接口地址栏可编辑的落点——定义随文档更新（同步 diff 口径不变），
-- 用户改写的路径存用户数据层，发送时覆写优先；稳定键由定义派生，
-- 覆写不改变稳定键，接口与文档的同步映射不受影响。
ALTER TABLE endpoint_user_data ADD COLUMN path_override TEXT;
