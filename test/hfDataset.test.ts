/**
 * The open dataset's rules (scripts/hf-dataset.ts): only clean rights go out, and a row is marked as first published
 * only when Tickerz read it when it came out. Plain asserts, no network.
 * Run: node --import tsx test/hfDataset.test.ts
 */
import assert from "node:assert/strict";
import { COLUMNS, asFirstPublished, card, isOpen, parseCsv, periodEnd, toDatasetCsv } from "../scripts/hf-dataset";

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${name}`);
}

ok("only clean rights are published", () => {
  assert.equal(isOpen({ status: "clean", url: "", clause: "" }), true);
  assert.equal(isOpen({ status: "consent_needed", url: "", clause: "" }), false);
  assert.equal(isOpen({ status: "blocked", url: "", clause: "" }), false);
  assert.equal(isOpen(undefined), false);
});

ok("a month ends on its last day; a day and a week end on their label", () => {
  assert.equal(periodEnd("2026-10-01", "month"), "2026-10-31");
  assert.equal(periodEnd("2024-02-01", "month"), "2024-02-29");
  assert.equal(periodEnd("2026-12-01", "month"), "2026-12-31");
  assert.equal(periodEnd("2026-11-07", "week"), "2026-11-07");
  assert.equal(periodEnd("2026-11-16", "day"), "2026-11-16");
});

// $BITE as served on 2026-11-18: history loaded on 2026-11-13, the day it started.
const BITE = `ticker,period,value,settlement_value,revised,revised_on,band,z,proof_day,bitcoin_height,proof_url
BITE,2026-11-01,900,900,false,,Quiet,0.1,2026-12-03,,https://tickerz.com/api/indices/proof?day=2026-12-03
BITE,2020-01-01,700,700,false,,,,2026-11-13,975682,https://tickerz.com/api/indices/proof?day=2026-11-13
BITE,2026-10-01,875,875,false,,Quiet,-0.9,2026-11-16,,https://tickerz.com/api/indices/proof?day=2026-11-16
`;

ok("history loaded on the first record day is not a first print; a later period is", () => {
  const out = toDatasetCsv(BITE, "month");
  assert.equal(out.firstDay, "2026-11-13");
  assert.equal(out.rows, 3);
  assert.equal(out.firstPublished, 1);
  const rows = parseCsv(out.csv).filter((r) => r.length > 1);
  assert.deepEqual(rows[0], [...COLUMNS]);
  // Sorted oldest first; October 2026 had ended before Nov 13, so it was read late even though its proof day is later.
  assert.deepEqual(rows.slice(1).map((r) => [r[1], r[6]]), [["2020-01-01", "false"], ["2026-10-01", "false"], ["2026-11-01", "true"]]);
});

// $JOBS marks its own back history.
const JOBS = `ticker,period,value,settlement_value,revised,revised_on,band,z,proof_day,bitcoin_height,proof_url,note
JOBS,2026-09-01,60000,,false,,Quiet,0.2,,,,Loaded later: the Bureau's current figure and not the number as first published
JOBS,2026-10-01,165000,165000,false,,Quiet,1.2,2026-11-07,974942,https://tickerz.com/api/indices/proof?day=2026-11-07,
`;

ok("the BLS note decides for the BLS indexes, and a quoted note survives", () => {
  const out = toDatasetCsv(JOBS, "month");
  assert.equal(out.firstPublished, 1);
  const rows = parseCsv(out.csv).filter((r) => r.length > 1);
  assert.equal(rows[1][6], "false");
  assert.equal(rows[1][12], "Loaded later: the Bureau's current figure and not the number as first published");
  assert.equal(rows[2][6], "true");
  assert.equal(rows[2][12], "");
});

ok("no settlement value is never a first print", () => {
  assert.equal(asFirstPublished({ period: "2026-11-16", settlement_value: "" }, "day", "2026-11-13", false), false);
  assert.equal(asFirstPublished({ period: "2026-11-16", settlement_value: "5" }, "day", "2026-11-13", false), true);
  assert.equal(asFirstPublished({ period: "2026-11-16", settlement_value: "5" }, "day", null, false), false);
});

ok("the card carries the caveat, a licence per source and a config per index", () => {
  const row = {
    ticker: "BITE", name: "Dog bites", family: "wild", counts: "Dog bites | reported", unit: "bites", cadence: "month" as const,
    source: { name: "NYC Open Data", url: "https://data.cityofnewyork.us/" },
    rights: { status: "clean", url: "https://example.org/terms", clause: "Public domain." },
    grade: "display", harm: false, rows: 3, firstPublished: 1, firstDay: "2026-11-13", from: "2020-01-01", to: "2026-11-01",
  };
  const text = card([row, { ...row, ticker: "OD", harm: true }], "2026-11-18");
  assert.match(text, /^---\nlicense: other\n/);
  assert.match(text, /- config_name: bite\n  data_files: data\/BITE.csv/);
  assert.match(text, /The point-in-time caveat/);
  assert.match(text, /\[Public domain.\]\(https:\/\/example.org\/terms\)/);
  assert.match(text, /Dog bites \\\| reported/);
  assert.match(text, /\$OD counts deaths or harm: shown for reading, never for bets/);
  assert.doesNotMatch(text, /[\u2013\u2014]/);
});

console.log(`\n${passed} passed`);
