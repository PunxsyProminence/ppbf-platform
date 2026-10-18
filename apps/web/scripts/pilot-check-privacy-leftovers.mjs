import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// READ-ONLY. Counts rows two closed privacy holes may have left behind, so a
// person can decide whether anything needs cleaning up. Counts only.
//
// 1. CROSS-SUBJECT CITATIONS (finding F-099). Before #1630, Library search
//    checked only a chunk's subject: a chunk with no subject under a document
//    filed against an athlete was served gym-wide (F-087). #1630 stops new
//    evidence like that. An answer already stored with it stays readable in
//    that conversation: the read path (shadowConversations.ts) returns the
//    cited document's name and source title for every citation, and the
//    answer text was written from that evidence (the passage itself is not
//    replayed; it must be gym-wide). SHADOW chat admits athletes and parents,
//    so such a citation in one of their conversations is another child's
//    record in someone else's hands.
//    What counts: a stored citation whose document has a subject that is not
//    the conversation's athlete (a conversation with no athlete counts too),
//    grouped by the asking account's role -- a coach reaches every athlete of
//    the gym (OD-2026-10-11-007), a parent or athlete does not. Citations in
//    deleted conversations are counted, and shown apart: the app no longer
//    shows them, but the rows are still stored.
//    The app has copied a document's subject onto its chunks since the Library
//    was written, and the repository's research seed has no subject-scoped
//    rows, so the expected answer is 0; only a count shows it.
//
// 2. ATHLETE LOGINS WITH A STAFF ROLE (finding F-098). Until lane L44's PR A,
//    assign-admin and transfer-admin promoted an athlete's login (role
//    'athlete', or an athlete_id behind it) to the gym's organization_admin
//    with athlete_id kept, and a transfer could then demote it to coach. What
//    counts: logins with an athlete_id and a role other than 'athlete', by
//    role; and memberships with a role other than 'athlete' held by an
//    athlete login, by membership role. Deleted and inactive ones are shown
//    apart.
//
// THERE IS NO APPLY PATH IN THIS FILE. Every statement runs inside one
// read-only transaction that is rolled back, so PostgreSQL itself refuses a
// write. Cleanup, if a count is not zero, is a separate decision.
//
// Exit codes: 0 nothing found, 2 found (somebody needs to look), 1 the check
// itself failed. Counts and role names only: no ids, emails, names or
// document names are printed.

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

// Same reasoning as db.ts's resolveSslConfig and the migration runners:
// production/staging always require TLS.
function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

async function countCrossSubjectCitations(client) {
  const tables = await client.query(
    `select to_regclass('pilot.shadow_message_citations') is not null as citations,
            to_regclass('pilot.shadow_evidence_items') is not null as items`,
  );
  if (tables.rows[0]?.citations !== true || tables.rows[0]?.items !== true) {
    throw new Error('SHADOW_CITATION_TABLES_MISSING');
  }
  // The platform Library migration added library_organization_id: the shelf
  // that owns the cited document, which for the platform baseline is not the
  // bundle's gym. Before it, the two were the same column.
  const column = await client.query(
    `select exists (
       select 1 from information_schema.columns
       where table_schema = 'pilot'
         and table_name = 'shadow_evidence_items'
         and column_name = 'library_organization_id'
     ) as present`,
  );
  const libraryOrganization = column.rows[0]?.present === true ? 'ei.library_organization_id' : 'ei.organization_id';
  const counted = await client.query(
    `select coalesce(a.role, 'unknown') as asker_role,
            count(*)::int as citations,
            count(distinct mc.assistant_message_id)::int as answers,
            count(distinct m.conversation_id)::int as conversations,
            (count(*) filter (where s.deleted_at is null))::int as citations_in_open_conversations
       from pilot.shadow_message_citations mc
       join pilot.shadow_evidence_items ei
         on ei.evidence_id = mc.evidence_id
        and ei.bundle_id = mc.bundle_id
        and ei.organization_id = mc.organization_id
        and ei.account_id = mc.account_id
       join pilot.shadow_library_documents d
         on d.document_id = ei.document_id
        and d.organization_id = ${libraryOrganization}
       join pilot.shadow_chat_messages m
         on m.message_id = mc.assistant_message_id
        and m.organization_id = mc.organization_id
        and m.account_id = mc.account_id
       join pilot.shadow_chat_sessions s
         on s.conversation_id = m.conversation_id
        and s.organization_id = m.organization_id
       left join pilot.accounts a
         on a.account_id = mc.account_id
      where d.subject_id is not null
        and d.subject_id is distinct from s.athlete_id
      group by 1
      order by 1`,
  );
  const byRole = counted.rows.map((row) => ({
    asker_role: row.asker_role,
    citations: row.citations,
    answers: row.answers,
    conversations: row.conversations,
    citations_in_open_conversations: row.citations_in_open_conversations,
  }));
  return {
    total: byRole.reduce((sum, row) => sum + row.citations, 0),
    by_asker_role: byRole,
  };
}

async function countAthleteLoginsWithStaffRoles(client) {
  const logins = await client.query(
    `select a.role,
            count(*)::int as logins,
            (count(*) filter (where a.deleted_at is null and a.active_flag))::int as live
       from pilot.accounts a
      where a.athlete_id is not null
        and a.role <> 'athlete'
      group by a.role
      order by a.role`,
  );
  const memberships = await client.query(
    `select om.role,
            count(*)::int as memberships,
            (count(*) filter (where om.active_flag and a.deleted_at is null))::int as live
       from pilot.organization_memberships om
       join pilot.accounts a on a.account_id = om.account_id
      where (a.role = 'athlete' or a.athlete_id is not null)
        and om.role <> 'athlete'
      group by om.role
      order by om.role`,
  );
  const loginsByRole = logins.rows.map((row) => ({ role: row.role, logins: row.logins, live: row.live }));
  const membershipsByRole = memberships.rows.map((row) => ({
    role: row.role,
    memberships: row.memberships,
    live: row.live,
  }));
  return {
    total: loginsByRole.reduce((sum, row) => sum + row.logins, 0)
      + membershipsByRole.reduce((sum, row) => sum + row.memberships, 0),
    logins_by_role: loginsByRole,
    memberships_by_role: membershipsByRole,
  };
}

export async function countPrivacyLeftovers(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    return {
      cross_subject_citations: await countCrossSubjectCitations(client),
      athlete_logins_with_staff_roles: await countAthleteLoginsWithStaffRoles(client),
    };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }
}

export async function run() {
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');
  const client = new Client({ connectionString, ssl: resolveSslConfig() });
  await client.connect();
  let report;
  try {
    report = await countPrivacyLeftovers(client);
  } finally {
    await client.end();
  }

  console.log(JSON.stringify({ event: 'privacy_leftovers.checked', ...report }));
  const citations = report.cross_subject_citations.total;
  const staffRoles = report.athlete_logins_with_staff_roles.total;
  if (citations === 0 && staffRoles === 0) {
    console.log(
      'PILOT PRIVACY LEFTOVERS CHECK PASS: no stored SHADOW answer cites a Library document filed against another athlete, and no athlete login holds a staff role or membership (read-only; nothing changed)',
    );
    return 0;
  }
  console.log(
    `PILOT PRIVACY LEFTOVERS CHECK REPORTED: ${citations} stored citation(s) of a Library document filed against an athlete other than the conversation's (cross_subject_citations), and ${staffRoles} athlete login role(s) or membership(s) other than athlete (athlete_logins_with_staff_roles). Cleanup is a separate decision (read-only; nothing changed)`,
  );
  return 2;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    process.exitCode = await run();
  } catch (error) {
    console.error('PILOT PRIVACY LEFTOVERS CHECK FAIL (read-only; nothing changed)');
    console.error(String(error));
    process.exit(1);
  }
}
