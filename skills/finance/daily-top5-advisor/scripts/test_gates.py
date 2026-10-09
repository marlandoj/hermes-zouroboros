"""Regression tests for the 2026-10-01 gate repairs.

Each test pins a specific defect found in the constraint diagnostic so it cannot
silently return. Run: python3 test_gates.py (or python3 -m pytest test_gates.py -q)
"""

import json
import os
import sys

try:
    import pytest
    raises = pytest.raises
except ImportError:  # plain-Python runner; see __main__ below
    from contextlib import contextmanager

    @contextmanager
    def raises(expected):
        try:
            yield
        except expected:
            return
        raise AssertionError(f"{expected.__name__} not raised")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gates import (  # noqa: E402
    GateDataError,
    concentration_flags,
    confluence_band,
    frac_allowed,
    hard_indicator_2,
    load_config,
    score_confluence,
    whole_share_cap,
)

CFG = load_config()


# --- Finding 1: fractional gate read a field Alpaca never returns ------------

def test_frac_allows_when_account_and_asset_support_it():
    asset = {"symbol": "QQQ", "fractionable": True, "status": "active"}
    acct = {"fractional_trading": True}
    assert frac_allowed(asset, acct, CFG) is True


def test_frac_denies_when_asset_not_fractionable():
    asset = {"symbol": "XYZ", "fractionable": False, "status": "active"}
    acct = {"fractional_trading": True}
    assert frac_allowed(asset, acct, CFG) is False


def test_frac_denies_when_account_disabled():
    asset = {"symbol": "QQQ", "fractionable": True, "status": "active"}
    assert frac_allowed(asset, {"fractional_trading": False}, CFG) is False


def test_frac_raises_instead_of_silently_denying_on_missing_field():
    """The old bug returned False forever because fractional_eh_enabled is absent.

    Absent data must raise, not degrade to whole shares.
    """
    asset = {"symbol": "QQQ", "status": "active"}  # no 'fractionable'
    acct = {"fractional_trading": True}
    with raises(GateDataError):
        frac_allowed(asset, acct, CFG)


def test_frac_raises_when_asset_record_missing_entirely():
    with raises(GateDataError):
        frac_allowed(None, {"fractional_trading": True}, CFG)


def test_alpaca_payload_shape_is_accepted():
    """Real /v2/assets response: fractional_eh_enabled is a string inside
    `attributes`, not a top-level boolean. Must not be mistaken for a boolean."""
    asset = {
        "id": "42bb557d",
        "class": "us_equity",
        "exchange": "NASDAQ",
        "symbol": "QQQ",
        "status": "active",
        "tradable": True,
        "fractionable": True,
        "attributes": ["fractional_eh_enabled", "has_options"],
    }
    assert frac_allowed(asset, {"fractional_trading": True}, CFG) is True


# --- Finding 2: the 161.8% level sits above price 100% of the time ----------

def test_confluence_band_geometry():
    low, high = 100.0, 120.0
    band_low, band_high = confluence_band(low, high, 1.618)
    assert band_low == 120.0            # the leg high
    assert round(band_high, 2) == 132.36  # 100 + 1.618*20


def test_hard2_fires_on_a_shallow_pullback_holding_ema():
    """The case the old rule rejected: an uptrend pulling back into the band."""
    close, ema20 = 119.0, 119.5  # pullback tagged EMA-20 support
    res = hard_indicator_2(close, ema20, 100.0, 120.0, CFG)
    assert res["hit"] is True
    assert res["points"] == 2
    assert res["in_band"] is True and res["ema20_hold"] is True


def test_hard2_fires_within_max_band_depth():
    # band_low == leg_high == 120. Price must sit 0-3% below it AND have
    # reached the EMA-20 (close <= ema20). 117.5 is 2.13% below the band low.
    assert hard_indicator_2(117.5, 118.0, 100.0, 120.0, CFG)["hit"] is True
    # 116.0 is 3.45% below the band low -> deeper than max_band_depth_pct.
    assert hard_indicator_2(116.0, 118.0, 100.0, 120.0, CFG)["hit"] is False


def test_hard2_requires_price_to_reach_the_ema20():
    """Price inside the band but still above its EMA-20 is not yet a pullback."""
    res = hard_indicator_2(119.0, 118.0, 100.0, 120.0, CFG)  # close > ema20
    assert res["hit"] is False


def test_hard2_does_not_fire_at_a_new_high():
    """The old rule only ever fired here, which is the opposite of a pullback."""
    res = hard_indicator_2(125.0, 124.0, 100.0, 120.0, CFG)  # above the leg high
    assert res["hit"] is False


def test_score_confluence_relaxes_to_one_hard_indicator():
    c = CFG["confluence"]
    assert c["min_hard_indicators"] == 1
    assert c["min_total_points"] == 4


def test_score_marks_uncollected_soft_indicator_as_none_not_zero():
    """Finding 3: s_rev rendered as 0 points, implying it was evaluated."""
    out = score_confluence(119.0, 118.5, 100.0, 120.0, CFG, soft={})
    assert out["soft_indicators"]["s_rev_30s_reversal"] is None
    assert out["soft_indicators"]["range_20_low_reversal"] == 0


def test_score_qualifies_a_plausible_pullback():
    soft = {"range_20_low_reversal": True, "avwap_1sigma_reclaim": True}
    out = score_confluence(119.0, 119.6, 100.0, 120.0, CFG, soft=soft)
    assert out["hard_indicator_hits"] == 1
    assert out["total_points"] >= 4
    assert out["qualifies"] is True


# --- Standing risk rule: must be unchanged ---------------------------------

def test_five_percent_cap_unchanged():
    assert CFG["position_sizing"]["max_single_security_pct"] == 5.0
    assert whole_share_cap(967.0, 25.0, CFG) == 1   # $48.35 cap
    assert whole_share_cap(967.0, 60.0, CFG) == 0   # unaffordable whole


def test_concentration_flags_block_over_cap_and_flag_sector():
    ok = concentration_flags(10_000.0, 400.0, 2_000.0, CFG)
    assert ok["position_over_cap"] is False and ok["sector_flag"] is False
    over = concentration_flags(10_000.0, 600.0, 2_600.0, CFG)
    assert over["position_over_cap"] is True and over["sector_flag"] is True
    with raises(GateDataError):
        concentration_flags(0.0, 1.0, 1.0, CFG)


# --- Finding 5: thresholds are externalized ---------------------------------

def test_config_is_valid_json_and_annotated():
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config", "gates.json")) as fh:
        raw = json.load(fh)
    assert "_comment" in raw
    assert raw["confluence"]["hard_2_fib_confluence_band"]["definition"] == "band_pullback"
    assert raw["soft_indicators"]["s_rev_30s_reversal"]["enabled"] is False


if __name__ == "__main__":
    failures = 0
    tests = [(name, fn) for name, fn in sorted(globals().items()) if name.startswith("test_") and callable(fn)]
    for name, fn in tests:
        try:
            fn()
            print(f"PASS {name}")
        except Exception as error:  # noqa: BLE001
            failures += 1
            print(f"FAIL {name}: {error!r}")
    print(f"{len(tests) - failures} passed, {failures} failed")
    sys.exit(1 if failures else 0)
