/**
 * One reader per source kind. Each returns observations: one number per period. A day is UTC for Wikimedia,
 * DefiLlama and the live sources, and the city's own local date for Chicago and NYC data, as the cities publish it.
 * A week (the claims file) is keyed by the Saturday it ends on, as the Department of Labor reports it.
 *
 * The parsers are pure and exported for the tests (src/lib/__tests__/indices.test.ts). The network goes through
 * an injected getter, so the cron uses fetch and the local backfill script can use another transport.
 * Nothing here writes. Partial days are dropped here, never scored: a source's newest dates that are still filling
 * in (trailingPartial) and any date on or after today for a daily source.
 */
import type { IndexDef } from "./registry";
import { alchemyTurn, bodyCu, isAlchemy, logFallback, solanaRpcs, type Env } from "../chainRpc";

export type Observation = {
  /** UTC day, YYYY-MM-DD. For a weekly source, the Saturday the week ends on. */
  period: string;
  /** The level. Null for a difference index read for the first time (no earlier reading to subtract). */
  value: number | null;
  /** The reading behind a difference index. */
  raw?: number;
  /** A BLS month loaded as history: today's Bureau figure, not a first print. The seal skips it. */
  backfill?: boolean;
};

export type Getter = (url: string, headers?: Record<string, string>, opts?: { timeoutMs?: number }) => Promise<{ status: number; text: string }>;

/** Wikimedia asks every client for a User-Agent with a contact. */
export const USER_AGENT = "TickerzIndexBot/1.0 (https://tickerz.com; desk@tickerz.com)";

export const fetchGetter: Getter = async (url, headers = {}, opts = {}) => {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, ...headers }, cache: "no-store", signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
  return { status: res.status, text: await res.text() };
};

/** The claims file is about 13 MB; it gets most of the cron's 60 seconds. */
export const LARGE_FILE_TIMEOUT_MS = 45_000;

const DAY = 864e5;
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (period: string, n: number) => dayOf(Date.parse(`${period}T00:00:00Z`) + n * DAY);

class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

function json(res: { status: number; text: string }, what: string): unknown {
  if (res.status !== 200) throw new SourceError(`${what}_http_${res.status}`);
  try {
    return JSON.parse(res.text);
  } catch {
    throw new SourceError(`${what}_bad_json`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------------------------------------------

/** Wikimedia per-article daily pageviews: { items: [{ timestamp: "2026092200", views }] } to period and views. */
export function parseWikimedia(body: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const items = (body as { items?: { timestamp?: string; views?: number }[] })?.items ?? [];
  for (const it of items) {
    const ts = String(it.timestamp ?? "");
    const v = Number(it.views);
    if (!/^\d{10}$/.test(ts) || !Number.isFinite(v)) continue;
    out.set(`${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`, v);
  }
  return out;
}

/** Several articles added together, only on days every article has. */
export function sumArticles(series: Map<string, number>[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!series.length) return out;
  for (const [day, v] of series[0]) {
    let total = v;
    let all = true;
    for (const s of series.slice(1)) {
      const x = s.get(day);
      if (x == null) { all = false; break; }
      total += x;
    }
    if (all) out.set(day, total);
  }
  return out;
}

/** Socrata grouped counts: [{ d: "2026-09-13T00:00:00.000", n: "658" }]. */
export function parseSocrataCounts(body: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(body)) throw new SourceError("socrata_not_array");
  for (const r of body as { d?: string; n?: string | number }[]) {
    const d = String(r.d ?? "").slice(0, 10);
    const n = Number(r.n);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(n)) out.set(d, n);
  }
  return out;
}

/** One CSV line into fields. Quoted fields may hold commas and doubled quotes. */
export function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Hugging Face models list: the summed trendingScore of the list. The index is the top `limit`, so the list must hold
 * exactly `limit` models, each with a numeric score. A short list, a long one, or a missing score is a bad reading and
 * is refused, never summed as if the missing models scored zero.
 */
export function parseHfTrending(body: unknown, limit: number): number {
  if (!Array.isArray(body)) throw new SourceError("hf_not_array");
  if (body.length !== limit) throw new SourceError("hf_list_size");
  const scores = (body as { trendingScore?: unknown }[]).map((m) => m?.trendingScore);
  if (!scores.every((x): x is number => typeof x === "number" && Number.isFinite(x))) throw new SourceError("hf_bad_score");
  return scores.reduce((s, x) => s + x, 0);
}

/** DefiLlama per-protocol daily fees or volume: { totalDataChart: [[unixSeconds, dollars], ...] } to UTC day and dollars. */
export function parseDefillamaFees(body: unknown): Map<string, number> {
  const chart = (body as { totalDataChart?: unknown })?.totalDataChart;
  if (!Array.isArray(chart)) throw new SourceError("defillama_no_chart");
  const out = new Map<string, number>();
  for (const pt of chart) {
    if (!Array.isArray(pt)) continue;
    const ts = Number(pt[0]);
    // A null or non-numeric fee is a missing day, not a zero: Number(null) would read as $0 and pass as complete.
    const v = typeof pt[1] === "number" ? pt[1] : typeof pt[1] === "string" && pt[1].trim() !== "" ? Number(pt[1]) : NaN;
    if (!Number.isFinite(ts) || !Number.isFinite(v)) continue;
    out.set(dayOf(ts * 1000), v);
  }
  return out;
}

/**
 * Several protocols' fees added together: a day counts only when every protocol has it (the rule of sumArticles),
 * never the current UTC day (DefiLlama serves a running figure for it) or anything after, never before `since`.
 * Rounded to cents.
 */
export function sumFees(series: Map<string, number>[], today: string, since: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [day, v] of sumArticles(series)) {
    if (day >= today || day < since) continue;
    out.set(day, Math.round(v * 100) / 100);
  }
  return out;
}

/**
 * The Department of Labor's ETA 539 file: one row per state per week. Columns are found by the header (st, rptdate,
 * c3), never by position. rptdate is the week ending Saturday; c3 is the state's initial claims. A national week is
 * the sum of c3 over its rows, for weeks from `since`. The file fills in state by state, so a week counts only when
 * it has rows from as many jurisdictions as the most common count among the weeks read (53: the 50 states, DC,
 * Puerto Rico and the Virgin Islands); a week with fewer is still filling and is dropped.
 */
export function parseDolClaims(text: string, since: string): Map<string, number> {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const head = csvFields(lines[0] ?? "").map((h) => h.trim().toLowerCase());
  const iSt = head.indexOf("st");
  const iWeek = head.indexOf("rptdate");
  const iIc = head.indexOf("c3");
  if (iSt < 0 || iWeek < 0 || iIc < 0) throw new SourceError("dol_columns_missing");
  // One figure per state per week. A repeated row with the same figure is ignored; a state listed twice with two
  // different figures makes the week unreadable, so it is dropped rather than counted twice.
  const weeks = new Map<string, { byState: Map<string, number>; conflict: boolean }>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = csvFields(line);
    const week = (f[iWeek] ?? "").trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || week < since) continue;
    const st = (f[iSt] ?? "").trim().toUpperCase();
    const raw = (f[iIc] ?? "").trim();
    const ic = Number(raw);
    if (!st || raw === "" || !Number.isFinite(ic)) continue;
    const w = weeks.get(week) ?? { byState: new Map<string, number>(), conflict: false };
    const prev = w.byState.get(st);
    if (prev === undefined) w.byState.set(st, ic);
    else if (prev !== ic) w.conflict = true;
    weeks.set(week, w);
  }
  // The most common jurisdiction count among readable weeks; on a tie, the larger.
  const freq = new Map<number, number>();
  for (const w of weeks.values()) if (!w.conflict) freq.set(w.byState.size, (freq.get(w.byState.size) ?? 0) + 1);
  let full = 0;
  let best = 0;
  for (const [size, n] of freq) if (n > best || (n === best && size > full)) { full = size; best = n; }
  const out = new Map<string, number>();
  for (const [week, w] of [...weeks].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (w.conflict || w.byState.size < full) continue;
    let total = 0;
    for (const v of w.byState.values()) total += v;
    out.set(week, Math.round(total));
  }
  return out;
}

/**
 * Drop the newest `trailing` dates in a series (still filling in) and anything on or after `today`.
 * Returned oldest first.
 */
export function completeDays(series: Map<string, number>, today: string, trailing: number): Observation[] {
  const days = [...series.keys()].filter((d) => d < today).sort();
  const keep = trailing > 0 ? days.slice(0, Math.max(0, days.length - trailing)) : days;
  return keep.map((d) => ({ period: d, value: series.get(d)! }));
}

// ---------------------------------------------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------------------------------------------

const ymd = (period: string) => period.replaceAll("-", "");

export async function readSource(def: IndexDef, ctx: { now: number; get: Getter; window?: number }): Promise<Observation[]> {
  const today = dayOf(ctx.now);
  const window = ctx.window ?? def.window;
  const since = addDays(today, -window);
  const f = def.fetch;
  switch (f.kind) {
    case "wikimedia": {
      const end = addDays(today, -1);
      const series: Map<string, number>[] = [];
      for (const article of f.articles) {
        const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(article)}/daily/${ymd(since)}/${ymd(end)}`;
        series.push(parseWikimedia(json(await ctx.get(url), "wikimedia")));
      }
      return completeDays(sumArticles(series), today, def.trailingPartial);
    }
    case "socrata": {
      const where = [`${f.dateField}>='${since}T00:00:00'`, f.where].filter(Boolean).join(" AND ");
      const params = new URLSearchParams({
        $select: `date_trunc_ymd(${f.dateField}) as d, count(*) as n`,
        $where: where,
        $group: "d",
        $order: "d DESC",
        $limit: "1000",
      });
      const url = `https://${f.domain}/resource/${f.dataset}.json?${params.toString()}`;
      return completeDays(parseSocrataCounts(json(await ctx.get(url), "socrata")), today, def.trailingPartial);
    }
    case "hf_trending": {
      const url = `https://huggingface.co/api/models?sort=trendingScore&limit=${f.limit}`;
      return [{ period: today, value: parseHfTrending(json(await ctx.get(url), "hf"), f.limit) }];
    }
    case "defillama_fees": {
      // Every protocol or none: a total missing one protocol would read as a drop.
      const series = await Promise.all(f.slugs.map(async (slug) =>
        parseDefillamaFees(json(await ctx.get(`https://api.llama.fi/summary/fees/${encodeURIComponent(slug)}?dataType=dailyFees`), "defillama")),
      ));
      return completeDays(sumFees(series, today, since), today, def.trailingPartial);
    }
    case "defillama_volume": {
      // Both venues or neither: a total missing one would read as a drop.
      const series = await Promise.all(f.slugs.map(async (slug) =>
        parseDefillamaFees(json(await ctx.get(`https://api.llama.fi/summary/dexs/${encodeURIComponent(slug)}?dataType=dailyVolume`), "defillama")),
      ));
      return completeDays(sumFees(series, today, since), today, def.trailingPartial);
    }
    case "solana_sigs":
      // A running count needs its cursor: the cron reads it through advanceChain, never here.
      throw new SourceError("solana_sigs_reads_through_the_cursor");
    case "base_x402":
      // Read hour by hour by /api/cron/machines, which writes the complete days itself.
      throw new SourceError("base_x402_reads_through_the_machines_cron");
    case "dol_claims": {
      const res = await ctx.get("https://oui.doleta.gov/unemploy/csv/ar539.csv", {}, { timeoutMs: LARGE_FILE_TIMEOUT_MS });
      if (res.status !== 200) throw new SourceError(`dol_http_${res.status}`);
      // A week keyed by a Saturday still to come is never counted (completeDays drops today and later).
      return completeDays(parseDolClaims(res.text, since), today, def.trailingPartial);
    }
    case "bls":
      // All four series go out in one POST from the cron (bls.ts). A call here would spend four queries.
      throw new SourceError("bls_reads_as_a_batch");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The chain (solana_sigs): successful signatures on an account, counted per UTC day, read forward from a cursor
// ---------------------------------------------------------------------------------------------------------------

export type Poster = (url: string, body: string, opts?: { timeoutMs?: number; headers?: Record<string, string> }) => Promise<{ status: number; text: string }>;

export const fetchPoster: Poster = async (url, body, opts = {}) => {
  // Alchemy's free plan meters compute units a second: each call waits its turn (src/lib/chainRpc.ts).
  if (isAlchemy(url)) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(body); } catch { /* not JSON: costed as one call */ }
    await alchemyTurn(bodyCu(parsed));
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": USER_AGENT, ...opts.headers },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  return { status: res.status, text: await res.text() };
};

/**
 * Public Solana JSON RPC endpoints, in order. It allows about 100 requests per 10 seconds per address and 40 for one
 * method. PublicNode was the second until Oct 6 2026: its terms bar "data mining, robots, scraping, or similar data
 * gathering" (publicnode.com/terms), so a day it served could not be settled (issue #678). With ALCHEMY_API_KEY set,
 * Alchemy is asked first (solanaRpcs in chainRpc.ts).
 */
export const SOLANA_RPC: readonly string[] = ["https://api.mainnet-beta.solana.com"];
/** getSignaturesForAddress returns at most this many per call. */
export const SIGS_PAGE = 1000;
/** Pause between pages, under the per-method limit. */
export const SIGS_DELAY_MS = 150;
/** Wait before the one retry after a 429. */
export const SIGS_BACKOFF_MS = 2_000;
/** Days of running counts the cursor keeps: today and the days a late read can still complete. */
export const CHAIN_KEEP_DAYS = 3;

export type SigInfo = { signature: string; blockTime: number | null; err: unknown; slot?: number };
export type SigMark = { signature: string; blockTime: number | null };

export type SigTally = {
  /** Successful signatures per UTC day. */
  days: Map<string, number>;
  /** Successful signatures per UTC hour (YYYY-MM-DDTHH), kept in memory for the backfill table and the tests. */
  hours: Map<string, number>;
  /** Failed transactions seen and left out. */
  failed: number;
  /** Successful signatures with no block time, left out. */
  untimed: number;
};

export const emptyTally = (): SigTally => ({ days: new Map(), hours: new Map(), failed: 0, untimed: 0 });
export const hourOf = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 13);
export const dayStartSec = (ms: number) => Date.parse(`${dayOf(ms)}T00:00:00Z`) / 1000;

/**
 * Bucket one page, newest first, into `tally`: successful signatures (err null) by the UTC day and hour of their
 * block time. Stops at the first signature older than fromSec (seconds) and says so. Pure.
 */
export function tallySigs(page: SigInfo[], fromSec: number, tally: SigTally): { reachedFrom: boolean } {
  for (const s of page) {
    if (s.blockTime != null && s.blockTime < fromSec) return { reachedFrom: true };
    if (s.err != null) { tally.failed++; continue; }
    if (s.blockTime == null) { tally.untimed++; continue; }
    const day = dayOf(s.blockTime * 1000);
    const hour = hourOf(s.blockTime);
    tally.days.set(day, (tally.days.get(day) ?? 0) + 1);
    tally.hours.set(hour, (tally.hours.get(hour) ?? 0) + 1);
  }
  return { reachedFrom: false };
}

export type RpcCtx = {
  post: Poster;
  sleep?: (ms: number) => Promise<void>;
  endpoints?: readonly string[];
  backoffMs?: number;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One JSON-RPC client over the endpoints: Alchemy first when ALCHEMY_API_KEY is set, then the public ones
 * (src/lib/chainRpc.ts). A 429 waits backoffMs and retries once; a second refusal, any other status or an RPC error
 * moves to the next endpoint, which is kept for the rest of the run (and logged as rpc_fallback when it leaves
 * Alchemy). Throws when every endpoint refuses.
 */
export function solanaRpc(ctx: RpcCtx & { env?: Env }) {
  const endpoints = ctx.endpoints ?? solanaRpcs(SOLANA_RPC, ctx.env ?? process.env);
  const sleep = ctx.sleep ?? realSleep;
  const backoff = ctx.backoffMs ?? SIGS_BACKOFF_MS;
  let at = 0;
  let id = 0;
  // fellBack: a later endpoint answered at least once this run (the cursor only moves forward), so the read did not
  // come from the first endpoint alone. $MINTS's licensing turns on it (#678). With ALCHEMY_API_KEY set the first
  // endpoint is Alchemy, so it means a public endpoint served part of the run.
  const state = { calls: 0, retries: 0, endpoint: () => endpoints[at], fellBack: () => at > 0 };
  const leave = (why: string) => {
    if (isAlchemy(endpoints[at]) && at + 1 < endpoints.length) logFallback("solana", endpoints[at], endpoints[at + 1], why);
  };
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    let last = "no_endpoint";
    for (; at < endpoints.length; at++) {
      const body = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params });
      const send = async () => {
        state.calls++;
        try { return await ctx.post(endpoints[at], body); } catch { return { status: 0, text: "" }; }
      };
      let res = await send();
      if (res.status === 429) {
        state.retries++;
        await sleep(backoff);
        res = await send();
      }
      if (res.status !== 200) { last = `http_${res.status}`; leave(last); continue; }
      let parsed: { result?: T; error?: { code?: number } };
      try { parsed = JSON.parse(res.text); } catch { last = "bad_json"; leave(last); continue; }
      if (parsed.error || parsed.result === undefined) { last = `rpc_${parsed.error?.code ?? "no_result"}`; leave(last); continue; }
      return parsed.result;
    }
    at = endpoints.length - 1;
    throw new SourceError(`solana_rpc_refused_${last}`);
  }
  return { call, state };
}

export type SigPageOpts = {
  account: string;
  /** Exclusive: stop at this signature (the cursor). */
  until?: string | null;
  /** Exclusive: start below this signature (a gap being filled). */
  before?: string | null;
  /** Stop at the first signature older than this, in seconds. */
  fromSec: number;
  maxPages: number;
  /** Stop paging at this time (ms since epoch), after at least one page. */
  deadline?: number;
  delayMs?: number;
  now?: () => number;
  /** Sees every page as it arrives, before it is tallied: the Machine Board keeps the signatures themselves. */
  onPage?: (page: SigInfo[]) => void;
};

export type SigPageResult = {
  tally: SigTally;
  /** The newest signature read, successful or not: the next cursor. */
  newest: SigMark | null;
  /** The oldest signature read: where a read cut short resumes. */
  oldest: SigMark | null;
  /** Reached the cursor, the from time, or the account's first transaction. */
  complete: boolean;
  pages: number;
};

/** Page getSignaturesForAddress newest first, 1,000 at a time, and tally what it returns. */
export async function pageSignatures(rpc: ReturnType<typeof solanaRpc>, o: SigPageOpts, sleep: (ms: number) => Promise<void> = realSleep): Promise<SigPageResult> {
  const tally = emptyTally();
  const now = o.now ?? Date.now;
  let before = o.before ?? null;
  let newest: SigMark | null = null;
  let oldest: SigMark | null = null;
  let pages = 0;
  while (pages < o.maxPages) {
    if (pages > 0) {
      if (o.deadline != null && now() >= o.deadline) break;
      await sleep(o.delayMs ?? SIGS_DELAY_MS);
    }
    const cfg: Record<string, unknown> = { limit: SIGS_PAGE, commitment: "finalized" };
    if (before) cfg.before = before;
    if (o.until) cfg.until = o.until;
    const page = await rpc.call<SigInfo[]>("getSignaturesForAddress", [o.account, cfg]);
    if (!Array.isArray(page)) throw new SourceError("solana_sigs_not_array");
    pages++;
    o.onPage?.(page);
    if (page.length && !newest) newest = { signature: page[0].signature, blockTime: page[0].blockTime ?? null };
    const { reachedFrom } = tallySigs(page, o.fromSec, tally);
    if (page.length) {
      const last = page[page.length - 1];
      oldest = { signature: last.signature, blockTime: last.blockTime ?? null };
      before = last.signature;
    }
    if (reachedFrom || page.length < SIGS_PAGE) return { tally, newest, oldest, complete: true, pages };
  }
  return { tally, newest, oldest, complete: false, pages };
}

/**
 * What chain_cursors holds for one account, as JSON: the newest signature counted, the running count per UTC day
 * for the last few days, and a gap when a read was cut short (the signatures between `until` and `before` are still
 * to count). The counts live with the cursor, so a run that fails after writing either one repeats cleanly: the
 * levels are always rebuilt from the cursor's counts.
 */
export type ChainState = {
  newest: string | null;
  newest_time: number | null;
  days: Record<string, number>;
  gap: { before: string; before_time: number | null; until: string | null; from: number; after_time: number | null } | null;
};

export const emptyChain = (): ChainState => ({ newest: null, newest_time: null, days: {}, gap: null });

function addTally(days: Record<string, number>, t: SigTally) {
  for (const [d, n] of t.days) days[d] = (days[d] ?? 0) + n;
}

/**
 * One run on one account. Fills an open gap first; reads forward from the cursor once no gap is left. With no
 * cursor, the first read starts at 00:00 UTC today. A read cut short (page cap or deadline) leaves a gap for the next
 * run and moves the cursor to the newest signature read, so nothing is counted twice or skipped.
 */
export async function advanceChain(
  account: string,
  prior: ChainState | null,
  ctx: RpcCtx & { now: number; maxPages: number; deadline?: number; delayMs?: number; clock?: () => number },
): Promise<{ state: ChainState; pages: number; tally: SigTally; fellBack: boolean }> {
  const s: ChainState = prior ? { ...prior, days: { ...prior.days }, gap: prior.gap ? { ...prior.gap } : null } : emptyChain();
  const rpc = solanaRpc(ctx);
  const sleep = ctx.sleep ?? realSleep;
  const all = emptyTally();
  const merge = (t: SigTally) => {
    addTally(s.days, t);
    for (const [d, n] of t.days) all.days.set(d, (all.days.get(d) ?? 0) + n);
    for (const [h, n] of t.hours) all.hours.set(h, (all.hours.get(h) ?? 0) + n);
    all.failed += t.failed;
    all.untimed += t.untimed;
  };
  let pages = 0;
  const base = { maxPages: ctx.maxPages, deadline: ctx.deadline, delayMs: ctx.delayMs, now: ctx.clock };
  if (s.gap) {
    const r = await pageSignatures(rpc, { ...base, account, before: s.gap.before, until: s.gap.until, fromSec: s.gap.from }, sleep);
    pages += r.pages;
    merge(r.tally);
    if (r.complete) s.gap = null;
    else if (r.oldest) s.gap = { ...s.gap, before: r.oldest.signature, before_time: r.oldest.blockTime };
  }
  const timeLeft = ctx.deadline == null || (ctx.clock ?? Date.now)() < ctx.deadline;
  if (!s.gap && pages < ctx.maxPages && timeLeft) {
    const fromSec = s.newest ? 0 : dayStartSec(ctx.now);
    const prevNewest = s.newest;
    const prevTime = s.newest_time;
    if (pages > 0) await sleep(ctx.delayMs ?? SIGS_DELAY_MS);
    const r = await pageSignatures(rpc, { ...base, maxPages: ctx.maxPages - pages, account, until: prevNewest, fromSec }, sleep);
    pages += r.pages;
    merge(r.tally);
    if (r.newest) { s.newest = r.newest.signature; s.newest_time = r.newest.blockTime; }
    if (!r.complete && r.oldest) {
      s.gap = { before: r.oldest.signature, before_time: r.oldest.blockTime, until: prevNewest, from: fromSec, after_time: prevTime ?? fromSec };
    }
  }
  // Old days are not pruned here: a long catch-up can recover counts for days older than the keep window, and those
  // must reach storage first. The caller prunes after writing (pruneChainDays).
  return { state: s, pages, tally: all, fellBack: rpc.state.fellBack() };
}

/**
 * Drop running counts older than the keep window, but only days already written to storage. A day an open gap still
 * holds, or any day not yet written, stays in the cursor until it is, so no recovered count is lost between the read
 * and the write.
 */
export function pruneChainDays(s: ChainState, nowMs: number, written: ReadonlySet<string>): ChainState {
  const keepFrom = addDays(dayOf(nowMs), -(CHAIN_KEEP_DAYS - 1));
  const days = { ...s.days };
  for (const d of Object.keys(days)) if (d < keepFrom && written.has(d)) delete days[d];
  return { ...s, days };
}

/**
 * The days a cursor's counts can print: every day it holds, except the days an open gap still runs through (from
 * the day of the cursor it started from to the day of the oldest signature read), which wait for the gap to fill.
 * Oldest first.
 */
export function chainObservations(s: ChainState, nowMs: number): Observation[] {
  let heldFrom: string | null = null;
  let heldTo: string | null = null;
  if (s.gap) {
    heldFrom = dayOf((s.gap.after_time ?? s.gap.from) * 1000);
    heldTo = s.gap.before_time != null ? dayOf(s.gap.before_time * 1000) : dayOf(nowMs);
  }
  return Object.keys(s.days)
    .filter((d) => !(heldFrom && heldTo && d >= heldFrom && d <= heldTo))
    .sort()
    .map((d) => ({ period: d, value: s.days[d] }));
}
