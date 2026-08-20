import pg from "pg";

let pool: pg.Pool | null = null;

export function getPool(databaseUrl?: string): pg.Pool {
  if (pool) return pool;
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  pool = new pg.Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  pool.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("Unexpected postgres pool error", err.message);
  });
  return pool;
}

export async function ping(p: pg.Pool): Promise<void> {
  const client = await p.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export { pool }; // re-export for tests that want to reset the singleton