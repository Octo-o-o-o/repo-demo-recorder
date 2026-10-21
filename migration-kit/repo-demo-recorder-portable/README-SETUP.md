# 新机器配置包

把整个 zip 传到新机器并解压，用 Codex 打开解压目录，再发送 PROMPT.md 全文。源码完整在 skill/，不依赖 GitHub 可访问，也不依赖原机器路径。SOURCE.json 标记快照来源；该快照含原有未提交修改，不是一个已发布版本。

## 资源清单

|资源|用途|凭据|
|---|---|---|
|Node.js >=18|执行 skill 脚本|不需要|
|Python 3|配置包校验与凭据工具|不需要|
|FFmpeg / ffprobe|剪辑、编码、媒体检查|不需要|
|Playwright + Chromium|Web 录屏、封面渲染|不需要|
|ws npm 包|豆包带鉴权头的 WebSocket|不需要|
|uv / uvx + edge-tts|在线备用语音|不需要 API key|
|豆包/火山 TTS v3|在线中文女声|DOUBAO_TTS_API_KEY 或 VOLCENGINE_TTS_API_KEY|
|macOS say|macOS 离线语音|不需要，Windows/Linux 不支持此实现|
|中文字体|字幕和封面|系统字体；必要时指定 REPO_DEMO_RECORDER_FONT_FILE|

豆包非敏感配置见 tts-config.json。这是脚本支持的 narration 配置片段，不是完整 scenario；合并到 scaffold 输出的 narration 字段。API key 需要对应火山语音服务权限及可用额度，不能用普通大模型 key 或云账户 AccessKey 替代。服务可用性要在新机器实测。目标项目登录态、演示账号、storageState 不在包内，真正录制时另配。

## 密钥

本包不携带旧机器真实 key。可从你的密码管理器或服务商控制台取回，再在新机器本地终端输入；无需给 Codex 看见。没有 key 时依然能安装 skill、验证浏览器和媒体链路、使用 edge-tts。

macOS/Linux：`python3 credentials.py setup` 隐藏输入并保存在 `~/.config/repo-demo-recorder/credentials.json`（目录 700、文件 600）。这是权限受限的本地明文文件，不是加密保险箱；不应同步或打包。Windows 不自动写明文文件，使用下述 run 每次隐藏输入，或由密码管理器注入环境变量。

运行：`python3 /绝对路径/credentials.py run node /skill绝对路径/scripts/add-tts-narration.mjs --video ... --report ... --out ... --scenario ...`

Windows 将 python3 替换成 `py -3`。加载顺序：现有环境变量 → 本地凭据文件（仅 POSIX）→ 终端隐藏输入。key 只传给子进程环境，不传命令行。run 不启动 shell，故命令应直接写可执行文件和参数。不要通过该工具运行打印环境变量的命令。保存的 key 不会自动进入所有 Codex shell，必须使用 wrapper。

未来从目标项目目录运行时，ws 必须在该项目可解析；Playwright runner 同样依赖目标项目的模块解析。全局 npm 安装通常不能解决这两点。按该项目包管理器安装或使用隔离工作区，不随意修改已有依赖锁文件。

## 验收边界

verify.py 只检查包内容完整性，不验证来源可信度、服务商账户权限或实际业务录屏。源码自检也不能替代真实 Chromium 启动和在线 TTS 测试。具体本机打包验证结果见 VALIDATION.md。
