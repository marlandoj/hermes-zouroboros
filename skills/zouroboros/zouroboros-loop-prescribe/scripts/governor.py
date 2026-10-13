#!/usr/bin/env python3
"""Risk governor for loop prescriptions (pure, deterministic, no I/O besides reading the file).

Ports the upstream selfheal governor flags (packages/selfheal/src/prescribe/governor.ts:
schema/migration→HIGH, >3 files→MEDIUM, bridge/executor→HIGH, requiresApproval→HIGH) into the
Constitution tiers of zouroboros-loop/references/loop-contract.md:
  BLOCK > G (governance) > H (high) > M (medium) > L (low).

Usage: governor.py PRESCRIPTION.json [--write]   # --write stores the result under "governor"
Exit: 0 tier L/M/H/G, 4 BLOCK, 3 unreadable input.
"""
import fnmatch, json, os, re, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "zouroboros-loop", "scripts"))
from loop_paths import PRODUCTION  # noqa: E402  (deployed checkout, ~/.hermes, profile data — resolved at runtime)

RULES_VERSION = "zo-loop-governor/1"
PRODUCTION_PATHS = tuple(PRODUCTION) + ("~/hermes-zouroboros", "~/.hermes", "~/.local/share/hermes-zouroboros")
G_GLOBS = ["*zouroboros-loop*", "*zouroboros-platform-assessment*", "*heldout*", "CONSTITUTION.md", "ZOUROBOROS.md",
           ".github/workflows/*", "*governance*", "*swarm-decision-gate*", "*governor*", "*plan-gate*", "*constitution*"]
H_GLOBS = {"database / schema / migration": ["*migration*", "*schema*", "packages/memory/src/database.ts"],
           "secret handling / redaction / auth": ["*defense*", "*redact*", "*auth*", "*secret*", "*credential*"],
           "executor bridge": ["*bridge*", "*executor*"],
           "routing weights": ["packages/swarm/src/routing/engine.ts", "*routing*weights*"],
           "process / signal handling": ["integration/cli.ts", "integration/swarm-worker.ts", "*spawn*"],
           "network exposure": ["*qdrant*", "*.container", "*cors*", "*gate-server*", "*server*"]}
H_WORDS = {"concurrency / locking": r"\b(busy_timeout|lock|transaction|concurren\w*|race)\b",
           "process / signal handling": r"\b(SIGTERM|SIGINT|signal|process group|orphan\w*)\b",
           "shell execution": r"\b(execSync|spawnSync|shell)\b",
           "data format / persistence": r"\b(migrat\w*|schema|data format)\b"}
M_GLOBS = {"dependency change": ["package.json", "*/package.json", "pnpm-lock.yaml"],
           "public interface (MCP/CLI)": ["integration/mcp.ts", "integration/cli.ts", "cli/src/*"]}
WEIGHT_WORDS = r"\b(fine-?tun\w*|train(ing)?\s+(the\s+)?model|LoRA|gradient|model weights)\b"
ORDER = ["L", "M", "H", "G", "BLOCK"]


def match(path, globs):
    return any(fnmatch.fnmatch(path, g) or fnmatch.fnmatch(path.split("/")[-1], g) for g in globs)


def evaluate(rx):
    flags = []
    add = lambda tier, rule, why: flags.append({"tier": tier, "rule": rule, "why": why})
    plan = rx.get("change_plan", {}) or {}
    files = list(plan.get("files", []))
    text = " ".join([rx.get("title", ""), rx.get("spec", ""), rx.get("rationale", ""), plan.get("summary", ""),
                     " ".join(plan.get("approach", []))])
    delivery, kind = rx.get("delivery", "pr"), rx.get("kind")
    # BLOCK rules (Arts. I, II, IX)
    if re.search(WEIGHT_WORDS, text, re.I):
        add("BLOCK", "art-I-frozen-weights", "plan mentions training/fine-tuning model weights")
    if not rx.get("acceptance_checks"):
        add("BLOCK", "art-II-no-check", "no executable acceptance check — the change could not be verified")
    if kind == "heal" and delivery == "pr" and not (rx.get("reproduction", {}) or {}).get("meets_expectation"):
        add("BLOCK", "art-II-no-reproduction", "heal without a confirmed red reproduction on the base")
    if kind == "evolve" and not rx.get("baseline"):
        add("BLOCK", "art-II-no-baseline", "evolve without an incumbent baseline")
    if rx.get("open_questions"):
        add("BLOCK", "ambiguity", f"{len(rx['open_questions'])} open question(s) — resolve before approval (upstream: ambiguity > 0.20)")
    for f in files:
        if any(f.startswith(p) for p in PRODUCTION_PATHS):
            add("BLOCK", "production-path", f"{f}: the loop changes repos via PR, never the deployed checkout or live data")
    # G
    for f in files:
        if match(f, G_GLOBS):
            add("G", "art-VIII-self-referential", f"{f}: loop, verify harness, held-out, governance, CI or gate")
    # H
    for rule, globs in H_GLOBS.items():
        hit = [f for f in files if match(f, globs)]
        if hit:
            add("H", rule, ", ".join(hit))
    for rule, rgx in H_WORDS.items():
        m = re.search(rgx, text, re.I)
        if m:
            add("H", rule, f"plan mentions '{m.group(0)}'")
    if delivery == "operator":
        add("H", "operator-delivery", "host/repo-settings change delivered by the operator outside a PR")
    # M
    max_files = int(plan.get("max_files", len(files)) or 0)
    if max(max_files, len(files)) > 3:
        add("M", "upstream-maxFiles>3", f"plan allows {max(max_files, len(files))} files")
    for rule, globs in M_GLOBS.items():
        hit = [f for f in files if match(f, globs)]
        if hit:
            add("M", rule, ", ".join(hit))
    tier = max((fl["tier"] for fl in flags), key=ORDER.index, default="L")
    review = {"L": "operator", "M": "operator", "H": "operator + independent review recommended",
              "G": "operator (separate approval) + independent review", "BLOCK": "not approvable until blockers are fixed"}[tier]
    # de-duplicate identical rule+why pairs, keep order
    seen, uniq = set(), []
    for fl in flags:
        k = (fl["tier"], fl["rule"], fl["why"])
        if k not in seen:
            seen.add(k); uniq.append(fl)
    return {"rules_version": RULES_VERSION, "tier": tier, "approval": review, "flags": uniq}


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    try:
        with open(sys.argv[1]) as f:
            rx = json.load(f)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"unreadable prescription: {e}"}), file=sys.stderr); return 3
    g = evaluate(rx)
    if "--write" in sys.argv[2:]:
        rx["governor"] = g
        with open(sys.argv[1], "w") as f:
            json.dump(rx, f, indent=2, ensure_ascii=False); f.write("\n")
    print(json.dumps(g, indent=2, ensure_ascii=False))
    return 4 if g["tier"] == "BLOCK" else 0


if __name__ == "__main__":
    sys.exit(main())
