---
name: zouroboros-governance
description: "Constitutional governance for Zouroboros self-modification: verify the canonical manifesto and constitution, run the fail-closed constitution gate on a proposed change (scheduling, routing, memory, prompts, gates or governance) before acting, and record hash-chained, anchored verdicts. Use before any self-modifying change and whenever someone asks to check the constitution or the governance audit log."
version: 2.0.0-hermes.1
author: Zouroboros
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Zouroboros, Governance, Safety, Audit, Constitution]
    related_skills: [zouroboros, zo-swarm-orchestrator, autoloop]
prerequisites:
  commands: [bun]
---

# Zouroboros governance

The governing documents ship with this skill and are authoritative:

- `references/ZOUROBOROS.md`: the manifesto, which defines what Zouroboros is;
- `references/CONSTITUTION.md`: the ten articles that govern self-modification.

Every change to scheduling, routing, memory, prompts, gates or governance goes through the
constitution gate first. If the gate or the documents are unavailable, **stop**: the gate fails
closed and so must the caller.

## Verify the governing documents

```bash
bun "${HERMES_SKILL_DIR}/scripts/constitution-gate.ts" verify-docs
```

It checks that both documents exist, that the constitution has exactly ten articles and that the
manifesto carries the canonical identity statement. It prints JSON and exits 0 (ok) or 2 (violations).

- `--canonical-root DIR` or `ZOUROBOROS_GOVERNANCE_DOCS_DIR` checks another canonical copy.
- `--mirror-root DIR` or `ZOUROBOROS_GOVERNANCE_MIRROR_DIR` also checks that a workspace
  entry point (a symlink or an identical copy of each document) has not drifted. With no mirror
  configured, `mirrorMode` is `not-configured` and the shipped copy is authoritative.

## Check a proposed change (preflight)

Write a change envelope and pipe it to the gate:

```json
{
  "operation": "evolve-routing-policy",
  "description": "Replace one routing rule after evaluation",
  "targetFiles": ["config/routing.json"],
  "modifiesModelWeights": false,
  "reversible": true,
  "rollbackPlan": "Revert the candidate commit",
  "blastRadius": "local",
  "humanApproved": false,
  "provenance": { "rationale": "Lower failure rate", "evidence": ["eval/report.json"], "actor": "autoloop" },
  "budgetBounded": true,
  "layerIntegrity": true,
  "failClosed": true
}
```

```bash
bun "${HERMES_SKILL_DIR}/scripts/constitution-gate.ts" check --stdin --phase preflight < change.json
```

`decision` is `ALLOW` (exit 0) or `BLOCK` (exit 2), with a `violations` list naming the article
and a code. Each check is recorded in the governance audit log unless `--skip-audit` is given.
The main codes are:

| Code | Article | Meaning |
| --- | --- | --- |
| `I-FROZEN-WEIGHTS` | I | the change would train or alter model weights |
| `IV-NO-ROLLBACK` | IV | not reversible or no rollback plan |
| `V-HUMAN-AUTHORIZATION` | V | `shared`/`high` blast radius without explicit human approval |
| `VI-PROVENANCE` / `VI-INCOMPLETE-SCOPE` | VI | rationale, actor, evidence or scope missing |
| `VII-UNBOUNDED-RESOURCES` | VII | no bounded budget |
| `VIII-LAYER-INTEGRITY` | VIII | crosses model/harness/agent/memory/control-plane boundaries |
| `IX-FAIL-OPEN` / `IX-INVALID-INPUT` | IX | the caller would not stop on missing evidence, or the input is invalid |
| `X-AMENDMENT-AUTHORIZATION` | X | amends a governing document without human approval |
| `X-*` document codes | X | governing documents missing, malformed or drifted |

`humanApproved: true` must reflect an explicit approval from the operator in this conversation
or task. Never set it on your own judgement.

**Promotion is blocked in this distribution.** `--phase promotion` always returns `BLOCK` with
`IX-PROMOTION-AUTHORITY-UNAVAILABLE`. Certified promotion needs an evidence issuer, independent
persona attestations, operator approval keys and a single-use authorization ledger, and none of
these are provisioned here. Caller-supplied flags such as `mechanical`, `heldOut` or a model
consensus boolean are never accepted as promotion evidence. Promotion goes through the
repository's normal review and CI instead.

## Audit log

```bash
G="${HERMES_SKILL_DIR}/scripts/governance.ts"
bun "$G" verdict --kind manual --label "<what>" --verdict ALLOW|BLOCK|ADVISORY --evidence '<json>' --rationale "<why>"
bun "$G" verify          # chain + detached anchor MAC; exit 1 if broken
bun "$G" tail --limit 10
bun "$G" blocked-tools   # Hermes tools the governance role must never dispatch
```

Records are append-only, SHA-256 hash-chained and anchored by an HMAC in a separate file.
A wrong verdict is corrected by appending a new one, never by editing the log.
Locations (owner-only; created on first use):

| File | Default |
| --- | --- |
| audit log | `$ZOUROBOROS_STATE_DIR/governance/governance-audit.log` |
| anchor | `$ZOUROBOROS_STATE_DIR/governance/governance-anchor.log` |
| anchor key | `$ZOUROBOROS_CONFIG_DIR/governance/governance-anchor.key` |
| approval authorities | `$ZOUROBOROS_CONFIG_DIR/governance/approval-authorities.json` |

Without those variables, the state and config dirs are `state/` and `config/` under the
hermes-zouroboros profile (`$HERMES_ZOUROBOROS_HOME`, default
`$XDG_DATA_HOME/hermes-zouroboros`). `ZOUROBOROS_GOVERNANCE_LOG_PATH`,
`ZOUROBOROS_GOVERNANCE_ANCHOR_PATH`, `ZOUROBOROS_GOVERNANCE_ANCHOR_KEY_PATH` and
`ZOUROBOROS_APPROVAL_KEYS_PATH` override single files.

## Authorized bypass (operator only)

A BLOCK verdict can be bypassed only with a signed, scoped, single-use Ed25519 authorization from
an operator-held key. The private key never lives on the agent host: `generate` and `sign`
refuse to run inside an agent session or next to a hermes-zouroboros profile, and `enroll`
refuses to run inside an agent session.

```bash
O="${HERMES_SKILL_DIR}/scripts/operator-authorization.ts"
# operator device
bun "$O" generate --authority operator-offline-v1 --output-dir ./keys
# agent host, operator shell: trust the public key only
bun "$O" enroll --authority operator-offline-v1 --public-key ./keys/operator-offline-v1.public.pem
# request (30-900 s validity), sign offline, then record the bypass
bun "$O" request --actor <actor> --action governance.bypass --resource <verdict_id> \
  --fingerprint <fp> --scope governance.bypass --authority operator-offline-v1 --output req.json
bun "$O" sign --request req.json --private-key ./keys/operator-offline-v1.private.pem --output auth.json
bun "$G" bypass --target <verdict_id> --reason "<why>" --actor <actor> --authorization auth.json
```

As an agent, you may prepare a request, but signing, enrolling and deciding to bypass are the
operator's.

## Capability-ethics ratio

```bash
bun "${HERMES_SKILL_DIR}/scripts/capability-ethics.ts" --pretty   # default: this distribution's skills/
```

It reports which skills carry a `GOVERNANCE.md` (capability statement, blast radius, ethics review).

## Boundaries

- Governance is enforced where callers invoke the gate. It is not a syscall interceptor, and
  Hermes tools are not hooked automatically.
- Anchor authenticity uses a host-local HMAC key, not a cross-host identity system.
- Not in this distribution: the promotion issuer and attestation stack, managed Codex pre-tool
  guards, the autonomy classifier and pre-tool adapter, the dissent digest (it depends on the
  retired model consensus gate) and delegation receipts.

## Verification

```bash
bun test "${HERMES_SKILL_DIR}/scripts"
```
