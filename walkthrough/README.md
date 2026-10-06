# Install and prove one layer at a time

## 1. Build the distribution

Install Hermes Agent using its upstream instructions and authenticate the provider you intend to use. Run `bash scripts/setup.sh` from this checkout. This installs locked npm dependencies and compiles the imported source. It does not install system services, log into providers, or import existing memories.

## 2. Create an isolated profile

Create an empty work directory, then run:

```bash
bun integration/cli.ts init --workspace /absolute/workspace
bun integration/cli.ts hermes setup
bun integration/cli.ts doctor
```

`init` refuses to overwrite an existing profile. `hermes setup` configures the new profile; check its `config.yaml` still contains the generated `mcp_servers.zouroboros` entry afterward. The wrapper sets `HERMES_HOME` only for its child process, preserving the user's actual `HOME`.

To choose another data location, export `HERMES_ZOUROBOROS_HOME=/absolute/private/directory` consistently before these and subsequent commands. Defaults follow `XDG_DATA_HOME` or `~/.local/share`. Do not commit that directory.

## 3. Prove shared memory

```bash
bun integration/cli.ts memory store --entity demo --key choice --value 'Use copper widgets'
bun integration/cli.ts memory search copper
bun integration/cli.ts hermes chat
```

Ask Hermes to use `memory_search` for `copper`; it reads the same database. Keyword search is the supported default. The imported library offers embeddings and richer retrieval, but this profile makes no embedding calls.

## 4. Prepare, review, execute

Ask Hermes to call `swarm_prepare` with a short task list. It validates IDs, missing dependencies, cycles, priorities, and timeout bounds, then writes a campaign under the data directory. Inspect the JSON and the target workspace before running:

```bash
HERMES_ZOUROBOROS_ALLOW_SWARM=1 \
  bun integration/cli.ts swarm /absolute/path/to/campaign.json
```

The worker uses concurrency two, no automatic retries, and your configured Hermes provider/model. Failed tasks return nonzero. The bridge caps each Hermes call at 300 seconds by default; `HERMES_TIMEOUT` can change that outer bound, while each task retains its orchestrator timeout. Child agents cannot execute a new campaign through the MCP profile.

For an explicit model, set `HERMES_MODEL`; a `HERMES_PROVIDER` override requires a model as well. Values pass through unchanged. Keep credentials in the Hermes provider configuration or its supported environment variables.

## 5. Connect factory intake when you have a board

Follow [factory.md](../docs/factory.md) to obtain a qualified board snapshot and pinned schema manifest. Add `HERMES_ZOUROBOROS_BOARD_DIR` and `HERMES_ZOUROBOROS_MANIFEST` as absolute paths under the MCP server's `env` mapping in the generated profile. Restart Hermes, then call `factory_intake`.

The reader does not create, claim, update, or dispatch tickets. Do not substitute an arbitrary hash to silence schema rejection; qualify the board schema first.

## 6. Optional background memory gate

The default MCP connection is stdio and requires no open port or daemon. If another coding harness needs prompt-time recall or observation hooks, follow [operations.md](../docs/operations.md) to install the optional memory gate and wire the bundled hooks. This is separate from Hermes MCP.
