<p align="center">
  <a href="https://tickerz.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/brand/tickerz-mark-tape-3-bone.svg">
      <img alt="Tickerz" src=".github/brand/tickerz-mark-tape-3-ink.svg" height="56">
    </picture>
  </a>
</p>

<h1 align="center">Tickerz Open</h1>

<p align="center">Recount any signed Tickerz number yourself.</p>

<p align="center">
  <a href="https://github.com/tickerzhq/tickerz-open/actions/workflows/uptime.yml"><img alt="uptime" src="https://github.com/tickerzhq/tickerz-open/actions/workflows/uptime.yml/badge.svg"></a>
  <a href="https://github.com/tickerzhq/tickerz-open/actions/workflows/cosign.yml"><img alt="cosign" src="https://github.com/tickerzhq/tickerz-open/actions/workflows/cosign.yml/badge.svg"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/tickerzhq/tickerz-open"><img alt="OpenSSF Scorecard" src="https://api.scorecard.dev/projects/github.com/tickerzhq/tickerz-open/badge"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/tickerzhq/tickerz-open"></a>
</p>

[Tickerz](https://tickerz.com) turns data into numbers that markets can be built on: everything gets a ticker. Each number is kept as first published, with a Bitcoin timestamp, and the ones a market may settle on are signed. Tickerz publishes the number; it never runs a market.

This repo is the public half. It counts every signed number again from its public source and co-signs it only when the count is exactly the same, checks the daily Bitcoin proofs, and keeps a second public copy of the settlement files. No database, no keys, no account: everything it reads is public.

## Try it

```
git clone https://github.com/tickerzhq/tickerz-open && cd tickerz-open
npm ci
npm run recount -- JOBS
```

Run on Nov 19 2026, trimmed:

```
$JOBS 2026-10-01, final: 165,000 jobs
  hash      e4ef26a3...9ea9  matches the report
  signed    HCTmBYfj...jVjE  publisher signature valid
  cosigned  7TYVLzDy...EjZ3  this repo's co-signature valid
  recount   165,000 from BLS API v1 CES0000000001

Match: the recount equals the signed value.
```

That fetched the signed $JOBS report, checked its hash, the publisher's signature and this repo's co-signature, and counted October payrolls again from the Bureau of Labor Statistics. Try `UNEMP`, `CPI`, `CORECPI`, `LAYOFFS` or `MINTS`, or name a period: `npm run recount -- MINTS 2026-11-17` reads that day from the Solana chain over the public RPC in a few minutes, and matched the signed 48,226 coins.

## What is in this repo

| Folder | What it does | When it runs |
|---|---|---|
| [`oracle/`](oracle) | The public recount: checks each signed report, counts the period again from its source, co-signs on an exact match | Daily (`cosign.yml`) |
| [`cosigns/`](cosigns), [`disputes/`](disputes) | Its output: one file per co-signed report, one per disagreement | Daily |
| [`src/`](src), [`scripts/`](scripts) | The $MINTS counter, the daily seal check, the mirror, and the retired $GIGS and $WAGE math kept as history | `npm run verify`, `mints`, `gigs` |
| [`prints/`](prints), [`daily-proofs/`](daily-proofs) | The settlement files and daily proofs, mirrored from tickerz.com | Twice a day (`mirror.yml`) |
| [`models/`](models), [`forecasts/`](forecasts) | Tickerz Forecast v1, the open forecast baseline, and its live record | Daily (`forecast.yml`) |
| [`plugin/`](plugin) | The Tickerz plugin for Claude Code: the MCP server and a skill | |
| [`displays/`](displays) | Desk displays for TRMNL e-paper and Tidbyt LED panels | |
| [`floor/`](floor) | The Floor: the company of AI agents behind Tickerz, as a public file | On every change (`floor.yml`) |
| [`.github/workflows/`](.github/workflows) | Uptime of tickerz.com every 15 minutes, CodeQL, OpenSSF Scorecard and the jobs above | |

## Links

- **Tickerz:** https://tickerz.com, with all 50 indexes at https://tickerz.com/x
- **The oracle**, every signed number: https://oracle.tickerz.com
- **MCP server:** `https://tickerz.com/mcp` (HTTP, no key, no signup, 17 tools)
- **Claude Code plugin:** `/plugin install tickerz --marketplace tickerzhq/tickerz-open` ([plugin/README.md](plugin/README.md)), or the server alone: `claude mcp add --transport http tickerz https://tickerz.com/mcp`
- **Public keys:** https://tickerz.com/.well-known/tickerz-signer.json
- **API:** https://tickerz.com/api/v1/indices (no key)
- **Rules:** [METHODOLOGY.md](METHODOLOGY.md) for the indexes counted here, https://tickerz.com/methodology for the rest

## How a signed number becomes final

[![$JOBS](https://tickerz.com/api/badge/jobs.svg)](https://oracle.tickerz.com/jobs) [![$CPI](https://tickerz.com/api/badge/cpi.svg)](https://oracle.tickerz.com/cpi) [![$MINTS](https://tickerz.com/api/badge/mints.svg)](https://oracle.tickerz.com/mints) [![$SHELTER](https://tickerz.com/api/badge/shelter.svg)](https://tickerz.com/x/shelter)

The numbers a market may settle on ($LAYOFFS, $JOBS, $UNEMP, $CPI and $CORECPI; $MINTS is signed too) are signed by the Tickerz oracle: one canonical JSON report per print, signed with the publisher's Ed25519 key. `.github/workflows/cosign.yml` runs `oracle/` every day at 16:40 UTC. It fetches each new signed report from tickerz.com, counts the period again from the source (the BLS API and flat file for $JOBS, $UNEMP, $CPI and $CORECPI; the Labor Department's claims file for $LAYOFFS; the Solana chain for $MINTS), and co-signs only when its count equals the signed value. Co-signatures land in `cosigns/`, disagreements in `disputes/`. A number is final after 24 hours with a co-signature and no dispute.

The co-signing key is this repo's own, separate from the publisher's:

| Key | Address |
|---|---|
| Publisher | `HCTmBYfjrJyenusT99huGVMVDcvhKznyb2ha18gqjVjE` |
| Recount (this repo) | `7TYVLzDyAGspQ2FSH1H4D8kzrocuQqSRMM48frr3EjZ3` |

Both are listed, with the exact bytes each one signs, at https://tickerz.com/.well-known/tickerz-signer.json, and [SECURITY.md](SECURITY.md) walks through the check. `npm run recount` (`oracle/scripts/recount.ts`) runs the same check and the same count as the daily job, and writes and signs nothing. To co-sign yourself: `npx tsx oracle/scripts/cosign.ts --out .` with your own `TICKERZ_COSIGNER_KEY`.

`oracle/` is copied from Tickerz's production code so anyone can read exactly what co-signs. Every signed number is listed at https://oracle.tickerz.com and https://tickerz.com/signed. The oracle's Solana program runs on devnet; its mainnet address is reserved and not deployed yet, so until it is, the signed report is the record.

## The indexes

Tickerz publishes indexes of what people actually do. There are 50 today, in nine families (Vice, Hard times, Mind, Streets, Wild, Net, Planet, Markets and Power), led by the human ones: porn sites among the web's most visited ($GOON), lonely adults ($LONELY), phone bets in New York ($TILT), debt collector complaints ($BROKE), the New York City shelter census ($SHELTER) and evictions ($EVICTED). Then the streets, the wild, the net and the planet, from potholes to Arctic sea ice, and the markets, from memecoin launches ($MINTS) and airport checkpoints ($TSA) to the US jobs and CPI numbers as first published, and power: executive orders signed each week ($EO). Each index counts one thing from a named public source, daily, weekly or monthly. The full list is at https://tickerz.com/x.

Once a day every new reading is hashed and timestamped in Bitcoin with OpenTimestamps, so anyone can check later that a number was not changed after it was first published.

Three indexes are counted by code in this repo:

| Index | What it counts | Source |
|---|---|---|
| **$MINTS** | New coins created on pump.fun per UTC day, with graduations as a second line | Solana mainnet, read directly |
| **$GIGS** (retired Nov 12 2026) | Paid calls settled over x402 on Base per UTC day, estimated from a one in sixteen sample, with a 95% range | Base mainnet, read directly |
| **$WAGE** (retired Nov 12 2026) | The payer-balanced median price of one of those paid calls | Base mainnet, read directly |

Live page: https://tickerz.com/x/mints. $GIGS and $WAGE were retired on Nov 12 2026 and their pages go to the board; their code stays here so every day they printed (Sep 15 to Nov 11 2026) can still be recounted. The full rulebook for each is in [METHODOLOGY.md](METHODOLOGY.md).

The counting code is extracted from Tickerz's production code with the counting rules unchanged. What was taken out: the database, the scheduler, the website, and environment settings. What is not here at all: how Tickerz scores a reading against its own history, how it decides when to write, the Terminal's unusual trading score for crypto and stocks, and the Tickerz Engine, the private forecasting engine behind the ranges on tickerz.com (see Forecasts below).

## Verify a day's proof

```
npm run verify -- 2026-10-03
```

This fetches the seal Tickerz wrote on that UTC day from `https://tickerz.com/api/v1/indices/proof?day=2026-10-03` and its proof from `...&format=ots`, then checks, with no Bitcoin node:

1. `sha256(canonical_json)` equals the published `digest_sha256`.
2. The text is the seal for that day.
3. Rebuilt from its own rows with the published key order (`canonicalSealJson`), the text comes out byte for byte the same, so nothing rides along outside the rows.
4. The `.ots` file commits to that same digest (the 32 bytes after its header), and matches the copy inside the JSON.

It then prints the $MINTS, $GIGS and $WAGE rows the seal fixes and writes two files side by side: `proofs/tickerz-seal-2026-10-03.json` (the exact bytes that were hashed) and `proofs/tickerz-seal-2026-10-03.json.ots`. The seal holds every index's rows, so the `.json` it writes is where to read any other index for that day. A seal written after Nov 12 2026 has no $GIGS or $WAGE row: they were retired.

A seal written on day D holds the readings that completed since the seal before, usually day D-1. The seal written on 2026-10-03 fixes the 2026-10-02 prints: $MINTS 47,746 (graduations 1,725), $GIGS 50,535, $WAGE $0.01. Its digest is `2d4f359fc8cf89e2e431d7e03517d9577125945df989f7ef91976b5e5334b3f4`.

**Finish on Bitcoin** with the standard OpenTimestamps client:

```
pip install opentimestamps-client
ots info   proofs/tickerz-seal-2026-10-03.json.ots   # the path from the digest to its Bitcoin attestation; no node needed
ots verify proofs/tickerz-seal-2026-10-03.json.ots   # hashes the .json beside it and checks the attested block
```

`ots verify` reads the block header from a Bitcoin Core node on the same machine (the client's default; a pruned node works). Without a node, drop both files on https://opentimestamps.org, which checks the block against a public explorer. By hand: the 2026-10-03 proof ends in `BitcoinBlockHeaderAttestation(969734)` over the value `966ff86fe0c590e3ff8332b6b757a34f642b3431db618aada194d1c87cecee79`. That is the merkle root of Bitcoin block 969734 in the byte order the block header uses; explorers print the same bytes reversed, `79eeec7cc8d194a1ad8a61db31342b644fa357b7b63283ffe390c5e06ff86f96`. The block's time is 2026-10-03 13:25:17 UTC, 45 minutes after the seal was stamped.

## The prints, mirrored here

`prints/<TICKER>.csv` is the settlement file for each index counted from a source whose terms allow republishing the count ($LAYOFFS, $MINTS, and since Nov 12 2026 the human indexes on public domain or CC0 files: $LONELY, $BROKE, $STRAPPED, $LASTCALL, $OD, $SHELTER, $SAD; GIGS.csv and WAGE.csv stay as history since $GIGS and $WAGE were retired on Nov 12 2026): one row per complete period, with the number as first published, the value a contract settles on, any later revision beside it, and the day and Bitcoin block of its proof. `daily-proofs/<day>.json` is each daily proof: the exact JSON that was hashed, its SHA-256, and the OpenTimestamps file.

A scheduled job (`.github/workflows/mirror.yml`, `scripts/mirror.ts`) copies them from tickerz.com twice a day. It refuses to write, and fails in public, if a number as first published already in this repo changed, a period disappeared, or a proof's digest differs. A revision (revised = true) may change a period's value beside the number as first published; git history shows it. So this repo's git history is a second, public record of what was printed and when: a market that settles on a Tickerz number does not have to trust, or wait on, Tickerz's own servers.

Raw files: `https://raw.githubusercontent.com/tickerzhq/tickerz-open/main/prints/MINTS.csv`

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

## Recompute $GIGS and $WAGE (retired, kept as history)

$GIGS and $WAGE were retired on Nov 12 2026: Tickerz prints neither any more, and their last printed day is Nov 11 2026. The code stays so any day they printed can still be recounted from the chain. tickerz.com no longer serves their series, so the script's last step, setting the recount beside the print, says it could not read the published series; compare with `prints/GIGS.csv` and `prints/WAGE.csv` here instead.

```
npm run gigs -- 2026-10-03             # all 24 hours
npm run gigs -- 2026-10-03 --hours 1   # one hour, a quick look
```

For each hour of the day it finds the hour's blocks on Base, counts every USDC signed transfer (the `AuthorizationUsed` log, EIP-3009) and reads in full the transactions in the sample: the low byte of `keccak256(tx hash || block hash)` under 16, one in sixteen. The sender cannot know its block's hash when it sends, so it cannot steer into or out of the sample, and anyone redraws the same sample. A sampled transaction is a payment when a listed facilitator sent it and it moved USDC under a signed authorization.

- **$GIGS is estimated from the one in sixteen sample**: every signed transfer of the day times the payments per sampled transaction, printed with its 95% range. It is graded display, not candidate, until every transaction is read.
- **$WAGE** is the median across payers of each payer's own median price, so one wallet firing thousands of calls counts once. No level prints below 50 payers in the sample.

About 40 to 60 requests an hour on Base's free public nodes (59 for 08:00 UTC on Oct 3; the busiest hours, with over 500 sampled receipts, need about 80), so roughly 1,200 for a full day. Base went from a block every 2 seconds to one every 0.2 seconds at 2026-11-05 18:00 UTC, so an hour after that is ten times the blocks and takes more log calls.

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

**$WAGE rule v1 here, rule v2 in what Tickerz printed from Oct 5 2026.** Payer balancing stops one busy wallet from setting $WAGE. It does not stop many small wallets paying one service. On Oct 3 2026 one service's many $0.001 payers halved it: $WAGE printed $0.005, against $0.01 on Oct 2. From the Oct 5 2026 print Tickerz counted $WAGE under rule v2, which holds any one service's payers to 5% of the vote. The code here is still rule v1, so a $WAGE recount of a day from Oct 5 to Nov 11 2026 can differ from the print.

## Forecasts (Tickerz Forecast v1)

Where each index's next number is likely to land, with a 10th to 90th percentile range, and how well that has worked, for every live index the public API serves with enough history (48 of the 50 in the run of Nov 18 2026: $TSA and $EO joined the board that day). Display only: a forecast never touches a printed or settled number. Forecast v1 is the open baseline: its whole method is here, so anyone can rerun it. Code: [models/forecast.py](models/forecast.py), run daily at 14:10 UTC by `.github/workflows/forecast.yml`.

- **Backward.** Every candidate (last number, 7-period mean and median, 7-day seasonal, drift, exponential smoothing and Theta from statsforecast, gradient-boosted trees from LightGBM once a series has 60 periods, and the median of all of them) is walked forward over the numbers as first published: at each past period it sees only what came before. Scored by pinball loss and by how often the actual number fell inside the range (80% is right).
- **Forward.** Each index uses the median of all candidates unless another model's loss over the last 14 periods is at least 10% lower. The next forecast is appended to `forecasts/log.csv` before the number is known; a row there is never rewritten, and only the first forecast for a period counts.
- **Self-correcting.** The choice is made again every day from the newest prints and logged in `forecasts/selection.csv`.
- **Honest numbers.** `forecasts/latest.json` gives, per index, the backtest of the whole procedure (picking the model the way the daily run does, from earlier periods only) against repeating the last number on the same periods. The default model and the 10% margin were chosen after looking at that backtest, so the clean test is the live record in `log.csv`.
- **In shadow, from Nov 2026.** Two open models, Amazon's Chronos-2 and Google's TimesFM 2.5 (both Apache 2.0), forecast the same next period with their own ranges, along with the average of the two, for four weeks beside v1. They go to `forecasts/shadow-log.csv` (append only, the first forecast for a period counts) and `forecasts/shadow.json` (the same side-by-side live record); they never touch `latest.json`. In a backtest on v1's own periods they scored about 7 to 10% better than v1. The site does not read them.

```bash
pip install -r models/requirements.txt
python3 models/test_forecast.py      # no network: no look-ahead, ranges, negative series, the live record
python3 models/forecast.py --dry     # reads tickerz.com, writes forecasts/latest.json (and shadow.json) only
pip install -r models/requirements-shadow.txt   # optional: the shadow models (CPU torch, about 1.3 GB of weights)
```

**What tickerz.com shows.** Since Nov 18 2026 the ranges on tickerz.com come from the Tickerz Engine, a forecasting engine that learns from every print. For each index it publishes the likely range of the next number and how unusual the newest one was ("about 1 in N"), with its live record: the `engine` object in `GET https://tickerz.com/api/v1/indices/{ticker}` and the page https://tickerz.com/forecast. Display only, never a settled number. The engine's method is private and is not in this repo. Where the engine has no reading, the site shows Forecast v1 from `forecasts/latest.json` here.

`models/bandit.py` is the decision model over the company's experiments, a Thompson-sampling bandit; `.github/workflows/bandit.yml` checks it and ranks the made-up sample in `models/bandit_sample.md`.

## Desk displays

`displays/` holds a free plugin for TRMNL e-paper screens and a Pixlet app for Tidbyt LED panels on a Tronbyt server. Each shows the Tickerz Close or one index from the public API. Setup and screenshots: [displays/README.md](displays/README.md).

## The Floor

Tickerz runs as a company of AI agents, shown at [tickerz.com/proof-of-work](https://tickerz.com/proof-of-work) (tickerz.com/floor goes there). That page reads `floor/seats.json`: every seat with its badge, title and team, its level and how it moved, what it is working on, what it learned and its own view (the founder's seat included), written nightly by the scorer from the company's private record with private lines dropped. `floor/latest.json` is the first version of the file (Oct 9 2026): the three numbers the company is scored on, the bell for real wins, the Company Close and the idea market. It is exported by a script that passes every line through an allowlist and a confidentiality check and writes nothing when one fails. A ticker, a rank or odds that nothing measures yet is `null`, never a guess. Its rules are in `floor/RULES.md`, its fields in `floor/schema.json`, and `.github/workflows/floor.yml` checks every change with `test/floor.test.ts`.

## Run the tests

Tested on Node 22.23 (package.json asks for Node 20 or later).

```
npm ci
npm test            # 7 files, 55 checks, no network
npx tsc --noEmit    # strict type check of src, scripts and tests
```

The tests run the $MINTS counter against a fake chain (UTC day edges, failed and untimed transactions, a read cut short and resumed, rate limits), the x402 extraction against hand-built receipts (routers, fee proxies, several payments in one transaction, payment channel deposits), the estimate against an hour Tickerz read in full (4,044 payments; the estimate's range holds it), and every check of the verifier against a real seal, plus the ways a changed seal must fail.

## Uptime

`.github/workflows/uptime.yml` checks ten tickerz.com pages and endpoints every 15 minutes: each must answer 200 within 5 seconds, and the board must be fresh. While anything fails there is one open issue labelled `uptime` in this repo, and the first clean run closes it, so the record of when the site was down is public too.

## Security

Report a security problem to desk@tickerz.com, not in an issue: [SECURITY.md](SECURITY.md) has the scope, what happens next and how to verify a signed report. In this repo:

- Every action in `.github/workflows` is pinned to a full commit SHA, with its version in a comment.
- Each workflow's token has the least it needs. Only the three jobs that commit their own folders (cosign, forecast, mirror) can push, each one run at a time; uptime can open and close its own issue; everything else only reads.
- CodeQL scans the TypeScript, the Python and the workflows on every pull request, on code pushed to main and weekly. OpenSSF Scorecard grades the setup weekly and publishes the badge above.
- Dependabot proposes updates to the npm and pip packages and the actions every week, grouped, once a release is 7 days old.

## Code map

```
oracle/
  src/lib/oracle/   The recount (cosign.ts, recount.ts), the signed report and its checks (report.ts, canonical.ts).
  scripts/cosign.ts   The daily co-signing job. scripts/recount.ts: npm run recount, the same check with no key.
src/
  mints.ts          $MINTS: the Solana counter. Pages getSignaturesForAddress on pump.fun's mint authority and
                    migrator, counts successful signatures per UTC day of block time, and keeps a cursor so a
                    run never counts a signature twice or skips one.
  machines.ts       $GIGS and $WAGE (retired Nov 12 2026, kept so past days can be recounted): x402 payment
                    extraction from a Base receipt, the one in sixteen sample, the estimate and its range, the
                    payer-balanced median, and readHour over public Base nodes.
  facilitators.ts   The 128 x402 facilitator wallets on Base whose payments count (from x402scan, MIT).
  gigsRange.ts      The 95% range printed beside $GIGS (retired): parsing, and a reader for the public API.
  seal.ts           The daily seal: its canonical JSON, the numbers as first published, the .ots header, and checkSeal.
  rulebook.ts       The published rulebook lines for the three indexes, as data.
  publicApi.ts      Reads what Tickerz printed from https://tickerz.com/api/v1 (no key).
scripts/
  verify-proof.ts   npm run verify: check one day's seal and write the files for `ots verify`.
  count-mints.ts    npm run mints: recount $MINTS from the chain and set it beside the print.
  recompute-gigs-wage.ts  npm run gigs: recompute $GIGS and $WAGE for a day from the chain.
  mirror.ts         The twice-daily mirror of the prints and daily proofs. node scripts/mirror.ts
  test-all.ts       npm test: runs every file in test/.
test/               Plain-assert tests, no network. Most are copied from Tickerz's own suite.
  fixtures/seal-2026-10-03.json   The public proof for 2026-10-03, unchanged.
models/             forecast.py (Tickerz Forecast v1, writes forecasts/) and bandit.py (the decision model over experiments).
plugin/, .claude-plugin/  The Tickerz plugin for Claude Code: the tickerz.com MCP server and the tickerz-index skill.
```

## Contributing and citing

Recounts that disagree are the most useful thing anyone can send: open a "A number looks wrong" issue with the ticker, the period, the value seen, the value expected and the source. How to run everything and which pull requests are welcome: [CONTRIBUTING.md](CONTRIBUTING.md). To cite this repo, use [CITATION.cff](CITATION.cff) (GitHub's "Cite this repository" button reads it).

## Sources and credits

- pump.fun accounts: https://github.com/pump-fun/pump-public-docs
- x402 and its "exact" scheme: https://www.x402.org/
- Facilitator wallets: Merit-Systems/x402scan, `packages/external/facilitators`, commit 131a5d3, MIT License, Copyright (c) 2025.
- OpenTimestamps: https://opentimestamps.org

The test fixture `test/fixtures/seal-2026-10-03.json` is Tickerz's public proof for that day, unchanged; the digest only reproduces if every row stays. It holds every index's rows, each under its source's terms as listed on https://tickerz.com/x. The Chicago crime rows come with the City of Chicago's notice: "This site provides applications using data that has been modified for use from its original source, www.cityofchicago.org, the official website of the City of Chicago. The City of Chicago makes no claims as to the content, accuracy, timeliness, or completeness of any of the data provided at this site. The data provided at this site is subject to change at any time. It is understood that the data provided at this site is being used at one's own risk."

## License

MIT, copyright Tickerz LLC (see LICENSE). The x402 facilitator list comes from Merit-Systems/x402scan under MIT (see THIRD-PARTY-NOTICES). The license covers this code; the published index values and the Tickerz name are not covered by it.
