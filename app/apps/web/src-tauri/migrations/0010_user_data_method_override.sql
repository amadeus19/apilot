-- 接口级方法覆写（NULL＝跟随接口定义）：
-- 同步接口地址栏方法选择器可编辑的落点——稳定键由定义派生（方法＋路径），
-- 覆写不改变稳定键，接口与文档的同步映射不受影响；发送时覆写优先，
-- 定义侧随同步文档更新，互不干扰。
ALTER TABLE endpoint_user_data ADD COLUMN method_override TEXT;
