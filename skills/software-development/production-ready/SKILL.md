---
name: production-ready
description: "Production-readiness audit for AI-generated web apps and SaaS products. Runs an 18-domain audit (legal, secrets, auth, API safety, OWASP, abuse/rate-limits, frontend exposure, logging, accessibility, performance, payments, file uploads, database, AI-code failure modes, browser testing, concurrency/state integrity, visual consistency, SEO/AEO) against a code repo and/or live URL, produces a coverage-aware launch verdict (Do Not Launch / Private Beta Only / Launch with Monitoring / Launch-Ready; an incomplete audit can never be Launch-Ready), and emits JSON, Markdown and HTML reports plus copy-paste remediation prompts. Use before launching or when asked whether an app is production ready."
version: 1.0.0
license: MIT
metadata:
  protocol: vibeshield-derived
  hermes:
    tags: [software-development, security, audit, launch-readiness, Zouroboros]
    related_skills: [ask-governor, visual-verifier, ponytail-review]
prerequisites:
  commands: [bun]
---
# Production Ready

A repeatable, evidence-based launch readiness audit. Inspired by the Vibeshield protocol — extended with executable tooling, deeper checks, copy-paste remediation prompts, and a CI-friendly output format.

## Core rule

**Do not assume AI-generated code is safe because it runs.**

A passing test suite, a green CI badge, and a clean local browser tab tell you the code *executes*. They tell you nothing about whether it will leak secrets, accept arbitrary user input, expose admin routes, drain your wallet to a billing-loop, or fail WCAG. This skill exists to surface those gaps before launch.

## Quick start

```bash
# Audit a local repo (uses installed tools, falls back to heuristic checks)
bun "${HERMES_SKILL_DIR}/scripts/audit.ts" --repo /path/to/repo

# Audit a deployed URL (adds DAST, performance, a11y, CSP checks)
bun "${HERMES_SKILL_DIR}/scripts/audit.ts" --url https://example.com

# Both — full audit
bun "${HERMES_SKILL_DIR}/scripts/audit.ts" \
  --repo /path/to/repo \
  --url https://example.com \
  --out /tmp/audit \
  --format all
```

## Commands

```bash
S="${HERMES_SKILL_DIR}/scripts"

# Full audit (all 18 domains)
bun "$S/audit.ts" [--repo PATH] [--url URL] [--out DIR] [--format json|md|html|all]

# Single domain (any of):
bun "$S/audit.ts" --repo . --only secrets
bun "$S/audit.ts" --repo . --only owasp
bun "$S/audit.ts" --url https://example.com --only accessibility
bun "$S/audit.ts" --url https://example.com --only performance
bun "$S/audit.ts" --repo . --only ai-code
# ... etc

# List all domains
bun "$S/audit.ts" --list

# Show the launch verdict logic
bun "$S/verdict.ts" --explain

# Generate a remediation prompt pack from a previous audit
bun "$S/prompts.ts" --audit /tmp/audit/findings.json
```

## The 18 audit domains

| # | Domain | What it checks | Tools used (fallback: heuristic) |
|---|--------|----------------|----------------------------------|
| 1 | **Legal & Data Handling** | Privacy policy, ToS, data retention/deletion/export, third-party sharing disclosures | Manual checklist + repo grep for `privacy`/`gdpr`/`ccpa` |
| 2 | **Secrets & Credential Exposure** | Frontend key leaks, unsafe env vars, exposed tokens, rotation | `gitleaks`, `trufflehog`, repo bundle scan |
| 3 | **Authentication & Authorization** | Server-side auth, ownership checks, role gates, admin protection, session safety | `semgrep` rulesets + auth pattern grep |
| 4 | **API Route Safety** | Input validation, method controls, rate limits, CORS, abuse paths | `semgrep`, route grep, OpenAPI lint |
| 5 | **OWASP Baseline** | XSS, CSRF, SSRF, IDOR, injection, security headers, dependency CVEs | `semgrep` + `osv-scanner` + `nuclei` (if URL) |
| 6 | **Abuse, Cost & Rate Limits** | Throttling, payload caps, bot friction, billing-loop protection | Route grep + middleware detection |
| 7 | **Frontend Exposure** | Bundle leaks, localStorage secrets, sourcemaps, network exposure | Source bundle scan + `gitleaks` on `dist/` |
| 8 | **Logging & Monitoring** | Privacy-safe logs, uptime checks, alerts, audit trails | Logger config grep + PII pattern scan |
| 9 | **Accessibility** | WCAG 2.2 AA — keyboard, labels, contrast, screen-reader, motion | `axe-core` CLI + `pa11y` (if URL) |
| 10 | **Performance & Reliability** | Bundle size, caching, indexes, loading states, backups, timeouts, rollbacks | `lighthouse` (Core Web Vitals) + repo heuristics |
| 11 | **Payments & Webhooks** | Stripe signature verification, idempotency, entitlement logic, secret handling | Stripe pattern grep + webhook handler audit |
| 12 | **File Upload Safety** | Size/type validation, ownership checks, signed URLs, quotas, content sniffing | Upload handler grep |
| 13 | **Database & Data Access** | RLS, tenant scoping, parameterized queries, indexes, audit trails, backups | Schema/query grep + RLS policy check |
| 14 | **AI-Generated Code Failure Modes** | Silenced errors, dead code, fake-passing tests, weakened security, brittle abstractions | Custom heuristic scan (`try: pass`, `assert True`, commented auth) |
| 15 | **Manual Browser Testing** | Sign-in flows, role boundaries, admin paths, mobile UX, protected routes | Generates a manual test checklist tailored to the app |
| 16 | **Concurrency & State Integrity** | Race conditions, transaction isolation, idempotency keys, double-submit, stale-read-after-write | Repo heuristics + concurrency-pattern grep |
| 17 | **Visual Consistency** | Layout drift, color/spacing token adherence, responsive breakage, orphan components | Repo heuristics + snapshot diff (if available) |
| 18 | **SEO / AEO (Search & Answer-Engine Visibility)** | RFC 9309 robots.txt, sitemap reachability, title/meta-description/canonical/hreflang/OG, JSON-LD structured data parity, robots-meta noindex intent, AI-bot policy | `curl` (HTML head + robots/sitemap) + `lighthouse` SEO category (optional) |

## Required inputs

The audit script will use whatever it can find. To get a complete report, provide:

- **App name & purpose** — `--name "FooApp" --purpose "personal finance tracker"`
- **Tech stack** — auto-detected from `package.json`, `pyproject.toml`, `go.mod`, etc.
- **Deployment platform** — auto-detected from `vercel.json`, `netlify.toml`, `Dockerfile`, etc.
- **Database / auth / payment providers** — detected from deps; supplement with `--config audit.config.json`
- **Code repo path** — `--repo`
- **Public or staging URL** — `--url`
- **Special surfaces** — `--has-user-data --has-uploads --has-admin --has-ai --has-payments`

See `references/audit-config-schema.md` for the full optional config file.

## Outputs

Every audit produces, in `--out` (default: a new timestamped directory under
`$ZOUROBOROS_STATE_DIR/production-ready/`, falling back to the hermes-zouroboros profile's
`state/` directory; an `--out` inside the skill directory is refused):

- `findings.json` — machine-readable, full finding records
- `report.md` — human-readable report (this is what you ship to stakeholders)
- `report.html` — standalone HTML (open in a browser or attach to a review)
- `verdict.json` — single-decision summary (verdict, blockers, scores)
- `prompts/` — one copy-paste remediation prompt per critical/high finding, formatted for Claude Code / Cursor / Aider

## Launch verdicts

The verdict is the **worst of two gates**: a findings gate (what problems were found) and a coverage gate (did the audit actually look). Run `bun "${HERMES_SKILL_DIR}/scripts/verdict.ts" --explain` for the full model.

Findings gate:

| Verdict | Trigger |
|---------|---------|
| **🟢 Launch-Ready** | 0 critical, 0 high, ≤ maxMedium (default 3, tunable via risk profile) |
| **🟡 Launch with Monitoring** | 0 critical, 0 high, but medium findings present that should be tracked post-launch |
| **🟠 Private Beta Only** | 0 critical, 1+ high findings — invite-gated launch acceptable |
| **🔴 Do Not Launch** | Any critical (hard blocker) finding |

Coverage gate (caps the verdict — a clean-but-blind scan is NOT a pass):

| Cap | Trigger |
|-----|---------|
| **🟠 Private Beta Only** | ≥ 2 core scanners missing (gitleaks/semgrep/osv-scanner), or a security-critical domain errored |
| **🟡 Launch with Monitoring** | 1 core scanner missing, partial domain coverage, no `--url`, or critical manual checks not signed off (`--manual-verified`) |

## Hard blockers (always critical)

1. Private API keys or service-role keys exposed in frontend or repo
2. Unprotected admin routes (no auth or auth bypassable)
3. Cross-tenant data access (user A can read user B's data)
4. Public paid-API endpoint with no rate limit or auth (billing loop)
5. Unverified payment webhooks (no signature check)
6. PII / secrets written to logs without redaction
7. Unsafe file uploads (no type/size validation, no isolation)
8. Database accessible from frontend with broad permissions (e.g., `anon` can `select *`)

The audit short-circuits to **Do Not Launch** if any hard blocker is detected.

## Tooling

The skill prefers real static-analysis tools when installed and falls back to repo-scoped heuristic scanners. To unlock the full audit, install:

```bash
# Required for most checks
brew install gitleaks osv-scanner semgrep
npm install -g lighthouse pa11y @axe-core/cli

# Optional — DAST against live URL
brew install nuclei
docker pull ghcr.io/zaproxy/zaproxy:stable

# Optional — container/IaC scanning
brew install trivy
```

The `scripts/audit.ts` script auto-detects which tools are present and records each tool's resolved path (or `null`) under `tooling` in `findings.json`.

## Triage layer (FP cut)

Heuristic-source findings (the in-process regex scanners) have a meaningful false-positive rate — most commonly when the rule matches its own definition inside the skill's own source, or matches a documentation string. Two-stage triage cuts this.

```bash
# Stage 1: deterministic reproduce-the-finding (no LLM, no cost)
bun "${HERMES_SKILL_DIR}/scripts/audit.ts" --repo . --triage

# Stage 2 (opt-in): + governed multi-model quorum on survivors at severity >= medium
PRODUCTION_READY_TRIAGE_MODELS=model-a,model-b,model-c \
  bun "${HERMES_SKILL_DIR}/scripts/audit.ts" --repo . --triage --consensus
```

**Stage 1 (reproduce)** re-reads the file/line of each heuristic finding and drops obvious FPs:
- match inside a comment (skipped for rules that target comments by design)
- match inside a block comment
- match inside a regex literal (the rule matching itself)
- match inside a `description:` / `message:` / `title:` / `remediation:` string property
- match in a markdown documentation file
- match inside a `rule.id` / `check.name` / `finding.title` definition

**Stage 2 (consensus)** is opt-in (`--consensus`). Each vote is one governed one-shot call through the `ask-governor` skill, which runs the Hermes profile's executor, so the provider, credentials and model routing come from the profile; the skill holds no API key and calls no vendor endpoint itself. The panel is `PRODUCTION_READY_TRIAGE_MODELS` (comma-separated model ids the profile's provider can serve). List at least two, ideally three non-reasoning instruct models from distinct families, so failures are not correlated. With fewer than two models the quorum cannot form, so the pass is skipped and findings keep their severity. Calls use the `production-ready-triage` governor budget (`PRODUCTION_READY_TRIAGE_BUDGET`, default 300 per day). If the model layer is unavailable (no profile or executor, budget exhausted, circuit open), the first failure stops further calls and the remaining findings are kept at their original severity. This needs a hermes-zouroboros checkout with an initialized profile.

Decision policy:
- **2+ vote `real`** → keep at original severity
- **2+ vote `fp`** → drop (recorded in `triage-dropped.json`)
- **genuine split** among 2+ responders → downgrade one severity tier, mark `needsHumanReview`
- **fewer than 2 responses** → keep at original severity (consensus inconclusive, no penalty)

Tool-sourced findings (`gitleaks`, `semgrep`, `osv-scanner`, etc.) are never triaged away — those signals are already verified.

In the source workspace, triage cut a self-audit from 7 high findings to 0 without losing the hard blockers of a deliberately vulnerable test app (5 critical and 7 high preserved).

## Godmode

Pass `--godmode` to:

1. Run every check, even ones that need a live URL (will note "URL not provided" rather than skip)
2. Apply experimental AI-code heuristics (slower, higher false-positive rate, catches more)
3. **Auto-enable `--triage`** (reproduce pass) to cut FPs from the broader rule set
4. Generate copy-paste prompts for *every* finding, not just critical/high
5. Open the HTML report in your browser (via `xdg-open` / `open`) when finished
6. Drop a `LAUNCH_CHECKLIST.md` in the audited repo root for stakeholder sign-off

```bash
bun "${HERMES_SKILL_DIR}/scripts/audit.ts" --repo . --url https://staging.foo.app --godmode
```

## CI integration

A GitHub Actions workflow template ships at `templates/audit.yml`. Copy the skill into the target
repo (default location `tools/production-ready/`, or set `AUDIT_DIR`) and add the workflow:

```bash
mkdir -p /path/to/your/repo/tools /path/to/your/repo/.github/workflows
cp -r "${HERMES_SKILL_DIR}" /path/to/your/repo/tools/production-ready
cp "${HERMES_SKILL_DIR}/templates/audit.yml" /path/to/your/repo/.github/workflows/production-ready.yml
```

It runs the skill's regression tests and the audit on every PR, posts the verdict as a PR comment, uploads the reports as an artifact, and fails the build on **Do Not Launch**. Third-party actions are pinned to full commit SHAs. CI runs never use `--consensus`.

## References

- `references/owasp-top-10.md` — OWASP 2021 + API Security 2023 + LLM Top 10
- `references/tool-reference.md` — Every CLI tool used, with install + invocation
- `references/ai-failure-modes.md` — Cataloged AI-generated-code antipatterns
- `references/production-checklist.md` — Google SRE + AWS WAF + GitLab merged
- `references/compliance.md` — SOC 2 / GDPR / CCPA / PCI-DSS starter requirements
- `references/audit-config-schema.md` — Full `audit.config.json` schema

## Exit codes

- `0` — Launch-Ready
- `1` — Launch with Monitoring
- `2` — Private Beta Only
- `3` — Do Not Launch
- `10` — Audit error (script crashed, tool failed, missing inputs)

CI pipelines should fail on `>= 2`. Internal teams may choose to fail on `>= 1`.
