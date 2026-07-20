import pg from 'pg';

const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
if (!connectionString) {
  console.error('FAIL: AZURE_POSTGRES_CONNECTION_STRING is required.');
  process.exit(2);
}

const required = {
  shadow_chat_audit: ['organization_id', 'user_id', 'user_message', 'shadow_response', 'was_filtered'],
  shadow_chat_sessions: ['conversation_id', 'organization_id', 'user_id', 'deleted_at'],
  shadow_chat_messages: ['message_id', 'conversation_id', 'organization_id', 'user_id', 'role', 'content'],
  shadow_human_review_queue: ['review_id', 'organization_id', 'severity', 'status'],
  shadow_data_deletion_requests: ['request_id', 'organization_id', 'user_id', 'status'],
  shadow_telemetry_events: ['organization_id', 'metric_name', 'dimensions'],
};

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  const result = await client.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'pilot'");
  const found = new Map();
  for (const row of result.rows) {
    if (!found.has(row.table_name)) found.set(row.table_name, new Set());
    found.get(row.table_name).add(row.column_name);
  }
  const missing = [];
  for (const [table, columns] of Object.entries(required)) {
    for (const column of columns) if (!found.get(table)?.has(column)) missing.push('pilot.' + table + '.' + column);
  }
  if (missing.length) {
    console.error('FAIL: missing required SHADOW database objects:\n' + missing.map((item) => ' - ' + item).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('PASS: SHADOW chat database schema is ready.');
  }
} finally {
  await client.end();
}