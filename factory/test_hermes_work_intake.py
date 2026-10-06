# Derived from workspace Projects/zouroboros-software-factory/hermes/test_hermes_work_intake.py; see PROVENANCE.json.
"""Credential-free, supplied-snapshot tests for the read-only intake seam."""

import unittest
import sqlite3
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from hermes_work_intake import MAX_SNAPSHOT_BYTES, MAX_TASKS, project_tasks, read_fixture_snapshot


def snapshot(task_id="task-1", status="ready"):
    return {"board": "software-factory", "tasks": [
        {"id": task_id, "title": "Build queue", "body": "Acceptance criteria", "status": status}
    ]}


class HermesWorkIntakeTests(unittest.TestCase):
    def test_readonly_sqlite_fixture_reaches_projection(self):
        with sqlite3.connect(":memory:") as connection:
            connection.execute("CREATE TABLE tasks(id TEXT, title TEXT, body TEXT, status TEXT)")
            connection.execute("INSERT INTO tasks VALUES(?,?,?,?)", ("task-1", "Build queue", None, "ready"))
            with self.assertRaisesRegex(ValueError, "SNAPSHOT_READONLY_REQUIRED"):
                read_fixture_snapshot(connection)
            connection.execute("PRAGMA query_only=ON")
            result = project_tasks(read_fixture_snapshot(connection))
            self.assertEqual(len(result), 1)
            self.assertEqual(result[0]["description"], "")
            self.assertFalse(result[0]["dispatch_eligible"])

    def test_fixture_reader_rejects_unknown_schema(self):
        with sqlite3.connect(":memory:") as connection:
            connection.execute("CREATE TABLE tasks(id TEXT, title TEXT)")
            connection.execute("PRAGMA query_only=ON")
            with self.assertRaisesRegex(ValueError, "SNAPSHOT_SCHEMA"):
                read_fixture_snapshot(connection)

    def test_cli_caps_snapshot_bytes_before_json_decode(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "snapshot.json"
            source.write_bytes(b"x" * (MAX_SNAPSHOT_BYTES + 1))
            run = subprocess.run([sys.executable, "-I", "-B", str(Path(__file__).with_name("hermes_work_intake.py")), str(source)],
                                 capture_output=True, text=True, timeout=10)
            self.assertNotEqual(run.returncode, 0)
            self.assertIn("SNAPSHOT_BYTES", run.stderr)
            self.assertEqual(run.stdout, "")

    def test_cli_projects_supplied_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "snapshot.json"
            source.write_text(json.dumps(snapshot()), encoding="utf-8")
            run = subprocess.run([sys.executable, "-I", "-B", str(Path(__file__).with_name("hermes_work_intake.py")), str(source)],
                                 capture_output=True, text=True, timeout=10)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertFalse(json.loads(run.stdout)[0]["dispatch_eligible"])

    def test_stable_identity_and_closed_dispatch(self):
        first = project_tasks(snapshot())[0]
        again = project_tasks(snapshot(status="blocked"))[0]
        self.assertEqual(first["factory_work_id"], again["factory_work_id"])
        # Pinned by the TypeScript held-work-to-claim bridge and its fixture receipt.
        self.assertEqual(first["factory_work_id"],
                         "fw_827ce197981d1904313d3b67adb6f60cfb616694938a714e509b0a81d4549a64")
        self.assertTrue(first["factory_work_id"].startswith("fw_"))
        self.assertEqual(first["source"], "hermes")
        self.assertEqual(first["external_references"],
                         {"hermes_board": "software-factory", "hermes_task_id": "task-1"})
        self.assertFalse(first["dispatch_eligible"])
        self.assertFalse(again["dispatch_eligible"])
        self.assertNotIn("linear_id", first)

    def test_pinned_scheduled_status_is_held(self):
        scheduled = project_tasks(snapshot(status="scheduled"))[0]
        self.assertEqual(scheduled["source_status"], "scheduled")
        self.assertFalse(scheduled["dispatch_eligible"])

    def test_identity_is_scoped_and_not_display_text(self):
        original = project_tasks(snapshot())[0]["factory_work_id"]
        changed = snapshot()
        changed["tasks"][0]["title"] = "Renamed"
        self.assertEqual(original, project_tasks(changed)[0]["factory_work_id"])
        self.assertNotEqual(original, project_tasks(snapshot("task-2"))[0]["factory_work_id"])

    def test_duplicate_and_malformed_tasks_fail_closed(self):
        duplicate = snapshot()
        duplicate["tasks"].append(dict(duplicate["tasks"][0]))
        with self.assertRaisesRegex(ValueError, "TASK_DUPLICATE"):
            project_tasks(duplicate)
        for task_id in ("", "../escape", " spaced ", "a" * 129):
            with self.subTest(task_id=task_id), self.assertRaisesRegex(ValueError, "TASK_ID"):
                project_tasks(snapshot(task_id))

    def test_wrong_board_and_unknown_status_fail_closed(self):
        wrong = snapshot()
        wrong["board"] = "other"
        with self.assertRaisesRegex(ValueError, "SNAPSHOT_BOARD"):
            project_tasks(wrong)
        with self.assertRaisesRegex(ValueError, "TASK_STATUS"):
            project_tasks(snapshot(status="unknown"))

    def test_oversized_batch_and_invalid_row_fail_closed(self):
        oversized = {"board": "software-factory", "tasks": [
            {"id": f"task-{number}", "title": "Build", "body": "", "status": "ready"}
            for number in range(MAX_TASKS + 1)
        ]}
        with self.assertRaisesRegex(ValueError, "SNAPSHOT_LIMIT"):
            project_tasks(oversized)
        invalid = snapshot()
        invalid["tasks"][0]["body"] = 42
        with self.assertRaisesRegex(ValueError, "TASK_BODY"):
            project_tasks(invalid)


if __name__ == "__main__":
    unittest.main()
