/**
 * Recounts from the public source, one period at a time, the same way the live readers count. Used three ways:
 *   - the print path reads each configured provider with these, so two providers can agree (agree.ts);
 *   - the public recount job (scripts/oracle/cosign.ts, run in the public tickerz-open repo) counts again and
 *     co-signs only when it gets the signed value;
 *   - anyone can run them to check a print.
 * Every read keeps the raw response bytes, so the snapshot hash in a report can be rebuilt.
 */
import { createHash } from "node:crypto";
import { pctChange1dp } from "../indices/bls";
import { SIGS_PAGE, emptyTally, parseDolClaims, tallySigs, type SigInfo } from "../indices/fetchers";
import { providerTurn } from "../chainRpc";

export type RawRead = { value: number | null; bytes: Buffer; rows: number; error?: string };
export type Fetcher = typeof fetch;

export const snapshotHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Tries per page before a read gives up: a refusal for speed or a dropped page waits 2, 4, 6, 8 s and asks again. */
export const READ_ATTEMPTS = 5;

/**
 * Successful transactions signed by a Solana account in one UTC day (the $MINTS rule: err null, finalized, counted on
 * the UTC day of block time). Pages newest first from `before` (or the chain's newest) until it passes the day's
 * start. The snapshot is every page's raw JSON, joined by newlines, in the order read.
 */
export async function countSolanaDay(
  rpcUrl: string, account: string, day: string,
  opts: { before?: string; fetchImpl?: Fetcher; delayMs?: number; retryMs?: number; maxPages?: number; userAgent?: string; headers?: Record<string, string> } = {},
): Promise<RawRead> {
  const f = opts.fetchImpl ?? fetch;
  const dayStart = Date.parse(`${day}T00:00:00Z`) / 1000;
  const dayEnd = dayStart + 86_400;
  const tally = emptyTally();
  const raw: Buffer[] = [];
  let before = opts.before ?? null;
  let rows = 0;
  for (let page = 0; page < (opts.maxPages ?? 400); page++) {
    if (page > 0) await sleep(opts.delayMs ?? 250);
    const cfg: Record<string, unknown> = { limit: SIGS_PAGE, commitment: "finalized" };
    if (before) cfg.before = before;
    const payload = { jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [account, cfg] };
    let text = "";
    let failure: string | null = null;
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep((opts.retryMs ?? 2_000) * attempt);
      // Alchemy's compute units and Helius's calls a second (chainRpc.ts): unpaced, a page every 120 ms is 320 CU a
      // second on Alchemy, over its free plan's 300, and the Oct 7 15:10 read of $MINTS failed there.
      await providerTurn(rpcUrl, payload);
      try {
        const r = await f(rpcUrl, {
          method: "POST", headers: { "content-type": "application/json", "user-agent": opts.userAgent ?? "tickerz-agent/oracle", ...opts.headers },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30_000),
        });
        text = await r.text();
        if (r.status === 429 || r.status >= 500) { failure = `http_${r.status}`; continue; }
        if (r.status !== 200) return { value: null, bytes: Buffer.concat(raw), rows, error: `http_${r.status}:${text.slice(0, 60)}` };
        failure = null;
        break;
      } catch (e) {
        // A timeout or a dropped connection on one page: that page again, never the whole day.
        failure = `fetch:${(e instanceof Error ? e.name : "failed").slice(0, 30)}`;
      }
    }
    if (failure) return { value: null, bytes: Buffer.concat(raw), rows, error: `${failure} after ${READ_ATTEMPTS} tries, page ${page + 1}` };
    raw.push(Buffer.from(text + "\n", "utf8"));
    let j: { result?: SigInfo[]; error?: { message?: string } };
    try { j = JSON.parse(text); } catch { return { value: null, bytes: Buffer.concat(raw), rows, error: `not_json, page ${page + 1}` }; }
    if (!Array.isArray(j.result)) return { value: null, bytes: Buffer.concat(raw), rows, error: `rpc:${String(j.error?.message ?? "no_result").slice(0, 80)}` };
    const pg = j.result;
    rows += pg.length;
    // Signatures newer than the day are passed over; tallySigs stops at the first one older than its start.
    const inOrBefore = pg.filter((s) => s.blockTime == null || s.blockTime < dayEnd);
    const { reachedFrom } = tallySigs(inOrBefore, dayStart, tally);
    if (pg.length) before = pg[pg.length - 1].signature;
    if (reachedFrom || pg.length < SIGS_PAGE) {
      return { value: tally.days.get(day) ?? 0, bytes: Buffer.concat(raw), rows };
    }
  }
  return { value: null, bytes: Buffer.concat(raw), rows, error: "page_cap" };
}

/** One BLS series, level by month, from the public API v1 (no key): { "2026-09": 159540, ... }. */
export async function readBlsSeries(series: string, opts: { fetchImpl?: Fetcher; startyear?: number; endyear?: number } = {}): Promise<{ levels: Record<string, number>; bytes: Buffer; error?: string }> {
  const f = opts.fetchImpl ?? fetch;
  const end = opts.endyear ?? new Date().getUTCFullYear();
  const r = await f("https://api.bls.gov/publicAPI/v1/timeseries/data/", {
    method: "POST", headers: { "content-type": "application/json", "user-agent": "tickerz-agent/oracle" },
    body: JSON.stringify({ seriesid: [series], startyear: String(opts.startyear ?? end - 1), endyear: String(end) }),
    signal: AbortSignal.timeout(30_000),
  });
  const bytes = Buffer.from(await r.text(), "utf8");
  if (r.status !== 200) return { levels: {}, bytes, error: `http_${r.status}` };
  const j = JSON.parse(bytes.toString("utf8")) as { status?: string; Results?: { series?: { data?: { year: string; period: string; value: string }[] }[] } };
  const levels: Record<string, number> = {};
  for (const d of j.Results?.series?.[0]?.data ?? []) {
    if (!/^M(0[1-9]|1[0-2])$/.test(d.period)) continue;
    const v = Number(d.value);
    if (Number.isFinite(v)) levels[`${d.year}-${d.period.slice(1)}`] = v;
  }
  return { levels, bytes, error: j.status === "REQUEST_SUCCEEDED" ? undefined : `bls_${j.status}` };
}

/** Several BLS series in one POST (one query of the daily 25), level by month for each. */
export async function readBlsMany(series: string[], opts: { fetchImpl?: Fetcher; startyear: number; endyear: number }): Promise<{ bySeries: Record<string, Record<string, number>>; bytes: Buffer; error?: string }> {
  const f = opts.fetchImpl ?? fetch;
  const r = await f("https://api.bls.gov/publicAPI/v1/timeseries/data/", {
    method: "POST", headers: { "content-type": "application/json", "user-agent": "tickerz-agent/oracle" },
    body: JSON.stringify({ seriesid: series, startyear: String(opts.startyear), endyear: String(opts.endyear) }),
    signal: AbortSignal.timeout(30_000),
  });
  const bytes = Buffer.from(await r.text(), "utf8");
  if (r.status !== 200) return { bySeries: {}, bytes, error: `http_${r.status}` };
  const j = JSON.parse(bytes.toString("utf8")) as { status?: string; Results?: { series?: { seriesID: string; data?: { year: string; period: string; value: string }[] }[] } };
  const bySeries: Record<string, Record<string, number>> = {};
  for (const s of j.Results?.series ?? []) {
    const levels: Record<string, number> = {};
    for (const d of s.data ?? []) {
      const v = Number(d.value);
      if (/^M(0[1-9]|1[0-2])$/.test(d.period) && Number.isFinite(v)) levels[`${d.year}-${d.period.slice(1)}`] = v;
    }
    bySeries[s.seriesID] = levels;
  }
  return { bySeries, bytes, error: j.status === "REQUEST_SUCCEEDED" ? undefined : `bls_${j.status}` };
}

/**
 * The Bureau's own flat files (the LABSTAT database at download.bls.gov), a second path to the same official figures
 * with no daily query cap. Not every series has a small file: the household survey's ($UNEMP) is one file of several
 * hundred megabytes, so it is read through the API only.
 */
export const BLS_FLAT_FILE: Record<string, string> = {
  CES0000000001: "https://download.bls.gov/pub/time.series/ce/ce.data.00a.TotalNonfarm.Employment",
  CUSR0000SA0: "https://download.bls.gov/pub/time.series/cu/cu.data.1.AllItems",
  // Core CPI is not in cu.data.2.Summaries (checked Oct 7 2026: every month read null there); it is in the special
  // aggregates file, 3.6 MB.
  CUSR0000SA0L1E: "https://download.bls.gov/pub/time.series/cu/cu.data.20.USCommoditiesServicesSpecial",
};

/** One series from its flat file: tab separated, padded; "series_id year period value footnotes". */
export async function readBlsFlatFile(series: string, opts: { fetchImpl?: Fetcher; fromYear?: number } = {}): Promise<{ levels: Record<string, number>; bytes: Buffer; error?: string }> {
  const url = BLS_FLAT_FILE[series];
  if (!url) return { levels: {}, bytes: Buffer.alloc(0), error: "no_flat_file" };
  const f = opts.fetchImpl ?? fetch;
  // The Bureau asks automated readers to name themselves with a contact.
  const r = await f(url, { headers: { "user-agent": "tickerz-agent/oracle (desk@tickerz.com)" }, signal: AbortSignal.timeout(60_000) });
  const bytes = Buffer.from(await r.arrayBuffer());
  if (r.status !== 200) return { levels: {}, bytes, error: `http_${r.status}` };
  return { levels: parseBlsFlat(bytes.toString("utf8"), series, opts.fromYear ?? 0), bytes };
}

export function parseBlsFlat(text: string, series: string, fromYear = 0): Record<string, number> {
  const levels: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) {
    const [id, year, period, value] = line.split("\t").map((x) => x?.trim());
    if (id !== series || !/^M(0[1-9]|1[0-2])$/.test(period ?? "") || Number(year) < fromYear) continue;
    const v = Number(value);
    if (value && Number.isFinite(v)) levels[`${year}-${period.slice(1)}`] = v;
  }
  return levels;
}

/**
 * The same series from FRED's keyless CSV (the St. Louis Fed republishes the BLS figures), as a cross-check reader.
 * FRED's id for payrolls is PAYEMS, unemployment UNRATE, CPI CPIAUCSL, core CPI CPILFESL.
 */
export const FRED_ID: Record<string, string> = { CES0000000001: "PAYEMS", LNS14000000: "UNRATE", CUSR0000SA0: "CPIAUCSL", CUSR0000SA0L1E: "CPILFESL" };

export async function readFredSeries(id: string, opts: { fetchImpl?: Fetcher; from?: string } = {}): Promise<{ levels: Record<string, number>; bytes: Buffer; error?: string }> {
  const f = opts.fetchImpl ?? fetch;
  const r = await f(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${opts.from ?? "2024-01-01"}`, {
    headers: { "user-agent": "tickerz-agent/oracle" }, signal: AbortSignal.timeout(30_000),
  });
  const bytes = Buffer.from(await r.text(), "utf8");
  if (r.status !== 200) return { levels: {}, bytes, error: `http_${r.status}` };
  const levels: Record<string, number> = {};
  for (const line of bytes.toString("utf8").split(/\r?\n/).slice(1)) {
    const [date, v] = line.split(",");
    if (!/^\d{4}-\d{2}-01$/.test(date ?? "")) continue;
    const n = Number(v);
    if (v !== "." && Number.isFinite(n)) levels[date.slice(0, 7)] = n;
  }
  return { levels, bytes };
}

/**
 * A BLS index's value for a month from a level series, by the registry's transform. Null when a month it needs is
 * missing. change_x1000: (level(m) - level(m-1)) * 1000, whole jobs. level: the figure. pct_mom_1dp: the percent change
 * at one decimal, half away from zero, from the index (pctChange1dp in bls.ts, the live reader's own rounding).
 */
export function blsValue(levels: Record<string, number>, month: string, transform: "change_x1000" | "level" | "pct_mom_1dp"): number | null {
  const [y, m] = month.split("-").map(Number);
  const prev = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}`;
  const a = levels[month];
  if (a == null) return null;
  if (transform === "level") return a;
  const b = levels[prev];
  if (b == null) return null;
  if (transform === "change_x1000") return Math.round((a - b) * 1000);
  return pctChange1dp(a, b);
}

/** The Labor Department's weekly claims file, every state row since 2015 (about 13 MB). */
export const DOL_CLAIMS_FILE = "https://oui.doleta.gov/unemploy/csv/ar539.csv";

/**
 * $LAYOFFS from the Labor Department's own file: initial claims (c3) summed over every jurisdiction, by the week's
 * Saturday, with parseDolClaims (the live reader's own parser, which drops a week missing a state). `weeks` is empty
 * and `error` set when the file cannot be read.
 */
export async function readDolClaims(opts: { fetchImpl?: Fetcher; since?: string } = {}): Promise<{ weeks: Map<string, number>; bytes: Buffer; error?: string }> {
  try {
    const r = await (opts.fetchImpl ?? fetch)(DOL_CLAIMS_FILE, { headers: { "user-agent": "tickerz-agent/oracle (desk@tickerz.com)" }, signal: AbortSignal.timeout(60_000) });
    if (r.status !== 200) return { weeks: new Map(), bytes: Buffer.alloc(0), error: `http_${r.status}` };
    const bytes = Buffer.from(await r.arrayBuffer());
    return { weeks: parseDolClaims(bytes.toString("utf8"), opts.since ?? "2000-01-01"), bytes };
  } catch (e) {
    return { weeks: new Map(), bytes: Buffer.alloc(0), error: String(e).slice(0, 80) };
  }
}
