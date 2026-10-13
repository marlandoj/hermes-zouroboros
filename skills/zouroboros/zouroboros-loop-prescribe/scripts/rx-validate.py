#!/usr/bin/env python3
"""Validate loop prescriptions (schema zo-loop/prescription@1) and render PRESCRIPTIONS.md.

Usage:
  rx-validate.py RX.json [RX.json ...]            validate; exit 0 all valid, 1 otherwise
  rx-validate.py --render DIR                     validate DIR/prescriptions/*.json and write DIR/PRESCRIPTIONS.md
  rx-validate.py --defects-digest DEFECTS.md D-03 [D-NN …]   print the source.defects_digest for these ids

Fail-closed checks (references/prescription-schema.md):
- required fields and types; ID patterns; kind heal|evolve; delivery pr|operator
- every acceptance check is runnable by check-runner (id, cmd, expect) and, for heal, declares `red`
- heal+pr: reproduction.result_file exists, its digest matches, meets_expectation is true, and it
  was produced on base.sha with the same check ids
- evolve: baseline present with metric, value, n
- pr delivery: change_plan.files non-empty; operator delivery: runbook steps non-empty
- governor block equals a fresh recomputation (hand-edited tiers are rejected)
"""
import glob, hashlib, json, os, re, sys

sys.path.insert(0, os.path.dirname(__file__))
from governor import evaluate  # noqa: E402

RX_ID = re.compile(r"^RX-C\d{8}-\d+-\d{2}$")
CYCLE = re.compile(r"^C\d{8}-\d+$")
DEFECT = re.compile(r"^(D-\d{2,3}|M-[A-Za-z0-9_-]+)$")
SHA = re.compile(r"^[0-9a-f]{40}$")


def load(path):
    with open(path) as f:
        return json.load(f)


def canon_digest(path):
    with open(path, "rb") as f:
        raw = f.read()
    try:
        return hashlib.sha256(json.dumps(json.loads(raw), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    except ValueError:
        return hashlib.sha256(raw).hexdigest()


def defects_digest(defects_md, ids):
    """SHA-256 over only the cited defects' entries (table row + '### D-NN' section), in id order.
    Unrelated edits to DEFECTS.md (e.g. new defects) do not invalidate a prescription; edits to a
    cited defect do."""
    lines = open(defects_md, encoding="utf-8").read().split("\n")
    chunks = []
    for d in sorted(ids):
        rows = [l for l in lines if l.startswith(f"| {d} |")]
        sec, on = [], False
        for l in lines:
            if l.startswith("### "):
                on = l.startswith(f"### {d} ")
            if on:
                sec.append(l)
        if not rows:
            return None
        chunks.append("\n".join(rows + sec).strip())
    return hashlib.sha256("\n\n".join(chunks).encode()).hexdigest()


def validate(rx, path=""):
    e = []
    req = lambda k, t: (k in rx and isinstance(rx[k], t)) or e.append(f"missing/invalid '{k}' ({t.__name__})")
    for k, t in [("schema", str), ("id", str), ("cycle", str), ("kind", str), ("delivery", str), ("title", str),
                 ("defects", list), ("source", dict), ("spec", str), ("rationale", str), ("base", dict),
                 ("acceptance_checks", list), ("risk", dict), ("rollback", str), ("budget", dict)]:
        req(k, t)
    if e:
        return e
    if rx["schema"] != "zo-loop/prescription@1": e.append("schema must be zo-loop/prescription@1")
    if not RX_ID.match(rx["id"]): e.append(f"id {rx['id']!r} must match RX-C<YYYYMMDD>-<n>-<nn>")
    if not CYCLE.match(rx["cycle"]) or not rx["id"].startswith("RX-" + rx["cycle"] + "-"): e.append("cycle must match the id prefix")
    if rx["kind"] not in ("heal", "evolve"): e.append("kind must be heal|evolve")
    if rx["delivery"] not in ("pr", "operator"): e.append("delivery must be pr|operator")
    if not rx["defects"] or not all(isinstance(d, str) and DEFECT.match(d) for d in rx["defects"]): e.append("defects must be non-empty D-NN (or M-<metric>) ids")
    src = rx["source"]
    if not src.get("assessment") or not os.path.isdir(os.path.expanduser(src["assessment"])): e.append("source.assessment must be an existing assessment directory")
    if not re.match(r"^[0-9a-f]{64}$", str(src.get("defects_digest", ""))): e.append("source.defects_digest must be a sha256")
    elif src.get("assessment") and os.path.isfile(os.path.join(os.path.expanduser(src["assessment"]), "DEFECTS.md")):
        dd = defects_digest(os.path.join(os.path.expanduser(src["assessment"]), "DEFECTS.md"), rx["defects"])
        if dd is None:
            e.append("a cited defect id is not in the assessment's DEFECTS.md")
        elif dd != src["defects_digest"]:
            e.append("source.defects_digest does not match the cited defects in DEFECTS.md (a cited defect changed — re-derive)")
    base = rx["base"]
    if rx["delivery"] == "pr" and (not base.get("repo") or not SHA.match(str(base.get("sha", "")))): e.append("base.repo and 40-hex base.sha required for pr delivery")
    for i, c in enumerate(rx["acceptance_checks"]):
        for k in ("id", "cmd", "expect"):
            if k not in c: e.append(f"acceptance_checks[{i}] missing {k}")
        if c.get("kind", "acceptance") != "acceptance": e.append(f"acceptance_checks[{i}].kind must be acceptance (held-out lives in verify)")
        if rx["kind"] == "heal" and "red" not in c: e.append(f"acceptance_checks[{i}] needs a 'red' defect signature (heal)")
    if rx["kind"] == "heal" and rx["delivery"] == "pr":
        rep = rx.get("reproduction") or {}
        f = os.path.expanduser(rep.get("result_file", ""))
        if not os.path.isfile(f):
            e.append("reproduction.result_file missing")
        else:
            if canon_digest(f) != rep.get("digest"): e.append("reproduction.digest does not match result_file")
            r = load(f)
            if not (r.get("expect") == "fail" and r.get("meets_expectation") is True): e.append("reproduction result is not a confirmed red (expect=fail, meets_expectation=true)")
            ids = {x["id"] for x in r.get("results", [])}
            missing = {c.get("id") for c in rx["acceptance_checks"]} - ids
            if missing: e.append(f"reproduction does not cover acceptance checks {sorted(missing)}")
            if rep.get("red_on_sha") != base.get("sha"): e.append("reproduction.red_on_sha must equal base.sha")
            if not rep.get("meets_expectation"): e.append("reproduction.meets_expectation must be true")
    if rx["kind"] == "evolve":
        b = rx.get("baseline") or {}
        if not all(k in b for k in ("metric", "value", "n")): e.append("evolve needs baseline {metric, value, n}")
    cat_path = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "zouroboros-loop-verify", "heldout", "catalog.json")
    if os.path.exists(cat_path):
        classes = set(load(cat_path)["classes"])
        bad = [h for h in rx.get("heldout_ref") or [] if h not in classes]
        if bad: e.append(f"heldout_ref names unknown held-out classes {bad} (known: {sorted(classes)})")
    if rx.get("governor", {}).get("tier") in ("H", "G") and not rx.get("heldout_ref"):
        e.append("tier H/G prescriptions must name at least one held-out class in heldout_ref (verify needs a discriminating held-out check)")
    plan = rx.get("change_plan") or {}
    if rx["delivery"] == "pr" and not plan.get("files"): e.append("pr delivery needs change_plan.files (allowed paths/globs)")
    if rx["delivery"] == "operator" and not rx.get("runbook"): e.append("operator delivery needs runbook steps")
    if not isinstance(rx["budget"].get("live_calls", None), int): e.append("budget.live_calls must be an integer (0 if none)")
    fresh = evaluate(rx)
    if rx.get("governor") != fresh: e.append(f"governor block is stale or hand-edited (recomputed tier {fresh['tier']}); run governor.py --write")
    if rx.get("risk", {}).get("tier") not in (None, fresh["tier"]): e.append("risk.tier disagrees with governor tier")
    return e


def render(d):
    files = sorted(glob.glob(os.path.join(d, "prescriptions", "RX-*.json")))
    rows, bad = [], 0
    for p in files:
        rx = load(p); errs = validate(rx, p); bad += bool(errs)
        g = rx.get("governor", {})
        rows.append(f"| {rx['id']} | {rx['kind']} | {rx['delivery']} | {', '.join(rx['defects'])} | {g.get('tier','?')} | {rx['title']} | "
                    f"{'VALID' if not errs else 'INVALID: ' + '; '.join(errs)} | `{os.path.basename(p)}` |")
    out = ["# Prescriptions", "", "Generated by `rx-validate.py --render`. Approval binds the canonical digest of each JSON file;",
           "editing a prescription after approval invalidates the approval.", "",
           "| ID | Kind | Delivery | Defects | Tier | Title | Validation | File |", "|---|---|---|---|---|---|---|---|", *rows, ""]
    for p in files:
        rx = load(p); g = rx.get("governor", {})
        out += [f"## {rx['id']} — {rx['title']}", "", f"- **Kind / delivery:** {rx['kind']} / {rx['delivery']}  ·  **Defects:** {', '.join(rx['defects'])}",
                f"- **Spec:** {rx['spec']}", f"- **Rationale:** {rx['rationale']}",
                f"- **Base:** {rx['base'].get('repo','-')} @ `{str(rx['base'].get('sha','-'))[:12]}`",
                f"- **Plan:** {(rx.get('change_plan') or {}).get('summary', '-')}",
                f"- **Files allowed:** {', '.join((rx.get('change_plan') or {}).get('files', [])) or '-'}",
                f"- **Acceptance checks:** " + "; ".join(f"`{c['id']}` {c.get('description','')}" for c in rx["acceptance_checks"]),
                f"- **Governor:** tier **{g.get('tier')}** — {g.get('approval')}; flags: " + ("; ".join(f"{f['tier']}:{f['rule']} ({f['why']})" for f in g.get("flags", [])) or "none"),
                f"- **Rollback:** {rx['rollback']}", f"- **Budget:** {rx['budget']}",
                f"- **Digest:** `{canon_digest(p)}`", ""]
    with open(os.path.join(d, "PRESCRIPTIONS.md"), "w") as f:
        f.write("\n".join(out))
    return bad


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    if sys.argv[1] == "--defects-digest":
        d = defects_digest(sys.argv[2], sys.argv[3:]); print(d or ""); return 0 if d else 1
    if sys.argv[1] == "--render":
        bad = render(sys.argv[2]); print(json.dumps({"rendered": os.path.join(sys.argv[2], "PRESCRIPTIONS.md"), "invalid": bad}))
        return 1 if bad else 0
    bad = 0
    for p in sys.argv[1:]:
        try:
            errs = validate(load(p), p)
        except Exception as ex:
            errs = [f"unreadable: {ex}"]
        print(json.dumps({"file": p, "valid": not errs, "errors": errs}))
        bad += bool(errs)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
