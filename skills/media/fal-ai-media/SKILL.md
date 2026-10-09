---
name: fal-ai-media
description: "Generate and edit images and videos through the fal.ai queue API with the operator's own FAL_KEY, using models including nano-banana-2, gpt-image-2, kling-v3-std and veo3.1-fast. Use for text-to-image, image editing, image-to-video and text-to-video requests."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [media, image-generation, video-generation, fal.ai, Zouroboros]
    related_skills: [ai-character-builder, broll-injector]
prerequisites:
  commands: [bun]
  env_vars: [FAL_KEY]
---
# fal-ai-media

Image and video generation through the fal.ai API with the operator's own `FAL_KEY`.
The script has no dependencies and makes no call other than to `queue.fal.run` and the
returned media URLs.

## Usage

```bash
bun "${HERMES_SKILL_DIR}/scripts/fal-media.ts" <command> [options]
```

## Commands

| Command | Description |
| --- | --- |
| `generate` | Text-to-image generation |
| `edit` | Image editing / transformation |
| `video` | Image-to-video generation |
| `t2v` | Text-to-video generation |
| `models` | List available models |

## Model Selection

- **Text in image** (titles, thumbnails, labels): `--model gpt-image-2`
- **Standard generation**: `--model nano-banana-2` (default)
- **High-quality/campaign**: `--model nano-banana-pro`
- **Video from image**: `--model kling-v3-std` (default)
- **Text-to-video**: `--model veo3.1-fast` (default)

## Examples

```bash
OUT="${ZOUROBOROS_WORKSPACE:-$PWD}/media"
mkdir -p "$OUT"

# Generate an image
bun "${HERMES_SKILL_DIR}/scripts/fal-media.ts" generate --prompt "A serene mountain landscape" --output "$OUT/mountain.png"

# Edit an existing image
bun "${HERMES_SKILL_DIR}/scripts/fal-media.ts" edit --prompt "Change background to sunset" --image "$OUT/photo.png" --output "$OUT/edited.png"

# Generate video from image
bun "${HERMES_SKILL_DIR}/scripts/fal-media.ts" video --prompt "Camera slowly pans right" --image "$OUT/scene.png" --output "$OUT/scene.mp4"
```

## Notes

- `FAL_KEY` comes from the Hermes profile environment. Never paste the key into chat or a file in the workspace.
- Every generation is billed to the fal.ai account behind `FAL_KEY`; confirm large or video batches with the operator first.
- GPT Image 2 caveats: no PNG transparency, max aspect 3:1, endpoint is `fal-ai/gpt-image-2`.
- `--output` is required. Save outputs in the operator's workspace (for example a `media/` folder) with descriptive filenames, never inside the skill directory.
