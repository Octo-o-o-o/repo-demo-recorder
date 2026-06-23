---
name: repo-demo-recorder
description: Create verified repository-native product walkthrough recordings with Playwright/browser automation, captions/subtitles, TTS narration, segmented assembly, cover art, review pages, quality gates, and committed artifacts. Use when an agent is asked to record a project demo, generate narrated walkthrough videos, add Chinese/English subtitles or voiceover, create customer-ready product walkthroughs, produce mobile portrait demos, package external app recordings, or turn UI QA work into reproducible video proof.
---

# Repo Demo Recorder

## 目标

把产品演示录屏做成可复现的工程产物，而不是一次性的手工视频。完成任务时，通常应交付录制脚本、场景配置、视频、字幕或解说、封面、质量报告、审片页和重录说明。

默认优先级：

1. 安全：不泄露生产数据、真实密码、客户隐私或未经授权的环境。
2. 可复现：脚本和 scenario 能让后续 agent 或开发者重跑。
3. 可审片：产物包含 report、media report、frame review 或 review HTML。
4. 可交付：字幕、解说、封面、尺寸、音量和过渡帧达到目标观众标准。

## 先确认两件事

### 1. 数据来源必须明确

用户没有明确说明时，先问数据来源，不要默认推断。

- `mock`：本地 dev 环境、seed/fixture/API intercept 生成的演示数据。推荐默认，安全，可反复重录，可分享。
- `staging`：预发环境或演示租户。需要专用演示账号、`auth.storageState` 或 dev-login，不默认清理共享租户数据。
- `production`：真实生产数据。默认不录。只有用户明确确认有授权时才继续，并且 scaffold 必须传 `--data-mode production --allow-production`。流程强制只读，不写入、不切换到他人账号、不拍进无关客户数据。

询问时说明：mock 安全可发版；staging 适合工程验收但要准备账号；production 风险高，需要授权和只读策略。

### 2. 真正要演示的业务必须明确

不要只录 landing page 或空白首页。用户没有说明业务路径时，至少问清：

- 要演示哪条核心流程？
- 关键的 1-3 个动作是什么？
- 目标观众是谁，客户、内部评审、QA、培训还是 PR 证明？

默认骨架只是起点。正式录屏必须进入产品本体，例如 dashboard、列表、详情、表单、报表、审批、导出或移动端核心页面。

## 什么时候使用哪条路径

### Web 项目

如果目标项目能用浏览器访问，使用默认 Playwright 工作流：

1. 准备隔离 worktree。
2. scaffold 场景和 runner。
3. 编辑 scenario、runner、guide。
4. 运行录制脚本。
5. 加 TTS、封面、质量门禁和审片页。
6. cleanup worktree，把产物带回主工作树。

### 外部录屏项目

iOS、Android、macOS 原生 App、Flutter Desktop、Tauri 桌面壳、Electron 无 Web shell、纯 CLI 等无法由 Playwright 驱动时，不要硬录浏览器。改用外部录屏接入：

1. 用 QuickTime、Xcode Simulator、Android Emulator、OBS、Screen Studio 或 asciinema 录 raw MP4。
2. 写最小 report JSON，包含 `captions[]`、`steps[]`、`consoleMessages[]`、`pageErrors[]`、`responseErrors[]`。
3. 用本 skill 的 TTS、合并、封面、嵌入、trim、validate、review 脚本做后期和校验。

`scaffold-repo-demo.mjs` 在检测到原生项目时会提醒 generated runner 不能驱动原生 UI。此时应解释并切到外部录屏路径。

## 推荐执行流程

### 0. 读取上下文

先读目标项目的启动方式、框架、auth/dev-login、seed/mock、现有录屏产物、测试命令和禁区文件。需要更完整的参数和 schema 时再查：

- `references/commands.md`
- `references/options.md`
- `references/scenario-schema.md`
- `references/quality-gates.md`

### 1. 建隔离 worktree

默认在目标项目中创建录制 worktree，避免污染主工作树：

```bash
node <skill>/scripts/prepare-recording-worktree.mjs --root . --name <flow>
```

stdout 最后一行是 JSON，读取 `worktreePath` 后进入该目录继续：

```bash
cd <worktreePath>
```

默认软链 `node_modules` 和非生产 `.env*`。`.env.production*` 不自动软链。只有生产录制被明确授权时，才显式 `--link .env.production.local`。

主工作树有未提交改动时，优先让用户确认是否需要带入录制环境；需要时用 `--include-uncommitted`。不要为了录屏对主工作树执行破坏性 git 操作。

跳过 worktree 的情况：

- 目标项目不是 git 仓库。
- 用户明确要求原地录制。
- 快速 QA 证据且主工作树干净。
- 要录的就是大量未提交改动，搬到 worktree 成本过高。

### 2. scaffold 场景

始终显式传 `--data-mode`：

```bash
node <skill>/scripts/scaffold-repo-demo.mjs \
  --root . \
  --name <flow> \
  --data-mode mock \
  --language zh-CN \
  --subtitles open \
  --audience qa-proof \
  --polish formal-delivery \
  --flows core
```

手机端使用：

```bash
node <skill>/scripts/scaffold-repo-demo.mjs \
  --root . \
  --name <flow> \
  --surface mobile \
  --data-mode mock \
  --language zh-CN \
  --subtitles both \
  --audience customer \
  --polish customer-ready \
  --flows mobile
```

生成后必须编辑并检查：

- `docs/recordings/<flow>.scenario.json`
- `scripts/recordings/<flow>.mjs`
- `docs/recordings/RECORDING_GUIDE.md`

不要把 scaffold 的占位流程当成最终交付。应根据真实业务补齐 routes、selectors、captions、narration、preflight、waitForApi、assertions 和质量门禁。

### 3. 准备数据和预热账号

录制前让数据稳定：

- mock 环境优先用 seed/upsert/API intercept 创建演示数据。
- staging 使用专用演示账号或演示租户。
- production 只读，不写入。
- 写入型流程必须先明确备份和清理策略。

首登弹窗、onboarding、隐私 banner 应放进 `scenario.preflight.steps`，不要录进正式视频。支持 `goto`、`click`、`fill`、`wait`、`fetch`。优先用 profile API 或 storage state 直接标记 onboarding 完成。

### 4. 实现真实录制脚本

使用 Playwright 驱动真实 UI。规则：

- `page.goto` 默认用 `domcontentloaded`，不要在 Next/Vite dev 项目里用 `networkidle`。
- 数据加载用 selector、`waitForApi` 或明确的等待条件，不靠固定长 sleep。
- 写入动作必须等待 API、URL 或 DB 断言，不能只看页面跳转。
- 登录优先用 storage state、dev-login 或人工 auth handoff。不要录入真实密码。
- 字幕和旁白描述业务价值，不暴露 mock、fixture、renderer-only、内部边界等客户不可见词。
- 表单数据要像真实业务，不用 `test/test`。
- 高亮只短暂提示，点击或输入前清除，结束时 report 中 `highlightVisible=false`。

### 5. 分段录制

正式交付默认分段：

- 每段独立 MP4/WebM/report。
- 每段录完先 review。
- 某段失败只重录该段。
- 所有段通过后再合并。

短 QA 证据可以单段录制。单段合并时 `assemble-segmented-video.mjs` 会直接复制，不会插入中间转场。

### 6. 添加 TTS 解说

推荐从 scenario 读取 TTS 默认值：

```bash
node <skill>/scripts/add-tts-narration.mjs \
  --video docs/recordings/<flow>.mp4 \
  --report docs/recordings/<flow>-report.json \
  --out docs/recordings/<flow>-narrated.mp4 \
  --scenario docs/recordings/<flow>.scenario.json
```

客户可发版中文可用：

```bash
--engine edge-tts --voice zh-CN-YunyangNeural --pad-mode freeze --pad-buffer-ms 300
```

`edge-tts` 是在线 TTS，会把文本发送到 Microsoft。敏感内容没有授权时不要用，改用 macOS `say`、本地语音或只输出文稿。

TTS 默认 `--pad-mode freeze`：语音比展示窗口长时，在对应 cue 末尾插入冻结帧并平移后续时间轴。不要截断音频。单段 padding 超过上限时，优先缩短文案。

### 7. 合并多段视频

多段视频用：

```bash
node <skill>/scripts/assemble-segmented-video.mjs \
  --out docs/recordings/<full>-narrated.mp4 \
  --segment docs/recordings/<seg-a>-narrated.mp4 \
  --segment-title "<第一段标题>" \
  --segment-report docs/recordings/<seg-a>-report.json \
  --segment docs/recordings/<seg-b>-narrated.mp4 \
  --segment-title "<第二段标题>" \
  --segment-report docs/recordings/<seg-b>-report.json \
  --report docs/recordings/<full>-assemble-report.json \
  --combined-report docs/recordings/<full>-report.json
```

2 段及以上会在段间插入短子封面。子封面应沿用主封面的真实抽帧、色彩和字体，但视觉层级更低。

### 8. 生成封面并嵌入 MP4

正式交付默认生成真实录屏帧封面和候选 contact sheet：

```bash
node <skill>/scripts/generate-video-cover.mjs \
  --video docs/recordings/<flow>-narrated.mp4 \
  --report docs/recordings/<flow>-report.json \
  --out docs/recordings/<flow>-cover.png \
  --title "<产品或演示名>" \
  --subtitle "<价值短句>" \
  --candidates-dir docs/recordings/<flow>-cover-candidates
```

手机端传：

```bash
--width 1080 --height 1920 --theme mobile
```

最终 MP4 需要封面流：

```bash
node <skill>/scripts/embed-video-cover.mjs \
  --video docs/recordings/<flow>-narrated.mp4 \
  --cover docs/recordings/<flow>-cover.png \
  --out docs/recordings/<flow>-narrated.mp4 \
  --intro-duration-ms 2000 \
  --narration-report docs/recordings/<flow>-narrated-narration-report.json \
  --narration-vtt docs/recordings/<flow>-narrated-narration.vtt \
  --report docs/recordings/<flow>-cover-embed-report.json
```

`attached_pic` 只是元数据。客户希望打开视频就看到封面时，保留 `--intro-duration-ms 2000`。

封面后若出现 loading、白屏、黑屏或空档，用 `trim-video-gap.mjs` 删除准确范围，并同步 narration report/VTT。

### 9. 质量门禁

至少运行：

```bash
node <skill>/scripts/validate-recording-report.mjs \
  docs/recordings/<flow>-report.json \
  --video docs/recordings/<flow>-narrated.mp4 \
  --source-video docs/recordings/<flow>.mp4 \
  --narration-report docs/recordings/<flow>-narrated-narration-report.json \
  --require-audio \
  --require-cover-art \
  --expect-width 1440 \
  --expect-height 960 \
  --write-media-report docs/recordings/<flow>-media-report.json \
  --write-frame-review docs/recordings/<flow>-frame-review
```

手机端用 `--expect-width 1080 --expect-height 1920`。

必过项：

- 脚本语法检查通过。
- 录制脚本退出码为 0。
- `pageErrors=[]`。
- response/console 噪声有明确 allowlist。
- `highlightVisible=false`。
- 横向溢出为 0，除非用户明确接受。
- 写入型流程有 API、URL 或 DB 成功断言。
- 带解说视频有音频流，且非静音。
- TTS 输出时长与 narration report 预期一致。
- 最终视频尺寸符合目标端类型。
- 客户可发版有封面、候选封面、封面嵌入验证。
- 字幕、章节横幅、段间子封面的开始和结束帧没有半截遮罩、遮挡关键控件、字体溢出或跳动。

### 10. 生成审片页

正式交付默认生成：

```bash
node <skill>/scripts/generate-review-page.mjs \
  --report docs/recordings/<flow>-report.json \
  --video docs/recordings/<flow>-narrated.mp4 \
  --media-report docs/recordings/<flow>-media-report.json \
  --narration-report docs/recordings/<flow>-narrated-narration-report.json \
  --cover docs/recordings/<flow>-cover.png \
  --cover-candidates docs/recordings/<flow>-cover-candidates \
  --frame-review docs/recordings/<flow>-frame-review \
  --out docs/recordings/<flow>-review.html
```

审片页用于集中确认视频、字幕时间线、音频、封面候选、质量报告和过渡帧。发现问题时重录对应 segment，不把失败片段混入最终视频。

### 11. 后期包装或 Screen Studio 交接

skill 适合做稳定的自动包装：

```bash
node <skill>/scripts/polish-video.mjs \
  --video docs/recordings/<flow>-narrated.mp4 \
  --out docs/recordings/<flow>-polished.mp4 \
  --preset customer-desktop
```

需要自然 zoom、cursor smoothing、motion blur、设备框、摄像头布局或主观时间线剪辑时，输出 handoff 包：

```bash
node <skill>/scripts/prepare-screen-studio-handoff.mjs \
  --out docs/recordings/<flow>-screen-studio-handoff \
  --target desktop \
  --raw-video docs/recordings/<flow>.mp4 \
  --narrated-video docs/recordings/<flow>-narrated.mp4 \
  --report docs/recordings/<flow>-report.json \
  --scenario docs/recordings/<flow>.scenario.json \
  --vtt docs/recordings/<flow>-narrated-narration.vtt \
  --cover docs/recordings/<flow>-cover.png
```

不要同时保留 skill open captions 和 Screen Studio 生成的第二套字幕。

### 12. cleanup worktree

完成后把产物带回主工作树并删除录制 worktree：

```bash
node <skill>/scripts/cleanup-recording-worktree.mjs --worktree <worktreePath>
```

默认拷回 `docs/recordings/` 和 `scripts/recordings/`。自定义输出目录用 `--copy <relPath>`。需要保留 worktree 调试时传 `--keep`，调完再不带 `--keep` 收尾。

## 叙事和可见文案规则

- 客户演示：讲业务价值、可控性、效率、追溯、权限、安全和下一步。不要在字幕或旁白里出现 mock、fixture、内部边界、临时脚本、dev warning。
- 内部评审：可以讲实现边界、已知噪声和风险，但这些信息放 report/guide，不放客户版视频。
- QA/PR 证明：聚焦变更前后、断言和回归结果。
- 培训 SOP：放慢节奏，讲字段含义和操作顺序。
- 同一个录屏要同时服务客户和内部时，先做客户版；内部信息放文档。

## Overlay 和封面规则

录屏中的 DOM overlay 要保守：

- 不用 `translateY`、`translateX`、`scale`、`clip-path` 做字幕或章节横幅动画。
- 固定最终位置，只允许短 opacity 变化或直接切换。
- 内容先写入并完成布局，再显示；显示稳定后再记录 caption `startMs`。
- 记录 `endMs` 后再隐藏，等待过渡结束再继续操作。
- 字幕不遮挡主 CTA、输入框、表格、报告正文、toast 或底部导航。
- 手机端优先底部安全区全宽字幕，但避开底部导航、输入框和键盘区域。

封面规则：

- 必须来自真实录屏或产品实景，不用纯渐变、抽象插画或随机空白帧。
- 桌面默认 1280x720，手机默认 1080x1920。
- 候选帧优先 Home、Dashboard、核心结果页；避开登录页、设置页、loading、错误页和信息过密页面。
- 客户封面标题小尺寸也要可读，不能遮挡产品主视觉。
- 记录最终封面选择理由，便于复验和重录。

## 可用脚本速查

- `scripts/prepare-recording-worktree.mjs`：创建隔离录制 worktree。
- `scripts/cleanup-recording-worktree.mjs`：拷回产物并删除 worktree。
- `scripts/scaffold-repo-demo.mjs`：生成 scenario、runner、guide。
- `scripts/add-tts-narration.mjs`：生成 TTS、VTT、narration report，并合成带解说视频。
- `scripts/assemble-segmented-video.mjs`：合并单段或多段视频，多段时插入段间子封面。
- `scripts/generate-video-cover.mjs`：抽帧生成封面和候选 contact sheet。
- `scripts/embed-video-cover.mjs`：嵌入 MP4 `attached_pic`，可添加可见封面片头。
- `scripts/trim-video-gap.mjs`：删除空白/loading 片段并平移 narration 时间轴。
- `scripts/validate-recording-report.mjs`：校验 report、音视频、封面和过渡帧。
- `scripts/generate-review-page.mjs`：生成本地审片 HTML。
- `scripts/polish-video.mjs`：保守导出 preset。
- `scripts/prepare-screen-studio-handoff.mjs`：打包给 Screen Studio 的素材。
- `scripts/install-skill.mjs`：安装到 Codex 或 Claude Code skill 目录。
- `scripts/check-skill.mjs`：自检本 skill。

## 完成标准

除非用户只要草稿，否则最终回复应列出：

- 录制路径和核心产物路径。
- 数据模式、目标观众、端类型和关键假设。
- 已运行的校验命令和结果。
- 未解决的风险、allowlist 噪声或需要人工审片的地方。
- 如何重录或继续后期。

只在用户要求时 commit/push。提交时只暂存本任务相关的脚本、指南、录屏产物、报告和文档，避开无关脏改。
