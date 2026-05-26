# Repo Demo Recorder

`repo-demo-recorder` is a Codex skill for turning local product demos into reproducible recording artifacts: scripted Playwright walkthroughs, realistic demo data, captions, narration, media reports, and frame-review proof.

It is designed for repository-native demo work where a video should be repeatable, reviewable, and safe to share with customers or stakeholders.

## What It Helps With

- Plan a product demo path for customers, internal reviews, QA proof, training, or release PRs.
- Scaffold scenario JSON, a Playwright recorder, and a recording guide.
- Record stable MP4/WebM walkthroughs with open captions and optional sidecar subtitles.
- Add TTS narration with automatic freeze-frame padding when speech is longer than the original cue window.
- Generate standard video covers from real recording frames: 16:9 for desktop demos, 9:16 for mobile demos, including candidate contact sheets.
- Validate page errors, response errors, horizontal overflow, audio presence, audio volume, video dimensions, and narration timing.
- Generate frame-review contact sheets around caption/chapter transitions so overlays do not look half-rendered or unprofessional.
- Generate a local review HTML page that brings together video, captions, cover candidates, frame review, and quality reports.
- Apply conservative post-production presets, or prepare a Screen Studio handoff pack for professional zoom/cursor/timeline polish.

## Install

Clone this repository and install the skill into Codex:

```bash
git clone https://github.com/Octo-o-o-o/repo-demo-recorder.git
cd repo-demo-recorder
node scripts/install-skill.mjs --force
```

By default this installs to:

```text
$CODEX_HOME/skills/repo-demo-recorder
```

or, when `CODEX_HOME` is not set:

```text
~/.codex/skills/repo-demo-recorder
```

To install somewhere else:

```bash
node scripts/install-skill.mjs --dest /path/to/skills/repo-demo-recorder --force
```

## Requirements

- Node.js 18+
- `ffmpeg` and `ffprobe`
- Playwright available in the target repository when running generated recorder scripts
- Optional for local narration: macOS `say`
- Optional for higher-quality online narration: `uvx` with `edge-tts`

## Basic Usage

Ask Codex to use the skill, for example:

```text
Use repo-demo-recorder to create a customer-ready narrated demo for this project.
```

Or scaffold the recording artifacts yourself:

```bash
node ~/.codex/skills/repo-demo-recorder/scripts/scaffold-repo-demo.mjs \
  --root . \
  --name customer-demo \
  --audience customer \
  --polish customer-ready \
  --flows core,add-data \
  --base-url http://127.0.0.1:3210 \
  --subtitles both
```

For a pure mobile product, or the mobile part of a multi-surface product, scaffold a separate portrait recording:

```bash
node ~/.codex/skills/repo-demo-recorder/scripts/scaffold-repo-demo.mjs \
  --root . \
  --name mobile-customer-demo \
  --surface mobile \
  --audience customer \
  --polish customer-ready \
  --flows mobile \
  --base-url http://127.0.0.1:3210 \
  --subtitles both
```

Then edit:

- `docs/recordings/customer-demo.scenario.json`
- `scripts/recordings/customer-demo.mjs`
- `docs/recordings/RECORDING_GUIDE.md`

Run the generated recorder:

```bash
node scripts/recordings/customer-demo.mjs
```

Add narration:

```bash
node ~/.codex/skills/repo-demo-recorder/scripts/add-tts-narration.mjs \
  --video docs/recordings/customer-demo.mp4 \
  --report docs/recordings/customer-demo-report.json \
  --out docs/recordings/customer-demo-narrated.mp4 \
  --engine edge-tts \
  --voice zh-CN-YunyangNeural \
  --pad-mode freeze \
  --pad-buffer-ms 300
```

Validate the final video and generate frame-review images:

```bash
node ~/.codex/skills/repo-demo-recorder/scripts/validate-recording-report.mjs \
  docs/recordings/customer-demo-report.json \
  --video docs/recordings/customer-demo-narrated.mp4 \
  --source-video docs/recordings/customer-demo.mp4 \
  --narration-report docs/recordings/customer-demo-narrated-narration-report.json \
  --require-audio \
  --expect-width 1440 \
  --expect-height 960 \
  --write-media-report docs/recordings/customer-demo-media-report.json \
  --write-frame-review docs/recordings/customer-demo-frame-review
```

Review:

```text
docs/recordings/customer-demo-frame-review/contact-sheet.png
```

Generate a standard cover:

```bash
node ~/.codex/skills/repo-demo-recorder/scripts/generate-video-cover.mjs \
  --video docs/recordings/customer-demo-narrated.mp4 \
  --report docs/recordings/customer-demo-report.json \
  --out docs/recordings/customer-demo-cover.png \
  --title "Product Demo" \
  --subtitle "Customer-ready product walkthrough" \
  --candidates-dir docs/recordings/customer-demo-cover-candidates
```

Generate a mobile portrait cover:

```bash
node ~/.codex/skills/repo-demo-recorder/scripts/generate-video-cover.mjs \
  --video docs/recordings/mobile-customer-demo-narrated.mp4 \
  --report docs/recordings/mobile-customer-demo-report.json \
  --out docs/recordings/mobile-customer-demo-cover.png \
  --title "Mobile Product Demo" \
  --subtitle "Mobile product walkthrough" \
  --width 1080 \
  --height 1920 \
  --theme mobile \
  --candidates-dir docs/recordings/mobile-customer-demo-cover-candidates
```

Review:

```text
docs/recordings/customer-demo-cover-candidates/contact-sheet.png
```

Generate a review page:

```bash
node ~/.codex/skills/repo-demo-recorder/scripts/generate-review-page.mjs \
  --report docs/recordings/customer-demo-report.json \
  --video docs/recordings/customer-demo-narrated.mp4 \
  --media-report docs/recordings/customer-demo-media-report.json \
  --cover docs/recordings/customer-demo-cover.png \
  --cover-candidates docs/recordings/customer-demo-cover-candidates \
  --frame-review docs/recordings/customer-demo-frame-review \
  --out docs/recordings/customer-demo-review.html
```

Apply a conservative customer-ready packaging preset:

```bash
node ~/.codex/skills/repo-demo-recorder/scripts/polish-video.mjs \
  --video docs/recordings/customer-demo-narrated.mp4 \
  --out docs/recordings/customer-demo-polished.mp4 \
  --preset customer-desktop
```

Prepare assets for Screen Studio when the final video needs manual zooms, cursor smoothing, device frames, or timeline polish:

```bash
node ~/.codex/skills/repo-demo-recorder/scripts/prepare-screen-studio-handoff.mjs \
  --out docs/recordings/customer-demo-screen-studio-handoff \
  --target desktop \
  --raw-video docs/recordings/customer-demo.mp4 \
  --narrated-video docs/recordings/customer-demo-narrated.mp4 \
  --report docs/recordings/customer-demo-report.json \
  --vtt docs/recordings/customer-demo-narrated-narration.vtt \
  --cover docs/recordings/customer-demo-cover.png
```

## Demo Quality Defaults

For customer-ready demos, the skill now defaults toward:

- Customer-value narration instead of internal implementation language.
- Segmented recording and per-segment review before merging.
- Stable overlay behavior: no `translateY`, `scale`, or `clip-path` transitions for captions or chapter banners.
- Caption timing that starts only after overlays have settled.
- TTS freeze-frame padding so narration is not clipped.
- Media validation plus transition frame review.
- A standard cover using a real product frame, readable title text, and candidate review.
- Mobile demos use a 390x844 phone viewport, 1080x1920 portrait video, bottom safe-area captions, and a 1080x1920 cover.
- Review HTML by default for formal delivery, so each segment can be approved or rerecorded with less back-and-forth.
- Conservative polish presets in the skill; Screen Studio handoff for subjective editor work such as motion blur, cursor smoothing, manual zoom blending, webcam layouts, and device-frame tweaks.

## Command Reference

```bash
node scripts/scaffold-repo-demo.mjs --help
node scripts/add-tts-narration.mjs --help
node scripts/generate-video-cover.mjs --help
node scripts/generate-review-page.mjs --help
node scripts/polish-video.mjs --help
node scripts/prepare-screen-studio-handoff.mjs --help
node scripts/validate-recording-report.mjs --help
node scripts/install-skill.mjs --help
node scripts/check-skill.mjs
```

Use `--help` for script-specific options. The scripts intentionally fail fast when required inputs are missing.

## Repository Layout

```text
repo-demo-recorder/
  SKILL.md
  agents/openai.yaml
  references/
    options.md
    quality-gates.md
    scenario-schema.md
  scripts/
    scaffold-repo-demo.mjs
    add-tts-narration.mjs
    generate-video-cover.mjs
    generate-review-page.mjs
    polish-video.mjs
    prepare-screen-studio-handoff.mjs
    validate-recording-report.mjs
    install-skill.mjs
    check-skill.mjs
```

## Development

Run the skill self-check:

```bash
npm run check
```

This validates required files, script syntax, and a scaffold smoke test.

## License

MIT
