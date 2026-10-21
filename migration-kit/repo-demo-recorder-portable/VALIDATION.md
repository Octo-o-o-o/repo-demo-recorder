# 打包验证（2026-10-09）

本机验证通过：
- 快照内 `node skill/scripts/check-skill.mjs` 退出 0，输出 skill checks passed，无跳过警告。
- 安装到临时目录后，逐文件比较与快照一致。
- 两个 Python 工具语法解析通过。
- 使用合成 token 验证环境变量注入、本地 600 文件加载；644 凭据文件被拒绝。没有使用或导出真实 key。
- SHA256 清单及 ZIP 解压后校验通过。

未运行：新机器安装、Windows 实测、真实豆包/Edge 在线合成、Codex 新会话发现、真实项目录屏。交互式隐藏输入和新机器系统权限需现场验证。

原仓库已有 scripts/add-tts-narration.mjs 修改保持原样，快照包含它；未 commit/push。
