---
name: smart-money
description: End-to-end pipeline for a faceless finance-education video channel. Turns strategy backtests and market data into a narrated, captioned video package (script, humanized narration, visuals, assembled video, title/description/tags) ready for review and upload. Use when producing finance explainer videos from research output.
version: 1.0.0
author: Zouroboros
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Zouroboros, Video, Finance, YouTube, Content Pipeline]
    related_skills: [humanizer, academy-video-pipeline, heygen-video, tradingview-mcp-server]
---

# Smart Money

Content pipeline for a faceless finance-education video channel. It converts
financial research, backtests and market data into complete video packages
for human review before upload.

## Pipeline

1. **Research**: pull strategy backtest results or market data (for example
   via `tradingview-mcp-server` screens). Record sources and as-of dates.
2. **Narration**: draft the narration script, then run it through the
   `humanizer` skill.
3. **Visuals**: create charts and supporting imagery. Prefer charts rendered
   from the actual data over generated imagery for anything numeric.
4. **Assembly**: package narration and visuals into the final video, for example
   with `academy-video-pipeline` (HyperFrames) or a presenter via `heygen-video`.
5. **Metadata**: generate the title, description and tags.

## Output structure

Each run writes a timestamped folder under the workspace (for example
`$ZOUROBOROS_WORKSPACE/smart-money/output/<timestamp>/`), never inside the
skill directory:

- `narration-raw.txt`: initial narration
- `narration-humanized.txt`: after the humanizer pass
- `narration.txt`: final approved narration
- `description.txt`: video description
- `tags.txt`: tags
- `manifest.json`: run metadata (sources, as-of dates, model and voice used)
- `final.mp4`: assembled video

## Content rules

- Educational content only. Every video and description carries a clear
  "not financial advice" disclaimer, and states that backtested results are
  hypothetical and do not guarantee future returns.
- Never present a specific buy/sell instruction or price target as advice.
  Show risk (drawdown, stop-loss levels) alongside every return figure.
- Cite data sources and as-of dates in the description.
- A human reviews and approves each package before upload. The pipeline never
  publishes on its own.

## Persona

The channel voice is set per deployment, for example a confident, data-driven
narrator. Keep the persona definition (name, voice ID, tuning) in the
deployment's own configuration, not in this skill.

## Configuration

Read credentials from the environment or the host's secret store. Never commit
values. Variables, all optional unless the step is used:

| Variable | Used for |
| --- | --- |
| `ELEVENLABS_API_KEY` | Narration TTS |
| `SMART_MONEY_VOICE_ID` | TTS voice for the channel persona |
| `SMART_MONEY_VOICE_MODEL` | TTS model, for example `eleven_multilingual_v2` |
| `FAL_KEY` | Generated imagery and image-to-video |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Script generation, fallback TTS |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN` | Upload, after human approval |
| `YOUTUBE_CHANNEL_ID`, `YOUTUBE_CHANNEL_NAME` | Channel targeting |
| `UTM_PARAM_DEFAULT_SOURCE`, `UTM_PARAM_DEFAULT_MEDIUM` | Link attribution in descriptions |
