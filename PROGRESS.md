# README marketing visuals

Status: IN PROGRESS

Objective: create and integrate a coordinated hero banner, architecture diagram, and capability infographic for the Hermes × Zouroboros README.

- [x] Review existing README claims and repository state.
- [x] Scope documentation-only work; decision gate SUGGEST (0.31), proceed directly.
- [x] Generate and inspect three images; preserve prompts in docs/assets.
- [x] Embed assets with descriptive alt text and verify local references.
- [ ] Commit, push, and open a documentation pull request.

Preflight limitations: graph CLI rejects sandbox IPC ownership; escalation unavailable. Operation-window command failed before a decision because `/home/.z` is read-only. Work stays in the existing VPS checkout; no detached workers or service changes.

Verified: all three PNG signatures and dimensions, all README image references, descriptive alt text, retained Mermaid/table text equivalents, and `git diff --check`. No TypeScript or application code changed.

Artifacts: `docs/assets/hermes-zouroboros-{hero,architecture,capabilities}.png`. Exact generation prompts: `docs/assets/README.md`. Consumer: root `README.md`.

Next action: commit, push branch `docs/readme-marketing-visuals`, and open the documentation pull request.
