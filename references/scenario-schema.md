# 场景配置结构

场景文件建议保存为 `docs/recordings/<name>.scenario.json` 或 `docs/recordings/<name>.scenario.yaml`。

## 顶层字段

```json
{
  "name": "add-data-flow",
  "title": "新增数据流程录屏",
  "baseUrl": "http://127.0.0.1:3210",
  "language": "zh-CN",
  "subtitles": "open",
  "audience": "customer",
  "polish": "formal-delivery",
  "surface": "desktop",
  "primarySurface": "desktop",
  "surfaces": {
    "desktop": {
      "viewport": { "width": 1440, "height": 960 },
      "videoSize": { "width": 1440, "height": 960 },
      "isMobile": false,
      "hasTouch": false,
      "deviceScaleFactor": 1
    }
  },
  "narrative": {
    "angle": "customer-value",
    "avoidVisibleTerms": ["mock", "fixture", "renderer-only", "内部边界"],
    "defaultCaptionPattern": "客户价值 + 可控机制"
  },
  "narration": {
    "enabled": true,
    "provider": "auto",
    "engine": "edge-tts",
    "language": "zh-CN",
    "voice": "zh-CN-YunyangNeural",
    "rate": 180,
    "mix": "replace",
    "timing": "auto",
    "padMode": "freeze",
    "padBufferMs": 300,
    "maxPaddingMs": 60000
  },
  "style": "sales-demo",
  "viewport": { "width": 1440, "height": 960 },
  "recording": {
    "videoSize": { "width": 1440, "height": 960 },
    "orientation": "landscape"
  },
  "device": {
    "isMobile": false,
    "hasTouch": false,
    "deviceScaleFactor": 1,
    "userAgent": null
  },
  "overlay": {
    "animation": "safe-opacity",
    "settleMs": 160,
    "chapterBanner": true,
    "chapterPosition": "top-center",
    "captionPosition": "bottom-left"
  },
  "cover": {
    "enabled": true,
    "mode": "with-candidates",
    "width": 1280,
    "height": 720,
    "title": "产品演示",
    "subtitle": "面向客户的可发版走查",
    "line": "新增数据流程",
    "badge": "客户演示",
    "timestamp": "auto"
  },
  "segmentation": {
    "enabled": true,
    "reviewEachSegment": true,
    "mergeAfterPass": true,
    "rerecordOnFailure": true,
    "transitionCover": {
      "enabled": "auto",
      "durationMs": 2400,
      "fadeInMs": 180,
      "fadeOutMs": 380,
      "style": "subtle-subcover",
      "label": "接下来"
    }
  },
  "preflight": {
    "steps": []
  },
  "auth": {
    "mode": "dev-login-or-storage-state",
    "storageState": null,
    "endpoint": null,
    "payload": null
  },
  "data": {
    "mode": "mock",
    "strategy": "ui-write",
    "cleanup": true,
    "backupCommand": null,
    "seedCommand": null,
    "demoPrefix": "演示",
    "productionWarning": null
  },
  "server": {
    "command": "npm run dev",
    "healthPath": "/",
    "startupTimeoutMs": 120000
  },
  "outputs": {
    "dir": "docs/recordings",
    "mp4": true,
    "webm": true,
    "report": true,
    "finalScreenshot": true,
    "sidecarSubtitles": false,
    "narratedMp4": true,
    "narrationTranscript": true,
    "mediaReport": true,
    "reviewPage": true,
    "polishedMp4": false,
    "screenStudioHandoff": false,
    "coverImage": true,
    "coverCandidates": true,
    "coverIntro": true,
    "coverEmbedReport": true,
    "gapTrimReport": true,
    "assembledMp4": true,
    "assemblyReport": true,
    "segmentTransitionCovers": true
  },
  "postProduction": {
    "polishPreset": "customer-desktop",
    "screenStudioTarget": "desktop",
    "useScreenStudioFor": []
  },
  "review": {
    "writeFrameReview": true,
    "frameReviewDir": "docs/recordings/add-data-flow-frame-review",
    "sampleCueKinds": ["chapter", "caption"],
    "sampleOffsetsMs": [-220, -80, 80, 220]
  },
  "qualityGates": {
    "maxOverflow": 0,
    "allowPageErrors": false,
    "allowedResponseErrors": [],
    "allowedConsoleErrors": [],
    "requireApiSuccess": true,
    "requireDbAssertions": false,
    "media": {
      "requireAudio": true,
      "minDurationRatio": 0.98,
      "maxDurationRatio": null,
      "minAudioMaxDb": -50,
      "expectWidth": 1440,
      "expectHeight": 960
    }
  },
  "flows": []
}
```

## Audience / Narrative 字段

- `audience`: `customer`、`internal-review`、`qa-proof`、`training`、`release-pr`。
- `polish`: `quick-proof`、`formal-delivery`、`customer-ready`。
- `narrative.angle`: `customer-value` 时，caption 和 narration 应先说明客户收益，再说明机制；内部实现词放进 report/guide，不进入画面。
- `narrative.avoidVisibleTerms`: 用于人工或脚本 review，避免客户可见字幕/旁白出现内部词。

## Surface / Recording 字段

- `surface`: 当前场景的主端类型，常用 `desktop`、`mobile`、`tablet`、`multi`。
- `primarySurface`: 当前脚本实际录制的端类型。多端项目建议分别生成桌面和手机两个脚本，不把横屏桌面和竖屏手机硬拼成一个主视频。
- `surfaces`: 端类型预设表。脚本会优先读取 `surfaces[primarySurface]` 的 viewport、视频尺寸和设备仿真参数。
- `viewport`: 页面实际渲染尺寸。手机端默认 `390x844`。
- `recording.videoSize`: Playwright 录屏输出尺寸。桌面默认 `1440x960`；手机默认 `1080x1920`。
- `recording.orientation`: `landscape` 或 `portrait`，用于封面、字幕和质量门禁。
- `device`: Playwright context 的移动端仿真参数；手机端应启用 `isMobile`、`hasTouch` 和合适的 `deviceScaleFactor/userAgent`。

手机版示例：

```json
{
  "surface": "mobile",
  "primarySurface": "mobile",
  "viewport": { "width": 390, "height": 844 },
  "recording": {
    "videoSize": { "width": 1080, "height": 1920 },
    "orientation": "portrait"
  },
  "device": {
    "isMobile": true,
    "hasTouch": true,
    "deviceScaleFactor": 3
  }
}
```

## Overlay 字段

- `animation=safe-opacity`：固定位置，只做短时透明度变化；显示稳定后再记录 caption 时间。正式交付默认。
- `animation=instant`：直接显示/隐藏，适合 QA 证据。
- `animation=motion`：允许位移动画，仅用于草稿；客户可发版不要使用。
- `chapterBanner=true`：模块切换时增加更显眼的章节横幅。横幅文案应表达价值而不是实现细节。

## Segmentation 字段

长 demo 推荐启用分段录制：

- 每段输出独立 MP4/WebM/VTT/report/review。
- 每段通过后再继续下一段。
- 某段失败时只重录该段。
- 全部通过后再合并，合并后重新做媒体校验和抽帧复查。
- `transitionCover.enabled="auto"`：只有 2 段及以上时在段间插入子封面；1 段时不加。
- `transitionCover.durationMs`：段间子封面时长，默认约 2400ms。客户可发版一般保持 2000-2500ms，中文标题较长、需要观众理解章节目标时可以继续加长。
- `transitionCover.fadeInMs` / `fadeOutMs`：段间子封面淡入/淡出时长，默认短淡入和柔和淡出，避免章节卡一闪而过。
- 子封面用于提示下一段标题，必须沿用主封面的真实录屏抽帧、色彩和字体，但标题更小、文案更短、无强 badge，让它看起来像同一条视频里的转场。

## PostProduction 字段

- `outputs.reviewPage=true`：正式交付建议生成 `<name>-review.html`，集中检查视频、字幕、封面、质量门禁和抽帧。
- `outputs.polishedMp4=true`：生成基础包装版 MP4。适合统一背景、尺寸、padding、社媒/客户导出 preset。
- `outputs.screenStudioHandoff=true`：生成 Screen Studio 交接包，不代表最终视频由 skill 自动美化。
- `postProduction.polishPreset`: `customer-desktop`、`customer-mobile`、`social-mobile`、`qa-proof`、`readme-gif`。
- `postProduction.screenStudioTarget`: `desktop`、`mobile`、`social`、`training`，用于 handoff 文档里的推荐设置。
- `postProduction.useScreenStudioFor`: 说明哪些效果交给 Screen Studio，例如 manual zoom、cursor smoothing、device frame、timeline edits。

推荐边界：skill 做可复现录制、审片、字幕、封面、基础包装；Screen Studio 做自然缩放、光标平滑、motion blur、设备模型、摄像头布局、音乐和主观剪辑。

## Cover 字段

- `enabled=true`：正式交付默认生成封面。
- `mode=standard`：直接生成最终封面。
- `mode=with-candidates`：生成候选封面 contact sheet，再输出最终封面。客户可发版推荐。
- `width/height`：桌面默认 1280×720，保持 16:9；手机默认 1080×1920，保持 9:16。
- `timestamp=auto`：从 report 中优先选择 Home/Dashboard/工作台相关 cue；否则取视频前 22% 左右的画面。也可显式传 `00:00:36`。
- `title/subtitle/line/badge`：客户可见文案；客户演示不要出现 mock/fixture/dev warning 等内部词。

标准客户封面应该用真实录屏抽帧作为主视觉。桌面封面默认左侧保留清晰标题、右侧展示产品 UI；手机封面默认顶部标题、中部手机 UI、底部价值短句。不要用设置页、登录页、loading 或信息过密页面做默认封面。

## Flow 字段

```json
{
  "id": "create-source",
  "surface": "desktop",
  "route": "/sources/new/manual",
  "caption": {
    "title": "新增数据源",
    "body": "配置招投标监控平台、关键词、地区和频率。",
    "durationMs": 3600,
    "narration": "这里配置招投标监控平台、关键词、地区和频率，后续系统会按这些条件自动归集公告。"
  },
  "steps": [
    {
      "type": "fill",
      "selector": "#sourceName",
      "value": "演示·政务云招标监控",
      "caption": "使用面向业务的名称，方便团队在列表中识别。"
    },
    {
      "type": "click",
      "selector": "button[type=submit]",
      "waitForApi": { "method": "POST", "path": "/api/sources", "ok": true },
      "waitForUrl": "/sources"
    }
  ],
  "assertions": [
    { "type": "text", "value": "演示·政务云招标监控" },
    { "type": "db", "model": "source", "where": { "sourceName": "$demo.sourceName" } }
  ]
}
```

## Step 类型

- `goto`：导航。可加 `step.waitUntil`（默认 `domcontentloaded`，不推荐 `networkidle`，Next.js/Tauri 等 HMR 项目可能永远不 idle）。
- `caption`：只显示字幕并停留。
- `chapter`：模块切换横幅。
- `click`：高亮、清除高亮、点击。可加 `waitForApi: { method, path, ok, timeoutMs }`，命中后自动追加到 `report.apiAssertions[]`，配合 `qualityGates.requireApiSuccess` 校验。
- `fill`：高亮、清除高亮、输入。
- `select`：Radix/native select。
- `scroll`：滚动。
- `wait`：等待固定时间或 selector/API/URL。
- `screenshot`：关键帧截图。
- `assert`：运行页面文本断言。
- `db`：执行 DB 落库断言（详见下方）。

## Step `waitForApi`

`{ method, path, ok, timeoutMs }`。runner 自动 `await page.waitForResponse(...)`，命中后追加到 `report.apiAssertions[]`：

```json
{ "label": "create-source-5-click", "method": "POST", "path": "/api/sources", "url": "...", "status": 201, "ok": true, "atMs": 12345 }
```

`qualityGates.requireApiSuccess=true` 时，validate 检查 `report.apiAssertions[].ok=true` 至少有一条。

## Step / Assertion `type: "db"`

runner 不会自动连数据库。你在 scenario 里指向项目内一个 `async (params) => boolean | { ok, detail }` 函数：

```json
{
  "type": "db",
  "module": "scripts/recordings/assert-source.mjs",
  "exportName": "default",
  "params": { "sourceName": "演示·政务云招标监控" }
}
```

`module` 是相对于 `projectRoot` 的相对路径；`exportName` 省略时取 `default`。函数可以用 Prisma、Drizzle、Knex、原生 `pg` 等任意客户端。结果会追加到 `report.dbAssertions[]`；`qualityGates.requireDbAssertions=true` 时检查至少一条 `ok=true`。

scaffold 默认把 `requireDbAssertions=false`，因为多数项目首次跑时还没写过 DB assert module；只有你在 step 里加了 `type: "db"` 节点并希望 fail-fast，再手动改成 true。

## Narration 字段

caption 或 step 可以加 `narration` 覆盖解说文案。没有该字段时，TTS 脚本默认使用 `title + body`。需要跳过某条字幕时设置 `"narration": false`。

`scenario.narration.provider` 记录 scaffold 时的选择：`auto`、`macos-say`、`local-system`、`edge-tts` 或 `doubao-tts-v3`。真正驱动合成的是 `engine` / `voice`；`provider=auto` 会按观众类型解析为客户版 `edge-tts`、其它场景 macOS 本机语音。声音可以在 scaffold 时用 `--tts-voice <voice>` 写入，也可以录制前直接改 `scenario.narration.voice`。

豆包/火山 TTS v3 示例（不要把 key 写进 scenario）：

```json
{
  "narration": {
    "enabled": true,
    "provider": "doubao-tts-v3",
    "engine": "doubao-tts-v3",
    "language": "zh-CN",
    "voice": "zh_female_jitangmei_uranus_bigtts",
    "doubaoEndpoint": "wss://openspeech.bytedance.com/api/v3/tts/bidirection",
    "doubaoResourceId": "seed-tts-2.0",
    "doubaoModel": "seed-tts-2.0-expressive",
    "doubaoSampleRate": 24000,
    "doubaoBitRate": 128000,
    "doubaoSpeechRate": 0,
    "doubaoLoudnessRate": 20,
    "padMode": "freeze",
    "padBufferMs": 300
  }
}
```

运行时用 `DOUBAO_TTS_API_KEY` 或 `VOLCENGINE_TTS_API_KEY` 提供凭据。不要把 key 写进 scenario；本地推荐用不回显 prompt 临时导出，合成后 `unset`。共享机器上尽量不要用 `--doubao-api-key`，因为命令行可能进入 shell history 或进程列表。

## Media report 字段

带 TTS 或正式交付录屏应输出 media report，并至少包含：

```json
{
  "source": { "durationSeconds": 72.4, "video": { "width": 1440, "height": 960 } },
  "output": {
    "durationSeconds": 72.4,
    "audioStreams": 1,
    "audioVolume": { "meanVolumeDb": -24.1, "maxVolumeDb": -5.8 }
  },
  "durationRatio": 1
}
```

媒体校验失败时不要只重跑合成命令；先检查 report captions 是否过密、TTS voice 是否可用、音频是否被错误 mute、输出是否被 `-t` 截短、竖屏场景是否仍被错误导出为横屏，以及 narration-report 中的 `timeline.totalPaddingMs` 是否触发了冻结帧扩展（如果是，源视频时长 ≠ 输出时长，校验时要用 `expectedDurationMs`）。TTS 脚本生成的 `cues[].endMs` 应覆盖该段真实语音时长与 `padBufferMs`，不能停留在原始字幕的短时长。

## 断言要求

写入型步骤必须至少满足一个：

- `waitForApi.ok=true`
- `waitForUrl`
- `db` 断言

否则不允许把录屏标记为成功。
