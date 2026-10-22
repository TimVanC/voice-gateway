import { Pool } from "pg";

// One pool per server process. Next.js reloads modules in dev, so the pool is
// parked on globalThis to avoid leaking connections on every hot reload.
const globalForPg = globalThis as unknown as { avaPool?: Pool };

export function getPool(): Pool {
  if (!globalForPg.avaPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    // Verified TLS for Neon; none for a local database.
    const local = /sslmode=disable/i.test(connectionString) || /@(localhost|127\.0\.0\.1)[:/]/i.test(connectionString);
    globalForPg.avaPool = new Pool({
      connectionString,
      ssl: local ? false : { rejectUnauthorized: true },
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      query_timeout: 15_000,
    });
    globalForPg.avaPool.on("error", (err) => {
      console.error("pg pool error (ignored):", err.message);
    });
  }
  return globalForPg.avaPool;
}

export async function query<T extends object = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query(text, params);
  return result.rows as T[];
}
