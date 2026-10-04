# Methodology: $MINTS, $GIGS and $WAGE

This is the rulebook Tickerz publishes for the three indexes whose code is in this repo, copied from the production registry (Rulebook v0.1, 2026-09-23). The same lines are on each index's page (https://tickerz.com/x/mints, /x/gigs, /x/wage) and in `GET https://tickerz.com/api/v1/indices/{ticker}`. `src/rulebook.ts` holds them as data, and `test/rulebook.test.ts` fails if this file and that one drift apart.

A rulebook line is what a venue can paste into a contract: what the number counts, where it comes from, what it costs to move, what happens when the source is late, and the precision. The grade says how far a venue can lean on it: **candidate** could settle a listed contract once its open item is cleared; **reference** is a public series a venue can read itself; **display** is for reading only.

## How a reading is fixed

Once per UTC day, after 12:00 UTC, Tickerz writes one seal: every index row written or revised since the seal before, as compact JSON with a fixed key order (`kind`, `day`, `since`, `rows[]` of `ticker`, `period`, `value`, `revisions`, sorted by ticker then period). The JSON is hashed with SHA-256 and the digest is stamped with OpenTimestamps, which commits it to a Bitcoin block. The text is served exactly as hashed at `GET https://tickerz.com/api/v1/indices/proof?day=YYYY-MM-DD`, with the `.ots` proof at `&format=ots`.

A seal written on day D holds the periods that completed since the seal before, usually period D-1. The first seal to hold a ticker and period is that period's **first print**, the number a venue settles on. A later revision by the source is sealed again and sits beside the first print, never in its place. `npm run verify -- YYYY-MM-DD` checks a seal; see the README.

## $MINTS: Memecoin launches

**What it counts.** New coins created on the pump.fun program per UTC day, counted by Tickerz from the Solana chain: one per successful create transaction on the program's mint authority. Graduations (curves that completed and moved to pump.fun's own exchange) print as a second line. Rulebook v0.1: finalized transactions only, each counted on the UTC day of its block time.

The accounts: creates are successful signatures on `TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM`, pump.fun's mint authority, which signs only create transactions on the bonding curve program (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`). Graduations are successful signatures on the migrator, `39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg`, where many competing attempts fail, so only successful signatures count on both. From https://github.com/pump-fun/pump-public-docs. Code: `src/mints.ts`.

**Unit.** coins.

**Source.** Solana mainnet, the pump.fun program. https://github.com/pump-fun/pump-public-docs

**Terms.** Public chain data read by Tickerz over the Solana JSON RPC. No vendor dataset. The count is Tickerz's own and is licensed by Tickerz.

**Cadence.** Hourly, from the chain.

**Second line.** Graduations, stored as `MINTS.GRADS`: printed under the level and sealed with it, not an index of its own.

**Grade.** candidate. Counted from the chain by Tickerz with no third party in the path, so the number is Tickerz's own to license. The count is of creates, not of coins that traded; rulebook v0.2 adds a survival filter and the graduation line already prints beside it.

**Cost to move one day.** Cheap for the raw count: creating a coin costs about a transaction fee, so a bot can push creates. The graduation line costs real liquidity to move. A venue should settle on the line the rulebook names.

**When the source is late.** If the RPC is down the hour is retried on the next run and the day stays open, marked provisional, and nothing settles. A day is complete at 00:00 UTC; a day that cannot be read is void.

**Precision.** Whole coins, one per successful create transaction, counted on the UTC day of its block time.

**Version.** Rulebook v0.1, 2026-09-23

## $GIGS: Paid gigs over x402

**What it counts.** Paid calls settled over x402 on Base, per UTC day, between paying wallets and the services they pay; whether a person, a script or an AI agent holds a wallet is not on the chain. Every USDC signed transfer (EIP-3009) on Base is counted from the chain; one transaction in sixteen, chosen by the low byte of keccak256(tx hash, block hash), is read in full. A payment counts when one of the 128 x402 facilitator wallets on the list settled it. A payer paying itself is left out. The level is the estimate, every signed transfer times the payments per sampled transaction; its 95% range prints beside it.

The estimate: every signed transfer of the day (N) is counted; of the n transactions in the sample, k were x402 payments carrying m payments. GIGS = N x (k/n) x (m/k), rounded to a whole gig. Its 95% range is GIGS plus or minus 1.96 x N x (m/k) x the standard error of the sampled share k/n, with the finite population correction, floored at zero. Code: `estimateGigs` and `dayFromHours` in `src/machines.ts`; the facilitator list is `src/facilitators.ts`.

**Unit.** gigs.

**Source.** Base mainnet, USDC signed transfers settled by x402 facilitators. https://www.x402.org/

**Terms.** Public chain data read by Tickerz over Base's public JSON RPC. No vendor dataset. The facilitator list is from Merit-Systems/x402scan (MIT License). The count is Tickerz's own and is licensed by Tickerz.

**Cadence.** Hourly, from the chain; a day prints once it is complete.

**Grade.** display. Counted by Tickerz from the chain with no vendor in the path, but estimated from a one in sixteen sample on a free public node. It becomes a candidate when every transaction is read.

**Cost to move one day.** Moderate. A payment costs a transaction and the amount paid, so pushing thousands of fake gigs costs real money and shows up as a few payers with many calls.

**When the source is late.** An hour the node cannot serve is retried on the next run and the day stays open, so nothing settles. A day is complete once its 24 hours are read; a day that cannot be read is void.

**Precision.** Whole gigs, rounded from the estimate, with the 95% range beside it.

**Version.** Rulebook v0.1, 2026-09-23

## $WAGE: The machine wage

**What it counts.** What a paying wallet paid per call, per UTC day: the payer-balanced median price of a settled x402 payment on Base. Each payer's median price first, weighted by its calls, then the median across payers, so one wallet firing thousands of calls counts once; the 25th and 75th percentiles print beside it. Every USDC signed transfer (EIP-3009) on Base is counted from the chain; one transaction in sixteen, chosen by the low byte of keccak256(tx hash, block hash), is read in full. A payment counts when one of the 128 x402 facilitator wallets on the list settled it. A payer paying itself is left out. No level prints on a day with fewer than 50 payers in the sample.

The median: each payer's prices are reduced to that payer's lower weighted median (weighted by its calls), then the median of those per-payer medians is taken by nearest rank, with the 25th and 75th percentiles beside it. Code: `weightedMedian`, `percentile` and `dayStats` in `src/machines.ts`.

**Open issue, Oct 3 2026.** Payer balancing stops one busy wallet from setting the wage, but not a fleet of small wallets paying one service. On Oct 3 2026 one service's many $0.001 payers halved it: WAGE printed $0.005, against $0.01 on Oct 2. A fix is open and not yet in the rulebook; until it lands, read WAGE with that in mind.

**Unit.** US dollars per call.

**Source.** Base mainnet, USDC signed transfers settled by x402 facilitators. https://www.x402.org/

**Terms.** Public chain data read by Tickerz over Base's public JSON RPC. No vendor dataset. The facilitator list is from Merit-Systems/x402scan (MIT License). The count is Tickerz's own and is licensed by Tickerz.

**Cadence.** Hourly, from the chain; a day prints once it is complete.

**Grade.** display. A median of settled prices read from the chain by Tickerz, the machine version of a wage. Payer balanced, so one busy wallet cannot set it; many small wallets paying one service still can: on Oct 3 one service's $0.001 payers halved it. Estimated from a sample until the full count runs.

**Cost to move one day.** Moderate. Moving the median takes many distinct paying wallets, each paying real money.

**When the source is late.** An hour the node cannot serve is retried on the next run and the day stays open, so nothing settles. A day with fewer than 50 sampled payers prints no level and is void.

**Precision.** US dollars to six decimals, the unit USDC settles in.

**Version.** Rulebook v0.1, 2026-09-23

## Shared rules for $GIGS and $WAGE

A payment counts when a listed facilitator wallet sent the transaction, it succeeded, and USDC emitted an `AuthorizationUsed` (EIP-3009, the x402 "exact" scheme) followed by the `Transfer` it authorized. Each authorization is one payment: its signer is the payer, the wallet its money reaches is the payee (followed through up to three router hops that pass on at least half of what they received), its amount is the price. Left out: a transfer no authorization covers (a router's fee, a refund), a payer paying itself, a zero amount, and a deposit into an x402 payment channel contract, which pays for many calls the chain does not show.

The sample is one transaction in sixteen: the low byte of `keccak256(tx hash || block hash)` under 16. The sender cannot know its block's hash when it sends, so it cannot steer a transaction into or out of the sample, and anyone can redraw the same sample from the chain. A day is its 24 UTC hours, each read whole.


---

The text below is Tickerz's public methodology as published at https://tickerz.com/methodology, reproduced verbatim from the production source. Most of it describes the Terminal's Activity score (model Sigma-1), which this repo does not compute and whose parameters are not here. The part that applies to the indexes above is "Z1 on the indexes": the z printed beside every index reading.


## Appendix: Sigma-1: self-relative anomaly detection, on the record

Sigma-1 is the first model in the Tickerz Sigma family. It produces the activity score, a 0 to 100 measurement of how unusual an asset's last 24 hours were versus that asset's own recent pattern, and it binds every measurement to a falsifiable public record.

### Formulation
Most attention metrics are popularity contests. Sigma-1 compares each asset only to itself: the unit is departure from baseline, not size. A quiet asset waking up outscores a large asset doing what it always does.

### Inputs
Each snapshot consumes 24-hour traded volume and the absolute 24-hour price move. Richer inputs (funding rates and open interest on five major coins, total stablecoin supply, DeFi TVL) are context for future Sigma models and do not touch Sigma-1.

### Standardization
Each input becomes a z-score against that asset's own trailing 30-day distribution, excluding the asset's own current-day observation. Guardrails: negative z floors at zero before the clamp, z-scores clamp at four standard deviations inside the score while the event record keeps the raw z-scores that opened it, and no asset is scored until 14 days of baseline exist. New listings appear unscored rather than scored on thin history.

Correction, dated 2026-09-22: the 30-day baseline previously included the asset's own most recent reading in its comparison population, diluting real anomalies toward zero on close calls. Fixed by excluding the current day's own observation. This is a correction to the standardization step, not a change to inputs or blend weights; scores and events recorded before this date were produced under the earlier baseline.

Correction for equities, effective from the 2026-09-23 session: a stock's volume counts from the opening bell, but its baseline was built from end-of-session readings, so every stock read quiet in the morning (median equity volume z-score -1.7 before 11:00 New York time, -0.2 after 15:00, over the prior 30 days). Each stock is now compared with its own readings at the same point in the session, in 10-minute steps, over the same 30-day window, for both volume and move. The first reading of each session is recorded and not scored: the feed can still carry the prior session's daily bar at that moment. Equity scores recorded through 2026-09-22 read low in the morning. They, and the events and receipts they opened, stay as recorded.

### Score
Clamped z-scores combine in a fixed weighted blend, normalized so 100 requires both inputs at the clamp. Volume anomaly weighs above move anomaly. Exact blend weights are proprietary; the principle is public and testable against the record.

### Events
An activity score at or above 70 opens an event and freezes the asset's price. Closing uses hysteresis: the score must fall below a cooler band and stay there across consecutive readings. The opening activity score, the peak and the triggering z-scores are recorded with the event. Correction, dated 2026-09-22: the field published as the opening score held the peak; the record now publishes both.

### Receipts
Every event resolves at +24h, +7d, and +30d as the forward return from the frozen open price, from Tickerz's own stored history, with the benchmark's return over the same window recorded beside it (Bitcoin for crypto, SPY for stocks). Receipt clocks resolve on the next Terminal reading at or after each horizon: within 15 minutes for crypto, at the next regular-session reading for stocks. Rises and falls publish alike. The one finding that has held: a crypto upside spike while under 3% of coins are unusual lagged Bitcoin by a median of about 5% over 7 days, about 3 points worse than an ordinary day. See https://tickerz.com/evidence.

### Provable receipts
Since 20:30 UTC on 2026-09-22 every new event is stamped at open, within about an hour (SHA-256 of canonical JSON: event id, symbol, open time, open price, horizon open, opening score, triggering z-scores), so a new call is provably made before its outcome, and each resolved receipt is stamped the same way (event id, symbol, open time, reference price, horizon, resolved time, return). Events opened before that were stamped later, in hourly batches from 20:30 UTC on 2026-09-22 to 05:30 UTC on 2026-09-23; compare stamped_at with opened_at. After Bitcoin confirmation the receipt shows the block height. Verify via /api/receipts/proof?event_id=&horizon= (open, 24h, 7d or 30d) and opentimestamps.org or the ots CLI.

### Z1 on the indexes
From 2026-09-29 every Tickerz Index print also carries z: the period's own count against its baseline's median, in robust standard deviations (the median absolute deviation, scaled), signed, one decimal. 0 is normal. Below 0 is quieter than usual, so a low week reads as low instead of quiet, and one freak day in the baseline cannot set what normal is. It is published beside the Activity score, which is unchanged. Prints and proofs already on the record do not move.

### Coverage
Top 250 crypto by market cap every 15 minutes. Stablecoins, wrapped and staked tokens, tokenized funds and other pegged assets are left out, with no readings and no score. A token that shares a stock's ticker is recorded but not displayed. Curated US equities on the same mechanism every 10 minutes in regular market hours, each compared with its own readings at the same point in the session. When a feed goes quiet, the Terminal says the feed is late and for how long, and a stopped row reads STALE.

### Disclosure line
Public: inputs, per-asset standardization, four-sigma clamp, 14-day minimum baseline, event threshold at 70, existence of hysteresis, receipt horizons. Proprietary: blend weights, close band, confirmation count, calibration parameters. Judge the model by its receipts.

### Boundaries
The activity score is not a prediction, a recommendation, or an endorsement. Not financial advice. The activity score measures attention, not merit.

Source: https://tickerz.com/methodology
