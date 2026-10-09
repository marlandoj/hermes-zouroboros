"""Canonical decision gates for the Daily Top 5 advisor.

Every run imports this module instead of re-authoring gate logic inline. All
thresholds come from config/gates.json so a nightly run cannot silently invent
its own rules.

Fixed 2026-10-01 (source constraint diagnostic, not distributed):

  * frac_allowed() no longer reads the non-existent asset field
    `fractional_eh_enabled`. It asserts account-level `fractional_trading` and
    per-asset `fractionable`, and raises when a required field is absent rather
    than defaulting to whole shares.
  * hard indicator #2 was re-scoped from "price within 1.5% of the 161.8%
    extension" to "price pulled back into the [leg_high, ext_161_8] confluence
    band while holding the EMA-20". The old level sits above price 100% of the
    time (median gap 14.02%), so it could never fire on a pullback.
  * indicators with no collected data are reported as None, not 0.0, so an
    uncollected indicator can never masquerade as an evaluated non-hit.
"""

from __future__ import annotations

import json
import os
from typing import Any, Mapping, Sequence

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config", "gates.json")


class GateDataError(RuntimeError):
    """Raised when a required field is missing. Never degrade to a default."""


class GateConfigError(RuntimeError):
    """Raised when config/gates.json does not define a required key."""


def load_config(path: str | None = None) -> dict[str, Any]:
    with open(path or CONFIG_PATH, encoding="utf-8") as fh:
        return json.load(fh)


# --------------------------------------------------------------------------
# Fractional trading eligibility
# --------------------------------------------------------------------------

def frac_allowed(
    asset: Mapping[str, Any],
    account_config: Mapping[str, Any],
    cfg: Mapping[str, Any],
) -> bool:
    """Return True when fractional sizing is permitted for this symbol.

    `asset` is one /v2/assets/{symbol} record; `account_config` is the
    /v2/account/configurations record. Both must be present. A missing key is a
    GateDataError -- the previous behaviour silently returned False forever
    because the field it asked for does not exist in Alpaca's schema.
    """
    ps = cfg["position_sizing"]
    if not ps.get("allow_fractional", False):
        return False

    field_map = ps.get("fractional_field_map") or {}
    for src_name, src, label in (
        ("asset", asset, "asset.fractionable"),
        ("account", account_config, "account.fractional_trading"),
    ):
        field = field_map.get(src_name)
        if not field:
            raise GateConfigError(
                f"config.position_sizing.fractional_field_map.{src_name} is not set"
            )
        if src is None:
            raise GateDataError(f"missing {label} record")
        if not isinstance(src, Mapping) or field not in src:
            raise GateDataError(
                f"Alpaca response is missing {label!r} (field {field!r})"
            )

    if ps.get("fail_loud_on_missing_field", True) and asset.get("status") not in (None, "active"):
        raise GateDataError(f"asset {asset.get('symbol')} is not tradable: status={asset.get('status')!r}")

    return bool(account_config.get("fractional_trading")) and bool(asset.get("fractionable"))


# --------------------------------------------------------------------------
# Confluence scoring
# --------------------------------------------------------------------------

def _pct(price: float, level: float) -> float:
    return abs(price - level) / price * 100.0 if price else float("inf")


def confluence_band(leg_low: float, leg_high: float, fib_ratio: float) -> tuple[float, float]:
    """Confluence band between the impulse-leg high and its 161.8% extension.

    The extension always sits above the leg high, so band_low is the leg high.
    Kept as a tuple so the geometry stays explicit if the ratio is ever < 1.
    """
    ext = leg_low + fib_ratio * (leg_high - leg_low)
    return (min(leg_high, ext), max(leg_high, ext))


def hard_indicator_2(
    close: float,
    ema20: float,
    leg_low: float,
    leg_high: float,
    cfg: Mapping[str, Any],
) -> dict[str, Any]:
    """Re-scoped Fibonacci confluence: a pullback INTO the band holding EMA-20."""
    spec = cfg["confluence"]["hard_2_fib_confluence_band"]
    if not spec.get("enabled", True):
        return {"hit": False, "points": 0, "disabled": True}

    band_low, band_high = confluence_band(leg_low, leg_high, spec.get("fib_ratio", 1.618))
    depth_pct = (band_low - close) / close * 100.0 if close else float("inf")
    in_band = 0.0 <= depth_pct <= spec.get("max_band_depth_pct", 3.0)
    ema_hold = (close <= ema20) if spec.get("require_ema20_hold", True) else True
    hit = bool(in_band and ema_hold)

    return {
        "hit": hit,
        "points": 2 if hit else 0,
        "band_low": round(band_low, 4),
        "band_high": round(band_high, 4),
        "depth_below_band_pct": round(depth_pct, 3),
        "in_band": in_band,
        "ema20_hold": ema_hold,
    }


def hard_indicator_1(close: float, ema20: float, leg_low: float, leg_high: float, cfg: Mapping[str, Any]) -> dict[str, Any]:
    """Unchanged: EMA-20 within tolerance of the 161.8% extension."""
    spec = cfg["confluence"]["hard_1_ema20_vs_extension"]
    if not spec.get("enabled", True):
        return {"hit": False, "points": 0, "disabled": True}
    ext = leg_low + 1.618 * (leg_high - leg_low)
    hit = _pct(ema20, ext) <= spec.get("tolerance_pct", 1.0)
    return {"hit": hit, "points": 1 if hit else 0, "ext_161_8": round(ext, 4)}


def score_confluence(
    close: float,
    ema20: float,
    leg_low: float,
    leg_high: float,
    cfg: Mapping[str, Any],
    soft: Mapping[str, bool] | None = None,
) -> dict[str, Any]:
    """Return the confluence score dict consumed by the report builder.

    Unavailable indicators contribute `None` points, which is surfaced as 'n/a'
    in the report rather than as a 0 that reads like a genuine non-hit.
    """
    h1 = hard_indicator_1(close, ema20, leg_low, leg_high, cfg)
    h2 = hard_indicator_2(close, ema20, leg_low, leg_high, cfg)

    hard = [h1, h2]
    soft_specs = cfg.get("soft_indicators", {})
    soft_hits: dict[str, int | None] = {}
    for name, spec in soft_specs.items():
        if name.startswith("_"):
            continue
        if not spec.get("enabled", False):
            soft_hits[name] = None
        else:
            hit = bool((soft or {}).get(name, False))
            soft_hits[name] = 1 if hit else 0

    nhard = sum(1 for i in hard if i["hit"])
    pts = sum(i["points"] for i in hard) + sum(v for v in soft_hits.values() if v)

    c = cfg["confluence"]
    return {
        "hard_indicators": {"h1_ema20_vs_extension": h1, "h2_fib_confluence_band": h2},
        "soft_indicators": soft_hits,
        "total_points": pts,
        "hard_indicator_hits": nhard,
        "threshold": f">= {c['min_total_points']} points with >= {c['min_hard_indicators']} hard indicator(s)",
        "qualifies": bool(pts >= c["min_total_points"] and nhard >= c["min_hard_indicators"]),
    }


def whole_share_cap(equity: float, price: float, cfg: Mapping[str, Any]) -> int:
    """Max whole shares within the single-security cap. 0 means whole shares unaffordable."""
    cap_dollars = equity * cfg["position_sizing"]["max_single_security_pct"] / 100.0
    return int(cap_dollars // price) if price > 0 else 0


def concentration_flags(
    equity: float,
    position_value_after_fill: float,
    sector_value_after_fill: float,
    cfg: Mapping[str, Any],
) -> dict:
    """Standing risk rules after a proposed fill: a single security above the cap blocks the
    ticket; a sector above the flag threshold is surfaced to the operator, never hidden."""
    if equity <= 0:
        raise GateDataError("portfolio equity must be a positive, fresh value before sizing")
    sizing = cfg["position_sizing"]
    position_pct = 100.0 * position_value_after_fill / equity
    sector_pct = 100.0 * sector_value_after_fill / equity
    return {
        "position_pct": round(position_pct, 4),
        "sector_pct": round(sector_pct, 4),
        "position_over_cap": position_pct > sizing["max_single_security_pct"],
        "sector_flag": sector_pct > sizing["sector_flag_pct"],
    }
