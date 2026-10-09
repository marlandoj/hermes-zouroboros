Install the Zouroboros Observatory from the versioned `zouroboros-observatory` package.

Requirements:

1. Confirm Bun is available (1.1 or newer). Run the package with `bunx zouroboros-observatory@0.1.0`.
2. Run `init` and `doctor --json`.
3. Detect my Zouroboros home, memory database, execution results, repository, factory telemetry, and Chronicle feed. Enable only sources that exist and are readable. Do not create sample data.
4. Keep all adapters read-only. Never expose raw absolute paths, secrets, prompt bodies, Chronicle proposal bodies, or private memory content.
5. For local use, bind only to `127.0.0.1`.
6. For remote access, set `ZOUROBOROS_OBSERVATORY_TOKEN` from my secret store, keep the dashboard on a private network or behind an authenticated proxy, and ask for approval before binding to a non-loopback address.
7. Verify the doctor, authenticated API, dashboard shell, desktop and mobile layouts, keyboard access, and loading, empty, partial, unavailable, authentication, and error states.
8. Confirm unauthenticated API requests fail with `401` when remote access is configured.
9. Report the detected modules, exact verification results, and the private URL. If any security prerequisite is unavailable, stop and report the blocker.
