请在这台新机器配置 repo-demo-recorder skill。配套目录是本 prompt 所在的 repo-demo-recorder-portable；如果你只能看到附件而不能访问本地文件，先让我提供解压目录。请实际完成安装和验收，不要只给操作建议。

本次授权：在当前用户范围安装 skill、Node/Python 依赖、Playwright Chromium 和所需工具；如系统缺少 Node.js、Python 3、FFmpeg 或 uv，也授权通过可信的官方渠道/系统包管理器补齐。需要管理员权限时让我在本地处理，不能索取管理员密码。不授权购买、充值、开通付费服务、commit、push 或操作生产项目。

1. 先读 README-SETUP.md、SOURCE.json、skill/SKILL.md 和安装脚本。执行 python3 verify.py（Windows 可用 py -3）。必须通过所有哈希校验。这是含未提交 TTS 修复的本地快照，不要擅自替换成远端 main。
2. 检测 OS、架构、Codex 实际 skills 发现路径和 CODEX_HOME。优先沿用已生效的配置，必要时读取本机说明或官方文档。使用 skill/scripts/install-skill.mjs 安装；若目标已存在，先备份到 skills 目录外，再替换，保留可回滚路径。不要直接无备份 --force。
3. 补齐 Node.js（满足 >=18，优先当前受支持 LTS）、Python 3、ffmpeg/ffprobe、uv/uvx。安装目录内用 npm install --no-save --package-lock=false playwright ws，并运行 npx playwright install chromium；Linux 需要的系统库按实际失败补齐。安装脚本不会自动装这些依赖。记录实际版本。
4. 按 README-SETUP.md 配置豆包 TTS 非敏感参数和凭据。无需 OpenAI key。先检查 DOUBAO_TTS_API_KEY / VOLCENGINE_TTS_API_KEY 是否存在，只报告有/无。不要打印环境变量值、读取已有 secret 文件给模型、要求我把 key 发进聊天，或把 key 放进命令参数、scenario、仓库、日志。需要 key 时让我在本地终端运行 credentials.py setup；Windows 默认使用 credentials.py run 的隐藏输入。复制 credentials.py 到用户工具目录以便解压包删除后还能使用，记录绝对路径。已有 key 也不代表 API 可用。
5. 默认准备豆包中文女声配置，同时准备无需 key 的 edge-tts 备用路径；不要悄悄将豆包失败当作 edge 成功。豆包服务未开通或权限不足时继续完成其余安装，明确缺哪项并给我服务商官方入口，不替我付费。
6. 验收：运行安装目录 scripts/check-skill.mjs，记录通过/失败/跳过；从安装目录验证 playwright、ws 能解析并实际启动 Chromium 打开内存测试页、截图；用 FFmpeg 生成 3 秒合成画面。在线验证只发送公开句子“你好，这是录屏技能的配置测试。”，本次授权各 TTS 提供商最多一次短句合成（豆包可能产生少量按量费用，不授权充值）；设置有界超时，失败不重复扣费重试。先检查脚本重试行为，必要时用小型一次性客户端直接请求。密钥缺失则豆包测试标为未运行，绝不称通过。用 ffprobe 验证生成音频时长 >0。另外用 scaffold 在临时目录生成 mock 场景，验证 runner 语法，不需要真实业务项目或生产账号。
7. 在持久的用户工具目录记录安装路径、备份、依赖版本、凭据接入方式（不含值）、测试结果和复用命令。解释 Node 模块解析边界：豆包 ws 从当前工作目录加载，runner 的 playwright 从目标项目加载；未来录制具体仓库时还要确保该仓库能解析依赖，不能声称装好 skill 就适用于所有仓库。
8. 最终用简体中文给我安装结果和可复制的使用示例。明确区分环境安装、Codex 新会话发现 skill、真实在线 TTS 验证和真实项目录屏；需要刷新/新建会话才能发现时如实说明。不要为了安装要求我先选择录屏业务路径或数据源，这次只配置环境。
