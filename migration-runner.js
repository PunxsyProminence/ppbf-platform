const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.AZURE_POSTGRES_CONNECTION_STRING,
  ssl: { rejectUnauthorized: false }
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
