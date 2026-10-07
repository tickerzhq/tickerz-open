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

export type Canon = string | number | boolean | null | Canon[] | { [k: string]: Canon };

export function canonicalJson(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("canonical_number_not_integer");
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return `{${keys.map((k) => {
      if (o[k] === undefined) throw new Error(`canonical_undefined:${k}`);
      return `${JSON.stringify(k)}:${canonicalJson(o[k])}`;
    }).join(",")}}`;
  }
  throw new Error(`canonical_type:${typeof v}`);
}

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
