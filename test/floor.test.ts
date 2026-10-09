/**
 * The Floor (floor/latest.json) keeps its contract: it matches floor/schema.json, a number nothing measures carries no
 * value, sealed bets show no detail, the founder's seat is titled and never named, and no line carries an id, an
 * address, a money amount, a private path or an outside link. The private name list lives with the exporter, never
 * here; this check is the public half. Plain asserts, no network. Run: node --import tsx test/floor.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${name}`);
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Schema = { [k: string]: any };

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const doc = JSON.parse(read("floor/latest.json")) as { [k: string]: any };
const schema = JSON.parse(read("floor/schema.json")) as Schema;

/** The part of JSON Schema that schema.json uses: $ref, const, enum, type, required, properties,
 * additionalProperties false, items, anyOf, pattern, minimum and maximum. Returns every problem with its path. */
function validate(node: Json, s: Schema, path = "$", out: string[] = []): string[] {
  if (s.$ref) return validate(node, resolve(s.$ref), path, out);
  if (s.anyOf) {
    if (!s.anyOf.some((x: Schema) => validate(node, x, path, []).length === 0)) out.push(`${path}: matches none of anyOf`);
    return out;
  }
  if ("const" in s && node !== s.const) out.push(`${path}: must be ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(node)) out.push(`${path}: not one of ${JSON.stringify(s.enum)}`);
  if (s.type) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    const kind = node === null ? "null" : Array.isArray(node) ? "array" : typeof node;
    const ok = types.some((t) => t === kind || (t === "integer" && Number.isInteger(node)) || (t === "number" && kind === "number"));
    if (!ok) { out.push(`${path}: ${kind}, want ${types.join(" or ")}`); return out; }
  }
  if (typeof node === "string" && s.pattern && !new RegExp(s.pattern).test(node)) out.push(`${path}: does not match ${s.pattern}`);
  if (typeof node === "number") {
    if (s.minimum != null && node < s.minimum) out.push(`${path}: below ${s.minimum}`);
    if (s.maximum != null && node > s.maximum) out.push(`${path}: above ${s.maximum}`);
  }
  if (Array.isArray(node) && s.items) node.forEach((x, i) => validate(x, s.items, `${path}[${i}]`, out));
  if (node && typeof node === "object" && !Array.isArray(node)) {
    for (const k of s.required ?? []) if (!(k in node)) out.push(`${path}: missing ${k}`);
    for (const [k, v] of Object.entries(node)) {
      if (s.properties?.[k]) validate(v, s.properties[k], `${path}.${k}`, out);
      else if (s.additionalProperties === false) out.push(`${path}: unexpected ${k}`);
    }
  }
  return out;
}
function resolve(ref: string): Schema {
  return ref.replace(/^#\//, "").split("/").reduce((o: Schema, k) => o[k], schema);
}

function* strings(node: Json, path = "$"): Generator<[string, string]> {
  if (typeof node === "string") yield [path, node];
  else if (Array.isArray(node)) for (let i = 0; i < node.length; i++) yield* strings(node[i], `${path}[${i}]`);
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) yield* strings(v, `${path}.${k}`);
}

const ALLOWED_URL = /^https:\/\/(?:tickerz\.com(?:\/\S*)?|oracle\.tickerz\.com(?:\/\S*)?|x\.com\/tickerzhq\b\S*|github\.com\/tickerzhq\/tickerz-open\b\S*|raw\.githubusercontent\.com\/tickerzhq\/tickerz-open\/\S*)$/;
const vendor = ["Cla" + "ude", "Anth" + "ropic", "Open" + "AI", "GPT", "Codex", "Grok", "Gemini", "Cursor"];
const RULES: [string, RegExp][] = [
  ["house style (no em or en dash, no exclamation point)", /[—–!]/],
  ["routine id", /\btrig_[A-Za-z0-9]+/],
  ["project id", /\bprj_[A-Za-z0-9]+/],
  ["email address", /[\w.+-]+@[\w-]+\.[\w.-]+/],
  ["handle other than @tickerzhq", /(?<![\w/])@(?!tickerzhq\b)\w+/],
  ["money amount", /\$\s?\d|\b(?:USD|EUR|GBP)\s?\d/],
  ["private path", /\/Users\/|~\/|\b(?:Founder|Setup|Strategy|Memory|Brain|Research)\//],
  ["vendor name", new RegExp(`\\b(?:${vendor.join("|")})\\b`)],
  ["key shape", /\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[\w-]{10,}\.eyJ/],
];

check("floor/latest.json matches floor/schema.json", () => {
  assert.deepEqual(validate(doc as Json, schema), []);
});

check("the validator itself rejects a wrong file", () => {
  const bad = JSON.parse(JSON.stringify(doc));
  bad.schema = "tickerz-floor/0";
  bad.seats[0].status = "sacked";
  bad.extra = 1;
  const problems = validate(bad, schema);
  assert.ok(problems.some((p) => p.startsWith("$.schema")));
  assert.ok(problems.some((p) => p.startsWith("$.seats[0].status")));
  assert.ok(problems.some((p) => p.includes("unexpected extra")));
});

check("a number nothing measures has no value", () => {
  const walk = (n: Json, path: string) => {
    if (Array.isArray(n)) n.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (n && typeof n === "object") {
      if (n.measured === false && "value" in n) assert.equal(n.value, null, path);
      for (const [k, v] of Object.entries(n)) walk(v, `${path}.${k}`);
    }
  };
  walk(doc as Json, "$");
  for (const s of doc.seats) if (!s.ticker.measured) assert.deepEqual([s.ticker.value, s.ticker.rank, s.ticker.series.length], [null, null, 0], s.id);
});

check("the founder holds a seat, titled Founder", () => {
  const f = doc.seats.filter((s: any) => s.kind === "founder");
  assert.equal(f.length, 1);
  assert.equal(f[0].name, "Founder");
  assert.equal(f[0].symbol, "FOUNDER");
});

check("seat ids are unique and every reference points at a seat or a lesson", () => {
  const ids = doc.seats.map((s: any) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  const lessons = new Set(doc.lessons.map((l: any) => l.id));
  for (const s of doc.seats) {
    if (s.opposite != null) assert.ok(ids.includes(s.opposite), `${s.id} opposite`);
    if (s.lesson != null) assert.ok(lessons.has(s.lesson), `${s.id} lesson`);
  }
  for (const b of doc.bell) assert.ok(ids.includes(b.seat), b.id);
});

check("a sealed bet shows its lane, number and status, never its detail", () => {
  for (const i of doc.ideas.filter((x: any) => x.sealed)) {
    assert.equal(i.result, null, i.id);
    assert.equal(i.check_on, null, i.id);
  }
});

check("the bell is newest first and every bell links to its proof", () => {
  const at = doc.bell.map((b: any) => b.at);
  assert.deepEqual(at, [...at].sort().reverse());
  for (const b of doc.bell) assert.ok(b.links.length > 0, b.id);
});

check("no line carries an id, an address, money, a private path, an outside link or a vendor's name", () => {
  const problems: string[] = [];
  for (const [path, s] of strings(doc as Json)) {
    for (const [rule, rx] of RULES) if (rx.test(s)) problems.push(`${path}: ${rule}`);
    for (const u of s.match(/https?:\/\/[^\s"'<>)]+/g) ?? []) if (!ALLOWED_URL.test(u.replace(/[.,;]+$/, ""))) problems.push(`${path}: outside link`);
  }
  assert.deepEqual(problems, []);
});

check("the rulebook names no scoring limit", () => {
  const rules = read("floor/RULES.md");
  assert.ok(!/[—–!]/.test(rules.replace(/\[[^\]]*\]\([^)]*\)/g, "")), "house style");
  assert.ok(!/\b\d+\s+(?:strikes?|misses|runs)\b/i.test(rules), "no counts that trigger firing or promotion");
  assert.ok(rules.includes("starts at **100**"));
});

console.log(`\n${passed} passed`);
