---
name: autoloop
description: "Autonomous single-metric optimization loop (autoresearch style): an agent proposes a change to one target file, the loop commits it on a dedicated git branch, runs the experiment, measures the metric, and keeps or reverts it until a limit is reached. Use to iteratively improve a benchmark, test pass rate, latency, size or score with a reproducible run command."
version: 1.0.0-hermes.1
author: Zouroboros
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Zouroboros, Optimization, Experiments, Automation]
    related_skills: [tier-resolver, zo-swarm-executors, zo-memory-system]
prerequisites:
  commands: [bun, git, bash, timeout]
---

# Autoloop

Each iteration proposes a change, commits it, runs the experiment, measures the metric, and then
keeps or discards the commit. Proposals come from a one-shot Hermes Agent (`hermes-vps` in the
profile's executor registry) that sees the objective, the metric history and the target file. It
must reply with `HYPOTHESIS: ...` and the full new file in a code block.

## Safety model: read before running

- The loop **executes the program's setup, run and metric commands** and **rewrites the target
  file** with model output. Review `program.md` and run it only in a disposable branch or clone.
- It creates `autoloop/<name>-<date>` and uses `git reset --hard HEAD~1` on that branch to discard
  regressions. Commit or stash your own changes first.
- Execution is opt-in: `HERMES_ZOUROBOROS_ALLOW_SWARM=1` is required (as for swarm runs).
  `--dry-run` only parses the program.
- The proposing agent runs with `HERMES_ZOUROBOROS_ALLOW_SWARM=0` and cannot start swarms.

## program.md

````markdown
# Program: Faster Sort

## Objective
Minimize the runtime of sort.ts on the benchmark input.

## Metric
- **name**: runtime_ms
- **direction**: lower_is_better
- **extract**: `grep "Time:" out.txt | awk '{print $2}'`

## Setup
```bash
bun install
```

## Target File
sort.ts

## Run Command
```bash
bun bench.ts > out.txt
```

## Read-Only Files
- bench.ts

## Constraints
- **Time budget per run**: 60
- **Max experiments**: 20
- **Max duration**: 1

## Stagnation
- **Threshold**: 5
- **Double threshold**: 10
- **Triple threshold**: 15

## Notes
Keep the public function signature unchanged.
````

`direction` is `lower_is_better` or `higher_is_better`. The extract command must print one number.
A run that exits non-zero, or a metric that is not a number, counts as a crash. The agent then
gets up to three attempts to fix it.

## Run

```bash
A="${HERMES_SKILL_DIR}/scripts/autoloop.ts"
bun "$A" --program path/to/program.md --dry-run
HERMES_ZOUROBOROS_ALLOW_SWARM=1 bun "$A" --program path/to/program.md   # --executor <id> --resume
```

Outputs, written next to `program.md` (add them to `.gitignore`):

- `results.tsv`: commit, metric, status (keep/discard/crash), hypothesis, time, duration;
- `autoloop-summary-<name>.md`: stop reason, best result, top improvements, crash log.

The loop stops at **max experiments**, **max duration** or the **triple stagnation** threshold.
At the first two stagnation thresholds it switches the agent to exploratory and then radical
proposals.

The proposing model comes from the `tier-resolver` catalog when it has a non-empty id. Otherwise
the Hermes profile's model is used. Record notable results with `zo-memory-system`.
