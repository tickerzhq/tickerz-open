/**
 * The canonical JSON writer with no Node imports, so the browser builds the same bytes as the signer (the "Verify it
 * yourself" button on /signed). canonical.ts re-exports it with the hashing helpers.
 */
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
