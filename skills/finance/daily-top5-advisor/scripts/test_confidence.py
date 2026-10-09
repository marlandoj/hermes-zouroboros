import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from confidence import assess_confidence  # noqa: E402


def row(**overrides):
    value = {
        "price": 100,
        "market_change_percent": 0.4,
        "stored_change_percent": 0.4,
        "volume": 1_000_000,
        "avg_volume_20d": 1_000_000,
        "rsi14": 52,
        "sma50": 98,
        "sma200": 95,
        "high_52w": 130,
        "low_52w": 70,
        "composite_score": 55,
        "signal_value": "HOLD",
    }
    value.update(overrides)
    return value


def test_calm_full_history_row_is_known():
    result = assess_confidence(row())
    assert result["band"] == "KNOWN"
    assert result["confidence"] >= 0.70


def test_missing_indicators_force_unknown():
    result = assess_confidence(row(rsi14=None, sma50=None, sma200=None))
    assert result["band"] == "UNKNOWN"
    assert "No usable price history" in result["reasons"][0]


def test_zero_rsi_is_treated_as_missing():
    result = assess_confidence(row(rsi14=0))
    assert all("oversold" not in reason.lower() for reason in result["reasons"])


def test_abnormal_regime_cannot_be_known():
    result = assess_confidence(
        row(rsi14=88, volume=8_000_000, market_change_percent=15, price=129.8)
    )
    assert result["band"] in {"EDGE", "UNKNOWN"}


def test_market_change_matches_copilot_precedence():
    current = assess_confidence(row(market_change_percent=15, stored_change_percent=0.1))
    stored = assess_confidence(row(market_change_percent=None, stored_change_percent=0.1))
    assert current["signals"]["ood"] > stored["signals"]["ood"]


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
