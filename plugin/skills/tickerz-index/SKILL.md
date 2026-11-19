---
name: tickerz-index
description: Read Tickerz indexes and answer with the number, its unit, its period and how it was counted. Use when someone asks about what people actually do and the numbers behind it, such as loneliness, porn, sports and casino bets, drinking, overdoses, guns, shelters, evictions, food stamps, debt collectors, city complaints (potholes, fireworks, graffiti, tents, robotaxis), animals, the dark web and data breaches, sea ice, CO2, earthquakes and asteroids, or about US jobless claims, payrolls, unemployment and CPI as first published, airport checkpoint counts, executive orders, memecoin launches and prediction market volume. Also for how unusual crypto or US stock trading is right now (the Terminal), or a market settled on one of these numbers.
---

# Tickerz indexes

Tickerz publishes 50 live indexes, each counted from a named public source under a fixed rule, in nine families: Vice, Hard times, Mind, Streets, Wild, Net, Planet, Markets and Power. The human ones lead: $GOON (porn among the web's top 1,000 sites), $LONELY, $TILT (New York phone bets), $BROKE (debt collector complaints), $SHELTER (the New York City shelter census), $EVICTED and more. The list is at https://tickerz.com/x. Use the `tickerz` MCP tools; no key is needed.

## Which tool

- A question in plain words and you do not know the index: `find_index` first ("how many Americans feel lonely", "is NYC eviction rising"). An empty answer means no index measures it.
- Where things stand across all indexes: `list_indices`.
- One index, its recent periods and its newest complete number: `get_index` (for example `SHELTER`, `TILT`, `JOBS`). Its `engine` field is the forecast: the likely range of the next number, and how unusual the newest one was ("about 1 in N"). Display only, never a settled number.
- How an index is counted, and whether a market may settle on it: `get_rule`.
- The signed report behind a print: `get_report`. Only $LAYOFFS, $JOBS, $UNEMP, $CPI, $CORECPI and $MINTS are signed today; for any other index say plainly that none exists. Every feed and its status at once: `list_feeds`.
- A market question ready to paste for an index's next print: `get_listing_kit` ($LAYOFFS and $MINTS).
- Call the next number for points in the Arena: `arena`, then `submit_forecast`. Points only, no money.
- Ask for a number Tickerz does not publish yet: `name_a_number`. Tickerz answers within 48 hours with a ticker or the reason it cannot be built.
- What is unusual in crypto or US stocks right now: `board`, then `asset` for one name, `base_rate` and `receipts` for how past spikes turned out. The Terminal's 0 to 100 score is the unusual trading score: how unusual today's trading is for that asset, not whether it is good.

## How to answer

1. Lead with the number, its unit and its period: "83,508 people. New York City shelter census, Nov 17."
2. Name the index with its ticker in code style (`$SHELTER`) and link its page, `https://tickerz.com/x/<ticker in lowercase>`.
3. For US government series, say whether the number is as first published or revised since. Markets usually settle on the first published number, and Tickerz keeps it.
4. If the current period is still being counted, say so and give the last complete period instead of the partial count.
5. $OD (overdose deaths) is shown, never called or bet on.
6. Never present an index or a score as a price or as advice to trade.
