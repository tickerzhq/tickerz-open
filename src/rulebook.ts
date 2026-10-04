/**
 * The rulebook for the three indexes in this repo, as Tickerz publishes it (copied from the production registry; the
 * same text is on https://tickerz.com/x/mints, /x/gigs and /x/wage and in GET https://tickerz.com/api/v1/indices/{ticker}).
 * Pure data. METHODOLOGY.md prints these lines, and a test holds the two together.
 */
import { GRADUATIONS_ACCOUNT, MINTS_ACCOUNT } from "./mints";

export const RULEBOOK_VERSION = "Rulebook v0.1, 2026-09-23";

export type Grade = "candidate" | "reference" | "display";

export type Rulebook = {
  ticker: string;
  slug: string;
  name: string;
  /** What the number counts. */
  counts: string;
  unit: [string, string];
  format: "count" | "usd";
  source: { name: string; url: string; terms: string };
  /** Where the number is read from. */
  chain: { kind: "solana_sigs"; account: string; graduations: string } | { kind: "base_x402"; series: "gigs" | "wage" };
  cadence: string;
  companion?: { ticker: string; label: string };
  settlement: { grade: Grade; why: string; manipulation: string; fallback: string; precision: string; version: string };
};

export const RULEBOOKS: readonly Rulebook[] = [
  {
    ticker: "MINTS",
    slug: "mints",
    name: "Memecoin launches",
    counts: "New coins created on the pump.fun program per UTC day, counted by Tickerz from the Solana chain: one per successful create transaction on the program's mint authority. Graduations (curves that completed and moved to pump.fun's own exchange) print as a second line. Rulebook v0.1: finalized transactions only, each counted on the UTC day of its block time.",
    unit: ["coin", "coins"],
    format: "count",
    source: {
      name: "Solana mainnet, the pump.fun program",
      url: "https://github.com/pump-fun/pump-public-docs",
      terms: "Public chain data read by Tickerz over the Solana JSON RPC. No vendor dataset. The count is Tickerz's own and is licensed by Tickerz.",
    },
    chain: { kind: "solana_sigs", account: MINTS_ACCOUNT, graduations: GRADUATIONS_ACCOUNT },
    cadence: "Hourly, from the chain",
    companion: { ticker: "MINTS.GRADS", label: "Graduations" },
    settlement: {
      grade: "candidate",
      why: "Counted from the chain by Tickerz with no third party in the path, so the number is Tickerz's own to license. The count is of creates, not of coins that traded; rulebook v0.2 adds a survival filter and the graduation line already prints beside it.",
      manipulation: "Cheap for the raw count: creating a coin costs about a transaction fee, so a bot can push creates. The graduation line costs real liquidity to move. A venue should settle on the line the rulebook names.",
      fallback: "If the RPC is down the hour is retried on the next run and the day stays open, marked provisional, and nothing settles. A day is complete at 00:00 UTC; a day that cannot be read is void.",
      precision: "Whole coins, one per successful create transaction, counted on the UTC day of its block time.",
      version: RULEBOOK_VERSION,
    },
  },
  {
    ticker: "GIGS",
    slug: "gigs",
    name: "Paid gigs over x402",
    counts: "Paid calls settled over x402 on Base, per UTC day, between paying wallets and the services they pay; whether a person, a script or an AI agent holds a wallet is not on the chain. Every USDC signed transfer (EIP-3009) on Base is counted from the chain; one transaction in sixteen, chosen by the low byte of keccak256(tx hash, block hash), is read in full. A payment counts when one of the 128 x402 facilitator wallets on the list settled it. A payer paying itself is left out. The level is the estimate, every signed transfer times the payments per sampled transaction; its 95% range prints beside it.",
    unit: ["gig", "gigs"],
    format: "count",
    source: {
      name: "Base mainnet, USDC signed transfers settled by x402 facilitators",
      url: "https://www.x402.org/",
      terms: "Public chain data read by Tickerz over Base's public JSON RPC. No vendor dataset. The facilitator list is from Merit-Systems/x402scan (MIT License). The count is Tickerz's own and is licensed by Tickerz.",
    },
    chain: { kind: "base_x402", series: "gigs" },
    cadence: "Hourly, from the chain; a day prints once it is complete",
    settlement: {
      grade: "display",
      why: "Counted by Tickerz from the chain with no vendor in the path, but estimated from a one in sixteen sample on a free public node. It becomes a candidate when every transaction is read.",
      manipulation: "Moderate. A payment costs a transaction and the amount paid, so pushing thousands of fake gigs costs real money and shows up as a few payers with many calls.",
      fallback: "An hour the node cannot serve is retried on the next run and the day stays open, so nothing settles. A day is complete once its 24 hours are read; a day that cannot be read is void.",
      precision: "Whole gigs, rounded from the estimate, with the 95% range beside it.",
      version: RULEBOOK_VERSION,
    },
  },
  {
    ticker: "WAGE",
    slug: "wage",
    name: "The machine wage",
    counts: "What a paying wallet paid per call, per UTC day: the payer-balanced median price of a settled x402 payment on Base. Each payer's median price first, weighted by its calls, then the median across payers, so one wallet firing thousands of calls counts once; the 25th and 75th percentiles print beside it. Every USDC signed transfer (EIP-3009) on Base is counted from the chain; one transaction in sixteen, chosen by the low byte of keccak256(tx hash, block hash), is read in full. A payment counts when one of the 128 x402 facilitator wallets on the list settled it. A payer paying itself is left out. No level prints on a day with fewer than 50 payers in the sample.",
    unit: ["dollar", "dollars"],
    format: "usd",
    source: {
      name: "Base mainnet, USDC signed transfers settled by x402 facilitators",
      url: "https://www.x402.org/",
      terms: "Public chain data read by Tickerz over Base's public JSON RPC. No vendor dataset. The facilitator list is from Merit-Systems/x402scan (MIT License). The count is Tickerz's own and is licensed by Tickerz.",
    },
    chain: { kind: "base_x402", series: "wage" },
    cadence: "Hourly, from the chain; a day prints once it is complete",
    settlement: {
      grade: "display",
      why: "A median of settled prices read from the chain by Tickerz, the machine version of a wage. Payer balanced, so one busy wallet cannot set it; many small wallets paying one service still can: on Oct 3 one service's $0.001 payers halved it. Estimated from a sample until the full count runs.",
      manipulation: "Moderate. Moving the median takes many distinct paying wallets, each paying real money.",
      fallback: "An hour the node cannot serve is retried on the next run and the day stays open, so nothing settles. A day with fewer than 50 sampled payers prints no level and is void.",
      precision: "US dollars to six decimals, the unit USDC settles in.",
      version: RULEBOOK_VERSION,
    },
  },
];

export function rulebookOf(ticker: string): Rulebook | null {
  const t = ticker.replace(/^\$/, "").toUpperCase();
  return RULEBOOKS.find((r) => r.ticker === t) ?? null;
}
