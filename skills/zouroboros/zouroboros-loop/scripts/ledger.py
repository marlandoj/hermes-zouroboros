#!/usr/bin/env python3
"""Hash-chained, fail-closed state ledger for the Zouroboros closed loop.

Implements references/loop-contract.md (Constitution Arts. VI and IX). Every event is one JSON
line with `prev` (hash of the previous line) and `hash` (SHA-256 of the canonical event without
`hash`). Appends are serialized with flock. Illegal transitions, wrong actors, missing approvals,
prescriptions edited after approval, or a broken chain are refused with exit code 3.

Usage:
  ledger.py init      --home DIR [--mode live|smoke]
  ledger.py verify    --home DIR
  ledger.py digest    FILE                                  # canonical SHA-256 of a JSON file
  ledger.py cycle-open  --home DIR --cycle C --budget-calls N --budget-usd X --actor operator
  ledger.py cycle-close --home DIR --cycle C --actor operator|loop [--note ...]
  ledger.py spend     --home DIR --cycle C --calls N [--usd X] --actor ACTOR --note WHY
  ledger.py budget-raise --home DIR --cycle C --calls N --usd X --actor operator --operator-words "..."
  ledger.py budget    --home DIR --cycle C                  # prints remaining; exit 3 if exhausted
  ledger.py event     --home DIR --cycle C --rx RX --event EVENT --actor ACTOR
                      [--rx-file PRESCRIPTION.json] [--evidence PATH ...] [--data JSON] [--note TEXT]
  ledger.py state     --home DIR [--rx RX] [--json]
Actors: operator (human decisions recorded verbatim), prescribe, evolve, verify, introspect,
github (facts read from the GitHub API), loop, test-fixture (smoke ledgers only).
"""
import argparse, contextlib, datetime as dt, fcntl, hashlib, json, os, sys

GENESIS = "0" * 64
MAX_RETRIES = 2
# event: (allowed from-states, to-state, allowed actors)
TRANSITIONS = {
    "propose":      ({None}, "proposed", {"prescribe"}),
    "revise":       ({"proposed"}, "proposed", {"prescribe"}),
    "approve":      ({"proposed", "failed", "inconclusive"}, "approved", {"operator"}),
    "reject":       ({"proposed"}, "rejected", {"operator"}),
    "withdraw":     ({"approved", "certified"}, "withdrawn", {"operator"}),
    "start":        ({"approved"}, "evolving", {"evolve"}),
    "branch-ready": ({"evolving"}, "evolved", {"evolve"}),
    "abandon":      ({"evolving", "evolved", "failed", "inconclusive"}, "abandoned", {"evolve", "operator"}),
    "verify-start": ({"evolved"}, "verifying", {"verify"}),
    "verify-abort": ({"verifying"}, "evolved", {"verify", "operator"}),   # recovery: verify crashed or was interrupted
    "certified":    ({"verifying"}, "certified", {"verify"}),
    "failed":       ({"verifying"}, "failed", {"verify"}),
    "inconclusive": ({"verifying"}, "inconclusive", {"verify"}),
    "pr-opened":    ({"certified"}, "pr-open", {"evolve"}),
    "merged":       ({"pr-open"}, "merged", {"github", "operator"}),
    "closed":       ({"pr-open", "certified"}, "closed", {"github", "operator"}),
    "applied":      ({"approved"}, "applied", {"operator"}),   # operator delivery: the runbook was performed
    "confirmed":    ({"merged", "applied"}, "confirmed", {"introspect"}),
    "regressed":    ({"merged", "applied"}, "regressed", {"introspect"}),
}
SCOPES = {"evolve-local", "push-branch", "open-draft-pr"}   # delivery "pr"
RUNBOOK_SCOPES = {"operator-runbook"}                        # delivery "operator"
CYCLE_EVENTS = {"cycle-open", "cycle-close", "spend", "budget-raise"}


class Refused(Exception):
    pass


def canon(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def file_digest(path: str) -> str:
    with open(path, "rb") as f:
        raw = f.read()
    try:
        return sha(canon(json.loads(raw)))
    except ValueError:
        return sha(raw)


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def path_of(home):
    return os.path.join(home, "ledger.jsonl")


def read(home):
    p = path_of(home)
    if not os.path.exists(p):
        raise Refused(f"no ledger at {p}; run init")
    with open(p, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def check_chain(events):
    prev = GENESIS
    for i, e in enumerate(events):
        body = {k: v for k, v in e.items() if k != "hash"}
        if e.get("seq") != i:
            raise Refused(f"chain: seq {e.get('seq')} at line {i + 1}")
        if e.get("prev") != prev:
            raise Refused(f"chain: prev mismatch at seq {i}")
        if sha(canon(body)) != e.get("hash"):
            raise Refused(f"chain: hash mismatch at seq {i} (line edited?)")
        prev = e["hash"]
    if not events or events[0].get("event") != "init":
        raise Refused("chain: first event must be init")
    return prev


def fold(events):
    """Return {rx: {...state info...}} and {cycle: {...}}."""
    rxs, cycles = {}, {}
    for e in events[1:]:
        ev, cyc, rx = e["event"], e.get("cycle"), e.get("rx")
        if ev in CYCLE_EVENTS:
            c = cycles.setdefault(cyc, {"open": False, "budget_calls": 0, "budget_usd": 0.0,
                                        "spent_calls": 0, "spent_usd": 0.0, "failed_streak": 0})
            if ev == "cycle-open":
                c.update(open=True, budget_calls=e["data"]["budget_calls"], budget_usd=e["data"]["budget_usd"])
            elif ev == "cycle-close":
                c["open"] = False
            elif ev == "spend":
                c["spent_calls"] += e["data"]["calls"]; c["spent_usd"] += e["data"].get("usd", 0.0)
            elif ev == "budget-raise":
                c["budget_calls"] += e["data"]["calls"]; c["budget_usd"] += e["data"]["usd"]
            continue
        r = rxs.setdefault(rx, {"state": None, "cycle": cyc, "retries": 0, "approval": None,
                                "head_sha": None, "history": []})
        if ev == "approve" and r["state"] in ("failed", "inconclusive"):
            r["retries"] += 1
        r["state"] = TRANSITIONS[ev][1]
        r["history"].append([e["seq"], ev, e["actor"], e["ts"]])
        if ev == "approve":
            r["approval"] = e["data"]
        if ev == "branch-ready":
            r["head_sha"] = e["data"]["head_sha"]
        if ev in ("failed",) and cyc in cycles:
            cycles[cyc]["failed_streak"] += 1
        if ev in ("certified",) and cyc in cycles:
            cycles[cyc]["failed_streak"] = 0
    return rxs, cycles


@contextlib.contextmanager
def locked(home):
    os.makedirs(home, exist_ok=True)
    fd = os.open(path_of(home) + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN); os.close(fd)


def append(home, event):
    events = read(home)
    prev = check_chain(events)
    event = {"seq": len(events), "ts": now(), "prev": prev, **event}
    event["hash"] = sha(canon(event))
    with open(path_of(home), "a", encoding="utf-8") as f:
        f.write(json.dumps(event, sort_keys=True, ensure_ascii=False) + "\n")
        f.flush(); os.fsync(f.fileno())
    return event


def validate_event(events, a, data, evidence):
    mode = events[0]["data"]["mode"]
    if a.actor == "test-fixture":
        if mode != "smoke":
            raise Refused("actor test-fixture is only valid in a smoke-mode ledger")
        actor_role = "operator" if a.event in ("approve", "reject", "withdraw", "applied", "merged", "closed") else None
    else:
        actor_role = a.actor
    rxs, cycles = fold(events)
    cyc = cycles.get(a.cycle)
    if not cyc or not cyc["open"]:
        raise Refused(f"cycle {a.cycle} is not open")
    if a.event not in TRANSITIONS:
        raise Refused(f"unknown event {a.event}")
    allowed_from, _to, actors = TRANSITIONS[a.event]
    cur = rxs.get(a.rx, {}).get("state")
    if cur not in allowed_from:
        raise Refused(f"{a.rx}: cannot '{a.event}' from state {cur!r} (allowed: {sorted(map(str, allowed_from))})")
    if (actor_role or a.actor) not in actors:
        raise Refused(f"{a.rx}: actor {a.actor!r} may not '{a.event}' (allowed: {sorted(actors)})")
    rec = rxs.get(a.rx, {})
    if a.event in ("propose", "revise"):
        if not a.rx_file:
            raise Refused(f"{a.event} requires --rx-file")
        if a.event == "revise" and not a.note:
            raise Refused("revise requires --note explaining what changed")
        data["rx_digest"] = file_digest(a.rx_file)
    if a.event == "approve":
        if rec.get("retries", 0) >= MAX_RETRIES and cur in ("failed", "inconclusive"):
            raise Refused(f"{a.rx}: retry limit {MAX_RETRIES} reached")
        if not a.rx_file:
            raise Refused("approve requires --rx-file (approval binds the prescription digest)")
        try:
            with open(a.rx_file) as f:
                rxj = json.load(f)
            tier = (rxj.get("governor") or {}).get("tier")
            delivery = rxj.get("delivery", "pr")
        except ValueError:
            tier, delivery = None, None
        if tier in (None, "BLOCK"):
            raise Refused(f"{a.rx}: governor tier is {tier!r} — resolve blockers (and run governor.py --write) before approval")
        allowed = RUNBOOK_SCOPES if delivery == "operator" else SCOPES
        scope = data.get("scope")
        if not scope or not set(scope) <= allowed | {s for s in scope if s.startswith("live-calls:")}:
            raise Refused(f"approve of a delivery={delivery!r} prescription requires data.scope ⊆ {sorted(allowed)} + live-calls:<n>")
        if delivery == "operator" and "operator-runbook" not in scope:
            raise Refused("approve of an operator-delivered prescription requires scope 'operator-runbook'")
        data["delivery"] = delivery
        if not data.get("operator_words"):
            raise Refused("approve requires data.operator_words (the operator's approval, verbatim)")
        data["rx_digest"] = file_digest(a.rx_file)
    if a.event in ("start", "pr-opened", "applied"):
        appr = rec.get("approval") or {}
        if a.event == "start" and appr.get("delivery") == "operator":
            raise Refused(f"{a.rx}: operator-delivered — the operator performs the runbook; evolve never starts it")
        if not a.rx_file or file_digest(a.rx_file) != appr.get("rx_digest"):
            raise Refused(f"{a.rx}: prescription changed since approval (or --rx-file missing) — re-approve")
        need = {"start": "evolve-local", "pr-opened": "open-draft-pr", "applied": "operator-runbook"}[a.event]
        if need not in appr.get("scope", []) or (a.event == "pr-opened" and "push-branch" not in appr.get("scope", [])):
            raise Refused(f"{a.rx}: approval scope lacks '{need}'" + (" and 'push-branch'" if a.event == "pr-opened" else ""))
    if a.event == "applied":
        if not data.get("operator_words"):
            raise Refused("applied requires data.operator_words (who performed the runbook, or the operator's direction, verbatim)")
        if not evidence:
            raise Refused("applied requires --evidence (the acceptance-check result after the runbook)")
    if a.event == "verify-abort" and not a.note:
        raise Refused("verify-abort requires --note (what interrupted verification)")
    if a.event == "abandon" and cur in ("failed", "inconclusive") and (actor_role or a.actor) != "operator":
        raise Refused("abandoning a verified prescription is the operator's decision")
    if a.event == "branch-ready":
        for k in ("base_sha", "head_sha", "branch"):
            if not data.get(k):
                raise Refused(f"branch-ready requires data.{k}")
    if a.event in ("certified", "failed", "inconclusive"):
        if not evidence:
            raise Refused(f"{a.event} requires --evidence <verify report>")
        if data.get("head_sha") != rec.get("head_sha"):
            raise Refused(f"{a.rx}: verified head {data.get('head_sha')} != evolved head {rec.get('head_sha')}")
    if a.event == "pr-opened" and not str(data.get("pr_url", "")).startswith("https://github.com/"):
        raise Refused("pr-opened requires data.pr_url")
    if a.event == "merged" and not (data.get("merged_sha") and data.get("source") == "github-api"):
        raise Refused("merged requires data.merged_sha and data.source='github-api' (never asserted)")
    if a.event in ("confirmed", "regressed") and not (data.get("assessment") and data.get("matrix_rows")):
        raise Refused(f"{a.event} requires data.assessment and data.matrix_rows from a later introspect")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    p = sp.add_parser("init"); p.add_argument("--home", required=True); p.add_argument("--mode", choices=["live", "smoke"], default="live")
    p = sp.add_parser("verify"); p.add_argument("--home", required=True)
    p = sp.add_parser("digest"); p.add_argument("file")
    p = sp.add_parser("cycle-open"); p.add_argument("--home", required=True); p.add_argument("--cycle", required=True)
    p.add_argument("--budget-calls", type=int, required=True); p.add_argument("--budget-usd", type=float, required=True); p.add_argument("--actor", required=True)
    p = sp.add_parser("cycle-close"); p.add_argument("--home", required=True); p.add_argument("--cycle", required=True); p.add_argument("--actor", required=True); p.add_argument("--note", default="")
    p = sp.add_parser("spend"); p.add_argument("--home", required=True); p.add_argument("--cycle", required=True)
    p.add_argument("--calls", type=int, required=True); p.add_argument("--usd", type=float, default=0.0); p.add_argument("--actor", required=True); p.add_argument("--note", required=True)
    p = sp.add_parser("budget-raise"); p.add_argument("--home", required=True); p.add_argument("--cycle", required=True)
    p.add_argument("--calls", type=int, required=True); p.add_argument("--usd", type=float, required=True); p.add_argument("--actor", required=True); p.add_argument("--operator-words", required=True)
    p = sp.add_parser("budget"); p.add_argument("--home", required=True); p.add_argument("--cycle", required=True); p.add_argument("--need-calls", type=int, default=0)
    p = sp.add_parser("event"); p.add_argument("--home", required=True); p.add_argument("--cycle", required=True); p.add_argument("--rx", required=True)
    p.add_argument("--event", required=True); p.add_argument("--actor", required=True); p.add_argument("--rx-file"); p.add_argument("--evidence", nargs="*", default=[])
    p.add_argument("--data", default="{}"); p.add_argument("--note", default="")
    p = sp.add_parser("state"); p.add_argument("--home", required=True); p.add_argument("--rx"); p.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "digest":
            print(file_digest(a.file)); return 0
        if a.cmd == "init":
            if os.path.exists(path_of(a.home)):
                raise Refused(f"ledger exists at {path_of(a.home)}; refusing to overwrite")
            os.makedirs(a.home, mode=0o700, exist_ok=True)
            e = {"seq": 0, "ts": now(), "prev": GENESIS, "event": "init", "actor": "loop", "data": {"mode": a.mode, "contract": "loop-contract.md v1"}}
            e["hash"] = sha(canon(e))
            with locked(a.home), open(path_of(a.home), "x", encoding="utf-8") as f:
                f.write(json.dumps(e, sort_keys=True) + "\n")
            os.chmod(path_of(a.home), 0o600); print(json.dumps({"ok": True, "mode": a.mode})); return 0
        with locked(a.home):
            events = read(a.home); head = check_chain(events)
            if a.cmd == "verify":
                print(json.dumps({"ok": True, "events": len(events), "head": head, "mode": events[0]["data"]["mode"]})); return 0
            rxs, cycles = fold(events)
            if a.cmd == "state":
                out = {k: v for k, v in rxs.items() if not a.rx or k == a.rx}
                if a.json:
                    print(json.dumps({"rx": out, "cycles": cycles}, indent=2))
                else:
                    for k, v in out.items():
                        print(f"{k}\t{v['state']}\tretries={v['retries']}\tcycle={v['cycle']}")
                    for k, c in cycles.items():
                        print(f"{k}\topen={c['open']}\tcalls {c['spent_calls']}/{c['budget_calls']}\tusd {c['spent_usd']:.4f}/{c['budget_usd']:.2f}\tfailed_streak={c['failed_streak']}")
                return 0
            if a.cmd == "budget":
                c = cycles.get(a.cycle)
                if not c:
                    raise Refused(f"unknown cycle {a.cycle}")
                rem = {"calls": c["budget_calls"] - c["spent_calls"], "usd": round(c["budget_usd"] - c["spent_usd"], 6)}
                print(json.dumps(rem))
                if rem["calls"] < max(a.need_calls, 0) or rem["usd"] < 0 or (a.need_calls and rem["calls"] <= 0):
                    raise Refused(f"budget insufficient for {a.need_calls} call(s)")
                return 0
            mode = events[0]["data"]["mode"]
            if a.actor == "test-fixture" and mode != "smoke":
                raise Refused("actor test-fixture is only valid in a smoke-mode ledger")
            if a.cmd == "cycle-open":
                if a.cycle in cycles:
                    raise Refused(f"cycle {a.cycle} already exists")
                zero = a.budget_calls == 0 and a.budget_usd == 0
                if a.actor not in ("operator", "test-fixture") and not (zero and a.actor == "loop"):
                    raise Refused("cycle-open with a non-zero budget needs actor operator; the loop may open zero-budget cycles only")
                e = append(a.home, {"event": "cycle-open", "cycle": a.cycle, "actor": a.actor, "data": {"budget_calls": a.budget_calls, "budget_usd": a.budget_usd}})
            elif a.cmd == "cycle-close":
                if not cycles.get(a.cycle, {}).get("open"):
                    raise Refused(f"cycle {a.cycle} not open")
                e = append(a.home, {"event": "cycle-close", "cycle": a.cycle, "actor": a.actor, "note": a.note, "data": {}})
            elif a.cmd == "budget-raise":
                if a.actor not in ("operator", "test-fixture"):
                    raise Refused("budget-raise needs actor operator")
                if not cycles.get(a.cycle, {}).get("open"):
                    raise Refused(f"cycle {a.cycle} not open")
                if a.calls < 0 or a.usd < 0 or not a.operator_words.strip():
                    raise Refused("budget-raise needs non-negative amounts and the operator's words")
                e = append(a.home, {"event": "budget-raise", "cycle": a.cycle, "actor": a.actor, "note": "",
                                    "data": {"calls": a.calls, "usd": a.usd, "operator_words": a.operator_words}})
            elif a.cmd == "spend":
                c = cycles.get(a.cycle)
                if not c or not c["open"]:
                    raise Refused(f"cycle {a.cycle} not open")
                e = append(a.home, {"event": "spend", "cycle": a.cycle, "actor": a.actor, "note": a.note, "data": {"calls": a.calls, "usd": a.usd}})
                c2 = fold(read(a.home))[1][a.cycle]
                if c2["spent_calls"] > c2["budget_calls"] or c2["spent_usd"] > c2["budget_usd"]:
                    print(json.dumps({"warning": "budget exceeded — loop must pause", **c2}), file=sys.stderr); return 3
            else:  # event
                try:
                    data = json.loads(a.data)
                    assert isinstance(data, dict)
                except (ValueError, AssertionError):
                    raise Refused("--data must be a JSON object")
                evidence = {}
                for pth in a.evidence:
                    if not os.path.isfile(pth):
                        raise Refused(f"evidence not found: {pth}")
                    evidence[pth] = file_digest(pth)
                validate_event(events, a, data, evidence)
                e = append(a.home, {"event": a.event, "cycle": a.cycle, "rx": a.rx, "actor": a.actor,
                                    "data": data, "evidence": evidence, "note": a.note})
            print(json.dumps({"ok": True, "seq": e["seq"], "event": e["event"], "hash": e["hash"][:16]}))
            return 0
    except Refused as r:
        print(json.dumps({"ok": False, "refused": str(r)}), file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
