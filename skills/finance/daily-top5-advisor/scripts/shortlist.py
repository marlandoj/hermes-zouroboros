#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import os
import sys
import urllib.parse as up
from pathlib import Path
from zoneinfo import ZoneInfo


from confidence import CONFIDENCE_MODEL, assess_confidence

LIVE_BASE = "https://api.alpaca.markets"
DATA_BASE = "https://data.alpaca.markets"
NEW_YORK = ZoneInfo("America/New_York")
FORECAST_HORIZON_PREMARKET = {
    "id": "first-60-minutes-after-regular-open",
    "start": "09:30 America/New_York",
    "end": "10:30 America/New_York",
    "source": "Daily Top 5 advisor workflow contract",
}
FORECAST_HORIZON_POSTMARKET = {
    "id": "first-60-minutes-of-the-next-premarket-open",
    "start": "07:00 America/New_York next trading day",
    "end": "08:00 America/New_York next trading day",
    "source": "After-hours Top 5 advisor workflow contract",
}
FORECAST_HORIZONS = {
    "premarket": FORECAST_HORIZON_PREMARKET,
    "postmarket": FORECAST_HORIZON_POSTMARKET,
}


def headers():
    candidates = [
        ("ALPACA_LIVE_API_KEY", "ALPACA_LIVE_SECRET_KEY"),
        ("ALPACA_API_KEY", "ALPACA_API_SECRET"),
        ("LIVE_ALPACA_API_KEY", "LIVE_ALPACA_API_SECRET"),
    ]
    for key_name, secret_name in candidates:
        key = os.environ.get(key_name)
        secret = os.environ.get(secret_name)
        if key and secret:
            return {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}
    raise RuntimeError("No configured Alpaca market-data credential pair is available.")


def request(url, auth, params=None):
    import requests  # third-party; imported lazily so --help works without it

    response = requests.get(url, headers=auth, params=params, timeout=30)
    if not response.ok:
        body = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
        raise RuntimeError(f"{response.status_code} {body.get('message', response.reason)}")
    return response.json()


def db_connect():
    import pymysql  # third-party; imported lazily so --help works without it

    parsed = up.urlparse(os.environ["DATABASE_URL"])
    return pymysql.connect(
        host=parsed.hostname,
        port=parsed.port or 3306,
        user=up.unquote(parsed.username or ""),
        password=up.unquote(parsed.password or ""),
        database=parsed.path.lstrip("/"),
        cursorclass=pymysql.cursors.DictCursor,
        connect_timeout=15,
        read_timeout=30,
        write_timeout=30,
        charset="utf8mb4",
    )


def market_session(auth, date):
    calendar = request(f"{LIVE_BASE}/v2/calendar", auth, {"start": date.isoformat(), "end": date.isoformat()})
    return calendar[0] if calendar else None


def fetch_universe():
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT MAX(run_date) AS run_date FROM screener_snapshots")
            run_date = str(cur.fetchone()["run_date"])
            cur.execute(
                """
                SELECT s.run_date, s.ticker, s.name, s.exchange, s.asset_type,
                       CAST(s.price AS DOUBLE) AS price,
                       CAST(s.rsi14 AS DOUBLE) AS rsi14,
                       CAST(s.sma50 AS DOUBLE) AS sma50,
                       CAST(s.sma200 AS DOUBLE) AS sma200,
                       s.volume, s.avg_volume_20d,
                       CAST(s.high_52w AS DOUBLE) AS high_52w,
                       CAST(s.low_52w AS DOUBLE) AS low_52w,
                       s.composite_score, CAST(s.`signal` AS CHAR) AS signal_value,
                       s.factors_json, s.etf_aum, s.etf_category,
                       CAST(s.change_percent AS DOUBLE) AS stored_change_percent,
                       CAST(m.changePercent AS DOUBLE) AS market_change_percent,
                       m.marketCap AS market_cap, m.sector
                FROM screener_snapshots s
                LEFT JOIN market_data m ON m.symbol = s.ticker
                WHERE s.run_date = %s
                  AND s.price > 5
                  AND s.ticker NOT REGEXP '(-WT|-W|-U|-R|\\.WS|\\.U|\\.RT)$'
                ORDER BY s.composite_score DESC, s.volume DESC
                """,
                (run_date,),
            )
            rows = cur.fetchall()
    accepted = []
    for row in rows:
        asset_type = row.get("asset_type")
        exchange = row.get("exchange")
        if asset_type not in {"stock", "etf"}:
            continue
        if asset_type == "stock" and exchange not in {"NYSE", "NASDAQ", "AMEX", "BATS"}:
            continue
        if asset_type == "stock" and int(row.get("market_cap") or 0) < 2_000_000_000:
            continue
        if asset_type == "etf" and int(row.get("etf_aum") or 0) < 250_000_000:
            continue
        factors = row.get("factors_json")
        if isinstance(factors, str):
            try:
                row["factors_json"] = json.loads(factors)
            except json.JSONDecodeError:
                row["factors_json"] = None
        row["confidence"] = assess_confidence(row)
        accepted.append(row)
    return run_date, rows, accepted


def chunks(items, size):
    for index in range(0, len(items), size):
        yield items[index:index + size]


def snapshots(auth, symbols):
    result = {}
    unavailable = []
    valid_symbols = []
    for symbol in symbols:
        if symbol.replace(".", "").isalnum():
            valid_symbols.append(symbol)
        else:
            unavailable.append({"ticker": symbol, "reason": "unsupported nonstandard ticker for Alpaca batch snapshot"})
    for batch in chunks(valid_symbols, 50):
        response = request(f"{DATA_BASE}/v2/stocks/snapshots", auth, {"symbols": ",".join(batch), "feed": "iex"})
        result.update(response)
    missing = set(valid_symbols) - set(result)
    unavailable.extend({"ticker": symbol, "reason": "no Alpaca IEX snapshot returned"} for symbol in sorted(missing))
    return result, unavailable


def normalize(symbol, snapshot, now):
    trade = snapshot.get("latestTrade") or {}
    quote = snapshot.get("latestQuote") or {}
    minute = snapshot.get("minuteBar") or {}
    daily = snapshot.get("dailyBar") or {}
    previous = snapshot.get("prevDailyBar") or {}
    price = float(trade.get("p") or minute.get("c") or daily.get("c") or 0)
    previous_close = float(previous.get("c") or 0)
    bid = float(quote.get("bp") or 0)
    ask = float(quote.get("ap") or 0)
    midpoint = (bid + ask) / 2 if bid > 0 and ask > 0 else 0
    spread_percent = ((ask - bid) / midpoint * 100) if midpoint else None
    volume = int(daily.get("v") or 0)
    vwap = float(daily.get("vw") or price or 0)
    change_percent = ((price / previous_close - 1) * 100) if previous_close else None
    timestamp = trade.get("t") or quote.get("t") or minute.get("t") or daily.get("t")
    timestamp_dt = dt.datetime.fromisoformat(timestamp.replace("Z", "+00:00")) if timestamp else None
    data_age_seconds = max(0, (now - timestamp_dt).total_seconds()) if timestamp_dt else None
    return {
        "ticker": symbol,
        "price": price,
        "previous_close": previous_close,
        "premarket_change_percent": change_percent,
        "bid": bid,
        "ask": ask,
        "spread_percent": spread_percent,
        "session_volume": volume,
        "session_vwap": vwap,
        "session_dollar_volume": volume * vwap,
        "timestamp": timestamp,
        "data_age_seconds": data_age_seconds,
        "source": "Alpaca Market Data API v2, IEX feed",
    }


def recent_news(auth, symbols, now):
    result = {symbol: [] for symbol in symbols}
    start = now - dt.timedelta(hours=24)
    for batch in chunks(symbols, 50):
        payload = request(
            f"{DATA_BASE}/v1beta1/news",
            auth,
            {
                "symbols": ",".join(batch),
                "start": start.isoformat().replace("+00:00", "Z"),
                "end": now.isoformat().replace("+00:00", "Z"),
                "limit": 50,
                "sort": "desc",
                "include_content": "false",
            },
        )
        for item in payload.get("news") or []:
            for symbol in item.get("symbols") or []:
                if symbol in result:
                    result[symbol].append({
                        "headline": item.get("headline"),
                        "summary": item.get("summary"),
                        "created_at": item.get("created_at"),
                        "source": item.get("source"),
                        "url": item.get("url"),
                    })
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--mode", choices=["premarket", "postmarket"], default="premarket")
    args = parser.parse_args()
    forecast_horizon = FORECAST_HORIZONS[args.mode]
    now_et = dt.datetime.now(NEW_YORK)
    now_utc = now_et.astimezone(dt.timezone.utc)
    auth = headers()
    session = market_session(auth, now_et.date())
    target_market_date = None
    if args.mode == "postmarket":
        upcoming = request(
            f"{LIVE_BASE}/v2/calendar",
            auth,
            {
                "start": (now_et.date() + dt.timedelta(days=1)).isoformat(),
                "end": (now_et.date() + dt.timedelta(days=7)).isoformat(),
            },
        )
        target_market_date = upcoming[0]["date"] if upcoming else None
    output = {
        "generated_at": now_utc.isoformat(),
        "market_date": now_et.date().isoformat(),
        "analysis_mode": args.mode,
        "target_market_date": target_market_date,
        "analysis_timezone": "America/New_York",
        "market_open": session is not None,
        "calendar": session,
        "forecast_horizon": forecast_horizon,
        "max_data_age_seconds": 7200 if args.mode == "postmarket" else 600,
        "confidence_model": CONFIDENCE_MODEL,
    }
    if not session:
        output["status"] = "market_closed"
    else:
        run_date, raw_universe, universe = fetch_universe()
        assessed_count = sum(1 for row in universe if row.get("confidence", {}).get("band") in {"KNOWN", "EDGE", "UNKNOWN"})
        confidence_coverage = {
            "assessed": assessed_count,
            "expected": len(universe),
            "complete": assessed_count == len(universe),
        }
        if not confidence_coverage["complete"]:
            output.update({
                "status": "warning",
                "warning": "confidence_assessment_incomplete",
                "screener_run_date": run_date,
                "raw_universe_count": len(raw_universe),
                "eligible_universe_count": len(universe),
                "confidence_coverage": confidence_coverage,
                "qualifier_count": 0,
                "qualifiers": [],
            })
            target = Path(args.output)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(output, indent=2, default=str) + "\n")
            print(json.dumps({"output": str(target), "status": output["status"], "market_open": output["market_open"], "qualifier_count": 0}, indent=2))
            return
        by_symbol = {row["ticker"]: row for row in universe}
        live = []
        snapshot_data, unavailable = snapshots(auth, list(by_symbol))
        for symbol, snapshot in snapshot_data.items():
            item = normalize(symbol, snapshot, now_utc)
            if item["price"] <= 5:
                continue
            if item["session_dollar_volume"] < 2_000_000:
                continue
            if item["spread_percent"] is None or item["spread_percent"] > 1:
                continue
            max_data_age = 7200 if args.mode == "postmarket" else 600
            if item["data_age_seconds"] is None or item["data_age_seconds"] > max_data_age:
                continue
            item["screener"] = by_symbol[symbol]
            item["forecast_horizon"] = forecast_horizon
            if args.mode == "postmarket":
                item["after_hours_change_percent"] = item["premarket_change_percent"]
            live.append(item)
        live.sort(key=lambda item: (item["premarket_change_percent"] if item["premarket_change_percent"] is not None else -999, item["session_dollar_volume"], item["screener"].get("composite_score") or 0), reverse=True)
        news = recent_news(auth, [item["ticker"] for item in live[:100]], now_utc) if live else {}
        for item in live:
            item["news_24h"] = news.get(item["ticker"], [])
        output.update({
            "status": "ok",
            "screener_run_date": run_date,
            "raw_universe_count": len(raw_universe),
            "eligible_universe_count": len(universe),
            "confidence_coverage": confidence_coverage,
            "market_data_unavailable": unavailable,
            "qualifier_count": len(live),
            "qualifiers": live,
        })
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(output, indent=2, default=str) + "\n")
    print(json.dumps({"output": str(target), "status": output["status"], "market_open": output["market_open"], "qualifier_count": output.get("qualifier_count", 0)}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"error: {type(error).__name__}: {error}", file=sys.stderr)
        raise
