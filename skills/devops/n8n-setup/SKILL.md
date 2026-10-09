---
name: n8n-setup
description: "Install n8n (open-source workflow automation) as an OPTIONAL, operator-approved user service on a Linux host: local-only listener, data under the Zouroboros data directory, systemd user unit, private remote access. Use when the user asks to set up, update, check or remove n8n."
version: 1.0.0
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [devops, automation, n8n, self-hosting, Zouroboros]
    related_skills: []
prerequisites:
  commands: [node, npm, systemctl]
---

# n8n Setup (optional service)

[n8n](https://n8n.io) is an open-source workflow automation tool. Nothing in hermes-zouroboros
depends on it; install it only when the operator asks. This skill installs it as a **systemd
user service** listening on **127.0.0.1 only**, with all state in the Zouroboros data directory.
n8n is distributed under its own Sustainable Use License; the operator is responsible for
accepting it.

## Before you start

Confirm with the operator, then check:

- Node.js version supported by the n8n release you install (`node --version`; see the n8n docs).
- `systemctl --user status` works for this account. On a headless server, user services that
  must survive logout need lingering (`loginctl enable-linger "$USER"`, which may need an admin).
- Port 5678 is free (`ss -ltn 'sport = :5678'`), or choose another with `N8N_PORT`.

## Install

```bash
DATA="${ZOUROBOROS_DATA_DIR:-${HERMES_ZOUROBOROS_HOME:-$HOME/.local/share/hermes-zouroboros}}"
CONF="${ZOUROBOROS_CONFIG_DIR:-$DATA/config}"
mkdir -p "$DATA/n8n" "$CONF" "$HOME/.config/systemd/user"

# 1. Install a pinned release into a user prefix (no root, no global npm).
npm install --prefix "$DATA/n8n/app" n8n@<version>

# 2. Generate the credential-encryption key once. Keep this file: losing it makes stored
#    n8n credentials unreadable. Never print it or commit it.
umask 077
[ -f "$CONF/n8n.env" ] || printf 'N8N_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" > "$CONF/n8n.env"

# 3. Install the unit from the template, substituting the two directories.
sed -e "s|@DATA@|$DATA|g" -e "s|@CONF@|$CONF|g" \
  "${HERMES_SKILL_DIR}/references/n8n.service" > "$HOME/.config/systemd/user/n8n.service"
systemctl --user daemon-reload
systemctl --user enable --now n8n.service
```

Verify before reporting success:

```bash
systemctl --user is-active n8n.service
curl -fsS http://127.0.0.1:5678/healthz
```

## First use and remote access

- The service listens on `127.0.0.1:5678` only. Open it through a private path: an SSH tunnel
  (`ssh -L 5678:127.0.0.1:5678 <host>`), a tailnet, or an operator-managed reverse proxy with TLS
  and authentication. Do not expose n8n directly on a public interface.
- On first visit n8n asks for an owner account. The operator creates it; never choose or store
  that password for them.
- If the instance is reached through a proxy URL, set `N8N_HOST`, `N8N_PROTOCOL` and
  `WEBHOOK_URL` in `$CONF/n8n.env` so webhook URLs are correct, then restart.

## Operate

| Task | Command |
|---|---|
| Status | `systemctl --user status n8n.service` |
| Logs | `journalctl --user -u n8n.service -n 200` |
| Restart | `systemctl --user restart n8n.service` |
| Update | `npm install --prefix "$DATA/n8n/app" n8n@<new-version>` then restart |
| Back up | copy `$DATA/n8n/home` (workflows, credentials DB) and `$CONF/n8n.env` together |
| Remove | `systemctl --user disable --now n8n.service`, delete the unit file, then `$DATA/n8n` only if the operator confirms the data is no longer needed |

Read the n8n release notes before an update; take a backup first. Removing data is
irreversible and needs the operator's explicit confirmation.

## Resources

- [n8n documentation](https://docs.n8n.io/)
- [n8n community forum](https://community.n8n.io/)
- [Workflow examples](https://n8n.io/workflows/)
