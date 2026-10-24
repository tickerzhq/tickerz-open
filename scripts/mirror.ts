/**
 * Mirror what Tickerz printed into this repo, so the record does not depend on Tickerz's own servers.
 *
 * For each index below it downloads the public settlement file (one row per complete period: the first print, the value
 * a contract settles on, any later revision, and the Bitcoin proof day) and writes it to prints/<TICKER>.csv. It also
 * saves each daily proof to daily-proofs/<day>.json, and fills in the Bitcoin block once when it confirms. Git history
 * then shows every change anyone ever made.
 *
 * It refuses to write when the new file would break the record:
 *   - a first print that is already in this repo has a different value (the first print is settlement_value; a
 *     revision, marked revised = true, may change value beside it, and git history shows the change), or
 *   - a period that is already in this repo is missing from inside the new file's range, or
 *   - a daily proof's digest differs from the one saved here.
 * Either one fails the run, and the difference is printed. The settlement file holds about the last 100 periods, so a
 * period older than its first one has aged out of the file, not out of the record: this repo keeps it.
 *
 * Run: node scripts/mirror.ts (Node 24 or later runs TypeScript as is; no install, no dependencies). The downloaded
 * text is written as it came, and the lines kept from this repo are the repo's own lines, never rewritten.
 * test/mirror.test.ts pins the rules.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://tickerz.com";
// Indexes counted from sources whose terms allow republishing the count.
const TICKERS = ["LAYOFFS", "MINTS", "GIGS", "WAGE"];
const UA = { "User-Agent": "tickerz-agent/mirror" };
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HEADER = ["ticker", "period", "value", "settlement_value", "revised", "revised_on", "band", "z", "proof_day", "bitcoin_height", "proof_url"];

type Row = string[];
type Json = Record<string, unknown>;

/** Stop the run with a message and exit 1, as Python's SystemExit(message) does. */
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function get(urlPath: string): Promise<string> {
  const res = await fetch(BASE + urlPath, { headers: UA, signal: AbortSignal.timeout(60_000) });
  if (res.status !== 200) fail(`${urlPath}: HTTP ${res.status}`);
  return new TextDecoder("utf-8", { fatal: true }).decode(await res.arrayBuffer());
}

/** CSV rows as Python's csv.reader reads them: quoted fields with "" for a quote, a blank line as an empty row. */
export function parseCsv(text: string): Row[] {
  const rows: Row[] = [];
  let row: Row = [], field = "", quoted = false, started = false, i = 0;
  const endRow = () => {
    if (started || row.length) { row.push(field); rows.push(row); } else rows.push([]);
    row = []; field = ""; started = false;
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field === "") { quoted = true; started = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; started = true; i++; continue; }
    if (c === "\r" || c === "\n") { endRow(); i += c === "\r" && text[i + 1] === "\n" ? 2 : 1; continue; }
    field += c; started = true; i++;
  }
  if (started || row.length || field) endRow();
  return rows;
}

/** Python's str.splitlines(keepends=True): every line keeps its own ending, \r\n counts as one. */
const BREAK = "\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029";
const LINE = new RegExp(`[^${BREAK}]*(?:\\r\\n|[${BREAK}]|$)`, "g");
export function splitLines(text: string): string[] {
  return (text.match(LINE) ?? []).filter((s) => s !== "");
}

/** A field Python would index, or the run stops (Python raises IndexError there). */
function at(row: Row, i: number): string {
  if (i >= row.length) fail(`a row has no field ${i}: ${row.join(",")}`);
  return row[i];
}

const repr = (row: Row | undefined) => (row ? `[${row.map((s) => `'${s}'`).join(", ")}]` : "None");

function rowsOf(text: string): Row[] {
  const r = parseCsv(text);
  if (!r.length || r[0].join("\u0000") !== HEADER.join("\u0000") || r[0].length !== HEADER.length) fail(`unexpected header: ${repr(r[0])}`);
  return r.slice(1);
}

const minOf = (values: string[]) => values.reduce((a, b) => (b < a ? b : a));

const VALUE = 2, SETTLEMENT = 3, REVISED = 4;

/**
 * The record only grows: no period inside the new file's range disappears and no first print changes. A period with a
 * first print (settlement_value) keeps it; its value may change only as a revision (revised = true). A period with no
 * first print yet keeps its value.
 */
export function check(ticker: string, oldRows: Row[], newRows: Row[]): string[] {
  const fresh = new Map<string, Row>();
  for (const row of newRows) fresh.set(at(row, 1), row);
  const oldest = minOf([...fresh.keys()]);
  const problems: string[] = [];
  for (const row of oldRows) {
    const period = at(row, 1);
    if (period < oldest) continue; // aged out of the settlement file's window; kept here by agedOut()
    const now = fresh.get(period);
    const first = at(row, SETTLEMENT);
    if (!now) problems.push(`${ticker} ${period}: in this repo, missing from the new file`);
    else if (first && at(now, SETTLEMENT) !== first) problems.push(`${ticker} ${period}: first print was ${first}, the new file says ${at(now, SETTLEMENT)}`);
    else if (first && at(now, VALUE) !== at(row, VALUE) && at(now, REVISED) !== "true") problems.push(`${ticker} ${period}: value was ${at(row, VALUE)}, the new file says ${at(now, VALUE)} with no revision`);
    else if (!first && at(now, VALUE) !== at(row, VALUE)) problems.push(`${ticker} ${period}: first print was ${at(row, VALUE)}, the new file says ${at(now, VALUE)}`);
  }
  return problems;
}

/** The new file with this repo's periods older than its first one kept on top, so the mirror never loses a period. */
export function agedOut(oldText: string, newText: string): string {
  const newLines = splitLines(newText);
  const oldest = minOf(rowsOf(newText).map((row) => at(row, 1)));
  const kept = splitLines(oldText).slice(1).filter((line) => at(parseCsv(line)[0] ?? [], 1) < oldest);
  return [...newLines.slice(0, 1), ...kept, ...newLines.slice(1)].join("");
}

/** Python's truth test for a JSON value. */
const truthy = (v: unknown) =>
  v === null || v === undefined ? false
  : typeof v === "object" ? Object.keys(v).length > 0
  : typeof v === "string" ? v.length > 0
  : Boolean(v);
const field = (o: unknown, k: string) => (o && typeof o === "object" && !Array.isArray(o) ? (o as Json)[k] ?? null : null);
const str = (v: unknown) => (v === null ? "None" : typeof v === "string" ? v : JSON.stringify(v));

/** A text file read the way Python's open().read() does: \r\n and \r become \n. */
const readText = (file: string) => readFileSync(file, "utf8").replace(/\r\n?/g, "\n");

async function main() {
  const problems: string[] = [], changed: [string, string, string][] = [], proofDays = new Set<string>();
  for (const folder of ["prints", "daily-proofs"]) mkdirSync(path.join(ROOT, folder), { recursive: true });
  for (const ticker of TICKERS) {
    let text = await get(`/api/indices/${ticker.toLowerCase()}/history.csv`);
    const newRows = rowsOf(text);
    if (!newRows.length) fail(`${ticker}: the settlement file is empty`);
    const file = path.join(ROOT, "prints", `${ticker}.csv`);
    const oldText = existsSync(file) ? readText(file) : "";
    const oldRows = oldText ? rowsOf(oldText) : [];
    problems.push(...check(ticker, oldRows, newRows));
    if (oldText) text = agedOut(oldText, text);
    for (const row of newRows.slice(-14)) if (at(row, 8)) proofDays.add(at(row, 8));
    if (text !== oldText) changed.push([file, text, `${ticker}: ${oldRows.length} to ${rowsOf(text).length} periods`]);
  }
  if (problems.length) {
    console.log("The record changed. Nothing was written.\n" + problems.join("\n"));
    process.exit(1);
  }
  for (const [file, text, note] of changed) {
    writeFileSync(file, text);
    console.log(note);
  }
  for (const day of [...proofDays].sort()) {
    const file = path.join(ROOT, "daily-proofs", `${day}.json`);
    const have: unknown = existsSync(file) ? JSON.parse(readText(file)) : null;
    if (truthy(have) && truthy(field(have, "bitcoin_height"))) continue; // complete: a proof with its Bitcoin block is never rewritten
    const body = await get(`/api/indices/proof?day=${day}`);
    const fresh: unknown = JSON.parse(body);
    if (truthy(have) && field(fresh, "digest_sha256") !== field(have, "digest_sha256")) {
      console.log(`The record changed. proof ${day}: digest was ${str(field(have, "digest_sha256"))}, now ${str(field(fresh, "digest_sha256"))}`);
      process.exit(1);
    }
    if (truthy(have) && !truthy(field(fresh, "bitcoin_height"))) continue; // still waiting for its Bitcoin block
    writeFileSync(file, body.endsWith("\n") ? body : body + "\n");
    console.log(`proof ${day}` + (truthy(field(fresh, "bitcoin_height")) ? "" : " (Bitcoin block pending)"));
  }
  if (!changed.length) console.log("no new prints");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
