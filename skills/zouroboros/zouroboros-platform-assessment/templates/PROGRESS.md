# Zouroboros platform assessment (<YYYY-MM-DD>)

Status: IN PROGRESS — Phase 0

Objective: evidence-backed assessment of the Zouroboros platform on <host>; final report in `REPORT.md`.

Permitted scope (operator, <time MST>):
- Execution mode: <direct + ≤4 read-only helpers | direct only | swarm campaign>
- Live model calls: <none | ≤N calls, ≈$X hard stop, logged in evidence/model-calls.tsv>
- No deploys, production data changes, service restarts, messages or trades. Mutation, failure and restore tests run in scratch only.

Environment under test:
- Host: <hostnamectl / uptime / boot>
- Deployed checkout and revision: <provenance.txt summary>
- Swarm decision gate on the scoped plan: <decision score>
- Gates unavailable on this host: <operation window / recovery controller / hooks>

Scratch: </tmp/zo-task-XXXXXX> (contains copies of live data — delete in Phase 4)

## Phases
- [ ] 0. Rules, scope, host identity, decision gate, operator authorization
- [ ] 1. Discovery & inventory
- [ ] 2. Test matrix
- [ ] 3A. Build & code integrity (isolated copy)
- [ ] 3B/C. Contract and end-to-end workflows
- [ ] 3D. AI reliability (bounded live calls)
- [ ] 3E/F. Data integrity, concurrency, resilience, restore
- [ ] 3G/H. Security, performance, retrieval, observability
- [ ] 4. Defect register + final report + cleanup

## Changes made during testing
- <none yet>

## Next step
<one actionable line>
