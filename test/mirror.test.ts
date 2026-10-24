/**
 * The mirror's rules (scripts/mirror.ts): the record only grows, a first print never changes, a revision may change the
 * value beside it, and periods that aged out of the settlement file stay here. Plain asserts, no network.
 * Run: node --import tsx test/mirror.test.ts
 */
import assert from "node:assert/strict";
import { agedOut, check, parseCsv, splitLines } from "../scripts/mirror";

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${name}`);
}

const HEAD = "ticker,period,value,settlement_value,revised,revised_on,band,z,proof_day,bitcoin_height,proof_url\n";
const proof = "2026-10-17,971861,https://tickerz.com/api/indices/proof?day=2026-10-17";
// LAYOFFS 2026-10-10 as this repo held it, and as the settlement file served it on 2026-10-24 after the Department of
// Labor revised the week: the value moved, the first print (settlement_value) did not.
const HELD = `LAYOFFS,2026-10-10,191033,191033,false,,Quiet,0.2,${proof}\n`;
const REVISED = `LAYOFFS,2026-10-10,191099,191033,true,2026-10-24,Quiet,0.2,${proof}\n`;
const rows = (text: string) => parseCsv(HEAD + text).slice(1);

ok("a revision changes the value beside an unchanged first print: clean", () => {
  assert.deepEqual(check("LAYOFFS", rows(HELD), rows(REVISED)), []);
});

ok("a changed first print fails, whatever the revision flag says", () => {
  const moved = REVISED.replace(",191033,true,", ",191034,true,");
  assert.deepEqual(check("LAYOFFS", rows(HELD), rows(moved)), ["LAYOFFS 2026-10-10: first print was 191033, the new file says 191034"]);
});

ok("a value that changes with no revision fails", () => {
  const quiet = REVISED.replace(",true,2026-10-24,", ",false,,");
  assert.deepEqual(check("LAYOFFS", rows(HELD), rows(quiet)), ["LAYOFFS 2026-10-10: value was 191033, the new file says 191099 with no revision"]);
});

ok("a period with no first print yet keeps its value", () => {
  const unsettled = "MINTS,2026-10-23,48973,,false,,Quiet,0.1,,,\n";
  assert.deepEqual(check("MINTS", rows(unsettled), rows(unsettled)), []);
  assert.deepEqual(check("MINTS", rows(unsettled), rows(unsettled.replace("48973", "48990"))), ["MINTS 2026-10-23: first print was 48973, the new file says 48990"]);
  assert.deepEqual(check("MINTS", rows(unsettled), rows(unsettled.replace("48973,,", "48973,48973,"))), [], "its first print arriving is not a change");
});

ok("a period missing from inside the new file's range fails; one older than its first period aged out", () => {
  const a = `LAYOFFS,2026-09-26,180000,180000,false,,Quiet,0.1,${proof}\n`;
  const b = `LAYOFFS,2026-10-03,185000,185000,false,,Quiet,0.1,${proof}\n`;
  assert.deepEqual(check("LAYOFFS", rows(a + b + HELD), rows(b + HELD)), [], "2026-09-26 aged out");
  assert.deepEqual(check("LAYOFFS", rows(a + b + HELD), rows(a + HELD)), ["LAYOFFS 2026-10-03: in this repo, missing from the new file"]);
});

ok("aged-out periods stay on top as this repo's own lines, under the new file's header", () => {
  const old = `${HEAD}LAYOFFS,2024-11-09,230008,230008,false,,,,${proof}\n${HELD}`;
  const fresh = `${HEAD}${REVISED}`;
  assert.equal(agedOut(old, fresh), `${HEAD}LAYOFFS,2024-11-09,230008,230008,false,,,,${proof}\n${REVISED}`);
  assert.equal(agedOut(fresh, fresh), fresh, "nothing older: the new file as it came");
});

ok("CSV and lines are read as Python reads them", () => {
  assert.deepEqual(parseCsv('a,"b,c","say ""hi"""\r\n\n,x\n'), [["a", "b,c", 'say "hi"'], [], ["", "x"]]);
  assert.deepEqual(splitLines("a\r\nb\nc"), ["a\r\n", "b\n", "c"]);
  assert.deepEqual(splitLines(""), []);
});

console.log(`\n${passed} passed`);
