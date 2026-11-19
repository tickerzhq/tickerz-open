/**
 * Build the open Tickerz dataset for Hugging Face: one CSV per index whose source's terms allow republishing, plus a
 * dataset card. .github/workflows/hf-dataset.yml runs it once a day and uploads the folder to the dataset repo.
 *
 * Which indexes: every index tickerz.com lists at /api/indices whose rule (/api/indices/{t}/rule) says rights "clean".
 * "blocked" ($YESNO, $TRENCHES: DefiLlama and Kalshi terms) and "consent_needed" ($GOON, $AIGF, $TILT, $MINTS and the
 * others waiting on their source's word) stay out. The rule is read on every run, so an index joins the day its rights
 * turn clean and leaves the day they stop being clean.
 *
 * Each file is the public settlement file (/api/indices/{t}/history.csv) with the columns made the same for every
 * index and one column added, as_first_published:
 *   - The BLS indexes ($JOBS, $UNEMP, $CPI, $CORECPI) mark their own back history in a note column ("Loaded later");
 *     a row is as first published when it has a settlement_value and no note.
 *   - Every other index was loaded with its history on the day it started. A row whose period had already ended
 *     before the index's first record day was read on that day, after the source may have revised it, so it is not a
 *     first print. Only periods that end on or after the first record day were read when they came out.
 *
 * Run: node scripts/hf-dataset.ts [out-dir]   (Node 24 runs TypeScript as is; no install, no dependencies.)
 * test/hfDataset.test.ts pins the rules.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://tickerz.com";
// Our own reads are not outside usage (tickerz TICKERZ.md section 7, "Own traffic").
const HEADERS = { "User-Agent": "tickerz-agent/dataset (+https://tickerz.com)", "x-tickerz-agent": "dataset" };

export const COLUMNS = [
  "ticker", "period", "value", "settlement_value", "revised", "revised_on",
  "as_first_published", "band", "z", "proof_day", "bitcoin_height", "proof_url", "note",
] as const;

export type Cadence = "day" | "week" | "month";
export type Rights = { status: string; url: string; clause: string; checked?: string };
export type IndexInfo = {
  ticker: string;
  name: string;
  family: string;
  counts: string;
  unit: string;
  cadence: Cadence;
  source: { name: string; url: string; terms?: string };
  rights: Rights;
  grade: string;
  harm: boolean;
};
type Json = Record<string, unknown>;

/** CSV rows: quoted fields with "" for a quote. Same reading as scripts/mirror.ts, kept here so Node runs this file as is. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field === "") { quoted = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r" || c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function get(urlPath: string): Promise<string> {
  const res = await fetch(BASE + urlPath, { headers: HEADERS, signal: AbortSignal.timeout(60_000) });
  if (res.status !== 200) throw new Error(`${urlPath}: HTTP ${res.status}`);
  return new TextDecoder("utf-8", { fatal: true }).decode(await res.arrayBuffer());
}

/** Only sources whose terms allow republishing the count go into the open dataset. */
export const isOpen = (rights: Rights | undefined) => rights?.status === "clean";

/** The last day a period covers, YYYY-MM-DD. A week is labelled by the day it ends, so it ends on its own label. */
export function periodEnd(period: string, cadence: Cadence): string {
  if (cadence !== "month") return period;
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** The first day Tickerz recorded this index: the earliest proof day in its file. */
export function firstRecordDay(rows: Record<string, string>[]): string | null {
  const days = rows.map((r) => r.proof_day ?? "").filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return days[0] ?? null;
}

/** Whether a row holds the number as its source first published it (see the header of this file). */
export function asFirstPublished(row: Record<string, string>, cadence: Cadence, firstDay: string | null, hasNote: boolean): boolean {
  if (!row.settlement_value) return false;
  if (hasNote) return !row.note;
  if (!firstDay) return false;
  return periodEnd(row.period, cadence) >= firstDay;
}

const csvField = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The settlement file in the dataset's columns, oldest period first. Returns the CSV and its row counts. */
export function toDatasetCsv(text: string, cadence: Cadence): { csv: string; rows: number; firstPublished: number; firstDay: string | null } {
  const parsed = parseCsv(text).filter((r) => r.length > 1);
  if (!parsed.length) throw new Error("empty file");
  const head = parsed[0];
  for (const need of ["ticker", "period", "value", "settlement_value", "proof_day"]) {
    if (!head.includes(need)) throw new Error(`unexpected header: ${head.join(",")}`);
  }
  const hasNote = head.includes("note");
  const rows: Record<string, string>[] = parsed.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
  rows.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
  const firstDay = firstRecordDay(rows);
  let firstPublished = 0;
  const lines = [COLUMNS.join(",")];
  for (const row of rows) {
    const fp = asFirstPublished(row, cadence, firstDay, hasNote);
    if (fp) firstPublished++;
    const out: Record<string, string> = { ...row, as_first_published: fp ? "true" : "false" };
    lines.push(COLUMNS.map((c) => csvField(out[c] ?? "")).join(","));
  }
  return { csv: lines.join("\n") + "\n", rows: rows.length, firstPublished, firstDay };
}

const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

export type CardRow = IndexInfo & { rows: number; firstPublished: number; firstDay: string | null; from: string; to: string };

/** The dataset card (README.md): Hugging Face front matter, the columns, the licence per source and the caveat. */
export function card(indexes: CardRow[], builtOn: string): string {
  const configs = [
    "- config_name: all\n  data_files: data/*.csv\n  default: true",
    ...indexes.map((i) => `- config_name: ${i.ticker.toLowerCase()}\n  data_files: data/${i.ticker}.csv`),
  ].join("\n");
  const table = indexes
    .map((i) => `| [$${i.ticker}](https://tickerz.com/x/${i.ticker.toLowerCase()}) | ${md(i.counts)} | ${i.cadence} | ${md(i.unit)} | [${md(i.source.name)}](${i.source.url}) | [${md(i.rights.clause)}](${i.rights.url}) | ${i.from} to ${i.to} | ${i.rows} | ${i.firstPublished} | ${i.firstDay ?? ""} |`)
    .join("\n");
  const harm = indexes.filter((i) => i.harm).map((i) => `$${i.ticker}`);
  return `---
license: other
license_name: per-source
license_link: https://tickerz.com/methodology
pretty_name: Tickerz Index
language: [en]
tags: [time-series, tabular, economics, public-data, open-data, indexes, point-in-time]
size_categories: [1K<n<10K]
configs:
${configs}
---

# Tickerz Index

Tickerz turns data into numbers that markets can be built on. Everything gets a ticker.

This dataset holds the published history of every Tickerz index whose source allows the count to be republished: ${indexes.length} indexes, one CSV each in \`data/\`. It is rebuilt every day from the public settlement files at \`https://tickerz.com/api/indices/{ticker}/history.csv\` by [tickerzhq/tickerz-open](https://github.com/tickerzhq/tickerz-open/blob/main/scripts/hf-dataset.ts). Built ${builtOn}.

Indexes whose sources need consent or forbid republishing are left out, whatever they show on tickerz.com. Each index's rule, with its source and the terms clause, is at \`https://tickerz.com/api/indices/{ticker}/rule\`.

## Columns

| Column | Meaning |
|---|---|
| ticker | The index, without the $. |
| period | The period the number is for: a day, the day a week ends, or the first day of a month. |
| value | The number as Tickerz holds it today. After a revision by the source, this is the revised number. |
| settlement_value | The number as Tickerz first recorded it. It never changes. Empty when Tickerz has no record of the first number. |
| revised | true when the source later changed the number. |
| revised_on | The day Tickerz saw the revision. |
| as_first_published | true only when settlement_value is the number as the source first published it. Read the caveat below. |
| band | How unusual the number is against the index's own normal: Quiet, Normal, Elevated, High or Extreme. |
| z | The robust z-score behind the band. |
| proof_day | The day the row was stamped into a daily proof. |
| bitcoin_height | The Bitcoin block holding that day's OpenTimestamps proof, once it confirmed. |
| proof_url | The daily proof. |
| note | Set when the source file marks a row, e.g. "Loaded later" for BLS months read after their release. |

## The point-in-time caveat

Most of these indexes started on Tickerz in November 2026 and were loaded with their history on their first day. A row whose period ended before the index's first record day was read on that day, after the source may already have revised it. Its settlement_value is the number as it stood then, not as the source first published it, and \`as_first_published\` is false. Only rows for periods that ended on or after the first record day (the last column of the table below) are true first prints. The BLS indexes mark their back history themselves in \`note\`.

If you backtest on this data, use \`as_first_published = true\` rows for anything that depends on what was known at the time.

## The indexes, sources and licences

The licence column quotes the source's own terms, word for word, as Tickerz read them. Cite the source as its terms ask (the BLS asks to be cited as the Bureau of Labor Statistics). Tickerz's own work on top (the rules, bands and scores) is MIT, as in tickerz-open.

| Index | What it counts | Cadence | Unit | Source | Terms | Periods | Rows | As first published | First record day |
|---|---|---|---|---|---|---|---|---|---|
${table}

Aggregates only: no row names or identifies a person.${harm.length ? ` ${harm.join(", ")} count${harm.length === 1 ? "s" : ""} deaths or harm: shown for reading, never for bets.` : ""}

Questions: desk@tickerz.com.
`;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function info(ticker: string, listed: Json): Promise<IndexInfo | null> {
  const rule = JSON.parse(await get(`/api/indices/${ticker.toLowerCase()}/rule`)) as Json;
  const cur = (rule.current ?? {}) as Json;
  const rights = cur.rights as Rights | undefined;
  if (!isOpen(rights)) return null;
  const cadence = String(cur.cadence ?? listed.cadence) as Cadence;
  if (!["day", "week", "month"].includes(cadence)) throw new Error(`${ticker}: cadence ${cadence}`);
  const source = (cur.source ?? listed.source ?? {}) as IndexInfo["source"];
  return {
    ticker,
    name: String(listed.name ?? ticker),
    family: String(listed.family ?? ""),
    counts: String(cur.counts ?? listed.counts ?? ""),
    unit: String(cur.unit ?? ""),
    cadence,
    source,
    rights: rights as Rights,
    grade: String(cur.grade ?? ""),
    // A harm index is "See only" in its settlement note: published, never called or bet on.
    harm: /see only/i.test(String((listed.settlement as Json | undefined)?.why ?? "")),
  };
}

async function main() {
  const out = path.resolve(process.argv[2] ?? "hf-out");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(path.join(out, "data"), { recursive: true });
  const list = JSON.parse(await get("/api/indices")) as { indices: Json[] };
  const rows: CardRow[] = [];
  const skipped: string[] = [];
  const manifest: Record<string, string> = {};
  for (const listed of list.indices) {
    const ticker = String(listed.ticker);
    const meta = await info(ticker, listed);
    if (!meta) { skipped.push(ticker); continue; }
    const built = toDatasetCsv(await get(`/api/indices/${ticker.toLowerCase()}/history.csv`), meta.cadence);
    if (!built.rows) { skipped.push(`${ticker} (no rows)`); continue; }
    writeFileSync(path.join(out, "data", `${ticker}.csv`), built.csv);
    manifest[`data/${ticker}.csv`] = sha(built.csv);
    const periods = parseCsv(built.csv).slice(1).filter((r) => r.length > 1).map((r) => r[1]);
    rows.push({ ...meta, ...built, from: periods[0], to: periods[periods.length - 1] });
    console.log(`${ticker} ${built.rows} rows, ${built.firstPublished} as first published (first record ${built.firstDay ?? "none"})`);
  }
  if (!rows.length) throw new Error("no index with clean rights; nothing to publish");
  rows.sort((a, b) => a.ticker.localeCompare(b.ticker));
  const readme = card(rows, new Date().toISOString().slice(0, 10));
  writeFileSync(path.join(out, "README.md"), readme);
  // The day stamp in the card changes daily; the manifest hashes the data and the card without it, so an unchanged
  // record is not uploaded again.
  manifest["README.md"] = sha(readme.replace(/Built \d{4}-\d{2}-\d{2}\./, "Built."));
  const digest = sha(JSON.stringify(manifest, Object.keys(manifest).sort()));
  writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ digest, files: manifest }, null, 2) + "\n");
  console.log(`\n${rows.length} indexes written to ${out}; left out (rights not clean): ${skipped.join(", ") || "none"}`);
  console.log(`digest ${digest}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
