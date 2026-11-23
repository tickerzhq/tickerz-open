/**
 * Property tests (fast-check) for the proof check: scripts/verify-proof.ts and src/seal.ts, which it runs on the seal
 * the public API serves. Each property is checked on a few hundred generated inputs: the seal text and its rebuild,
 * every check checkSeal runs, the .ots header, the day argument, and first prints. The last check runs the script
 * itself against a fake proof endpoint, so there is no network. Run: node --import tsx test/proof.property.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fc from "fast-check";
import { canonicalSealJson, checkSeal, firstPrintsFromSeals, isCalendarDay, isOts, otsDigestHex, sealRowsOf, sha256Hex, type SealProof, type SealRecord, type SealRow } from "../src/seal";

// Each property stops after a minute (shrinking included), and a minute without an answer counts as a failure.
fc.configureGlobal({ interruptAfterTimeLimit: 60_000, markInterruptAsFailure: true });

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${name}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------------------------

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const hex64 = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(hex);
const dayArb = fc
  .date({ min: new Date("2015-01-01T00:00:00Z"), max: new Date("2035-12-31T00:00:00Z"), noInvalidDate: true })
  .map((d) => d.toISOString().slice(0, 10));
const isoArb = fc.date({ min: new Date("2015-01-01T00:00:00Z"), max: new Date("2035-12-31T00:00:00Z"), noInvalidDate: true }).map((d) => d.toISOString());
const anyText = fc.oneof(fc.string(), fc.string({ unit: "binary" }), fc.string({ unit: fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c)) }));

/** A seal row as the write set holds it: a level, or (for a withheld source) a salted hash of it. */
const rowArb: fc.Arbitrary<SealRow> = fc.oneof(
  fc.record({ ticker: fc.stringMatching(/^[A-Za-z][A-Za-z0-9.]{0,11}$/), period: dayArb, value: fc.double({ noNaN: true, noDefaultInfinity: true }), revisions: fc.nat(20) }),
  fc.record({ ticker: fc.stringMatching(/^[A-Za-z][A-Za-z0-9.]{0,11}$/), period: dayArb, value_sha256: hex64, revisions: fc.nat(20) }),
);
/** The rows of one seal: one per ticker and period. */
const rowsArb = fc.uniqueArray(rowArb, { selector: (r) => `${r.ticker.toUpperCase()}:${r.period}`, maxLength: 40 });
const sealArb = fc.record({ day: dayArb, since: fc.option(isoArb, { nil: null }), rows: rowsArb, tail: fc.uint8Array({ maxLength: 200 }) });

/** "\x00OpenTimestamps\x00\x00Proof\x00" and the 8 magic bytes, as in src/seal.ts. */
const OTS_MAGIC = Buffer.from("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294", "hex");
/** A detached .ots file: the header (version 1, SHA-256), the digest, then the path to Bitcoin (any bytes here). */
const otsFile = (digestHex: string, tail: Uint8Array = new Uint8Array()) => new Uint8Array(Buffer.concat([OTS_MAGIC, Buffer.from([0x01, 0x08]), Buffer.from(digestHex, "hex"), tail]));

/** A seal as the proof endpoint serves it, with its .ots file. */
function sealOf(s: { day: string; since: string | null; rows: SealRow[]; tail: Uint8Array }): { proof: SealProof; ots: Uint8Array } {
  const canonical_json = canonicalSealJson(s.day, s.since, s.rows);
  const ots = otsFile(sha256Hex(canonical_json), s.tail);
  return { proof: { day: s.day, digest_sha256: sha256Hex(canonical_json), canonical_json, ots_proof_base64: Buffer.from(ots).toString("base64") }, ots };
}

const shuffle = <T>(xs: readonly T[], seed: number): T[] => {
  const out = [...xs];
  let x = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const j = x % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

// ---------------------------------------------------------------------------------------------------------------
// The seal text
// ---------------------------------------------------------------------------------------------------------------

check("the seal text round trips: rebuilt from its own parsed rows it is the same bytes, so the digest reproduces", () => {
  fc.assert(
    fc.property(sealArb, ({ day, since, rows }) => {
      const text = canonicalSealJson(day, since, rows);
      const back = JSON.parse(text) as { kind: string; day: string; since: string | null; rows: SealRow[] };
      assert.equal(back.kind, "index_seal");
      assert.equal(back.day, day);
      assert.equal(back.rows.length, rows.length);
      assert.equal(canonicalSealJson(back.day, back.since, back.rows), text);
    }),
    { numRuns: 300 },
  );
});

check("the seal text does not depend on the order of the rows or the case of the tickers", () => {
  fc.assert(
    fc.property(sealArb, fc.nat(), ({ day, since, rows }, seed) => {
      const lower = shuffle(rows, seed).map((r) => ({ ...r, ticker: r.ticker.toLowerCase() }));
      assert.equal(canonicalSealJson(day, since, lower), canonicalSealJson(day, since, rows));
    }),
    { numRuns: 300 },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// checkSeal: every check the verifier runs without a Bitcoin node
// ---------------------------------------------------------------------------------------------------------------

check("a seal built from any rows passes every check", () => {
  fc.assert(
    fc.property(sealArb, (s) => {
      const { proof, ots } = sealOf(s);
      const checks = checkSeal(proof, ots, s.day);
      assert.deepEqual(checks.map((c) => c.name), ["digest", "day", "canonical", "ots", "ots_same"]);
      for (const c of checks) assert.ok(c.ok, `${c.name}: ${c.detail}`);
    }),
    { numRuns: 300 },
  );
});

check("one changed character fails the digest, and stamping the changed text again fails the .ots", () => {
  fc.assert(
    fc.property(sealArb, fc.nat(), fc.string({ minLength: 1, maxLength: 1 }), (s, at, c) => {
      const { proof, ots } = sealOf(s);
      const i = at % proof.canonical_json.length;
      fc.pre(proof.canonical_json[i] !== c);
      const moved = proof.canonical_json.slice(0, i) + c + proof.canonical_json.slice(i + 1);
      const failed = (p: SealProof) => checkSeal(p, ots, s.day).filter((x) => !x.ok).map((x) => x.name);
      assert.ok(failed({ ...proof, canonical_json: moved }).includes("digest"));
      assert.ok(failed({ ...proof, canonical_json: moved, digest_sha256: sha256Hex(moved) }).includes("ots"));
    }),
    { numRuns: 300 },
  );
});

check("the wrong day fails only the day check; a proof of another digest fails only the two .ots checks", () => {
  fc.assert(
    fc.property(sealArb, dayArb, hex64, (s, other, digest) => {
      const { proof, ots } = sealOf(s);
      fc.pre(other !== s.day && digest !== proof.digest_sha256);
      const failed = (o: Uint8Array, day: string) => checkSeal(proof, o, day).filter((x) => !x.ok).map((x) => x.name);
      assert.deepEqual(failed(ots, other), ["day"]);
      assert.deepEqual(failed(otsFile(digest, s.tail), s.day), ["ots", "ots_same"]);
    }),
    { numRuns: 300 },
  );
});

/** A seal from a server that sends anything: fields of any type, text that is not JSON, rows of any shape. */
const anyRowArb = fc.oneof(
  fc.jsonValue(),
  fc.record({ ticker: fc.oneof(anyText, fc.jsonValue()), period: fc.oneof(dayArb, fc.jsonValue()), value: fc.jsonValue(), revisions: fc.jsonValue() }, { requiredKeys: [] }),
  fc.record({ ticker: fc.oneof(anyText, fc.jsonValue()), period: fc.oneof(dayArb, fc.jsonValue()), value_sha256: fc.jsonValue(), revisions: fc.jsonValue() }, { requiredKeys: [] }),
);
const sealishText = fc
  .record({ kind: fc.oneof(fc.constant("index_seal"), fc.jsonValue()), day: fc.oneof(dayArb, fc.jsonValue()), since: fc.oneof(fc.constant(null), isoArb, fc.jsonValue()), rows: fc.oneof(fc.array(anyRowArb, { maxLength: 8 }), fc.jsonValue()) }, { requiredKeys: [] })
  .map((o) => JSON.stringify(o));
const anyProofArb = fc.record(
  {
    day: fc.oneof(dayArb, fc.jsonValue()),
    digest_sha256: fc.oneof(hex64, fc.jsonValue()),
    canonical_json: fc.oneof(anyText, sealishText, fc.jsonValue()),
    ots_proof_base64: fc.oneof(fc.base64String(), fc.jsonValue()),
  },
  { requiredKeys: [] },
);

check("checkSeal reads any proof without throwing, and passes the canonical check only on text the script can read", () => {
  fc.assert(
    fc.property(anyProofArb, fc.uint8Array({ maxLength: 120 }), fc.oneof(dayArb, anyText), (p, ots, day) => {
      const proof = p as unknown as SealProof;
      const checks = checkSeal(proof, ots, day);
      assert.ok(checks.length >= 4);
      for (const c of checks) assert.ok(typeof c.name === "string" && typeof c.ok === "boolean" && typeof c.detail === "string");
      if (checks.find((c) => c.name === "canonical")?.ok) {
        // What scripts/verify-proof.ts reads after the checks.
        assert.ok(Array.isArray((JSON.parse(proof.canonical_json) as { rows: unknown }).rows));
        for (const t of ["MINTS", "GIGS"]) sealRowsOf(proof.canonical_json, t);
      }
    }),
    { numRuns: 1000 },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// The .ots header, the day argument, first prints
// ---------------------------------------------------------------------------------------------------------------

check("the .ots header round trips: the digest written after the header is the digest read", () => {
  fc.assert(
    fc.property(hex64, fc.uint8Array({ maxLength: 300 }), (digest, tail) => {
      const ots = otsFile(digest, tail);
      assert.equal(isOts(ots), true);
      assert.equal(otsDigestHex(ots), digest);
      // Cut short anywhere inside the digest: no digest.
      for (const cut of [OTS_MAGIC.length, OTS_MAGIC.length + 2, OTS_MAGIC.length + 33]) assert.equal(otsDigestHex(ots.subarray(0, cut)), null);
      // Another version or another hash op: no digest.
      for (const at of [OTS_MAGIC.length, OTS_MAGIC.length + 1]) {
        const other = new Uint8Array(ots);
        other[at] ^= 0x40;
        assert.equal(otsDigestHex(other), null);
      }
    }),
    { numRuns: 300 },
  );
});

check("bytes that do not start with the OpenTimestamps header are not a proof and have no digest", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 120 }), (b) => {
      fc.pre(!Buffer.from(b.subarray(0, OTS_MAGIC.length)).equals(OTS_MAGIC));
      assert.equal(isOts(b), false);
      assert.equal(otsDigestHex(b), null);
    }),
    { numRuns: 500 },
  );
});

/** Days in a month of the Gregorian calendar, worked out without Date. */
const daysIn = (y: number, m: number) => (m === 2 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);

check("the day argument: YYYY-MM-DD is accepted exactly when it is a real calendar day", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 9999 }), fc.integer({ min: 0, max: 13 }), fc.integer({ min: 0, max: 32 }), (y, m, d) => {
      const s = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      assert.equal(isCalendarDay(s), m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m), s);
    }),
    { numRuns: 2000 },
  );
  fc.assert(fc.property(anyText, (s) => assert.equal(isCalendarDay(s), /^\d{4}-\d{2}-\d{2}$/.test(s) && isCalendarDay(s))), { numRuns: 500 });
});

check("first prints: the earliest seal holding a period wins, whatever order the seals come in", () => {
  const sealsArb = fc.uniqueArray(fc.record({ day: dayArb, rows: rowsArb }), { selector: (s) => s.day, minLength: 1, maxLength: 6 });
  fc.assert(
    fc.property(sealsArb, fc.nat(), (list, seed) => {
      const seals: SealRecord[] = list.map((s) => {
        const canonical_json = canonicalSealJson(s.day, null, s.rows);
        return { day: s.day, canonical_json, digest_sha256: sha256Hex(canonical_json), bitcoin_height: null };
      });
      // The model: walk the seals by day, keep the first level seen for each ticker and period.
      const model = new Map<string, number>();
      for (const s of [...seals].sort((a, b) => (a.day < b.day ? -1 : 1))) {
        for (const r of (JSON.parse(s.canonical_json) as { rows: SealRow[] }).rows) {
          if ("value" in r && !model.has(`${r.ticker}:${r.period}`)) model.set(`${r.ticker}:${r.period}`, r.value);
        }
      }
      const firsts = firstPrintsFromSeals(shuffle(seals, seed));
      assert.deepEqual(new Map([...firsts].map(([k, v]) => [k, v.value])), model);
      assert.deepEqual(firstPrintsFromSeals(seals), firsts);
    }),
    { numRuns: 300 },
  );
});

check("first prints read any seal text without throwing; a seal that cannot be read is skipped", () => {
  fc.assert(
    fc.property(fc.array(fc.record({ day: fc.oneof(dayArb, anyText), canonical_json: fc.oneof(anyText, sealishText) }), { maxLength: 6 }), (list) => {
      const firsts = firstPrintsFromSeals(list.map((s) => ({ ...s, digest_sha256: "", bitcoin_height: null })));
      for (const [key, f] of firsts) {
        assert.match(f.period, /^\d{4}-\d{2}-\d{2}$/);
        assert.equal(key, `${f.ticker}:${f.period}`);
        assert.ok(Number.isFinite(f.value));
      }
    }),
    { numRuns: 500 },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// The script itself, against a fake proof endpoint
// ---------------------------------------------------------------------------------------------------------------

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeApi = pathToFileURL(path.join(root, "test", "fixtures", "fake-proof-api.ts")).href;

function verify(proofJson: string, otsBase64: string, day: string) {
  const out = mkdtempSync(path.join(tmpdir(), "tickerz-verify-"));
  try {
    const r = spawnSync(process.execPath, ["--import", "tsx", "--import", fakeApi, "scripts/verify-proof.ts", day, "--out", out], {
      cwd: root,
      env: { ...process.env, FAKE_PROOF_JSON: proofJson, FAKE_PROOF_OTS: otsBase64 },
      encoding: "utf8",
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, wrote: existsSync(path.join(out, `tickerz-seal-${day}.json`)) };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

check("npm run verify: a real seal passes; a seal it cannot read fails with the plain message, never a stack trace", () => {
  const real = readFileSync(path.join(root, "test", "fixtures", "seal-2026-10-03.json"), "utf8");
  const ok = verify(real, (JSON.parse(real) as SealProof).ots_proof_base64!, "2026-10-03");
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /All checks passed\./);
  assert.equal(ok.wrote, true);
  fc.assert(
    fc.property(anyProofArb, fc.base64String({ maxLength: 80 }), (p, ots) => {
      const r = verify(JSON.stringify({ ...p, day: "2026-10-03" }), ots, "2026-10-03");
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /do not rely on this seal/);
      assert.doesNotMatch(r.stderr, /Error|\n\s+at /, r.stderr);
    }),
    { numRuns: 12 },
  );
});

console.log(`\n${passed} passed`);
