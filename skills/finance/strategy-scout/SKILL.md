---
name: strategy-scout
description: "Scout a single equity/ETF ticker through an 8-stage diagnostic pipeline (identity → fundamentals → technicals → risk → strategy fit → backtest cross-check → cost/liquidity → portfolio fit → verdict). Emits a PASS / WATCH / REJECT verdict and a styled HTML + PDF report. Research only: never places orders."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [finance, trading, research, decision-support, Zouroboros]
    related_skills: [daily-top5-advisor]
prerequisites:
  commands: [bun]
---

# Strategy Scout — 8-stage diagnostic

Invoke this skill when a single ticker needs a fast, decision-grade snapshot. The 8 stages are:
1 Identity, 2 Fundamentals, 3 Technicals, 4 Risk, 5 Strategy fit, 6 Backtest cross-check,
7 Cost / liquidity, 8 Portfolio fit → verdict report.

This is **not** a research deep-dive. It is a fast, repeatable triage that produces a verdict the
operator can act on (PASS / WATCH / REJECT) and an artifact (PDF) they can file. It never places,
changes or cancels an order.

## Financial safety rules (non-negotiable)

1. **No trade without explicit confirmation.** A PASS is not a trade instruction. Before any buy/sell
   is placed by anyone, present the full order details (ticker, side, quantity, order type, limit,
   time-in-force, maximum cost, stop, target) and obtain the operator's explicit confirmation of that
   exact order.
2. **5% cap per security.** Never suggest a position size that would put the security above 5% of the
   portfolio after the fill (diversified broad-index ETFs are the only exemption, per the rubric). State
   the maximum position size in the report.
3. **Always a stop-loss.** Every PASS or WATCH report suggests a protective stop level and the
   resulting maximum loss.
4. **Flag concentration.** Flag a position above 5% and any sector above 25% of the portfolio, plus
   asset-class imbalance, using the live positions the script returns.
5. **Tax impact.** Note short-term-gain treatment and wash-sale risk (a loss sale of the same or a
   substantially identical security within 30 days).
6. **Log every recommendation.** Append timestamp, ticker, verdict/action, entry/exit levels, stop-loss,
   size, rationale and horizon to `$ZOUROBOROS_STATE_DIR/strategy-scout/recommendations.log.md`.

## Inputs

- `TICKER` — required, uppercase, 1-10 alpha/`.`/`-` chars (e.g. `AAPL`, `BRK.B`, `SPY`).
- `REQUESTER` — who asked; the report goes back to them through the profile's normal channel.
- `SOURCE` — optional, free-text provenance (e.g. `"Manual scout from screener UI"`); included in the report.

## Configuration

From the Hermes profile environment (never print values):

- `FMP_API_KEY`, `ALPACA_API_KEY`, `ALPACA_API_SECRET` — required.
- `FINNHUB_API_KEY` — optional (earnings + news cross-check).
- `ALPACA_PAPER=false` — read live instead of paper positions (read-only either way).
- `STRATEGY_SCOUT_BACKTEST_DIR` — optional directory searched for `verdict.json` backtest results.

## Protocol

### Step 1 — Fetch deterministic data (single script call)

```bash
bun "${HERMES_SKILL_DIR}/scripts/scout-data.ts" <TICKER>
```

It does Stages 1-7 in one shot from real APIs (FMP `stable`, Alpaca market data, Finnhub for earnings
and news) and emits a single JSON blob on stdout. If it exits non-zero, stdout is a JSON error envelope
`{error: true, stage, message}`. **Do not proceed with synthesis.** Go directly to Step 4.

The JSON on success contains keys: `ticker`, `generated_at`, `fundamentals`, `technicals`, `risk`,
`backtest`, `portfolio`, `cost`, `strategy_fit`.

### Step 2 — Synthesise the verdict

Apply the verdict rubric (`references/verdict-rubric.md`):

- **REJECT** if any of: `actively_trading == false`, `earnings_within_14d == true`, `liquidity_tier == "thin"`, `golden_cross == false` AND `rsi_14 > 70`, `current_concentration_pct > 5` (already over-allocated; broad-index ETFs exempt).
- **WATCH** if: `rsi_14 >= 75` (overbought), `proximity_52w_high_pct >= 95` AND `recent_news_14d_count >= 4` (extension + noise), or fundamentals show shrinking revenue/margins from the FMP profile/quote signal.
- **PASS** otherwise.

The `strategy_fit` values (`donchian_trend`, `etf_mean_reversion_basket`, `options_income_wheel_pmcc_ic`)
feed the "strategy fit" section; do not override their `FIT/CHECK/NO` labels unless you have a hard
reason (e.g. a backtest verdict says `FAIL`). Then apply the safety rules above: stop-loss, maximum
position size, concentration flags and tax notes.

### Step 3 — Render the report

- Title: `🎯 Strategy Scout — <TICKER> — <VERDICT>` (verdict ∈ `PASS` | `WATCH` | `REJECT`).
- Body: rich HTML with sections (1) Identity, (2) Fundamentals snapshot, (3) Technicals snapshot, (4) Risk flags, (5) Strategy fit, (6) Backtest cross-check, (7) Cost / liquidity, (8) Portfolio fit & verdict. Start from `references/email-template.html`.
- Generate a same-content PDF (wkhtmltopdf or weasyprint) at
  `$ZOUROBOROS_STATE_DIR/strategy-scout/reports/scout-<ticker-lower>-report-<YYYY-MM-DD>.pdf`.
- Deliver to the requester through the profile's configured channel. If that channel is email,
  prepare a draft; sending requires the operator's direct instruction.

### Step 4 — Fail loud (ONLY if the script failed)

Report `❌ Strategy Scout — <TICKER> — FAILED` with the JSON error envelope verbatim, the ticker, the
timestamp and the source. **Never end the session silently.** Either a PASS/WATCH/REJECT report or a
FAILED report is delivered.

## Notes

- The fetcher uses FMP `stable` endpoints (Starter tier compatible) for quote + profile, Alpaca IEX bars for RSI/realised vol, and Finnhub for earnings + news. IEX volume is a fraction of consolidated volume — `liquidity_tier` uses dollar-volume thresholds (deep > $50M/day, medium > $5M/day, thin otherwise) and tends to under-report on megacaps, but the tier labelling stays correct.
- The fetcher is deterministic. Do not augment its outputs with LLM-generated numbers; if the script omitted a field, omit it from the report rather than inventing a value.
- Stage 6 searches `STRATEGY_SCOUT_BACKTEST_DIR` for `verdict.json` files. If none is configured or no ticker-specific result exists, note "No ticker-specific backtest on file" — do not invent one.
- Stage 8 reads Alpaca positions. `current_concentration_pct` is the share of the invested positions, which overstates concentration when the account holds cash; that errs on the side of the 5% rule. If it exceeds 5%, flag it loudly.

## References

- `references/verdict-rubric.md` — the PASS/WATCH/REJECT decision tree.
- `references/email-template.html` — the styled HTML report layout.
