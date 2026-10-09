---
name: destructive-op-guard
description: "Advisory guardrail for destructive/teardown operations. A Hermes shell hook watches terminal commands and, when one matches a teardown pattern (cloud server/service/IP delete, rm -rf, git push --force, terraform destroy, DROP/dropdb), reminds the agent on its next turn to run a workspace reference sweep for the removed identifier. Includes sweep-refs.sh to grep the workspace and classify each hit as live-config vs log/doc."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [safety, hooks, infrastructure, teardown, Zouroboros]
    related_skills: []
prerequisites:
  commands: [bash, jq]
---

# destructive-op-guard

Mechanical companion to the "verify references against ground truth" discipline. Direct
destructive operations (for example deleting a cloud server by name) bypass every planning
gate, so nothing reminds the agent to confirm that no live configuration still points at the
removed resource. This skill closes that gap.

## Components

### 1. Advisory hook — `scripts/post-destructive-sweep-hook.sh`

Speaks the Hermes shell-hook protocol. Fail-open, never blocks, always exits 0. Register it
for two events in the profile's `config.yaml`; Hermes asks for consent on first use (or set
`hooks_auto_accept: true` for unattended gateways):

```yaml
hooks:
  post_tool_call:
    - matcher: terminal
      command: "/absolute/path/to/checkout/skills/software-development/destructive-op-guard/scripts/post-destructive-sweep-hook.sh"
      timeout: 5
  pre_llm_call:
    - command: "/absolute/path/to/checkout/skills/software-development/destructive-op-guard/scripts/post-destructive-sweep-hook.sh"
      timeout: 5
```

- **`post_tool_call`:** a fast pre-filter lets benign commands exit immediately. A genuinely
  destructive command is recorded as a pending reminder for the session under
  `$ZOUROBOROS_STATE_DIR/destructive-op-guard/`.
- **`pre_llm_call`:** if a reminder is pending, it is injected once as context and cleared.

Hermes ignores `post_tool_call` output, so the reminder arrives at the start of the next turn
rather than immediately after the command. When you run a destructive command yourself, do the
sweep in the same turn without waiting for the reminder.

Patterns watched: `hcloud <resource> delete`, `aws|gcloud|az|doctl|flyctl|kubectl … delete|destroy`,
`rm -r`/`rm -f`/`rm -rf`, `git push … --force`/`-f`, `terraform destroy`,
`DROP TABLE|DATABASE|SCHEMA`, `dropdb`, `systemctl disable --now`.

### 2. Reference sweep — `scripts/sweep-refs.sh <identifier> [<identifier2> ...]`

After a teardown, greps the workspace (`SWEEP_ROOT`, else `ZOUROBOROS_WORKSPACE`, else the
current directory) for each removed identifier and classifies every hit:

- `[LIVE]` config (`.json`/`.mcp.json`/`.env`/`.service`/`.yml`/`.tf`) — a live dependency, **fix**.
- `[code]` (`.ts`/`.js`/`.sh`/`.py`) — could be a live caller **or** reprovision-path source, **review**.
- `[log]`/`[doc]` — historical, **leave**.

Exit 1 when any config/code hit needs review, 0 when clean. Example:

```bash
bash "${HERMES_SKILL_DIR}/scripts/sweep-refs.sh" 203.0.113.10 <resource-id> old-box-name
```

## Controls and rollback

- Kill switch: `DESTRUCTIVE_OP_GUARD_OFF=1` in the profile environment.
- Rollback: remove both hook entries from the profile's `config.yaml`. The hook is advisory
  only; removing it changes nothing about tool execution.
