# Tickerz: the open parts

Tickerz publishes indexes of real-world activity. Each index counts one thing, every day, from a named public source: coins created on pump.fun, paid API calls settled over x402, unemployment claims filed with the states. Once a day every new reading is hashed and timestamped in Bitcoin with OpenTimestamps, so anyone can check later that a number was not changed after it was printed. Because the first print of each day is fixed that way, a venue such as a prediction market can settle a contract on it.

This repo is the part of Tickerz needed to check that claim: the code that counts three of the indexes from the chain, and a verifier for the daily Bitcoin proof. It runs on its own: no database, no keys, no account. Everything it fetches is public.

| Index | What it counts | Source |
|---|---|---|
| **$MINTS** | New coins created on pump.fun per UTC day, with graduations as a second line | Solana mainnet, read directly |
| **$GIGS** | Paid calls settled over x402 on Base per UTC day, estimated from a one in sixteen sample, with a 95% range | Base mainnet, read directly |
| **$WAGE** | The payer-balanced median price of one of those paid calls | Base mainnet, read directly |

Live pages: https://tickerz.com/x/mints, https://tickerz.com/x/gigs, https://tickerz.com/x/wage. The full rulebook for each is in [METHODOLOGY.md](METHODOLOGY.md).

## What is in this repo

```
src/
  mints.ts          $MINTS: the Solana counter. Pages getSignaturesForAddress on pump.fun's mint authority and
                    migrator, counts successful signatures per UTC day of block time, and keeps a cursor so a
                    run never counts a signature twice or skips one.
  machines.ts       $GIGS and $WAGE: x402 payment extraction from a Base receipt, the one in sixteen sample, the
                    estimate and its range, the payer-balanced median, and readHour over the public Base node.
  facilitators.ts   The 128 x402 facilitator wallets on Base whose payments count (from x402scan, MIT).
  gigsRange.ts      The 95% range printed beside $GIGS: parsing, and a reader for the public API.
  seal.ts           The daily seal: its canonical JSON, first prints, the .ots header, and checkSeal.
  rulebook.ts       The published rulebook lines for the three indexes, as data.
  publicApi.ts      Reads what Tickerz printed from https://tickerz.com/api/v1 (no key).
scripts/
  verify-proof.ts   npm run verify: check one day's seal and write the files for `ots verify`.
  count-mints.ts    npm run mints: recount $MINTS from the chain and set it beside the print.
  recompute-gigs-wage.ts  npm run gigs: recompute $GIGS and $WAGE for a day from the chain.
  test-all.mjs      npm test: runs every file in test/.
test/               Plain-assert tests, no network. Most are copied from Tickerz's own suite.
  fixtures/seal-2026-10-03.json   The public proof for 2026-10-03, unchanged.
```

The counting code is extracted from Tickerz's production code with the counting rules unchanged. What was taken out: the database, the scheduler, the website, and environment settings. What is not here at all: how Tickerz scores a reading against its own history, how it decides when to write, and the Terminal's model for crypto and stocks.

## Run the tests

Tested on Node 22.13 (package.json asks for Node 20 or later).

```
npm ci
npm test            # 5 files, 37 checks, no network
npx tsc --noEmit    # strict type check of src, scripts and tests
```

The tests run the $MINTS counter against a fake chain (UTC day edges, failed and untimed transactions, a read cut short and resumed, rate limits), the x402 extraction against hand-built receipts (routers, fee proxies, several payments in one transaction, payment channel deposits), the estimate against an hour Tickerz read in full (4,044 payments; the estimate's range holds it), and every check of the verifier against a real seal, plus the ways a changed seal must fail.

## Verify a day's proof

```
npm run verify -- 2026-10-03
```

This fetches the seal Tickerz wrote on that UTC day from `https://tickerz.com/api/v1/indices/proof?day=2026-10-03` and its proof from `...&format=ots`, then checks, with no Bitcoin node:

1. `sha256(canonical_json)` equals the published `digest_sha256`.
2. The text is the seal for that day.
3. Rebuilt from its own rows with the published key order (`canonicalSealJson`), the text comes out byte for byte the same, so nothing rides along outside the rows.
4. The `.ots` file commits to that same digest (the 32 bytes after its header), and matches the copy inside the JSON.

It then prints the $MINTS, $GIGS and $WAGE rows the seal fixes and writes two files side by side: `proofs/tickerz-seal-2026-10-03.json` (the exact bytes that were hashed) and `proofs/tickerz-seal-2026-10-03.json.ots`.

A seal written on day D holds the readings that completed since the seal before, usually day D-1. The seal written on 2026-10-03 fixes the 2026-10-02 prints: $MINTS 47,746 (graduations 1,725), $GIGS 50,535, $WAGE $0.01. Its digest is `2d4f359fc8cf89e2e431d7e03517d9577125945df989f7ef91976b5e5334b3f4`.

**Finish on Bitcoin** with the standard OpenTimestamps client:

```
pip install opentimestamps-client
ots info   proofs/tickerz-seal-2026-10-03.json.ots   # the path from the digest to its Bitcoin attestation; no node needed
ots verify proofs/tickerz-seal-2026-10-03.json.ots   # hashes the .json beside it and checks the attested block
```

`ots verify` reads the block header from a Bitcoin Core node on the same machine (the client's default; a pruned node works). Without a node, drop both files on https://opentimestamps.org, which checks the block against a public explorer. By hand: the 2026-10-03 proof ends in `BitcoinBlockHeaderAttestation(969734)` over the value `966ff86fe0c590e3ff8332b6b757a34f642b3431db618aada194d1c87cecee79`. That is the merkle root of Bitcoin block 969734 in the byte order the block header uses; explorers print the same bytes reversed, `79eeec7cc8d194a1ad8a61db31342b644fa357b7b63283ffe390c5e06ff86f96`. The block's time is 2026-10-03 13:25:17 UTC, 45 minutes after the seal was stamped.

## Recompute $MINTS

```
npm run mints -- 2026-10-03
```

Pages pump.fun's mint authority (`TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM`) and migrator (`39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg`) over the public Solana JSON RPC, newest first, from now back to 00:00 UTC on the day given, and counts the successful, finalized signatures on each UTC day of block time. It prints each day beside what Tickerz printed. About 55 pages per day back, so a day back takes a minute or two.

Run on 2026-10-04 from this repo, `npm run mints -- 2026-10-02` printed:

```
day          creates  printed    match  graduations
2026-10-02    47746    47746      yes         1725
2026-10-03    52414    52414      yes         2050
2026-10-04    17838    17303  so far today          670
```

The recount matches every complete day Tickerz printed, and the 2026-10-02 figures (47,746 coins, 1,725 graduations) are the ones the seal written on 2026-10-03 fixed in Bitcoin block 969734. Today's row is a running count that Tickerz reads once an hour, so its print runs behind a fresh recount.

## Recompute $GIGS and $WAGE

```
npm run gigs -- 2026-10-03             # all 24 hours
npm run gigs -- 2026-10-03 --hours 1   # one hour, a quick look
```

For each hour of the day it finds the hour's blocks on Base, counts every USDC signed transfer (the `AuthorizationUsed` log, EIP-3009) and reads in full the transactions in the sample: the low byte of `keccak256(tx hash || block hash)` under 16, one in sixteen. The sender cannot know its block's hash when it sends, so it cannot steer into or out of the sample, and anyone redraws the same sample. A sampled transaction is a payment when a listed facilitator sent it and it moved USDC under a signed authorization.

- **$GIGS is estimated from the one in sixteen sample**: every signed transfer of the day times the payments per sampled transaction, printed with its 95% range. It is graded display, not candidate, until every transaction is read.
- **$WAGE** is the median across payers of each payer's own median price, so one wallet firing thousands of calls counts once. No level prints below 50 payers in the sample.

About 40 to 60 requests an hour on Base's free public node (59 for 08:00 UTC on Oct 3; the busiest hours, with over 500 sampled receipts, need about 80), so roughly 1,200 for a full day.

Run on 2026-10-04 from this repo, `npm run gigs -- 2026-10-03` (24 hours read, about 15 minutes on the public node) printed:

```
GIGS 2026-10-03: 79739 (95% range 78963 to 80515)
  from 91937 signed transfers; 5811 sampled, 5040 of them x402 payments carrying 5040 payments
WAGE 2026-10-03: $0.005  (p25 $0.001, p75 $0.02, 810 payers, 227 payees)

Tickerz printed for 2026-10-03: GIGS 79739, WAGE 0.005
  GIGS range as printed: 78963 to 80515
  GIGS matches
  WAGE matches
```

The sample is fixed by the chain, so the recount lands on the same number and the same range as the print. The 2026-10-03 prints are sealed by the seal written on 2026-10-04, after 12:00 UTC: `npm run verify -- 2026-10-04` then shows them.

## Known issue: $WAGE on Oct 3 2026

Payer balancing stops one busy wallet from setting $WAGE. It does not stop many small wallets paying one service. On Oct 3 2026 one service's many $0.001 payers halved it: $WAGE printed $0.005, against $0.01 on Oct 2. A fix is open and is not yet in the rulebook or in this code. Until it lands, read $WAGE with that in mind.

## Sources and credits

- pump.fun accounts: https://github.com/pump-fun/pump-public-docs
- x402 and its "exact" scheme: https://www.x402.org/
- Facilitator wallets: Merit-Systems/x402scan, `packages/external/facilitators`, commit 131a5d3, MIT License, Copyright (c) 2025.
- OpenTimestamps: https://opentimestamps.org

The test fixture `test/fixtures/seal-2026-10-03.json` is Tickerz's public proof for that day, unchanged; the digest only reproduces if every row stays. It holds every index's rows, each under its source's terms as listed on https://tickerz.com/x. The Chicago crime rows come with the City of Chicago's notice: "This site provides applications using data that has been modified for use from its original source, www.cityofchicago.org, the official website of the City of Chicago. The City of Chicago makes no claims as to the content, accuracy, timeliness, or completeness of any of the data provided at this site. The data provided at this site is subject to change at any time. It is understood that the data provided at this site is being used at one's own risk."

## License

MIT, copyright Tickerz LLC (see LICENSE). The x402 facilitator list comes from Merit-Systems/x402scan under MIT (see THIRD-PARTY-NOTICES). The license covers this code; the published index values and the Tickerz name are not covered by it.
