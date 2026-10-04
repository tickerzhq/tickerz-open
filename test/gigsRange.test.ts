/**
 * The 95% range beside $GIGS: parsed from stored rows, and tied to the estimate it comes from. Plain asserts, no
 * network. Run: node --import tsx test/gigsRange.test.ts
 */
import assert from "node:assert/strict";
import { gigsRange, gigsRangesFromRows } from "../src/gigsRange";
import { estimateGigs } from "../src/machines";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${name}`);
}

check("a range needs both ends as finite numbers; numeric text is read, anything else is no range", () => {
  assert.deepEqual(gigsRange(78963, 80515), { low: 78963, high: 80515, level: 0.95 });
  assert.deepEqual(gigsRange("78963", "80515"), { low: 78963, high: 80515, level: 0.95 });
  assert.equal(gigsRange(null, 80515), null);
  assert.equal(gigsRange(78963, ""), null);
  assert.equal(gigsRange("n/a", 1), null);
  assert.equal(gigsRange(undefined, undefined), null);
});

check("ranges by UTC day from stored rows, a timestamped day cut to its date, an empty row left out", () => {
  const m = gigsRangesFromRows([
    { day: "2026-10-03", gigs_low: 78963, gigs_high: 80515 },
    { day: "2026-10-02T00:00:00+00:00", gigs_low: "49800", gigs_high: "51270" },
    { day: "2026-10-01", gigs_low: null, gigs_high: null },
  ]);
  assert.deepEqual([...m.keys()], ["2026-10-03", "2026-10-02"]);
  assert.deepEqual(m.get("2026-10-02"), { low: 49800, high: 51270, level: 0.95 });
});

check("the range is the estimate's: it brackets the level, and narrows as the sample grows", () => {
  const small = estimateGigs({ signedTxs: 100_000, sampledTxs: 1_000, x402Txs: 800, payments: 820 });
  const large = estimateGigs({ signedTxs: 100_000, sampledTxs: 6_250, x402Txs: 5_000, payments: 5_125 });
  for (const e of [small, large]) assert.ok(e.low <= e.gigs && e.gigs <= e.high, JSON.stringify(e));
  assert.ok(large.high - large.low < small.high - small.low);
  // Read in full (every transaction sampled) there is nothing left to estimate: the range closes on the count.
  const full = estimateGigs({ signedTxs: 4_662, sampledTxs: 4_662, x402Txs: 4_000, payments: 4_044 });
  assert.deepEqual(full, { gigs: 4_044, low: 4_044, high: 4_044 });
});

console.log(`\n${passed} passed`);
