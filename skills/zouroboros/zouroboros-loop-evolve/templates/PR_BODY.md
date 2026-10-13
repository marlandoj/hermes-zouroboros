## {{RX_ID}} — {{TITLE}}

Opened by the Zouroboros closed loop (introspect → prescribe → evolve → **verify**). **Draft:** a human reviews and merges. The loop never merges (Constitution Art. V).

> {{PROTECTION_NOTE}}

**Defects:** {{DEFECTS}} · **Kind:** {{KIND}} · **Governor tier:** {{TIER}} ({{FLAGS}})

### Spec (what must hold after this change)
{{SPEC}}

### Why
{{RATIONALE}}

### Evidence
- Red on base `{{BASE}}`: the acceptance checks failed with the defect's own signature (see the prescription's reproduction).
- Green on head `{{HEAD}}`: acceptance checks, the repository suite (build, typecheck, Bun and Python tests, portable check) and the scope check all pass.
- Verify verdict: **{{VERDICT}}**. {{VERIFY_SUMMARY}} Report digest `{{VERIFY_DIGEST}}`.
- Diff: {{DIFFSTAT}}

Acceptance checks:
{{CHECKS}}

### Rollback (Art. IV)
{{ROLLBACK}}

### Reviewer checklist
- [ ] The change implements the spec, not just the check (Art. III).
- [ ] The new test fails on `{{BASE}}` and passes here.
- [ ] No unrelated changes; the files match the prescription's plan.
- [ ] Merge only if CI is green.
