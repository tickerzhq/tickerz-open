/**
 * An index level as text. No imports, so a client component (the chart readout) can format a level without pulling
 * the registry into public JavaScript. registry.ts re-exports both, so every import path still works.
 */

/** What a formatter reads of an index definition: the same shape as Pick<IndexDef, "format" | "unit">. */
export type LevelFormat = { format: "count" | "usd" | "percent"; unit: [string, string] };

/** A level in full, for settlement: "9,782 views", "$4,434,237.23". Never abbreviated. */
export function formatExact(def: LevelFormat, v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "no reading";
  // Cents, and down to the millionth USDC settles in when the level is under a dollar (the machine wage).
  if (def.format === "usd") return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(v) > 0 && Math.abs(v) < 1 ? 6 : 2 })}`;
  if (def.format === "percent") {
    const n = v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return `${n} ${Math.abs(v) === 1 ? def.unit[0] : def.unit[1]}`;
  }
  const n = v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${n} ${Math.abs(v) === 1 ? def.unit[0] : def.unit[1]}`;
}

/** "9,782 views", "$4.43M". */
export function formatLevel(def: LevelFormat, v: number | null | undefined, opts: { unit?: boolean } = {}): string {
  if (v == null || !Number.isFinite(v)) return "--";
  if (def.format === "usd") {
    const a = Math.abs(v);
    // Under a dollar, four decimals: the machine wage is a fraction of a cent.
    const s = a >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : a >= 1 ? v.toFixed(0) : a > 0 ? v.toFixed(4) : "0";
    return `$${s}`;
  }
  if (def.format === "percent") {
    const n = v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    if (opts.unit === false) return n;
    return `${n} ${Math.abs(v) === 1 ? def.unit[0] : def.unit[1]}`;
  }
  const n = Math.round(v).toLocaleString("en-US");
  if (opts.unit === false) return n;
  return `${n} ${Math.round(Math.abs(v)) === 1 ? def.unit[0] : def.unit[1]}`;
}
