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

The Terminal's activity-score methodology is published at https://tickerz.com/methodology and is not part of this repository.
