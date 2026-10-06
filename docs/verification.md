# Verification contract

Run `bash scripts/setup.sh` to install the committed lockfile, build every included package, and run `tsc --noEmit` across packages and the integration. The root build has no postbuild service/config mutations.

`pnpm test` covers:

- isolated profile creation, restrictive file modes, overwrite refusal;
- dependency cycles, unknown dependencies and executor override rejection;
- an SDK MCP client handshake, shared-memory store/search, status, campaign preparation and execution-denied behavior;
- real CLI/worker/orchestrator wiring through a fake Hermes executable;
- bridge argument preservation, model/provider pass-through, timeout, failure, empty output and scratch cleanup;
- read-only factory intake, SQLite integrity/schema checks, selection and invalid-input rejection.

`python3 -m unittest discover -s factory -p 'test_*.py'` validates the offline Factory projection. `pnpm run verify:portable` validates upstream configuration and state export/import relocation under a scrubbed environment.

These are distribution acceptance tests, not the original monorepo's complete test suite. Imported standalone scripts and original internal test assets are intentionally not part of the curated runtime export. No test invokes a live model, creates a production board, activates a system service, or deploys software.

CI also runs `bun examples/offline-demo.ts`, the reproducible README demo. It verifies the CLI-to-MCP memory round trip, saved campaign dependencies, and disabled worker execution in a disposable profile. The example is included in the root TypeScript check.

After local provider setup, perform a live acceptance check yourself: launch `bun integration/cli.ts hermes chat`, call `workshop_status`, and retrieve the harmless memory written in the walkthrough. Run the sample campaign only after reviewing its workspace and unattended execution authority.
