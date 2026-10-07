/**
 * The signed report: one canonical JSON document per print, signed by the Tickerz publisher. It is what the Solana
 * feed's report_hash points at, what /api/indices/{ticker}/report serves, and what the independent recount co-signs.
 *
 * Signature (Ed25519, the publisher's Solana key, HCTmBYfjrJyenusT99huGVMVDcvhKznyb2ha18gqjVjE):
 *   message   = "tickerz-report-v1:" (18 ASCII bytes) followed by the 32 bytes of sha256(canonical JSON of the report)
 *   signature = Ed25519(message), base58 in the envelope
 * A co-signature uses "tickerz-cosign-v1:" in place of the prefix. The prefixes keep a report signature apart from a
 * Solana transaction signature by the same key: a transaction message never starts with these bytes.
 *
 * Ed25519 is what Solana verifies natively (the Ed25519 program), so the relay design (anyone carries a signed report
 * on chain) can follow without a new key. EVM contracts verify secp256k1; an EIP-712 signature (evm.ts) is added to
 * the envelope once a secp256k1 key sits in a managed key service (a founder ask: it costs money).
 */
import { createPublicKey, verify as edVerify } from "node:crypto";
import { base58Decode, base58Encode, keypairFromSecret, signBytes } from "../solanaTx";
import { canonicalJson, sha256Bytes } from "./canonical";
import type { Cadence, PrintStatus } from "./solanaFeed";

export const REPORT_PREFIX = "tickerz-report-v1:";
export const COSIGN_PREFIX = "tickerz-cosign-v1:";
export const SOLANA_PUBLISHER = "HCTmBYfjrJyenusT99huGVMVDcvhKznyb2ha18gqjVjE";

export type SourceRead = {
  /** Who served the read: "alchemy", "solana-public", "helius", "bls-api", "fred". Never a URL (it can hold a key). */
  provider: string;
  /** The value this provider's read gave, scaled like the report's value. */
  value: string;
  /** sha256 of the raw response bytes as stored in source_snapshots. */
  snapshot_sha256: string;
  fetched_at: string;
};

export type Report = {
  schema: "tickerz-report/1";
  /** "index" for a Tickerz index, "launch" for a ticker launched through Ticker it. */
  kind: "index" | "launch";
  ticker: string;
  period: string;
  period_start: number;
  cadence: Cadence;
  /** The value as a scaled integer: value / 10^decimals in `unit`. */
  value: string;
  decimals: number;
  unit: string;
  status: PrintStatus;
  /** For a correction: the report hash it replaces. Null otherwise. */
  corrects: string | null;
  /** For a final report: the hash of the provisional report it finalizes, which the recount co-signed. Null otherwise. */
  finalizes: string | null;
  rule: { version: number; hash: string };
  settleable: boolean;
  sources: SourceRead[];
  /** "two_providers" (two reads agreed), "official" (one official publisher, e.g. the BLS). */
  agreement: "two_providers" | "official";
  published_at: string;
  publisher: string;
};

export type Signed = { by: string; signature: string };
export type ReportEnvelope = { report: Report; hash: string; signature: Signed; cosignatures: Signed[] };

export const reportBytes = (r: Report) => Buffer.from(canonicalJson(r), "utf8");
export const reportHash = (r: Report) => sha256Bytes(reportBytes(r)).toString("hex");

export function signingMessage(hashHex: string, prefix: string = REPORT_PREFIX): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hashHex)) throw new Error("bad_hash");
  return Buffer.concat([Buffer.from(prefix, "ascii"), Buffer.from(hashHex, "hex")]);
}

/** Checks a report's fields before anything signs it. Throws a short reason. */
export function checkReport(r: Report): void {
  if (r.schema !== "tickerz-report/1") throw new Error("bad_schema");
  if (!/^[A-Z0-9.]{2,20}$/.test(r.ticker)) throw new Error("bad_ticker");
  if (!/^-?\d{1,19}$/.test(r.value)) throw new Error("bad_value");
  const v = BigInt(r.value);
  if (v > 2n ** 63n - 1n || v < -(2n ** 63n)) throw new Error("value_out_of_range");
  if (!Number.isInteger(r.decimals) || r.decimals < 0 || r.decimals > 12) throw new Error("bad_decimals");
  if (!Number.isSafeInteger(r.period_start)) throw new Error("bad_period_start");
  if (!["hour", "day", "week", "month"].includes(r.cadence)) throw new Error("bad_cadence");
  if (r.status === "corrected" ? !/^[0-9a-f]{64}$/.test(r.corrects ?? "") : r.corrects !== null) throw new Error("bad_corrects");
  if (r.status === "final" ? !/^[0-9a-f]{64}$/.test(r.finalizes ?? "") : r.finalizes !== null) throw new Error("bad_finalizes");
  if (!/^[0-9a-f]{64}$/.test(r.rule.hash)) throw new Error("bad_rule_hash");
  if (r.agreement === "two_providers") {
    const providers = new Set(r.sources.map((s) => s.provider));
    if (providers.size < 2) throw new Error("two_providers_needs_two");
    if (r.sources.some((s) => s.value !== r.value)) throw new Error("sources_disagree");
  }
  if (r.sources.length === 0) throw new Error("no_sources");
  for (const s of r.sources) if (!/^[0-9a-f]{64}$/.test(s.snapshot_sha256)) throw new Error("bad_snapshot_hash");
}

/** Signs a report with a Solana secret (the publisher's in production, a test key in tests). */
export function signReport(r: Report, secret: string, prefix: string = REPORT_PREFIX): ReportEnvelope {
  checkReport(r);
  const kp = keypairFromSecret(secret);
  if (prefix === REPORT_PREFIX && kp.address !== r.publisher) throw new Error("publisher_mismatch");
  const hash = reportHash(r);
  return { report: r, hash, signature: { by: kp.address, signature: base58Encode(signBytes(kp.privateKey, signingMessage(hash, prefix))) }, cosignatures: [] };
}

/** A co-signature over a report hash: the independent recount's key says it counted the same value. */
export function cosign(hash: string, secret: string): Signed {
  const kp = keypairFromSecret(secret);
  return { by: kp.address, signature: base58Encode(signBytes(kp.privateKey, signingMessage(hash, COSIGN_PREFIX))) };
}

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** Whether `sig` is `by`'s Ed25519 signature over the report hash with this prefix. Never throws. */
export function verifySigned(hash: string, sig: Signed, prefix: string = REPORT_PREFIX): boolean {
  try {
    const pub = base58Decode(sig.by);
    const s = base58Decode(sig.signature);
    if (pub.length !== 32 || s.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(pub)]), format: "der", type: "spki" });
    return edVerify(null, signingMessage(hash, prefix), key, s);
  } catch {
    return false;
  }
}

/**
 * Everything a reader checks on an envelope: the hash is the report's, the publisher signed it, and each co-signature
 * is valid and from a known recount key. Co-signatures are over the provisional report's hash: on a final report,
 * that is `finalizes`.
 */
export function verifyEnvelope(env: ReportEnvelope, opts: { publisher?: string; cosigners?: readonly string[] } = {}): { ok: boolean; reason?: string; cosigned: string[] } {
  const publisher = opts.publisher ?? SOLANA_PUBLISHER;
  if (reportHash(env.report) !== env.hash) return { ok: false, reason: "hash_mismatch", cosigned: [] };
  if (env.signature.by !== publisher || env.report.publisher !== publisher) return { ok: false, reason: "not_the_publisher", cosigned: [] };
  if (!verifySigned(env.hash, env.signature)) return { ok: false, reason: "bad_signature", cosigned: [] };
  const known = new Set(opts.cosigners ?? []);
  const target = env.report.finalizes ?? env.hash;
  const cosigned = env.cosignatures.filter((c) => known.has(c.by) && verifySigned(target, c, COSIGN_PREFIX)).map((c) => c.by);
  return { ok: true, cosigned };
}
