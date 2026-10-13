# Prescription schema — `zo-loop/prescription@1`

One JSON file per prescription: `cycles/<cycle>/prescriptions/RX-<cycle>-<nn>.json`.

The file is **immutable after approval**. The approval binds its canonical SHA-256
(`ledger.py digest`), so any edit invalidates the approval. State does not live in the file;
it lives only in `ledger.jsonl`.

`scripts/rx-validate.py` enforces everything below. Worked examples are the five
prescriptions under `<loop home>/cycles/<cycle>/prescriptions/` once a cycle has run.

| Field | Type | Rule |
|---|---|---|
| `schema` | string | `zo-loop/prescription@1` |
| `id` | string | `RX-C<YYYYMMDD>-<n>-<nn>`, prefixed by `cycle` |
| `cycle` | string | `C<YYYYMMDD>-<n>` |
| `kind` | `heal` \| `evolve` | Heal restores a declared spec. Evolve moves the spec, and needs `baseline` (ZOUROBOROS.md, heal vs evolve). |
| `delivery` | `pr` \| `operator` | `pr`: the evolve skill changes the repo through a PR. `operator`: host or settings change, done by a human following `runbook`. |
| `title` | string | One line, imperative |
| `defects` | string[] | Assessment defect IDs (`D-NN`), or `M-<metric>` for metric-track items |
| `source` | object | `assessment` (directory) and `defects_digest` (SHA-256 of its `DEFECTS.md`). A changed assessment invalidates the prescription, so re-derive it. |
| `spec` | string | The behaviour that must hold afterwards, stated so a check can decide it |
| `rationale` | string | Evidence-based why, with numbers and file:line |
| `base` | object | `repo`, `ref`, `sha` (40-hex for `pr`). It must be the commit the red reproduction ran on. |
| `reproduction` | object | Heal+pr only: `result_file` (check-runner `--expect fail` output), `digest`, `red_on_sha` (= `base.sha`), `meets_expectation: true`. It must cover every acceptance check ID. |
| `baseline` | object | Evolve only: `metric`, `value`, `n` (sample size), `variance` or `ci`, `result_file` |
| `acceptance_checks` | check[] | check-runner format, `kind: acceptance`. Heal checks must declare `red`, the defect's own signature. These checks are **visible to evolve**. |
| `heldout_ref` | string[] | Names only of held-out catalog entries, chosen by verify. Never the contents. |
| `change_plan` | object | `summary`, `files` (allowed paths/globs, enforced by evolve's scope check), `max_files`, `tests_to_add`, `approach` (red → green → full suite) |
| `runbook` | string[] | Operator delivery: exact steps, including rollback |
| `risk` | object | `blast_radius`, `reversibility`. `tier` may be omitted, and if present must equal the governor's. |
| `governor` | object | Written by `governor.py --write`. Never edit by hand; the validator recomputes it. |
| `rollback` | string | How to undo: before merge, close PR and delete branch; after merge, `git revert`. Plus data effects. |
| `budget` | object | `live_calls` (int), `usd`. Non-zero needs an approval scope `live-calls:<n>` and a cycle budget. |
| `open_questions` | string[] | Anything only the operator can decide. Non-empty means BLOCK. |
| `seed` | object | Optional. Upstream selfheal seed shape (`goal`, `constraints`, `acceptance_criteria`, `exit_conditions`, `evaluation_principles`) for plan-gate tooling. |

## Writing good prescriptions
- **One defect, one prescription,** unless two defects share a root cause and a single check
  decides both.
- **The spec is the contract.** Write it as an observable property, not an implementation:
  "200/200 concurrent writes succeed", not "add busy_timeout". The implementation goes in
  `change_plan`.
- **Smallest sufficient change.** Keep `files` tight; evolve fails any diff outside them. If you
  are unsure, plan it as two prescriptions.
- **Tests travel with the fix.** `tests_to_add` must reproduce the defect in the repo's own suite,
  so CI keeps guarding it after the loop moves on.
- **Never prescribe** weights, production-data edits, deployed-checkout edits, or anything you
  cannot check. The governor BLOCKs these.
- **Questions go to `open_questions`.** Never resolve an operator decision by assumption.
