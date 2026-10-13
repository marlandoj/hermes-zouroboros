# Original assessment brief (operator wording, reformatted)

The operator brief the skill implements; keep it as the source of truth for scope and rules. Wording is verbatim except that one restricted organization's name is generalized for publication.

Conduct a comprehensive, evidence-backed assessment of the entire Zouroboros platform. Determine whether its components work individually, integrate correctly, and reliably deliver their intended outcomes through actual user and automation workflows. Execute the assessment; do not stop at proposing a test plan. A running process, successful build, or passing health endpoint alone is insufficient proof of functional correctness.

## 1. ESTABLISH SCOPE AND OPERATING RULES

Read the applicable AGENTS.md instructions, project documentation, runbooks, persona memory, and relevant operational records. Identify the actual host, checkout, branch, commit, deployed revisions, and environment under test. Distinguish repository code from deployed code and intended architecture from observed behavior. Use graph-first code retrieval and check index freshness. Use semantic retrieval where appropriate, then targeted source inspection. Follow the workspace’s operation-window, swarm decision, specialist-routing, and turn-continuity requirements. Score the scoped execution plan before launching agents. Do not infer authorization for specialist model calls, swarms, or model Consensus. If the assessment exceeds a single permitted chat turn, prepare a concrete execution plan and route it through the approved campaign or Software Factory workflow. Hermes Kanban is the execution tracker for Factory work; Linear is retired. Proceed autonomously with authorized inspection and safe tests. Obtain case-specific approval only for actions that require it. Do not interpret this assessment as permission to deploy changes, modify production data, disrupt live services, send messages, place trades, or incur unbounded external costs. Use isolated environments and synthetic fixtures for mutation, recovery, security, and failure-injection tests. Keep secrets and sensitive data out of reports and tool output.

## 2. DISCOVER THE COMPLETE SYSTEM

Build an inventory from repository evidence and live runtime inspection. Do not rely solely on documentation or a predetermined checklist. For each discovered component, record:

- Purpose and expected behavior.

- Source location and deployed instance, if applicable.

- Entrypoint, concrete consumer, caller, or trigger.

- Upstream and downstream dependencies.

- Configuration and credential requirements, without exposing values.

- Existing tests, monitoring, and operational owner where documented.

- Whether it is active, retired, orphaned, duplicated, or uncertain. Inspect all applicable areas, including:

- User interfaces, Command Center, APIs, and backend services.

- Agent runtimes, personas, tools, skills, and plugins.

- Model routing, provider adapters, fallbacks, and budget controls.

- Swarm orchestration, specialist consultation, and Software Factory execution.

- Hermes Kanban intake and execution-state reconciliation.

- Memory, SQLite persistence, vector retrieval, and codebase-memory indexing.

- Schedulers, automations, workers, queues, and recovery controllers.

- External integrations, authentication, and authorization.

- Deployment, runtime configuration, storage, networking, and resource management.

- Logs, metrics, alerts, backups, restore procedures, and operational runbooks. Treat this list as a starting point. Add discovered components and justify exclusions.

## 3. BUILD A TRACEABLE TEST MATRIX

Before broad execution, create a matrix connecting every discovered component and critical workflow to its requirements and tests. Include:

- Test ID and risk priority.

- Component or workflow.

- Requirement or expected behavior.

- Environment and prerequisites.

- Test method and command or procedure.

- Explicit pass/fail criteria.

- Actual result and evidence location.

- Defect or blocker reference. Use these statuses consistently: PASS, FAIL, BLOCKED, NOT TESTED, NOT APPLICABLE. PASS requires observed evidence. Missing credentials, unavailable dependencies, skipped tests, and mocked responses do not establish live integration success. Label evidence as static inspection, isolated test, mocked integration, live integration, or end-to-end validation. Mark undocumented expectations as provisional assumptions. Prioritize critical user journeys, data integrity, authorization boundaries, and automated execution before lower-risk edge cases.

## 4. EXECUTE THE ASSESSMENT

### A. Build and code integrity

Run relevant repository checks: dependency consistency, configuration validation, linting, TypeScript compilation with tsc --noEmit, unit tests, integration tests, and builds. Record exact commands, exit codes, environment, and baseline failures. Do not disregard TypeScript errors or describe an unbuildable component as healthy.

### B. Functional and contract testing

Validate intended behavior, schemas, inputs, outputs, persistence, permissions, error handling, and compatibility between connected components. Test valid, invalid, missing, duplicate, oversized, and boundary inputs where relevant.

### C. End-to-end workflows

Discover and exercise real critical workflows from trigger to persisted outcome. Include applicable journeys such as:

- User request → persona/model selection → tool execution → response.

- Memory write → persistence → retrieval → downstream use.

- Code change → indexing → graph or semantic retrieval.

- Kanban task → intake → execution → validation → execution-state update.

- Scheduled trigger → worker → side effect → verification → completion record.

- Interrupted operation → recovery classification → evidence-based reconciliation. For each workflow, verify intermediate handoffs, final state, traceability, and failure visibility. Identify disconnected capabilities that pass local tests but have no working consumer.

### D. AI-specific reliability

Evaluate:

- Routing rules, capability constraints, and provider compatibility.

- Tool selection, argument validation, and execution boundaries.

- Context assembly, persona consistency, and memory relevance.

- Retrieval quality, freshness, provenance, and unsupported-answer behavior.

- Structured-output validation and malformed-response handling.

- Timeouts, rate limits, unavailable models, fallback behavior, and retry limits.

- Prompt injection through retrieved content, files, tool output, and inbound messages.

- Unauthorized actions, sensitive-data exposure, and permission enforcement.

- Token, cost, latency, and runaway-loop controls. Use representative evaluation cases with explicit scoring criteria. Repeat nondeterministic tests sufficiently to expose inconsistency; report sample sizes and limitations. Do not treat one successful model response as proof of reliability.

### E. Data integrity and concurrency

Test migrations, transactions, locks, duplicate delivery, idempotency, races, partial writes, stale state, and reconciliation where applicable. Verify that retries and recovery do not duplicate external effects or silently lose work.

### F. Resilience and recovery

In an isolated environment, test dependency outages, process interruption, restart, queue backlog, expired credentials, network failures, and resource constraints. Verify bounded retries, backoff, durable checkpoints, recovery-controller behavior, and operator-visible failure states. Test backup restoration into a disposable destination. Backup existence alone does not establish recoverability.

### G. Security and privacy

Inspect authentication, authorization, least privilege, tenant or session isolation, secret handling, input validation, dependency risks, and sensitive-data retention. Use safe negative tests to demonstrate that prohibited actions are rejected. Preserve confidentiality requirements, including restricted-organization correspondence handling and email-lane restrictions.

### H. Performance and observability

Measure representative latency distributions, throughput, errors, resource use, queue delay, and AI cost where available. Compare against documented targets. If targets do not exist, report measured baselines and propose provisional thresholds; do not invent an SLA. Verify that logs, metrics, traces, and alerts reveal failures and support diagnosis without leaking secrets. Exercise alert delivery only through an authorized test destination.

## 5. HANDLE FAILURES SYSTEMATICALLY

For every defect, record:

- Severity and affected workflow.

- Expected versus observed behavior.

- Reproduction steps and sanitized evidence.

- User or operational impact.

- Root cause, or a clearly labeled hypothesis.

- Recommended correction and verification procedure. Distinguish pre-existing failures, regressions, environmental blockers, flaky tests, and observability gaps. You may add isolated test harnesses and fixtures needed for this assessment. Keep product fixes separate from the baseline audit. Apply them only within authorized scope, preserve the original failure evidence, and rerun the relevant checks after any correction. Do not weaken assertions or alter expected outcomes merely to obtain passing results.

## 6. PRESERVE AUDIT EVIDENCE

Maintain PROGRESS.md for the assessment with completed phases, current status, actionable blockers, and the next step. Preserve durable reports and useful test artifacts in the active project. Put disposable builds, downloads, and test scratch in the designated temporary location. Record:

- Tested revisions and environment.

- Commands, results, and sanitized logs.

- Test matrix and workflow traces.

- Defect register.

- Measurements and evaluation datasets.

- Changes made during testing.

- Remaining work and resumable checkpoints. Display human-facing times in America/Phoenix, adding UTC when needed to correlate logs.

## 7. DELIVER A COMPLETE FINAL REPORT

Provide: 1. Executive verdict and its evidence-based limits. 2. Discovered architecture and dependency map. 3. Component health and test coverage matrix. 4. Critical end-to-end workflow results. 5. Detailed findings ranked by severity. 6. AI reliability, security, performance, and recovery results. 7. Exact evidence and reproduction references. 8. Untested areas, blockers, exclusions, and residual risks. 9. Prioritized remediation plan and acceptance criteria. 10. Repeatable commands or harnesses for regression testing. Report results against the discovered inventory: counts of components, critical workflows, and tests that passed, failed, were blocked, or were not tested. Explain coverage denominators. Test counts alone do not demonstrate comprehensive coverage. State which capabilities were proven through real execution, which were assessed only through inspection or mocks, and which remain unverified. Do not claim that “everything works” unless the defined scope and critical acceptance criteria support that conclusion. A completed assessment may still conclude that the platform is unhealthy or insufficiently verified. Begin with discovery, then execute the assessment in risk-prioritized phases and provide concise progress updates throughout.
