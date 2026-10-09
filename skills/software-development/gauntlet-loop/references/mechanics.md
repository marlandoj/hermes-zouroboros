# Gauntlet Loop Mechanics

## Sources

- Matt Shumer, "How to Run a Gauntlet Loop," Something Big, July 27, 2026: https://somethingbig.ai/gauntlet-loop
- Matt Shumer, Claude of Duty prompt: https://github.com/mshumer/Claude-of-Duty/blob/main/prompt.md

Sources reviewed on 2026-08-16. This reference paraphrases the method rather than reproducing the source prompt.

## Portable method

| Mechanic | Operational meaning |
| --- | --- |
| Goal over implementation | State the destination and constraints; let the lead agent choose the route. |
| Inspectable quality bar | Compare against a real artifact, reproducible test, target, implementation, or approved rubric. |
| Lead-agent decomposition | Split the artifact into the smallest components that can be improved and judged independently. |
| Builder-critic separation | A builder creates; a different critic with fresh context judges. |
| Actual-artifact inspection | Judge pixels, running behavior, measurements, tests, or final prose, not the builder's explanation. |
| Blind comparison | Hide candidate identity and randomize ordering when practical. |
| Largest-gap feedback | When the candidate loses, identify the most meaningful remaining gap and address it next. |
| Repeated passes | Continue while evidence supports a useful next step, not for a nominal number of rounds. |
| Progress visibility | Maintain a compact live view of artifacts, evidence, verdicts, gaps, and resource use. |
| Integration smoothing | After components improve, inspect the complete artifact and repair coherence problems. |

## Select a quality bar

Choose the strongest bar the critic can actually inspect, not the most impressive name.

| Artifact | Strong bars |
| --- | --- |
| Visual product or game | Matched screenshots or recordings from category-leading products under comparable states and viewports. |
| Website or application | Reference products plus task-completion recordings, responsive screenshots, and accessibility or performance thresholds. |
| Backend system | A reference implementation, conformance suite, latency target, failure-recovery test, load test, and security checks. |
| Writing | Representative passages with the desired clarity and compression plus factual and structural checks. |
| Research | Primary-source coverage, reproducible analysis, a benchmark report, and adversarial claim verification. |
| Campaign or strategy | A real category-leading campaign plus measurable audience, conversion, or distribution targets. |

Reject vague bars such as "excellent," "production-ready," or "AAA" unless they are backed by concrete references or measurements. A difficult bar may still be useful because it supplies direction and prevents premature stopping.

## Source-specific details

Claude of Duty used a Three.js game, Call of Duty screenshots, Claude Code, subagents, and ultracode. The portable method is not tied to that domain or vendor. Equivalent harnesses and bars are valid when they provide tool use, isolated contexts, actual-artifact inspection, and independent criticism.

## Bounded adaptation

The source rejects arbitrary fixed round counts and expects operator judgment or resource exhaustion to end a run. Preserve that pressure while requiring:

- a frozen incumbent and rollback reference;
- explicit authority and protected state;
- a time, cost, or operator-stop boundary plus a no-progress stop;
- working evidence separated from fresh or held-out acceptance evidence;
- fail-closed invalid-evidence handling;
- whole-artifact verification after component work;
- terminal states that distinguish success, regression, stagnation, exhaustion, approval, blockage, and cancellation.

These controls bound execution without weakening the core loop.

## Invalid implementations

- The builder grades its own output or writes the critic's evidence.
- The critic receives the builder's rationale before judging.
- The critic sees a summary rather than the actual artifact.
- A vague adjective is treated as the quality bar.
- Parallel builders share overlapping write scope or mutate the same evidence.
- A blended score hides a failed hard requirement.
- A local improvement is accepted while the integrated artifact regresses.
- Missing evidence becomes a score or success.
- The loop runs without a no-progress, cost, time, or operator-stop boundary.
- A product-level win directly rewrites or promotes the workflow that produced it.
