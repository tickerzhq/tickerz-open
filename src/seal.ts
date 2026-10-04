/**
 * The daily seal: how each day's readings are fixed in Bitcoin, and how anyone can check one.
 *
 * Once per UTC day (after 12:00 UTC) Tickerz writes one seal: every index row written or revised since the seal before
 * (all rows for the first seal), as compact JSON with a fixed key order. The JSON is hashed with SHA-256 and the digest
 * is stamped with OpenTimestamps, which commits it to a Bitcoin block, usually within a few hours. The text is served
 * exactly as hashed, so the digest reproduces byte for byte:
 *
 *   GET https://tickerz.com/api/v1/indices/proof?day=YYYY-MM-DD             canonical_json, digest_sha256, the proof
 *   GET https://tickerz.com/api/v1/indices/proof?day=YYYY-MM-DD&format=ots  the .ots file itself
 *
 * A seal written on day D holds the complete periods that landed since the seal before, usually period D-1. The first
 * seal to hold a ticker and period is its first print, the number a venue settles on; a later revision is sealed again
 * and sits beside it, never in its place.
 *
 * canonicalSealJson, firstPrintsFromSeals, firstPrintFromSeals, revisedFrom, isCalendarDay and isOts are copied from
 * Tickerz's production code unchanged. checkSeal, otsDigestHex and fetchSeal are written for this repo.
 */
import { createHash } from "node:crypto";
import { USER_AGENT } from "./mints";

// ---------------------------------------------------------------------------------------------------------------
// The seal text and first prints (production rules, unchanged)
// ---------------------------------------------------------------------------------------------------------------

/** A row with its level, as the write set reads it. */
export type SealValueRow = { ticker: string; period: string; value: number; revisions: number };

/**
 * A row of a source whose terms keep its levels out of the API: the seal is served in full at /api/indices/proof, so
 * it holds a salted SHA-256 of the level instead of the level. No index uses it now; the format allows it.
 */
export type SealHashRow = { ticker: string; period: string; value_sha256: string; revisions: number };

export type SealRow = SealValueRow | SealHashRow;

/**
 * Key order: kind, day, since, rows[] (ticker, period, value, revisions), sorted by ticker then period. A withheld
 * source's row carries value_sha256 in the value's place (ticker, period, value_sha256, revisions). Every other row
 * serializes exactly as it always has, so the text of every seal already written reproduces.
 */
export function canonicalSealJson(day: string, since: string | null, rows: SealRow[]): string {
  const sorted = [...rows]
    .map((r) =>
      "value_sha256" in r
        ? { ticker: r.ticker.toUpperCase(), period: r.period, value_sha256: String(r.value_sha256), revisions: Number(r.revisions) || 0 }
        : { ticker: r.ticker.toUpperCase(), period: r.period, value: Number(r.value), revisions: Number(r.revisions) || 0 },
    )
    .sort((a, b) => (a.ticker !== b.ticker ? (a.ticker < b.ticker ? -1 : 1) : a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
  return JSON.stringify({ kind: "index_seal", day, since, rows: sorted });
}

/** A seal as served by the proof endpoint, as much of it as the first print reads. */
export type SealRecord = { day: string; digest_sha256: string; bitcoin_height: number | null; canonical_json: string };

/**
 * The first print of a period: the value the earliest seal holding it recorded, with that seal. Final for settlement;
 * later seals may carry a revision beside it, never in its place.
 */
export type FirstPrint = { ticker: string; period: string; value: number; sealed_day: string; digest_sha256: string; bitcoin_height: number | null };

/**
 * Every first print in `seals`, keyed "TICKER:period". Seals are read in day order whatever order they come in; the
 * first seal to hold a ticker and period wins. A seal whose text cannot be read is skipped.
 */
export function firstPrintsFromSeals(seals: readonly SealRecord[]): Map<string, FirstPrint> {
  const out = new Map<string, FirstPrint>();
  const ordered = [...seals].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  for (const seal of ordered) {
    let rows: unknown;
    try {
      rows = (JSON.parse(seal.canonical_json) as { rows?: unknown }).rows;
    } catch {
      continue;
    }
    if (!Array.isArray(rows)) continue;
    for (const r of rows as { ticker?: unknown; period?: unknown; value?: unknown }[]) {
      const ticker = String(r?.ticker ?? "").toUpperCase();
      const period = String(r?.period ?? "").slice(0, 10);
      const value = Number(r?.value);
      if (!ticker || !/^\d{4}-\d{2}-\d{2}$/.test(period) || r?.value == null || !Number.isFinite(value)) continue;
      const key = `${ticker}:${period}`;
      if (out.has(key)) continue;
      out.set(key, { ticker, period, value, sealed_day: String(seal.day).slice(0, 10), digest_sha256: seal.digest_sha256, bitcoin_height: seal.bitcoin_height });
    }
  }
  return out;
}

/** The first print of one ticker and period in `seals`, or null when no seal holds it yet. */
export function firstPrintFromSeals(seals: readonly SealRecord[], ticker: string, period: string): FirstPrint | null {
  return firstPrintsFromSeals(seals).get(`${ticker.toUpperCase()}:${period}`) ?? null;
}

/** Whether a level differs from its first print: the two are compared to a billionth, the way the merge compares. */
export function revisedFrom(first: number, current: number | null | undefined): boolean {
  return current != null && Number.isFinite(current) && Math.abs(current - first) >= 1e-9 * Math.max(1, Math.abs(first));
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day as YYYY-MM-DD: the pattern, and a date that reads back the same, so 2026-02-31 is refused. */
export function isCalendarDay(s: string | null | undefined): s is string {
  if (!s || !DAY_RE.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}

// ---------------------------------------------------------------------------------------------------------------
// The .ots file
// ---------------------------------------------------------------------------------------------------------------

/** "\x00OpenTimestamps\x00\x00Proof\x00" plus the 8 magic bytes. */
const OTS_MAGIC = Buffer.from("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294", "hex");

export function isOts(bytes: Uint8Array): boolean {
  return bytes.length > OTS_MAGIC.length && Buffer.from(bytes.subarray(0, OTS_MAGIC.length)).equals(OTS_MAGIC);
}

/** The OpenTimestamps file hash op for SHA-256. */
const OP_SHA256 = 0x08;

/**
 * The digest a detached .ots file commits to: after the magic come the format version (1) and the file hash op
 * (0x08, SHA-256), then the 32 bytes of the digest. Null when the file is not a version 1 SHA-256 proof. This reads
 * the header only; the path from the digest to a Bitcoin block is what `ots verify` checks.
 */
export function otsDigestHex(bytes: Uint8Array): string | null {
  if (!isOts(bytes)) return null;
  const at = OTS_MAGIC.length;
  if (bytes.length < at + 2 + 32 || bytes[at] !== 0x01 || bytes[at + 1] !== OP_SHA256) return null;
  return Buffer.from(bytes.subarray(at + 2, at + 2 + 32)).toString("hex");
}

// ---------------------------------------------------------------------------------------------------------------
// Checking a seal
// ---------------------------------------------------------------------------------------------------------------

/** The proof endpoint's JSON, as much of it as the checks read. */
export type SealProof = {
  day: string;
  digest_sha256: string;
  canonical_json: string;
  stamped_at?: string;
  bitcoin_height?: number | null;
  bitcoin_block_time?: string | null;
  ots_proof_base64?: string;
};

export type SealCheck = { name: string; ok: boolean; detail: string };

export const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Every check that needs no Bitcoin node, in order. All must pass:
 *  1. sha256(canonical_json) equals digest_sha256.
 *  2. canonical_json is a seal for the day asked: kind index_seal, the same day.
 *  3. Rebuilt with canonicalSealJson from its own parsed rows, canonical_json comes out byte for byte the same, so the
 *     text follows the published key order and sort and nothing rides along outside the rows.
 *  4. The .ots file is an OpenTimestamps proof that commits to the same digest.
 *  5. When the JSON carries the proof too (ots_proof_base64), it is the same file.
 */
export function checkSeal(proof: SealProof, ots: Uint8Array, day: string = proof.day): SealCheck[] {
  const out: SealCheck[] = [];
  const digest = sha256Hex(proof.canonical_json);
  out.push({ name: "digest", ok: digest === proof.digest_sha256, detail: `sha256(canonical_json) = ${digest}` });
  type Parsed = { kind?: unknown; day?: unknown; since?: unknown; rows?: unknown };
  let parsed: Parsed | null;
  try {
    parsed = JSON.parse(proof.canonical_json) as Parsed;
  } catch {
    parsed = null;
  }
  out.push({
    name: "day",
    ok: parsed?.kind === "index_seal" && parsed?.day === day && proof.day === day,
    detail: `kind ${String(parsed?.kind)}, day ${String(parsed?.day)}`,
  });
  let rebuilt = "";
  if (parsed && Array.isArray(parsed.rows) && (parsed.since === null || typeof parsed.since === "string")) {
    rebuilt = canonicalSealJson(String(parsed.day), parsed.since as string | null, parsed.rows as SealRow[]);
  }
  out.push({
    name: "canonical",
    ok: rebuilt === proof.canonical_json,
    detail: `${Array.isArray(parsed?.rows) ? parsed.rows.length : 0} rows rebuilt with the published key order`,
  });
  const otsDigest = otsDigestHex(ots);
  out.push({ name: "ots", ok: otsDigest === proof.digest_sha256, detail: otsDigest ? `.ots commits to ${otsDigest}` : "not an OpenTimestamps SHA-256 proof" });
  if (proof.ots_proof_base64 != null) {
    const same = Buffer.from(proof.ots_proof_base64, "base64").equals(Buffer.from(ots));
    out.push({ name: "ots_same", ok: same, detail: same ? "the JSON's proof and the .ots file are the same bytes" : "the JSON's proof differs from the .ots file" });
  }
  return out;
}

/** The rows of one ticker in a seal, oldest period first. */
export function sealRowsOf(canonicalJson: string, ticker: string): SealRow[] {
  const rows = (JSON.parse(canonicalJson) as { rows?: SealRow[] }).rows ?? [];
  return rows.filter((r) => r.ticker === ticker.toUpperCase());
}

// ---------------------------------------------------------------------------------------------------------------
// Fetching a seal from the public API (no key)
// ---------------------------------------------------------------------------------------------------------------

export const PROOF_BASE = "https://tickerz.com/api/v1/indices/proof";

/** The seal written on `day`: its JSON and its .ots file. Throws on any status but 200. */
export async function fetchSeal(day: string, base = PROOF_BASE): Promise<{ proof: SealProof; ots: Uint8Array }> {
  if (!isCalendarDay(day)) throw new Error("bad_day: use YYYY-MM-DD");
  const get = async (url: string) => {
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`proof_http_${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
  };
  const proof = (await (await get(`${base}?day=${day}`)).json()) as SealProof;
  const ots = new Uint8Array(await (await get(`${base}?day=${day}&format=ots`)).arrayBuffer());
  return { proof, ots };
}
