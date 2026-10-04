/**
 * $GIGS and $WAGE: payment extraction, the sample, the estimate and the payer-balanced median. Copied from Tickerz's
 * production test suite (machines.test.ts), less the checks of display code not in this repo, plus checks for dayFromHours and
 * the facilitator list. Plain asserts; the one async check runs readHour against an injected fake node, no network.
 * Run: node --import tsx test/machines.test.ts
 */
import assert from "node:assert/strict";
import { AUTH_USED_TOPIC, BASE_USDC, TRANSFER_TOPIC, aggregateHour, dayFromHours, dayStats, estimateGigs, inSample, paymentsFromReceipt, percentile, readHour, weightedMedian, WAGE_MIN_PAYERS, type Payment } from "../src/machines";
import { BASE_FACILITATORS } from "../src/facilitators";
import { rulebookOf } from "../src/rulebook";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${name}`);
}

const pad = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`;
const FAC = { "0x1111111111111111111111111111111111111111": "coinbase" };
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const transfer = (from: string, to: string, amount: number) => ({
  address: BASE_USDC, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: `0x${amount.toString(16)}`, transactionHash: "0x01",
});

const auth = (signer: string, nonce = "9") => ({ address: BASE_USDC, topics: [AUTH_USED_TOPIC, pad(signer), "0x" + nonce.repeat(64)], data: "0x", transactionHash: "0x01" });
const F = "0x1111111111111111111111111111111111111111";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";
const R = "0x9c955c40dc98fce89a133f402ffbf94070e6e299";
const S = "0xfe802b35182f49778eec14db3153fcb8b92a47ee";

check("a payment counts only when a listed facilitator sent it and it succeeded", () => {
  const logs = [auth(A), transfer(A, B, 1000)];
  assert.deepEqual(paymentsFromReceipt({ from: F, status: "0x1", logs }, FAC), [{ payer: A, payee: B, facilitator: "coinbase", priceE6: 1000, leg: 0 }]);
  assert.deepEqual(paymentsFromReceipt({ from: "0x2222222222222222222222222222222222222222", status: "0x1", logs }, FAC), [], "an unlisted sender");
  assert.deepEqual(paymentsFromReceipt({ from: F, status: "0x0", logs }, FAC), [], "a failed transaction");
  assert.deepEqual(paymentsFromReceipt({ from: F, status: "0x1", logs: [auth(A), transfer(A, A, 1000)] }, FAC), [], "a payer paying itself");
  assert.deepEqual(paymentsFromReceipt(null, FAC), []);
});

check("a transfer no authorization covers is not a payment", () => {
  assert.deepEqual(paymentsFromReceipt({ from: F, status: "0x1", logs: [transfer(A, B, 1000)] }, FAC), []);
  const fee = [auth(A), transfer(A, B, 1000), transfer(B, C, 10)];
  assert.deepEqual(paymentsFromReceipt({ from: F, status: "0x1", logs: fee }, FAC), [{ payer: A, payee: B, facilitator: "coinbase", priceE6: 1000, leg: 0 }], "a fee of a different amount stays out");
});

check("a payment through a router is one payment to the service, the router kept as via (Fluxa, Sep 23 to 29)", () => {
  const logs = [auth(A), transfer(A, R, 1000), transfer(R, S, 1000)];
  assert.deepEqual(paymentsFromReceipt({ from: F, status: "0x1", logs }, FAC), [{ payer: A, payee: S, facilitator: "coinbase", priceE6: 1000, leg: 0, via: R }]);
});

check("a fee proxy that keeps 1%: the payee is the service, the price what the payer signed for (Meridian)", () => {
  const logs = [auth(A), transfer(A, R, 1000), transfer(R, C, 10), transfer(R, S, 990)];
  assert.deepEqual(paymentsFromReceipt({ from: F, status: "0x1", logs }, FAC), [{ payer: A, payee: S, facilitator: "coinbase", priceE6: 1000, leg: 0, via: R }]);
});

check("a settlement contract carrying several authorizations: one payment each, legs in order", () => {
  const logs = [auth(A, "1"), transfer(A, B, 1000), auth(C, "2"), transfer(C, B, 2000), auth(A, "3"), transfer(A, C, 3000)];
  const p = paymentsFromReceipt({ from: F, status: "0x1", logs }, FAC);
  assert.deepEqual(p.map((x) => [x.payer, x.payee, x.priceE6, x.leg]), [[A, B, 1000, 0], [C, B, 2000, 1], [A, C, 3000, 2]]);
  const skipped = paymentsFromReceipt({ from: F, status: "0x1", logs: [auth(A, "1"), transfer(A, A, 5), auth(C, "2"), transfer(C, B, 2000)] }, FAC);
  assert.deepEqual(skipped.map((x) => x.leg), [1], "a left out sibling keeps the next leg's number");
});

check("a deposit into an x402 payment channel is not a paid call", () => {
  const collector = "0x4020806089470a89826cb9fb1f4059150b550004";
  const settlement = "0x4020074e9df2ce1dee5a9c1b5c3f541d02a10003";
  const logs = [auth(A), transfer(A, collector, 5_000_000), transfer(collector, settlement, 5_000_000)];
  assert.deepEqual(paymentsFromReceipt({ from: F, status: "0x1", logs }, FAC), []);
});

check("logs of another token do not count", () => {
  const other = { ...transfer(A, B, 1000), address: "0x0000000000000000000000000000000000000001" };
  assert.deepEqual(paymentsFromReceipt({ from: F, status: "0x1", logs: [auth(A), other] }, FAC), []);
});

check("an hour aggregates by payer, payee, facilitator and price", () => {
  const p = { payer: A, payee: B, facilitator: "coinbase", priceE6: 1000, leg: 0 };
  const rows = aggregateHour("2026-09-28T12:00:00.000Z", [p, p, { ...p, priceE6: 2000 }]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.price_e6 === 1000)!.n, 2);
});

check("the weighted median and percentiles", () => {
  assert.equal(weightedMedian([{ price: 1, n: 1 }, { price: 5, n: 10 }]), 5);
  assert.equal(weightedMedian([{ price: 1, n: 3 }, { price: 5, n: 1 }]), 1);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4], 0.75), 3);
});

check("the wage is payer balanced: one bot firing thousands of calls counts once", () => {
  const rows = [
    { payer: "0xbot", payee: B, facilitator: "coinbase", price_e6: 1, n: 100_000 },
    ...Array.from({ length: WAGE_MIN_PAYERS }, (_, i) => ({ payer: `0xp${i}`, payee: B, facilitator: "coinbase", price_e6: 5000, n: 1 })),
  ];
  const s = dayStats(rows);
  assert.equal(s.gigs, 100_000 + WAGE_MIN_PAYERS);
  assert.equal(s.wage_e6, 5000, "the bot's 100,000 one-millionth calls do not set the wage");
  assert.equal(s.payers, WAGE_MIN_PAYERS + 1);
});

check("no wage under the minimum of distinct payers", () => {
  const s = dayStats([{ payer: A, payee: B, facilitator: "coinbase", price_e6: 1000, n: 500 }]);
  assert.equal(s.wage_e6, null);
  assert.equal(s.gigs, 500);
});

check("the estimate and its range, checked against the Sep 28 12:00 UTC hour read in full (4,044 payments)", () => {
  const e = estimateGigs({ signedTxs: 4662, sampledTxs: 304, x402Txs: 262, payments: 265 });
  assert.equal(e.gigs, 4064);
  assert.ok(e.low <= 4044 && 4044 <= e.high, `${e.low} to ${e.high}`);
  assert.deepEqual(estimateGigs({ signedTxs: 10, sampledTxs: 0, x402Txs: 0, payments: 0 }), { gigs: 0, low: 0, high: 0 });
});

check("the sample is fixed by the tx hash and the block hash, about 1 in 16", () => {
  const block = "0x" + "ab".repeat(32);
  const tx = "0x" + "cd".repeat(32);
  assert.equal(inSample(tx, block), inSample(tx, block));
  let hits = 0;
  for (let i = 0; i < 4000; i++) if (inSample(`0x${i.toString(16).padStart(64, "0")}`, block)) hits++;
  assert.ok(hits > 180 && hits < 320, `${hits} of 4000`);
});

check("a day is its 24 hours added up: the estimate over summed counts, the wage over every sampled payment", () => {
  const pay = (payer: string, priceE6: number): Payment => ({ payer, payee: B, facilitator: "coinbase", priceE6, leg: 0 });
  // 24 hours; hour 0 carries one busy wallet, hours 1 to 23 carry one call each from distinct wallets at $0.005.
  const hours = Array.from({ length: 24 }, (_, h) => ({
    signedTxs: 200,
    sampledTxs: 12,
    x402Txs: 10,
    payments: h === 0
      ? Array.from({ length: 10 }, () => pay("0xbusy", 1))
      : Array.from({ length: 10 }, (_, k) => pay(`0x${h}-${k}`, 5000)),
  }));
  const day = dayFromHours(hours);
  assert.deepEqual(day.totals, { signedTxs: 4800, sampledTxs: 288, x402Txs: 240, payments: 240 });
  assert.deepEqual(day.gigs, estimateGigs({ signedTxs: 4800, sampledTxs: 288, x402Txs: 240, payments: 240 }));
  assert.equal(day.stats.payers, 231);
  assert.equal(day.wage, 0.005, "the busy wallet counts once");
  assert.equal(day.stats.gigs, 240, "the sampled payments, not the estimate");
  // Splitting the same payments across hours differently gives the same wage: the median is over payers, not hours.
  const flat = hours.flatMap((h) => h.payments);
  const reshuffled = Array.from({ length: 24 }, (_, h) => ({ ...hours[h], payments: flat.filter((_, i) => i % 24 === h) }));
  assert.equal(dayFromHours(reshuffled).wage, day.wage);
  assert.throws(() => dayFromHours(hours.slice(1)), /day_incomplete:23/);
  // Below the minimum of distinct payers no wage prints.
  const thin = Array.from({ length: 24 }, () => ({ signedTxs: 1, sampledTxs: 1, x402Txs: 1, payments: [pay(A, 1000)] }));
  assert.equal(dayFromHours(thin).wage, null);
});

check("the facilitator list: 128 Base wallets, lower case, as the rulebook's counts line says", () => {
  const keys = Object.keys(BASE_FACILITATORS);
  assert.equal(keys.length, 128);
  assert.ok(keys.every((k) => /^0x[0-9a-f]{40}$/.test(k)), "lower-case addresses, so a receipt's sender matches after toLowerCase");
  assert.ok(Object.values(BASE_FACILITATORS).every((v) => /^[a-z0-9-]+$/.test(v)));
  assert.match(rulebookOf("GIGS")!.counts, /one of the 128 x402 facilitator wallets/);
  assert.match(rulebookOf("WAGE")!.counts, /No level prints on a day with fewer than 50 payers/);
  assert.equal(WAGE_MIN_PAYERS, 50);
});

async function checkAsync(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`ok ${name}`);
}

void (async () => {
  // Oct 3 2026 21:00 UTC: Base answered the busy half of the hour with HTTP 500, "backend response too large".
  await checkAsync("readHour halves a log range the node calls too large instead of retrying it forever", async () => {
    const T0 = 1_791_000_000; // block 0's time; one block every 2 seconds
    const ranges: [number, number][] = [];
    const post = async (_url: string, body: unknown) => {
      const { method, params } = body as { method: string; params: unknown[] };
      if (method === "eth_blockNumber") return { result: `0x${(4000).toString(16)}` };
      if (method === "eth_getBlockByNumber") return { result: { timestamp: `0x${(T0 + 2 * Number.parseInt(String(params[0]), 16)).toString(16)}` } };
      if (method === "eth_getLogs") {
        const f = params[0] as { fromBlock: string; toBlock: string };
        const a = Number.parseInt(f.fromBlock, 16), z = Number.parseInt(f.toBlock, 16);
        if (z - a + 1 > 300) throw new Error("rpc_http_500:backend response too large");
        ranges.push([a, z]);
        return { result: [] };
      }
      throw new Error(`unexpected ${method}`);
    };
    const r = await readHour((T0 + 200) * 1000, { post, rpcs: ["https://node.test"] });
    assert.equal(r.fromBlock, 100);
    assert.equal(r.toBlock, 1899);
    assert.ok(ranges.every(([a, z]) => z - a + 1 <= 300));
    const covered = ranges.reduce((s, [a, z]) => s + (z - a + 1), 0);
    assert.equal(covered, 1800, "every block of the hour read once");
    assert.equal(ranges[0][0], 100);
    assert.equal(ranges[ranges.length - 1][1], 1899);
  });
  console.log(`${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
