import { cp, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// tsc only emits compiled .ts files; copy non-TS assets the runtime reads.
const assets = [
  ["src/db/migrations", "dist/db/migrations"],
  ["src/dashboard/index.html", "dist/dashboard/index.html"],
];

for (const [srcRel, destRel] of assets) {
  const src = join(root, srcRel);
  const dest = join(root, destRel);
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
  console.log(`[build] copied ${srcRel} -> ${destRel}`);
}