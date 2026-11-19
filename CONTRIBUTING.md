# Contributing

Thank you for checking the numbers. The most useful thing anyone can do here is run a recount and tell us when it disagrees.

## Run it

Node 20 or later (tested on 22) and, for the models, Python 3.12.

```
npm ci
npm test                    # every file in test/, no network
npx tsc --noEmit            # strict type check of src, scripts and test
npm run recount -- JOBS     # check one signed number end to end, no key
npm run verify -- 2026-10-03
npm run mints -- 2026-11-17 # recount $MINTS from the chain, a few minutes
```

The models:

```
pip install -r models/requirements.txt
python3 models/test_forecast.py
python3 models/test_bandit.py
```

## What pull requests are welcome

- A fix to a counter, the seal check, the recount or the mirror, with a test in `test/` (or `models/test_*.py`) that fails before it and passes after.
- A new test for a case the counters do not cover yet: a day edge, a failed transaction, a revision, a malformed seal.
- Clearer docs, and fixes to anything in the README that is no longer true.
- Desk display layouts in `displays/`.

Please open an issue first for anything larger, and for anything in `oracle/`: that folder is copied from Tickerz's production code so that what co-signs is exactly what produced the number, so a change there has to land in both places.

These are written by scheduled jobs and are not edited by hand: `prints/`, `daily-proofs/`, `cosigns/`, `disputes/`, `forecasts/` and `floor/*.json`. A pull request that changes them will be closed.

## How

- One change per pull request, with what changed and why in the description.
- Plain English in docs and messages: short sentences, numbers first, no em or en dashes, no exclamation points, no hype words.
- Never put a key, token or private address in a file, an issue or a log.
- A security problem goes to desk@tickerz.com, not an issue (see [SECURITY.md](SECURITY.md)).

By contributing you agree your work is licensed under the MIT License, like the rest of the repo.
