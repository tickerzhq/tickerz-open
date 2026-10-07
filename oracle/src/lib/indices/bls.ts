/**
 * Monthly indexes from the Bureau of Labor Statistics public API v1.
 *
 * One POST carries every series (four today). Unregistered use is capped at 25 queries a day per IP, so this
 * client never makes more than 6. Only the release cron (/api/cron/bls) spends one: 12:35, 13:35 and 14:35 UTC on
 * weekdays (vercel.json). The Bureau publishes at 8:30 ET, which is 12:30 UTC in summer time and 13:30 UTC in
 * winter time, so one slot lands five minutes after the release in either season and the next is the retry
 * (blsSchedule.ts holds the release dates, and a test checks each against these slots). The hourly indices cron
 * never reads the Bureau.
 *
 * A month is keyed by the first of that month, YYYY-MM-01. The first 24 months loaded are the Bureau's figures
 * on the day of the load, not first prints: they are stored with raw BLS_BACKFILL_RAW and left out of the daily
 * proof. After that, the newest month of a read, when it is newer than anything stored, is the first print the
 * next proof holds. A later Bureau figure for that month is a revision beside it.
 */
import type { IndexDef } from "./registry";
import type { Observation, Poster } from "./fetchers";

export const BLS_URL = "https://api.bls.gov/publicAPI/v1/timeseries/data/";
export const BLS_USER_AGENT = "tickerz-agent/indices";
/** Hard stop. The public API allows 25 a day per IP. Three scheduled reads a day leave three for a forced read. */
export const BLS_QUERY_CAP = 6;
/** Months of history loaded on the first read, and kept on every read after. */
export const BLS_HISTORY_MONTHS = 24;
/**
 * Stored in index_levels.raw. No other index uses it: a difference index stores a real reading, and a normal
 * row stores null. The daily proof skips it, so a month loaded as history cannot become a first print.
 */
export const BLS_BACKFILL_RAW = -1;
/** What the page, the API and the settlement file say on a month loaded as history. No comma: it is a CSV cell too. */
export const BLS_NOT_FIRST_PRINT = "Loaded later: the Bureau's current figure and not the number as first published";

export type BlsTransform = "change_x1000" | "level" | "pct_mom_1dp";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 2026" from "2026-09-01". */
export function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1] ?? period} ${y}`;
}

/** The first of the month `n` months from `period` (YYYY-MM-01). */
export function addMonths(period: string, n: number): string {
  const [y, m] = period.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** The first of the UTC month containing `now`. */
export function monthStart(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** Whole months from `earlier` to `later`, both YYYY-MM-01. Null when either key is not a month. */
export function monthsBetween(later: string, earlier: string): number | null {
  if (!/^\d{4}-\d{2}-01$/.test(later) || !/^\d{4}-\d{2}-01$/.test(earlier)) return null;
  const [y1, m1] = later.split("-").map(Number);
  const [y0, m0] = earlier.split("-").map(Number);
  return (y1 - y0) * 12 + (m1 - m0);
}

/** Half away from zero, one decimal: 0.25 is 0.3 and -0.25 is -0.3. For a number that is already near one decimal. */
export function round1(n: number): number {
  const r = Math.round(Math.abs(n) * 10) / 10;
  const signed = n < 0 ? -r : r;
  return Object.is(signed, -0) ? 0 : signed;
}

/** Latest minus first print, in the index's precision. */
export function revisionChange(latest: number, first: number, format: IndexDef["format"]): number {
  const d = latest - first;
  if (format === "percent") return round1(d);
  if (format === "usd") return Math.round(d * 100) / 100;
  return Math.round(d);
}

export type MonthCapture = {
  period: string;
  latest: number;
  first: number | null;
  /** Latest minus the first print. Null when the month is backfill and has no first print. */
  change: number | null;
  note: string | null;
};

/** One row per stored month, newest first: the first print, the latest level, and the change between them. */
export function monthCaptures(
  periods: readonly { period: string; value: number }[],
  prints: ReadonlyMap<string, { value: number }> | null,
  backfill: ReadonlySet<string>,
  format: IndexDef["format"],
): MonthCapture[] {
  return [...periods]
    .filter((p) => Number.isFinite(p.value))
    .sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0))
    .map((p) => {
      const noted = backfill.has(p.period);
      const fp = noted ? null : prints?.get(p.period) ?? null;
      const first = fp && Number.isFinite(fp.value) ? fp.value : null;
      return {
        period: p.period,
        latest: p.value,
        first,
        change: first == null ? null : revisionChange(p.value, first, format),
        note: noted ? BLS_NOT_FIRST_PRINT : null,
      };
    });
}

/**
 * Whether one more BLS query may go out today. The release cron and a forced read ask; nothing else does, so the
 * schedule in vercel.json is the clock and this is only the cap.
 */
export function blsDue(queriesToday: number): boolean {
  return Number.isFinite(queriesToday) && queriesToday >= 0 && queriesToday < BLS_QUERY_CAP;
}

/**
 * The budget row after this instant. `stored.queries` counts only when `stored.day` is today.
 * `spend` is false at the cap. A spend returns the count to write before the request goes out.
 */
export function nextBlsBudget(
  stored: { day: string; queries: number },
  now: number,
): { spend: boolean; day: string; queries: number } {
  const day = new Date(now).toISOString().slice(0, 10);
  const queries = stored.day === day && Number.isFinite(stored.queries) && stored.queries >= 0 ? stored.queries : 0;
  if (!blsDue(queries)) return { spend: false, day, queries };
  return { spend: true, day, queries: queries + 1 };
}

export type BlsPoint = { period: string; value: number };

/** "2026" + "M09" to "2026-09-01". M13 (the annual average) and anything else are null. */
export function blsPeriodKey(year: string, period: string): string | null {
  if (!/^\d{4}$/.test(year) || !/^M(0[1-9]|1[0-2])$/.test(period)) return null;
  return `${year}-${period.slice(1)}-01`;
}

function blsNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s === "" || s === "-") return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** The API body to one series id and its monthly points, oldest last or first. Throws on a failed request. */
export function parseBlsBody(text: string): Map<string, BlsPoint[]> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("bls_bad_json");
  }
  const root = body as { status?: unknown; Results?: { series?: unknown } };
  if (root?.status !== "REQUEST_SUCCEEDED") throw new Error(`bls_${String(root?.status ?? "no_status")}`);
  const series = root.Results?.series;
  if (!Array.isArray(series)) throw new Error("bls_no_series");
  const out = new Map<string, BlsPoint[]>();
  for (const s of series as { seriesID?: unknown; data?: unknown }[]) {
    const id = String(s?.seriesID ?? "");
    if (!id || !Array.isArray(s.data)) continue;
    const pts: BlsPoint[] = [];
    for (const row of s.data as { year?: unknown; period?: unknown; value?: unknown }[]) {
      const period = blsPeriodKey(String(row?.year ?? ""), String(row?.period ?? ""));
      const value = blsNumber(row?.value);
      if (!period || value == null) continue;
      pts.push({ period, value });
    }
    out.set(id, pts);
  }
  return out;
}

/**
 * The percent change from `prev` to `value`, one decimal, half away from zero. The Bureau publishes these indexes
 * to three decimals, so the change is worked in whole thousandths: a change that is exactly a half (320.000 to
 * 320.800 is 0.25 percent) rounds the same way every time, where floating point reads it as 0.2499 and rounds down.
 * Null when the previous index is zero or less.
 */
export function pctChange1dp(value: number, prev: number): number | null {
  const v = Math.round(value * 1000);
  const p = Math.round(prev * 1000);
  if (!Number.isFinite(v) || !Number.isFinite(p) || p <= 0) return null;
  // tenths of a percent = (v - p) * 1000 / p, rounded half away from zero in integers.
  const tenths = Math.floor((2 * Math.abs(v - p) * 1000 + p) / (2 * p));
  const signed = v < p ? -tenths : tenths;
  return signed === 0 ? 0 : signed / 10;
}

/**
 * The level the index stores. `change_x1000` is the month's difference in the published level (thousands of
 * jobs) times 1,000, rounded to a job. `level` is the published figure at one decimal. `pct_mom_1dp` is the
 * percent change from the previous month's published index, half away from zero, one decimal (pctChange1dp). A
 * month whose previous calendar month is missing is left out, so a gap is never read as one change.
 * Points at or after `before` (the current month) and before `keepFrom` are dropped after the transform, so
 * the extra month fetched as the base of the first change is not itself a row.
 */
export function transformBls(points: readonly BlsPoint[], transform: BlsTransform, keepFrom: string, before: string): Observation[] {
  const by = new Map<string, number>();
  for (const p of points) by.set(p.period, p.value);
  const periods = [...by.keys()].sort();
  const out: Observation[] = [];
  for (const period of periods) {
    if (period < keepFrom || period >= before) continue;
    const value = by.get(period)!;
    if (transform === "level") {
      out.push({ period, value: round1(value) });
      continue;
    }
    const prev = by.get(addMonths(period, -1));
    if (prev == null) continue;
    if (transform === "change_x1000") {
      out.push({ period, value: Math.round((value - prev) * 1000) });
      continue;
    }
    const pct = pctChange1dp(value, prev);
    if (pct == null) continue;
    out.push({ period, value: pct });
  }
  return out;
}

/** Years to request so the transform has one month before the 24 that are kept. */
export function blsYearSpan(now: number): { startyear: string; endyear: string; keepFrom: string; before: string } {
  const before = monthStart(now);
  const keepFrom = addMonths(before, -BLS_HISTORY_MONTHS);
  const fetchFrom = addMonths(keepFrom, -1);
  return { startyear: fetchFrom.slice(0, 4), endyear: String(new Date(now).getUTCFullYear()), keepFrom, before };
}

export function blsRequest(series: readonly string[], startyear: string, endyear: string): { url: string; body: string; headers: Record<string, string> } {
  return {
    url: BLS_URL,
    body: JSON.stringify({ seriesid: [...series], startyear, endyear }),
    headers: { "content-type": "application/json", "user-agent": BLS_USER_AGENT },
  };
}

/** One POST for every BLS index in `defs`. The caller has already checked the query budget. */
export async function readBlsBatch(
  defs: readonly Pick<IndexDef, "ticker" | "fetch">[],
  ctx: { now: number; post: Poster },
): Promise<Map<string, Observation[]>> {
  const span = blsYearSpan(ctx.now);
  const series: string[] = [];
  for (const d of defs) {
    if (d.fetch.kind !== "bls") continue;
    if (!series.includes(d.fetch.series)) series.push(d.fetch.series);
  }
  const req = blsRequest(series, span.startyear, span.endyear);
  const res = await ctx.post(req.url, req.body, { headers: req.headers, timeoutMs: 20_000 });
  if (res.status !== 200) throw new Error(`bls_http_${res.status}`);
  const parsed = parseBlsBody(res.text);
  const out = new Map<string, Observation[]>();
  for (const d of defs) {
    if (d.fetch.kind !== "bls") continue;
    const pts = parsed.get(d.fetch.series);
    if (!pts) throw new Error(`bls_series_missing:${d.fetch.series}`);
    out.set(d.ticker, transformBls(pts, d.fetch.transform, span.keepFrom, span.before));
  }
  return out;
}

/** A reader that answered within this many days was watching: nothing it missed can have been revised since. */
export const BLS_WATCH_GAP_DAYS = 7;

/**
 * Which of `obs` are history, not first prints. An empty record: all of them (the 24 month load). A month already
 * stored keeps the mark it was stored with. A month older than the newest on file is history, not a release we
 * watched. A month newer than that is a first print when the reader was watching (`lastReadAt` within
 * BLS_WATCH_GAP_DAYS of `now`): releases of one series are weeks apart, so every new month arrived in one release,
 * as when the Bureau publishes two months together after a shutdown. When the reader was away longer, all new months are history: the reader cannot prove which release it missed.
 */
export function tagBlsVintage(
  existing: readonly { period: string; raw: number | null }[],
  obs: readonly Observation[],
  watch: { lastReadAt: string | null; now: number } = { lastReadAt: null, now: 0 },
): Observation[] {
  if (!existing.length) return obs.map((o) => ({ ...o, backfill: true }));
  let newest = existing[0].period;
  const rawOf = new Map<string, number | null>();
  for (const r of existing) {
    rawOf.set(r.period, r.raw);
    if (r.period > newest) newest = r.period;
  }
  const last = watch.lastReadAt ? Date.parse(watch.lastReadAt) : NaN;
  const watching = Number.isFinite(last) && watch.now >= last && watch.now - last <= BLS_WATCH_GAP_DAYS * 864e5;
  return obs.map((o) => {
    if (rawOf.has(o.period)) return { ...o, backfill: rawOf.get(o.period) === BLS_BACKFILL_RAW };
    return { ...o, backfill: !(o.period > newest && watching) };
  });
}
