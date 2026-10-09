---
name: academy-video-pipeline
description: Programmatic HTML→video generation for explainer and course content, backed by HeyGen HyperFrames. Author a composition as a single HTML file (GSAP/anime.js timelines, captions, voiceovers, audio-reactive visuals) and render it to a real MP4/WebM/MOV/GIF locally with headless Chrome + ffmpeg — no manual ffmpeg zoompan pipeline, no cloud render. Use this to build title cards, faceless explainers, slideshows, product/launch videos, motion graphics, and captioned clips.
version: 1.0.0
author: Zouroboros
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Zouroboros, Video, HyperFrames, Explainer, Motion Graphics]
    related_skills: [hyperframes, heygen-video, smart-money]
prerequisites:
  commands: [node, npx, ffmpeg]
---

# Academy Video Pipeline (HyperFrames)

Replaces a hand-rolled ffmpeg-zoompan + text-to-speech stills pipeline for
explainer and course content. You write **HTML**, HyperFrames renders
**video**. HyperFrames is Apache-2.0 and runs fully locally.

## Environment

Validated on Linux without Docker (2026-06):

- Node + `npx hyperframes@latest` (pinned via npx, no global install needed)
- Headless Chrome is auto-detected (chrome-headless-shell); `ffmpeg`/`ffprobe` must be present
- A 3s 1080p30 composition renders in about 10s wall time at `-q draft` with 3 workers
- `doctor` reports Docker and whisper-cpp as missing. Neither is needed for local
  rendering: whisper-cpp only powers `transcribe`, and TTS uses Kokoro-82M.

When the host already has Chrome or Chromium, export `PUPPETEER_SKIP_DOWNLOAD=1`
so npx doesn't fetch its own copy.

## Quick render (the validated path)

```bash
export PUPPETEER_SKIP_DOWNLOAD=1

# 1. Scaffold a project (blank starter; --skip-skills keeps it lean)
npx -y hyperframes@latest init my-video --non-interactive --example blank --skip-skills

# 2. Author the composition by editing my-video/index.html
#    - #root carries data-duration / data-width / data-height (1920x1080)
#    - each .clip is positioned; window.__timelines["main"] drives GSAP
#    - gsap is loaded from CDN in the scaffolded <head>

# 3. Validate, then render
cd my-video
npx -y hyperframes@latest lint
npx -y hyperframes@latest render -q draft -o renders/test.mp4   # draft | standard | high
```

Output is a real H.264 MP4 (verify with `ffprobe`). Other formats:
`--format webm|mov|gif|png-sequence`. Tune with `-f/--fps`, `-w/--workers`,
`-q/--quality`.

## When to use which orchestration skill

For anything beyond a single title card, use the multi-step HyperFrames skills.
In Hermes, the optional `hyperframes` skill covers the CLI. The vendor skill set
ships in the HyperFrames repository (`heygen-com/hyperframes`, `skills/`); its
skills cross-reference each other with relative paths, so run them from a clone.
For explainer content:

- **faceless-explainer**: text → narrated faceless explainer (30–90s sweet
  spot, every visual invented). The primary skill for explainer content.
- **slideshow**: deck-style sequences.
- Also shipped: general-video, embedded-captions, graphic-overlays,
  motion-graphics, music-to-video, product-launch-video, website-to-video,
  pr-to-video, hyperframes-animation/creative/media/cli.

If the route is unclear, read the vendor `hyperframes` router skill first.

## Security posture

The HyperFrames repository is a third-party plugin marketplace. Before first use
of any vendor skill, review it as untrusted code: read its `SKILL.md` and
scripts, check what it executes and fetches, and confirm with the user before
running it. Re-review after every update.

For a presenter-led (avatar) video instead of a composed one, use `heygen-video`.

## Underlying tool

- CLI: `npx -y hyperframes@latest <cmd>` (init, lint, render, preview, doctor,
  inspect, transcribe, tts, capture, publish).
- Source: `heygen-com/hyperframes` (Apache-2.0).
- Docs: hyperframes.heygen.com
