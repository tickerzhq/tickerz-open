/**
 * Which node a chain read goes to. Alchemy (ALCHEMY_API_KEY, free plan) is used where its free plan is as good as the
 * public node and costs few compute units; the public node stays where Alchemy's free plan is worse.
 *
 *   Base eth_getLogs ($GIGS, $WAGE)   mainnet.base.org first (500 blocks a call). Alchemy's free plan allows 10 blocks a
 *                                     call (60 CU each, about 180 calls an hour), so it is only the fallback.
 *   Base blocks, sampled receipts     Alchemy first, the public nodes after it (20 CU a block or a receipt; about 200
 *                                     receipts an hour).
 *   Base receipts from Goldsky        mainnet.base.org first, Alchemy as the fallback: about 450 receipts an hour, which
 *                                     would be the largest Alchemy cost (src/lib/indices/machinesIngest.ts).
 *   Solana signatures ($MINTS)        Alchemy first (40 CU a page of 1,000), the two public endpoints after it.
 *   Base EAS Close (the proof)        Alchemy first, mainnet.base.org after it; BASE_RPC_URL still overrides both.
 *
 * With no key every list is exactly the public one it was before. The key lives only inside these URLs: errors and
 * logs name a node by label ("alchemy", or the public host), never by URL.
 */
import { fallback, http, type Transport } from "viem";

export type Env = Record<string, string | undefined>;

export const PUBLIC_BASE = "https://mainnet.base.org";

function alchemyKey(env: Env): string | null {
  const k = env.ALCHEMY_API_KEY?.trim();
  return k ? k : null;
}

/** The Alchemy endpoint for a chain, or null when no key is set. */
export function alchemyUrl(chain: "base" | "solana", env: Env = process.env): string | null {
  const key = alchemyKey(env);
  if (!key) return null;
  return `https://${chain === "base" ? "base-mainnet" : "solana-mainnet"}.g.alchemy.com/v2/${key}`;
}

export const isAlchemy = (url: string) => /\.g\.alchemy\.com\//.test(url);

/** A node's name for logs and errors: "alchemy", or the public host. Never the URL, which holds the key. */
export function rpcLabel(url: string): string {
  if (isAlchemy(url)) return "alchemy";
  try { return new URL(url).host; } catch { return "node"; }
}

/** Removes the key from any text before it is logged or stored: the configured key, and whatever follows /v2/ in an Alchemy URL. */
export function redactKey(text: string, env: Env = process.env): string {
  const key = alchemyKey(env);
  const cut = key ? text.split(key).join("***") : text;
  return cut.replace(/(\.g\.alchemy\.com\/v2\/)[^\s"'/?#]+/g, "$1***");
}

/** One line in the runtime log each time a read leaves its first node, named by label. */
export function logFallback(what: string, from: string, to: string, reason: string, env: Env = process.env): void {
  console.warn(`rpc_fallback ${what}: ${rpcLabel(from)} -> ${rpcLabel(to)} (${redactKey(reason, env).slice(0, 160)})`);
}

/** Nodes for Base eth_getLogs: the public node first (500 blocks a call), Alchemy as the fallback. */
export function baseLogRpcs(publicNodes: readonly string[], env: Env = process.env): readonly string[] {
  const a = alchemyUrl("base", env);
  return a ? [PUBLIC_BASE, a] : publicNodes;
}

/** Public nodes first, Alchemy last: for Base reads that are big on Alchemy's meter (Goldsky's receipts). */
export function basePublicFirst(publicNodes: readonly string[], env: Env = process.env): readonly string[] {
  const a = alchemyUrl("base", env);
  return a ? [...publicNodes, a] : publicNodes;
}

/** Nodes for the Machine Board's blocks and sampled receipts: Alchemy first, then the public ones. */
export function baseRpcs(publicNodes: readonly string[], env: Env = process.env): readonly string[] {
  const a = alchemyUrl("base", env);
  return a ? [a, ...publicNodes] : publicNodes;
}

/** Endpoints for $MINTS's Solana reads: Alchemy first, then the public ones. */
export function solanaRpcs(publicNodes: readonly string[], env: Env = process.env): readonly string[] {
  const a = alchemyUrl("solana", env);
  return a ? [a, ...publicNodes] : publicNodes;
}

/**
 * Alchemy's free plan allows 300 compute units a second (a 10 second rolling window). Calls to Alchemy wait their turn
 * at 200 a second, so the Terminal's price reads keep room and a read is not refused for speed.
 */
export const ALCHEMY_CU_PER_SEC = 200;
/** Compute units per call, from https://www.alchemy.com/docs/reference/compute-unit-costs (read Oct 6 2026). */
export const ALCHEMY_CU: Readonly<Record<string, number>> = {
  eth_blockNumber: 10,
  eth_getBlockByNumber: 20,
  eth_getTransactionReceipt: 20,
  eth_call: 26,
  eth_getLogs: 60,
  getSignaturesForAddress: 40,
};
/** A pacer: each call waits until Alchemy has room for its compute units under ALCHEMY_CU_PER_SEC. */
export function alchemyPacer(now: () => number = Date.now, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
  let nextFreeAt = 0;
  return async (cu: number): Promise<void> => {
    const t = now();
    const start = Math.max(t, nextFreeAt);
    nextFreeAt = start + (cu * 1000) / ALCHEMY_CU_PER_SEC;
    if (start > t) await sleep(start - t);
  };
}

/** The one pacer every Alchemy call in this process shares. */
export const alchemyTurn = alchemyPacer();

/** The compute units one request body costs: a batch costs each call in it. */
export function bodyCu(body: unknown): number {
  const calls = Array.isArray(body) ? body : [body];
  return calls.reduce((s: number, c) => s + (ALCHEMY_CU[String((c as { method?: string })?.method)] ?? 20), 0);
}

/**
 * The viem transport for Base's EAS Close: BASE_RPC_URL when set; otherwise Alchemy, falling back to mainnet.base.org
 * (logged); with no key, mainnet.base.org alone, as before.
 */
export function baseTransport(env: Env = process.env, opts: { timeout?: number; retryCount?: number } = {}): Transport {
  const override = env.BASE_RPC_URL;
  if (override !== undefined) return http(override, opts);
  const a = alchemyUrl("base", env);
  if (!a) return http(PUBLIC_BASE, opts);
  return fallback([
    http(a, opts),
    http(PUBLIC_BASE, { ...opts, onFetchRequest: () => logFallback("base_eas", a, PUBLIC_BASE, "alchemy did not answer", env) }),
  ], { retryCount: 0 });
}
