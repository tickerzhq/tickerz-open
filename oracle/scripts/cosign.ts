/**
 * The independent recount, as run by the public tickerz-open repo (oracle/tickerz-open/cosign.yml, copied there).
 * For each index the oracle covers it fetches the newest signed report, checks the publisher's signature, counts the
 * period again from the public source, and when the count is exactly the signed value writes a co-signature to
 * cosigns/<report hash>.json. A different count is written to disputes/<report hash>.json, which keeps the print
 * provisional. Tickerz reads cosigns/ from the public repo (src/lib/oracle/run.ts).
 *
 *   TICKERZ_COSIGNER_KEY=<solana-keygen JSON or base58> [SOLANA_RPC_URL=<Helius or dRPC URL>] \
 *     npx tsx scripts/oracle/cosign.ts --out <dir> [--base https://tickerz.com]
 *
 * The key never prints. A report already co-signed or disputed is skipped.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { recountAndCosign } from "../src/lib/oracle/cosign";
import type { ReportEnvelope } from "../src/lib/oracle/report";

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const out = arg("out", ".")!;
const base = arg("base", "https://tickerz.com")!;
const TICKERS = ["JOBS", "UNEMP", "CPI", "CORECPI", "LAYOFFS", "MINTS"];

/** Daily indexes are signed every day, so the newest report is not the only one waiting: a day that stopped being the
 * newest before the recount ran (Nov 2026: $MINTS on every other day) would never be recounted. So a daily index is
 * also asked for each of the last DAILY_LOOKBACK UTC days by period (older days run into the page cap); an answer that is not provisional, or is already
 * co-signed or disputed, is skipped below. */
const DAILY = new Set(["MINTS"]);
// About seven days of $MINTS signatures fit under the recount's page cap, paging back from now.
const DAILY_LOOKBACK = 7;
function candidates(now: Date): { t: string; url: string }[] {
  const list: { t: string; url: string }[] = [];
  for (const t of TICKERS) {
    list.push({ t, url: `${base}/api/indices/${t.toLowerCase()}/report` });
    if (!DAILY.has(t)) continue;
    for (let i = 1; i <= DAILY_LOOKBACK; i++) {
      const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i)).toISOString().slice(0, 10);
      list.push({ t, url: `${base}/api/indices/${t.toLowerCase()}/report?period=${day}` });
    }
  }
  return list;
}

async function main() {
  const secret = process.env.TICKERZ_COSIGNER_KEY;
  if (!secret) throw new Error("TICKERZ_COSIGNER_KEY is not set");
  const rpc = process.env.SOLANA_RPC_URL;
  for (const d of ["cosigns", "disputes"]) mkdirSync(path.join(out, d), { recursive: true });
  for (const { t, url } of candidates(new Date())) {
    const r = await fetch(url, { headers: { "user-agent": "tickerz-open/cosign" } });
    if (r.status !== 200) { if (!url.includes("period=")) console.log(`${t}: no report (${r.status})`); continue; }
    const env = (await r.json()) as ReportEnvelope;
    if (env.report.status !== "provisional") { console.log(`${t} ${env.report.period}: ${env.report.status}, nothing to co-sign`); continue; }
    const done = ["cosigns", "disputes"].some((d) => existsSync(path.join(out, d, `${env.hash}.json`)));
    if (done) { console.log(`${t} ${env.report.period}: already handled`); continue; }
    const res = await recountAndCosign(env, secret, { solanaRpc: rpc });
    if (res.status === "cosigned") {
      writeFileSync(path.join(out, "cosigns", `${env.hash}.json`), JSON.stringify({ report_hash: env.hash, ticker: t, period: env.report.period, value: env.report.value, ...res.cosignature, how: res.how, at: new Date().toISOString() }, null, 2) + "\n");
      console.log(`${t} ${env.report.period}: co-signed ${env.report.value}`);
    } else if (res.status === "dispute" && res.recounted == null) {
      // A read that could not finish (Nov 6 2026: the 400,000 row page cap, paging back to a day over a week old) is not
      // a different count. It writes nothing, so the report stays provisional and a later run can try again; a dispute
      // is only ever a recount that finished and got another number.
      console.log(`${t} ${env.report.period}: could not recount (${res.error ?? "no count"}), left for a later run`);
    } else if (res.status === "dispute") {
      writeFileSync(path.join(out, "disputes", `${env.hash}.json`), JSON.stringify({ report_hash: env.hash, ticker: t, period: env.report.period, signed: res.signed, recounted: res.recounted, how: res.how, error: res.error ?? null, at: new Date().toISOString() }, null, 2) + "\n");
      console.log(`${t} ${env.report.period}: DISPUTE signed ${res.signed}, recounted ${res.recounted}`);
    } else {
      console.log(`${t} ${env.report.period}: rejected (${res.reason})`);
    }
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
