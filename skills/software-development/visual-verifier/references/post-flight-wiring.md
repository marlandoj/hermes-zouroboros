# Post-Flight Stage 2 Wiring — Visual Verification

## When the station runs

The visual verifier station runs during **post-flight Stage 2** (acceptance
criteria verification) for any deliverable flagged `visual: true` in the seed.

### Seed task flag

Add `visual: true` to any seed task that produces a rendered output (UI route,
site page, dashboard, landing page):

```yaml
tasks:
  - id: T1
    title: "Build the pricing page"
    visual: true          # ← triggers the visual verifier station
    acceptance: "Page renders with the project palette, hero section, and CTA."
```

Tasks without the flag (or with `visual: false`) skip the station, so the
post-flight eval is unchanged for them.

### Post-flight procedure (agent-side)

When running post-flight Stage 2 and a task has `visual: true`:

1. **After text ACs pass**, run the station:
   ```bash
   bun "${HERMES_SKILL_DIR}/scripts/station.ts" \
     --url "http://localhost:3099/<route>" \
     --criteria "<task acceptance text>" \
     --design-md "<path/to/DESIGN.md>" \
     --author "<maker model id>" \
     --label "<task-id>" \
     --project "<project>"
   ```
   Artifacts go to `$ZOUROBOROS_STATE_DIR/visual-verifier/<project>/`. Without
   `agent-browser`, capture the page with the Hermes browser tool and pass
   `--screenshot <png>` instead of `--url`.
2. **Read the exit code**: 0 = visual match, 1 = mismatch (rework needed),
   2 = station error (capture or verifier failed, including a missing vision
   key or an author conflict). Treat 2 as "not verified", never as a pass.
3. **On mismatch**: the station writes `visual-diff-<label>.json` with a
   structured diff (issue, criterion violated, severity). Feed this diff
   back to the maker subagent for the next iteration. The maker does NOT
   self-declare done on visual tasks — the verifier is the exit condition.
4. **On match**: mark the task visually verified. Proceed.

### What the station checks

The verifier reads the **screenshot image** (not the code) and compares
against three references:

- **(a)** Seed acceptance criteria (passed via `--criteria`)
- **(b)** Project `DESIGN.md` tokens (passed via `--design-md`) — palette,
  typography, spacing, border-radius, etc.
- **(c)** Prior screenshot (passed via `--prior-screenshot`) — sent as a
  second image to catch regressions from a previous iteration.

### ≠Author constraint

The verifier model must differ from the author model. `scripts/independence.ts`
compares model ids after normalization (lowercase, provider scheme stripped,
basename match). If the configured verifier is the author, the first non-author
model in `VISUAL_VERIFIER_FALLBACK_MODELS` is used; if none is configured, the
verifier refuses and the station exits 2.

### Panel mode

`VISUAL_VERIFIER_PANEL_MODELS=a,b,c` runs one independent verifier per model
(the author removed). The station reports a match only when every verifier
reports a clean match; otherwise the diffs from all verifiers, tagged by model,
form the rework diff. Default is a single verifier.
