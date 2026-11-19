/*
 * Check one signed Tickerz number end to end, with no key: the report's hash, the publisher's signature, this repo's
 * co-signature, and a fresh count of the period from the public source.
 *
 *   npm run recount -- JOBS                 the newest signed $JOBS report
 *   npm run recount -- MINTS 2026-11-17     one period (a UTC day for $MINTS, the first of the month for $JOBS)
 *
 * Tickers with signed reports: JOBS, UNEMP, CPI, CORECPI, LAYOFFS, MINTS. The checks and the count are the code the
 * daily co-signing job runs (oracle/src/lib/oracle/report.ts and cosign.ts); this script only writes nothing and signs
 * nothing. $MINTS reads the public Solana RPC unless SOLANA_RPC_URL is set, and a day back takes a minute or two.
 * Exits 0 when everything checks and the count matches, 1 when anything does not.
 */
import { recount } from "../src/lib/oracle/cosign";
import { SOLANA_PUBLISHER, verifyEnvelope, type ReportEnvelope } from "../src/lib/oracle/report";

/** This repo's co-signing key (cosign.yml). Also listed at https://tickerz.com/.well-known/tickerz-signer.json. */
const COSIGNER = "7TYVLzDyAGspQ2FSH1H4D8kzrocuQqSRMM48frr3EjZ3";
const SIGNED = ["JOBS", "UNEMP", "CPI", "CORECPI", "LAYOFFS", "MINTS"];
const base = process.env.TICKERZ_BASE ?? "https://tickerz.com";

const [tickerArg, period] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const ticker = (tickerArg ?? "").toUpperCase().replace(/^\$/, "");
if (!SIGNED.includes(ticker) || (period != null && !/^\d{4}-\d{2}-\d{2}$/.test(period))) {
  console.error(`Usage: npm run recount -- TICKER [YYYY-MM-DD]   (TICKER is one of ${SIGNED.join(", ")})`);
  process.exit(2);
}

const short = (s: string) => `${s.slice(0, 8)}...${s.slice(-4)}`;
const show = (v: string, decimals: number) => (Number(v) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: decimals });

(async () => {
  const url = `${base}/api/indices/${ticker.toLowerCase()}/report${period ? `?period=${period}` : ""}`;
  const res = await fetch(url, { headers: { "user-agent": "tickerz-open/recount" }, signal: AbortSignal.timeout(20_000) });
  if (res.status !== 200) throw new Error(`${url} answered ${res.status}`);
  const env = (await res.json()) as ReportEnvelope;
  const r = env.report;
  console.log(`$${r.ticker} ${r.period}, ${r.status}: ${show(r.value, r.decimals)} ${r.unit}`);
  console.log(`  report    ${url}`);

  const v = verifyEnvelope(env, { publisher: SOLANA_PUBLISHER, cosigners: [COSIGNER] });
  const sigOk = v.ok;
  console.log(`  hash      ${short(env.hash)}  ${v.reason === "hash_mismatch" ? "DOES NOT match the report" : "matches the report"}`);
  console.log(`  signed    ${short(SOLANA_PUBLISHER)}  ${sigOk ? "publisher signature valid" : `FAILED (${v.reason})`}`);
  const cosigned = v.cosigned.includes(COSIGNER);
  console.log(`  cosigned  ${short(COSIGNER)}  ${cosigned ? "this repo's co-signature valid" : r.status === "provisional" ? "not yet (the daily recount has not run on it)" : "no valid co-signature"}`);

  const rpc = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  console.log(`  counting  ${r.period} again from the source...`);
  const c = await recount(r, { solanaRpc: rpc });
  const match = c.value != null && c.value === r.value;
  const got = c.value == null ? `no count (${c.error ?? "unknown"})` : show(c.value, r.decimals);
  console.log(`  recount   ${got} from ${c.how}`);
  console.log(match ? `\nMatch: the recount equals the signed value.` : `\nNO MATCH: signed ${show(r.value, r.decimals)}, recounted ${got}.`);
  process.exit(sigOk && match ? 0 : 1);
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
