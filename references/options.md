# 录屏选项矩阵

## 目标观众

- `customer`：客户演示。优先讲业务价值、可控性、可落地路径；字幕和旁白避免 `mock`、`fixture`、内部边界、脚本实现、dev warning 等内部词。
- `internal-review`：内部评审。可以暴露实现细节、已知噪声、风险和未完成项。
- `qa-proof`：工程验收。强调可复现、断言、报告和质量门禁。
- `training`：培训 SOP。强调步骤、字段含义和慢速停留。
- `release-pr`：PR/发布证明。强调变更前后、修复点和回归验证。

目标观众不明确时按请求推断：出现“客户、销售、demo、试点、演示给别人看”默认 `customer`；出现“review、验收、PR、证明”默认对应工程视角。

## 精修级别

- `quick-proof`：快速证据。允许单段录制，保留 report 和基础媒体校验。
- `formal-delivery`：正式交付。默认分段录制、逐段 review、TTS 或解说稿、媒体校验、关键帧截图。
- `customer-ready`：客户可发版。在正式交付基础上，必须检查客户口径、字幕遮挡、章节横幅过渡、音量和最终时长；建议输出 frame-review contact sheet。

## 端类型 / Surface

- `desktop`：桌面端横屏录制，默认 viewport/video 为 1440×960，封面 1280×720。
- `mobile`：手机端竖屏录制，默认页面 viewport 为 390×844，视频输出为 1080×1920，封面 1080×1920。
- `tablet`：平板端录制，默认 viewport 为 820×1180，视频输出为 1080×1440。
- `multi`：多端项目。建议为桌面端和手机版分别生成独立视频与封面；手机版仍使用 `mobile` 的竖屏字幕、竖屏封面和竖屏质量门禁。
- `auto`：只有 `mobile` flow 时自动使用手机端；否则默认桌面端。

手机端视频不应直接套用桌面字幕和 16:9 封面。字幕要避开底部导航、输入框、系统安全区；封面应使用 9:16 竖屏模板。

## 字幕

- `none`：不加字幕。适合纯 QA 证据。
- `open`：画面内字幕。适合异步观看、PR 证明、客户演示。
- `sidecar`：外挂 `.srt/.vtt`。适合后期剪辑、多语言版本。
- `both`：画面内字幕 + 外挂字幕。适合正式交付。

字幕位置默认左下或右下，避开表单输入区和主 CTA。字幕文案描述“这一页能解决什么业务问题”，不要解释脚本实现。

## 模块切换提示

- `none`：不加章节横幅。
- `caption-only`：只用底部字幕提示模块切换。
- `chapter-banner`：顶部或侧边章节横幅，适合客户演示和培训。

章节横幅应表达客户价值，例如“文件深度问答 / 从企业资料中得到带来源的结论”，不要写“RAG step 3 / mock route seed”。横幅必须使用录屏安全 overlay：固定位置、无位移动画、无裁切动画、显示稳定后再开始计时。

## Overlay 动画

- `safe-opacity`（默认）：固定位置，只做短时透明度变化；显示前预渲染，显示后等待稳定帧。正式交付使用此项。
- `instant`：无动画直接切换。适合 QA 证据或动画容易干扰时。
- `motion`：允许位移/缩放/裁切。仅适合非正式草稿；客户可发版禁用。

不推荐在录屏中使用 `translateY/translateX/scale/clip-path` 作为字幕、章节横幅或面板的出现/收起动画。浏览器录屏会采到中间帧，容易出现半截遮罩或不专业的跳动。

## 封面

- `none`：不生成封面。只适合临时 QA 证据。
- `standard`：生成一张标准 PNG；桌面默认 16:9（1280×720），手机默认 9:16（1080×1920）。
- `with-candidates`：先生成 4-6 张候选封面和 contact sheet，再输出最终封面。正式交付默认。
- `multi-size`：生成 1280×720 与 1920×1080。适合公开视频平台或销售素材库。

标准客户封面建议：

- 左侧：产品名/演示主题/价值短句。
- 右侧：真实录屏抽帧作为产品窗口主视觉。
- 背景：同一抽帧模糊暗化，保证标题可读。
- 候选帧：优先 Home、Dashboard、核心结果页；避开登录页、设置页、loading、错误页和信息过密页面。

手机客户封面建议：

- 顶部：产品名和演示主题。
- 中部：真实手机 UI 截图或 H5 移动界面，尽量完整露出首屏。
- 底部：价值短句和视频类型。
- 输出尺寸默认 1080×1920，候选 contact sheet 使用竖屏缩略图。

## 字幕语言

- `zh-CN`：默认中文。
- `en-US`：英文。
- `bilingual`：双语，适合跨国团队，但每条字幕要更短。
- `locale`：跟随应用 locale。

## TTS 解说

- `none`：不加解说，只保留字幕/画面。
- `local-system`：使用本机系统 TTS。macOS 默认可用 `say`，中文推荐先试 `Tingting` 或 `Flo (Chinese (China mainland))`。
- `edge-tts`：通过 `uvx edge-tts` 使用 Microsoft Edge online TTS，中文默认推荐 `zh-CN-YunyangNeural`。需要联网，并会把解说文本发送到在线 TTS 服务。
- `cloud`：调用云端 TTS。只有用户明确允许外部服务和凭据可用时使用。
- `script-only`：只生成解说稿、VTT/JSON，不合成音频。

解说语言默认跟字幕语言一致。中文建议语速 170-190 wpm；英文建议 155-175 wpm。正式演示应输出 transcript，方便人工校对。

## 解说混音

- `replace`：视频原声静音，只保留 TTS。适合无真人讲解的 UI 录屏。
- `duck`：保留原声但降低音量。适合有点击声或系统提示音的视频。
- `keep-original`：原声不变，TTS 叠加。只在原声很轻时使用。

## TTS 超时处理

- `freeze`（默认）：TTS 合成完成后，逐段比较 `audioMs + padBufferMs` 与该 cue 的展示窗口（`cue.startMs` 到下一段 `cue.startMs` 或视频结尾）。窗口装不下就在原 cue 末尾插入冻结帧扩展视频，并把后续 cue 的时间轴整体后移。可用 `--pad-buffer-ms`（默认 300）调每段结尾留白，`--max-padding-ms`（默认 60000）防止单段无限扩展。
- `none`：不扩展。音频会被下一段 cue 或视频末尾截断；只有在确定 TTS 一定短于窗口时才用，否则解说听起来会被切。
- 启用 `freeze` 时会触发一次视频重编码（默认 `libx264 -crf 20 -preset veryfast`，可用 `--video-codec/--video-crf/--video-preset` 覆盖）；没有任何超时则走 fast path，沿用 `-c:v copy`。

## 媒体级验证

- `ffprobe-streams`：校验 MP4/WebM 存在可解码的视频流和预期尺寸。
- `audio-present`：带 TTS 时必须有音频流。
- `audio-non-silent`：用 `ffmpeg volumedetect` 校验 `max_volume`，默认阈值高于 `-50 dB`。
- `duration-ratio`：带解说视频时长不短于源视频 98%；当启用 `--pad-mode freeze` 时输出会比源长，ratio 自然 > 1，应同时校验 narration-report 中的 `timeline.outputDurationMs ≈ timeline.expectedDurationMs`（脚本内部已做 ±2%/±500ms 校验），慢速版或拼接版要在 report 中记录来源。
- `frame-sample`：抽取关键帧做人眼检查，确认字幕不遮挡主 CTA、报告正文和表单输入。
- `sidecar-proof`：解说稿 `.vtt`、narration report、media report 必须随视频一起交付。

## 后期处理

- `review-html`：生成本地审片页面，集中查看最终视频、字幕时间线、封面候选、frame review、media report 和 narration report。正式交付默认推荐。
- `polish-preset`：用 `polish-video.mjs` 做保守包装或导出，适合稳定自动化。可选：`customer-desktop`、`customer-mobile`、`social-mobile`、`qa-proof`、`readme-gif`。
- `screen-studio-handoff`：当需要专业软件处理自然 zoom、cursor smoothing、motion blur、device mockup、webcam layout 或主观剪辑时，生成 Screen Studio 交接包。skill 负责 raw/narrated video、VTT、report、cover、review 证据；Screen Studio 负责最终时间线美化。

默认策略：客户可发版先生成 review HTML；如果只需要统一背景和尺寸，用 `polish-preset`；如果用户明确追求 Screen Studio 风格，使用 `screen-studio-handoff`，不要在 skill 里硬做复杂运镜。

## 业务流程覆盖

- `core`：核心浏览路径、列表、详情、筛选、搜索、tab、提交。
- `add-data`：新增资料库/内容源/模板/报告等真实数据录入。
- `edit-data`：编辑、启停、重命名、配置更新。
- `delete-data`：删除或归档。默认只在 mock 环境录。
- `review`：审核、审批、决策、提交反馈。
- `export`：导出、分享、下载、生成报告。
- `empty-error-loading`：空状态、错误状态、loading、权限不足。
- `mobile`：375/390 宽移动端关键路径。

## 数据策略

- `readonly`：只浏览，不写入。
- `ui-write`：通过真实 UI 写入。必须备份 DB，并做落库断言。
- `api-seed`：录制前用 API 创建演示数据。
- `db-seed`：录制前用 ORM/seed/upsert 创建演示数据。
- `cleanup`：录后清理本次演示数据。只在用户要求或测试环境稳定时启用。

## 风格

- `qa-proof`：工程验收，强调可复现、断言、report。
- `sales-demo`：销售演示，强调价值、卖点、节奏、画面干净。
- `training`：培训 SOP，强调步骤、字段含义、慢速停留。
- `release-pr`：PR/发布证明，强调变更前后、关键修复、风险点。

## 分段策略

- `single`：短流程单段录制。
- `segmented`：每个模块独立 MP4/WebM/report/review，全部通过后再合并。正式 demo 默认使用。
- `segmented-with-rerecord`：逐段 review，发现遮挡、过渡瑕疵、字幕不合适、接口错误时只重录该段。客户可发版默认使用。

## 输出

- `mp4`：稳定主产物。
- `webm`：Playwright 原始录屏或浏览器原始产物。
- `report-json`：步骤、字幕、console、page error、network、质量门禁。
- `media-report-json`：ffprobe/ffmpeg 的音视频流、时长、音量和尺寸校验结果。
- `final-screenshot`：终帧。
- `guide-md`：重录说明和注意事项。
- `srt/vtt`：外挂字幕。
- `gif`：PR 评论或 README 轻量展示。
- `frame-review`：围绕 caption/chapter 开始和结束时间抽帧，生成 contact sheet，检查字幕遮挡和过渡瑕疵。
- `cover`：标准封面 PNG。
- `cover-candidates`：候选封面与 contact sheet。
- `cover-intro`：把封面写成视频开头的真实画面，解决播放器不显示 `attached_pic` 的情况。
- `cover-embed-report`：MP4 `attached_pic` 封面嵌入验证报告。
- `gap-trim-report`：删除封面后空白/loading 片段后的时间轴修正报告。
- `review-html`：本地审片页。
- `polished-mp4`：基础包装后的最终交付 MP4。
- `screen-studio-handoff`：给 Screen Studio 的素材包和操作说明。

## 默认推荐

```json
{
  "subtitles": "open",
  "audience": "qa-proof",
  "polish": "formal-delivery",
  "narration": { "enabled": true, "engine": "macos-say", "voice": "Tingting", "rate": 180, "padMode": "freeze", "padBufferMs": 300 },
  "language": "zh-CN",
  "flows": ["core"],
  "dataMode": "mock",
  "dataStrategy": "readonly",
  "style": "qa-proof",
  "outputs": ["mp4", "webm", "report-json", "final-screenshot", "guide-md", "narrated-mp4", "narration-vtt", "media-report-json", "review-html", "cover", "cover-candidates"],
  "viewport": { "width": 1440, "height": 960 },
  "surface": "desktop",
  "recording": { "videoSize": { "width": 1440, "height": 960 }, "orientation": "landscape" },
  "mediaValidation": { "requireAudio": true, "minDurationRatio": 0.98, "minAudioMaxDb": -50 },
  "highlight": { "enabled": true, "holdMs": 320, "clearBeforeAction": true },
  "overlay": { "animation": "safe-opacity", "settleMs": 160, "chapterBanner": false },
  "segmentation": "segmented",
  "cover": { "enabled": true, "mode": "with-candidates", "width": 1280, "height": 720 },
  "postProduction": { "reviewPage": true, "polishPreset": "customer-desktop", "screenStudioHandoff": false }
}
```
