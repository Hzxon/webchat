import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectPostgres } from '../server/sql.ts';

// Only the pool's options are read: no connection is opened, so no database is needed.
async function sslFor(connectionString: string) {
  const sql = connectPostgres({ connectionString });
  await sql.close();
  // node-postgres lets sslmode in the URL override the ssl option, so it must be gone.
  assert.equal(new URL(sql.pool.options.connectionString!).searchParams.has('sslmode'), false);
  return sql.pool.options.ssl;
}

test('sslmode=disable turns TLS off for a host that is not loopback', async () => {
  assert.equal(await sslFor('postgres://chat:secret@db:5432/webchat?sslmode=disable'), undefined);
});

test('a host that is not loopback still uses TLS by default', async () => {
  assert.deepEqual(await sslFor('postgres://chat:secret@db:5432/webchat'), { rejectUnauthorized: false });
  assert.deepEqual(await sslFor('postgres://chat:secret@db:5432/webchat?sslmode=require'), { rejectUnauthorized: false });
});

test('the IPv6 loopback address skips TLS', async () => {
  assert.equal(await sslFor('postgres://chat:secret@[::1]:5432/webchat'), undefined);
});
