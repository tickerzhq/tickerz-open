/**
 * Property tests (fast-check) for the public recount: oracle/scripts/recount.ts and the code it runs. Each property
 * is checked on a few hundred generated inputs, not on hand-picked examples: the canonical JSON every report hash is
 * built on, the signed report envelope, base58, the scaled integers, and the readers that parse what the Solana RPC,
 * the Bureau of Labor Statistics, FRED and the Labor Department send back. Those readers get answers from a fake
 * fetch, so there is no network. Run: node --import tsx test/recount.property.test.ts
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fc from "fast-check";
import { pctChange1dp } from "../oracle/src/lib/indices/bls";
import { parseDolClaims } from "../oracle/src/lib/indices/fetchers";
import { canonicalJson, scaled, unscaled } from "../oracle/src/lib/oracle/canonical";
import { recount } from "../oracle/src/lib/oracle/cosign";
import { blsValue, countSolanaDay, parseBlsFlat, readBlsSeries, snapshotHash } from "../oracle/src/lib/oracle/recount";
import { cosign, reportHash, signReport, verifyEnvelope, verifySigned, COSIGN_PREFIX, type Report, type ReportEnvelope } from "../oracle/src/lib/oracle/report";
import { base58Decode, base58Encode } from "../oracle/src/lib/solanaTx";

// oracle/ is copied from Tickerz's Next.js code, which passes cache: "no-store" to fetch. The DOM's RequestInit has
// that field and Node's types leave it out; tsc reads oracle/ through the imports above, so the field is declared here.
declare global {
  interface RequestInit {
    cache?: "default" | "force-cache" | "no-cache" | "no-store" | "only-if-cached" | "reload";
  }
}

// A failing property shrinks its example to the smallest one that still fails. On a chain of thousands of signatures
// that can take long, so each property stops after a minute, and a minute without an answer counts as a failure.
fc.configureGlobal({ interruptAfterTimeLimit: 60_000, markInterruptAsFailure: true });

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok ${name}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Shared generators and helpers
// ---------------------------------------------------------------------------------------------------------------

const DAY_SEC = 86_400;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const hex64 = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(hex);
/** A UTC day, YYYY-MM-DD, from 2015 to 2035. */
const dayArb = fc
  .date({ min: new Date("2015-01-01T00:00:00Z"), max: new Date("2035-12-31T00:00:00Z"), noInvalidDate: true })
  .map((d) => d.toISOString().slice(0, 10));
/** Text of any kind: printable, any code point, and lone UTF-16 halves. */
const anyText = fc.oneof(fc.string(), fc.string({ unit: "binary" }), fc.string({ unit: fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c)) }));
/** What a server might send back with a 200: anything at all, or any JSON. */
const anyBody = fc.oneof(anyText, fc.json(), fc.jsonValue().map((v) => JSON.stringify(v)));

/** A fetch that answers from a function of the URL and the request body, never the network. */
type Answer = { status: number; body: string };
function fakeFetch(answer: (url: string, body: string) => Answer): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const a = answer(url, typeof init?.body === "string" ? init.body : "");
    return new Response(a.body, { status: a.status });
  }) as typeof fetch;
}

/** An Ed25519 key as a Solana wallet exports it: base58 of the 32-byte seed then the 32-byte public key. */
function testKey(): { secret: string; address: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { secret: base58Encode(Buffer.concat([seed, pub])), address: base58Encode(pub) };
}

const isError = (e: unknown, pattern: RegExp) => e instanceof Error && !(e instanceof TypeError) && !(e instanceof SyntaxError) && pattern.test(e.message);

/** What a call ended in: what it returned, or the error it threw, by name and message. */
async function outcome<T>(f: () => Promise<T>): Promise<{ ok: T } | { thrown: string }> {
  try {
    return { ok: await f() };
  } catch (e) {
    return { thrown: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

/** Whether a body is JSON with a list where `path` looks (an RPC result, the Bureau's data). */
function jsonList(body: string, path: (j: unknown) => unknown): boolean {
  try {
    return Array.isArray(path(JSON.parse(body)));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Canonical JSON: the bytes every report hash and signature is over
// ---------------------------------------------------------------------------------------------------------------

/** Every value canonical JSON accepts: safe integers, any text, booleans, null, arrays and plain objects. */
const canonArb = fc.letrec((tie) => ({
  value: fc.oneof(
    { maxDepth: 4 },
    fc.maxSafeInteger().map((n) => n + 0),
    anyText,
    fc.boolean(),
    fc.constant(null),
    fc.array(tie("value"), { maxLength: 5 }),
    fc.dictionary(anyText, tie("value"), { maxKeys: 5, noNullPrototype: true }),
  ),
})).value;

function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]));
  return v;
}

await check("canonical JSON round trip: the text parses back to the same value, and canonicalising that gives the same bytes", () => {
  fc.assert(
    fc.property(canonArb, (v) => {
      const text = canonicalJson(v);
      const back: unknown = JSON.parse(text);
      assert.deepStrictEqual(back, v);
      assert.equal(canonicalJson(back), text);
    }),
    { numRuns: 300 },
  );
});

await check("canonical JSON does not depend on key order, at any depth", () => {
  fc.assert(fc.property(canonArb, (v) => assert.equal(canonicalJson(reverseKeys(v)), canonicalJson(v))), { numRuns: 300 });
});

await check("canonical JSON on any value: JSON text that canonicalises to itself, or a canonical_ reason (a fraction, undefined), never another error", () => {
  fc.assert(
    fc.property(fc.anything(), (v) => {
      try {
        const text = canonicalJson(v);
        assert.equal(canonicalJson(JSON.parse(text)), text);
      } catch (e) {
        assert.ok(isError(e, /^canonical_(number_not_integer|undefined:|type:)/), String(e));
      }
    }),
    { numRuns: 300 },
  );
  for (const bad of [0.5, NaN, Infinity, 2 ** 53, undefined, { a: undefined }, [1.5], () => 1, 1n]) {
    assert.throws(() => canonicalJson(bad), /^Error: canonical_/);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Scaled integers: the value a report carries
// ---------------------------------------------------------------------------------------------------------------

await check("scaled and unscaled round trip: an integer string at d decimals comes back exactly (up to 15 digits)", () => {
  fc.assert(
    fc.property(fc.integer({ min: -(10 ** 15) + 1, max: 10 ** 15 - 1 }), fc.integer({ min: 0, max: 12 }), (n, d) => {
      assert.equal(scaled(unscaled(String(n), d), d), String(n));
    }),
    { numRuns: 500 },
  );
});

await check("a count at d decimals is the count followed by d zeros (to the 15 digits scaled keeps)", () => {
  const upTo15Digits = (d: number) => Math.floor((10 ** 15 - 1) / 10 ** d);
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 12 }).chain((d) => fc.tuple(fc.integer({ min: -upTo15Digits(d), max: upTo15Digits(d) }), fc.constant(d))), ([n, d]) => {
      assert.equal(scaled(n, d), n === 0 ? "0" : `${n}${"0".repeat(d)}`);
    }),
    { numRuns: 500 },
  );
});

await check("scaled rounds half away from zero, the same both sides of zero, and never writes -0", () => {
  fc.assert(
    fc.property(fc.double({ noNaN: true }), fc.integer({ min: 0, max: 12 }), (x, d) => {
      let s: string;
      try {
        s = scaled(x, d);
      } catch (e) {
        assert.ok(isError(e, /^scaled_(not_finite|too_large)$/), String(e));
        assert.throws(() => scaled(-x, d), /scaled_(not_finite|too_large)/);
        return;
      }
      assert.match(s, /^(0|-?[1-9]\d*)$/);
      const neg = scaled(-x, d);
      assert.equal(neg, s === "0" ? "0" : s.startsWith("-") ? s.slice(1) : `-${s}`);
    }),
    { numRuns: 500 },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// base58: how keys and signatures travel in an envelope
// ---------------------------------------------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

await check("base58 round trips both ways, leading zero bytes included", () => {
  fc.assert(fc.property(fc.uint8Array({ maxLength: 80 }), (b) => assert.deepStrictEqual(base58Decode(base58Encode(b)), Uint8Array.from(b))), { numRuns: 400 });
  fc.assert(fc.property(fc.string({ unit: fc.constantFrom(...B58), maxLength: 100 }), (s) => assert.equal(base58Encode(base58Decode(s)), s)), { numRuns: 400 });
});

await check("base58 decoding refuses any text outside the alphabet with not_base58, and nothing else", () => {
  fc.assert(
    fc.property(anyText, (s) => {
      const valid = [...s].every((c) => B58.includes(c));
      try {
        base58Decode(s);
        assert.ok(valid, "decoded text outside the alphabet");
      } catch (e) {
        assert.ok(!valid && isError(e, /^not_base58$/), String(e));
      }
    }),
    { numRuns: 400 },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// The signed report envelope: what the recount checks before it counts
// ---------------------------------------------------------------------------------------------------------------

const publisher = testKey();
const cosigner = testKey();
const stranger = testKey();

const reportArb: fc.Arbitrary<Report> = fc
  .record({
    kind: fc.constantFrom("index" as const, "launch" as const),
    ticker: fc.stringMatching(/^[A-Z0-9.]{2,20}$/),
    period: dayArb,
    period_start: fc.integer({ min: 0, max: 4_000_000_000 }),
    cadence: fc.constantFrom("hour" as const, "day" as const, "week" as const, "month" as const),
    value: fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }).map(String),
    decimals: fc.integer({ min: 0, max: 12 }),
    unit: anyText,
    status: fc.constantFrom("provisional" as const, "final" as const, "corrected" as const),
    other: hex64,
    rule: fc.record({ version: fc.nat(), hash: hex64 }),
    settleable: fc.boolean(),
    sources: fc.array(fc.record({ provider: anyText, snapshot_sha256: hex64, fetched_at: anyText }), { minLength: 2, maxLength: 3 }),
    official: fc.boolean(),
    published_at: anyText,
  })
  .map(({ status, other, sources, official, ...r }) => ({
    schema: "tickerz-report/1" as const,
    ...r,
    status,
    corrects: status === "corrected" ? other : null,
    finalizes: status === "final" ? other : null,
    // Two providers must agree on the value and be two different names.
    sources: sources.map((s, i) => ({ ...s, provider: official ? s.provider : `${i}:${s.provider}`, value: official ? s.provider.slice(0, 5) : r.value })),
    agreement: official ? ("official" as const) : ("two_providers" as const),
    publisher: publisher.address,
  }));

/** The envelope as the network delivers it: signed, co-signed, then through JSON and back. */
function deliver(r: Report): ReportEnvelope {
  const env = signReport(r, publisher.secret);
  env.cosignatures.push(cosign(r.finalizes ?? env.hash, cosigner.secret), cosign(r.finalizes ?? env.hash, stranger.secret));
  return JSON.parse(JSON.stringify(env)) as ReportEnvelope;
}

await check("a signed report verifies after a trip through JSON, and only the known co-signer counts", () => {
  fc.assert(
    fc.property(reportArb, (r) => {
      const env = deliver(r);
      assert.equal(env.hash, reportHash(r));
      assert.equal(reportHash(reverseKeys(env.report) as Report), env.hash, "the hash does not depend on key order");
      assert.deepStrictEqual(verifyEnvelope(env, { publisher: publisher.address, cosigners: [cosigner.address] }), { ok: true, cosigned: [cosigner.address] });
      assert.deepStrictEqual(verifyEnvelope(env, { publisher: publisher.address }).cosigned, []);
      assert.equal(verifyEnvelope(env, { publisher: stranger.address }).reason, "not_the_publisher");
    }),
    { numRuns: 200 },
  );
});

await check("any change to any field of a signed report is refused: the hash no longer matches", () => {
  const fields: (keyof Report)[] = ["schema", "kind", "ticker", "period", "period_start", "cadence", "value", "decimals", "unit", "status", "corrects", "finalizes", "rule", "settleable", "sources", "agreement", "published_at", "publisher"];
  fc.assert(
    fc.property(reportArb, fc.constantFrom(...fields), fc.option(fc.jsonValue(), { nil: undefined }), (r, field, replacement) => {
      const env = deliver(r);
      const tampered: Record<string, unknown> = { ...env.report };
      if (replacement === undefined) delete tampered[field];
      else tampered[field] = replacement;
      let same = false;
      try {
        same = replacement !== undefined && canonicalJson(replacement) === canonicalJson(env.report[field]);
      } catch {
        same = false;
      }
      fc.pre(!same);
      try {
        const v = verifyEnvelope({ ...env, report: tampered as unknown as Report }, { publisher: publisher.address, cosigners: [cosigner.address] });
        assert.deepStrictEqual(v, { ok: false, reason: "hash_mismatch", cosigned: [] });
      } catch (e) {
        // A fraction cannot be canonicalised: refused with a short reason.
        assert.ok(isError(e, /^canonical_/), String(e));
      }
    }),
    { numRuns: 300 },
  );
});

await check("a signature or co-signature that is any other text is refused, never thrown", () => {
  fc.assert(
    fc.property(reportArb, anyText, anyText, (r, sig, by) => {
      const env = deliver(r);
      fc.pre(sig !== env.signature.signature);
      const forged = { ...env, signature: { ...env.signature, signature: sig } };
      assert.deepStrictEqual(verifyEnvelope(forged, { publisher: publisher.address }), { ok: false, reason: "bad_signature", cosigned: [] });
      const junk = { ...env, cosignatures: [{ by: cosigner.address, signature: sig }, { by, signature: env.cosignatures[0].signature }] };
      const v = verifyEnvelope(junk, { publisher: publisher.address, cosigners: [cosigner.address, by] });
      assert.equal(v.ok, true);
      const genuine = env.cosignatures[0].signature;
      assert.deepStrictEqual(v.cosigned, [...(sig === genuine ? [cosigner.address] : []), ...(by === cosigner.address ? [cosigner.address] : [])]);
    }),
    { numRuns: 200 },
  );
});

await check("verifySigned never throws, whatever the hash and the signature object hold", () => {
  fc.assert(
    fc.property(anyText, fc.anything(), (hash, sig) => {
      assert.equal(verifySigned(hash, sig as never), false);
      assert.equal(verifySigned(hash, sig as never, COSIGN_PREFIX), false);
    }),
    { numRuns: 300 },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// $MINTS: the Solana count of one UTC day, read page by page
// ---------------------------------------------------------------------------------------------------------------

type Sig = { signature: string; blockTime: number | null; err: unknown; slot: number };

/** A chain around one day: signatures newest first, some failed, some with no block time, many exactly on an edge. */
const chainArb = fc.tuple(
  dayArb,
  fc.array(
    fc.record({
      at: fc.oneof(fc.constantFrom(-1, 0, DAY_SEC - 1, DAY_SEC), fc.integer({ min: -DAY_SEC, max: 2 * DAY_SEC })),
      failed: fc.oneof({ arbitrary: fc.constant(false), weight: 3 }, { arbitrary: fc.constant(true), weight: 1 }),
      timed: fc.oneof({ arbitrary: fc.constant(true), weight: 9 }, { arbitrary: fc.constant(false), weight: 1 }),
    }),
    { maxLength: 2600, size: "max" },
  ),
).map(([day, entries]) => {
  const start = Date.parse(`${day}T00:00:00Z`) / 1000;
  const chain: Sig[] = [...entries]
    .sort((a, b) => b.at - a.at)
    .map((e, i) => ({ signature: `sig${i}`, blockTime: e.timed ? start + e.at : null, err: e.failed ? { InstructionError: [0, { Custom: 1 }] } : null, slot: 1e9 - i }));
  return { day, start, chain };
});

/** The day's count by the $MINTS rule: succeeded (err null), with a block time inside the UTC day. */
const countDay = (sigs: readonly Sig[], start: number) => sigs.filter((s) => s.err == null && s.blockTime != null && s.blockTime >= start && s.blockTime < start + DAY_SEC).length;

/** getSignaturesForAddress over a list held in memory: newest first, `limit` at a time, below `before`. */
function fakeRpc(chain: readonly Sig[]): typeof fetch {
  return fakeFetch((_url, body) => {
    const req = JSON.parse(body) as { id: number; params: [string, { limit: number; before?: string }] };
    const { limit, before } = req.params[1];
    const from = before ? chain.findIndex((s) => s.signature === before) + 1 : 0;
    return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: req.id, result: chain.slice(from, from + limit) }) };
  });
}

const RPC = "https://rpc.example.test/";

await check("$MINTS: the count equals the day's successful signatures, across pages and on the day's edges", async () => {
  await fc.assert(
    fc.asyncProperty(chainArb, async ({ day, start, chain }) => {
      const read = await countSolanaDay(RPC, "Acct", day, { fetchImpl: fakeRpc(chain), delayMs: 0 });
      assert.equal(read.error, undefined);
      assert.equal(read.value, countDay(chain, start));
    }),
    { numRuns: 60 },
  );
});

await check("$MINTS: the stored snapshot alone gives the same count, and two reads of one chain give the same bytes", async () => {
  await fc.assert(
    fc.asyncProperty(chainArb, async ({ day, start, chain }) => {
      const a = await countSolanaDay(RPC, "Acct", day, { fetchImpl: fakeRpc(chain), delayMs: 0 });
      const b = await countSolanaDay(RPC, "Acct", day, { fetchImpl: fakeRpc(chain), delayMs: 0 });
      assert.equal(snapshotHash(a.bytes), snapshotHash(b.bytes));
      const pages = a.bytes.toString("utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { result: Sig[] }).result);
      const rows = pages.flat();
      assert.equal(a.rows, rows.length);
      assert.equal(countDay(rows, start), a.value);
    }),
    { numRuns: 40 },
  );
});

await check("$MINTS: an answer that is not JSON, or has no list of signatures, never gives a count: no count with a reason, or a throw", async () => {
  const notAPage = anyBody.filter((b) => !jsonList(b, (j) => (j as { result?: unknown } | null)?.result));
  await fc.assert(
    fc.asyncProperty(dayArb, notAPage, async (day, body) => {
      const o = await outcome(() => countSolanaDay(RPC, "Acct", day, { fetchImpl: fakeFetch(() => ({ status: 200, body })), delayMs: 0 }));
      if ("ok" in o) {
        assert.equal(o.ok.value, null);
        assert.ok((o.ok.error ?? "").length > 0);
      }
    }),
    { numRuns: 400 },
  );
});

await check("$MINTS: a page whose entries have any shape gives a whole count of zero or more, no count with a reason, or a throw", async () => {
  const anyPage = fc.array(fc.oneof(fc.jsonValue(), fc.record({ signature: anyText, blockTime: fc.oneof(fc.integer(), fc.constant(null), fc.jsonValue()), err: fc.jsonValue() })), { maxLength: 20 })
    .map((result) => JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  await fc.assert(
    fc.asyncProperty(dayArb, anyPage, async (day, body) => {
      const o = await outcome(() => countSolanaDay(RPC, "Acct", day, { fetchImpl: fakeFetch(() => ({ status: 200, body })), delayMs: 0 }));
      if ("ok" in o && o.ok.value == null) assert.ok((o.ok.error ?? "").length > 0);
      else if ("ok" in o) assert.ok(Number.isSafeInteger(o.ok.value) && o.ok.value! >= 0);
    }),
    { numRuns: 400 },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// $JOBS, $UNEMP, $CPI, $CORECPI: the Bureau's figures
// ---------------------------------------------------------------------------------------------------------------

/** A month key, YYYY-MM, and the one before it on the calendar. */
const monthArb = fc.record({ y: fc.integer({ min: 1950, max: 2100 }), m: fc.integer({ min: 1, max: 12 }) });
const mkey = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
const prevMonth = ({ y, m }: { y: number; m: number }) => (m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 });

/** The percent change in tenths, half away from zero, worked in exact integers (thousandths of the index). */
function pctReference(v: bigint, p: bigint): number {
  const d = v - p < 0n ? p - v : v - p;
  const tenths = (2n * d * 1000n + p) / (2n * p);
  return Number(v < p ? -tenths : tenths) / 10 + 0;
}

await check("the CPI percent change matches exact integer arithmetic, half away from zero, at one decimal", () => {
  const thousandths = fc.integer({ min: 1, max: 1_000_000_000 });
  fc.assert(
    fc.property(thousandths, thousandths, (v, p) => {
      assert.equal(pctChange1dp(v / 1000, p / 1000), pctReference(BigInt(v), BigInt(p)));
    }),
    { numRuns: 1000 },
  );
  fc.assert(fc.property(fc.double({ noNaN: true }), fc.integer({ min: -1_000_000, max: 0 }), (v, p) => assert.equal(pctChange1dp(v, p / 1000), null)));
});

await check("a month's change is read against the calendar month before it, January against December", () => {
  fc.assert(
    fc.property(monthArb, fc.integer({ min: 0, max: 400_000_000 }), fc.integer({ min: 0, max: 400_000_000 }), (mo, a, b) => {
      const p = prevMonth(mo);
      const levels = { [mkey(mo.y, mo.m)]: a / 1000, [mkey(p.y, p.m)]: b / 1000 };
      assert.equal(blsValue(levels, mkey(mo.y, mo.m), "change_x1000"), a - b + 0);
      assert.equal(blsValue(levels, mkey(mo.y, mo.m), "level"), a / 1000);
      assert.equal(blsValue({ [mkey(mo.y, mo.m)]: a / 1000 }, mkey(mo.y, mo.m), "change_x1000"), null, "no month before: no change");
    }),
    { numRuns: 500 },
  );
});

/** Rows of the Bureau's flat file: series, year, period, value, unique by the first three. */
const SERIES = ["CES0000000001", "CUSR0000SA0", "CUSR0000SA0L1E", "LNS14000000"];
const flatRowsArb = fc.uniqueArray(
  fc.record({
    series: fc.constantFrom(...SERIES),
    year: fc.integer({ min: 1990, max: 2035 }),
    period: fc.integer({ min: 1, max: 13 }).map((m) => `M${String(m).padStart(2, "0")}`),
    value: fc.integer({ min: -9_999_999, max: 99_999_999 }).map((n) => n / 1000),
  }),
  { selector: (r) => `${r.series} ${r.year} ${r.period}`, maxLength: 120 },
);
const flatText = (rows: { series: string; year: number; period: string; value: number }[], eol: string) =>
  ["series_id                     \tyear\tperiod\t       value\tfootnote_codes", ...rows.map((r) => `${r.series.padEnd(30)}\t${r.year}\t${r.period}\t${String(r.value).padStart(12)}\t`)].join(eol) + eol;

await check("the BLS flat file round trips: written out and parsed back, each month of the asked series and nothing else", () => {
  fc.assert(
    fc.property(flatRowsArb, fc.constantFrom(...SERIES), fc.integer({ min: 1990, max: 2035 }), (rows, series, fromYear) => {
      const expected: Record<string, number> = {};
      for (const r of rows) if (r.series === series && r.period !== "M13" && r.year >= fromYear) expected[`${r.year}-${r.period.slice(1)}`] = r.value;
      assert.deepStrictEqual(parseBlsFlat(flatText(rows, "\n"), series, fromYear), expected);
      assert.deepStrictEqual(parseBlsFlat(flatText(rows, "\r\n"), series, fromYear), expected);
    }),
    { numRuns: 300 },
  );
});

await check("the BLS flat file parser takes any text without throwing, and reads only lines of the asked series", () => {
  fc.assert(
    fc.property(anyText, (text) => {
      const levels = parseBlsFlat(text, "CES0000000001");
      for (const v of Object.values(levels)) assert.ok(Number.isFinite(v));
      assert.ok(Object.keys(levels).length <= text.split(/\r?\n/).filter((l) => l.split("\t")[0]?.trim() === "CES0000000001").length);
    }),
    { numRuns: 400 },
  );
});

/** The API body for one series, as the Bureau sends it. */
const blsBody = (series: string, data: { year: number; m: number; value: number }[], status = "REQUEST_SUCCEEDED") =>
  JSON.stringify({ status, responseTime: 120, message: [], Results: { series: [{ seriesID: series, data: data.map((d) => ({ year: String(d.year), period: `M${String(d.m).padStart(2, "0")}`, periodName: "", value: String(d.value), footnotes: [{}] })) }] } });

await check("the BLS API reader round trips the Bureau's body; an answer with no list of months gives none, with a reason or a throw", async () => {
  const dataArb = fc.uniqueArray(fc.record({ year: fc.integer({ min: 1990, max: 2035 }), m: fc.integer({ min: 1, max: 12 }), value: fc.integer({ min: 0, max: 99_999_999 }).map((n) => n / 1000) }), { selector: (d) => `${d.year}-${d.m}`, maxLength: 40 });
  await fc.assert(
    fc.asyncProperty(dataArb, async (data) => {
      const read = await readBlsSeries("CES0000000001", { fetchImpl: fakeFetch(() => ({ status: 200, body: blsBody("CES0000000001", data) })) });
      assert.equal(read.error, undefined);
      assert.deepStrictEqual(read.levels, Object.fromEntries(data.map((d) => [mkey(d.year, d.m), d.value])));
    }),
    { numRuns: 200 },
  );
  const read = (body: string) => outcome(() => readBlsSeries("CES0000000001", { fetchImpl: fakeFetch(() => ({ status: 200, body })) }));
  const noMonths = anyBody.filter((b) => !jsonList(b, (j) => (j as { Results?: { series?: { data?: unknown }[] } } | null)?.Results?.series?.[0]?.data));
  await fc.assert(
    fc.asyncProperty(noMonths, async (body) => {
      const o = await read(body);
      if ("ok" in o) {
        assert.deepStrictEqual(o.ok.levels, {});
        if (!body.includes("REQUEST_SUCCEEDED")) assert.match(o.ok.error ?? "", /^bls_/);
      }
    }),
    { numRuns: 400 },
  );
  // A list of months with entries of any shape: only real months with finite levels, or a throw.
  const shapedJunk = fc.array(fc.jsonValue(), { maxLength: 8 }).map((data) => JSON.stringify({ status: "REQUEST_SUCCEEDED", Results: { series: [{ seriesID: "CES0000000001", data }] } }));
  await fc.assert(
    fc.asyncProperty(shapedJunk, async (body) => {
      const o = await read(body);
      if ("ok" in o) for (const [k, v] of Object.entries(o.ok.levels)) assert.ok(/-(0[1-9]|1[0-2])$/.test(k) && Number.isFinite(v), k);
    }),
    { numRuns: 400 },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// $LAYOFFS: the Labor Department's weekly claims file
// ---------------------------------------------------------------------------------------------------------------

/** One CSV cell, quoted when it holds a comma or a quote. */
const csvCell = (s: string) => (/[",]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);

/** The same rows in another order, picked by a seed. */
function shuffle<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  let x = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const j = x % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A claims file: every state for every week, columns in any order among others, and the national sums it should give. */
const claimsArb = fc
  .record({
    firstWeek: dayArb,
    weeks: fc.integer({ min: 2, max: 6 }),
    states: fc.uniqueArray(fc.stringMatching(/^[A-Z]{2}$/), { minLength: 1, maxLength: 12 }),
    extra: fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_ ,"]{0,6}$/), { maxLength: 3 }),
    claims: fc.array(fc.integer({ min: 0, max: 400_000 }), { minLength: 72, maxLength: 72 }),
    filler: fc.array(anyText.filter((s) => !/[\r\n]/.test(s)), { minLength: 1, maxLength: 4 }),
    order: fc.integer({ min: 0, max: 23 }),
    bom: fc.boolean(),
    eol: fc.constantFrom("\n", "\r\n"),
  })
  .map((c) => {
    const start = Date.parse(`${c.firstWeek}T00:00:00Z`);
    const weeks = Array.from({ length: c.weeks }, (_, i) => new Date(start + i * 7 * DAY_SEC * 1000).toISOString().slice(0, 10));
    const extra = c.extra.filter((h) => !["st", "rptdate", "c3"].includes(h.trim().toLowerCase()));
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const core = perms[c.order % 6].map((i) => ["st", "rptdate", "c3"][i]);
    const header = [...core.slice(0, 1), ...extra, ...core.slice(1)];
    const rows: { st: string; week: string; c3: number }[] = [];
    let k = 0;
    for (const week of weeks) for (const st of c.states) rows.push({ st, week, c3: c.claims[k++ % c.claims.length] });
    const line = (r: { st: string; week: string; c3: number }, i: number) =>
      header.map((h) => (h === "st" ? r.st : h === "rptdate" ? (i % 2 ? `${r.week}` : `${r.week}T00:00:00`) : h === "c3" ? String(r.c3) : csvCell(c.filler[i % c.filler.length]))).join(",");
    const sums = new Map(weeks.map((w) => [w, rows.filter((r) => r.week === w).reduce((s, r) => s + r.c3, 0)]));
    const text = (rs: typeof rows) => (c.bom ? "\uFEFF" : "") + [header.map(csvCell).join(","), ...rs.map(line)].join(c.eol) + c.eol;
    return { weeks, rows, sums, text, since: weeks[0] };
  });

await check("the claims file round trips: written in any column order and parsed back to each week's national sum", () => {
  fc.assert(fc.property(claimsArb, ({ rows, sums, text, since }) => assert.deepStrictEqual(parseDolClaims(text(rows), since), sums)), { numRuns: 300 });
});

await check("the claims sums do not depend on row order or on a row repeated, and a week missing a state is left out", () => {
  fc.assert(
    fc.property(claimsArb, fc.nat(), fc.nat(), ({ rows, sums, text, since }, seed, pick) => {
      assert.deepStrictEqual(parseDolClaims(text(shuffle(rows, seed)), since), sums);
      assert.deepStrictEqual(parseDolClaims(text([...rows, rows[pick % rows.length]]), since), sums);
      const gone = rows[pick % rows.length];
      const missing = new Map(sums);
      missing.delete(gone.week);
      // Every file has two weeks or more, so the full count of states is the most common one.
      assert.deepStrictEqual(parseDolClaims(text(rows.filter((r) => r !== gone)), since), missing);
      // One state given twice with two different figures makes its week unreadable.
      assert.deepStrictEqual(parseDolClaims(text([...rows, { ...gone, c3: gone.c3 + 1 }]), since), missing);
    }),
    { numRuns: 300 },
  );
});

await check("the claims parser takes any text: sums by week, or the one error for a file without its columns", () => {
  const headed = anyText.map((t) => `st,rptdate,c3\n${t}`);
  fc.assert(
    fc.property(fc.oneof(anyText, headed), dayArb, (text, since) => {
      try {
        for (const [week, n] of parseDolClaims(text, since)) {
          assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(week) && week >= since, week);
          assert.ok(Number.isInteger(n), String(n));
        }
      } catch (e) {
        assert.ok(e instanceof Error && e.name === "SourceError" && e.message === "dol_columns_missing", String(e));
      }
    }),
    { numRuns: 400 },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// The whole recount, as the co-signing job and npm run recount run it
// ---------------------------------------------------------------------------------------------------------------

/** What each public source answers in one generated world: a well formed body or anything at all. */
const sourcesArb = fc.record({
  blsApi: fc.oneof(anyBody, fc.uniqueArray(fc.record({ year: fc.integer({ min: 2024, max: 2027 }), m: fc.integer({ min: 1, max: 12 }), value: fc.integer({ min: 0, max: 400_000_000 }).map((n) => n / 1000) }), { selector: (d) => `${d.year}-${d.m}`, maxLength: 30 }).map((d) => ({ d }))),
  flat: fc.oneof(anyBody, flatRowsArb.map((rows) => flatText(rows, "\n"))),
  fred: fc.oneof(anyBody, fc.array(fc.tuple(fc.integer({ min: 2024, max: 2027 }), fc.integer({ min: 1, max: 12 }), fc.oneof(fc.constant("."), fc.integer({ min: 0, max: 400_000 }).map(String))), { maxLength: 30 }).map((rows) => `observation_date,X\n${rows.map(([y, m, v]) => `${mkey(y, m)}-01,${v}`).join("\n")}\n`)),
  dol: fc.oneof(anyBody, claimsArb.map((c) => c.text(c.rows))),
  rpc: fc.oneof(anyBody, chainArb.map(({ chain }) => JSON.stringify({ jsonrpc: "2.0", id: 1, result: chain.slice(0, 999) }))),
  status: fc.constantFrom(200, 200, 200, 404, 403),
});

const TICKERS = [
  { ticker: "JOBS", period: "2026-10-01", decimals: 0 },
  { ticker: "UNEMP", period: "2026-10-01", decimals: 1 },
  { ticker: "CPI", period: "2026-02-01", decimals: 1 },
  { ticker: "CORECPI", period: "2027-01-01", decimals: 1 },
  { ticker: "LAYOFFS", period: "2026-10-10", decimals: 0 },
  { ticker: "MINTS", period: "2026-11-17", decimals: 0 },
];

type World = typeof sourcesArb extends fc.Arbitrary<infer T> ? T : never;

/** A fetch that answers each public source from one generated world. */
function worldFetch(s: World, series: string): typeof fetch {
  return fakeFetch((url) => {
    const host = new URL(url).host;
    if (host === "api.bls.gov") return { status: s.status, body: typeof s.blsApi === "string" ? s.blsApi : blsBody(series, s.blsApi.d) };
    if (host === "download.bls.gov") return { status: s.status, body: s.flat };
    if (host === "fred.stlouisfed.org") return { status: s.status, body: s.fred };
    if (host === "oui.doleta.gov") return { status: s.status, body: s.dol };
    return { status: s.status, body: s.rpc };
  });
}

await check("a recount of any signed ticker, whatever the sources answer, ends the same way on every run: a scaled value, a reason, or the same error", async () => {
  await fc.assert(
    fc.asyncProperty(fc.constantFrom(...TICKERS), sourcesArb, async (t, world) => {
      const r = { ticker: t.ticker, period: t.period, decimals: t.decimals } as Report;
      const series = { JOBS: "CES0000000001", UNEMP: "LNS14000000", CPI: "CUSR0000SA0", CORECPI: "CUSR0000SA0L1E" }[t.ticker] ?? "";
      const run = () => outcome(() => recount(r, { solanaRpc: RPC, fetchImpl: worldFetch(world, series) }));
      const a = await run();
      assert.deepStrictEqual(await run(), a, "same answers, same recount");
      if ("ok" in a && a.ok.value == null) assert.ok(typeof a.ok.error === "string" && a.ok.error.length > 0);
      else if ("ok" in a) assert.match(a.ok.value!, /^(0|-?[1-9]\d*)$/);
    }),
    { numRuns: 300 },
  );
});

await check("a BLS API answer with no months falls back to the flat file, then FRED; a page that is not JSON never gives a value", async () => {
  const jobs = { ticker: "JOBS", period: "2026-10-01", decimals: 0 } as Report;
  const flat = flatText([{ series: "CES0000000001", year: 2026, period: "M09", value: 159540 }, { series: "CES0000000001", year: 2026, period: "M10", value: 159705 }], "\n");
  const fred = "observation_date,PAYEMS\n2026-09-01,159540\n2026-10-01,159705\n";
  const answers = (api: string, flatStatus: number) => fakeFetch((url) => {
    const host = new URL(url).host;
    if (host === "download.bls.gov") return { status: flatStatus, body: flat };
    if (host === "fred.stlouisfed.org") return { status: 200, body: fred };
    return { status: 200, body: api };
  });
  const capped = JSON.stringify({ status: "REQUEST_NOT_PROCESSED", message: ["The daily threshold for total number of requests allocated has been reached."], Results: {} });
  assert.deepStrictEqual(await recount(jobs, { fetchImpl: answers(capped, 200) }), { value: "165000", how: "BLS flat file CES0000000001", error: undefined });
  assert.deepStrictEqual(await recount(jobs, { fetchImpl: answers(capped, 404) }), { value: "165000", how: "FRED PAYEMS", error: undefined });
  const html = "<html><body>Service busy</body></html>";
  for (const r of [jobs, { ticker: "MINTS", period: "2026-11-17", decimals: 0 } as Report]) {
    const o = await outcome(() => recount(r, { solanaRpc: RPC, fetchImpl: answers(html, 404) }));
    if ("ok" in o) assert.equal(o.ok.value, null, r.ticker);
  }
});

console.log(`\n${passed} passed`);
