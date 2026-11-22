# AGENTS.md

tickerz-open is the public, recountable part of Tickerz: the daily recount that co-signs the oracle's signed numbers, the $MINTS counter, the checker for the daily Bitcoin-timestamped seal, a mirror of every print, and Forecast v1. TypeScript on Node, plus Python for the models in `models/`.

## Commands

Node 20 or later (tested on 22). Python 3.12 for `models/`.

```
npm ci
npm test                       # every test/*.test.ts via scripts/test-all.ts, no network
npm run typecheck              # tsc --noEmit over src, scripts and test
npm run recount -- JOBS        # check one signed report end to end, no key, needs network
npm run verify -- 2026-10-03   # check one day's seal, writes proofs/ (ignored by git)
npm run mints -- 2026-11-17    # recount $MINTS from the Solana chain, takes minutes
npm run gigs -- 2026-10-03     # the retired $GIGS and $WAGE math, kept as history
node --import tsx test/floor.test.ts   # one test file
```

Each test file must print `N passed` as its last line; `scripts/test-all.ts` reads that line to count checks.

```
pip install -r models/requirements.txt
python3 models/test_forecast.py
python3 models/test_bandit.py
```

`models/requirements-shadow.txt` pulls CPU torch and about 1.3 GB of model weights. Skip it unless the work is on the shadow models.

## What CI checks on a pull request

- `codeql.yml`: CodeQL (security-extended) on the workflows, the TypeScript and the Python, on every PR to main.
- `floor.yml`: `node --import tsx test/floor.test.ts`, only when `floor/` or that test changes.
- `bandit.yml`: `python models/test_bandit.py` and a ranking of `models/bandit_sample.md`, only when `models/bandit*` changes. "bandit" is the decision model, not the Bandit linter.

Nothing in CI runs `npm test`, `npm run typecheck` or `models/test_forecast.py`. Run them yourself before opening a PR; the PR template asks for them. No status check is required to merge.

## Scheduled jobs that push to main

- `mirror.yml`, 01:40 and 13:40 UTC: copies the prints from tickerz.com into `prints/` and `daily-proofs/` with `node scripts/mirror.ts` (Node 24 runs the TypeScript directly, no install). It fails and writes nothing if a first print already here changed or a period disappeared.
- `forecast.yml`, 14:10 UTC: runs `models/forecast.py` and commits `forecasts/`.
- `cosign.yml`, 16:40 UTC: runs `oracle/scripts/cosign.ts` and commits `cosigns/` and `disputes/`.

So main moves several times a day. Fetch and rebase before pushing, and expect a PR branch to fall behind.

Other schedules commit nothing: `uptime.yml` every 15 minutes (it opens one issue labelled `uptime` while tickerz.com fails a check and closes it on the first clean run), `indexnow.yml` daily, `codeql.yml` and `scorecard.yml` weekly. Dependabot opens grouped update PRs on Mondays.

There are no releases and nothing deploys from here; only main is supported. The tickerz.com site is not in this repo. The Claude Code plugin in `plugin/` (listed by `.claude-plugin/marketplace.json`) is installed straight from this repo, so a change there reaches users when it merges.

## Gotchas

- Never edit by hand: `prints/`, `daily-proofs/`, `cosigns/`, `disputes/`, `forecasts/` and `floor/*.json`. Jobs write them, and a PR that changes them is closed.
- `python3 models/forecast.py --dry` reads tickerz.com and rewrites `forecasts/latest.json` (and `shadow.json`). Discard that change before committing.
- `oracle/` is copied from Tickerz's production code, so the public recount is exactly the code that co-signs. A change there needs an issue first and has to land in both places. `tsconfig.json` does not include `oracle/`, so `npm run typecheck` does not check it.
- The cosign job's key and RPC URL (`TICKERZ_COSIGNER_KEY`, `SOLANA_RPC_URL`) exist only as Actions secrets. Never print, log or commit a key, token or private address. `npm run recount` needs no key and uses the public Solana RPC unless `SOLANA_RPC_URL` is set.
- Keep the workflow shape: actions pinned to a full commit SHA with a version comment, the least token permission per job, and the job that runs installed code never holds a write token (a separate commit job pushes). OpenSSF Scorecard grades this.
- A fix to a counter, the seal check, the recount or the mirror comes with a test that fails before it and passes after.
- A number in the docs comes from a file here or the public API, never from memory.
- Docs and commit messages: plain English, short sentences, numbers first, no em or en dashes, no exclamation marks, no hype words (`CONTRIBUTING.md`).
- Security problems are reported privately as `SECURITY.md` says, never in a public issue.
