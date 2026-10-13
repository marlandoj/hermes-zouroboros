# Held-out catalog

`heldout/catalog.json` defines held-out check classes (check-runner format, `kind: heldout`).
A prescription names the classes it wants in `heldout_ref` (class names only). Verify runs
those classes plus every class marked `always`. `rx-validate.py` rejects unknown class names, and
requires at least one class for tier H and G prescriptions.

Held-out checks exist so that passing the visible acceptance check is not enough (Constitution
Art. III). They test the same **spec** through a different path, with different parameters.

| Class | Check | How it differs from a typical acceptance check |
|---|---|---|
| `concurrency` | HO-CONC-1 `probes/memory-writers.ts` | N processes × M writes through the memory **library** rather than the MCP server; every write must persist with zero errors. |
| `shell-injection` | HO-SHELL-1 `probes/shell-payloads.sh` | Seven metacharacter variants (`$()`, backticks, `&&`, `\|`, newline, `\|\|`, quote-breaking) through the operator CLI, with absolute marker paths. |
| `cancellation` | HO-CANCEL-1 `probes/interrupt-variant.sh` | SIGINT (not SIGTERM) during task 1 of a 3-task chain, run with job control so the signal is actually delivered. |
| `mcp-contract` (always) | HO-MCP-ALL | The full `mcp-e2e.ts` contract harness on base and head, compared per test. Any PASS→FAIL is a regression. |

## Rules
1. **Confirm red before use.** A probe must fail on the current base with its declared `red`
   signature, and pass on a known-good fix. A probe that passes on base proves nothing; verify
   reports it as non-discriminating. Two classic probe bugs both surface only through this rule:
   - a relative marker path, which hides injection because the CLI changes the working directory;
   - a SIGINT sent to a background job in a non-interactive shell, which ignores it.
2. **Different path, same spec.** Don't copy the acceptance check with new numbers. Change the
   entry point, the parameters, or the attack variant.
3. **Self-contained and bounded.** Use `{scratch}` and `{bun}`, exit 97 on setup errors, and make
   no network or model calls.
4. **Protected.** Editing the catalog or probes is tier G (governor) and a protected path
   (scope-check, tamper-check). Evolve must not read this catalog; prescriptions name classes
   only.
5. **Saturation is a signal.** If every probe passes trivially on base, the class is
   non-discriminating. Harden it rather than celebrate (Art. III).
