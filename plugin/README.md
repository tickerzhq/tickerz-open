# Tickerz for Claude

Live indexes for data nobody else publishes, inside Claude. Ask "How many memecoins launched on Solana yesterday?" or "What were September payrolls as first published?" and get the number, its period, the rule it was counted under and how to recount it yourself.

- **MCP server:** `https://tickerz.com/mcp` (HTTP, no key, no signup). Fourteen read-only tools and two write tools; see https://tickerz.com/connect.
- **Skill:** `tickerz-index`, which tells Claude which tool answers which question and how to state a number.

## Install in Claude Code

```
/plugin install tickerz --marketplace tickerzhq/tickerz-open
```

Or add only the server: `claude mcp add --transport http tickerz https://tickerz.com/mcp`.

## The indexes

$LAYOFFS (US initial jobless claims), $JOBS (nonfarm payrolls), $UNEMP (unemployment rate), $CPI and $CORECPI (as first published), $MINTS (memecoin launches on Solana), $TRENCHES (memecoin launchpad fees), $YESNO (prediction market volume), $GIGS and $WAGE (paid AI agent calls on Base and their median price). Methodology: https://tickerz.com/methodology. Recounts: this repository.

## Privacy

The server reads public data and stores nothing about you. `name_a_number` and the Arena tools write only what you send them. Policy: https://tickerz.com/privacy
