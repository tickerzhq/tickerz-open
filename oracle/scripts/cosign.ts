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
const TICKERS = ["JOBS", "UNEMP", "CPI", "CORECPI", "MINTS"];

async function main() {
  const secret = process.env.TICKERZ_COSIGNER_KEY;
  if (!secret) throw new Error("TICKERZ_COSIGNER_KEY is not set");
  const rpc = process.env.SOLANA_RPC_URL;
  for (const d of ["cosigns", "disputes"]) mkdirSync(path.join(out, d), { recursive: true });
  for (const t of TICKERS) {
    const r = await fetch(`${base}/api/indices/${t.toLowerCase()}/report`, { headers: { "user-agent": "tickerz-open/cosign" } });
    if (r.status !== 200) { console.log(`${t}: no report (${r.status})`); continue; }
    const env = (await r.json()) as ReportEnvelope;
    if (env.report.status !== "provisional") { console.log(`${t} ${env.report.period}: ${env.report.status}, nothing to co-sign`); continue; }
    const done = ["cosigns", "disputes"].some((d) => existsSync(path.join(out, d, `${env.hash}.json`)));
    if (done) { console.log(`${t} ${env.report.period}: already handled`); continue; }
    const res = await recountAndCosign(env, secret, { solanaRpc: rpc });
    if (res.status === "cosigned") {
      writeFileSync(path.join(out, "cosigns", `${env.hash}.json`), JSON.stringify({ report_hash: env.hash, ticker: t, period: env.report.period, value: env.report.value, ...res.cosignature, how: res.how, at: new Date().toISOString() }, null, 2) + "\n");
      console.log(`${t} ${env.report.period}: co-signed ${env.report.value}`);
    } else if (res.status === "dispute") {
      writeFileSync(path.join(out, "disputes", `${env.hash}.json`), JSON.stringify({ report_hash: env.hash, ticker: t, period: env.report.period, signed: res.signed, recounted: res.recounted, how: res.how, error: res.error ?? null, at: new Date().toISOString() }, null, 2) + "\n");
      console.log(`${t} ${env.report.period}: DISPUTE signed ${res.signed}, recounted ${res.recounted}`);
    } else {
      console.log(`${t} ${env.report.period}: rejected (${res.reason})`);
    }
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
