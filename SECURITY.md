# Security policy

## Report a problem

Email **desk@tickerz.com** with "security" in the subject. Say what you found, where (a file, a workflow, a URL or a report hash), how to reproduce it, and what it would let someone do. Please do not open a public issue for something that could be abused before it is fixed.

A number that looks wrong but is not a security problem goes in a public issue instead: use the "A number looks wrong" form.

## Scope

In scope:

- **This repo's code.** The recount and co-signing in `oracle/`, the $MINTS counter in `src/mints.ts`, the seal check in `src/seal.ts` and `scripts/verify-proof.ts`, the mirror's checks in `scripts/mirror.ts`, the models in `models/`, and the workflows in `.github/workflows` (token permissions, script injection, how secrets are handled).
- **The recount and signature verification.** A signed report that verifies but should not, a co-signature this repo wrote over a number its recount did not reach, a way to make the recount agree with a wrong number, or a way to make the seal check pass on changed text.
- **The published files.** `prints/`, `daily-proofs/`, `cosigns/`, `disputes/`, `forecasts/` and `floor/`: a number as first published that changed, a period that disappeared, a proof whose digest does not match, a co-signature that does not verify, or a private line in a public file.

Not in scope: findings that need a stolen key or a taken-over account, slowing down a public RPC or API, social engineering, and scanner output without a working case. Problems in the sources themselves (the BLS, the Labor Department, the Solana chain) go to those sources. Problems with tickerz.com itself are welcome at the same address and are handled the same way, but the code is not in this repo.

## What happens next

1. We reply to say we have it and whether it is in scope.
2. We reproduce it. A fix to code lands as a pull request here. A wrong signed number is corrected in the open: a dispute in `disputes/` or a signed correction report that points at the one it replaces. A number as first published is never rewritten.
3. We tell you when the fix is live, and credit you in the pull request by the name or handle you give, if you want credit.
4. Please wait until the fix ships, or 90 days, before you publish.

There is no bug bounty: reports are not paid.

Only `main` is supported. There are no releases to patch.

## How a reader verifies a signed report

The public keys are published at https://tickerz.com/.well-known/tickerz-signer.json:

| Key | Address (Ed25519, Solana format) | Signs |
|---|---|---|
| Publisher | `HCTmBYfjrJyenusT99huGVMVDcvhKznyb2ha18gqjVjE` | `"tickerz-report-v1:"` followed by the 32 bytes of sha256 of the report's canonical JSON |
| Recount (this repo) | `7TYVLzDyAGspQ2FSH1H4D8kzrocuQqSRMM48frr3EjZ3` | `"tickerz-cosign-v1:"` followed by the 32 bytes of the provisional report's hash |

Canonical JSON means keys sorted at every depth, no whitespace and integers only (values are scaled integers in strings): the integer-only subset of RFC 8785. The same file names the Solana names that point at each key (`oracle.tickerzhq.sns` for the publisher, `recount.tickerzhq.sns` for the recount key), so the file and the names confirm each other.

To check a report end to end with no key:

```
npm ci
npm run recount -- JOBS              # or UNEMP, CPI, CORECPI, LAYOFFS, MINTS; add a period to pick one
```

It fetches the report from `https://tickerz.com/api/indices/{ticker}/report`, checks that the hash is the report's, that the publisher signed it and that this repo co-signed it, then counts the period again from the source. The code is `oracle/scripts/recount.ts` and `verifyEnvelope` in `oracle/src/lib/oracle/report.ts`. A report you think verifies wrongly: send its URL and that output.

The daily Bitcoin seal is checked with `npm run verify -- YYYY-MM-DD` and then `ots verify` (see the README).
