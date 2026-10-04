/*
 * Recount $MINTS (and its graduations line) from the Solana chain, and set it beside what Tickerz printed.
 *
 *   npm run mints -- 2026-10-03     every UTC day from 2026-10-03 to today
 *   npm run mints                   yesterday and today
 *
 * Pages getSignaturesForAddress on pump.fun's mint authority and its migrator, newest first, 1,000 a page, from now
 * back to 00:00 UTC on the day asked, over the public Solana JSON RPC (150 ms between pages, one retry after a 429,
 * the second public endpoint when the first refuses). Only successful, finalized signatures count, each on the UTC
 * day of its block time: the reader Tickerz runs every hour (src/mints.ts), here run once from scratch.
 *
 * Cost: about 55 pages per day of coin creations, plus the graduations account, so a day back is about a minute and a
 * week back several. Nothing is written anywhere.
 */
import { GRADUATIONS_ACCOUNT, MINTS_ACCOUNT, addDays, dayOf, fetchPoster, pageSignatures, solanaRpc, type Poster, type SigTally } from "../src/mints";
import { fetchPrinted, printedOn } from "../src/publicApi";

const now = Date.now();
const today = dayOf(now);
const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const first = arg ?? addDays(today, -1);
if (!/^\d{4}-\d{2}-\d{2}$/.test(first) || first > today || Number.isNaN(Date.parse(`${first}T00:00:00Z`))) {
  console.error("Usage: npm run mints -- YYYY-MM-DD   (a UTC day up to today; it is read from now back to that day)");
  process.exit(2);
}
if (first < addDays(today, -14)) {
  console.error(`${first} is more than 14 days back: about ${55 * Math.round((now - Date.parse(`${first}T00:00:00Z`)) / 864e5)} pages. Pick a later day.`);
  process.exit(2);
}

/** A long run meets a dropped connection or a busy minute: up to three more tries, 5 seconds apart, before the reader's own retry and fallback. */
const patient: Poster = async (url, body, opts) => {
  for (let i = 0; ; i++) {
    try {
      const res = await fetchPoster(url, body, opts);
      if ((res.status === 429 || res.status >= 500) && i < 3) { await new Promise((r) => setTimeout(r, 5_000)); continue; }
      return res;
    } catch (e) {
      if (i >= 3) throw e;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
};

async function readBack(label: string, account: string): Promise<SigTally> {
  const rpc = solanaRpc({ post: patient });
  const t0 = Date.now();
  let pages = 0;
  const r = await pageSignatures(rpc, { account, fromSec: Date.parse(`${first}T00:00:00Z`) / 1000, maxPages: 100_000 }, async (ms) => {
    pages++;
    if (pages % 25 === 0) console.error(`  ${label}: ${pages} pages, ${Math.round((Date.now() - t0) / 1000)}s`);
    await new Promise((res) => setTimeout(res, ms));
  });
  if (!r.complete) throw new Error(`${label}: read cut short`);
  console.error(`  ${label}: ${r.pages} pages, ${rpc.state.calls} calls, ${r.tally.failed} failed transactions left out, ${Math.round((Date.now() - t0) / 1000)}s`);
  return r.tally;
}

(async () => {
  console.error(`Reading ${MINTS_ACCOUNT} (creates) and ${GRADUATIONS_ACCOUNT} (graduations) back to ${first} 00:00 UTC.`);
  // One account at a time: the public endpoint's per-method limit is shared.
  const creates = await readBack("creates", MINTS_ACCOUNT);
  const grads = await readBack("graduations", GRADUATIONS_ACCOUNT);
  let printed: Awaited<ReturnType<typeof fetchPrinted>> | null = null;
  try {
    printed = await fetchPrinted("MINTS");
  } catch (e) {
    console.error(`  (could not read the published series: ${e instanceof Error ? e.message : e})`);
  }

  console.log("\nday          creates  printed    match  graduations");
  for (let d = first; d <= today; d = addDays(d, 1)) {
    const c = creates.days.get(d) ?? 0;
    const g = grads.days.get(d) ?? 0;
    const p = printed ? printedOn(printed, d) : null;
    const match = d === today ? "so far today" : p == null ? "-" : p === c ? "yes" : `off by ${c - p}`;
    console.log(`${d}  ${String(c).padStart(7)}  ${String(p ?? "-").padStart(7)}  ${match.padStart(7)}  ${String(g).padStart(11)}`);
  }
  if (printed?.companion) {
    const y = addDays(today, -1);
    console.log(`\nGraduations: Tickerz printed ${printed.companion.latest_complete ?? "-"} for the newest complete day; recounted ${grads.days.get(y) ?? 0} for ${y}.`);
  }
  console.log("\nToday's row is a running count. Tickerz reads it once an hour, so its print for today runs behind a fresh recount.");
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
