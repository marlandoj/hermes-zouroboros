# Validation

How to show that a Wayfinder installation works. Each check names its evidence. Keep raw sessions,
request dumps and config backups out of the repository. Publish only sanitized summaries.

## Mechanical checks (offline)

```bash
bash test/run.sh            # adapters, hook, plugins, modes, state/catalog, installer, DAG checker
python3 test/regression.py  # install from a path with spaces; missing model never downloads
```

- `run.sh` runs with a stub engine in a throwaway HOME. It covers:
  - the seven adapter outputs, shadow and live hook paths, per-harness overrides and the kill switch;
  - fail-open errors and timeouts;
  - the OpenCode, Pi and Hermes plugin contracts;
  - state, cache and catalog resolution;
  - installer preservation, idempotence and refusal: no Hermes profile without `--hermes-home` or
    `--zouroboros-profile`, and a `--dry-run` that writes nothing.
- The real-ranking and `factory`-caller checks need `flashrank` and the model from
  `scripts/setup_model.py`. Without them, the suite prints `skip:` and does not count those checks.
- The regression suite's download guard also needs `flashrank`. Without it, the suite reports the
  test as skipped.
- The Pi extension is part of the repository's `tsc --noEmit`.

## Harness evidence (per installation)

For each harness you enable, collect two kinds of evidence. They are separate, and only the
second shows the note reached the model:

1. **Hook evidence:** with the harness in shadow mode, a row appears in `suggestions.jsonl`
   (`bash scripts/wayfinder.sh report`). Its `harness` matches and its `catalog_size` is non-zero.
2. **Injection evidence:** with live mode enabled for that one harness, the `[Wayfinder]` note is
   present in the request the harness sends to its provider. For Hermes, check the current user
   message of that API call. A model reply that mentions the suggested skill is supporting evidence
   only. Do not claim it when the provider failed or was unavailable.

These are transport and injection checks. They do not show that the selected skill is correct.
Canary prompts that discuss hooks or replies skew relevance towards Wayfinder itself, so use
ordinary task prompts.

## Correctness and promotion

- Run `python3 scripts/shadow-report.py` against the catalog you actually ship. Read every miss
  before you change thresholds. A pick that is never used points to a skill description that needs
  fixing.
- The gates in `workflows/adoption.dag.json` (conformance, correctness, latency, reach) are
  checked by `engine/dag.py`. Promote one harness to live at a time. Return any harness to shadow
  if it degrades.

## Known failure modes this suite guards

1. OpenCode rejects a synthetic part without `id`, `sessionID` and `messageID`. The plugin
   supplies all three.
2. Kimi sends prompt content parts rather than a string. Normalization joins only the text parts.
3. Plugins resolve the hook from their own checkout, through symlinks, never from a fixed host path.
4. FlashRank downloads a missing model on first use. Prompt-time ranking forbids that, and only
   `scripts/setup_model.py` downloads it.
5. The installer quotes checkout paths, and Kimi's TOML command uses JSON-compatible escaping. The
   installer rejects unsupported harness lists, and a Hermes target that was not named, before it
   changes anything.
