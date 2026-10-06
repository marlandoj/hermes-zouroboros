# Hermes Agent integration

Hermes Agent is installed separately. This repository supplies Zouroboros source,
an isolated Hermes profile, MCP configuration, and a portable execution bridge.
It does not copy the operator’s credentials, sessions, or live VPS configuration.
Hermes Kanban is the Factory work tracker; it is separate from this agent runtime.

## One-shot bridge

```bash
HERMES_HOME=/absolute/path/to/generated-profile \
  bash integration/hermes-bridge.sh 'Summarize the workspace' /absolute/workspace
```

The bridge calls `hermes -z`, whose installed implementation emits the final
response on stdout and reports failures with a nonzero exit. The bridge also
rejects empty responses, imposes a timeout, and removes private temporary files.
It passes prompts as a single argument and uses the supplied working directory
(or the caller’s current directory). It preserves `HOME` and `HERMES_HOME`.

**Execution authority:** upstream Hermes one-shot mode automatically approves
shell/tool actions and accepts hooks. Use this bridge only for tasks authorized
for unattended execution, with an appropriately restricted OS account/workspace.
The bridge is not a sandbox or an interactive approval boundary. Merely selecting
a separate profile does not isolate filesystem or network access.

| Variable | Meaning |
| --- | --- |
| `HERMES_BIN` | Executable path/name; defaults to `hermes` on `PATH` |
| `HERMES_HOME` | Caller-selected profile; never rewritten by the bridge |
| `HERMES_TIMEOUT` | Positive integer seconds; defaults to 300 |
| `SWARM_RESOLVED_MODEL` | Highest-priority explicit model override |
| `HERMES_MODEL` | Model override when no swarm model is supplied |
| `HERMES_INFERENCE_MODEL` / `LLM_MODEL` | Further model fallbacks, in that order |
| `SWARM_PROVIDER` / `HERMES_PROVIDER` | Optional provider override, in that order |

A provider override requires an explicit model. With neither override Hermes uses
its configured defaults. The bridge does not rewrite model IDs, retry on another
provider, or source credential files. GNU `timeout`, Bash, and standard Linux
utilities are required. Failure messages omit raw provider stderr because it may
contain secrets; consult private Hermes session logs for diagnosis.

`createHermesRegistry(repoRoot, model?)` generates the swarm registry envelope
(`$schema: executor-registry/v1`, `executors: [...]`) with executor ID `hermes-vps`,
transport `bridge`, an absolute bridge path, and no hardcoded default model.
Profile initialization should write that object and select its path through
`SWARM_EXECUTOR_REGISTRY` for the swarm consumer. Child bridge runs set
`HERMES_ZOUROBOROS_ALLOW_SWARM=0` so the same MCP profile cannot recursively
dispatch more swarms through this integration.

## Native ACP

Hermes also exposes `hermes acp` and the dependency check `hermes acp --check`.
Native ACP supports persistent sessions, streamed events, cancellation, model
selection, and a host permission callback. It is a distinct transport: launching
the bridge does not establish ACP. The generated portable registry deliberately
uses the documented one-shot contract. An ACP host must implement permissions
and session lifecycle before selecting native ACP.

The workspace source includes `hermes-acp-sync.sh` / `hermes-acp-sync.py` for
Swarm ACP turns that must join delegated child work before returning. Those
adapters are separate from this distribution’s bridge and should be qualified
against the installed Hermes version before activation. Do not add
`--accept-hooks` without understanding its effect on the host’s approval policy.

## MCP consumer

Hermes reads `mcp_servers` from `$HERMES_HOME/config.yaml`. Each stdio server has
`command`, `args`, and optional `env`, `timeout`, and `connect_timeout` fields.
The generated profile is consumed by Hermes itself; the configured Bun command
starts this distribution’s MCP entrypoint and exposes Zouroboros tools.

Hermes filters environment variables passed to MCP subprocesses. Include required
state paths and credential references in each server’s `env` mapping; supported
references include `${env:VARIABLE}`. Use absolute script paths. `enabled: false`
disables a server and `tools.include` can restrict its tools. A tool exposed over
MCP still requires an authorized task before it is invoked.

The CLI/output/config contracts above were checked against the VPS’s installed
Hermes source (`hermes_cli/oneshot.py` and `tools/mcp_tool.py`). Tests use a fake
Hermes executable; they do not contact a model provider or validate live credentials.
