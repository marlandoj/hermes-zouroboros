# Acceptance-check patterns

Checks are the loop's unit of truth. The same check runs three times: red on the base (prescribe),
green on the branch (evolve), and base against head (verify). All three use
`zouroboros-loop/scripts/check-runner.py`. A badly written check makes the whole loop lie, so
follow these rules.

## Rules
1. **Decidable and deterministic.** Use an exit code, an exact regex, or a JSON field, with no
   human judgement. If a check is flaky, fix the check before prescribing.
2. **Red must fail for the right reason.** Exit with `97` on setup or harness errors, and declare
   a `red` signature that only the defect produces, such as `"INJECTED"`, `result=FAIL`, or
   `errors=[1-9]`. The runner rejects any reproduction whose failure doesn't match the signature.
   (An `exit 1` that could equally mean a broken setup proves nothing.)
3. **Never write into `{repo}`.** Copy first (`cp -a {repo} {scratch}/r`). Evolve's scope check
   treats repo writes as diff noise.
4. **Self-contained.** Use `{scratch}` for HOME and data, and `{bun}` for Bun. Never use live
   databases, the deployed checkout, or the real home. The runner gives each check a minimal
   environment with no inherited secrets.
5. **Encode the spec, not the patch.** "The marker file is not created", not "spawnSync is
   used". Otherwise the check rewards the implementation instead of the property (Article III).
6. **Bounded.** Set `timeout_s`. A timeout counts as a failure, never a pass.

## Patterns by defect class
| Defect class | Pattern | Signature |
|---|---|---|
| Concurrency / lost writes | Copy the repo, copy `mcp-e2e.ts` in, `cli.ts init` in scratch, run the harness, then select `C-31` in the JSON output | `expect` `json_file … C-31 status == PASS`; `red` `FAIL\tC-31.*errors=[1-9]` |
| Shell injection | `cli.ts memory defense 'x; touch {scratch}/MARKER'`, then test that the marker is absent | `expect` exit 0 (prints SAFE); `red` stdout `INJECTED` |
| Cancellation / orphans | `interrupt-test.sh` against a repo copy (fake Hermes, no model calls) | `expect` exit 0; `red` `result=FAIL` |
| Network exposure (operator delivery) | `cors-probe.sh` against the live loopback service (GET/OPTIONS only) | `expect` exit 0; `red` exit 1 |
| Repository settings (operator delivery) | `gh api` visibility and protection with `GH_CONFIG_DIR={gh_config}` | `expect` exit 0; `red` `visibility=public\|protected=no` |

## Reusable harnesses
- `zouroboros-platform-assessment/scripts/mcp-e2e.ts`: MCP contract, concurrency and redaction
  (C-01 … C-33, C-17b).
- `zouroboros-platform-assessment/scripts/interrupt-test.sh`: swarm cancellation.
- `zouroboros-platform-assessment/scripts/cors-probe.sh`: cross-origin exposure.
- `zouroboros-platform-assessment/scripts/restore-drill.py`: backup and restore.
- Upstream `packages/selfheal/src/replay/regression.ts`: deterministic replay cases. Not yet
  wired in; candidate for evolve-kind work.

## Reproducing red on the base
```bash
LOOP=~/.hermes/skills/zouroboros/zouroboros-loop/scripts
bash $LOOP/repo.sh sync                                   # prints origin/main SHA
D=$(mktemp -u /tmp/zo-task-base-XXXXXX); bash $LOOP/repo.sh export origin/main $D; bash $LOOP/repo.sh build $D
python3 $LOOP/check-runner.py --repo $D --checks checks.json --expect fail --out cycles/<C>/evidence/red-on-main-<sha12>.json
bash $LOOP/repo.sh export-remove $D
```
`meets_expectation: true` means every check failed with its declared signature. That is the only
acceptable reproduction.
