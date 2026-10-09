# GOVERNANCE.md — `zouroboros-governance`

## Skill: `zouroboros-governance`

### Capability statement
External governance surface for the Zouroboros stack. Provides verdict
recording, anchored audit-log verification, signed authorization checking,
and capability-ethics rollup.
The skill itself does not act on the operator's behalf — it observes and
records.

### Blast radius
- [x] **Tiny** — read-only, local only

Every operation in this skill is a local fs write to a single append-only log
or stdout. No network, no mutating tool dispatch, no external state.

### Ethics review
1. **Whose data does this touch?** Operator only. Log lives at
   `$ZOUROBOROS_STATE_DIR/governance/governance-audit.log`.
2. **What goes wrong if this misfires?** The audit log could corrupt (caught
   by `verify`) or a false verdict could mislead a future review. Both are
   recoverable: the chain is verifiable and individual entries are
   inspectable via `tail`.
3. **Is there a reversible-action contract?** Verdicts and bypasses are
   append-only — not reversible, by design. A wrong verdict is corrected by
   appending a corrective verdict, not deleting the original.
4. **Does this need consensus-gate or governance review before acting?** No
   — this *is* the governance layer.

### Failure modes considered
1. **Log file deleted/missing** — verification fails because the detached
   anchor no longer matches. Consumers cannot use the ledger as evidence.
2. **Hash collision / sha256 weakness** — sha256 collisions remain
   computationally infeasible at the scale of a personal audit log. If this
   ever changes, the chain format is forward-compatible with a longer hash.
3. **Caller wraps verdict in noise** — `verdict_id` is emitted on a
   dedicated stdout line (`verdict_id: <id>`) so regex-based callers don't
   misparse JSON-mode vs plain output.

### Out of scope
- Multi-user governance — single-operator only.
- Live pre-action enforcement. Hermes tool calls are not intercepted; callers
  invoke the constitution gate explicitly.
- Certified promotion. The promotion phase fails closed in this distribution.

### Audit hooks
- [x] Logs to local file (path: `$ZOUROBOROS_STATE_DIR/governance/governance-audit.log`) via `governance.ts`
- [x] Anchors the chain under `$ZOUROBOROS_STATE_DIR/governance/`, keyed from `$ZOUROBOROS_CONFIG_DIR/governance/`
- [ ] No audit
