# B-Roll Injector — pipeline design & gotchas

The skill generalizes an ffmpeg compositing formula that was first hardened by hand on
real explainer renders into a resumable, model-routed, fail-loud DAG. No new tooling — it
wires what already exists (`fal-ai-media`, a one-shot Hermes model call, ffmpeg) into one
repeatable workflow.

## The proven ffmpeg formula

Per b-roll moment, two operations:

1. **Time-shift** the clip so its `t=0` lands at the window start:
   `setpts=PTS+<start>/TB`
2. **Gate an overlay** (NOT concat) onto the spine for the window:
   `overlay=...:enable='between(t,<start>,<end>)'`

Then force everything concat-compatible on the way out:
`-r 25 -pix_fmt yuv420p -c:v libx264 -preset fast -crf 18`, and **always copy the
spine's audio** (`-map 0:a -c:a copy`) — the presenter's voice is the backbone and is
never re-encoded or replaced.

`compose.py` chains N overlays into a single `filter_complex`:

```
[1:v]<scale>,setpts=PTS+s1/TB[ov1];
[2:v]<scale>,setpts=PTS+s2/TB[ov2];
[0:v][ov1]overlay=<pos>:eof_action=pass:enable='between(t\,s1\,e1)'[s1];
[s1][ov2]overlay=<pos>:eof_action=pass:enable='between(t\,s2\,e2)'[vout]
```

- **fullframe** scale: `scale=W:H:force_original_aspect_ratio=increase,crop=W:H`
  (cover the frame, then center-crop to exact spine dims), overlaid at `x=0:y=0`.
- **pip** scale: `scale=iw*<pip_scale>:-2`, overlaid bottom-right at
  `x=W-w-<margin>:y=H-h-<margin>`.

## Why the tail doesn't freeze (the dark-tail lesson)

The original hand-render froze/darkened at the end of a cutaway when `hold` ran past
the clip's real length and ffmpeg held the last (often mid-fade-out) frame.
`compose.py` ffprobes each generated clip and **clamps `hold` to the clip duration**
(`_end = start + min(hold, clip_dur)`), and overlays use `eof_action=pass` so the base
shows through if a clip is short. Net effect: the cut lands before any internal
fade-out, so there is no frozen or dark tail.

## Generation: clean silent clips only

The compositor only ever deals with silent, 25fps, yuv420p mp4s. `gen-broll.ts`
guarantees that regardless of source:

- **t2v** → `fal-media.ts t2v --no-audio true` (veo3.1-fast) → re-encode
  `-an -r 25 -pix_fmt yuv420p`.
- **still** → `fal-media.ts generate` (nano-banana-2) → Ken Burns:
  upscale first (`scale=2400:-1`) for zoom headroom, then
  `zoompan=z='min(zoom+0.0012,1.18)':d=<frames>:s=1920x1080:fps=25`.

`dur = hold + 0.6` — a little overshoot so the clamp in compose always has real frames
to cut from.

## Planning call (extract-plan)

The planning stage is a pure-reasoning, one-shot model call through `ask-governor`
(caller `broll-injector`, budget `broll-injector-plan`, at most 2 attempts). It uses the
hermes-zouroboros profile's executor registry (default `hermes-vps`), so the provider and
credentials come from the Hermes profile. `--plan-model` overrides the profile's model.

- Parse a fenced ```json block out of the final response; the model is asked for a bare JSON
  array of `{start, hold, trigger_phrase, prompt}`. Ids `m1..mN` and source/mode/model
  are stamped on afterward; `hold` is clamped to [2.5, 6].

The prompt instructs the model to pick CONCRETE, literal, cinematic single-shot
visuals (subject, setting, lighting, camera move) — no on-screen text, no captions,
no talking people, no logos — spaced across the runtime and never overlapping.

## Dry-run = zero fal spend

`--dry-run` replaces generation with a labeled colour-card placeholder per moment
(stable pastel colour hashed from the id, the trigger phrase + prompt drawn on top).
This proves the entire DAG — planning, caching, windowing, modes, audio passthrough —
end to end before paying fal. Always dry-run a new plan, eyeball it, then render.

### drawtext escaping gotcha (placeholder cards)

drawtext `text=` breaks the filtergraph on any comma or colon in the prompt (a comma
is read as a filter separator — `No such filter: 'shallow depth ...'`). The fix:
write the label to a temp `.txt` file and use
`drawtext=textfile='...':expansion=none` — this sidesteps all filtergraph/drawtext
escaping and keeps the text literal.

## Plan schema

See `assets/plan.schema.json`. A plan is `{ base_video, fps, moments[] }` where each
moment is:

| field | type | notes |
|-------|------|-------|
| `id` | string | `m1`, `m2`, … — also the clip filename `<id>.mp4` |
| `start` | number | seconds into the spine to begin the cutaway |
| `hold` | number | cutaway duration (clamped to clip length at compose) |
| `source` | `"t2v"` \| `"still"` | motion clip vs. Ken Burns still |
| `mode` | `"fullframe"` \| `"pip"` | per-moment override of `--mode` |
| `model` | string | fal model (defaults by source) |
| `prompt` | string | the cinematic shot description fed to fal |
| `trigger_phrase` | string | the quote the cutaway illustrates (label/debug only) |

## Validation

At the source, a dry-run on a real presenter spine (3 moments: fullframe + pip + fullframe)
produced 1920x1080, 25fps, yuv420p, AAC stereo, 14.0s. Frame grabs confirmed each overlay
lands in its window and the spine shows through cleanly between cutaways. In this
distribution, `tests/skills-zoapi.test.ts` runs the full dry-run DAG on a synthetic spine with
a fake Hermes. A paid render is the remaining proof of *visual* quality.
