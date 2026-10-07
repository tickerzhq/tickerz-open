/**
 * Everything gets a ticker. The indices Tickerz computes from public data, one definition each.
 *
 * Pure data. Its one import is the level formatters (format.ts, which has none), so pages, client components, API
 * routes, the cron and the tests share one list.
 * A definition says what the number counts, where it comes from, how late the source is, how long a period is,
 * which baseline scores it, whether calls are taken on it, and which listed stocks and tokens it touches.
 *
 * The see-only rule, locked 2026-09-23: see-only for deaths and violent crime; everything people choose to do can be
 * called. The harm flag implements it: an index that counts harm to people (crime, deaths, overdoses) sets
 * harm, is published (SEE) and never called (PREDICT). No index carries it since $CRIME was retired on
 * 2026-10-05; the rule and its test stay for any future one. The test in
 * src/lib/__tests__/indices.test.ts holds that predict is off wherever harm is set, however fast the source is, and
 * that any index whose text mentions crime, deaths or overdoses carries the flag. No index on suicide, and no index
 * or call on a specific person.
 *
 * The ticker set was locked on 2026-09-23. The AI race ticker was named MODELS the same day, after a collision check:
 * the AGI placeholder is Alamos Gold on the NYSE and a token of size; MODELS was retired on 2026-10-06 (its Hugging
 * Face source is not clean for settlement). On 2026-10-01 the three indexes read from
 * Wikipedia pageviews (GOON, SINGLE, TILT) were removed: lookups of an article settle nothing. YESNO, prediction
 * market volume, took TILT's place (ODDS is a Pacer ETF, BETS a Nasdaq listing).
 */

export type SourceKind =
  | { kind: "wikimedia"; articles: string[] }
  | { kind: "socrata"; domain: string; dataset: string; dateField: string; where?: string }
  | { kind: "hf_trending"; limit: number }
  | { kind: "defillama_fees"; slugs: string[] }
  | { kind: "defillama_volume"; slugs: string[] }
  | { kind: "dol_claims" }
  /**
   * Successful transactions on a Solana account, counted per UTC day from the chain over the public JSON RPC, read
   * forward from a stored cursor (chain_cursors). `graduations` is a second account counted the same way into the
   * companion series.
   */
  | { kind: "solana_sigs"; account: string; graduations?: string }
  /**
   * Settled x402 agent payments on Base (src/lib/indices/machines.ts), read hour by hour by /api/cron/machines and
   * written as complete days. gigs: paid calls. wage: the payer-balanced median price of a paid call.
   */
  | { kind: "base_x402"; series: "gigs" | "wage" }
  /**
   * One series from the Bureau of Labor Statistics public API v1. All BLS indexes are read in one POST
   * (src/lib/indices/bls.ts). change_x1000: the month's difference in a level published in thousands, times 1,000.
   * level: the published figure at one decimal. pct_mom_1dp: the percent change from the previous month's published index.
   * release: the news release that carries the series (blsSchedule.ts): the Employment Situation or the Consumer Price Index.
   */
  | { kind: "bls"; series: string; transform: "change_x1000" | "level" | "pct_mom_1dp"; release: "empsit" | "cpi" };

/**
 * How far a venue can lean on an index, in the founder's words, for the Resolution section and the API.
 * candidate: could settle a listed contract once the open item in why is cleared. reference: a public series a venue
 * can read itself; Tickerz adds the score and the record. display: for reading only; the inputs are cheap to move.
 */
export type SettlementGrade = "candidate" | "reference" | "display";

export type Settlement = {
  grade: SettlementGrade;
  /** Why this grade, in one or two plain sentences. */
  why: string;
  /** The cost to move one day's reading, in plain words. */
  manipulation: string;
  /** What happens when the source is late (the period stays open) or never lands (void). */
  fallback: string;
  /** The unit and the rounding. */
  precision: string;
  /** The rulebook the words belong to. */
  version: string;
};

export const RULEBOOK_VERSION = "Rulebook v0.2, 2026-10-04";
/** $WAGE's own dated rule change on top of the rulebook (issue #693). Keep the date equal to WAGE_RULE_V2_FROM in machines.ts. */
/**
 * $YESNO's own dated rule change: from the Oct 6 2026 print a day waits until both venues have the day after it.
 * DefiLlama served Polymarket's newest day while it was still filling in, so the first prints for Oct 2 and Oct 3
 * came out 14 and 18 percent low and were revised up the next day (Oct 2: $551.6M first, $643.9M now; Oct 3: $564.1M
 * first, $686.7M now). One venue's day was still filling in when it was read.
 */
export const YESNO_RULE_V2_FROM = "2026-10-06";
export const YESNO_RULE_VERSION = `${RULEBOOK_VERSION}, $YESNO rule v2 from ${YESNO_RULE_V2_FROM}`;
export const WAGE_RULE_VERSION = `${RULEBOOK_VERSION}, $WAGE rule v2 from 2026-10-05`;

/**
 * A complete $GIGS or $WAGE day is marked thin when sampled payers are under this share of the
 * median of the earlier complete days, at most THIN_LOOKBACK_DAYS of them. Fewer than
 * THIN_MIN_HISTORY earlier days is not marked. The level stays. The share is fixed before the
 * days it marks. Evidence: docs/GIGS Thin Day Rule 2026-10-04.md.
 */
export const THIN_PRIOR_SHARE = 0.7;
export const THIN_LOOKBACK_DAYS = 28;
export const THIN_MIN_HISTORY = 14;

const THIN_PRECISION = `A day is marked thin when sampled paying wallets are under ${Math.round(THIN_PRIOR_SHARE * 100)}% of the median of the ${THIN_LOOKBACK_DAYS} complete days before it, once ${THIN_MIN_HISTORY} earlier days are on file, and the level still prints.`;

export type IndexDef = {
  /** Without the $. Upper case. The key in index_levels. */
  ticker: string;
  /** The URL segment: /x/{slug}. */
  slug: string;
  name: string;
  /** One line: what the number counts. Plain, no adjectives. */
  counts: string;
  /**
   * The named parts of a composite, in the order the source is read, for the fact grid. Set only where the counts
   * line does not already name them: a reader, or a venue writing a rulebook, must be able to see what is added up.
   */
  constituents?: string[];
  /** The unit after the number, singular and plural. */
  unit: [string, string];
  format: "count" | "usd" | "percent";
  source: {
    name: string;
    /** The page a reader can check. */
    url: string;
    /** License or terms, as short as the source allows. */
    terms: string;
    /** The terms page, when the terms line names one. */
    termsUrl?: string;
    /** Text a source requires beside its data, verbatim, or the notice its terms ask for. */
    attribution?: string;
    /**
     * Set when the source's terms license display to people on tickerz.com but not passing the data on. The API
     * then serves the score without the levels, and says why in these words. No index uses it now.
     */
    withheld?: string;
  };
  fetch: SourceKind;
  /** How the source publishes, in words, for the source line. */
  cadence: string;
  /**
   * Days per period. 1: one row per UTC day (or the city's own date). 7: one row per week, keyed by the Saturday
   * the week ends on, the way the Department of Labor reports claims. "month": one row per calendar month, keyed
   * by the first of that month, YYYY-MM-01.
   */
  step: 1 | 7 | "month";
  /**
   * Baseline the score reads against. daily: the prior 30 days, 14 minimum (the Terminal's rule).
   * weekday: the same weekday in the prior 8 weeks, 5 minimum, for series with a weekly shape (a Saturday is
   * compared with Saturdays), the way stocks are scored against the same point in the session.
   * weekly: the prior 26 weeks, 14 minimum, for a series of one number per week.
   * monthly: the prior 24 months, 12 minimum, for a series of one number per month.
   */
  baseline: "daily" | "weekday" | "weekly" | "monthly";
  /**
   * The newest dates in the source that are still filling in and are left out. Chicago's newest two dates are
   * partial (records land over about a week), NYC 311's newest date is partial, Wikimedia returns complete days.
   */
  trailingPartial: number;
  /**
   * Live sources are read every hour and keep one row per UTC day: the highest reading of the day. The current
   * day is shown as "so far today" and scored only once the day is over. A chain count (solana_sigs) is a running
   * count that only rises, so its highest reading is the count so far.
   */
  live: boolean;
  /** The level is the day-over-day difference of the reading, not the reading itself. No index uses it now. */
  diff?: boolean;
  /**
   * Set where the level is itself a rate or a change: a percent, or a month's gain that can be a loss. A percent
   * change of such a number misleads (0.1 to 0.4 percent would read "up 300%", and -10,000 to 133,000 jobs "down
   * 1,430%"), so none is shown, and the move the score reads is the difference from the period before, in the
   * index's own unit. The four Bureau of Labor Statistics indexes set it.
   */
  moves?: "difference";
  /** Read at most once in this many hours (a large file that changes weekly). */
  everyHours?: number;
  /** Days of history read on each run. The first run is the backfill. */
  window: number;
  /**
   * Hold back, and report, any new or revised period above this multiple of the trailing median (the same weekday
   * on a weekday baseline). For a series where a doubling means a bad file, not a busy day. No index sets it now;
   * a fees or claims file may need it later.
   */
  guard?: number;
  /** Counts harm to people: violent crime, or deaths. Published, never called. */
  harm?: true;
  /**
   * Calls are taken on a period that has not started when calls close (predict.ts). A daily index: every day, on
   * tomorrow, closing at 00:00 UTC. A weekly index: every week, on the week after this one, closing at 00:00 UTC on
   * the Sunday it begins. No part of the period called is public while calls are open, whatever the source:
   * Wikimedia's hourly files run about 3 hours behind, a live source's reading of the day only goes up, and the
   * claims file lands about ten days after each week. A daily source that lands days late is SEE and listed names
   * only. A count of harm to people is never called.
   */
  predict: { on: true } | { on: false; why: string };
  /**
   * Listed stocks and tokens in the same business. Linked when they are on the Terminal, plain text otherwise. No
   * link between an index and these prices has been measured.
   */
  linked: string[];
  /**
   * A second series stored beside the level under its own key in index_levels (not an index of its own: not scored,
   * never called), printed as one line under the level and sealed with it.
   */
  companion?: { ticker: string; label: string };
  /** The page a venue can paste into a rulebook: grade, cost to move, fallback, precision (Resolution on /x/{slug}). */
  settlement: Settlement;
};


const MACHINE_SOURCE = {
  name: "Base mainnet, USDC signed transfers settled by x402 facilitators",
  url: "https://www.x402.org/",
  terms: "Public chain data read by Tickerz over Base's public JSON RPC. No vendor dataset. The facilitator list is from Merit-Systems/x402scan (MIT License). The count is Tickerz's own and is licensed by Tickerz.",
};

const MACHINE_METHOD =
  "Every USDC signed transfer (EIP-3009) on Base is counted from the chain; one transaction in sixteen, chosen by the low byte of keccak256(tx hash, block hash), is read in full. A payment counts when one of the 128 x402 facilitator wallets on the list settled it. A payer paying itself is left out.";

export const INDICES: IndexDef[] = [
  {
    ticker: "LAYOFFS",
    slug: "layoffs",
    name: "US initial jobless claims",
    counts: "People filing a first claim for unemployment insurance in the week, added across the 50 states, DC, Puerto Rico and the Virgin Islands. Not seasonally adjusted. The week ends Saturday.",
    unit: ["claim", "claims"],
    format: "count",
    source: {
      name: "US Department of Labor, ETA 539 weekly claims file, state rows",
      url: "https://oui.doleta.gov/unemploy/claims.asp",
      terms: "US government work, public domain.",
    },
    fetch: { kind: "dol_claims" },
    cadence: "Weekly. The states' file lands about ten days after the week ends.",
    step: 7,
    baseline: "weekly",
    trailingPartial: 0,
    live: false,
    // A 13 MB file that changes once a week: read once a day, at 06:40 UTC, never in the seal run.
    everyHours: 24,
    window: 700,
    predict: { on: true },
    linked: [],
    settlement: {
      grade: "reference",
      why: "A government series. A venue can read the Department of Labor file directly and settle on it. Tickerz adds the score and the record, not the number.",
      manipulation: "Not practical. Moving a week means filing unemployment claims with state agencies, by the thousand.",
      fallback: "The states' file lands about ten days after the week ends. Until all 53 jurisdictions are in it, the week stays open. A week that never lands is void.",
      precision: "Whole claims, not seasonally adjusted, summed across 53 jurisdictions. The week ends Saturday. No rounding.",
      version: RULEBOOK_VERSION,
    },
  },
  {
    // Replaced $TILT (Wikipedia pageviews of four betting and prediction venues) on 2026-10-01: money traded, not
    // lookups. $TILT's history stays in the database under its own ticker.
    ticker: "YESNO",
    slug: "yesno",
    name: "Prediction market volume",
    counts: "Dollars traded per day on Kalshi and Polymarket, added together, as DefiLlama counts each venue's notional volume.",
    constituents: ["Kalshi", "Polymarket"],
    unit: ["dollar", "dollars"],
    format: "usd",
    source: {
      name: "DefiLlama, daily notional volume of Kalshi and Polymarket",
      url: "https://defillama.com/protocols/prediction-market",
      terms: "DefiLlama open API. Volumes are computed and published by DefiLlama; Tickerz adds the two venues once an hour.",
      termsUrl: "https://api-docs.defillama.com/",
      attribution: "Volume figures are computed and published by DefiLlama.",
    },
    // The venues by DefiLlama slug, in the order of `constituents`.
    fetch: { kind: "defillama_volume", slugs: ["kalshi", "polymarket"] },
    cadence: "Daily, two days late",
    step: 1,
    baseline: "daily",
    // Rule v2: the newest day both venues have is still filling in at DefiLlama, so it is left out until the next one lands.
    trailingPartial: 1,
    live: false,
    window: 130,
    predict: { on: true },
    linked: ["HOOD", "ICE", "CME", "DKNG"],
    settlement: {
      grade: "candidate",
      why: "Money traded on two venues, one regulated by the CFTC. Moving the number means trading, and paying the venues' fees, in public. Not for settlement yet: DefiLlama's terms bar commercial use without its written consent, and Kalshi's data terms bar building an index on its volume without Kalshi's. No source with clean terms has been found (checked Oct 5 2026).",
      manipulation: "Expensive. Adding a dollar of volume means trading a dollar of contracts on Kalshi or Polymarket.",
      fallback: "DefiLlama publishes a day about a day late and keeps filling it in for hours after. From Oct 6 2026 a day prints only once both venues also have the day after it, about two days late. Until then it stays open and nothing settles. A day that never lands is void.",
      precision: "US dollars of notional volume, as DefiLlama reports each venue, summed and rounded to the cent.",
      version: YESNO_RULE_VERSION,
    },
  },
  {
    ticker: "TRENCHES",
    slug: "trenches",
    name: "Memecoin launchpad fees",
    counts: "Fees paid on memecoin launchpads per day, in dollars, added across thirteen launchpads on Solana, BNB Chain, Base, Tron and other chains, as DefiLlama counts them.",
    // Display names, one per slug below, in the same order.
    constituents: ["pump.fun", "Raydium LaunchLab", "Bonk.fun", "Flap", "Graphite Protocol", "Meteora Dynamic Bonding Curve", "Four.meme", "Clanker", "Moonshot", "Jupiter Studio", "Bags", "Zora Coins", "SunPump"],
    unit: ["dollar", "dollars"],
    format: "usd",
    source: {
      name: "DefiLlama, daily fees by protocol, Launchpad category",
      url: "https://defillama.com/fees/chains",
      terms: "DefiLlama open API. Fees are computed and published by DefiLlama; Tickerz adds up the launchpads listed on this page once an hour.",
      termsUrl: "https://api-docs.defillama.com/",
      attribution: "Fee figures are computed and published by DefiLlama.",
    },
    // The launchpads by DefiLlama slug, in the order of `constituents`, which names them on the page.
    fetch: {
      kind: "defillama_fees",
      slugs: [
        "pump.fun",
        "launchlab",
        "bonk.fun-launchpad",
        "flap-sh",
        "graphite-protocol",
        "meteora-dynamic-bonding-curve",
        "four.meme",
        "clanker",
        "moonshot-create",
        "jupiter-studio",
        "bags",
        "zora-coins",
        "sunpump",
      ],
    },
    cadence: "Daily, one day late",
    step: 1,
    baseline: "daily",
    trailingPartial: 0,
    live: false,
    window: 130,
    predict: { on: true },
    linked: ["HOOD", "COIN", "SOL", "BNB", "PUMP", "BONK"],
    settlement: {
      grade: "candidate",
      why: "Fees are money paid on chain, so moving the number costs the fees themselves. Not for settlement yet: DefiLlama's terms bar commercial use without its written consent, and reading the thirteen launchpads' fees from their chains needs a node whose terms allow it (checked Oct 5 2026). The thirteen constituents are named on this page; a change to them is a new rulebook version.",
      manipulation: "Expensive. Adding a dollar to the day means paying a dollar in launchpad fees, in public.",
      fallback: "DefiLlama publishes a day about a day late. Until the day lands, it stays open and nothing settles. A day that never lands is void.",
      precision: "US dollars, as DefiLlama reports each launchpad, summed across the thirteen and rounded to the cent.",
      version: RULEBOOK_VERSION,
    },
  },
  {
    // The index Tickerz owns outright: counted from the chain by Tickerz, no vendor dataset in the path. The accounts
    // are from pump-fun/pump-public-docs: the mint authority PDA signs only create transactions on the bonding curve
    // program (6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P); the migrator holds graduations, where many competing
    // attempts fail, so only successful signatures count on both.
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
    fetch: { kind: "solana_sigs", account: "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM", graduations: "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg" },
    cadence: "Hourly, from the chain",
    step: 1,
    baseline: "daily",
    trailingPartial: 0,
    live: true,
    window: 60,
    predict: { on: true },
    linked: ["PUMP", "SOL", "BONK"],
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
    counts: `Paid calls settled over x402 on Base, per UTC day, between paying wallets and the services they pay; whether a person, a script or an AI agent holds a wallet is not on the chain. ${MACHINE_METHOD} The level is the estimate, every signed transfer times the payments per sampled transaction; its 95% range prints beside it.`,
    unit: ["gig", "gigs"],
    format: "count",
    source: MACHINE_SOURCE,
    fetch: { kind: "base_x402", series: "gigs" },
    cadence: "Hourly, from the chain; a day prints once it is complete",
    step: 1,
    baseline: "daily",
    trailingPartial: 0,
    live: false,
    window: 45,
    predict: { on: true },
    linked: ["COIN"],
    settlement: {
      grade: "display",
      why: "Counted by Tickerz from the chain with no vendor in the path, but estimated from a one in sixteen sample on a free public node. It becomes a candidate when every transaction is read.",
      manipulation: "Moderate. A payment costs a transaction and the amount paid, so pushing thousands of fake gigs costs real money and shows up as a few payers with many calls.",
      fallback: "An hour the node cannot serve is retried on the next run and the day stays open, so nothing settles. A day is complete once its 24 hours are read; a day that cannot be read is void.",
      precision: `Whole gigs, rounded from the estimate, with the 95% range beside it. ${THIN_PRECISION}`,
      version: RULEBOOK_VERSION,
    },
  },
  {
    ticker: "WAGE",
    slug: "wage",
    name: "The machine wage",
    counts: `What a paying wallet paid per call, per UTC day: the payer-balanced median price of a settled x402 payment on Base. Each payer's median price first, weighted by its calls, then the median across payers, so one wallet firing thousands of calls counts once. From October 5 2026 (rule v2) the payers of any one service hold at most 5% of that vote, so a fleet of wallets paying one service cannot set it either; days before keep their print. The 25th and 75th percentiles print beside it, on the same vote. ${MACHINE_METHOD} No level prints on a day with fewer than 50 payers in the sample.`,
    unit: ["dollar", "dollars"],
    format: "usd",
    source: MACHINE_SOURCE,
    fetch: { kind: "base_x402", series: "wage" },
    cadence: "Hourly, from the chain; a day prints once it is complete",
    step: 1,
    baseline: "daily",
    trailingPartial: 0,
    live: false,
    window: 45,
    predict: { on: true },
    linked: ["COIN"],
    settlement: {
      grade: "display",
      why: "A median of settled prices read from the chain by Tickerz, the machine version of a wage. Payer balanced, so one busy wallet cannot set it. Under rule v1 many small wallets paying one service could: on Oct 3 one service's $0.001 payers printed $0.0050, against $0.0102 without them. Rule v2 holds any one service's payers to 5% of the vote. Estimated from a sample until the full count runs.",
      manipulation: "Moderate. Moving the median takes many distinct paying wallets, each paying real money, spread across many services: one service's payers count for at most 5% of the vote.",
      fallback: "An hour the node cannot serve is retried on the next run and the day stays open, so nothing settles. A day with fewer than 50 sampled payers prints no level and is void.",
      precision: `US dollars to six decimals, the unit USDC settles in. ${THIN_PRECISION} Fewer than 50 still prints no level.`,
      version: WAGE_RULE_VERSION,
    },
  },
  {
    ticker: "JOBS",
    slug: "jobs",
    name: "US nonfarm payrolls",
    counts: "The monthly change in total nonfarm payroll employment in the United States, seasonally adjusted, in jobs. The Bureau of Labor Statistics publishes the level in thousands. This index stores the change from the previous month, in jobs.",
    unit: ["job", "jobs"],
    format: "count",
    source: {
      name: "US Bureau of Labor Statistics, Current Employment Statistics, series CES0000000001",
      url: "https://data.bls.gov/timeseries/CES0000000001",
      terms: "US government work, public domain.",
      termsUrl: "https://www.bls.gov/bls/linksite.htm",
    },
    fetch: { kind: "bls", series: "CES0000000001", transform: "change_x1000", release: "empsit" },
    moves: "difference",
    cadence: "Monthly. The Bureau publishes at 8:30 ET, usually the first Friday. Read at 12:35, 13:35 and 14:35 UTC on weekdays.",
    step: "month",
    baseline: "monthly",
    trailingPartial: 0,
    live: false,
    window: 800,
    predict: { on: false, why: "Calls stay off until Tickerz has read a month on the day it was published. History loaded at launch is the Bureau's current figure, not the number as first published." },
    linked: [],
    settlement: {
      grade: "reference",
      why: "The Bureau of Labor Statistics publishes the number, and a venue can read it. Tickerz keeps the first number of each month it reads at release. The Bureau revises the prior two months with each release and benchmarks payrolls once a year.",
      manipulation: "Not practical. Moving the month means changing the establishment survey the Bureau runs.",
      fallback: "A month that has not been published stays open. A month the Bureau never publishes is void. A revision is shown beside the number as first published.",
      precision: "Whole jobs. The Bureau publishes the level in thousands. The index is this month's level minus the previous month's level in the same release, times 1,000.",
      version: RULEBOOK_VERSION,
    },
  },
  {
    ticker: "UNEMP",
    slug: "unemp",
    name: "US unemployment rate",
    counts: "The US unemployment rate, U-3, seasonally adjusted, in percent to one decimal.",
    unit: ["percent", "percent"],
    format: "percent",
    source: {
      name: "US Bureau of Labor Statistics, Current Population Survey, series LNS14000000",
      url: "https://data.bls.gov/timeseries/LNS14000000",
      terms: "US government work, public domain.",
      termsUrl: "https://www.bls.gov/bls/linksite.htm",
    },
    fetch: { kind: "bls", series: "LNS14000000", transform: "level", release: "empsit" },
    moves: "difference",
    cadence: "Monthly. The Bureau publishes at 8:30 ET, with the employment situation. Read at 12:35, 13:35 and 14:35 UTC on weekdays.",
    step: "month",
    baseline: "monthly",
    trailingPartial: 0,
    live: false,
    window: 800,
    predict: { on: false, why: "Calls stay off until Tickerz has read a month on the day it was published. History loaded at launch is the Bureau's current figure, not the number as first published." },
    linked: [],
    settlement: {
      grade: "reference",
      why: "The Bureau of Labor Statistics publishes the rate, and a venue can read it. Tickerz keeps the first number of each month it reads at release. The Bureau does not revise the rate month to month. It sets the seasonal factors again each January, and that can move the last five years.",
      manipulation: "Not practical. Moving the month means changing the household survey the Bureau runs.",
      fallback: "A month that has not been published stays open. A month the Bureau never publishes is void. A revision is shown beside the number as first published.",
      precision: "Percent, one decimal, as published.",
      version: RULEBOOK_VERSION,
    },
  },
  {
    ticker: "CPI",
    slug: "cpi",
    name: "US CPI, month over month",
    counts: "The month over month percent change in the US Consumer Price Index for all urban consumers, seasonally adjusted, one decimal, computed from the published index.",
    unit: ["percent", "percent"],
    format: "percent",
    source: {
      name: "US Bureau of Labor Statistics, Consumer Price Index, series CUSR0000SA0",
      url: "https://data.bls.gov/timeseries/CUSR0000SA0",
      terms: "US government work, public domain.",
      termsUrl: "https://www.bls.gov/bls/linksite.htm",
    },
    fetch: { kind: "bls", series: "CUSR0000SA0", transform: "pct_mom_1dp", release: "cpi" },
    moves: "difference",
    cadence: "Monthly. The Bureau publishes at 8:30 ET, usually the second week. Read at 12:35, 13:35 and 14:35 UTC on weekdays.",
    step: "month",
    baseline: "monthly",
    trailingPartial: 0,
    live: false,
    window: 800,
    predict: { on: false, why: "Calls stay off until Tickerz has read a month on the day it was published. History loaded at launch is the Bureau's current figure, not the number as first published." },
    linked: [],
    settlement: {
      grade: "reference",
      why: "The Bureau of Labor Statistics publishes the index, and a venue can read it. Tickerz keeps the first percent change of each month it reads at release. The Bureau sets the seasonal factors again each February and revises the last five years of the seasonally adjusted index.",
      manipulation: "Not practical. Moving the month means changing the prices the Bureau collects.",
      fallback: "A month that has not been published stays open. A month the Bureau never publishes is void. A revision is shown beside the number as first published.",
      precision: "Percent, one decimal, half away from zero, computed from the index the Bureau publishes to three decimals. The Bureau's public API carries the index and not the percent change, so a venue should check the figure against the Bureau's release.",
      version: RULEBOOK_VERSION,
    },
  },
  {
    ticker: "CORECPI",
    slug: "corecpi",
    name: "US core CPI, month over month",
    counts: "The month over month percent change in the US Consumer Price Index for all items less food and energy, seasonally adjusted, one decimal, computed from the published index.",
    unit: ["percent", "percent"],
    format: "percent",
    source: {
      name: "US Bureau of Labor Statistics, Consumer Price Index, series CUSR0000SA0L1E",
      url: "https://data.bls.gov/timeseries/CUSR0000SA0L1E",
      terms: "US government work, public domain.",
      termsUrl: "https://www.bls.gov/bls/linksite.htm",
    },
    fetch: { kind: "bls", series: "CUSR0000SA0L1E", transform: "pct_mom_1dp", release: "cpi" },
    moves: "difference",
    cadence: "Monthly. The Bureau publishes at 8:30 ET, with the Consumer Price Index. Read at 12:35, 13:35 and 14:35 UTC on weekdays.",
    step: "month",
    baseline: "monthly",
    trailingPartial: 0,
    live: false,
    window: 800,
    predict: { on: false, why: "Calls stay off until Tickerz has read a month on the day it was published. History loaded at launch is the Bureau's current figure, not the number as first published." },
    linked: [],
    settlement: {
      grade: "reference",
      why: "The Bureau of Labor Statistics publishes the index, and a venue can read it. Tickerz keeps the first percent change of each month it reads at release. The Bureau sets the seasonal factors again each February and revises the last five years of the seasonally adjusted index.",
      manipulation: "Not practical. Moving the month means changing the prices the Bureau collects.",
      fallback: "A month that has not been published stays open. A month the Bureau never publishes is void. A revision is shown beside the number as first published.",
      precision: "Percent, one decimal, half away from zero, computed from the index the Bureau publishes to three decimals. The Bureau's public API carries the index and not the percent change, so a venue should check the figure against the Bureau's release.",
      version: RULEBOOK_VERSION,
    },
  },
];

/** Slugs of the first prototype that continue as a ticker of this set. Old links redirect to the new page. */
export const SLUG_ALIASES: Record<string, string> = {
  predict: "yesno",
};

/**
 * Slugs with no successor: the first prototype's; $RATS, removed September 24 2026; and $GOON, $SINGLE and $TILT,
 * removed October 1 2026 with their Wikipedia pageview source; $CRIME (Chicago only, which nobody settles on),
 * retired October 5 2026; and $MODELS with its old slugs hftrend and agi, retired October 6 2026 (the Hugging Face
 * trending score is not a clean source to settle on). Their pages redirect to /x; their history stays.
 */
export const RETIRED_SLUGS: readonly string[] = ["cannabis-ma", "nycnoise", "steam", "ghai", "rats", "nycrats", "goon", "onlyfans", "porntraffic", "single", "tilt", "crime", "chicrime", "models", "hftrend", "agi"];

/** The index for a URL segment: its slug, its ticker, or an old slug that continues as it (SLUG_ALIASES). */
export function indexBySlug(slug: string): IndexDef | null {
  const s = slug.toLowerCase();
  const target = SLUG_ALIASES[s] ?? s;
  return INDICES.find((d) => d.slug === target || d.ticker.toLowerCase() === target) ?? null;
}

/** Whether a URL segment is a retired slug of the first prototype (or its old ticker, CANNABIS.MA). */
export function isRetiredSlug(slug: string): boolean {
  const s = slug.toLowerCase().replace(/\./g, "-");
  return RETIRED_SLUGS.includes(s);
}

export function indexByTicker(ticker: string): IndexDef | null {
  const t = ticker.replace(/^\$/, "").toUpperCase();
  return INDICES.find((d) => d.ticker === t) ?? null;
}

/** Retired tickers that counted harm to people. Frozen history (past Closes, cards, emails) still carries their rows. */
export const RETIRED_SEE_ONLY: readonly string[] = ["CRIME"];

/**
 * Whether a row's ticker is see only: a live index with the harm flag, or a retired one that had it, so a past Close
 * replayed after $CRIME's retirement (2026-10-05) never leads with it or offers it as a call.
 */
export function seeOnlyTicker(ticker: string): boolean {
  const t = ticker.replace(/^\$/, "").toUpperCase();
  return Boolean(indexByTicker(t)?.harm) || RETIRED_SEE_ONLY.includes(t);
}

/** A level as the API may serve it: null when the source's terms keep levels out of the API (source.withheld). */
export function apiLevel(def: Pick<IndexDef, "source">, v: number | null | undefined): number | null {
  return def.source.withheld || v == null ? null : v;
}

/** The grade word shown after the name on the board: "see only" for a count of harm to people, the grade otherwise. */
export function gradeWord(def: Pick<IndexDef, "harm" | "settlement">): string {
  return def.harm ? "see only" : def.settlement.grade;
}

/** The level formatters live in format.ts, which has no imports, so client code can use them without the registry. */
export { formatExact, formatLevel } from "./format";
