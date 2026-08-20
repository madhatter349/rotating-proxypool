import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const here = fileURLToPath(new URL(".", import.meta.url));
const migrationsDir = join(here, "migrations");

export async function migrate(db: pg.Pool): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const { rowCount } = await db.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      [version]
    );
    if ((rowCount ?? 0) > 0) continue;

    const sql = await readFile(join(migrationsDir, file), "utf8");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [version]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    // eslint-disable-next-line no-console
    console.log(`[db] applied migration ${version}`);
  }
}