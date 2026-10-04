/**
 * $GIGS and $WAGE: what paying wallets pay for, read from settled x402 payments on Base. Who holds a wallet is not on
 * the chain, so nothing here names a payer as an AI agent.
 *
 * $GIGS counts paid agent calls per UTC day. $WAGE is the payer-balanced median price of a paid call: each payer's
 * median price first, weighted by its calls, then the median across payers, so one bot firing thousands of calls
 * counts once. The 25th and 75th percentiles across payers are kept beside it, as SOFR publishes its percentiles.
 *
 * A payment counts when a USDC signed transfer (EIP-3009, the x402 "exact" scheme) was sent on chain by one of the
 * facilitator wallets in facilitators.ts. Every signed transfer is counted from the logs; one transaction in sixteen is
 * read in full (inSample: the low byte of keccak256(tx hash, block hash) under 16). The sender cannot know its block's
 * hash when it sends, so it cannot steer into or out of the sample, and anyone can redraw the same sample. $GIGS is
 * the ratio estimate, every signed transfer times the payments per sampled transaction, printed with its 95% range;
 * $WAGE reads the sampled payments. A survey, the way labor statistics are measured, not a census. Each signed
 * authorization is one payment: its signer is the payer, the wallet its money reaches is the payee (through a router
 * when one passes it on), its amount the price. A payer paying itself, and a zero amount, are left out. Hours are read whole, once,
 * aggregated per payer, payee, facilitator and price (aggregateHour); a complete UTC day is its 24 hours added up
 * (dayFromHours): one level each for GIGS and WAGE, sealed in the daily proof like every index.
 *
 * Extracted from the reader Tickerz runs in production without changes to the counting rules; only the storage notes
 * and the storage key were taken out, and dayFromHours was added (production does the same sum over stored hours).
 */
import { concat, keccak256, type Hex } from "viem";
import { BASE_FACILITATORS } from "./facilitators";

export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/** keccak256("AuthorizationUsed(address,bytes32)"), emitted by USDC for every EIP-3009 signed transfer. */
export const AUTH_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
/** keccak256("Transfer(address,address,uint256)"). */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/**
 * Base's public node, the one free node that answered batched receipt reads when checked on 2026-09-29 (1rpc hit its
 * plan limit, drpc and meowrpc refused batches). Ten receipts take about 0.2 seconds.
 */
export const BASE_RPCS: readonly string[] = ["https://mainnet.base.org"];
/** Nodes for single calls (block numbers, blocks, logs): Base's own first, two free fallbacks. */
export const BASE_SINGLE_RPCS: readonly string[] = ["https://mainnet.base.org", "https://base.drpc.org", "https://base.meowrpc.com"];
/** Below this many distinct payers a day's $WAGE is not printed: a handful of payers is not a rate. */
export const WAGE_MIN_PAYERS = 50;
const HOUR_MS = 3_600_000;
const USER_AGENT = "TickerzIndexBot/1.0 (https://tickerz.com; desk@tickerz.com)";

/**
 * One agent payment: one signed authorization. leg is its place among the transaction's authorizations, from 0; via is
 * the router it passed through on the way to the service, when it did.
 */
export type Payment = { payer: string; payee: string; facilitator: string; priceE6: number; leg: number; via?: string };
/** One hour read: its blocks, every signed transfer counted, the sample read in full. */
export type HourRead = { fromBlock: number; toBlock: number; signedTxs: number; sampledTxs: number; x402Txs: number; payments: Payment[] };
export const SAMPLE_BYTE_BELOW = 16;

/** Whether a transaction is in the sample: the low byte of keccak256(tx hash, block hash) is under 16 (1 in 16). */
export function inSample(txHash: string, blockHash: string): boolean {
  const h = keccak256(concat([txHash as Hex, blockHash as Hex]));
  return Number.parseInt(h.slice(-2), 16) < SAMPLE_BYTE_BELOW;
}

/**
 * $GIGS for a day from its hours: every signed transfer times the payments per sampled transaction, with a 95% range
 * from the sampled share of transactions that were agent payments (finite population correction applied).
 */
export function estimateGigs(h: { signedTxs: number; sampledTxs: number; x402Txs: number; payments: number }): { gigs: number; low: number; high: number } {
  const { signedTxs: N, sampledTxs: n, x402Txs: k, payments } = h;
  if (!n || !k) return { gigs: 0, low: 0, high: 0 };
  const p = k / n;
  const perTx = payments / k;
  const gigs = N * p * perTx;
  const se = N * perTx * Math.sqrt(((p * (1 - p)) / n) * Math.max(0, 1 - n / N));
  return { gigs: Math.round(gigs), low: Math.max(0, Math.round(gigs - 1.96 * se)), high: Math.round(gigs + 1.96 * se) };
}
export type GigRow = { hour: string; payer: string; payee: string; facilitator: string; price_e6: number; n: number };
export type DayStats = {
  gigs: number;
  payers: number;
  payees: number;
  usd_e6: number;
  wage_e6: number | null;
  p25_e6: number | null;
  p75_e6: number | null;
  by_facilitator: Record<string, number>;
  top_payees: { payee: string; n: number; usd_e6: number }[];
};

type Log = { address: string; topics: string[]; data: string; transactionHash: string };
type Receipt = { from: string; status?: string; logs: Log[] } | null;

const addr = (topic: string) => `0x${topic.slice(-40)}`.toLowerCase();

/** A router passes a payment on at most this many times before the last wallet is taken as the service. */
const MAX_HOPS = 3;
/**
 * x402 batch-settlement contracts (x402-foundation/x402 contracts/evm, read 2026-09-30): an authorization into one of
 * them is a deposit into a payment channel that later pays for many calls, not a paid call, so it is not counted here.
 */
export const CHANNEL_CONTRACTS: ReadonlySet<string> = new Set([
  "0x4020074e9df2ce1dee5a9c1b5c3f541d02a10003", // x402BatchSettlement
  "0x4020806089470a89826cb9fb1f4059150b550004", // ERC3009DepositCollector
  "0x4020425faf3b746c082c2f942b4e5159887b0005", // Permit2DepositCollector
]);

/**
 * The agent payments in one transaction receipt, one per signed authorization. Empty unless a listed facilitator sent
 * it and it succeeded.
 *
 * USDC emits AuthorizationUsed(authorizer, nonce) and then the Transfer it authorized, so each AuthorizationUsed pairs
 * with the next USDC Transfer out of the authorizer. That holds for a direct call to USDC and for a facilitator's own
 * settlement contract alike. A payment sent through a router (Fluxa's escrow, Meridian's fee proxy: payer to router,
 * router to service, in one transaction) goes on to the wallet the router passes it to, and the router is kept as via:
 * one payment, not two, and the service as the payee. Transfers that no authorization covers (a router's fee, a
 * refund) are not payments.
 */
export function paymentsFromReceipt(receipt: Receipt, facilitators: Readonly<Record<string, string>> = BASE_FACILITATORS, usdcAddress: string = BASE_USDC): Payment[] {
  if (!receipt || receipt.status === "0x0") return [];
  const facilitator = facilitators[receipt.from.toLowerCase()];
  if (!facilitator) return [];
  const token = usdcAddress.toLowerCase();
  const usdc = receipt.logs.filter((lg) => lg.address.toLowerCase() === token);
  const isTransfer = (lg: Log) => lg.topics[0] === TRANSFER_TOPIC && lg.topics.length === 3;
  const used = new Set<number>();
  const out: Payment[] = [];
  let auths = 0;
  for (let i = 0; i < usdc.length; i++) {
    const lg = usdc[i];
    if (lg.topics[0] !== AUTH_USED_TOPIC || lg.topics.length < 2) continue;
    // The leg is the authorization's place in the transaction, so it stays the same when a sibling is left out.
    const leg = auths++;
    const payer = addr(lg.topics[1]);
    const t = usdc.findIndex((x, j) => j > i && !used.has(j) && isTransfer(x) && addr(x.topics[1]) === payer);
    if (t < 0) continue;
    used.add(t);
    const amount = BigInt(usdc[t].data);
    let payee = addr(usdc[t].topics[2]);
    let via: string | undefined;
    // While the wallet paid passes most of it on later in this transaction, follow the onward transfer closest in
    // amount to what it received (Meridian's proxy keeps 1%, thirdweb's fans out to fee wallets), the rule x402scan uses
    // (sync/transfers/trigger/lib/collapse.ts, issue #1024). The price stays what the payer signed for.
    for (let hop = 0, from = t, got = amount; hop < MAX_HOPS; hop++) {
      let f = -1;
      for (let j = from + 1; j < usdc.length; j++) {
        const x = usdc[j];
        // A wallet that passes on less than half of what it received is the service paying a fee, not a router.
        if (used.has(j) || !isTransfer(x) || addr(x.topics[1]) !== payee || BigInt(x.data) * 2n < got) continue;
        const d = (v: bigint) => (v > got ? v - got : got - v);
        if (f < 0 || d(BigInt(x.data)) < d(BigInt(usdc[f].data))) f = j;
      }
      if (f < 0) break;
      used.add(f);
      via ??= payee;
      payee = addr(usdc[f].topics[2]);
      got = BigInt(usdc[f].data);
      from = f;
    }
    if (CHANNEL_CONTRACTS.has(payee) || (via && CHANNEL_CONTRACTS.has(via))) continue;
    if (payer === payee || amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    out.push(via ? { payer, payee, facilitator, priceE6: Number(amount), leg, via } : { payer, payee, facilitator, priceE6: Number(amount), leg });
  }
  return out;
}

/** One hour's payments as rows: one row per payer, payee, facilitator and price, with how many calls (n). */
export function aggregateHour(hourIso: string, payments: Payment[]): GigRow[] {
  const m = new Map<string, GigRow>();
  for (const p of payments) {
    const k = `${p.payer}|${p.payee}|${p.facilitator}|${p.priceE6}`;
    const row = m.get(k);
    if (row) row.n += 1;
    else m.set(k, { hour: hourIso, payer: p.payer, payee: p.payee, facilitator: p.facilitator, price_e6: p.priceE6, n: 1 });
  }
  return [...m.values()];
}

/** The lower weighted median of prices, each weighted by its count. */
export function weightedMedian(prices: { price: number; n: number }[]): number {
  const sorted = [...prices].sort((a, b) => a.price - b.price);
  const total = sorted.reduce((s, p) => s + p.n, 0);
  let seen = 0;
  for (const p of sorted) {
    seen += p.n;
    if (seen * 2 >= total) return p.price;
  }
  return sorted[sorted.length - 1]?.price ?? 0;
}

/** Nearest-rank percentile of a sorted list, q in [0, 1]. */
export function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

/** A complete day's numbers from its rows (aggregateHour over each of its hours). */
export function dayStats(rows: Pick<GigRow, "payer" | "payee" | "facilitator" | "price_e6" | "n">[]): DayStats {
  const byPayer = new Map<string, { price: number; n: number }[]>();
  const payees = new Map<string, { n: number; usd: number }>();
  const byFacilitator: Record<string, number> = {};
  let gigs = 0;
  let usd = 0;
  for (const r of rows) {
    gigs += r.n;
    usd += r.price_e6 * r.n;
    byFacilitator[r.facilitator] = (byFacilitator[r.facilitator] ?? 0) + r.n;
    const list = byPayer.get(r.payer) ?? [];
    list.push({ price: r.price_e6, n: r.n });
    byPayer.set(r.payer, list);
    const pe = payees.get(r.payee) ?? { n: 0, usd: 0 };
    pe.n += r.n;
    pe.usd += r.price_e6 * r.n;
    payees.set(r.payee, pe);
  }
  const medians = [...byPayer.values()].map(weightedMedian).sort((a, b) => a - b);
  const printable = medians.length >= WAGE_MIN_PAYERS;
  return {
    gigs,
    payers: byPayer.size,
    payees: payees.size,
    usd_e6: usd,
    wage_e6: printable ? percentile(medians, 0.5) : null,
    p25_e6: printable ? percentile(medians, 0.25) : null,
    p75_e6: printable ? percentile(medians, 0.75) : null,
    by_facilitator: byFacilitator,
    top_payees: [...payees.entries()]
      .sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))
      .slice(0, 10)
      .map(([payee, v]) => ({ payee, n: v.n, usd_e6: v.usd })),
  };
}

/**
 * One complete UTC day from its 24 hour reads, as Tickerz's daily close computes it: $GIGS is estimateGigs over the
 * day's summed counts (every signed transfer, the sampled transactions, the sampled ones that were x402 payments, and
 * the payments in them); $WAGE is dayStats over every sampled payment of the day, in dollars. wage is null below
 * WAGE_MIN_PAYERS distinct payers, when no level prints. Throws unless exactly 24 hours are given.
 */
export function dayFromHours(hours: Pick<HourRead, "signedTxs" | "sampledTxs" | "x402Txs" | "payments">[]): {
  gigs: { gigs: number; low: number; high: number };
  wage: number | null;
  stats: DayStats;
  totals: { signedTxs: number; sampledTxs: number; x402Txs: number; payments: number };
} {
  if (hours.length !== 24) throw new Error(`day_incomplete:${hours.length}`);
  const totals = { signedTxs: 0, sampledTxs: 0, x402Txs: 0, payments: 0 };
  const rows: GigRow[] = [];
  hours.forEach((h, i) => {
    totals.signedTxs += h.signedTxs;
    totals.sampledTxs += h.sampledTxs;
    totals.x402Txs += h.x402Txs;
    totals.payments += h.payments.length;
    rows.push(...aggregateHour(String(i), h.payments));
  });
  const stats = dayStats(rows);
  return { gigs: estimateGigs(totals), wage: stats.wage_e6 == null ? null : stats.wage_e6 / 1e6, stats, totals };
}

// ---------------------------------------------------------------------------------------------------------------
// The chain: blocks for an hour, the signed transfers in them, their receipts
// ---------------------------------------------------------------------------------------------------------------

export type RpcPost = (url: string, body: unknown) => Promise<unknown>;

export const fetchRpc: RpcPost = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    // Base answers a too-large range with HTTP 500 and a JSON-RPC error: keep its message so the caller can split.
    const text = await res.text().catch(() => "");
    let msg = "";
    try { msg = String((JSON.parse(text) as { error?: { message?: string } }).error?.message ?? ""); } catch { /* not JSON */ }
    throw new Error(`rpc_http_${res.status}${msg ? `:${msg.slice(0, 120)}` : ""}`);
  }
  return res.json();
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An error that means the range asked too much of the node (Base: "backend response too large"), not that it is down. */
const TOO_MUCH = /too large|too many results|response size|exceed/i;
const THROTTLED = /rate|too many requests|429|throttl|capacity|credits/i;
const rangeTooLarge = (e: unknown) => e instanceof Error && TOO_MUCH.test(e.message) && !THROTTLED.test(e.message);

/** One JSON-RPC call, tried on each node in turn with backoff. A range the node calls too large is thrown at once. */
async function call(post: RpcPost, rpcs: readonly string[], method: string, params: unknown[], start = 0): Promise<unknown> {
  let last: unknown = null;
  for (let k = 0; k < 9; k++) {
    const url = rpcs[(start + k) % rpcs.length];
    try {
      const d = (await post(url, { jsonrpc: "2.0", id: 1, method, params })) as { result?: unknown; error?: { message?: string } };
      if (d.error) throw new Error(d.error.message ?? "rpc_error");
      return d.result;
    } catch (e) {
      if (rangeTooLarge(e)) throw e;
      last = e;
      await sleep(Math.min(16_000, 400 * 2 ** k));
    }
  }
  throw last instanceof Error ? last : new Error(`${method}_failed`);
}

/** Up to ten calls in one request (the cap on mainnet.base.org), results in call order. */
async function batch(post: RpcPost, url: string, method: string, paramsList: unknown[][]): Promise<unknown[]> {
  const body = paramsList.map((params, id) => ({ jsonrpc: "2.0", id, method, params }));
  const d = (await post(url, body)) as { id: number; result?: unknown; error?: unknown }[];
  if (!Array.isArray(d) || d.length !== paramsList.length) throw new Error(`rpc_batch_short:${JSON.stringify(d).slice(0, 120)}`);
  const byId = new Map(d.map((x) => [x.id, x]));
  return paramsList.map((_, id) => {
    const x = byId.get(id);
    if (!x) throw new Error("rpc_batch_missing");
    if (x.error) throw new Error(`rpc_batch_error:${JSON.stringify(x.error).slice(0, 120)}`);
    return x.result;
  });
}

async function blockTime(post: RpcPost, rpcs: readonly string[], n: number): Promise<number> {
  const b = (await call(post, rpcs, "eth_getBlockByNumber", [`0x${n.toString(16)}`, false])) as { timestamp: string } | null;
  if (!b) throw new Error("block_missing");
  return Number.parseInt(b.timestamp, 16);
}

/** The first block with a timestamp at or after tsSec. Base makes a block every 2 seconds; the estimate is checked. */
export async function firstBlockAtOrAfter(post: RpcPost, rpcs: readonly string[], tsSec: number): Promise<number> {
  const latestHex = (await call(post, rpcs, "eth_blockNumber", [])) as string;
  const latest = Number.parseInt(latestHex, 16);
  const latestTs = await blockTime(post, rpcs, latest);
  let b = latest - Math.floor((latestTs - tsSec) / 2);
  for (let i = 0; i < 12; i++) {
    const t = await blockTime(post, rpcs, b);
    if (t < tsSec) { b += Math.max(1, Math.ceil((tsSec - t) / 2)); continue; }
    const prev = await blockTime(post, rpcs, b - 1);
    if (prev < tsSec) return b;
    b -= Math.max(1, Math.floor((t - tsSec) / 2));
  }
  throw new Error("block_search_failed");
}

/** One hour, [hourStartMs, hourStartMs + 1 hour): every signed transfer counted, the sample read receipt by receipt. */
export async function readHour(
  hourStartMs: number,
  opts: { post?: RpcPost; rpcs?: readonly string[]; concurrency?: number; sampleAll?: boolean } = {},
): Promise<HourRead> {
  const post = opts.post ?? fetchRpc;
  const rpcs = opts.rpcs ?? BASE_RPCS;
  const single = opts.rpcs ?? BASE_SINGLE_RPCS;
  const from = await firstBlockAtOrAfter(post, single, hourStartMs / 1000);
  const to = (await firstBlockAtOrAfter(post, single, (hourStartMs + HOUR_MS) / 1000)) - 1;
  const logs: (Log & { blockHash: string })[] = [];
  // 1,000 blocks a call; a busy range the node refuses as too large (Oct 3 21:00) is halved until it answers.
  const ranges: [number, number][] = [];
  for (let b = from; b <= to; b += 1000) ranges.push([b, Math.min(b + 999, to)]);
  while (ranges.length) {
    const [a, z] = ranges.shift()!;
    try {
      logs.push(...((await call(post, single, "eth_getLogs", [
        { address: BASE_USDC, topics: [AUTH_USED_TOPIC], fromBlock: `0x${a.toString(16)}`, toBlock: `0x${z.toString(16)}` },
      ])) as (Log & { blockHash: string })[]));
    } catch (e) {
      if (!rangeTooLarge(e) || a === z) throw e;
      const mid = a + Math.floor((z - a) / 2);
      ranges.unshift([a, mid], [mid + 1, z]);
    }
  }
  const blockOf = new Map(logs.map((l) => [l.transactionHash, l.blockHash]));
  const all = [...blockOf.keys()].sort();
  const txs = opts.sampleAll ? all : all.filter((h) => inSample(h, blockOf.get(h)!));
  const chunks: string[][] = [];
  for (let i = 0; i < txs.length; i += 10) chunks.push(txs.slice(i, i + 10));
  const payments: Payment[] = [];
  let x402Txs = 0;
  let next = 0;
  const worker = async (w: number) => {
    for (;;) {
      const i = next++;
      if (i >= chunks.length) return;
      let receipts: unknown[] | null = null;
      let lastErr = "";
      for (let k = 0; k < 8 && !receipts; k++) {
        try {
          receipts = await batch(post, rpcs[(w + k) % rpcs.length], "eth_getTransactionReceipt", chunks[i].map((h) => [h]));
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e);
          await sleep(Math.min(16_000, 500 * 2 ** k));
        }
      }
      if (!receipts) throw new Error(`receipts_failed:${lastErr}`);
      for (const r of receipts) {
        const p = paymentsFromReceipt(r as Receipt);
        if (p.length) x402Txs += 1;
        payments.push(...p);
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 2 }, (_, w) => worker(w)));
  return { fromBlock: from, toBlock: to, signedTxs: all.length, sampledTxs: txs.length, x402Txs, payments };
}

export const hourIso = (ms: number) => new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString();
