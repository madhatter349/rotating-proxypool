import { cp, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "db", "migrations");
const dest = join(root, "dist", "db", "migrations");

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`[build] copied migrations -> ${dest}`);