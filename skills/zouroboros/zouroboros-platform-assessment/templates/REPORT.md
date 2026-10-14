# Zouroboros platform assessment — final report (<YYYY-MM-DD>)

Assessed <start>–<end> MST (<UTC>), by <agent/model> on host <host>. Companion files: `TEST-MATRIX.md`, `DEFECTS.md`, `PROGRESS.md`, `evidence/`.
Baseline for comparison: the previous assessment's `REPORT.md`, if any.

## 1. Executive verdict
<One-paragraph verdict, then its evidence-based limits: scope excluded, sample sizes, unverified areas. Never claim "everything works" unless every critical acceptance criterion passed.>

## 2. Scope, environment and revisions
## 3. Architecture and dependency map (observed)
## 4. Component health and coverage (denominator: N discovered components)
<Table: component | status | proven by (S/I/M/L/E) | health. Then the coverage split: proven by real execution / isolated or unit only / inspection only / N/A.>
## 5. Critical end-to-end workflows (denominator: N)
<W1 user request → model → tool → response; W2 memory write → persist → retrieve → downstream use; W3 code change → index → retrieval; W4 Kanban task → intake → execution → validation → state; W5 scheduled trigger → side effect → verification → record; W6 interruption → recovery → reconciliation; W7 campaign prepare → execute → evaluate; W8 backup → restore → consumer verification. Plus any new ones.>
## 6. Findings by severity
## 7. AI reliability, security, performance and recovery results
<Include sample sizes, baselines and provisional thresholds (no invented SLAs).>
## 8. Evidence and reproduction references
## 9. Untested areas, blockers, exclusions, residual risks
## 10. Prioritized remediation plan and acceptance criteria
## 11. Regression commands and harnesses
## 12. Counts (from matrix-totals.py) and what they do and do not prove
## 13. Change since baseline
<Defects fixed, defects still open, new defects, coverage gained or lost.>
