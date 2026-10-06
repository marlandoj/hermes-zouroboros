# Hermes Factory intake

This distribution includes the workspace's read-only Software Factory intake boundary.
Its concrete consumers are the Factory CLI and the integration's board-reading tool.
It does not install production Factory workers, claim tasks, approve work, or dispatch builds.
The source revision and original hashes are recorded in `factory/PROVENANCE.json`.

Supply an existing qualified `software-factory` board and its trusted foundation manifest:

```sh
bun factory/cli.ts --board-dir /srv/hermes/boards/software-factory \
  --manifest /srv/hermes/foundation/manifest.json --pullable
```

Both paths are required. The board directory must contain `board.json` with
`slug: "software-factory"` and `kanban.db`; an archived board is rejected.
The trusted manifest must name `board: "software-factory"`, integer
`schema_version`, and `schema_sha256`. Its digest covers table DDL ordered by
table name and joined by newlines, matching the original Hermes foundation.
Use the manifest qualified by the board owner: generating a replacement hash
from an unexpected schema would defeat the qualification check.

The reader opens SQLite read-only, enables `query_only`, and checks integrity,
schema, version, and bounded task rows inside one read transaction. Ready tasks
without claims are ordered by descending priority and then creation time.
The CLI's `--pullable` result is a work proposal with `dispatch_eligible: false`.
Reading the board does not reserve any task; a dispatcher must revalidate and
claim it atomically using the owning Hermes runtime.

`factory/hermes_work_intake.py` also projects a supplied JSON snapshot into
stable Factory work identities, always with `dispatch_eligible: false`:

```sh
python3 -I -B factory/hermes_work_intake.py /path/to/snapshot.json
```

The projection format contains exactly `board` and `tasks`; each task contains
exactly `id`, `title`, `body`, and `status`. It is a supplied snapshot, not live
dispatch authority. The live board reader additionally returns schema, claim,
priority, and creation metadata, so adapt its task fields explicitly before
using this projection API.

Credential-free checks:

```sh
bun test tests/factory.test.ts
python3 -B -m unittest discover -s factory -p 'test_*.py'
```
