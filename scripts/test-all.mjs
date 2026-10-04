// Every test file, one after another: node --import tsx on each file in test/. Prints each file's last line (its
// pass count) and the total. Exits 1 when any file fails. No network, no keys.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "test");
const files = readdirSync(dir).filter((f) => f.endsWith(".test.ts")).sort().map((f) => path.join(dir, f));

const failed = [];
let checks = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ["--import", "tsx", f], { cwd: root, encoding: "utf8" });
  const rel = path.relative(root, f);
  const last = `${r.stdout ?? ""}`.trim().split("\n").pop() ?? "";
  const n = Number(last.match(/^(\d+) passed$/)?.[1] ?? NaN);
  if (r.status === 0 && Number.isFinite(n)) {
    checks += n;
    console.log(`ok   ${rel}  ${last}`);
  } else {
    failed.push(rel);
    console.log(`FAIL ${rel}`);
    process.stdout.write(`${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n").slice(-25).join("\n") + "\n");
  }
}
console.log(`\n${files.length - failed.length} of ${files.length} test files passed, ${checks} checks`);
if (failed.length) {
  console.log(`failed: ${failed.join(", ")}`);
  process.exit(1);
}
