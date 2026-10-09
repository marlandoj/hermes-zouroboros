---
name: daily-top5-advisor
description: "Produce an after-hours Top 5 decision-support report from a configured stock/ETF screener database, end-of-day market data and recent catalysts, with approval-ready (never submitted) draft order tickets for the next trading day's premarket open. Research only: never places, changes or cancels orders."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [finance, trading, research, decision-support, Zouroboros]
    related_skills: [strategy-scout]
prerequisites:
  commands: [python3]
---

# After-Hours Top 5 Advisor

Create an auditable evening watchlist for buying in the first 60 minutes of the NEXT trading day's premarket open (7:00–8:00 a.m. America/New_York), using data available after the official 4:00 p.m. close. This is research only: it must not place, change, or cancel brokerage orders, and it has no order-submission capability.

## Financial safety rules (non-negotiable)

These apply to every report, ticket and follow-up conversation:

1. **No trade without explicit confirmation.** Never buy or sell. Before any buy/sell is placed by anyone, present the full order details (ticker, side, quantity, order type, limit price, time-in-force, extended-hours flag, maximum cost, stop, target) and obtain the operator's explicit written confirmation of that exact order. A draft ticket is not authorization.
2. **5% cap per security.** Never recommend a position that would exceed 5% of portfolio value after the fill, counting any existing position in that symbol. If whole-share sizing breaches the cap, omit the ticket; never relax the cap.
3. **Always a stop-loss.** Every recommendation carries a suggested protective stop level and the maximum planned loss before slippage.
4. **Flag concentration.** Flag any position above 5%, any sector above 25% of the portfolio after the proposed fill, and any asset-class imbalance. `gates.concentration_flags()` computes the position and sector shares; `config/gates.json` holds the thresholds.
5. **Tax impact.** Note short-term-gain treatment for positions likely held under a year and wash-sale risk when the symbol (or a substantially identical one) was sold at a loss within 30 days.
6. **Log every recommendation.** Record timestamp, ticker, action, entry/exit targets, stop-loss, size, rationale, horizon and approval status for every recommendation, including omitted or blocked ones.

## Configuration

- `DATABASE_URL` — MySQL connection URL for the screener database. `scripts/shortlist.py` reads the latest `screener_snapshots` run (`run_date, ticker, name, exchange, asset_type, price, rsi14, sma50, sma200, volume, avg_volume_20d, high_52w, low_52w, composite_score, signal, factors_json, etf_aum, etf_category, change_percent`) joined to `market_data` (`symbol, changePercent, marketCap, sector`). Point it at a read-only account.
- Alpaca market-data credentials: `ALPACA_API_KEY` + `ALPACA_API_SECRET` (or `ALPACA_LIVE_API_KEY` + `ALPACA_LIVE_SECRET_KEY`). Only market-data, calendar, account and position reads are used.
- Python packages `requests` and `pymysql`.
- Outputs go to `$ZOUROBOROS_STATE_DIR/daily-top5-advisor/runs/YYYY-MM-DD/` (run date), never inside the skill directory.

All credentials come from the Hermes profile environment. Never print them.

## Run sequence

1. Run `scripts/shortlist.py --mode postmarket` after the regular close and before evening delivery. The script reads the full current screener universe, excludes unqualified securities, records Alpaca IEX evidence, and resolves `target_market_date` (the next official trading day) from the Alpaca calendar. A `--mode premarket` legacy flag reproduces the 9:30–10:30 a.m. opening-window workflow for ad-hoc use only.
   - The producer deterministically attaches `screener.confidence` to every eligible row using the confidence-band model in `scripts/confidence.py`. Require `confidence_coverage.complete=true`; never infer a missing band from the composite score.
   - The forecast horizon is supplied as `forecast_horizon` by this workflow contract: 7:00–8:00 a.m. America/New_York on `target_market_date`. The screener does not publish a separate holding-period field, so absence of a per-row screener horizon is not a data warning.
   - Data basis: the Alpaca IEX feed. Extended-hours trade prints freeze at the 4:00 p.m. consolidated close (quotes can linger later); treat the close print as the authoritative end-of-day price basis and never invent live after-hours quotes. In postmarket mode the freshness bound is relaxed to 7,200 seconds so the frozen close print passes in a 16:45–17:45 run window (`max_data_age_seconds` is emitted in the output).
2. If the result says `market_open: false`, finish silently: do not send a report.
3. If the result says `status: warning`, send a warning report that identifies the unavailable or stale data. Never invent rankings.
4. From the qualifiers, retain only securities above $5, with at least $2 million session dollar volume, a bid-ask spread no wider than 1%, and data within `max_data_age_seconds`. Never relax these gates to manufacture five names.
5. Rank up to five stocks or ETFs by expected percentage upside in the first 60 minutes of the next trading day's premarket open. Use full-session technicals, post-close momentum (change vs previous close), news from the preceding 24 hours, and source-attributed sentiment, plus overnight futures/macro context. A direct catalyst is preferred; clearly label exceptional momentum candidates with no direct fresh catalyst.
6. For each candidate include a conditional next-day premarket strategy and a draft, approval-ready order ticket using a no-chase structure: exact ticker, BUY action, whole-share quantity, limit order, DAY time-in-force, extended-hours eligibility, limit price anchored to the consolidated close print and expected overnight/pre-market support/resistance, maximum cost, portfolio weight, entry condition/window of 7:02–7:32 a.m. America/New_York on `target_market_date`, cancel-if-unfilled time no later than 9:28 a.m. America/New_York on `target_market_date` (never carry into the regular open without new analysis), post-fill protective stop, profit target, expected horizon, maximum planned loss before slippage, rationale, catalyst/sentiment evidence, and risks. Use a pullback or confirmation-based limit cap; never recommend a market order or raising the limit to chase. If the next-day premarket opens above the cap, the ticket is dead — never chase. These are unsubmitted drafts requiring the operator's exact written approval, not guarantees or authorization to trade.

```bash
RUN="${ZOUROBOROS_STATE_DIR:?}/daily-top5-advisor/runs/$(date +%F)"
python3 "${HERMES_SKILL_DIR}/scripts/shortlist.py" --mode postmarket --output "$RUN/shortlist.json"
```

## Report contract

- Target a 5:00 p.m. America/New_York delivery on official market days (run after the official close). The report is dated by run date; the subject line and header display `target_market_date` from shortlist.py, since every ticket targets that date's premarket open.
- Deliver to the operator through the profile's configured channel. If email is used, prepare a draft (rich HTML plus a same-content PDF named `top-5-daily-buys-report-YYYY-MM-DD.pdf`); sending requires the operator's direct instruction. Never hardcode a recipient address in the skill or a scheduled job.
- Use a subject in the form `✅ After-Hours Top 5 - N Approval-Ready Next-Day Premarket Buys (TARGET-MARKET-DATE)` or `⚠️ After-Hours Top 5 - Data Warning (YYYY-MM-DD)`.
- Include an executive summary, compact metrics table, detailed candidate sections, risk/tax cautions, source links, report timestamp, and the statement: `Decision support only; no trade has been placed.`
- Preserve the dated JSON shortlist and rendered report in the run directory.
- Retrieve fresh read-only portfolio value, cash/buying power, current holdings, sector exposure, and broker order capabilities before sizing. If any prerequisite is unavailable, stale, inconsistent, or the candidate conflicts with the screener's own trusted signal direction, do not create an approval-ready ticket for that name; explain the block. Apply the safety rules above after the fill, do not assume margin, and account for existing positions.
- State plainly that the analysis uses end-of-day consolidated data with no live after-hours quotes: overnight news, macro events, or futures moves can invalidate the thesis before 7:00 a.m., and any ticket whose premarket opening price exceeds its limit cap must not be submitted. Premarket tickets must use a whole-share quantity unless the broker explicitly confirms fractional eligibility. "Explicitly confirms" means BOTH of these are read live and asserted: (a) `/v2/account/configurations` returns `fractional_trading: true`, and (b) the `/v2/assets/{symbol}` record for that exact symbol returns `fractionable: true`. A missing, `null`, or `false` value in either is a hard error that must be surfaced, never silently defaulted (the asset field `fractional_eh_enabled` does not exist as a boolean; it appears only as a string in `attributes`). Use `frac_allowed()` in `scripts/gates.py`. Then re-test the 5% single-security cap against the current portfolio value and existing position in that symbol. Alpaca offers no separate flag for extended-hours fractional support, so (a)+(b) do not by themselves prove a fractional premarket order will fill; validate with one minimal paper order before treating fractional premarket sizing as proven. If whole-share sizing breaches the cap, omit the ticket. Record both observed values (`fractional_trading`, `fractionable`) verbatim in the evidence snapshot. State that stop protection generally begins only when the broker accepts/activates it and that the position can gap through the stop; premarket liquidity, spread, partial-fill, volatility, overnight-gap, and opening-reversal risks must be explicit.
- Save the structured draft tickets and evidence snapshot to `approval-ready-orders.json` in the run directory, and append every recommendation (safety rule 6) to `$ZOUROBOROS_STATE_DIR/daily-top5-advisor/recommendations.log.md`.
- Send at most one report per run date. Record the idempotency decision before delivery.

## Tests

`python3 scripts/test_gates.py` and `python3 scripts/test_confidence.py` run offline (pytest optional).

## Pullback Confluence Method

**Purpose:** catch a pullback inside a strong uptrend in the forecast window (the dip-buy setup: a pullback that holds the daily EMA-20 inside the extension band, entered the next morning).

### Hard indicators (entry triggers — require at least one)

| Indicator | Setup rule |
|-----------|------------|
| **EMA-20 (daily)** | Pullback holds above (or touches and reclaims). The dominant structural floor in a strong uptrend. |
| **161.8% Fibonacci extension** | **CORRECTED 2026-10-01.** Do NOT require price within a fixed % of the 161.8% extension. A 161.8% extension sits 61.8% *above* the impulse-leg high, so that level was above price in 100% of 17,675 measured symbol-days (median gap 14.02%) and the old rule could only fire at a new high — the opposite of a pullback. Correct rule: price has pulled back **into** the confluence band `[leg_high, ext_161.8]` — no deeper than `max_band_depth_pct` below the leg high — **and** is at or below the daily EMA-20. Thresholds live in `config/gates.json`. |

### Supporting indicators (raise confidence / score)

| Indicator | Setup rule |
|-----------|------------|
| **RSI-14 daily reset to 40–50** | Pullback from overbought, not overdone — the healthy-pullback band. |
| **LTF anchored VWAP ±1σ** | Lows holding at the VWAP −1σ band, anchored to the week's primary premarket (e.g. Monday 9:30 EDT open). |
| **30-second reversal pattern** | Red 3×(3–5× avg vol) climactic selloff bars → green break of the prior red high on ≥2× average volume. **Requires 30-second bars to be collected.** If the run did not fetch them, report this indicator as *not evaluated* (`None`) — never as 0 points. Scoring it as 0 previously made an unmeasured indicator look like a measured non-hit. |
| **Fibonacci retracement 38.2–61.8%** | Last impulse retracement with instant bounce. |
| **Volume dry-up** | Pullback volume < prior selling volume — exhaustion. |
| **HTF structure intact** | Daily close keeps HH/HL above EMA-20; strong ADX; no fresh bearish catalyst. |

### Confluence scoring (HTF=daily only)

- Hard indicator hit = **2 points**
- Supporting indicator hit = **1 point**
- A valid pullback entry requires **≥ 4 points with ≥ 1 hard indicator**

**Why the hard-requirement count dropped from 2 to 1 (2026-10-01):** with the old Fibonacci rule the second hard indicator fired 0 times in 3 years on 23 of 25 names, so requiring two hard indicators was unsatisfiable and the pipeline produced 0 tickets. Relaxing it is only safe *after* the rule above was re-scoped. Do not restore `min_hard_indicators: 2` without first re-running `scripts/replay_gate.py`.

**No forward-return edge (measured, do not overstate):** the shipped gate fires on 4.05% of symbol-days with a +0.56% forward 5-session return against a +0.58% baseline. It is a *filter*, not a signal. (Measured in the source workspace's 2026-10-01 constraint diagnostic, which is not distributed; re-measure with `scripts/replay_gate.py` on your own universe.)

### Timeframes

- **HTF structural indicators (daily):** EMA-20 placement, extension/retracement levels, ADX, HH/HL integrity, RSI daily band.
- **LTF entry indicators (week of primary premarket):** anchored VWAP deviation from the week's first 9:30 EDT open for 3+ consecutive sessions up to the forecast date, 30-second reversal pattern, volume behavior.