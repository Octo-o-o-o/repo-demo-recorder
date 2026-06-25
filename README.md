# Repo Demo Recorder

`repo-demo-recorder` 是一个面向 Claude Code、Codex、Cursor 和自定义 agent 的录屏技能与 CLI 工具集。它把“临时手动录屏”整理成可复现、可审片、可验证、可交付的工程产物：场景配置、Playwright 录制脚本、字幕、TTS 解说、封面、质量报告、审片页和可选后期交接包。

它适合为本地项目生成客户演示、工程验收、培训 SOP、发布证明和 UI QA 证据。对 Web 项目，它可以驱动浏览器完成真实流程；对 iOS、Android、桌面客户端和 CLI 项目，它也能接入外部录制好的 MP4，继续完成解说、封面、合并、校验和审片。

## 能做什么

- 为目标仓库生成 `docs/recordings/*.scenario.json`、Playwright runner 和 `RECORDING_GUIDE.md`。
- 使用隔离的 git worktree 录制，避免污染用户主工作树、当前分支和 IDE 会话。
- 明确区分 `mock`、`staging`、`production` 数据来源；生产录制必须显式授权并强制只读。
- 支持 `preflight.steps`，在正式录制前关闭 onboarding、隐私 banner、首登弹窗等干扰。
- 支持桌面、手机、平板和多端项目；手机默认竖屏 `1080x1920` 输出和移动端安全区字幕。
- 从 report captions 生成 TTS 解说、VTT 和 narration report；默认用 freeze-frame padding 避免语音被截断。
- 合并多段视频；只有多段时插入低强度段间子封面，单段直接透传。
- 从真实录屏抽帧生成桌面 `16:9` 或手机 `9:16` 封面，并输出候选 contact sheet。
- 把封面 PNG 嵌入 MP4 `attached_pic`，也可写入可见片头，并同步修正解说时间轴。
- 删除封面后或转场中的 loading、白屏、黑屏空档，并保持 narration VTT/report 同步。
- 校验页面错误、网络错误、横向溢出、API/DB 断言、音频、音量、尺寸、封面和关键过渡帧。
- 生成本地 review HTML，把视频、字幕时间线、封面、候选帧、frame review 和质量报告集中到一页。
- 输出保守后期 preset，或打包 Screen Studio handoff 给专业工具处理缩放、光标、设备框和时间线。

## 安装

```bash
git clone https://github.com/Octo-o-o-o/repo-demo-recorder.git
cd repo-demo-recorder

# Codex，默认安装到 $CODEX_HOME/skills/repo-demo-recorder
# 未设置 CODEX_HOME 时安装到 ~/.codex/skills/repo-demo-recorder
node scripts/install-skill.mjs --force

# Claude Code
node scripts/install-skill.mjs --target claude --force

# 自定义位置
node scripts/install-skill.mjs --dest /path/to/skills/repo-demo-recorder --force

# 只预览安装动作
node scripts/install-skill.mjs --target claude --dry-run
```

安装后重启或刷新对应 agent。也可以不安装 skill，直接用本仓库的脚本：

```bash
node scripts/scaffold-repo-demo.mjs --help
node scripts/check-skill.mjs
```

## 环境要求

- Node.js 18+
- `ffmpeg` 和 `ffprobe`
- 目标 Web 项目中可用 Playwright，或者目标项目允许安装/运行 Playwright
- 可选：macOS `say`，用于本地离线 TTS
- 可选：`uvx` + `edge-tts`，用于质量更好的在线 TTS
- 可选：火山/豆包 TTS v3 key（运行时临时放 `DOUBAO_TTS_API_KEY` 或 `VOLCENGINE_TTS_API_KEY`），用于豆包在线语音合成；不要写进 scenario、文档、runner 或会提交的 env 文件
- 可选：Playwright，用于封面渲染；缺失时 `generate-video-cover.mjs` 会退化到 ffmpeg drawtext 或抽帧方案

如果 fallback 封面文字需要更好的字体，可设置：

```bash
export REPO_DEMO_RECORDER_FONT_FILE=/path/to/font.ttf
```

## 推荐工作流

下面的 `<skill>` 指安装后的 skill 路径，例如 `~/.codex/skills/repo-demo-recorder` 或 `~/.claude/skills/repo-demo-recorder`。命令在被录制的目标项目根目录执行。

### 1. 准备隔离 worktree

```bash
node <skill>/scripts/prepare-recording-worktree.mjs \
  --root . \
  --name customer-demo
```

脚本输出最后一行是 JSON，包含 `worktreePath`。进入该目录后执行后续录制命令：

```bash
cd <worktreePath>
```

默认会软链 `node_modules`、`.env`、`.env.local`、`.env.development*`、`.env.test*`，但不会自动软链 `.env.production*`。如果需要把主工作树的未提交改动带入录制环境，显式增加：

```bash
node <skill>/scripts/prepare-recording-worktree.mjs \
  --root . \
  --name customer-demo \
  --include-uncommitted
```

### 2. 生成场景和录制脚本

必须先明确数据来源：

- `mock`：本地开发环境和演示数据，推荐默认值，可分享。
- `staging`：预发环境或测试租户，需要专用演示账号和 `auth.storageState`。
- `production`：真实生产数据，必须有书面授权，并加 `--allow-production`；场景会被锁定为只读。

桌面端示例：

```bash
node <skill>/scripts/scaffold-repo-demo.mjs \
  --root . \
  --name customer-demo \
  --data-mode mock \
  --language zh-CN \
  --subtitles both \
  --audience customer \
  --polish customer-ready \
  --flows core,add-data
```

手机竖屏示例：

```bash
node <skill>/scripts/scaffold-repo-demo.mjs \
  --root . \
  --name mobile-demo \
  --surface mobile \
  --data-mode mock \
  --language zh-CN \
  --subtitles both \
  --audience customer \
  --polish customer-ready \
  --flows mobile
```

`scaffold` 会自动检测常见 Web 项目的 dev command 和 baseUrl，包括 Vite、Next、Tauri、npm/pnpm/yarn/bun 脚本。可用 `--base-url` 覆盖。

生成后重点检查并完善：

- `docs/recordings/<name>.scenario.json`
- `scripts/recordings/<name>.mjs`
- `docs/recordings/RECORDING_GUIDE.md`

### 3. 录制

```bash
node scripts/recordings/customer-demo.mjs
```

runner 会启动 dev server、执行场景步骤、写入 MP4/WebM、最终截图和 report JSON。正式交付建议把长流程拆成多个 segment，逐段录制、逐段审片，通过后再合并。

### 4. 添加 TTS 解说

推荐让 TTS 脚本直接读取 scenario 中的 narration 配置：

```bash
node <skill>/scripts/add-tts-narration.mjs \
  --video docs/recordings/customer-demo.mp4 \
  --report docs/recordings/customer-demo-report.json \
  --out docs/recordings/customer-demo-narrated.mp4 \
  --scenario docs/recordings/customer-demo.scenario.json
```

如需强制指定在线中文声音：

```bash
node <skill>/scripts/add-tts-narration.mjs \
  --video docs/recordings/customer-demo.mp4 \
  --report docs/recordings/customer-demo-report.json \
  --out docs/recordings/customer-demo-narrated.mp4 \
  --engine edge-tts \
  --voice zh-CN-YunyangNeural \
  --pad-mode freeze \
  --pad-buffer-ms 300
```

脚手架也可以在生成 scenario 时直接选择 provider 和声音：

```bash
node <skill>/scripts/scaffold-repo-demo.mjs \
  --name customer-demo \
  --data-mode mock \
  --tts-provider doubao-tts-v3 \
  --tts-voice zh_female_jitangmei_uranus_bigtts
```

如需使用豆包女声，先用不回显的 prompt 临时注入 key，再运行合成；结束后清掉环境变量：

```bash
printf "DOUBAO_TTS_API_KEY: "
stty -echo
trap 'stty echo' EXIT
IFS= read -r DOUBAO_TTS_API_KEY
stty echo
trap - EXIT
printf "\n"
export DOUBAO_TTS_API_KEY

node <skill>/scripts/add-tts-narration.mjs \
  --video docs/recordings/customer-demo.mp4 \
  --report docs/recordings/customer-demo-report.json \
  --out docs/recordings/customer-demo-narrated.mp4 \
  --engine doubao-tts-v3 \
  --voice zh_female_jitangmei_uranus_bigtts

unset DOUBAO_TTS_API_KEY
```

脚手架 provider 可选：`--tts-provider auto|macos-say|local-system|edge-tts|doubao-tts-v3`。声音可用 `--tts-voice <voice>` 或直接改 `scenario.narration.voice`。`edge-tts` 与 `doubao-tts-v3` 都需要网络，并会把解说文本发送到对应在线 TTS 服务；涉及敏感内容且没有授权时，使用 `macos-say` 或只生成解说稿。不要把 API key 写进 scenario 或文档；共享机器上尽量不要用 `--doubao-api-key`，因为命令行可能进入 shell history 或进程列表。

### 5. 合并多段视频

如果最终视频由多个片段组成，先确保每段都通过校验，再合并：

```bash
node <skill>/scripts/assemble-segmented-video.mjs \
  --out docs/recordings/full-walkthrough-narrated.mp4 \
  --segment docs/recordings/core-narrated.mp4 \
  --segment-title "核心浏览路径" \
  --segment-report docs/recordings/core-report.json \
  --segment docs/recordings/add-data-narrated.mp4 \
  --segment-title "新增数据流程" \
  --segment-report docs/recordings/add-data-report.json \
  --transition-duration-ms 2400 \
  --transition-fade-in-ms 180 \
  --transition-fade-out-ms 380 \
  --report docs/recordings/full-walkthrough-assemble-report.json \
  --combined-report docs/recordings/full-walkthrough-report.json
```

只有一个 segment 时脚本会直接复制输出，不会添加中间转场。

### 6. 生成并嵌入封面

桌面封面：

```bash
node <skill>/scripts/generate-video-cover.mjs \
  --video docs/recordings/customer-demo-narrated.mp4 \
  --report docs/recordings/customer-demo-report.json \
  --out docs/recordings/customer-demo-cover.png \
  --title "产品演示" \
  --subtitle "面向客户的可发版走查" \
  --candidates-dir docs/recordings/customer-demo-cover-candidates
```

手机竖屏封面：

```bash
node <skill>/scripts/generate-video-cover.mjs \
  --video docs/recordings/mobile-demo-narrated.mp4 \
  --report docs/recordings/mobile-demo-report.json \
  --out docs/recordings/mobile-demo-cover.png \
  --width 1080 \
  --height 1920 \
  --theme mobile \
  --candidates-dir docs/recordings/mobile-demo-cover-candidates
```

嵌入封面，并把封面写成 2 秒可见片头：

```bash
node <skill>/scripts/embed-video-cover.mjs \
  --video docs/recordings/customer-demo-narrated.mp4 \
  --cover docs/recordings/customer-demo-cover.png \
  --out docs/recordings/customer-demo-narrated.mp4 \
  --intro-duration-ms 2000 \
  --narration-report docs/recordings/customer-demo-narrated-narration-report.json \
  --narration-vtt docs/recordings/customer-demo-narrated-narration.vtt \
  --report docs/recordings/customer-demo-cover-embed-report.json
```

`attached_pic` 是播放器元数据，不等同于打开视频时肉眼可见的第一帧。客户可发版通常保留 `--intro-duration-ms 2000`。

如果封面后出现白屏、黑屏、loading 或无意义等待，删除那段空档：

```bash
node <skill>/scripts/trim-video-gap.mjs \
  --video docs/recordings/customer-demo-narrated.mp4 \
  --cover docs/recordings/customer-demo-cover.png \
  --out docs/recordings/customer-demo-narrated.mp4 \
  --remove-start-ms 2000 \
  --remove-end-ms 8500 \
  --narration-report docs/recordings/customer-demo-narrated-narration-report.json \
  --narration-vtt docs/recordings/customer-demo-narrated-narration.vtt \
  --report docs/recordings/customer-demo-gap-trim-report.json
```

### 7. 质量门禁和审片页

```bash
node <skill>/scripts/validate-recording-report.mjs \
  docs/recordings/customer-demo-report.json \
  --video docs/recordings/customer-demo-narrated.mp4 \
  --source-video docs/recordings/customer-demo.mp4 \
  --narration-report docs/recordings/customer-demo-narrated-narration-report.json \
  --require-audio \
  --require-cover-art \
  --expect-width 1440 \
  --expect-height 960 \
  --write-media-report docs/recordings/customer-demo-media-report.json \
  --write-frame-review docs/recordings/customer-demo-frame-review
```

手机端改为：

```bash
--expect-width 1080 --expect-height 1920
```

生成审片页：

```bash
node <skill>/scripts/generate-review-page.mjs \
  --report docs/recordings/customer-demo-report.json \
  --video docs/recordings/customer-demo-narrated.mp4 \
  --media-report docs/recordings/customer-demo-media-report.json \
  --narration-report docs/recordings/customer-demo-narrated-narration-report.json \
  --cover docs/recordings/customer-demo-cover.png \
  --cover-candidates docs/recordings/customer-demo-cover-candidates \
  --frame-review docs/recordings/customer-demo-frame-review \
  --out docs/recordings/customer-demo-review.html
```

### 8. 回收 worktree

```bash
node <skill>/scripts/cleanup-recording-worktree.mjs \
  --worktree <worktreePath>
```

默认把 `docs/recordings/` 和 `scripts/recordings/` 拷回主工作树，然后删除录制 worktree。若使用了自定义输出目录，增加 `--copy <relPath>`。

## 外部录屏接入

iOS、Android、macOS 原生 App、Flutter Desktop、Tauri 桌面壳、Electron 无 Web shell、CLI 工具等无法由 Playwright 直接驱动时，使用外部录屏工作流：

1. 用 QuickTime、Xcode Simulator、Android Emulator、OBS、Screen Studio 或 asciinema 录制 raw MP4。
2. 手写最小 `report.json`，至少包含 `captions[]`、`steps[]`、`consoleMessages[]`、`pageErrors[]`、`responseErrors[]`。
3. 用 `add-tts-narration.mjs` 添加解说。
4. 多段视频用 `assemble-segmented-video.mjs` 合并。
5. 用 `generate-video-cover.mjs` 生成封面和候选 contact sheet。
6. 用 `embed-video-cover.mjs` 嵌入封面，必要时 `trim-video-gap.mjs` 删除片头空档。
7. 用 `validate-recording-report.mjs` 和 `generate-review-page.mjs` 做最终校验和审片。

最小 report 结构见 `references/quality-gates.md`。

## 默认质量标准

正式交付和客户可发版默认要求：

- `pageErrors` 为空。
- `responseErrors` 只包含有解释的 allowlist 噪声。
- 所有步骤 `highlightVisible=false`。
- 页面横向溢出为 0，除非用户明确接受横向滚动。
- 写入型流程至少有成功 API、URL 或 DB 断言。
- 带解说视频必须有非静音音轨，并输出 narration report、VTT 和 media report。
- 桌面视频尺寸符合预期，常用 `1440x960`；手机视频必须竖屏，默认 `1080x1920`。
- 客户可发版必须生成真实产品画面的封面候选、最终封面和 MP4 `attached_pic`。
- 封面片头后不应出现明显空白/loading 段。
- 字幕、章节横幅和段间子封面的开始/结束帧需要抽帧检查，避免遮挡、半截遮罩、字体溢出和跳动。
- 正式交付建议生成 review HTML，减少漏审。

更完整的门禁和常见失败处理见 `references/quality-gates.md`。

## 命令地图

```bash
node scripts/prepare-recording-worktree.mjs --help
node scripts/cleanup-recording-worktree.mjs --help
node scripts/scaffold-repo-demo.mjs --help
node scripts/add-tts-narration.mjs --help
node scripts/assemble-segmented-video.mjs --help
node scripts/generate-video-cover.mjs --help
node scripts/embed-video-cover.mjs --help
node scripts/trim-video-gap.mjs --help
node scripts/validate-recording-report.mjs --help
node scripts/generate-review-page.mjs --help
node scripts/polish-video.mjs --help
node scripts/prepare-screen-studio-handoff.mjs --help
node scripts/install-skill.mjs --help
node scripts/check-skill.mjs --help
```

安装为 npm package 后也可以使用 `package.json` 中的 bin 名：

- `repo-demo-scaffold`
- `repo-demo-prepare-worktree`
- `repo-demo-cleanup-worktree`
- `repo-demo-add-tts`
- `repo-demo-assemble`
- `repo-demo-cover`
- `repo-demo-embed-cover`
- `repo-demo-trim-gap`
- `repo-demo-validate`
- `repo-demo-review`
- `repo-demo-polish`
- `repo-demo-screen-studio`
- `repo-demo-check`
- `repo-demo-install-skill`

## 仓库结构

```text
repo-demo-recorder/
  SKILL.md                         # Agent 读取的主说明
  README.md                        # 面向使用者的中文说明
  LICENSE                          # MIT
  package.json                     # npm 元数据、bin、npm run check
  agents/openai.yaml               # Codex 展示元数据
  references/
    commands.md                    # 完整命令手册
    options.md                     # 观众、端类型、字幕、TTS、封面等选项矩阵
    quality-gates.md               # 校验规则、常见失败、最小 report
    scenario-schema.md             # scenario JSON 字段说明
  scripts/
    prepare-recording-worktree.mjs
    cleanup-recording-worktree.mjs
    scaffold-repo-demo.mjs
    add-tts-narration.mjs
    assemble-segmented-video.mjs
    generate-video-cover.mjs
    embed-video-cover.mjs
    trim-video-gap.mjs
    validate-recording-report.mjs
    generate-review-page.mjs
    polish-video.mjs
    prepare-screen-studio-handoff.mjs
    install-skill.mjs
    check-skill.mjs
    templates/playwright-runner.mjs
```

## 开发和自检

```bash
npm run check
```

自检会验证关键文件、脚本语法、脚手架 smoke test，以及主要 CLI 的基础行为。提交前建议至少跑一次。

## License

MIT
