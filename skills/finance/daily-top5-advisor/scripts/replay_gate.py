"""Replay the Pullback Confluence gate over history and score forward returns.

This is the evidence harness for the 2026-10-01 gate repair. It exercises the
SHIPPED gates.hard_indicator_2 (not a local re-implementation), so the numbers
here and the numbers a live run produces come from one code path.

What it measures, per symbol-day:
  * how far the 60d 161.8% extension sits above price (the structural defect)
  * hit rate of the pre-repair rule vs the shipped rule
  * mean forward 5-session return conditioned on each, vs the unconditional base

Read-only. Fetches daily bars and nothing else. Places no orders.

Usage (Alpaca market-data credentials in the environment, e.g. the Hermes profile's):
    python3 replay_gate.py [--symbols QQQ,IVV,...] [--cache PATH]
"""
from __future__ import annotations

import argparse
import json
import os
import statistics as st
import sys
import tempfile
import time
import urllib.request
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gates import hard_indicator_2, load_config  # noqa: E402

DATA = "https://data.alpaca.markets"
START, END = "2023-09-01", "2026-10-02"
DEFAULT_SYMS = [
    "AES", "WBD", "CZR", "NOV", "KVUE", "QQQ", "QQQM", "IVV", "IEMG", "EEM",
    "IWD", "EWJ", "EFA", "XLF", "VEA", "NKE", "IWM", "CIFR", "AMD", "PLTR",
    "PSLV", "AG", "SPY", "VTI", "DIA",
]
DEFAULT_CACHE = os.path.join(tempfile.gettempdir(), "daily-top5-gate-audit", "bars2.json")
LOOKBACK = 60
FWD = 5


def keypair() -> tuple[str, str]:
    for k, s in (
        ("LIVE_ALPACA_API_KEY", "LIVE_ALPACA_API_SECRET"),
        ("ALPACA_LIVE_API_KEY", "ALPACA_LIVE_SECRET_KEY"),
        ("ALPACA_API_KEY", "ALPACA_API_SECRET"),
    ):
        if os.environ.get(k) and os.environ.get(s):
            return os.environ[k], os.environ[s]
    sys.exit("no alpaca keypair found in the environment")


def fetch(sym: str, key: str, sec: str) -> list[dict]:
    url = (f"{DATA}/v2/stocks/{sym}/bars?timeframe=1Day&start={START}"
           f"&end={END}&limit=10000&adjustment=all&feed=iex")
    req = urllib.request.Request(
        url, headers={"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": sec})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r).get("bars") or []


def load_bars(syms: list[str], cache: str) -> dict[str, list[dict]]:
    if os.path.exists(cache):
        return json.load(open(cache, encoding="utf-8"))
    key, sec = keypair()
    bars: dict[str, list[dict]] = {}
    for s in syms:
        try:
            bars[s] = fetch(s, key, sec)
            print(f"  {s}: {len(bars[s])} bars", flush=True)
            time.sleep(0.15)
        except Exception as e:  # noqa: BLE001
            print(f"  FAILED {s}: {e}", flush=True)
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    with open(cache, "w", encoding="utf-8") as fh:
        json.dump(bars, fh)
    return bars


def ema(v: list[float], n: int) -> float:
    k, out = 2.0 / (n + 1), v[0]
    for x in v[1:]:
        out = x * k + out * (1 - k)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", default="")
    ap.add_argument("--cache", default=DEFAULT_CACHE)
    args = ap.parse_args()
    syms = args.symbols.split(",") if args.symbols else DEFAULT_SYMS
    cfg = load_config()

    bars = load_bars(syms, args.cache)
    n = 0
    gaps: list[float] = []
    fwd: dict[str, list[float]] = {"pre_repair": [], "shipped": [], "baseline": []}
    hits = Counter()
    per_sym = Counter()

    for sym, bs in bars.items():
        bs = sorted(bs, key=lambda b: b["t"])
        C = [b["c"] for b in bs]
        H = [b["h"] for b in bs]
        L = [b["l"] for b in bs]
        for i in range(LOOKBACK, len(C) - FWD):
            c = C[i]
            leg_lo = min(L[i - LOOKBACK + 1:i + 1])
            leg_hi = max(H[i - LOOKBACK + 1:i + 1])
            e20 = ema(C[max(0, i - 19):i + 1], 20)
            ext = leg_lo + 1.618 * (leg_hi - leg_lo)
            gaps.append((ext - c) / c * 100)
            n += 1
            r5 = (C[i + FWD] - c) / c * 100
            fwd["baseline"].append(r5)

            # The rule exactly as build-analysis.py evaluated it before
            # 2026-10-01, reproduced verbatim. The denominator is CLOSE, not
            # the extension -- using `ext` here misreports the old hit count.
            if abs(e20 - ext) / c * 100 <= 1.0 and abs(c - ext) / c * 100 <= 1.5:
                hits["pre_repair"] += 1
                fwd["pre_repair"].append(r5)

            # the shipped rule, straight from gates.py
            if hard_indicator_2(c, e20, leg_lo, leg_hi, cfg)["hit"]:
                hits["shipped"] += 1
                fwd["shipped"].append(r5)
                per_sym[sym] += 1

    if n == 0:
        sys.exit("no symbol-days evaluated")

    print(f"\nsymbol-days evaluated: {n}")
    print("\nSTRUCTURAL DIAGNOSTIC -- 60d 161.8% extension vs price")
    print(f"  extension above price on {sum(1 for x in gaps if x > 0) / n * 100:.1f}% of symbol-days")
    print(f"  median gap = {st.median(gaps):.2f}%  (old tolerance was 1.5%)")

    print(f"\nHIT RATE + forward {FWD}-session return")
    print(f"  {'rule':<14} {'hits':>6} {'rate':>8} {'fwd':>8} {'vs base':>9}")
    base = st.mean(fwd["baseline"])
    for k in ("pre_repair", "shipped"):
        m = st.mean(fwd[k]) if fwd[k] else float("nan")
        rate = f"{hits[k] / n * 100:.2f}%" if n else "-"
        delta = f"{m - base:+.2f}%" if fwd[k] else "n/a"
        print(f"  {k:<14} {hits[k]:>6} {rate:>8} {m:>7.2f}% {delta:>9}")
    print(f"  {'baseline':<14} {n:>6} {'100.00%':>8} {base:>7.2f}% {'--':>9}")

    print("\nHIT CONCENTRATION -- is the gate still M&A-pinned?")
    for s, v in per_sym.most_common(10):
        print(f"  {s:<6} {v}")


if __name__ == "__main__":
    main()
