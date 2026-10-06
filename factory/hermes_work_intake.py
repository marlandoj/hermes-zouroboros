# Derived from workspace Projects/zouroboros-software-factory/hermes/hermes_work_intake.py; see PROVENANCE.json.
"""Project a supplied Hermes task snapshot into factory work identities.

This is a read-only preparation boundary. It does not open a board, claim a
task, invoke a model, or grant dispatch authority.
"""

import hashlib
import json
import re
import sqlite3
from pathlib import Path


BOARD = "software-factory"
TASK_ID = re.compile(r"[A-Za-z0-9_.:-]{1,128}\Z")
# Pinned hermes_cli/kanban_db.py VALID_STATUSES at 345cd2b0 (SHA in manifest).
STATUSES = frozenset({"triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"})
MAX_TASKS = 1000
MAX_SNAPSHOT_BYTES = 2_000_000
MAX_TOTAL_BODY_BYTES = 2_000_000


def read_fixture_snapshot(connection):
    """Read a bounded synthetic board connection; never accepted as live authority."""
    if type(connection) is not sqlite3.Connection or connection.execute("PRAGMA query_only").fetchone() != (1,):
        raise ValueError("SNAPSHOT_READONLY_REQUIRED")
    try:
        rows = connection.execute(
            "SELECT id, title, body, status FROM main.tasks ORDER BY id LIMIT ?", (MAX_TASKS + 1,)
        ).fetchall()
    except sqlite3.Error as error:
        raise ValueError("SNAPSHOT_SCHEMA") from error
    if len(rows) > MAX_TASKS:
        raise ValueError("SNAPSHOT_LIMIT")
    return {"board": BOARD, "tasks": [
        {"id": row[0], "title": row[1], "body": row[2] if row[2] is not None else "", "status": row[3]}
        for row in rows
    ]}


def project_tasks(snapshot):
    """Return a deterministic, explicitly non-dispatchable work projection."""
    if type(snapshot) is not dict or set(snapshot) != {"board", "tasks"}:
        raise ValueError("SNAPSHOT_SHAPE")
    if snapshot["board"] != BOARD or type(snapshot["tasks"]) is not list:
        raise ValueError("SNAPSHOT_BOARD")
    if len(snapshot["tasks"]) > MAX_TASKS:
        raise ValueError("SNAPSHOT_LIMIT")
    seen = set()
    projected = []
    total_body_bytes = 0
    for task in snapshot["tasks"]:
        if type(task) is not dict or set(task) != {"id", "title", "body", "status"}:
            raise ValueError("TASK_SHAPE")
        task_id = task["id"]
        if type(task_id) is not str or not TASK_ID.fullmatch(task_id):
            raise ValueError("TASK_ID")
        if task_id in seen:
            raise ValueError("TASK_DUPLICATE")
        seen.add(task_id)
        if type(task["title"]) is not str or not task["title"].strip() or len(task["title"]) > 512:
            raise ValueError("TASK_TITLE")
        if type(task["body"]) is not str:
            raise ValueError("TASK_BODY")
        try:
            body_bytes = len(task["body"].encode("utf-8"))
        except UnicodeError as error:
            raise ValueError("TASK_BODY") from error
        if body_bytes > 65536:
            raise ValueError("TASK_BODY")
        total_body_bytes += body_bytes
        if total_body_bytes > MAX_TOTAL_BODY_BYTES:
            raise ValueError("SNAPSHOT_BYTES")
        if type(task["status"]) is not str or task["status"] not in STATUSES:
            raise ValueError("TASK_STATUS")
        identity = hashlib.sha256(f"hermes\0{BOARD}\0{task_id}".encode()).hexdigest()
        projected.append({
            "schema": "factory-work/v1",
            "factory_work_id": f"fw_{identity}",
            "source": "hermes",
            "external_references": {"hermes_board": BOARD, "hermes_task_id": task_id},
            "title": task["title"].strip(),
            "description": task["body"],
            "source_status": task["status"],
            "dispatch_eligible": False,
        })
    return projected


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Project a supplied Hermes JSON snapshot; no board access")
    parser.add_argument("snapshot", type=Path)
    args = parser.parse_args()
    with args.snapshot.open("rb") as source:
        raw = source.read(MAX_SNAPSHOT_BYTES + 1)
    if len(raw) > MAX_SNAPSHOT_BYTES:
        raise ValueError("SNAPSHOT_BYTES")
    print(json.dumps(project_tasks(json.loads(raw.decode("utf-8"))), sort_keys=True))


if __name__ == "__main__":
    main()
