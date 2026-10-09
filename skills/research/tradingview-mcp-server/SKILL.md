---
name: tradingview-mcp-server
description: Screen stocks, ETFs, forex and crypto through the unofficial TradingView screener API using the open-source tradingview-mcp-server (MCP). Use for research-paced screening (value, quality, growth, momentum presets, 75+ fundamental and technical fields, symbol lookup), market-regime checks and building candidate lists. Not for intraday or real-time trading, order execution, or options.
version: 1.0.0
author: Fiale Plus (fiale-plus/tradingview-mcp-server), Hermes skill by hermes-zouroboros
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Finance, Stock Screener, TradingView, MCP, Research]
    homepage: https://github.com/fiale-plus/tradingview-mcp-server
    related_skills: [smart-money]
prerequisites:
  commands: [npx]
---

# TradingView screener (MCP)

The skill runs the published `tradingview-mcp-server` npm package (MIT, Fiale
Plus) as a stdio MCP server. It calls TradingView's **unofficial** scanner API,
needs no authentication, and can change without notice.

## Setup in Hermes

Add the server to the profile's `config.yaml`. Pin the version you reviewed:

```yaml
mcp_servers:
  tradingview:
    command: "npx"
    args: ["-y", "tradingview-mcp-server@0.7.1"]
    env:
      CACHE_TTL_SECONDS: "300"   # optional, default 300
      RATE_LIMIT_RPM: "10"       # optional, default 10; keep it conservative
```

Start a new session. Hermes registers the tools as `mcp_tradingview_<tool>`.

## Tools

| Tool | Use |
| --- | --- |
| `screen_stocks` | Filter stocks by fundamental/technical fields, sort and limit |
| `screen_etf`, `screen_forex`, `screen_crypto` | The same for other asset classes |
| `list_fields` | Discover the available fields (see `references/fields.md`) |
| `list_presets`, `get_preset` | Ready-made strategies: quality, value, growth, momentum and more (see `references/presets.md`) |
| `lookup_symbols` | Resolve tickers and fetch current values for specific symbols |

## Workflow

1. Clarify the strategy, universe (exchange, market cap, sector) and horizon.
2. Start from a preset (`get_preset`) and adjust filters. Explain each filter in plain language.
3. Screen with a small limit first, then widen. Respect the rate limit, and do not loop rapid queries.
4. Present results as a candidate list with the metrics that qualified each one, the data's as-of time, and known caveats (stale fundamentals, missing fields).

## Rules

- Research and education only. Results are not investment advice and not a
  recommendation to buy or sell. Say so when presenting candidates.
- Never place, or claim to place, orders. Any buy/sell action needs explicit
  confirmation from the user, with full order details, outside this skill.
- When candidates feed a portfolio discussion, flag concentration: no single
  security above 5% of the portfolio, and no sector above 25%. Suggest
  stop-loss levels and mention tax impact (short-term gains, wash sales).
- Do not present screener output as real-time data.

Upstream licence: `LICENSE` (MIT). Field and preset references are copied from the upstream `docs/`.
