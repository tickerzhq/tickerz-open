/**
 * Property tests (fast-check) for what oracle/ does now that it is in step with Tickerz's production code: how the
 * $MINTS read handles a page that is not JSON, refusals and dropped connections (up to READ_ATTEMPTS tries a page),
 * how the BLS API reader takes an answer that is not the Bureau's, and where core CPI's flat file is read. Answers
 * come from a fake fetch, so there is no network. Run: node --import tsx test/oracle.property.test.ts
 */
import assert from "node:assert/strict";
import fc from "fast-check";
import { recount } from "../oracle/src/lib/oracle/cosign";
import { BLS_FLAT_FILE, countSolanaDay, readBlsSeries, READ_ATTEMPTS } from "../oracle/src/lib/oracle/recount";
import { pctChange1dp } from "../oracle/src/lib/indices/bls";
import { scaled } from "../oracle/src/lib/oracle/canonical";
import type { Report } from "../oracle/src/lib/oracle/report";

// oracle/ is copied from Tickerz's Next.js code, which passes cache: "no-store" to fetch. The DOM's RequestInit has
// that field and Node's types leave it out; tsc reads oracle/ through the imports above, so the field is declared here.
declare global {
  interface RequestInit {
    cache?: "default" | "force-cache" | "no-cache" | "no-store" | "only-if-cached" | "reload";
  }
}

// Each property stops after a minute (shrinking included), and a minute without an answer counts as a failure.
fc.configureGlobal({ interruptAfterTimeLimit: 60_000, markInterruptAsFailure: true });

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok ${name}`);
}

const DAY_SEC = 86_400;
const RPC = "https://rpc.example.test/";
const dayArb = fc
  .date({ min: new Date("2015-01-01T00:00:00Z"), max: new Date("2035-12-31T00:00:00Z"), noInvalidDate: true })
  .map((d) => d.toISOString().slice(0, 10));
const anyText = fc.oneof(fc.string(), fc.string({ unit: "binary" }), fc.string({ unit: fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c)) }));
const isJson = (s: string) => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};
/** Text that is not JSON: what a proxy or a busy node sends back in place of an answer. */
const notJson = anyText.filter((s) => !isJson(s));

type Answer = { status: number; body: string } | { throws: Error };
/** A fetch that answers from a function of the URL and the request body, never the network. */
function fakeFetch(answer: (url: string, body: string) => Answer): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const a = answer(url, typeof init?.body === "string" ? init.body : "");
    if ("throws" in a) throw a.throws;
    return new Response(a.body, { status: a.status });
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------------------------------------------
// $MINTS: a chain of signatures around one day, served page by page
// ---------------------------------------------------------------------------------------------------------------

type Sig = { signature: string; blockTime: number | null; err: unknown; slot: number };

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

/**
 * getSignaturesForAddress over a list held in memory, newest first, `limit` at a time below `before`. `fault(page,
 * attempt)` may answer in the page's place: page and attempt count from 1.
 */
function fakeRpc(chain: readonly Sig[], fault: (page: number, attempt: number) => Answer | null = () => null) {
  const tries = new Map<number, number>();
  const fetchImpl = fakeFetch((_url, body) => {
    const req = JSON.parse(body) as { id: number; params: [string, { limit: number; before?: string }] };
    const { limit, before } = req.params[1];
    const from = before ? chain.findIndex((s) => s.signature === before) + 1 : 0;
    const page = Math.floor(from / limit) + 1;
    const attempt = (tries.get(page) ?? 0) + 1;
    tries.set(page, attempt);
    return fault(page, attempt) ?? { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: req.id, result: chain.slice(from, from + limit) }) };
  });
  return { fetchImpl, tries };
}

const read = (day: string, fetchImpl: typeof fetch) => countSolanaDay(RPC, "Acct", day, { fetchImpl, delayMs: 0, retryMs: 0 });

await check("$MINTS: a page that is not JSON ends the read with not_json and its page number; the pages before it stay in the snapshot", async () => {
  await fc.assert(
    fc.asyncProperty(chainArb, fc.nat(), notJson, async ({ day, chain }, pick, junk) => {
      const clean = fakeRpc(chain);
      await read(day, clean.fetchImpl);
      const k = 1 + (pick % clean.tries.size);
      const r = await read(day, fakeRpc(chain, (page) => (page === k ? { status: 200, body: junk } : null)).fetchImpl);
      assert.equal(r.value, null);
      assert.equal(r.error, `not_json, page ${k}`);
      assert.equal(r.rows, (k - 1) * 1000);
      // The snapshot: one line for each page before it, then the bad page as it came (as UTF-8, like any answer).
      const bad = Buffer.from(`${junk}\n`, "utf8");
      assert.ok(r.bytes.subarray(r.bytes.length - bad.length).equals(bad));
      assert.equal(r.bytes.subarray(0, r.bytes.length - bad.length).toString("utf8").split("\n").filter(Boolean).length, k - 1);
    }),
    { numRuns: 60 },
  );
});

/** What a node does instead of answering: refuses for speed, fails, or the connection drops. */
const failureArb = fc.constantFrom<{ answer: Answer; reason: string }>(
  { answer: { status: 429, body: "Too Many Requests" }, reason: "http_429" },
  { answer: { status: 500, body: "Internal Server Error" }, reason: "http_500" },
  { answer: { status: 503, body: "" }, reason: "http_503" },
  { answer: { throws: new TypeError("fetch failed") }, reason: "fetch:TypeError" },
);

await check(`$MINTS: refusals and dropped connections are asked again, up to ${READ_ATTEMPTS} tries a page, and the count is the clean read's`, async () => {
  await fc.assert(
    fc.asyncProperty(chainArb, fc.array(fc.tuple(fc.integer({ min: 0, max: READ_ATTEMPTS - 1 }), failureArb), { minLength: 3, maxLength: 3 }), async ({ day, start, chain }, plan) => {
      const rpc = fakeRpc(chain, (page, attempt) => {
        const [fails, f] = plan[(page - 1) % plan.length];
        return attempt <= fails ? f.answer : null;
      });
      const r = await read(day, rpc.fetchImpl);
      assert.equal(r.error, undefined);
      assert.equal(r.value, countDay(chain, start));
      for (const [page, tries] of rpc.tries) assert.equal(tries, plan[(page - 1) % plan.length][0] + 1, `page ${page}`);
    }),
    { numRuns: 60 },
  );
});

await check(`$MINTS: a page that fails ${READ_ATTEMPTS} times ends the read, named by the last failure and the page`, async () => {
  await fc.assert(
    fc.asyncProperty(chainArb, fc.nat(), failureArb, async ({ day, chain }, pick, f) => {
      const clean = fakeRpc(chain);
      await read(day, clean.fetchImpl);
      const k = 1 + (pick % clean.tries.size);
      const rpc = fakeRpc(chain, (page) => (page === k ? f.answer : null));
      const r = await read(day, rpc.fetchImpl);
      assert.deepStrictEqual([r.value, r.error], [null, `${f.reason} after ${READ_ATTEMPTS} tries, page ${k}`]);
      assert.equal(rpc.tries.get(k), READ_ATTEMPTS);
    }),
    { numRuns: 60 },
  );
});

await check("$MINTS: any other refusal ends the read at once, with the status and the start of the answer", async () => {
  await fc.assert(
    fc.asyncProperty(fc.constantFrom(400, 401, 403, 404, 410, 413), anyText, async (status, body) => {
      const rpc = fakeRpc([], () => ({ status, body }));
      const r = await read("2026-11-17", rpc.fetchImpl);
      const sent = await new Response(body).text();
      assert.deepStrictEqual([r.value, r.error], [null, `http_${status}:${sent.slice(0, 60)}`]);
      assert.equal(rpc.tries.get(1), 1);
    }),
    { numRuns: 200 },
  );
});

await check("$MINTS: JSON with no list of signatures never gives a count: an rpc: reason, or a throw for the JSON null", async () => {
  await fc.assert(
    fc.asyncProperty(fc.jsonValue().filter((j) => !Array.isArray((j as { result?: unknown } | null)?.result)), async (j) => {
      const go = () => read("2026-11-17", fakeFetch(() => ({ status: 200, body: JSON.stringify(j) })));
      if (j === null) return void (await assert.rejects(go, TypeError));
      const r = await go();
      assert.equal(r.value, null);
      assert.match(r.error ?? "", /^rpc:/);
    }),
    { numRuns: 300 },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// The Bureau of Labor Statistics
// ---------------------------------------------------------------------------------------------------------------

await check("the BLS API reader: an answer that is not JSON is thrown as a SyntaxError; JSON with no months gives none, with a bls_ reason", async () => {
  const go = (body: string) => readBlsSeries("CES0000000001", { fetchImpl: fakeFetch(() => ({ status: 200, body })) });
  await fc.assert(fc.asyncProperty(notJson, async (body) => void (await assert.rejects(go(body), SyntaxError))), { numRuns: 300 });
  const noMonths = fc.jsonValue().filter((j) => j !== null && (j as { status?: unknown }).status !== "REQUEST_SUCCEEDED" && (j as { Results?: { series?: { data?: unknown }[] } }).Results?.series?.[0]?.data == null);
  await fc.assert(
    fc.asyncProperty(noMonths, async (j) => {
      const r = await go(JSON.stringify(j));
      assert.deepStrictEqual(r.levels, {});
      assert.match(r.error ?? "", /^bls_/);
    }),
    { numRuns: 300 },
  );
});

await check("core CPI falls back to the Bureau's special aggregates file, and its percent change comes out at one decimal", async () => {
  assert.equal(BLS_FLAT_FILE.CUSR0000SA0L1E, "https://download.bls.gov/pub/time.series/cu/cu.data.20.USCommoditiesServicesSpecial");
  const thousandths = fc.integer({ min: 100_000, max: 900_000 });
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 2016, max: 2030 }), fc.integer({ min: 1, max: 12 }), thousandths, thousandths, async (y, m, a, b) => {
      const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
      const line = (yy: number, mm: number, v: number) => `CUSR0000SA0L1E                \t${yy}\tM${String(mm).padStart(2, "0")}\t${String(v / 1000).padStart(12)}\t`;
      const flat = ["series_id\tyear\tperiod\tvalue\tfootnote_codes", line(prev.y, prev.m, b), line(y, m, a)].join("\n") + "\n";
      const asked: string[] = [];
      const fetchImpl = fakeFetch((url) => {
        asked.push(url);
        if (url === BLS_FLAT_FILE.CUSR0000SA0L1E) return { status: 200, body: flat };
        if (url.startsWith("https://api.bls.gov/")) return { status: 200, body: JSON.stringify({ status: "REQUEST_NOT_PROCESSED", Results: {} }) };
        return { status: 404, body: "" };
      });
      const period = `${y}-${String(m).padStart(2, "0")}-01`;
      const r = await recount({ ticker: "CORECPI", period, decimals: 1 } as Report, { fetchImpl });
      const pct = pctChange1dp(a / 1000, b / 1000);
      assert.ok(pct != null);
      assert.deepStrictEqual(r, { value: scaled(pct, 1), how: "BLS flat file CUSR0000SA0L1E", error: undefined });
      assert.deepStrictEqual(asked.slice(0, 2), ["https://api.bls.gov/publicAPI/v1/timeseries/data/", BLS_FLAT_FILE.CUSR0000SA0L1E]);
    }),
    { numRuns: 200 },
  );
});

console.log(`\n${passed} passed`);
