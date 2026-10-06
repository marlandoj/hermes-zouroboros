# @zouroboros/capability-runtime

Vendor-neutral policy and mediation library for the Zouroboros capability-secured tool runtime.

## Implemented scope

### ZCR-002: capability broker

- Resolves immutable authority references through the ZOU-1059 owner adapter.
- Verifies envelope ID, version, canonical payload digest, enforcement evidence, run, subject, environment, validity, and terminal state.
- Issues resource-scoped, operation-scoped, expiring `CapabilityHandleV1` records.
- Proves child delegation against the authoritative ZOU-1059 subset validator and the complete stored parent chain.
- Projects only active introduced capabilities into the model-visible catalog; credential locators and authority internals remain broker-private.
- Revalidates authority, parent state, catalog bindings, arguments, expiry, and receipt lineage immediately before provider I/O.
- Emits introduction, use, denial, expiry, and attenuation proposals through an injected ZOU-1051 canonical receipt writer.
- Allows read dispatch only after use evidence is committed. Writes fail closed with `action_journal_required` until ZCR-003 supplies exact-action approval and the durable journal.

### ZCR-003: exact-action approval and durable action journal

- Canonicalizes strict JSON action payloads and rejects unsupported, cyclic, sparse, or non-finite values.
- Stores canonical payload bytes only through an injected sealed payload store; journal rows carry ciphertext references and SHA-256 fingerprints.
- Produces a structured trusted action view from sealed canonical bytes rather than agent-authored summaries.
- Verifies domain-separated Ed25519 action approvals against exact action, run, actor, session, capability, tool, resource, payload, plan-lineage, and expiry bindings.
- Persists immutable actions and approvals, append-only hash-chained events, a transactional receipt outbox, and canonical receipt acknowledgements in SQLite WAL with `synchronous=FULL`.
- Commits and receipts `approved -> applying` with a `claimed` boundary before provider I/O; authority is reverified immediately before and after the claim.
- Recovers uncertain claims as `outcome_unknown`, republishes pending evidence without repeating provider effects, and preserves terminal state across a fresh process.

### ZCR-005: effect and reconciliation policy

- Effect-class policy for provider-idempotent, reconcilable, non-idempotent, destructive, and compensating writes.
- Crash-window recovery and explicit `outcome_unknown` semantics.
- Reconciliation and replacement-dispatch gates.
- File-backed reference idempotency store proving restart recovery.

## Trust boundaries

- ZOU-1059 remains the sole authority-envelope owner. `Zou1059AuthorityVerifier` delegates structural, request, resource, and delegation decisions to that implementation.
- ZOU-1051 remains the sole canonical receipt owner. This package submits event proposals and consumes returned receipt references; it does not mint receipt identities.
- Catalog entries, clock, runtime environment, run state, credential locators, provider invoker, store, and receipt writer are injected trusted ports.
- Raw credentials and provider sessions never enter handles, evidence proposals, model-visible catalogs, invocation requests, or broker results. The provider invoker resolves opaque credential locators inside its own trusted boundary.
- No workflow, swarm, Software Factory, MCP, deployment, or live enforcement path imports this package yet. The ZCR-002 broker still blocks writes until ZCR-007 connects it to `GovernedActionRuntime`; consumer wiring remains ZCR-007/ZCR-008 work.

## Verification

```bash
bun run typecheck
bun test test/
```

The focused suite includes forged and expired authority references, over-broad resources, environment and terminal-state drift, argument smuggling, catalog mutation, evidence-writer outages, credential-sentinel checks, expiry monotonicity, delegated-parent revocation, exact-action mutation, signed-binding drift, journal tampering, receipt-outbox recovery, and fresh-process terminality.
