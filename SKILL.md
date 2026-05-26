---
name: repo-demo-recorder
description: Create verified repository-native product walkthrough recordings with Playwright/browser automation, captions/subtitles, TTS narration, highlights, mock or seed data setup, quality gates, and committed artifacts. Use when Codex is asked to record a project demo, generate narrated walkthrough videos, add Chinese/English subtitles or voiceover, cover core business flows, create realistic data-entry recordings, produce recording scripts/guides, or turn UI QA work into reproducible video proof.
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
- **数据策略**：默认用 mock/seed，并在 DB 写入前备份。选项：只读演示、真实 UI 写入、API seed、Prisma seed、录后清理。
- **录屏风格**：默认工程验收。选项：工程验收、销售 demo、培训 SOP、发布 PR 证明。
- **精修级别**：默认正式交付。选项：快速证据、正式交付、客户可发版。正式交付及以上必须分段录制、逐段 review、合并后媒体校验；客户可发版还要抽帧检查字幕/横幅出现和收起的过渡帧。
- **封面**：正式交付默认生成标准 16:9 封面。客户演示封面应使用真实录屏画面作主视觉，产品名/演示主题第一眼可见，避免用信息过密或偏单一模块的截图；先生成候选 contact sheet，确认后输出最终 cover PNG。
- **输出**：默认 MP4 + 原始 WebM + report JSON + 指南 MD。可加 GIF、截图、字幕文件、PR/commit 摘要。

更多选项见 `references/options.md`。场景文件结构见 `references/scenario-schema.md`。

## 工作流

1. **读上下文**：读取项目启动命令、测试命令、auth/dev-login、seed/mock、禁区文件、现有录屏脚本和设计目标。
2. **定叙事和观众**：先把流程整理成“观众能理解的路径”。客户演示按“场景 -> 价值 -> 可控机制 -> 下一步”写字幕/旁白；内部评审才保留实现细节和风险点。如果用户要求先确认方案，必须先输出/落盘方案并等待确认。
3. **生成场景**：可运行 `scripts/scaffold-repo-demo.mjs` 生成场景 JSON、脚本骨架和录屏指南。正式 demo 优先把长流程拆成多个 segment。
4. **准备数据**：涉及 DB 写入前先备份；用 seed/upsert 创建稳定演示数据；避免生产数据和敏感信息入镜。客户可见内容使用“示例数据/演示租户”，不要把“mock/fixture”写进字幕或旁白。
5. **实现录制脚本**：优先 Playwright。字幕用录屏安全 DOM overlay 或后期字幕文件；解说从 captions/narration 生成；高亮只短暂提示，点击/输入前立即清除。
6. **分段录制真实流程**：操作必须像真实用户；关键页面保留自然停留时间；表单数据要业务化，不要 `test/test`。正式交付默认一段一录、一段一 review；失败或画面不专业时重录该段，不把失败片段合进最终视频。
7. **补 TTS 解说**：对正式 demo 默认生成 transcript/VTT，再用本地 TTS 合成音频并 mux；解说补充业务价值和验收点，不逐字朗读字幕或按钮。旁白时间应从 overlay 稳定后开始。
8. **质量门禁**：检查 API POST 成功、页面无横向溢出、`pageErrors=[]`、高亮不滞留、允许的 404 有明确 allowlist，并做媒体级校验。
9. **生成封面**：正式交付生成 `<name>-cover.png` 和 `<name>-cover-report.json`；客户可发版先输出候选封面 contact sheet，再选择最能代表完整产品价值的帧。
10. **媒体级验证和抽帧复查**：用 `ffprobe/ffmpeg` 校验 MP4 可解码、尺寸/帧率符合预期、有非静音音轨、音视频时长比例正常、字幕/解说稿/report 都落地。正式交付还要围绕字幕/章节横幅的开始、结束时间抽帧，确认没有半截遮罩、跳动、遮挡关键控件。
11. **落文档**：记录命令、环境、产物路径、已知噪声、DB 备份、封面选择、复验结果、如何重录。
12. **提交策略**：只在用户要求时 commit/push；只暂存脚本、指南、录屏产物和相关日志，避开无关脏改。

## 叙事规则

- **客户演示**：面向业务/IT/安全负责人。字幕和旁白先讲客户能得到什么，例如减少切换、资料可追溯、操作可确认、权限可治理；技术词只作为支撑，不作为标题。
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

- 标准封面输出为 16:9 PNG，默认 1280×720；如面向高清发布，可追加 1920×1080。
- 封面必须来自真实录屏抽帧或产品实景，不用纯渐变、抽象插画或无法代表产品的背景。
- 客户演示封面结构默认：左侧产品名/演示主题/价值短句，右侧真实 UI 截图窗口，背景使用同一截图的模糊暗化版本。
- 标题在小尺寸列表页中也要可读；不要超过两行，不使用负 letter spacing，不遮挡 UI 主视觉。
- 封面帧优先选择能代表整体工作流的入口页、Dashboard、Home 或核心结果页；避免选择设置页、登录页、错误态、loading、信息过密邮件页，除非视频主题就是这些内容。
- 正式交付应生成候选封面 contact sheet，并在 guide/report 中记录最终选择理由。

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

- `scripts/scaffold-repo-demo.mjs`：在目标仓库生成场景 JSON、Playwright 脚本骨架、录屏指南。
- `scripts/add-tts-narration.mjs`：从 report captions 生成 TTS 解说、VTT 解说稿，并合成带解说 MP4；支持 macOS `say` 和 `edge-tts`。
- `scripts/generate-video-cover.mjs`：从视频抽帧生成标准 16:9 封面，可生成候选封面 contact sheet。
- `scripts/validate-recording-report.mjs`：校验 report JSON 的高亮、溢出、page error、response allowlist，并可生成字幕/章节过渡抽帧 contact sheet。
- `scripts/install-skill.mjs`：把本仓库安装到 `$CODEX_HOME/skills/repo-demo-recorder` 或 `~/.codex/skills/repo-demo-recorder`。
- `scripts/check-skill.mjs`：开源仓库自检，校验必需文件、脚本语法和 scaffold smoke test。
- `references/options.md`：录屏需求选项矩阵。
- `references/scenario-schema.md`：场景配置结构和示例。
- `references/quality-gates.md`：验收清单与常见失败处理。

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
  <flow>-narration.vtt
  <flow>-narration-report.json
  <flow>-media-report.json
  <flow>-cover.png
  <flow>-cover-report.json
  <flow>-cover-candidates/
    contact-sheet.png
  <flow>-frame-review/
    contact-sheet.png
```

## 常用命令

```bash
node <skill>/scripts/scaffold-repo-demo.mjs --root . --name add-data-flow --language zh-CN --subtitles open --flows core,add-data
node <skill>/scripts/add-tts-narration.mjs --video docs/recordings/add-data-flow.mp4 --report docs/recordings/add-data-flow-report.json --out docs/recordings/add-data-flow-narrated.mp4 --language zh-CN --engine edge-tts --voice zh-CN-YunyangNeural --pad-mode freeze --pad-buffer-ms 300
node <skill>/scripts/generate-video-cover.mjs --video docs/recordings/add-data-flow-narrated.mp4 --report docs/recordings/add-data-flow-report.json --out docs/recordings/add-data-flow-cover.png --title "Product Demo" --subtitle "Customer-ready walkthrough" --candidates-dir docs/recordings/add-data-flow-cover-candidates
node <skill>/scripts/validate-recording-report.mjs docs/recordings/add-data-flow-report.json --video docs/recordings/add-data-flow-narrated.mp4 --source-video docs/recordings/add-data-flow.mp4 --narration-report docs/recordings/add-data-flow-narrated-narration-report.json --require-audio --expect-width 1440 --expect-height 960 --write-media-report docs/recordings/add-data-flow-media-report.json --write-frame-review docs/recordings/add-data-flow-frame-review
```
