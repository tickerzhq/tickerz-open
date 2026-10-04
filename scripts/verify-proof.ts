/*
 * Verify one day's Tickerz seal.
 *
 *   npm run verify -- 2026-10-03            checks, then writes proofs/tickerz-seal-2026-10-03.json and .json.ots
 *   npm run verify -- 2026-10-03 --out dir  writes the two files to dir instead
 *
 * Fetches the seal written on that UTC day from the public API (no key), then checks, with no Bitcoin node:
 *   1. sha256(canonical_json) equals the published digest;
 *   2. the text is the seal for that day;
 *   3. rebuilt from its own rows with the published key order, the text comes out byte for byte the same;
 *   4. the .ots file commits to that same digest (and matches the copy inside the JSON).
 * It prints the MINTS, GIGS and WAGE rows the seal fixes, writes the exact hashed text and the proof side by side, and
 * says how to finish the check on Bitcoin with the standard OpenTimestamps client. Exit code 0 when every check passes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkSeal, fetchSeal, isCalendarDay, sealRowsOf, PROOF_BASE } from "../src/seal";

const args = process.argv.slice(2);
const day = args.find((a) => !a.startsWith("--"));
const outAt = args.indexOf("--out");
const outDir = outAt >= 0 && args[outAt + 1] ? args[outAt + 1] : "proofs";

if (!isCalendarDay(day)) {
  console.error("Usage: npm run verify -- YYYY-MM-DD [--out dir]\nThe day a seal was written (UTC). A seal written on day D fixes the readings of D-1.");
  process.exit(2);
}

(async () => {
  console.log(`Seal written on ${day}: ${PROOF_BASE}?day=${day}\n`);
  let fetched: Awaited<ReturnType<typeof fetchSeal>>;
  try {
    fetched = await fetchSeal(day);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg.startsWith("proof_http_404") ? `No seal on file for ${day}. Seals are written once a day after 12:00 UTC.` : `Could not fetch the seal: ${msg}`);
    process.exit(1);
  }
  const { proof, ots } = fetched;

  const checks = checkSeal(proof, ots, day);
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(9)} ${c.detail}`);
  const ok = checks.every((c) => c.ok);

  const rows = JSON.parse(proof.canonical_json) as { since: string | null; rows: unknown[] };
  console.log(`\ndigest_sha256  ${proof.digest_sha256}`);
  console.log(`stamped_at     ${proof.stamped_at ?? "?"}`);
  console.log(`since          ${rows.since ?? "the first seal"}`);
  console.log(`rows           ${rows.rows.length}`);
  console.log(`bitcoin        ${proof.bitcoin_height != null ? `block ${proof.bitcoin_height}${proof.bitcoin_block_time ? `, ${proof.bitcoin_block_time}` : ""}` : "not yet confirmed (the calendars usually confirm within a few hours)"}`);

  console.log("\nWhat this seal fixes for the indexes in this repo:");
  for (const t of ["MINTS", "MINTS.GRADS", "GIGS", "WAGE"]) {
    const mine = sealRowsOf(proof.canonical_json, t);
    if (!mine.length) console.log(`  ${t.padEnd(12)} (no row in this seal)`);
    for (const r of mine) console.log(`  ${t.padEnd(12)} ${r.period}  ${"value" in r ? r.value : `sha256 ${r.value_sha256}`}  revisions ${r.revisions}`);
  }

  mkdirSync(outDir, { recursive: true });
  const jsonFile = path.join(outDir, `tickerz-seal-${day}.json`);
  const otsFile = `${jsonFile}.ots`;
  // The exact bytes that were hashed: no newline, no reformatting.
  writeFileSync(jsonFile, proof.canonical_json, "utf8");
  writeFileSync(otsFile, ots);
  console.log(`\nWrote ${jsonFile} (the exact text hashed) and ${otsFile} (its OpenTimestamps proof).`);

  console.log(`
Finish on Bitcoin with the OpenTimestamps client (pip install opentimestamps-client):
  ots info ${otsFile}
      Prints the path from the digest to its Bitcoin attestation. Needs no node.
  ots verify ${otsFile}
      Hashes ${path.basename(jsonFile)} beside it and checks the path against the attested block's header, read from
      a Bitcoin Core node on this machine (the client's default; a pruned node works).
Without a node: drop both files on https://opentimestamps.org, which checks the block against a public explorer.`);

  if (!ok) {
    console.error("\nAt least one check failed: do not rely on this seal.");
    process.exit(1);
  }
  console.log("\nAll checks passed.");
})();
