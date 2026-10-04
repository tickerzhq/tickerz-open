/**
 * $MINTS: the chain counter, against a fake chain. Copied from Tickerz's production test suite (the chain block of
 * indices.test.ts), with a check that the accounts are the ones the rulebook names. Plain asserts, no network.
 * Run: node --import tsx test/mints.test.ts
 */
import assert from "node:assert/strict";
import {
  GRADUATIONS_ACCOUNT,
  MINTS_ACCOUNT,
  SIGS_PAGE,
  advanceChain,
  chainObservations,
  emptyTally,
  pageSignatures,
  pruneChainDays,
  solanaRpc,
  tallySigs,
  type ChainState,
  type Poster,
  type SigInfo,
} from "../src/mints";
import { rulebookOf } from "../src/rulebook";

let passed = 0;
const pending: Promise<void>[] = [];
function check(name: string, fn: () => void | Promise<void>) {
  const r = fn();
  const done = () => { passed++; console.log(`ok ${name}`); };
  if (r instanceof Promise) pending.push(r.then(done, (e) => { console.error(`FAIL ${name}`); throw e; }));
  else done();
}

check("MINTS: counted on pump.fun's mint authority, graduations on its migrator, as the rulebook names them", () => {
  const m = rulebookOf("MINTS")!;
  assert.deepEqual(m.chain, { kind: "solana_sigs", account: "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM", graduations: "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg" });
  assert.equal(MINTS_ACCOUNT, "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM");
  assert.equal(GRADUATIONS_ACCOUNT, "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg");
  assert.match(m.counts, /Rulebook v0\.1/);
  assert.deepEqual(m.companion, { ticker: "MINTS.GRADS", label: "Graduations" });
});

const sec = (iso: string) => Date.parse(iso) / 1000;

check("chain tally: UTC day edges, failed and untimed left out, stops at the from time", () => {
  const t = emptyTally();
  const page: SigInfo[] = [
    { signature: "a", blockTime: sec("2026-09-24T00:00:00Z"), err: null },
    { signature: "b", blockTime: sec("2026-09-23T23:59:59Z"), err: null },
    { signature: "c", blockTime: sec("2026-09-23T23:59:58Z"), err: { InstructionError: [0, "Custom"] } },
    { signature: "d", blockTime: null, err: null },
    { signature: "e", blockTime: sec("2026-09-23T00:00:00Z"), err: null },
    { signature: "f", blockTime: sec("2026-09-22T23:59:59Z"), err: null },
  ];
  assert.deepEqual(tallySigs(page, sec("2026-09-23T00:00:00Z"), t), { reachedFrom: true });
  assert.deepEqual([...t.days], [["2026-09-24", 1], ["2026-09-23", 2]]);
  assert.deepEqual([...t.hours], [["2026-09-24T00", 1], ["2026-09-23T23", 1], ["2026-09-23T00", 1]]);
  assert.equal(t.failed, 1);
  assert.equal(t.untimed, 1);
  // With an earlier from time the last signature lands on Sep 22.
  const u = emptyTally();
  assert.deepEqual(tallySigs(page, 0, u), { reachedFrom: false });
  assert.equal(u.days.get("2026-09-22"), 1);
});

/**
 * A fake chain for one account, newest first, served the way getSignaturesForAddress serves it: at most `limit`
 * below `before` and above `until`, both exclusive. `head` adds new signatures at the top.
 */
function fakeChain(sigs: SigInfo[]) {
  const chain = [...sigs];
  const calls: Record<string, unknown>[] = [];
  const post: Poster = async (_url, body) => {
    const req = JSON.parse(body) as { method: string; params: [string, Record<string, unknown>] };
    assert.equal(req.method, "getSignaturesForAddress");
    const cfg = req.params[1];
    calls.push(cfg);
    assert.equal(cfg.commitment, "finalized");
    let i = cfg.before ? chain.findIndex((s) => s.signature === cfg.before) + 1 : 0;
    const stop = cfg.until ? chain.findIndex((s) => s.signature === cfg.until) : chain.length;
    const out: SigInfo[] = [];
    for (; i < (stop < 0 ? chain.length : stop) && out.length < Number(cfg.limit); i++) out.push(chain[i]);
    return { status: 200, text: JSON.stringify({ jsonrpc: "2.0", id: 1, result: out }) };
  };
  return { chain, calls, post, head: (more: SigInfo[]) => chain.unshift(...more) };
}

/** n signatures ending at `end` (newest), one every `every` seconds, every `failEvery`-th failed. */
function sigRun(prefix: string, n: number, endIso: string, every: number, failEvery = 0): SigInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    signature: `${prefix}${i}`,
    blockTime: sec(endIso) - i * every,
    err: failEvery && i % failEvery === failEvery - 1 ? { InstructionError: [0, "Custom"] } : null,
  }));
}

const noSleep = async () => {};
const truth = (sigs: SigInfo[], fromSec: number) => {
  const m = new Map<string, number>();
  for (const s of sigs) if (s.err == null && s.blockTime != null && s.blockTime >= fromSec) m.set(new Date(s.blockTime * 1000).toISOString().slice(0, 10), (m.get(new Date(s.blockTime * 1000).toISOString().slice(0, 10)) ?? 0) + 1);
  return Object.fromEntries([...m].sort());
};

check("chain pages 1,000 at a time newest first and stops at the cursor", async () => {
  // 2,500 signatures, 30 seconds apart, ending 14:00 on Sep 23; the cursor is the 2,301st.
  const f = fakeChain(sigRun("s", 2500, "2026-09-23T14:00:00Z", 30));
  const rpc = solanaRpc({ post: f.post, sleep: noSleep });
  const r = await pageSignatures(rpc, { account: "acct", until: "s2300", fromSec: 0, maxPages: 10 }, noSleep);
  assert.equal(r.complete, true);
  assert.equal(r.pages, 3);
  assert.equal(r.newest!.signature, "s0");
  assert.equal(r.oldest!.signature, "s2299");
  assert.equal([...r.tally.days.values()].reduce((a, b) => a + b, 0), 2300);
  assert.equal(SIGS_PAGE, 1000);
  assert.deepEqual(f.calls.map((c) => c.before ?? null), [null, "s999", "s1999"]);
  assert.ok(f.calls.every((c) => c.until === "s2300" && c.limit === 1000));
});

check("chain cursor: the first run starts at 00:00 UTC, later runs add only what is new, nothing twice", async () => {
  // 3,000 signatures 60 seconds apart back from 14:00 Sep 23: about 50 hours, over Sep 21, 22 and 23; every 10th failed.
  const old = sigRun("o", 3000, "2026-09-23T14:00:00Z", 60, 10);
  const f = fakeChain(old);
  const now = Date.parse("2026-09-23T14:05:00Z");
  const first = await advanceChain("acct", null, { post: f.post, sleep: noSleep, now, maxPages: 40 });
  assert.equal(first.state.newest, "o0");
  assert.equal(first.state.gap, null);
  // Only today, from 00:00 UTC: 14 hours and one signature on the hour.
  assert.deepEqual(first.state.days, truth(old, sec("2026-09-23T00:00:00Z")));
  assert.deepEqual(Object.keys(first.state.days), ["2026-09-23"]);

  // An hour later 1,500 new signatures land, 2 seconds apart, the newest at 14:59:58.
  const fresh = sigRun("n", 1500, "2026-09-23T14:59:58Z", 2);
  f.head(fresh);
  const calls = f.calls.length;
  const second = await advanceChain("acct", first.state, { post: f.post, sleep: noSleep, now: Date.parse("2026-09-23T15:00:00Z"), maxPages: 40 });
  assert.ok(f.calls.slice(calls).every((c) => c.until === "o0"), "reads forward from the cursor");
  assert.equal(second.state.newest, "n0");
  assert.equal(second.state.days["2026-09-23"], first.state.days["2026-09-23"] + 1500);
  assert.deepEqual(chainObservations(second.state, Date.parse("2026-09-23T15:00:00Z")), [{ period: "2026-09-23", value: second.state.days["2026-09-23"] }]);

  // Nothing new: nothing added, the cursor stays.
  const third = await advanceChain("acct", second.state, { post: f.post, sleep: noSleep, now: Date.parse("2026-09-23T16:00:00Z"), maxPages: 40 });
  assert.deepEqual(third.state, second.state);
});

check("chain cursor: a read cut short leaves a gap, holds its days, and the next runs fill it exactly", async () => {
  const start = sigRun("a", 10, "2026-09-22T20:00:00Z", 60);
  const f = fakeChain(start);
  const now0 = Date.parse("2026-09-22T20:10:00Z");
  const s0 = (await advanceChain("acct", null, { post: f.post, sleep: noSleep, now: now0, maxPages: 5 })).state;
  assert.equal(s0.days["2026-09-22"], 10);
  // A missed day: 2,600 signatures 40 seconds apart back from Sep 24 at 04:00, to Sep 22 at about 23:07.
  const burst = sigRun("b", 2600, "2026-09-24T04:00:00Z", 40);
  f.head(burst);
  const now1 = Date.parse("2026-09-24T04:10:00Z");
  const s1 = (await advanceChain("acct", s0, { post: f.post, sleep: noSleep, now: now1, maxPages: 1 })).state;
  assert.ok(s1.gap, "a gap is open");
  assert.equal(s1.newest, "b0");
  assert.equal(s1.gap!.until, "a0");
  assert.equal(s1.gap!.before, "b999");
  // The gap runs from Sep 22 (the old cursor's day) to the day of b999 (Sep 23): those days wait; Sep 24 prints.
  assert.deepEqual(chainObservations(s1, now1).map((o) => o.period), ["2026-09-24"]);
  // Two more runs of one page each fill the gap; nothing new arrives meanwhile.
  const s2 = (await advanceChain("acct", s1, { post: f.post, sleep: noSleep, now: now1, maxPages: 1 })).state;
  assert.ok(s2.gap);
  const s3 = (await advanceChain("acct", s2, { post: f.post, sleep: noSleep, now: now1, maxPages: 1 })).state;
  assert.equal(s3.gap, null);
  const all = truth([...burst, ...start], sec("2026-09-22T00:00:00Z"));
  assert.deepEqual(s3.days, all);
  assert.deepEqual(chainObservations(s3, now1), Object.entries(all).map(([period, value]) => ({ period, value })));
});

check("chain cursor keeps recovered days until they are written, then keeps the last three", async () => {
  const f = fakeChain([]);
  const prior: ChainState = { newest: "x", newest_time: sec("2026-09-20T10:00:00Z"), days: { "2026-09-20": 5, "2026-09-21": 6, "2026-09-22": 7, "2026-09-23": 8 }, gap: null };
  const now = Date.parse("2026-09-23T10:00:00Z");
  // The read itself drops nothing: a long catch-up's older days must reach storage first.
  const r = await advanceChain("acct", prior, { post: f.post, sleep: noSleep, now, maxPages: 5 });
  assert.deepEqual(r.state.days, prior.days);
  assert.deepEqual(chainObservations(r.state, now).map((o) => o.period), ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23"]);
  // After the write, days older than three are pruned, but only the ones written.
  assert.deepEqual(pruneChainDays(r.state, now, new Set(["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23"])).days, { "2026-09-21": 6, "2026-09-22": 7, "2026-09-23": 8 });
  assert.deepEqual(pruneChainDays(r.state, now, new Set(["2026-09-22", "2026-09-23"])).days, prior.days);
});

check("chain rate limit: one retry after a 429 with a wait, then the second endpoint, then a refusal", async () => {
  const ok = JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] });
  const waits: number[] = [];
  const sleep = async (ms: number) => { waits.push(ms); };
  const seq = (answers: number[]) => {
    const asked: string[] = [];
    const post: Poster = async (url) => {
      asked.push(url);
      const status = answers.shift() ?? 200;
      return { status, text: status === 200 ? ok : "Too many requests" };
    };
    return { asked, post };
  };
  const eps = ["https://one", "https://two"];

  // 429, then 200 on the same endpoint after one wait.
  const a = seq([429, 200]);
  const ra = solanaRpc({ post: a.post, sleep, endpoints: eps, backoffMs: 2000 });
  assert.deepEqual(await ra.call("getSignaturesForAddress", ["x", {}]), []);
  assert.deepEqual(a.asked, ["https://one", "https://one"]);
  assert.deepEqual(waits, [2000]);
  assert.equal(ra.state.retries, 1);

  // 429 twice: the second endpoint answers, and is kept for the next call.
  const b = seq([429, 429, 200, 200]);
  const rb = solanaRpc({ post: b.post, sleep, endpoints: eps, backoffMs: 2000 });
  await rb.call("getSignaturesForAddress", ["x", {}]);
  await rb.call("getSignaturesForAddress", ["x", {}]);
  assert.deepEqual(b.asked, ["https://one", "https://one", "https://two", "https://two"]);

  // A 403 moves on at once, with no wait; a thrown connection error counts as a refusal too.
  waits.length = 0;
  const c = seq([403, 200]);
  await solanaRpc({ post: c.post, sleep, endpoints: eps }).call("getSignaturesForAddress", ["x", {}]);
  assert.deepEqual(c.asked, ["https://one", "https://two"]);
  assert.deepEqual(waits, []);
  let n = 0;
  const flaky: Poster = async () => { if (n++ === 0) throw new Error("reset"); return { status: 200, text: ok }; };
  assert.deepEqual(await solanaRpc({ post: flaky, sleep, endpoints: eps }).call("m", []), []);

  // An RPC error in a 200 body is a refusal; when every endpoint refuses, the read throws and nothing is counted.
  const d = seq([429, 429, 429, 429]);
  await assert.rejects(solanaRpc({ post: d.post, sleep, endpoints: eps }).call("getSignaturesForAddress", ["x", {}]), /solana_rpc_refused_http_429/);
  const e: Poster = async () => ({ status: 200, text: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "busy" } }) });
  await assert.rejects(solanaRpc({ post: e, sleep, endpoints: eps }).call("m", []), /solana_rpc_refused_rpc_-32005/);

  // A refused page inside a run fails the run: the cursor state is only returned, and so only stored, on success.
  const g = seq([500, 500]);
  await assert.rejects(advanceChain("acct", null, { post: g.post, sleep, endpoints: eps, now: Date.parse("2026-09-23T10:00:00Z"), maxPages: 5 }), /solana_rpc_refused/);
});

check("chain pages wait between calls, and stop at the deadline after at least one page", async () => {
  const f = fakeChain(sigRun("s", 3500, "2026-09-23T14:00:00Z", 10));
  const waits: number[] = [];
  let clock = 1000;
  const r = await pageSignatures(solanaRpc({ post: f.post, sleep: noSleep }), { account: "acct", fromSec: 0, maxPages: 10, deadline: 1300, now: () => clock, delayMs: 150 }, async (ms) => { waits.push(ms); clock += 400; });
  // Page 1 at 1000, before the deadline: wait 150, page 2 at 1400, past it: stop at 2 pages.
  assert.equal(r.pages, 2);
  assert.equal(r.complete, false);
  assert.deepEqual(waits, [150]);
});

Promise.all(pending).then(() => console.log(`\n${passed} passed`), () => process.exit(1));
