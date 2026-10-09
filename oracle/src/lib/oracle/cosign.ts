/**
 * The independent recount. It runs outside Tickerz's servers (a GitHub Actions job in the public tickerz-open repo,
 * with its own key in that repo's secrets: TICKERZ_COSIGNER_KEY), fetches each new signed report, counts the period
 * again from the public source with the code in recount.ts, and co-signs the report hash only when it gets exactly the
 * signed value. A disagreement is written down as a dispute, which keeps the print provisional.
 *
 * The co-signer's public address goes in ORACLE_COSIGNERS on the Tickerz side and in /.well-known/tickerz-signer.json.
 */
import { indexByTicker } from "../indices/registry";
import { scaled } from "./canonical";
import { blsValue, BLS_FLAT_FILE, countSolanaDay, FRED_ID, readBlsFlatFile, readBlsSeries, readDolClaims, readFredSeries } from "./recount";
import { cosign, verifyEnvelope, type ReportEnvelope, type Signed } from "./report";

export type RecountResult = { value: string | null; how: string; error?: string };

/** Count a report's period again from its public source. Supports the Solana signature counts, the BLS series and the Labor Department claims file. */
export async function recount(r: ReportEnvelope["report"], opts: { solanaRpc?: string; solanaHeaders?: Record<string, string>; fetchImpl?: typeof fetch } = {}): Promise<RecountResult> {
  const def = indexByTicker(r.ticker);
  if (!def) return { value: null, how: "unknown_ticker", error: "unknown_ticker" };
  const f = def.fetch;
  if (f.kind === "solana_sigs") {
    if (!opts.solanaRpc) return { value: null, how: "solana", error: "no_rpc" };
    const read = await countSolanaDay(opts.solanaRpc, f.account, r.period, { fetchImpl: opts.fetchImpl, headers: opts.solanaHeaders });
    return { value: read.value == null ? null : scaled(read.value, r.decimals), how: `getSignaturesForAddress ${f.account}, ${read.rows} rows`, error: read.error };
  }
  if (f.kind === "bls") {
    const month = r.period.slice(0, 7);
    const year = Number(month.slice(0, 4));
    const bls = await readBlsSeries(f.series, { fetchImpl: opts.fetchImpl, startyear: year - 1, endyear: year });
    let v = blsValue(bls.levels, month, f.transform);
    let how = `BLS API v1 ${f.series}`;
    if (v == null && BLS_FLAT_FILE[f.series]) {
      // The keyless BLS API allows 25 queries a day per address; the Bureau's flat file has no cap.
      const flat = await readBlsFlatFile(f.series, { fetchImpl: opts.fetchImpl, fromYear: year - 1 });
      v = blsValue(flat.levels, month, f.transform);
      how = `BLS flat file ${f.series}`;
    }
    if (v == null && FRED_ID[f.series]) {
      // FRED republishes the same figures.
      const fred = await readFredSeries(FRED_ID[f.series], { fetchImpl: opts.fetchImpl, from: `${year - 1}-01-01` });
      v = blsValue(fred.levels, month, f.transform);
      how = `FRED ${FRED_ID[f.series]}`;
    }
    return { value: v == null ? null : scaled(v, r.decimals), how, error: v == null ? bls.error ?? "month_missing" : undefined };
  }
  if (f.kind === "dol_claims") {
    const since = new Date(Date.parse(`${r.period}T00:00:00Z`) - 70 * 864e5).toISOString().slice(0, 10);
    const dol = await readDolClaims({ fetchImpl: opts.fetchImpl, since });
    const v = dol.weeks.get(r.period);
    return { value: v == null ? null : scaled(v, r.decimals), how: "Labor Department ar539.csv, initial claims summed over the states", error: v == null ? dol.error ?? "week_missing" : undefined };
  }
  return { value: null, how: f.kind, error: "recount_not_supported" };
}

export type CosignOutcome = { status: "cosigned"; cosignature: Signed; how: string } | { status: "dispute"; recounted: string | null; signed: string; how: string; error?: string } | { status: "rejected"; reason: string };

/** Verify the envelope, recount, and co-sign only on an exact match. */
export async function recountAndCosign(env: ReportEnvelope, secret: string, opts: Parameters<typeof recount>[1] & { publisher?: string } = {}): Promise<CosignOutcome> {
  const v = verifyEnvelope(env, { publisher: opts.publisher });
  if (!v.ok) return { status: "rejected", reason: v.reason ?? "invalid" };
  const r = await recount(env.report, opts);
  if (r.value == null || r.value !== env.report.value) return { status: "dispute", recounted: r.value, signed: env.report.value, how: r.how, error: r.error };
  return { status: "cosigned", cosignature: cosign(env.hash, secret), how: r.how };
}
