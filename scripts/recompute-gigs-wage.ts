/*
 * Recompute $GIGS and $WAGE for one UTC day from the Base chain, and set them beside what Tickerz printed.
 *
 *   npm run gigs -- 2026-10-03              all 24 hours: the day's GIGS with its 95% range, and its WAGE
 *   npm run gigs -- 2026-10-03 --hours 2    only the first 2 hours: a quick look at the method, no day level
 *
 * Each hour is read the way Tickerz reads it (readHour in src/machines.ts) over Base's free public node: every USDC
 * signed transfer (AuthorizationUsed) in the hour's blocks is counted from the logs, and the transactions in the one
 * in sixteen sample (low byte of keccak256(tx hash, block hash) under 16) are read receipt by receipt. Payments are
 * the signed transfers a listed facilitator sent (src/facilitators.ts). The day is the 24 hours added up (dayFromHours):
 * GIGS = signed transfers x (sampled payments / sampled transactions), with its 95% range; WAGE = the payer-balanced
 * median price of the sampled payments.
 *
 * The sample is fixed by the chain, so the same day read again gives the same numbers, unless the node returned a
 * different set of logs. Cost: about 40 to 60 requests an hour (two block searches, one or two log reads, one batch
 * per ten sampled receipts), roughly 1,200 for a day; Oct 3 2026 took about 15 minutes. Nothing is written anywhere.
 */
import { dayFromHours, readHour, type HourRead } from "../src/machines";
import { fetchLatestGigs } from "../src/gigsRange";
import { fetchPrinted, printedOn } from "../src/publicApi";

const args = process.argv.slice(2);
const day = args.find((a) => !a.startsWith("--"));
const hoursAt = args.indexOf("--hours");
const hoursWanted = hoursAt >= 0 ? Number(args[hoursAt + 1]) : 24;
const HOUR = 3_600_000;

if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || !Number.isInteger(hoursWanted) || hoursWanted < 1 || hoursWanted > 24) {
  console.error("Usage: npm run gigs -- YYYY-MM-DD [--hours N]   (a complete UTC day; N from 1 to 24, default 24)");
  process.exit(2);
}
const start = Date.parse(`${day}T00:00:00Z`);
if (start + 24 * HOUR > Date.now()) {
  console.error(`${day} is not over yet in UTC. Pick a complete day.`);
  process.exit(2);
}

const usd = (e6: number | null) => (e6 == null ? "-" : `$${(e6 / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`);

(async () => {
  const hours: HourRead[] = [];
  console.log("hour (UTC)          blocks              signed  sampled  x402 txs  payments");
  for (let h = 0; h < hoursWanted; h++) {
    const at = start + h * HOUR;
    const r = await readHour(at);
    hours.push(r);
    console.log(`${new Date(at).toISOString().slice(0, 13)}:00  ${`${r.fromBlock}-${r.toBlock}`.padEnd(18)}  ${String(r.signedTxs).padStart(6)}  ${String(r.sampledTxs).padStart(7)}  ${String(r.x402Txs).padStart(8)}  ${String(r.payments.length).padStart(8)}`);
  }

  if (hoursWanted < 24) {
    const sum = (k: "signedTxs" | "sampledTxs" | "x402Txs") => hours.reduce((s, h) => s + h[k], 0);
    const payments = hours.reduce((s, h) => s + h.payments.length, 0);
    console.log(`\n${hoursWanted} of 24 hours: ${sum("signedTxs")} signed transfers, ${sum("sampledTxs")} sampled, ${sum("x402Txs")} of them x402 payments carrying ${payments} payments.`);
    console.log("A day level needs all 24 hours: run without --hours.");
    return;
  }

  const d = dayFromHours(hours);
  console.log(`\nGIGS ${day}: ${d.gigs.gigs} (95% range ${d.gigs.low} to ${d.gigs.high})`);
  console.log(`  from ${d.totals.signedTxs} signed transfers; ${d.totals.sampledTxs} sampled, ${d.totals.x402Txs} of them x402 payments carrying ${d.totals.payments} payments`);
  console.log(`WAGE ${day}: ${d.wage == null ? `no level (${d.stats.payers} payers in the sample, under 50)` : usd(d.wage * 1e6)}  (p25 ${usd(d.stats.p25_e6)}, p75 ${usd(d.stats.p75_e6)}, ${d.stats.payers} payers, ${d.stats.payees} payees)`);

  try {
    const [g, w, latest] = await Promise.all([fetchPrinted("GIGS"), fetchPrinted("WAGE"), fetchLatestGigs()]);
    const pg = printedOn(g, day);
    const pw = printedOn(w, day);
    console.log(`\nTickerz printed for ${day}: GIGS ${pg ?? "-"}, WAGE ${pw ?? "-"}`);
    if (latest.period === day && latest.range) console.log(`  GIGS range as printed: ${latest.range.low} to ${latest.range.high}`);
    // WAGE prints to the precision it is published at; compare at six decimals, the unit USDC settles in.
    if (pg != null) console.log(`  GIGS ${pg === d.gigs.gigs ? "matches" : `differs by ${d.gigs.gigs - pg}`}`);
    if (pw != null && d.wage != null) console.log(`  WAGE ${Math.abs(pw - d.wage) < 5e-7 ? "matches" : `differs: recomputed ${d.wage}`}`);
  } catch (e) {
    console.error(`(could not read the published series: ${e instanceof Error ? e.message : e})`);
  }
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
