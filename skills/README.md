# Agent skill

`apilot/` 是给 Apilot 用户的英文 Agent skill，教编码 agent 用 `apilot` CLI 读取与执行本机工作空间里的接口和工作流。
把它整个文件夹拷贝进编码 agent 的 skills 目录即可（如 `~/.claude/skills/`、`~/.agents/skills/`），文件夹名 `apilot` 不要改。
前提是已安装 Apilot，并在 设置 › 开发者 › 高级 开启 CLI，使 `apilot` 在 PATH 上。
升级 Apilot 后重新从代码仓库拉取本 skill，保持它和 CLI 契约一致。
