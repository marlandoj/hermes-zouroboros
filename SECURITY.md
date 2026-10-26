# Security

Keep credentials, provider auth, live memory databases, campaign output, and board snapshots outside Git. The default Hermes profile is private to the local user. MCP uses stdio and inherits that user's filesystem authority.

Swarm execution is an explicit opt-in to unattended Hermes tooling in the selected workspace. It does not provide operating-system isolation. Use a dedicated unprivileged account/container when executing work you do not trust. Review changes and checks before publishing or deploying them.

Executor trust model: every swarm executor (Hermes and the other CLIs in `packages/swarm`) runs with the privileges of the user who started it, most with tools auto-approved. It can read and write what that user can, run commands, reach the network, and see that user's credentials and environment: environment variables, readable key files, and the credential stores of every installed CLI. Task content can come from other models (upstream task output, recalled memory, workspace files). The orchestrator passes upstream output, specialist-consult advice and the memory-gate briefing to executors as fenced data rather than instructions, and the memory-gate hook fences what it injects into the host prompt the same way; that reduces prompt injection but is not a security boundary. For anything sensitive, run the installation under a dedicated OS user or in a VM, give it scoped API keys (separate keys with spending limits and the narrowest permissions your providers offer, never personal or production keys), and keep production credentials, SSH keys and cloud admin tokens out of that account.

Factory intake is read-only and rejects schema or integrity mismatch. The optional memory-gate HTTP service binds to loopback and requires a bearer token; do not expose it publicly.

Report vulnerabilities privately through GitHub's security reporting facility if enabled, or contact the repository owner without including credentials or sensitive payloads. Never attach a live memory database to a public issue.
