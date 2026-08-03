const { Pool } = require('pg');

// Legacy one-off script retained for local/dev recovery only.
// Production and staging migrations must run through controlled pilot:apply-* scripts.
function assertLocalTarget(connectionString) {
  if (!connectionString || !connectionString.trim()) {
    throw new Error('Missing AZURE_POSTGRES_CONNECTION_STRING');
  }

  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('Invalid AZURE_POSTGRES_CONNECTION_STRING');
  }

  const host = (parsed.hostname || '').toLowerCase();
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (!localHosts.has(host)) {
    throw new Error('Refusing non-local target. Use controlled pilot:apply-* migration scripts for shared environments.');
  }
}

const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
assertLocalTarget(connectionString);

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: true }
});

(async () => {
  try {
    const result = await pool.query(
      'ALTER TABLE pilot.accounts ADD COLUMN IF NOT EXISTS has_master_shadow_access boolean NOT NULL DEFAULT false;'
    );
    console.log('✅ Migration successful');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
