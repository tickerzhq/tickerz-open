/**
 * The daily seal: the canonical text, first prints, and every check the verifier runs, on a real seal. The fixture is
 * the public proof endpoint's response for 2026-10-03, unchanged (GET https://tickerz.com/api/v1/indices/proof?day=2026-10-03).
 * The first three checks are copied from Tickerz's production test suite; the rest are written for this repo.
 * Plain asserts, no network. Run: node --import tsx test/seal.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  canonicalSealJson,
  checkSeal,
  firstPrintFromSeals,
  firstPrintsFromSeals,
  isCalendarDay,
  isOts,
  otsDigestHex,
  revisedFrom,
  sealRowsOf,
  type SealProof,
} from "../src/seal";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${name}`);
}

check("seal text: the write set, fixed key order, sorted by ticker then day, reproducible", () => {
  const rows = [
    { ticker: "agi", period: "2026-09-22", value: 7520054, revisions: 0 },
    { ticker: "CRIME", period: "2026-09-13", value: 658, revisions: 2 },
    { ticker: "CRIME", period: "2026-09-12", value: 695, revisions: 0 },
  ];
  const a = canonicalSealJson("2026-09-24", "2026-09-23T12:40:05.000Z", rows);
  const b = canonicalSealJson("2026-09-24", "2026-09-23T12:40:05.000Z", [...rows].reverse());
  assert.equal(a, b);
  assert.equal(a, '{"kind":"index_seal","day":"2026-09-24","since":"2026-09-23T12:40:05.000Z","rows":[{"ticker":"AGI","period":"2026-09-22","value":7520054,"revisions":0},{"ticker":"CRIME","period":"2026-09-12","value":695,"revisions":0},{"ticker":"CRIME","period":"2026-09-13","value":658,"revisions":2}]}');
  assert.match(canonicalSealJson("2026-09-24", null, rows), /"since":null/);
});

check("first print: the earliest seal holding a period wins, a revision sits beside it", () => {
  const seal = (day: string, since: string | null, rows: { ticker: string; period: string; value: number; revisions: number }[]) => {
    const canonical_json = canonicalSealJson(day, since, rows);
    return { day, canonical_json, digest_sha256: createHash("sha256").update(canonical_json, "utf8").digest("hex"), bitcoin_height: day === "2026-09-24" ? 915000 : null };
  };
  const a = seal("2026-09-24", null, [
    { ticker: "GOON", period: "2026-09-23", value: 9782, revisions: 0 },
    { ticker: "TRENCHES", period: "2026-09-23", value: 4434237.23, revisions: 0 },
  ]);
  // The next day's seal carries GOON's 23rd again, revised by the source, and the 24th for the first time.
  const b = seal("2026-09-25", "2026-09-24T12:40:05.000Z", [
    { ticker: "GOON", period: "2026-09-23", value: 9850, revisions: 1 },
    { ticker: "GOON", period: "2026-09-24", value: 10100, revisions: 0 },
  ]);
  // Newest first, the way a careless read would hand them over: the order of the seals, not of the list, decides.
  const seals = [b, a];
  const first = firstPrintFromSeals(seals, "GOON", "2026-09-23")!;
  assert.deepEqual(first, { ticker: "GOON", period: "2026-09-23", value: 9782, sealed_day: "2026-09-24", digest_sha256: a.digest_sha256, bitcoin_height: 915000 });
  assert.match(first.digest_sha256, /^[0-9a-f]{64}$/);
  const next = firstPrintFromSeals(seals, "goon", "2026-09-24")!;
  assert.equal(next.value, 10100);
  assert.equal(next.sealed_day, "2026-09-25");
  assert.equal(next.digest_sha256, b.digest_sha256);
  assert.equal(next.bitcoin_height, null);
  assert.equal(firstPrintFromSeals(seals, "GOON", "2026-09-25"), null);
  assert.equal(firstPrintFromSeals(seals, "TRENCHES", "2026-09-23")!.value, 4434237.23);
  assert.equal(firstPrintsFromSeals(seals).size, 3);
  // The level as it stands now is the revision; the first print stands.
  assert.equal(revisedFrom(first.value, 9850), true);
  assert.equal(revisedFrom(first.value, 9782), false);
  assert.equal(revisedFrom(first.value, null), false);
  // An unreadable seal is skipped, never fatal.
  assert.equal(firstPrintsFromSeals([{ day: "2026-09-23", canonical_json: "{", digest_sha256: "0".repeat(64), bitcoin_height: null }, ...seals]).size, 3);
  assert.equal(firstPrintsFromSeals([]).size, 0);
});

check("a day parameter is a real calendar day", () => {
  for (const ok of ["2026-09-24", "2024-02-29", "2026-12-31", "2026-01-01"]) assert.equal(isCalendarDay(ok), true, ok);
  for (const bad of ["2026-02-31", "2026-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "2026-09-32", "2026-9-24", "20260924", "", null, undefined]) {
    assert.equal(isCalendarDay(bad), false, String(bad));
  }
});

const proof = JSON.parse(readFileSync(new URL("./fixtures/seal-2026-10-03.json", import.meta.url), "utf8")) as SealProof;
const ots = new Uint8Array(Buffer.from(proof.ots_proof_base64!, "base64"));

check("a real seal passes every check: digest, day, canonical rebuild, and the .ots commits to the digest", () => {
  const checks = checkSeal(proof, ots, "2026-10-03");
  assert.deepEqual(checks.map((c) => c.name), ["digest", "day", "canonical", "ots", "ots_same"]);
  for (const c of checks) assert.ok(c.ok, `${c.name}: ${c.detail}`);
  assert.equal(proof.digest_sha256, "2d4f359fc8cf89e2e431d7e03517d9577125945df989f7ef91976b5e5334b3f4");
  assert.equal(proof.bitcoin_height, 969734);
});

check("the .ots header: magic, version 1, SHA-256, then the 32-byte digest", () => {
  assert.equal(isOts(ots), true);
  assert.equal(otsDigestHex(ots), proof.digest_sha256);
  assert.equal(isOts(new TextEncoder().encode("not a proof at all, but long enough to read")), false);
  assert.equal(otsDigestHex(ots.subarray(0, 40)), null, "a cut-off file has no digest");
  const otherOp = new Uint8Array(ots);
  otherOp[32] = 0x02; // SHA-1
  assert.equal(otsDigestHex(otherOp), null);
});

check("any change fails: one level moved, one key reordered, a different proof, the wrong day", () => {
  const failed = (p: SealProof, o: Uint8Array = ots, day = "2026-10-03") => checkSeal(p, o, day).filter((c) => !c.ok).map((c) => c.name);
  const moved = proof.canonical_json.replace('"ticker":"MINTS","period":"2026-10-02","value":47746', '"ticker":"MINTS","period":"2026-10-02","value":47747');
  assert.notEqual(moved, proof.canonical_json);
  assert.deepEqual(failed({ ...proof, canonical_json: moved }), ["digest"], "a moved level breaks the digest");
  // Re-stamping a moved level still fails: the .ots commits to the original digest.
  const restamped = { ...proof, canonical_json: moved, digest_sha256: createHash("sha256").update(moved, "utf8").digest("hex") };
  assert.deepEqual(failed(restamped), ["ots"]);
  // The same rows with keys in another order hash differently and do not rebuild to the published text.
  const reordered = proof.canonical_json.replace('{"kind":"index_seal","day":"2026-10-03",', '{"day":"2026-10-03","kind":"index_seal",');
  assert.deepEqual(failed({ ...proof, canonical_json: reordered, digest_sha256: createHash("sha256").update(reordered, "utf8").digest("hex") }), ["canonical", "ots"]);
  const otherOts = new Uint8Array(ots);
  otherOts[40] ^= 0xff;
  assert.deepEqual(failed(proof, otherOts), ["ots", "ots_same"]);
  assert.deepEqual(failed(proof, ots, "2026-10-04"), ["day"]);
});

check("the Oct 3 seal holds the Oct 2 prints of MINTS, its graduations line, GIGS and WAGE", () => {
  assert.deepEqual(sealRowsOf(proof.canonical_json, "MINTS"), [{ ticker: "MINTS", period: "2026-10-02", value: 47746, revisions: 0 }]);
  assert.deepEqual(sealRowsOf(proof.canonical_json, "MINTS.GRADS"), [{ ticker: "MINTS.GRADS", period: "2026-10-02", value: 1725, revisions: 0 }]);
  assert.deepEqual(sealRowsOf(proof.canonical_json, "gigs"), [{ ticker: "GIGS", period: "2026-10-02", value: 50535, revisions: 0 }]);
  assert.deepEqual(sealRowsOf(proof.canonical_json, "WAGE"), [{ ticker: "WAGE", period: "2026-10-02", value: 0.01, revisions: 0 }]);
  const firsts = firstPrintsFromSeals([{ day: proof.day, digest_sha256: proof.digest_sha256, bitcoin_height: proof.bitcoin_height ?? null, canonical_json: proof.canonical_json }]);
  assert.equal(firsts.get("MINTS:2026-10-02")!.bitcoin_height, 969734);
});

console.log(`\n${passed} passed`);
