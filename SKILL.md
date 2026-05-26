---
name: repo-demo-recorder
description: Create verified repository-native product walkthrough recordings with Playwright/browser automation, captions/subtitles, TTS narration, highlights, mock or seed data setup, quality gates, and committed artifacts. Use when an agent (Claude Code / Codex / Cursor) is asked to record a project demo, generate narrated walkthrough videos, add Chinese/English subtitles or voiceover, cover core business flows, create realistic data-entry recordings, produce recording scripts/guides, or turn UI QA work into reproducible video proof.
---

# Repo Demo Recorder

## 目标

把“临时录屏”变成可复现的工程产物：脚本化操作本地项目，生成带字幕/解说/高亮/停留时间的 MP4/WebM，并输出 JSON/Markdown 证据报告。

## 先问选项

如果用户没有明确说明，先用 1-3 个问题确认关键选项；能从上下文推断时直接采用默认值并记录假设。

- **目标观众/表达视角**：默认按请求推断。选项：客户演示、内部评审、工程验收、培训 SOP、发布证明。客户演示必须先讲业务价值和可控性，再讲机制；避免把 mock、fixture、内部边界、renderer-only、临时脚本等内部词放进画面字幕或旁白。
- **字幕**：默认开启。选项：无字幕、画面内字幕、外挂 `.srt/.vtt`、两者都要。
- **字幕语言**：默认跟用户语言一致。选项：`zh-CN`、`en-US`、双语、按页面 locale。
- **TTS 解说**：默认询问。选项：无解说、本地系统 TTS、云端 TTS、只生成解说稿。确认语言、声音、语速、是否保留原声。
- **业务流程**：默认覆盖核心流程。选项：核心浏览、添加新数据、编辑/删除、审批/审核、报表/导出、异常/空状态、移动端。
- **端类型**：默认自动推断。选项：桌面端、手机端、平板端、多端。纯手机版或多端中的手机版必须单独输出适合手机播放的竖屏视频，默认 1080×1920；字幕、章节横幅和封面也按竖屏重新排版。
- **数据策略**：默认用 mock/seed，并在 DB 写入前备份。选项：只读演示、真实 UI 写入、API seed、Prisma seed、录后清理。
- **录屏风格**：默认工程验收。选项：工程验收、销售 demo、培训 SOP、发布 PR 证明。
- **精修级别**：默认正式交付。选项：快速证据、正式交付、客户可发版。正式交付及以上必须分段录制、逐段 review、合并后媒体校验；客户可发版还要抽帧检查字幕/横幅出现和收起的过渡帧。
- **封面**：正式交付默认生成标准封面。桌面端默认 16:9，手机端默认 9:16；客户演示封面应使用真实录屏画面作主视觉，产品名/演示主题第一眼可见，避免用信息过密或偏单一模块的截图；先生成候选 contact sheet，确认后输出最终 cover PNG。
- **输出**：默认 MP4 + 原始 WebM + report JSON + 指南 MD。可加 GIF、截图、字幕文件、PR/commit 摘要。

更多选项见 `references/options.md`。场景文件结构见 `references/scenario-schema.md`。

## 录制环境（worktree 隔离）

skill 默认在目标项目里**新开一个 git worktree** 作为录制环境，所有 scaffold、runner、TTS、封面、validate 步骤都跑在 worktree 里，不污染主工作树。这样可以：

- 主工作树保持当前 dirty 状态/分支，用户的 IDE/终端会话不受打扰。
- 录屏脚本误删数据、bad seed、misconfig 都局限在 worktree 内，不需要 `git reset`。
- 同时录多个 flow（手机 + 桌面、core + add-data）时彼此不抢端口/缓存外的文件。

### 默认流程

```bash
# 0. 准备隔离 worktree（在目标项目根下跑）
node <skill>/scripts/prepare-recording-worktree.mjs --root . --name <flow>
# 输出最后一行是 JSON，包含 worktreePath；按提示 cd 进去
cd <worktreePath>

# 1-9. scaffold / runner / TTS / cover / validate / review 全部在 worktree 内执行
node <skill>/scripts/scaffold-repo-demo.mjs --root . --name <flow> ...
node scripts/recordings/<flow>.mjs
# ... 后续命令同 references/commands.md

# 10. 收尾：拷产物回主工作树并删除 worktree
node <skill>/scripts/cleanup-recording-worktree.mjs --worktree <worktreePath>
```

prepare 默认会：

- `git worktree add --detach` 创建 worktree（不污染分支命名空间）。默认路径 `<root>/.repo-demo-recorder/worktrees/<name>`，并把 `/.repo-demo-recorder/` 写入 `.git/info/exclude`，不影响主工作树 git status。
- 软链 `node_modules` / `.env` / `.env.local` / `.env.development*` / `.env.test*` / `.env.production*` 到 worktree，避免重新安装依赖、重新填环境变量。其它构建缓存（`.next` / `.vite` / `dist`）**不**默认软链，因为主工作树并行启动会互相覆盖；如确认安全，用 `--link <relPath>` 显式追加。
- 主工作树 dirty 时打印警告并提示：要么 `git commit` 一笔临时改动再开 worktree，要么加 `--include-uncommitted` 让 prepare 把 staged + unstaged + untracked（自动跳过默认 link 路径）搬到 worktree。

cleanup 默认会：

- 把 worktree 中的 `docs/recordings/` 和 `scripts/recordings/` 拷回主工作树（用 `--copy <relPath>` 追加；`--copy-mode merge|overwrite|backup` 控制冲突）。
- 解除 prepare 建的软链（不动用户在 worktree 内手动新建的真实文件）。
- `git worktree remove --force` 删 worktree（拷完产物后 worktree 必然 dirty，--force 是预期行为；想保留状态调试加 `--keep`）。
- 删空的 `.repo-demo-recorder/worktrees/` 父目录、移除自己写入的 `.git/info/exclude` pattern。

### 何时不走 worktree

下列情况直接在主工作树跑 scaffold 即可，不要 prepare worktree：

- 目标项目**不是 git 仓库**：prepare 会 fail-fast，提示先 `git init` 或直接在原目录跑。
- 录制内容就是**主工作树正在写的 uncommitted 改动**，且改动巨大不便临时 commit 再 carry。
- 用户明确只要录"快速证据"（`--polish quick-proof`），且主工作树干净。

### 外部录屏接入工作流

iOS / Android / 桌面客户端 / CLI 等不能由 Playwright 驱动的项目，录制步骤本来就是 raw video → 后期脚本。worktree 隔离对它们的价值是**保护后期产物落地路径**：在 worktree 内运行 `add-tts-narration.mjs` / `generate-video-cover.mjs` / `embed-video-cover.mjs` / `validate-recording-report.mjs`，cleanup 时统一拷回 `docs/recordings/`。

## 项目类型与录制源

skill 内置的脚本化录制路径依赖 Playwright 自动驱动浏览器，只适合可以本地起 web server 的项目（Web App / SaaS / 本地后端 + 浏览器 UI）。识别到下列情况时，应优先走"外部录屏接入"工作流：

- **iOS / macOS 原生 App**（Xcode 项目、`.xcodeproj/`、`*.xcworkspace/`、`project.yml` 由 XcodeGen 管理）：用 iOS 模拟器 + QuickTime 屏幕录制 / Xcode "Record App Preview" / Reincubate Camo / Screen Studio 录视频。
- **Android 原生 App**（`build.gradle` + `app/src/main/AndroidManifest.xml`）：用 Android Emulator + `adb screenrecord` / Android Studio screen recorder / Screen Studio。
- **桌面客户端**（Electron 没有 web 部分、Flutter Desktop、Tauri 桌面、SwiftUI for macOS）：用 Screen Studio / macOS QuickTime / OBS 录原始视频。
- **CLI 工具**：用 asciinema 或 QuickTime 录终端窗口；本 skill 仅做后期。

外部录屏接入工作流（不跑 `scaffold-repo-demo.mjs` 也能用）：

1. 用上述外部工具录得 raw MP4，建议同时手写一份 `report.json`（只需 `captions[].title/body/startMs/endMs/kind` 与 `steps:[]`、`consoleMessages:[]`、`pageErrors:[]`、`responseErrors:[]` 几个最小字段，参考 `references/quality-gates.md` 中 "Report 最小字段"）。
2. 用 `scripts/add-tts-narration.mjs` 加解说；竖屏录屏直接传 `--engine edge-tts --voice zh-CN-YunyangNeural`。
3. 用 `scripts/generate-video-cover.mjs --theme mobile --width 1080 --height 1920` 抽帧生成候选封面。
4. 用 `scripts/embed-video-cover.mjs --intro-duration-ms 2000` 嵌入封面，并按需 `trim-video-gap.mjs` 删除片头空白。
5. 用 `scripts/validate-recording-report.mjs --require-cover-art --expect-width ... --expect-height ...` 跑媒体级校验。
6. 用 `scripts/generate-review-page.mjs` 输出审片页；客户可发版用 `scripts/prepare-screen-studio-handoff.mjs` 打包给 Screen Studio。

scaffold 跑在原生项目根目录时会自动识别 `.xcodeproj/.xcworkspace/project.yml/build.gradle` 并打印警告：generated runner 不能驱动原生 UI，请改走外部录屏接入工作流，并忽略 scenario 中的 `server/auth/healthPath` 字段。

对 Web 项目，scaffold 现在会自动检测：

- `pnpm-lock.yaml/yarn.lock/bun.lockb/package-lock.json` → 推断 `server.command`。注意 npm 必须用 `npm run dev`，pnpm/yarn/bun 可以 `pnpm dev`。
- `src-tauri/tauri.conf.json` 的 `build.devUrl` 和 `beforeDevCommand` → 推断 Tauri 项目的 `baseUrl` 与 dev 命令，并提醒 Tauri invoke API 在浏览器中会失败。
- `vite.config.{ts,js,mjs}` / `next.config.*` / `package.json` → 推断 Vite (5173)、Next (3000)、其他 Node 项目的默认端口。
- `package.json` 中 `scripts.dev` / `scripts.start` 的 `-p PORT` / `--port PORT` → 优先使用脚本里写的端口，覆盖框架默认。
- 项目根目录的 `.gitignore` → 录屏产物未被忽略时打印警告，避免误 commit 大文件。
- Next.js 项目还会自动把 `/_next/static/*`、`/_next/webpack-hmr`、`/_next/data/development`、`/__nextjs_*` 预填进 `qualityGates.allowedResponseErrors`，避免 HMR/source-map 噪声让每次 validate 都 fail。
- 写入型 flow（含 `data`）默认 `qualityGates.requireApiSuccess=true`，配合 `step.waitForApi` 让 runner 自动写 `report.apiAssertions[]`。`requireDbAssertions` 默认 false，因为 DB 断言需要用户自己提供 module（见下方）。

显式传 `--base-url` 覆盖自动检测；scenario.json 落盘后仍可手工编辑 `server/baseUrl/healthPath`。

`scaffold` 会校验 `--audience / --polish / --language / --subtitles / --surface` 的取值，拼错时 fail-fast 给出有效取值列表。

## 工作流

0. **准备录制 worktree**：在目标项目（git 仓库）里跑 `prepare-recording-worktree.mjs --root . --name <flow>`，得到 worktreePath；之后所有命令的 `--root` 都改为 worktreePath，runner 也在 worktreePath 内启动 dev server。不是 git 仓库或用户明确要求"原地录"时跳过本步。
1. **读上下文**：读取项目启动命令、测试命令、auth/dev-login、seed/mock、禁区文件、现有录屏脚本和设计目标。
2. **定叙事和观众**：先把流程整理成“观众能理解的路径”。客户演示按“场景 -> 价值 -> 可控机制 -> 下一步”写字幕/旁白；内部评审才保留实现细节和风险点。如果用户要求先确认方案，必须先输出/落盘方案并等待确认。
3. **生成场景**：可运行 `scripts/scaffold-repo-demo.mjs` 生成场景 JSON、脚本骨架和录屏指南。正式 demo 优先把长流程拆成多个 segment。
4. **准备数据**：涉及 DB 写入前先备份；用 seed/upsert 创建稳定演示数据；避免生产数据和敏感信息入镜。客户可见内容使用“示例数据/演示租户”，不要把“mock/fixture”写进字幕或旁白。
5. **实现录制脚本**：优先 Playwright。字幕用录屏安全 DOM overlay 或后期字幕文件；解说从 captions/narration 生成；高亮只短暂提示，点击/输入前立即清除。`page.goto` 默认 `waitUntil="domcontentloaded"`，**不要在 Next.js/Vite dev 项目里用 `networkidle`**（HMR/long-poll 永远不 idle）。需要等数据加载完时用 `step.wait` + selector，或在 `step.waitForApi` 中指定关键 API。
6. **分段录制真实流程**：操作必须像真实用户；关键页面保留自然停留时间；表单数据要业务化，不要 `test/test`。正式交付默认一段一录、一段一 review；失败或画面不专业时重录该段，不把失败片段合进最终视频。
7. **补 TTS 解说**：对正式 demo 默认生成 transcript/VTT，再用本地 TTS 合成音频并 mux；解说补充业务价值和验收点，不逐字朗读字幕或按钮。旁白时间应从 overlay 稳定后开始。
8. **质量门禁**：检查 API POST 成功、页面无横向溢出、`pageErrors=[]`、高亮不滞留、允许的 404 有明确 allowlist，并做媒体级校验。
9. **生成并嵌入封面**：正式交付生成 `<name>-cover.png` 和 `<name>-cover-report.json`；客户可发版先输出候选封面 contact sheet，再选择最能代表完整产品价值的帧；最终 MP4 必须用 `embed-video-cover.mjs` 嵌入 `attached_pic` 封面流，并在质量门禁中要求 `--require-cover-art`。如果用户期望“打开视频就看到封面”，还必须加 `--intro-duration-ms 2000` 把封面作为真实开场画面写入视频，并同步后移 narration VTT/report。封面后如果出现 loading/白屏/空白等待，必须用 `trim-video-gap.mjs` 删除空白段，并再次抽帧确认封面后直接进入有效画面。
10. **媒体级验证和抽帧复查**：用 `ffprobe/ffmpeg` 校验 MP4 可解码、尺寸/帧率符合预期、有非静音音轨、音视频时长比例正常、字幕/解说稿/report 都落地。正式交付还要围绕字幕/章节横幅的开始、结束时间抽帧，确认没有半截遮罩、跳动、遮挡关键控件。
11. **生成审片页**：正式交付默认生成 review HTML，把视频、字幕时间线、质量门禁、封面候选和过渡帧放在同一页，便于逐段判断是否重录。
12. **基础包装或专业交接**：skill 只做稳定的背景、尺寸、padding 和导出 preset；需要自然缩放、光标平滑、设备模型、复杂时间线时，生成 Screen Studio handoff 包交给专业软件处理。
13. **落文档**：记录命令、环境、产物路径、已知噪声、DB 备份、封面选择、复验结果、如何重录。
14. **回收 worktree**：在主工作树（或任何位置）跑 `cleanup-recording-worktree.mjs --worktree <worktreePath>`，把 `docs/recordings/` 和 `scripts/recordings/` 拷回主工作树并 `git worktree remove --force`；如果还想在 worktree 内调试，加 `--keep`，确认后再来一次不带 `--keep` 收尾。
15. **提交策略**：只在用户要求时 commit/push；只暂存脚本、指南、录屏产物和相关日志，避开无关脏改。

## 端类型规则

- **桌面端**：默认录制横屏，推荐 1440×960 或项目约定尺寸；封面默认 1280×720。
- **手机端**：默认使用手机 viewport（如 390×844）和竖屏输出（1080×1920）。底部字幕使用全宽安全区，字号更小，章节横幅靠顶部安全区，避免遮住底部导航、输入框和主 CTA。
- **平板端**：默认使用竖屏或横屏平板尺寸，按实际产品使用场景决定；封面跟随视频方向。
- **多端项目**：桌面端和手机版应优先分别录制、分别配字幕和封面。不要把横屏桌面和竖屏手机硬拼成一个主视频；如必须合辑，应在每段之间加明确章节，并为手机版片段保留竖屏版本。
- 如果用户只说“手机版/移动端 App/H5 手机端”，直接使用 mobile surface，不需要再询问横屏尺寸。

## 叙事规则

- **客户演示**：面向业务/IT/安全负责人。字幕和旁白先讲客户能得到什么，例如减少切换、资料可追溯、操作可确认、权限可治理；技术词只作为支撑，不作为标题。`scenario.narrative.avoidVisibleTerms` 在 `validate-recording-report.mjs` 中会被强制校验，命中即门禁失败。
- **内部评审**：可以讲实现边界、mock、接口、已知噪声和风险，但这些词不要进入客户可发版。
- **培训 SOP**：步骤更慢，字段含义更明确，少用销售化形容。
- **发布证明/PR**：聚焦变更前后、回归验证、错误修复和风险留存。
- 如果一条录屏要同时给客户和内部看，优先产出客户版视频，内部信息放在 report/guide 中。

## 录屏安全 Overlay 规则

DOM overlay 最容易决定视频是否专业。正式交付默认遵守：

- 不使用 `translateY/translateX/scale/clip-path` 做出现或收起动画，避免录到“半截遮罩”中间帧。
- 章节横幅、说明面板和字幕固定在最终空间位置；只允许短时 `opacity` 变化，或直接切换。
- 显示前先更新内容、强制完成布局，再切换可见状态；显示后等待 1-2 个 animation frame + 过渡时间，再开始记录 caption `startMs`。
- 收起时先记录 caption `endMs`，再隐藏 overlay，并等待过渡完成后继续下一步点击/滚动。
- 横幅不要覆盖关键控件；底部字幕不要遮挡主 CTA、表单输入、报告正文或状态 toast。
- 高亮只保留 200-400ms，点击/输入前清除，`finally` 再清一次。
- 每段结束时 report 中 `highlightVisible=false`；正式交付要抽帧检查 overlay 开始/结束前后。

## 封面规则

- 桌面标准封面输出为 16:9 PNG，默认 1280×720；手机标准封面输出为 9:16 PNG，默认 1080×1920。
- 封面必须来自真实录屏抽帧或产品实景，不用纯渐变、抽象插画或无法代表产品的背景。
- 客户演示桌面封面结构默认：左侧产品名/演示主题/价值短句，右侧真实 UI 截图窗口，背景使用同一截图的模糊暗化版本。手机封面结构默认：顶部标题，中部手机 UI 主视觉，底部价值短句。
- 标题在小尺寸列表页中也要可读；不要超过两行，不使用负 letter spacing，不遮挡 UI 主视觉。
- 封面帧优先选择能代表整体工作流的入口页、Dashboard、Home 或核心结果页；手机端优先选择首屏可读、底部导航和主 CTA 不被遮挡的画面。避免选择设置页、登录页、错误态、loading、信息过密邮件页，除非视频主题就是这些内容。
- 正式交付应生成候选封面 contact sheet，并在 guide/report 中记录最终选择理由。

## 后期边界

- **skill 应该做**：分段录制、mock/seed 数据、字幕/解说、封面、审片页、基础背景包装、尺寸/音量/字幕/隐私质量门禁、Screen Studio 交接包。
- **专业软件更适合做**：自然 cursor smoothing、motion blur、复杂 zoom blending、摄像头动态布局、音乐混音、真机设备框细节、逐帧手动剪辑。
- **可配合 Screen Studio**：先用 skill 产出干净 raw video、narrated video、VTT、report、cover 和 review page；再用 Screen Studio 做手动 zoom、cursor、device frame、background 和最终导出。不要同时保留 skill open captions 和 Screen Studio captions，避免字幕重复。
- **避免为了设计而设计**：默认不加复杂转场、背景音乐、强运动缩放或硬裁横屏成竖屏。客户版优先清晰、稳定、可复验。

## 实现规则

- 不要只交一个视频；必须交脚本和复现说明。
- 不要把失败录屏伪装成完成；提交类动作必须等对应 API/路由/DB 断言成功。
- 对写入型录屏，必须先备份 DB，并在 report 中写入 demo data 名称和落库验证。
- 对字幕和高亮，宁可克制：字幕不遮挡主要控件，高亮展示 200-400ms，之后立即隐藏。
- 对客户可发版，模块切换可用更显眼的章节横幅，但必须采用录屏安全 overlay 规则，并抽帧检查出现/收起过渡。
- 对 TTS 解说，先生成 transcript，再合成音频并 mux 到视频；没有明确授权时不要调用外部云端 TTS。
- 解说要补充业务价值，不逐字朗读按钮；中文默认用 `zh-CN` 声音，保留 0.8-1.2 秒自然间隔。
- 对带 TTS 的最终视频，必须验证音轨不是静音：`max_volume` 默认应高于 `-50 dB`，并输出 media report。
- 合成 TTS 后必须 `ffprobe` 测每段音频时长。若 `audioMs + padBuffer` 超过该段 cue 的展示窗口（`cue.startMs` 到下一个 `cue.startMs` 或视频结尾），自动在原 cue 末尾插入冻结帧（`tpad=stop_mode=clone`）并把后续 cue 的时间轴整体后移；同步把字幕 VTT、narration-report 的时间码改为延长后的坐标。默认 `--pad-mode freeze --pad-buffer-ms 300 --max-padding-ms 60000`，单段超限时不要默默截断音频，而要 fail-fast 让人缩短文案。
- 如果同一任务有“核心流程”和“新增数据流程”，优先输出两个单独 MP4，再拼接一个完整 walkthrough，避免单段脚本过长难以重录。
- 对登录流程，优先使用本地 dev-login、storage state 或人工 auth handoff；不要录入真实密码。
- 对商业/隐私数据，使用 blur、mock 数据或专用演示租户。
- 对 CI/PR 录屏，优先固定 viewport、locale、timezone、seed、network allowlist。

## 可用资源

- `scripts/prepare-recording-worktree.mjs`：在目标项目里 `git worktree add` 一个隔离录制环境，自动软链 `node_modules` / `.env*`，可选 carry 未提交改动；输出 worktreePath 元数据供 cleanup 使用。
- `scripts/cleanup-recording-worktree.mjs`：把 worktree 内的 `docs/recordings/` / `scripts/recordings/` 拷回主工作树，解除软链，`git worktree remove --force` 并清理 `.git/info/exclude` 注册的 pattern。
- `scripts/scaffold-repo-demo.mjs`：在目标仓库生成场景 JSON、Playwright 脚本骨架、录屏指南。
- `scripts/add-tts-narration.mjs`：从 report captions 生成 TTS 解说、VTT 解说稿，并合成带解说 MP4；支持 macOS `say` 和 `edge-tts`。
- `scripts/generate-video-cover.mjs`：从视频抽帧生成标准封面，桌面端 16:9、手机端 9:16，可生成候选封面 contact sheet。
- `scripts/embed-video-cover.mjs`：把封面 PNG 作为 MP4 `attached_pic` 流嵌入最终视频；可用 `--intro-duration-ms` 添加肉眼可见的封面开场，并同步后移 narration VTT/report。
- `scripts/trim-video-gap.mjs`：删除封面后、转场中或录屏开头的空白片段，并同步后移/前移 narration VTT/report，保留封面流。
- `scripts/validate-recording-report.mjs`：校验 report JSON 的高亮、溢出、page error、response allowlist，并可生成字幕/章节过渡抽帧 contact sheet。
- `scripts/generate-review-page.mjs`：生成本地审片 HTML，集中查看视频、字幕时间线、封面候选、frame review 和质量门禁结果。
- `scripts/polish-video.mjs`：做保守后期包装和导出 preset，包括客户桌面、客户手机、社媒竖屏、QA 证明和 README GIF。
- `scripts/prepare-screen-studio-handoff.mjs`：打包 raw/narrated video、字幕、report、封面和说明，交给 Screen Studio 做专业时间线编辑。
- `scripts/install-skill.mjs`：把本仓库安装到 `$CODEX_HOME/skills/repo-demo-recorder`、`~/.codex/skills/repo-demo-recorder`，或 `~/.claude/skills/repo-demo-recorder`（`--target claude`）。
- `scripts/check-skill.mjs`：开源仓库自检，校验必需文件、脚本语法和 scaffold smoke test。
- `references/options.md`：录屏需求选项矩阵。
- `references/scenario-schema.md`：场景配置结构和示例。
- `references/quality-gates.md`：验收清单与常见失败处理。
- `references/commands.md`：常用命令完整版（scaffold → 录制 → TTS → 封面 → 校验 → 审片 → 包装）。
- `scripts/templates/playwright-runner.mjs`：scaffold 写出录屏脚本的模板源；改这里就能改所有新生成 runner 的行为。

## 推荐产物结构

```text
scripts/recordings/
  <flow>.mjs
docs/recordings/
  RECORDING_GUIDE.md
  <flow>.mp4
  <flow>-<timestamp>.webm
  <flow>-final.png
  <flow>-report.json
  <flow>.scenario.json
  <flow>-narrated.mp4
  <flow>-narrated-narration.vtt
  <flow>-narrated-narration-report.json
  <flow>-media-report.json
  <flow>-cover.png
  <flow>-cover-report.json
  <flow>-cover-embed-report.json
  <flow>-gap-trim-report.json
  <flow>-cover-candidates/
    contact-sheet.png
  <flow>-frame-review/
    contact-sheet.png
  <flow>-review.html
  <flow>-polished.mp4
  <flow>-polish-report.json
  <flow>-screen-studio-handoff/
    SCREEN_STUDIO_HANDOFF.md
    screen-studio-handoff.json
```

## 常用命令

完整命令清单见 `references/commands.md`。决策流程上你只需要记住：

0. `prepare-recording-worktree.mjs` 在目标项目里开 worktree，cd 进去；不是 git 仓库则跳过本步。
1. `scaffold-repo-demo.mjs` 生成 scenario + runner + guide。
2. 跑 generated runner 录原始 MP4 + report.json。
3. `add-tts-narration.mjs` 加解说，`generate-video-cover.mjs` 抽帧出封面，`embed-video-cover.mjs` 把封面嵌入 MP4，`trim-video-gap.mjs` 删开场空白。
4. `validate-recording-report.mjs` 做质量门禁与抽帧复查。
5. `generate-review-page.mjs` 输出本地审片 HTML；客户可发版用 `polish-video.mjs` 或 `prepare-screen-studio-handoff.mjs` 做最后包装。
6. `cleanup-recording-worktree.mjs` 把产物拷回主工作树并删 worktree。
