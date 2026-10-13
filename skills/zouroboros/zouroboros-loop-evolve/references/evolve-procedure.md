# Evolve procedure: worked example

The sequence below takes one approved heal prescription, a "concurrent memory writers lose facts"
defect fixed with a `busy_timeout`, from `approved` to `evolved`. Replace the IDs and paths for a
real cycle.

```bash
SK="${HERMES_SKILL_DIR}/.."                       # skills/zouroboros
H=<loop home>; C=<cycle>; RX=<id>; F=$H/cycles/$C/prescriptions/$RX.json; EV=$H/cycles/$C/evolve
L="python3 $SK/zouroboros-loop/scripts/ledger.py"; R="bash $SK/zouroboros-loop/scripts/repo.sh"
$L event --home $H --cycle $C --rx $RX --event start --actor evolve --rx-file $F
$R sync
B=zo-loop/$C/01-busy-timeout; W=$($R worktree-add $B "$(jq -r .base.sha $F)")
$R build $W
# RED: add the planned regression test (two writer processes × 200 writes through initDatabase/storeFact)
(cd $W && bun test tests/memory-concurrency.test.ts)          # must FAIL for the defect's reason
git -C $W add tests/memory-concurrency.test.ts && git -C $W commit -m "test(memory): reproduce lost writes … [$RX]"
# GREEN: smallest change inside change_plan.files
#   packages/memory/src/database.ts: db.exec('PRAGMA busy_timeout = 5000') before journal_mode
$R build $W && (cd $W && bun test tests/memory-concurrency.test.ts)   # must PASS
git -C $W add packages/memory/src/database.ts && git -C $W commit -m "fix(memory): … [$RX]"
jq .acceptance_checks $F > $EV/$RX.acceptance-checks.json
python3 $SK/zouroboros-loop/scripts/check-runner.py --repo $W --checks $EV/$RX.acceptance-checks.json --expect pass --out $EV/$RX.acceptance.json
bash $SK/zouroboros-loop-evolve/scripts/local-suite.sh $W $EV/$RX.suite.json
# base suite: export the base to /tmp, build it, run local-suite.sh (or reuse a run on the same base SHA)
python3 $SK/zouroboros-loop-evolve/scripts/scope-check.py --worktree $W --rx $F --out $EV/$RX.scope.json
python3 $SK/zouroboros-loop-evolve/scripts/evolve-record.py --rx $F --worktree $W --branch $B \
  --acceptance $EV/$RX.acceptance.json --suite $EV/$RX.suite.json --base-suite $EV/$RX.base-suite.json \
  --scope $EV/$RX.scope.json --out $EV/$RX.json
$L event --home $H --cycle $C --rx $RX --event branch-ready --actor evolve --rx-file $F --evidence $EV/$RX.json \
  --data "$(jq -c '{base_sha, head_sha, branch}' $EV/$RX.json)"
```

## What a good run looks like
- **Red:** the new test fails on the base for the defect's reason (here, lock errors from both
  writers).
- **Green:** the test passes. The prescription's acceptance checks pass on the branch, and they
  were red on the base with their declared signatures.
- **Suite vs base:** no step or test that passes on base fails on head. Pre-existing failures
  are recorded in the evolve record, never hidden.
- **Scope:** exactly the planned files, in two commits (test, then fix).

## Lessons built into the scripts
- `local-suite.sh` runs in a 0700 directory under the loop home, not `/tmp`. The installer tests
  correctly refuse a world-writable hierarchy, and running them under `/tmp` produces dozens of
  false failures.
- PATH excludes `~/.local/bin`, because the real Hermes, Claude and Codex launchers live there,
  and tests expect fakes or absence.
- Approvals bind the prescription digest. Changing any field of an approved prescription, even
  provenance metadata, makes verify refuse. Revise only while the prescription is `proposed`.
