# Security

Keep credentials, provider auth, live memory databases, campaign output, and board snapshots outside Git. The default Hermes profile is private to the local user. MCP uses stdio and inherits that user's filesystem authority.

Swarm execution is an explicit opt-in to unattended Hermes tooling in the selected workspace. It does not provide operating-system isolation. Use a dedicated unprivileged account/container when executing work you do not trust. Review changes and checks before publishing or deploying them.

Factory intake is read-only and rejects schema or integrity mismatch. The optional memory-gate HTTP service binds to loopback and requires a bearer token; do not expose it publicly.

Report vulnerabilities privately through GitHub's security reporting facility if enabled, or contact the repository owner without including credentials or sensitive payloads. Never attach a live memory database to a public issue.
