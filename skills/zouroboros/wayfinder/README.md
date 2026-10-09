# Wayfinder

**Find the relevant skill at prompt time, in Hermes and six other coding agents.**

Wayfinder searches the installed `SKILL.md` catalog when a prompt is submitted. One local ranking
engine serves Hermes, Claude Code, Codex CLI, Kimi Code, Gemini CLI, OpenCode and Pi. Start in
shadow mode to inspect suggestions. Switch to live when you want the agent to see them.

## How it works

1. A native hook or a small plugin extracts the user prompt.
2. BM25 keyword scoring shortlists up to 20 skill descriptions.
3. FlashRank reranks the shortlist with `ms-marco-MiniLM-L-12-v2`.
4. Shadow mode records the proposed skill locally. Live mode adds one advisory note with the
   skill's name, path and short description.
5. The agent decides whether to read the skill. Wayfinder never runs a skill, authorizes a tool or
   blocks a prompt.

Ranking uses no generative model or inference API. The model is downloaded once during explicit
setup. Prompt hooks use only cached model files, and fail open if the files are missing. The agent
still uses its own configured provider, and any live suggestion becomes part of that agent's
context. The flow is drawn in [docs/workflows.md](docs/workflows.md).

## One engine, seven harnesses

| Harness | Entry point | Live delivery | Configuration scope |
| --- | --- | --- | --- |
| Hermes | `pre_llm_call` plugin | Current-turn user context (`{"context": ...}`) | `<profile>/plugins/wayfinder` and `plugins.enabled` in an explicitly named profile |
| Claude Code | `UserPromptSubmit` | `additionalContext` | Project `.claude/settings.json` |
| Codex CLI | `UserPromptSubmit` | `additionalContext` | Project `.codex/hooks.json`; interactive hook trust applies |
| Kimi Code | `UserPromptSubmit` | Hook `message`; accepts content-part prompts | User `~/.kimi-code/config.toml` |
| Gemini CLI | `BeforeAgent` | `additionalContext` | User `~/.gemini/settings.json` |
| OpenCode | `chat.message` plugin | Synthetic text part with session, message and part IDs | User `~/.config/opencode/plugin/wayfinder.js` |
| Pi | `before_agent_start` extension | Hidden custom message | User `~/.pi/agent/extensions/wayfinder.ts` |

The adapters were written against Claude Code 2.1, Codex 0.156, Kimi 0.41, Gemini 0.58,
OpenCode 1.18, Pi 0.85 and Hermes 0.16. Harness APIs change, so check a new version in shadow
mode before relying on live mode. See [docs/validation.md](docs/validation.md) for how to validate an installation.

## Install

Linux prerequisites:

- Python 3.11+, Bash, GNU `timeout` and `jq`;
- Node 22+, for the plugin tests only.

Install the Python dependency into the `python3` your harness inherits. A virtual environment must be on that harness's `PATH`.

```bash
python3 -m pip install -r requirements.txt
python3 scripts/setup_model.py                     # the only download; prints the cache dir
bash scripts/install.sh --zouroboros-profile --dry-run
bash scripts/install.sh --zouroboros-profile
```

By default the installer wires Hermes only, and only into a profile you name:

- `--zouroboros-profile` targets the hermes-zouroboros profile (`$HERMES_ZOUROBOROS_HOME/hermes`);
- `--hermes-home DIR` targets any other profile.

Without either flag it refuses and writes nothing. It never falls back to `~/.hermes`.

To add other harnesses, list them, for example
`--harness hermes,codex,gemini --project /absolute/path/to/project`.

- The installer keeps unrelated hooks.
- It backs up changed config files to `<state>/backups`.
- It leaves existing mode choices intact.
- An unchanged reinstall creates no backup.

On Codex, review and trust the new hook through `/hooks`. The installer does not write trust hashes or bypass trust. Restart running
harnesses, or start a new Hermes session, after installing plugins or changing hook configuration.
Once a plugin is loaded, mode changes take effect on the next prompt.

Plugins are symlinked to this checkout, so keep it where it is. For copied plugin files, set
`WAYFINDER_HOOK` to the absolute hook path. When you move a checkout, remove the old hook entries
and plugin links, then reinstall from the new location.

### Your skill catalog

Installed inside a hermes-zouroboros checkout (`skills/zouroboros/wayfinder`), the default catalog is
that checkout's whole `skills/` tree, in the category layout `skills/<category>/<skill>/SKILL.md`.
Outside a checkout, the default is `~/.agents/skills`. To share a catalog across harnesses, set
this in the environment their launcher inherits:

```bash
export WAYFINDER_SKILLS_ROOTS=/absolute/path/to/shared/skills:/absolute/path/to/other/skills
```

- When two roots hold a skill with the same name, the first root wins.
- Discovery scans one and two directory levels for the frontmatter `name` and `description`.
- Directories beginning with `_` are excluded.

`WAYFINDER_NATIVE_SKILLS=1` also includes each harness's native skill directories. For Hermes,
that is `$HERMES_HOME/skills`, searched first. This changes the candidate set, so evaluate it in
shadow mode before enabling it broadly.

## Shadow → inspect → live

```bash
bash scripts/wayfinder.sh status
bash scripts/wayfinder.sh suggest "Generate a product poster image"
bash scripts/wayfinder.sh report
bash scripts/wayfinder.sh mode live --harness hermes
bash scripts/wayfinder.sh mode live
bash scripts/wayfinder.sh mode shadow
bash scripts/wayfinder.sh off
bash scripts/wayfinder.sh on
```

- A global mode command clears the per-harness overrides.
- `off` is the immediate kill switch; `on` restores the configured modes.
- Live suggestions are advisory, even when a suggested skill conflicts with higher-priority instructions.

For one invocation only, set `WAYFINDER_MODE=live`, or `WAYFINDER=0` to disable the hook. `status`
reports the saved modes, so an environment override for one invocation can differ from it.

`python3 scripts/shadow-report.py` scores the ranker against a small labeled case set over the
current catalog. Use it before you promote shadow mode to live.

## Runtime, privacy and limits

| Setting | Default | Purpose |
| --- | --- | --- |
| `WAYFINDER_HOME` | `$ZOUROBOROS_STATE_DIR/wayfinder`, else `~/.wayfinder` | Modes, disable sentinel, logs and backups |
| `FLASHRANK_CACHE_DIR` | `$ZOUROBOROS_CACHE_DIR/wayfinder`, else `~/.cache/wayfinder` | Local model files; populated by setup |
| `WAYFINDER_TIMEOUT` | 4 seconds | Maximum synchronous live ranking time |
| `WAYFINDER_SHADOW_TIMEOUT` | 15 seconds | Maximum detached shadow worker time |
| `WAYFINDER_HOOK` | Resolved from the plugin's checkout | Hook override for copied plugins |
| `WAYFINDER_ENGINE` | Bundled `engine/run.py` | Test/custom engine override; trusted code only |

Shadow hooks return immediately and start a bounded background process. The harness or the
operating system can end that worker, so a missing shadow row does not prove a prompt never
happened. Live mode waits for ranking, then fails open on errors or timeouts.

Each row of `suggestions.jsonl` stores:

- a SHA-256 of the prompt and its length (never the raw prompt text);
- the session ID and working directory;
- the selected skill, the candidate scores and the duration.

The directory and new log files are owner-only. Paths and skill names can still be sensitive, so
keep logs private. Harness-native logs may hold the original prompts independently of Wayfinder.

The Software Factory's ACP transport (`packages/swarm`) ranks as the `factory` caller. It writes
one shadow row per invocation under `<state>/invocations/<id>/`, and records whether the
suggested skill was used with `engine/run.py outcome`.

Ranking limits:

- only the first 2,000 prompt characters are ranked;
- prompts shorter than eight characters, and slash commands, are skipped;
- skill descriptions are cut to 500 characters.

Scores show relative relevance, not calibrated confidence. Broad or meta-level prompts can select
an irrelevant skill, which is why shadow is the default. Measure latency from your own log; it is
not guaranteed.

## Validate and roll back

```bash
bash test/run.sh
python3 test/regression.py
```

The shell suite covers:

- the seven adapter outputs and mode changes;
- state and catalog resolution;
- timeouts and failure handling;
- installer preservation, idempotence and refusal;
- the gate-ordering checker.

The real local-ranking checks run only when `flashrank` and the downloaded model are present.
Otherwise they print `skip:`. The regression tests install from a path containing spaces, and
check that a missing model never triggers a download (that check also needs `flashrank`).

To roll back immediately, run `bash scripts/wayfinder.sh off`. To uninstall:

1. Remove only the Wayfinder hook entries and plugin links.
2. Remove `wayfinder` from the profile's `plugins.enabled`.

Restore a full backup only if no later, unrelated config changes would be lost. Wayfinder installs
no scheduled service and needs no credentials.

## Credits

- [FlashRank](https://github.com/PrithivirajDamodaran/FlashRank), by Prithivi Da and contributors,
  supplies the local cross-encoder runtime (Apache 2.0). FlashRank and its downloaded model keep
  their own licences; neither is vendored here.
- [hermes-jev-skills](https://github.com/kerpopule/hermes-jev-skills) inspired the investigation into
  prompt-time skill selection. Wayfinder uses local BM25 and FlashRank instead of a remote ranker.
