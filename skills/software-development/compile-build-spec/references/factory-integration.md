# Software Factory Integration

The skill is an upstream compiler, not an execution authority.

## Current Live Path

Factory intake reads `ready` tasks from the Hermes Kanban `software-factory` board (report-only; dispatch is disabled). See `docs/factory.md` in the hermes-zouroboros checkout. The conveyor validates a ticket's contract, then lets the dispatcher choose DIRECT or SWARM.

The exported ticket must use these exact headers:

```markdown
## Acceptance Criteria
## Target Repo
## Archetype
## Repro
```

Do not emit `## Repro / Area`; the production parser does not accept the spaced-slash header.

Supported coarse archetypes are:

- `dependency`
- `docs`
- `bugfix`
- `feature`
- `refactor`
- `migration`

Before the operator applies `factory-ready`, confirm that the exported ticket contains exactly the four
headers above and passes `validate`. In this distribution, `factory/cli.ts` reads the board
(`--board-dir`, `--manifest`, optionally `--pullable`) and never dispatches; it is the place to
confirm that a ready task is visible to intake.

## Authority Boundary

The skill may:

- Preserve and hash a source prompt.
- Produce a normalized specification.
- Run deterministic and independent model review.
- Generate candidate ticket and seed files.
- Resolve a separately versioned exact-template persona association and retain its lineage, bounded fleet, and task-scoped authority overrides.

The skill may not:

- Create or mutate Hermes Kanban tasks.
- Add labels or change states.
- Dispatch the factory.
- Choose an authoritative execution mode.
- Merge, publish, deploy, or send external communications.
- Resolve live persona UUIDs, invoke personas, or change model and harness routing.

## Swarm Mapping

When the dispatcher chooses SWARM:

- `milestones` provide the task DAG.
- `contracts` define shared ownership boundaries.
- `acceptanceCriteria` and `verifications` feed seed evaluation.
- `canonicalScenarios` define retained evidence.
- `unresolved` must be empty before execution.
- `metadata.personaAssociation` maps to the seed's optional `persona_association` block.
- Milestone `personaAssignments` map to task-local `persona_assignments`; implementation paths remain a subset of task-owned files.
- Post-flight evaluation and the five-part gap audit remain downstream gates.

Association-bearing export fails closed when a task names a role outside the exact resolved fleet, exceeds that role's permitted phases, or grants implementation authority without non-empty contained paths. Candidate export remains non-dispatching; live directory resolution and invocation belong to downstream factory gates.

Do not duplicate or bypass the factory's spec interview, seed evaluation, post-flight evaluation, or gap audit. The compiler improves the intake artifact those gates receive.
