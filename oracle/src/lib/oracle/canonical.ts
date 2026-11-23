/**
 * Canonical JSON for anything Tickerz signs or hashes (rules, reports, co-signatures). One byte string per value, so
 * anyone can rebuild it and get the same sha256:
 *   - object keys sorted by their UTF-16 code units (as JavaScript sorts strings), at every depth;
 *   - no whitespace; strings escaped as JSON.stringify escapes them;
 *   - numbers only as safe integers (no floats, no exponents): a value with decimals is a scaled integer in a string;
 *   - undefined is refused, null is kept.
 * This is the integer-only subset of RFC 8785 (JSON Canonicalization Scheme), where both give the same bytes.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonicalCore";

export { canonicalJson, type Canon } from "./canonicalCore";

export const sha256Bytes = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest();
export const canonicalHash = (v: unknown) => sha256Bytes(Buffer.from(canonicalJson(v), "utf8")).toString("hex");

/** A decimal number as a scaled integer string: 4.2 at 1 decimal is "42", 0.005 at 6 is "5000". Rounds half away from zero; throws when it does not fit. */
export function scaled(value: number, decimals: number): string {
  if (!Number.isFinite(value)) throw new Error("scaled_not_finite");
  // Half away from zero, as the rulebook rounds; the toPrecision step removes binary noise (4.2 * 10 = 42.00000000000001).
  const x = Number((Math.abs(value) * 10 ** decimals).toPrecision(15));
  const s = Math.sign(value) * Math.round(x);
  if (!Number.isSafeInteger(s)) throw new Error("scaled_too_large");
  return String(s === 0 ? 0 : s);
}

/** The other way: "42" at 1 decimal is 4.2. For display only; a contract keeps the integer. */
export const unscaled = (s: string, decimals: number) => Number(s) / 10 ** decimals;
