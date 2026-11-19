## What changed and why

<!-- One or two plain sentences. Link the issue if there is one. -->

## How it was checked

- [ ] `npm test` passes
- [ ] `npx tsc --noEmit` passes
- [ ] `python3 models/test_forecast.py` and `python3 models/test_bandit.py` pass (only if `models/` changed)
- [ ] A number in the docs comes from a file in this repo or the public API, not from memory

## Before you open it

- [ ] No key, token or private address in any file, commit or log
- [ ] No hand edits to `prints/`, `daily-proofs/`, `cosigns/`, `disputes/`, `forecasts/` or `floor/*.json` (scheduled jobs write them)
- [ ] A change to `oracle/` was agreed in an issue first (it is copied from Tickerz's production code)
