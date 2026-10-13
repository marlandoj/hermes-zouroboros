"""Runtime path resolution shared by the loop's Python scripts (mirror of loop-env.sh)."""
import os, pwd, re, subprocess

REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir
_SKILLS_ROOT = os.path.realpath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
CHECKOUT = os.path.dirname(_SKILLS_ROOT) if os.path.isfile(os.path.join(_SKILLS_ROOT, "..", "integration", "cli.ts")) else None
_DATA = os.environ.get("HERMES_ZOUROBOROS_HOME") or os.path.join(REAL_HOME, ".local/share/hermes-zouroboros")
LOOP_HOME = os.path.realpath(os.environ.get("ZO_LOOP_HOME") or os.path.join(os.environ.get("ZOUROBOROS_STATE_DIR") or os.path.join(_DATA, "state"), "zouroboros-loop"))
SKILLS_ROOT = _SKILLS_ROOT
PROTECTED = [os.path.realpath(p) for p in (os.path.join(REAL_HOME, "hermes-zouroboros"), CHECKOUT) if p]
# Live data and profiles the loop must never write to directly (governor BLOCK; check-runner refusal).
PRODUCTION = PROTECTED + [os.path.realpath(p) for p in (os.path.join(REAL_HOME, ".hermes"), _DATA)]


def is_protected(path):
    p = os.path.realpath(path)
    return any(p == x or p.startswith(x + os.sep) for x in PROTECTED)


def repo_slug():
    if os.environ.get("ZO_LOOP_REPO"):
        return os.environ["ZO_LOOP_REPO"]
    if CHECKOUT:
        url = subprocess.run(["git", "-C", CHECKOUT, "remote", "get-url", "origin"], capture_output=True, text=True).stdout.strip()
        m = re.match(r"^(?:https://github\.com/|git@github\.com:)([^/]+/[^/.]+?)(?:\.git)?$", url)
        if m:
            return m.group(1)
    return None
