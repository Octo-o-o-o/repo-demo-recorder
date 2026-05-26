# 质量门禁

## 必过项

- `node --check` 或等价语法检查通过。
- 项目自身类型检查/构建命令不低于改动前 baseline。
- 录屏脚本退出码为 0。
- `report.steps[].highlightVisible` 全部为 `false`。
- `max(report.steps[].overflow)` 为 `0`，除非用户明确接受横向滚动。
- `pageErrors` 为空。
- `responseErrors` 只包含 allowlist 中已解释的噪声。
- 写入型录屏必须有 API 成功或 DB 落库断言。
- 带解说视频必须能被 `ffprobe` 识别出音频流。
  - 当 `--pad-mode freeze`（默认）启用时，输出时长 = 源时长 + 各超时 cue 的 padding 之和，可能 > 100%；要校验 `outputDurationMs` 与 narration-report 里的 `expectedDurationMs` 偏差 ≤ 2% 或 ≤ 500ms（脚本内部已 fail-fast）。
  - 当 `--pad-mode none`，输出时长应等于源时长，且不应短于 98%。
- 带解说视频必须通过非静音校验：`ffmpeg volumedetect` 的 `max_volume` 默认高于 `-50 dB`。
- 视频尺寸、帧率、codec 必须写入 media report；正式桌面录屏默认校验 `1440x900` 或项目约定 viewport。
- 解说稿必须随产物落地，不能只有合成后的音轨。
- 正式交付必须生成标准 16:9 封面 PNG；客户可发版必须生成候选封面 contact sheet，并记录最终封面选择理由。
- 至少抽 1-3 张关键帧做人眼检查，确认字幕没有遮挡主要控件、表单输入、报告正文或导出结果。
- 正式交付或客户可发版必须围绕 caption/chapter 的 `startMs/endMs` 抽取过渡帧，确认没有半截遮罩、位移露出、遮挡关键控件、字体溢出或横幅跳动。
- 录屏结束后停止本地 dev server，不保留端口监听。

## 可接受噪声

- 已知 legacy endpoint 404，且不影响当前流程。
- Sentry、OpenTelemetry、webpack cache warning。
- Next dev HMR warning。

所有噪声必须写进 report 或指南，不要只口头说明。

## 常见失败

### 高亮滞留

根因通常是等待 `locator.click()` 完成后才隐藏高亮。应改为：

1. 短暂展示高亮。
2. 立即清除高亮。
3. 再执行真实 click/fill。
4. finally 中再次清除。

### 页面看似成功但数据没落库

根因通常是只等 URL fallback。写入型流程必须等待对应 POST API `response.ok()`，再允许 URL fallback。

### Next dev manifest 缺失

如果本地 Next dev 频繁报 `.next/routes-manifest.json` 或 `.next/server/app-paths-manifest.json` 缺失：

- 先尝试 `npm run build`。
- 录制时固定 `127.0.0.1`。
- 必要时运行 skill 的 `scripts/ensure-next-dev-manifests.mjs` 类似辅助脚本，持续补齐 dev manifest。

### 字幕遮挡控件

调整字幕到对角位置，缩小宽度，或将字幕写入 sidecar `.vtt/.srt`。不要为了字幕牺牲表单可读性。

### 遮罩只显示一半或出现/收起不丝滑

根因通常是 DOM overlay 用了 `translateY/translateX/scale/clip-path` 做出现/收起动画，录屏采到了动画中间帧。正式交付应改为：

1. 固定 overlay 的最终位置，不做位移、缩放或裁切动画。
2. 只允许短时 `opacity` 变化，或直接瞬时切换。
3. 显示前先写入内容并强制 layout，例如读取一次 `offsetHeight`。
4. 等待 1-2 个 `requestAnimationFrame` 和过渡时间后，再记录 `caption.startMs`。
5. 记录 `caption.endMs` 后再隐藏 overlay，并等待过渡完成。
6. 用 `--write-frame-review` 生成 contact sheet，检查 start/end 前后连续帧。

如果仍有瑕疵，优先改成无动画直接显示，不要加更复杂的动画曲线。

### 封面不像正式产品视频

常见根因：

- 直接使用随机终帧、设置页、loading、登录页或信息过密页面。
- 标题太小，移动端列表页不可读。
- 纯渐变或抽象插画没有产品真实感。
- 客户演示封面出现 mock、fixture、dev warning、内部边界等内部词。

建议修复：

1. 生成 4-6 张候选封面 contact sheet。
2. 优先选择 Home/Dashboard/核心结果页作为真实 UI 主视觉。
3. 输出 1280×720 PNG；公开视频平台可再输出 1920×1080。
4. 左侧放产品名和演示主题，右侧放真实 UI 截图窗口。
5. 背景使用同一抽帧的模糊暗化版本，保证文字对比度。
6. 记录最终选择理由，便于后续重录复用。

### TTS 解说错位或太密

优先使用 `spread` timing 把 report captions 均匀铺到视频长度；如果 report 已有 `startMs/endMs`，使用 `report` timing。解说太密时缩短文案，不要盲目提高语速。

### TTS 比视频段长导致重叠或被截

`add-tts-narration` 默认开启 `--pad-mode freeze`：合成后会用 `ffprobe` 测每段音频时长，若窗口装不下就在原 cue 末尾插入冻结帧，并把后续 cue 的时间轴整体后移。如果你看到：

- 输出视频中某段 TTS 还没读完就被下一段盖住：检查 narration-report 里 `padMode` 是否被覆盖成 `none`，或某段 padding 超过 `--max-padding-ms` 被 fail-fast。
- 单段 padding 超过 60s：通常是文案写太长。优先缩短文案/换成画外简介，不要盲目调高 `--max-padding-ms`。
- 字幕和画面错位：确认 sidecar `.vtt` 用的是 narration-report 里 `cues[].startMs/endMs` 这套延长后的坐标，而不是原 report.captions 的源坐标。

## Report 最小字段

```json
{
  "createdAt": "ISO-8601",
  "baseUrl": "http://127.0.0.1:3210",
  "scenario": "add-data-flow",
  "demoData": {},
  "captions": [],
  "narration": { "enabled": true, "engine": "local-system", "voice": "Tingting" },
  "steps": [
    { "label": "source-basic", "url": "/sources/new/manual", "highlightVisible": false, "overflow": 0 }
  ],
  "consoleMessages": [],
  "pageErrors": [],
  "responseErrors": []
}
```

## 解说视频校验命令

```bash
node <skill>/scripts/validate-recording-report.mjs docs/recordings/add-data-flow-report.json \
  --video docs/recordings/add-data-flow-narrated.mp4 \
  --source-video docs/recordings/add-data-flow.mp4 \
  --narration-report docs/recordings/add-data-flow-narrated-narration-report.json \
  --require-audio \
  --expect-width 1440 \
  --expect-height 960 \
  --write-media-report docs/recordings/add-data-flow-media-report.json \
  --write-frame-review docs/recordings/add-data-flow-frame-review
```
