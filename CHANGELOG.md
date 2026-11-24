# Changelog

What changed in tickerz-open, by release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Only main is supported; a release marks a point you can cite and recount from.

The scheduled jobs (the mirror, the forecast, the co-sign and the Floor levels) commit to main several times a day. Their data commits are not listed here.

## [Unreleased]

## [0.1.0] - 2026-11-24

The first tagged release: everything on main since the repo opened on Oct 4 2026.

### The recount

- An independent recount co-signs every signed Tickerz number. `npm run recount -- JOBS` checks one signed report end to end with no key.
- It also rechecks each of the last 14 days of a daily index, so a day that stopped being the newest is still recounted.
- A read that cannot finish is not a dispute. Base blocks are found by search, and logs are read from nodes that still serve them.
- `$LAYOFFS` is recounted from the Labor Department's file and co-signed.

### Counters and proofs

- `npm run mints` recounts `$MINTS` from the Solana chain.
- `npm run verify -- <day>` checks one day's Bitcoin-timestamped seal. Since 0.1.0 a malformed proof fails its check instead of throwing, and property tests cover the checker on generated inputs.
- `mirror.yml` copies every print into `prints/` and `daily-proofs/` twice a day and fails, writing nothing, if a print already here changed or a period disappeared.

### Forecast v1 and the decision model

- `models/forecast.py`: a walk-forward backtest, a daily model choice and next-print forecasts, display only.
- `models/bandit.py`: a Thompson-sampling bandit over experiment types.
- The models' pip installs are pinned by sha256 (`pip install --require-hashes`).

### Around the numbers

- A Claude Code plugin with the Tickerz MCP server and the tickerz-index skill, installed straight from this repo.
- Desk displays: a TRMNL plugin and a Pixlet app for the Tickerz Close or one index.
- `floor/latest.json`: the company of agents in one public file, for tickerz.com/floor.
- An uptime check on tickerz.com every 15 minutes that opens one issue while anything fails, and IndexNow once a day.

### Security and supply chain

- Every action pinned to a full commit SHA, the least token permission per job, and the jobs that run installed code never hold a write token.
- CodeQL (security-extended), OpenSSF Scorecard, Dependabot with a 7-day cooldown on version updates, and `SECURITY.md` for private reports.
- MIT license.

[Unreleased]: https://github.com/tickerzhq/tickerz-open/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tickerzhq/tickerz-open/releases/tag/v0.1.0
