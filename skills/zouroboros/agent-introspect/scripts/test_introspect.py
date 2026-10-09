#!/usr/bin/env python3
"""
Tests for the introspection audit. Run: `python3 test_introspect.py`
Exit 0 = all pass, 1 = a failure. `--help` exits 0 (so the audit can probe it).
"""
import argparse
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.json"

# Frozen snapshot: the skip_health set must always equal these 17 entries.
# Changing this set is a deliberate act and must update both this snapshot and config.json.
FROZEN_SKIP_HEALTH = {
    # Network-only update check (heygen-video): a --help probe must not call out.
    "update-check.sh",
}


def _load_module():
    spec = importlib.util.spec_from_file_location("introspect", HERE / "introspect.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _write_cfg(tmpdir, **overrides):
    base = json.loads(CONFIG.read_text())
    base.update(overrides)
    p = Path(tmpdir) / "cfg.json"
    p.write_text(json.dumps(base))
    return p


def test_skip_health_parity(intro):
    cfg = intro.load_config(CONFIG)
    assert cfg["skip_health"] == FROZEN_SKIP_HEALTH, (
        f"skip_health drift: extra={cfg['skip_health'] - FROZEN_SKIP_HEALTH}, "
        f"missing={FROZEN_SKIP_HEALTH - cfg['skip_health']}"
    )
    assert len(cfg["skip_health"]) == 1, f"expected 1 entry, got {len(cfg['skip_health'])}"


def test_config_valid(intro):
    cfg = intro.load_config(CONFIG)
    assert cfg["version"] == intro.EXPECTED_CONFIG_VERSION
    assert cfg["probe_timeout_s"] == 10
    assert cfg["retries"] == 1
    assert cfg["audit_budget_s"] == 600
    assert cfg["max_timeouts"] == 5


def test_config_fail_closed(intro):
    with tempfile.TemporaryDirectory() as td:
        # bad version -> ERROR
        try:
            intro.load_config(_write_cfg(td, version=99))
            assert False, "expected ConfigError on version mismatch"
        except intro.ConfigError:
            pass
        # out-of-range -> ERROR
        try:
            intro.load_config(_write_cfg(td, retries=99))
            assert False, "expected ConfigError on out-of-range retries"
        except intro.ConfigError:
            pass
        # unknown key -> ERROR (typo guard)
        try:
            intro.load_config(_write_cfg(td, skip_helth=[]))
            assert False, "expected ConfigError on unknown key"
        except intro.ConfigError:
            pass
        # duplicate skip_health -> ERROR
        dup = FROZEN_SKIP_HEALTH | set()
        try:
            intro.load_config(_write_cfg(td, skip_health=["demo.ts", "demo.ts"]))
            assert False, "expected ConfigError on duplicate skip_health"
        except intro.ConfigError:
            pass
        # missing file -> ERROR
        try:
            intro.load_config(Path(td) / "nope.json")
            assert False, "expected ConfigError on missing config"
        except intro.ConfigError:
            pass


def test_probe_map_subset_of_runnable(intro):
    # Every probe strategy must be over a runnable extension (no orphan strategies).
    assert set(intro.PROBE_INTERPRETER).issubset(intro.RUNNABLE_EXT)


def test_arch_collect_nonfatal(intro):
    # A missing binary must degrade to a note, never raise — the audit cannot be
    # blocked by the codebase-memory graph being unavailable.
    saved = intro.ARCH_BIN
    try:
        intro.ARCH_BIN = Path("/nonexistent/codebase-memory-mcp")
        out = intro.collect_architecture_hotspots(timeout_s=1)
    finally:
        intro.ARCH_BIN = saved
    assert isinstance(out, list)
    assert out and "unavailable" in out[0]


def test_report_arch_is_additive(intro):
    # The advisory section must never change the findings count (compat parity),
    # must appear only when arch_lines are supplied, and must be absent otherwise.
    meta = {"unprobed": 0, "missing_interpreters": [], "timeout_events": 0}
    base_args = ("2026-01-01", [], [], [], meta, [], "OK")

    text_none, count_none = intro.build_report(*base_args, arch_lines=None)
    text_with, count_with = intro.build_report(*base_args, arch_lines=["- x"])

    assert "Architecture Hotspots" not in text_none
    assert "Architecture Hotspots" in text_with
    assert count_none == count_with == 0, "advisory section must not affect findings count"


def main():
    argparse.ArgumentParser(description="Tests for the introspection audit.").parse_args()
    intro = _load_module()
    tests = [
        test_skip_health_parity, test_config_valid, test_config_fail_closed,
        test_probe_map_subset_of_runnable,
        test_arch_collect_nonfatal, test_report_arch_is_additive,
    ]
    failed = 0
    for t in tests:
        try:
            t(intro)
            print(f"PASS {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {t.__name__}: {e}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"ERROR {t.__name__}: {e!r}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
