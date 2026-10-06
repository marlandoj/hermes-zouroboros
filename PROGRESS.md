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
