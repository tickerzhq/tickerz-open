/**
 * Read what Tickerz printed, from its public API (no key, CORS open): https://tickerz.com/api/v1/indices/{ticker}.
 * The scripts use it to set a recount beside the published number.
 */
import { USER_AGENT } from "./mints";

export const API_BASE = "https://tickerz.com/api/v1";

export type PrintedDay = { period: string; value: number | null; provisional: boolean };

export type PrintedIndex = {
  ticker: string;
  days: PrintedDay[];
  /** The second line beside an index (graduations beside MINTS): its newest and newest complete reading. */
  companion: { ticker: string; latest: number | null; latest_complete: number | null } | null;
};

/** One index's series as published. */
export async function fetchPrinted(ticker: string, base = API_BASE): Promise<PrintedIndex> {
  const res = await fetch(`${base}/indices/${encodeURIComponent(ticker.toLowerCase())}`, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`index_http_${res.status}`);
  const body = (await res.json()) as {
    ticker?: string;
    days?: { period?: string; value?: number | null; provisional?: boolean }[];
    companion?: { ticker?: string; latest?: number | null; latest_complete?: number | null } | null;
  };
  const days = (body.days ?? [])
    .filter((d): d is { period: string; value?: number | null; provisional?: boolean } => typeof d.period === "string")
    .map((d) => ({ period: d.period, value: typeof d.value === "number" ? d.value : null, provisional: d.provisional === true }));
  const c = body.companion;
  return {
    ticker: String(body.ticker ?? ticker).toUpperCase(),
    days,
    companion: c && typeof c.ticker === "string"
      ? { ticker: c.ticker, latest: typeof c.latest === "number" ? c.latest : null, latest_complete: typeof c.latest_complete === "number" ? c.latest_complete : null }
      : null,
  };
}

/** The published value for one period, or null. */
export function printedOn(index: PrintedIndex, period: string): number | null {
  return index.days.find((d) => d.period === period)?.value ?? null;
}
