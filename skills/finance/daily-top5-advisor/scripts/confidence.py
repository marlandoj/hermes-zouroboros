from __future__ import annotations

import math


CONFIDENCE_MODEL = {
    "name": "screener-confidence-band",
    "version": "zou-295-299-v1",
    "bands": {"known_min": 0.70, "edge_min": 0.45},
    "source": "screener confidence-band engine",
}


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def ramp(value: float, low: float, high: float) -> float:
    if high == low:
        return 1.0 if value >= high else 0.0
    return clamp01((value - low) / (high - low))


def thin_history_signal(row: dict) -> float:
    if row.get("sma200") is not None:
        return 0.0
    if row.get("sma50") is not None:
        return 0.45
    if clean_rsi(row.get("rsi14")) is not None:
        return 0.75
    return 1.0


def clean_rsi(value):
    if value is None:
        return None
    numeric = float(value)
    return numeric if math.isfinite(numeric) and numeric > 0 else None


def source_change_percent(row: dict) -> float:
    current = row.get("market_change_percent")
    stored = row.get("stored_change_percent")
    return float(current if current is not None else stored if stored is not None else 0)


def out_of_distribution_signal(row: dict) -> float:
    parts = []
    rsi = clean_rsi(row.get("rsi14"))
    if rsi is not None:
        parts.append(max(ramp(rsi, 70, 85), ramp(rsi, 30, 15)))

    volume = float(row.get("volume") or 0)
    average_volume = float(row.get("avg_volume_20d") or 0)
    if volume > 0 and average_volume > 0:
        ratio = volume / average_volume
        parts.append(max(ramp(ratio, 2, 5), ramp(ratio, 0.3, 0.05)))

    price = float(row.get("price") or 0)
    high = float(row.get("high_52w") or 0)
    low = float(row.get("low_52w") or 0)
    span = high - low
    if price > 0 and span > 0:
        position = clamp01((price - low) / span)
        parts.append(max(ramp(position, 0.9, 0.99), ramp(position, 0.1, 0.01)))

    change = source_change_percent(row)
    parts.append(ramp(abs(change), 5, 12))
    if not parts:
        return 0.0
    return clamp01(max(parts) * 0.7 + (sum(parts) / len(parts)) * 0.3)


def favorability(row: dict) -> float:
    score = row.get("composite_score")
    score_component = ramp(abs(float(score) - 50), 0, 35) if score is not None else 0.0
    decisive = 0.15 if row.get("signal_value") in {"BUY", "SELL"} else 0.0
    return clamp01(score_component + decisive)


def reasons(row: dict, signals: dict, band: str) -> list[str]:
    result = []
    thin = signals["thinHistory"]
    if thin >= 0.95:
        result.append("No usable price history — indicators unavailable.")
    elif thin >= 0.7:
        result.append("Thin price history — long-term trend (SMA200) unavailable.")
    elif thin >= 0.4:
        result.append("Limited history — no 200-day moving average yet.")

    rsi = clean_rsi(row.get("rsi14"))
    if rsi is not None and (rsi >= 75 or rsi <= 25):
        state = "overbought" if rsi >= 75 else "oversold"
        result.append(f"RSI {rsi:.0f} is in {state} extreme.")

    volume = float(row.get("volume") or 0)
    average_volume = float(row.get("avg_volume_20d") or 0)
    if average_volume > 0:
        ratio = volume / average_volume
        if ratio >= 3:
            result.append(f"Volume {ratio:.1f}× its 20-day average.")
        elif 0 < ratio <= 0.25:
            result.append("Volume dried up vs its 20-day average.")

    price = float(row.get("price") or 0)
    high = float(row.get("high_52w") or 0)
    low = float(row.get("low_52w") or 0)
    if price > 0 and high > low:
        position = (price - low) / (high - low)
        if position >= 0.97:
            result.append("Trading at the top of its 52-week range (breakout).")
        elif position <= 0.03:
            result.append("Trading at the bottom of its 52-week range (breakdown).")

    change = source_change_percent(row)
    if abs(change) >= 8:
        result.append(f"Large single-session move ({change:+.1f}%).")
    if signals["goodhart"] >= 0.5:
        result.append("Favorable score is driven by abnormal conditions — treat the signal with caution.")
    if not result and band == "KNOWN":
        result.append("Indicators sit within well-modeled ranges.")
    return result


def assess_confidence(row: dict) -> dict:
    thin = thin_history_signal(row)
    ood = out_of_distribution_signal(row)
    goodhart = clamp01(favorability(row) * max(ood, thin))
    uncertainty = clamp01(0.4 * thin + 0.4 * ood + 0.2 * goodhart)
    confidence = clamp01(1 - uncertainty)
    band = "KNOWN" if confidence >= 0.70 else "EDGE" if confidence >= 0.45 else "UNKNOWN"
    if thin >= 0.95:
        band = "UNKNOWN"
    elif (thin >= 0.7 or ood >= 0.85) and band == "KNOWN":
        band = "EDGE"
    signals = {
        "thinHistory": thin,
        "ood": ood,
        "goodhart": goodhart,
    }
    return {
        "band": band,
        "confidence": confidence,
        "signals": signals,
        "reasons": reasons(row, signals, band),
        "model": CONFIDENCE_MODEL["version"],
    }
