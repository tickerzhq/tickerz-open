/**
 * The rulebook as data (src/rulebook.ts) and as prose (METHODOLOGY.md) say the same thing, and the copy follows the
 * production copy rules. Plain asserts, no network. Run: node --import tsx test/rulebook.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RULEBOOKS, RULEBOOK_VERSION, rulebookOf } from "../src/rulebook";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${name}`);
}

const methodology = readFileSync(new URL("../METHODOLOGY.md", import.meta.url), "utf8");

check("three rulebooks, one version, found by ticker with or without the $", () => {
  assert.deepEqual(RULEBOOKS.map((r) => r.ticker), ["MINTS", "GIGS", "WAGE"]);
  assert.equal(RULEBOOK_VERSION, "Rulebook v0.1, 2026-09-23");
  for (const r of RULEBOOKS) assert.equal(r.settlement.version, RULEBOOK_VERSION);
  assert.equal(rulebookOf("$wage")?.ticker, "WAGE");
  assert.equal(rulebookOf("LAYOFFS"), null, "only the three indexes whose code is here");
  assert.deepEqual(RULEBOOKS.map((r) => r.settlement.grade), ["candidate", "display", "display"]);
});

check("METHODOLOGY.md carries every rulebook line verbatim", () => {
  for (const r of RULEBOOKS) {
    for (const line of [r.name, r.counts, r.source.name, r.source.url, r.source.terms, r.cadence, r.settlement.why, r.settlement.manipulation, r.settlement.fallback, r.settlement.precision]) {
      assert.ok(methodology.includes(line), `${r.ticker}: missing "${line.slice(0, 60)}"`);
    }
  }
  assert.ok(methodology.includes(RULEBOOK_VERSION));
});

check("copy rules, as in production: no em or en dashes, no exclamation points, no banned words", () => {
  const banned = /\b(hot|alpha|signal|moon|pump(?!\.fun)|merch)\b|AI-powered|Z-Score|don't miss/i;
  for (const r of RULEBOOKS) {
    const s = r.settlement;
    for (const text of [r.name, r.counts, r.cadence, r.source.name, r.source.terms, s.why, s.manipulation, s.fallback, s.precision]) {
      assert.ok(!/[–—]/.test(text), `dash in: ${text.slice(0, 60)}`);
      assert.ok(!text.includes("!"), `exclamation in: ${text.slice(0, 60)}`);
      assert.ok(!banned.test(text), `banned word in: ${text.slice(0, 60)}`);
    }
  }
});

console.log(`\n${passed} passed`);
