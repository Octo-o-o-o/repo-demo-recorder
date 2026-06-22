# 常用命令参考

`<skill>` 指 skill 安装路径（如 `~/.codex/skills/repo-demo-recorder` 或 `~/.claude/skills/repo-demo-recorder`）。在目标项目根目录执行。完整参数用 `--help` 查看。

## 0. 准备录制 worktree（推荐）

```bash
node <skill>/scripts/prepare-recording-worktree.mjs \
  --root . \
  --name add-data-flow
```

输出最后一行是 JSON（含 `worktreePath`、`linkedPaths`、`gitExclude` 等），按提示 `cd <worktreePath>` 之后所有命令的 `--root` 改成 `.` 即可。

主工作树有未提交改动时，默认只警告不阻断。需要把改动一并带进 worktree：

```bash
node <skill>/scripts/prepare-recording-worktree.mjs \
  --root . \
  --name add-data-flow \
  --include-uncommitted
```

prepare 默认会软链 `node_modules` / `.env` / `.env.local` / `.env.development*` / `.env.test*`，并默认跳过 `.env.production*`。生产录制必须先确认授权，再显式 `--link .env.production.local`。要追加其它路径（例如 framework cache）：

```bash
node <skill>/scripts/prepare-recording-worktree.mjs \
  --root . \
  --name add-data-flow \
  --link .next \
  --link .vite
```

录完后回收：

```bash
node <skill>/scripts/cleanup-recording-worktree.mjs --worktree <worktreePath>
```

默认拷回 `docs/recordings/` 和 `scripts/recordings/`。如果改了 `--out`，补 `--copy <relPath>`：

```bash
node <skill>/scripts/cleanup-recording-worktree.mjs \
  --worktree <worktreePath> \
  --copy docs/customer-demos \
  --copy-mode overwrite
```

`--keep` 留住 worktree 调试；调好后再不带 `--keep` 跑一次正式收尾。

## 1. 生成场景骨架

先显式选择数据来源：本地安全演示用 `--data-mode mock`，staging 演示账号用 `--data-mode staging`，真实生产数据必须同时加 `--data-mode production --allow-production`。

桌面端通用走查：

```bash
node <skill>/scripts/scaffold-repo-demo.mjs \
  --root . \
  --name add-data-flow \
  --data-mode mock \
  --language zh-CN \
  --subtitles open \
  --flows core,add-data
```

移动端竖屏客户演示：

```bash
node <skill>/scripts/scaffold-repo-demo.mjs \
  --root . \
  --name mobile-demo \
  --surface mobile \
  --language zh-CN \
  --subtitles both \
  --data-mode mock \
  --flows mobile \
  --audience customer \
  --polish customer-ready
```

scaffold 会自动从 `package.json` / `tauri.conf.json` / `vite.config.*` / `next.config.*` 探测 baseUrl 与 dev command；可用 `--base-url` 覆盖。

## 2. 录制

```bash
node scripts/recordings/<name>.mjs
```

runner 自动起 dev server（`server.command`）、按 `flow.steps` 操作浏览器、收集 caption/step/console/pageError/response 进 report。

## 3. 加 TTS 解说

```bash
node <skill>/scripts/add-tts-narration.mjs \
  --video docs/recordings/add-data-flow.mp4 \
  --report docs/recordings/add-data-flow-report.json \
  --out docs/recordings/add-data-flow-narrated.mp4 \
  --language zh-CN \
  --engine edge-tts \
  --voice zh-CN-YunyangNeural \
  --pad-mode freeze \
  --pad-buffer-ms 300
```

`--engine edge-tts` 需要 `uvx` 和网络（会把文本发到 Microsoft Edge online TTS）。离线时改 `--engine macos-say`，voice 不存在会自动 fallback。

## 4. 多段合并与段间子封面

如果最终视频由多段录制片段组成，先逐段录制、逐段审片、逐段加 TTS，然后合并。只有 2 段及以上时会插入低强度段间子封面；只有 1 段时脚本会直接复制输出，不加中间转场。

```bash
node <skill>/scripts/assemble-segmented-video.mjs \
  --out docs/recordings/full-walkthrough-narrated.mp4 \
  --segment docs/recordings/core-narrated.mp4 \
  --segment-title "核心浏览路径" \
  --segment-report docs/recordings/core-report.json \
  --segment docs/recordings/add-data-narrated.mp4 \
  --segment-title "新增数据流程" \
  --segment-report docs/recordings/add-data-report.json \
  --transition-duration-ms 1100 \
  --report docs/recordings/full-walkthrough-assemble-report.json \
  --combined-report docs/recordings/full-walkthrough-report.json
```

子封面会使用下一段视频的真实抽帧作为背景，并沿用主封面的色彩/字体，但只显示「接下来」、下一段标题和一句短提示，视觉层级低于片头主封面。合并后的 `full-walkthrough-report.json` 会把原分段 report 的时间轴整体平移，并把子封面写成 `kind: "transition"`、`narration: false` 的 cue，便于 frame review 抽帧检查。

## 5. 生成封面（含候选 contact sheet）

桌面 16:9：

```bash
node <skill>/scripts/generate-video-cover.mjs \
  --video docs/recordings/add-data-flow-narrated.mp4 \
  --report docs/recordings/add-data-flow-report.json \
  --out docs/recordings/add-data-flow-cover.png \
  --title "产品演示" \
  --subtitle "面向客户的可发版走查" \
  --candidates-dir docs/recordings/add-data-flow-cover-candidates
```

移动 9:16：

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

Playwright 不可用时自动退化到 ffmpeg drawtext 或纯抽帧（详见 README）。

## 6. 嵌入封面 + 删空白

```bash
node <skill>/scripts/embed-video-cover.mjs \
  --video docs/recordings/add-data-flow-narrated.mp4 \
  --cover docs/recordings/add-data-flow-cover.png \
  --out docs/recordings/add-data-flow-narrated.mp4 \
  --intro-duration-ms 2000 \
  --narration-report docs/recordings/add-data-flow-narrated-narration-report.json \
  --narration-vtt docs/recordings/add-data-flow-narrated-narration.vtt \
  --report docs/recordings/add-data-flow-cover-embed-report.json
```

```bash
node <skill>/scripts/trim-video-gap.mjs \
  --video docs/recordings/add-data-flow-narrated.mp4 \
  --cover docs/recordings/add-data-flow-cover.png \
  --out docs/recordings/add-data-flow-narrated.mp4 \
  --remove-start-ms 2000 \
  --remove-end-ms 8500 \
  --narration-report docs/recordings/add-data-flow-narrated-narration-report.json \
  --narration-vtt docs/recordings/add-data-flow-narrated-narration.vtt \
  --report docs/recordings/add-data-flow-gap-trim-report.json
```

## 7. 质量门禁 + 审片页

```bash
node <skill>/scripts/validate-recording-report.mjs \
  docs/recordings/add-data-flow-report.json \
  --video docs/recordings/add-data-flow-narrated.mp4 \
  --source-video docs/recordings/add-data-flow.mp4 \
  --narration-report docs/recordings/add-data-flow-narrated-narration-report.json \
  --require-audio \
  --require-cover-art \
  --expect-width 1440 \
  --expect-height 960 \
  --write-media-report docs/recordings/add-data-flow-media-report.json \
  --write-frame-review docs/recordings/add-data-flow-frame-review
```

`qualityGates.allowedResponseErrors / allowedConsoleErrors / allowPageErrors / requireApiSuccess / requireDbAssertions` 会自动从 report 中读取，不需要再传 CLI flag。

```bash
node <skill>/scripts/generate-review-page.mjs \
  --report docs/recordings/add-data-flow-report.json \
  --video docs/recordings/add-data-flow-narrated.mp4 \
  --media-report docs/recordings/add-data-flow-media-report.json \
  --cover docs/recordings/add-data-flow-cover.png \
  --cover-candidates docs/recordings/add-data-flow-cover-candidates \
  --frame-review docs/recordings/add-data-flow-frame-review \
  --out docs/recordings/add-data-flow-review.html
```

## 8. 包装 / Screen Studio 交接

```bash
node <skill>/scripts/polish-video.mjs \
  --video docs/recordings/add-data-flow-narrated.mp4 \
  --out docs/recordings/add-data-flow-polished.mp4 \
  --preset customer-desktop
```

```bash
node <skill>/scripts/prepare-screen-studio-handoff.mjs \
  --out docs/recordings/add-data-flow-screen-studio-handoff \
  --target desktop \
  --raw-video docs/recordings/add-data-flow.mp4 \
  --narrated-video docs/recordings/add-data-flow-narrated.mp4 \
  --report docs/recordings/add-data-flow-report.json \
  --vtt docs/recordings/add-data-flow-narrated-narration.vtt \
  --cover docs/recordings/add-data-flow-cover.png
```
