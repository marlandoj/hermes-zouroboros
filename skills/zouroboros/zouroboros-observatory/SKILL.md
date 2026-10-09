---
name: zouroboros-observatory
description: Install, configure, diagnose, and verify the portable Zouroboros Observatory (read-only telemetry dashboard for memory, workflow results, repository, factory and Chronicle sources) on a Bun-capable Linux or macOS host. Use when the user asks to add an Observatory, inspect supported telemetry modules, run a private dashboard, or troubleshoot Observatory startup and data-source detection.
version: 1.0.0
author: Zouroboros
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Zouroboros, Observability, Dashboard, Telemetry]
    related_skills: [classifier-fallback]
prerequisites:
  commands: [bun]
---

# Zouroboros Observatory

Use the versioned `zouroboros-observatory` npm package as the implementation source. Do not regenerate dashboard code from prose, and do not copy another operator's private routes or dashboards.

## Install

1. Confirm Bun is available (`bun --version`, 1.1 or newer).
2. Run the package without a global install: `bunx zouroboros-observatory@0.1.0 <command>`. To use the unpinned latest release instead, say so and confirm with the user first.
3. Run `init`, then `doctor --json`.
4. Enable only the sources the doctor detects. Missing sources must stay `unavailable`. Never seed demonstration data.
5. Keep the default `127.0.0.1` bind for local use: `start --host 127.0.0.1 --port 4178`.

## Configure

Point the adapters at sources with environment variables. In a hermes-zouroboros profile, reuse the paths the distribution already exports, for example `ZOUROBOROS_MEMORY_DB`.

- `ZOUROBOROS_HOME`: Observatory config directory (default `~/.zouroboros`)
- `ZOUROBOROS_MEMORY_DB`
- `ZOUROBOROS_RESULTS_DIR`
- `ZOUROBOROS_REPO`
- `ZOUROBOROS_FACTORY_DIR`
- `ZOUROBOROS_CHRONICLE_PATH`
- `ZOUROBOROS_INSTANCE_NAME`
- `ZOUROBOROS_OBSERVATORY_TOKEN`: bearer token. Without it, the server refuses non-loopback binds.

Never print environment values, tokens, absolute user paths, prompt bodies, or private memory content. The package emits normalized source labels and aggregate evidence only.

## Remote access

Keep the dashboard private:

1. Set `ZOUROBOROS_OBSERVATORY_TOKEN` from the host's secret store, never from a committed file or a URL.
2. Prefer exposing only through a private network (VPN or tailnet) or an authenticated reverse proxy. Do not publish a public route.
3. Present the deployment effect and get explicit approval from the user before binding to a non-loopback address.

The package also has `export --target zo-site`, which only applies to Zo Computer hosts. Do not use it on Hermes hosts.

## Verify

- Run `doctor --json` and require no failed checks.
- Start the server and verify `/api/health`, `/api/snapshot`, and the browser shell.
- Confirm an unauthenticated API request returns `401` when token protection is enabled.
- Check desktop and mobile layouts, keyboard navigation, loading, empty, partial, unavailable, authentication, and error states.
- Confirm all six modules render even when some sources are absent.
- Confirm the snapshot JSON (`snapshot --json`) contains no absolute paths or private content.
- Name the consumer and URL before reporting completion.

Fail closed when authentication, configuration evidence, or the built UI is unavailable.

`assets/install.prompt.md` is a copy-paste install prompt with the same steps.
