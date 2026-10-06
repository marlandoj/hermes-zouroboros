# Watch it, then run it

The [README terminal animation](assets/terminal-demo.gif) shows real local CLI and MCP calls with condensed output and paced playback. It is a guided demo, not a live Hermes conversation. Read the [captured text transcript](assets/terminal-demo.txt) without animation.

## Reproduce the demo

After `bash scripts/setup.sh`, run from the repository root:

```bash
bun examples/offline-demo.ts
```

The script creates a fresh temporary profile and workspace, runs `doctor`, stores `demo.choice = Use copper widgets` through the CLI, reads it through a new MCP process, and prepares a two-task dependency plan. It checks the actual responses and saved campaign before printing success. It removes its temporary profile, database, workspace, and campaign when finished.

No provider credentials, paid model calls, configured board, or worker execution are needed. Hermes Agent is optional for this offline demo: without its executable, the doctor section honestly reports `MISSING hermes`. A normal installation still requires Hermes. An installed executable is only a prerequisite check; it does not prove provider authentication.

The MCP lines label tool calls made by the SDK client. They are explanatory notation, not shell commands. The campaign path and random identifier are replaced with placeholders; diagnostic chatter is omitted. Memory content comes exclusively from the disposable demo profile.

## Try the same workflow in Hermes

Use your initialized profile and configured provider from the [walkthrough](../walkthrough/README.md):

```bash
bun integration/cli.ts hermes chat
```

Ask:

> Call `memory_store` with entity `demo`, key `choice`, and value `Use copper widgets`. Then call `memory_search` for `copper`.

Then ask:

> Call `swarm_prepare` for two tasks: `inspect`, which reads the workspace and lists its top-level files; and `summarize`, which summarizes those findings and depends on `inspect`. Prepare the plan for my review.

Expect a `taskFile`, `taskCount: 2`, and an instruction to review the campaign before opting in to execution. This conversation uses your configured model and may incur provider charges. The offline demo above does not.

## Refresh the recording

Capture output from a built checkout. The animation renderer requires Python, Pillow 11.3.0, and DejaVu Sans Mono fonts; these are documentation tooling only.

```bash
bun examples/offline-demo.ts > docs/assets/terminal-demo.txt
python3 scripts/render-readme-demo.py
```

Review all four frames and the transcript before committing. The recording demonstrates the installed environment; do not replace missing prerequisites with fabricated successes.
