---
name: tickerz-index
description: Read Tickerz indexes and answer with the number, its unit, its period and how it was counted. Use when someone asks about US jobless claims, payrolls, unemployment, CPI or core CPI as first published, memecoin launches or launchpad fees on Solana, prediction market volume (Kalshi and Polymarket), paid AI agent calls on Base, or wants a market or a bet settled on one of these numbers.
---

# Tickerz indexes

Tickerz publishes ten live indexes, each counted from a public source under a fixed rule. Use the `tickerz` MCP tools; no key is needed.

## Which tool

- Where things stand across all indexes: `list_indices`.
- One index, its recent periods and its newest final number: `get_index` (for example `MINTS`, `JOBS`, `CPI`).
- How an index is counted, and whether a market may settle on it: `get_rule`.
- The signed report behind a print, when one exists: `get_report`. Before Oct 14 2026 most indexes have no signed report yet; say so plainly if the tool answers that none exists.
- A market question ready to paste for an index's next print: `get_listing_kit`.
- Ask for a number Tickerz does not publish yet: `name_a_number`. Tickerz answers within 48 hours with a ticker or the reason it cannot be built.

## How to answer

1. Lead with the number, its unit and its period: "55,686 coins. Memecoin launches on Solana, Oct 8."
2. Name the index with its ticker in code style (`$MINTS`) and link its page, `https://tickerz.com/x/<ticker in lowercase>`.
3. For US government series, say whether the number is as first published or revised since. Markets usually settle on the first published number, and Tickerz keeps it.
4. If the current period is still being counted, say so and give the last complete period instead of the partial count.
5. Never present an index as a price or as advice to trade.
