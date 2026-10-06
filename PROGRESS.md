# Release 0.1.0

Status: COMPLETE

Objective: independent Hermes/Zouroboros VPS distribution extracted from the workspace; no fork of Muse and no changes to running VPS services.

- [x] Extract tracked runtime source with revision/hash provenance.
- [x] Create isolated Hermes profile, local MCP and portable executor.
- [x] Adapt read-only Factory intake and include offline projection.
- [x] Add setup, optional service template, walkthrough and CI.
- [x] Build imported packages; validate portable state relocation.
- [x] Verify MCP memory round trip and fake executor integration.
- [x] Complete final typecheck, acceptance suite and clean-checkout proof (18 Bun tests, 10 Python tests, portable relocation).
- [x] Publish independent private repository and verify remote revision.
- [x] Pass GitHub fresh-runner CI: build, TypeScript, 18 Bun tests, 10 Python tests, portable relocation.

Source workspace preflight: graph IPC and operation-window ledger are inaccessible in this sandbox. Targeted source reads were used. Specialist routing ran in shadow mode; bounded read-only/code reviews used the operator-authorized agents. No real specialist provider calls or paid model execution.

Known scope limits: production Factory dispatch and deployment are not installed; standalone self-heal probes/TUI/bundled skills are excluded. Private package license declarations are preserved. See README and NOTICE.

GitHub repository created and verified PRIVATE, `isFork=false`: https://github.com/marlandoj/hermes-zouroboros.

Verified implementation revision: `2103e0123990b4da69f4efc90773eb98fefee281`.

CI receipt: https://github.com/marlandoj/hermes-zouroboros/actions/runs/37407318443 — SUCCESS.

Next operator step: follow walkthrough/README.md to configure the isolated Hermes provider profile and perform an authorized live-model smoke test. Repository creation and distribution validation are complete; the existing production VPS was not redeployed.

## README marketing visuals

Objective: create and integrate a coordinated hero banner, architecture diagram, and capability infographic for the Hermes × Zouroboros README.

- [x] Review existing README claims and repository state.
- [x] Scope documentation-only work; decision gate SUGGEST (0.31), proceed directly.
- [x] Generate and inspect three images; preserve prompts in docs/assets.
- [x] Embed assets with descriptive alt text and verify local references.
- [x] Commit, push, and open a documentation pull request.

Preflight limitations: graph CLI rejects sandbox IPC ownership; escalation unavailable. Operation-window command failed before a decision because `/home/.z` is read-only. Work stays in the existing VPS checkout; no detached workers or service changes.

Verified: all three PNG signatures and dimensions, all README image references, descriptive alt text, retained Mermaid/table text equivalents, and `git diff --check`. No TypeScript or application code changed.

Artifacts: `docs/assets/hermes-zouroboros-{hero,architecture,capabilities}.png`. Exact generation prompts: `docs/assets/README.md`. Consumer: root `README.md`.

Published for review: https://github.com/marlandoj/hermes-zouroboros/pull/1 on `docs/readme-marketing-visuals`. Artwork implementation and local checks are complete; merge remains pending review.
