# License: not chosen yet

This repo has no LICENSE file on purpose. Which license it carries is the founder's decision, made before the repo is published. Until a license is added, the code is shown for reading and the usual default applies: all rights reserved.

## The usual options

For a repo whose job is to let judges and venues read and rerun the code, the two common choices are:

- **MIT.** Short and permissive. Anyone may use, copy, change and redistribute the code, including in closed products, as long as the copyright notice and license text travel with it.
- **Apache-2.0.** Just as permissive, plus an explicit patent license from contributors and a requirement to mark changed files. Longer, and a common pick for companies.

Either lets a judge clone, run `npm test` and `npm run verify`, and reuse the verifier. Neither gives away the data: the index levels Tickerz publishes stay under the terms on each index page ("The count is Tickerz's own and is licensed by Tickerz").

## Third-party code to credit under either choice

- `src/facilitators.ts` is the list of x402 facilitator wallets on Base from Merit-Systems/x402scan (`packages/external/facilitators`, commit 131a5d3), MIT License, Copyright (c) 2025. Keep the credit in the file header and add a THIRD-PARTY-NOTICES file carrying x402scan's MIT notice before publishing.
- The pump.fun account addresses in `src/mints.ts` are public facts from https://github.com/pump-fun/pump-public-docs; no code is copied.
- `test/fixtures/seal-2026-10-03.json` is Tickerz's own public proof for 2026-10-03, unchanged. It holds every index's rows that day, each under its source's terms (see the README).

## To publish

1. Pick MIT or Apache-2.0 (or another license).
2. Add `LICENSE` with the full text and the copyright line. THIRD-PARTY-NOTICES for x402scan is already in place.
3. Set `"license"` in `package.json` and drop `"private": true` if the package will be published to npm (not needed for GitHub).
4. Delete this file.
