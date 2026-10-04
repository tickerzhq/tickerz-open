/**
 * The 95% range printed beside $GIGS. $GIGS is an estimate from a one in sixteen sample (estimateGigs in machines.ts),
 * so every day carries the range the estimate came with. Tickerz stores it beside the closed day and serves it with
 * the newest complete day at https://tickerz.com/api/v1/indices/gigs (latest_complete.range).
 *
 * Pure parsing, plus one fetch helper for the public API. Stored values can arrive as numbers or as numeric strings
 * (Postgres numerics come back as text); anything that is not a finite number is no range at all, never a zero.
 */
import { USER_AGENT } from "./mints";

export type GigsRange = { low: number; high: number; level: 0.95 };

function finiteNumber(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A range from its two ends, or null when either end is missing or not a number. */
export function gigsRange(low: number | string | null | undefined, high: number | string | null | undefined): GigsRange | null {
  const lo = finiteNumber(low);
  const hi = finiteNumber(high);
  return lo == null || hi == null ? null : { low: lo, high: hi, level: 0.95 };
}

/** Ranges by UTC day from stored day rows. A row with no usable range is left out. */
export function gigsRangesFromRows(rows: { day: string; gigs_low: number | string | null; gigs_high: number | string | null }[]): Map<string, GigsRange> {
  const map = new Map<string, GigsRange>();
  for (const row of rows) {
    const range = gigsRange(row.gigs_low, row.gigs_high);
    if (range) map.set(String(row.day).slice(0, 10), range);
  }
  return map;
}

/** The newest complete $GIGS day as the public API serves it, with its range. Null fields when the API has none. */
export async function fetchLatestGigs(base = "https://tickerz.com/api/v1"): Promise<{ period: string | null; value: number | null; range: GigsRange | null }> {
  const res = await fetch(`${base}/indices/gigs`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`gigs_http_${res.status}`);
  const body = (await res.json()) as { latest_complete?: { period?: string; value?: number | null; range?: { low?: unknown; high?: unknown } | null } | null };
  const lc = body.latest_complete ?? null;
  const r = lc?.range ?? null;
  return {
    period: typeof lc?.period === "string" ? lc.period : null,
    value: typeof lc?.value === "number" ? lc.value : null,
    range: r ? gigsRange(r.low as number | string | null, r.high as number | string | null) : null,
  };
}
