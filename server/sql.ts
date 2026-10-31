import fs from 'node:fs';
import pg from 'pg';

/** The few database calls the app needs. Implemented by node-postgres (Supabase) and PGlite (local). */
export interface Querier {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface Sql extends Querier {
  /** Runs work inside BEGIN/COMMIT and rolls back if it throws. */
  transaction<T>(work: (tx: Querier) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// node-postgres returns BIGINT as a string by default. Every BIGINT here is a millisecond timestamp
// or a count, both far below 2^53, so plain numbers are safe and match what PGlite returns.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export interface PostgresOptions {
  connectionString: string;
  /** PEM certificate to verify the server with. Supabase signs with its own root CA, not a public one. */
  caCert?: string;
}

export function connectPostgres({ connectionString, caCert }: PostgresOptions): Sql & { pool: pg.Pool } {
  const url = new URL(connectionString);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  // node-postgres reads sslmode from the URL and would override the ssl object below.
  url.searchParams.delete('sslmode');
  const pool = new pg.Pool({
    connectionString: url.toString(),
    // Supabase's certificate chains to its own root CA. Without DATABASE_CA_CERT the connection is
    // still encrypted, but the server's identity is not checked.
    ssl: local ? undefined : caCert ? { ca: caCert } : { rejectUnauthorized: false },
    // Serverless functions run many small instances; a few connections each is plenty.
    max: 3,
    idleTimeoutMillis: 10_000,
  });

  return {
    pool,
    async query<T>(text: string, params?: unknown[]) {
      return (await pool.query(text, params)).rows as T[];
    },
    async transaction<T>(work: (tx: Querier) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work({ query: async <R>(t: string, p?: unknown[]) => (await client.query(t, p)).rows as R[] });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Embedded Postgres for local development and tests. Pass ":memory:" for a throwaway database. */
export async function openPglite(dataDir: string): Promise<Sql> {
  // A computed specifier keeps Vercel's bundler from packing PGlite (26 MB) into the function,
  // which always uses Postgres there.
  const specifier = '@electric-sql/pglite';
  const { PGlite } = (await import(specifier)) as typeof import('@electric-sql/pglite');
  if (dataDir !== ':memory:') fs.mkdirSync(dataDir, { recursive: true });
  const db = new PGlite(dataDir === ':memory:' ? undefined : dataDir);
  await db.waitReady;

  return {
    async query<T>(text: string, params?: unknown[]) {
      return (await db.query<T>(text, params)).rows;
    },
    transaction<T>(work: (tx: Querier) => Promise<T>) {
      return db.transaction((tx) => work({ query: async <R>(t: string, p?: unknown[]) => (await tx.query<R>(t, p)).rows }));
    },
    close: () => db.close(),
  };
}
