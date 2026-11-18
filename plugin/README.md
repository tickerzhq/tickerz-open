# Tickerz for Claude

Tickerz indexes inside Claude: what people actually do, as numbers with their rule. Ask "How many Americans feel lonely?", "How much do New Yorkers bet on sports each week?" or "What were October payrolls as first published?" and get the number, its period, the rule it was counted under and how to check it yourself.

- **MCP server:** `https://tickerz.com/mcp` (HTTP, no key, no signup). Seventeen tools: fifteen read only and two that write; see https://tickerz.com/connect.
- **Skill:** `tickerz-index`, which tells Claude which tool answers which question and how to state a number.

## Install in Claude Code

```
/plugin install tickerz --marketplace tickerzhq/tickerz-open
```

Or add only the server: `claude mcp add --transport http tickerz https://tickerz.com/mcp`.

## The indexes

48 live indexes in eight families, the human ones first:

- **Vice:** $GOON (porn among the web's top 1,000 sites), $AIGF (AI companion sites), $TILT (New York phone bets), $SPIN, $PARLAY, $KENO, $LASTCALL (the Texas bar tab), $LEAF (Canada's legal weed stores).
- **Hard times:** $BROKE (debt collector complaints), $SHELTER (the New York City shelter census), $EVICTED, $EBT, $TAXMAN, $UNDERWATER.
- **Mind:** $LONELY, $SAD (mental health ER visits), $OD (overdose deaths, shown and never called), $STRAPPED (gun background checks).
- **Streets, Wild, Net, Planet:** city complaints from potholes to robotaxis, animals, the dark web and data breaches, sea ice, CO2, earthquakes and asteroids.
- **Markets:** $LAYOFFS (US initial jobless claims), $JOBS, $UNEMP, $CPI and $CORECPI (as first published), $MINTS (memecoin launches on Solana), $TRENCHES, $YESNO (prediction market volume), $COE.

`find_index` maps a plain question to the index that answers it. The full list: https://tickerz.com/x. How a reading is scored against its own normal: https://tickerz.com/methodology. Recounts: this repository.

The same server also reads the Tickerz Terminal: about 220 crypto assets and US stocks, each with its unusual trading score (0 to 100, how unusual today's trading is for that asset; not a call on price, and not advice).

## What it connects to and sends

The plugin has no hooks, scripts or local code. It adds one remote MCP server, `https://tickerz.com/mcp`, run by Tickerz, and one skill (text only). When Claude calls a Tickerz tool, the tool's arguments (for example a ticker such as `SHELTER`, or the question given to `find_index`) go to tickerz.com over HTTPS. Read tools only read public data. Two tools write: `name_a_number` sends the number you ask Tickerz to publish, and `submit_forecast` sends the forecast you enter in the Arena. Nothing else is sent, and no key or account is needed.

## Privacy

The server reads public data and stores nothing about you. `name_a_number` and `submit_forecast` write only what you send them. Policy: https://tickerz.com/privacy
