/**
 * $MINTS: new coins created on pump.fun per UTC day, counted from the Solana chain.
 *
 * pump.fun's mint authority (a PDA of the bonding curve program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P) signs
 * only create transactions, so one successful signature on it is one coin created. Graduations (curves that completed
 * and moved to pump.fun's own exchange) are counted the same way on the migrator account; many competing graduation
 * attempts fail, so on both accounts only successful signatures count. The accounts are from
 * https://github.com/pump-fun/pump-public-docs.
 *
 * Rulebook v0.1: finalized transactions only, each counted on the UTC day of its block time.
 *
 * Everything below talks to the chain through an injected `post`, so the tests run it against a fake chain and the
 * CLI (scripts/count-mints.ts) runs it against the public Solana JSON RPC. Nothing here writes anywhere.
 * Extracted from the reader Tickerz runs in production without changes to the counting rules.
 */

/** The account whose successful signatures are $MINTS: pump.fun's mint authority. */
export const MINTS_ACCOUNT = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";
/** The account whose successful signatures are the graduations line ($MINTS.GRADS): pump.fun's migrator. */
export const GRADUATIONS_ACCOUNT = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";

/** Sent with every request so a node operator can see who is asking. */
export const USER_AGENT = "TickerzIndexBot/1.0 (https://tickerz.com; desk@tickerz.com)";

const DAY = 864e5;
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (period: string, n: number) => dayOf(Date.parse(`${period}T00:00:00Z`) + n * DAY);

/** One number per period. */
export type Observation = {
  /** UTC day, YYYY-MM-DD. */
  period: string;
  value: number | null;
};

class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The chain (solana_sigs): successful signatures on an account, counted per UTC day, read forward from a cursor
// ---------------------------------------------------------------------------------------------------------------

export type Poster = (url: string, body: string, opts?: { timeoutMs?: number }) => Promise<{ status: number; text: string }>;

export const fetchPoster: Poster = async (url, body, opts = {}) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": USER_AGENT },
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  return { status: res.status, text: await res.text() };
};

/**
 * Public Solana JSON RPC endpoints, in order. The first allows about 100 requests per 10 seconds per address and 40
 * for one method; the second is tried when the first refuses.
 */
export const SOLANA_RPC: readonly string[] = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
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
 * One JSON-RPC client over the public endpoints. A 429 waits backoffMs and retries once; a second refusal, any
 * other status or an RPC error moves to the next endpoint, which is kept for the rest of the run. Throws when every
 * endpoint refuses.
 */
export function solanaRpc(ctx: RpcCtx) {
  const endpoints = ctx.endpoints ?? SOLANA_RPC;
  const sleep = ctx.sleep ?? realSleep;
  const backoff = ctx.backoffMs ?? SIGS_BACKOFF_MS;
  let at = 0;
  let id = 0;
  const state = { calls: 0, retries: 0, endpoint: () => endpoints[at] };
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
      if (res.status !== 200) { last = `http_${res.status}`; continue; }
      let parsed: { result?: T; error?: { code?: number } };
      try { parsed = JSON.parse(res.text); } catch { last = "bad_json"; continue; }
      if (parsed.error || parsed.result === undefined) { last = `rpc_${parsed.error?.code ?? "no_result"}`; continue; }
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
  /** Sees every page as it arrives, before it is tallied, for a caller that keeps the signatures themselves. */
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
 * What the reader keeps between runs for one account, as JSON (the cursor): the newest signature counted, the running count per UTC day
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
): Promise<{ state: ChainState; pages: number; tally: SigTally }> {
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
  return { state: s, pages, tally: all };
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
