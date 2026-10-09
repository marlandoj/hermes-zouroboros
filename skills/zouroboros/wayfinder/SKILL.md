---
name: wayfinder
description: "Prompt-time skill suggester. Ranks SKILL.md descriptors locally with BM25 + a FlashRank cross-encoder (no network, no model call) and suggests the one installed skill that fits the user's prompt. First-class in Hermes through a pre_llm_call plugin; the same hook also serves Claude Code, Codex CLI, Kimi Code, Gemini CLI, OpenCode and Pi. Shadow mode logs the would-be pick; live mode adds one advisory line to the turn. Use to install, switch modes, report on, or debug the suggester."
version: 1.0.0
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [Zouroboros, Skills, Routing, Hooks, Plugins]
    related_skills: [tier-resolver, zouroboros]
prerequisites:
  commands: [python3, bash, jq, timeout]
---

# Wayfinder

Wayfinder runs once per user prompt and never blocks it. It suggests a skill; it never runs one,
authorizes a tool, or calls a model.

## Hermes (first-class path)

1. Install the ranker into the `python3` that Hermes inherits, then download the model once.
   This is the only network step. Prompt-time ranking never downloads anything.

   ```bash
   python3 -m pip install -r "${HERMES_SKILL_DIR}/requirements.txt"
   python3 "${HERMES_SKILL_DIR}/scripts/setup_model.py"
   ```

2. Wire the plugin into an **explicitly named** profile. The installer never writes into a Hermes
   profile without one of these flags. Preview the changes with `--dry-run` first:

   ```bash
   bash "${HERMES_SKILL_DIR}/scripts/install.sh" --zouroboros-profile --dry-run
   bash "${HERMES_SKILL_DIR}/scripts/install.sh" --zouroboros-profile        # the hermes-zouroboros profile
   bash "${HERMES_SKILL_DIR}/scripts/install.sh" --hermes-home /path/to/profile
   ```

   - The installer links `plugins/hermes/wayfinder` into `<profile>/plugins/wayfinder`.
   - It adds `wayfinder` to `plugins.enabled` in `<profile>/config.yaml` and backs that file up first.
   - Start a new Hermes session afterwards.

3. Hermes calls the plugin on `pre_llm_call`. In shadow mode (the default), the plugin returns
   nothing and ranks in a detached process. In live mode, it returns `{"context": "[Wayfinder] ..."}`.
   Hermes appends that to the current user message for that API call only.

## Catalog

- **Default:** the hermes-zouroboros checkout's `skills/` tree, resolved from this skill's own location
  (`skills/<category>/wayfinder`). The category layout `skills/<category>/<skill>/SKILL.md` is
  scanned. Directories beginning with `_` are skipped. Outside a checkout, the default is
  `~/.agents/skills`.
- **`WAYFINDER_SKILLS_ROOTS`:** colon-separated roots. They replace the default, and the first root
  wins when two skills have the same name.
- **`WAYFINDER_NATIVE_SKILLS=1`:** also searches each harness's own skill dirs. For Hermes, that is
  the profile's `$HERMES_HOME/skills`, searched first because Hermes gives it precedence. This
  option changes the candidate set, so evaluate it in shadow mode first.

## Modes, report, state

```bash
W="${HERMES_SKILL_DIR}/scripts/wayfinder.sh"
bash "$W" status                     # mode per harness, kill switch, log size
bash "$W" suggest "Generate a product poster image"
bash "$W" mode live --harness hermes # or: mode live | mode shadow
bash "$W" off                        # kill switch; `on` restores
bash "$W" report                     # overall and per harness
bash "$W" where                      # state directory
```

- **State** (modes, kill switch, `suggestions.jsonl`, backups): `WAYFINDER_HOME`, else
  `$ZOUROBOROS_STATE_DIR/wayfinder`, else `~/.wayfinder`. The log stores a prompt SHA-256, never
  prompt text.
- **Model cache:** `FLASHRANK_CACHE_DIR`, else `$ZOUROBOROS_CACHE_DIR/wayfinder`, else
  `~/.cache/wayfinder`.
- **Per invocation:** `WAYFINDER_MODE=live` or `WAYFINDER=0` (disable).
- **Software Factory:** the ACP transport in `packages/swarm` calls `engine/run.py` directly as the
  `factory` caller. It is always shadow-only, with one row per invocation.

## Other harnesses

Name them explicitly. `--project DIR` holds the Claude and Codex project hooks. Kimi, Gemini,
OpenCode and Pi are wired user-wide under `$HOME`:

```bash
bash "${HERMES_SKILL_DIR}/scripts/install.sh" --harness claude,codex,gemini --project /abs/project
```

Harness event shapes and injection formats are in `engine/adapters.py`. See `README.md` for the
per-harness table and rollback.

## Tests

`bash "${HERMES_SKILL_DIR}/test/run.sh"` and `python3 "${HERMES_SKILL_DIR}/test/regression.py"`
use a throwaway HOME and a stub engine for the hook paths. The real-ranking checks need
`flashrank` and the downloaded model. Without them, the checks print `skip:` and are not counted.
`engine/dag.py` checks the gate ordering in `workflows/*.dag.json`, and `test/dag.py` runs as part
of `run.sh`.
