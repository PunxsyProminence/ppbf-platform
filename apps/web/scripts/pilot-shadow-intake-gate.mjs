/*
  SHADOW Intake mandatory gate:
  - Upload real PDFs for required document classes
  - Persist to Blob + shadow_intake + intake case/doc tables
  - Approve + promote to domain records
  - Verify retrieval and audit trail
*/

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import PDFDocument from 'pdfkit';

import { mintGateSession } from './lib/gate-session.mjs';

// Populated by run() as sessions are minted, and drained in the finally block
// at the bottom of this file so nothing is left live if the gate throws.
const sessionsToRevoke = [];

const baseUrl = process.env.PILOT_GATE_BASE_URL || 'http://localhost:3000';
const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING || '';
const adminAccountId = process.env.PILOT_ADMIN_ACCOUNT_ID || '';
const organizationId = process.env.PILOT_ORG_A_ID || process.env.PPBF_PILOT_DEFAULT_ORG_ID || '';
const organizationName = process.env.PILOT_ORG_A_NAME || '';

const athleteAccountId = process.env.PILOT_SHADOW_ATHLETE_ACCOUNT_ID || '';
const athletePin = process.env.PILOT_SHADOW_ATHLETE_PIN || '';
const athleteId = process.env.PILOT_SHADOW_ATHLETE_ID || '';
const guardianAccountId = process.env.PILOT_SHADOW_GUARDIAN_ACCOUNT_ID || '';
// Still required: the promotion step provisions the guardian account and sets
// this PIN on it, even though a parent can no longer sign in with one.
const guardianPin = process.env.PILOT_SHADOW_GUARDIAN_PIN || '';
const guardianParentId = process.env.PILOT_SHADOW_GUARDIAN_PARENT_ID || '';

function requireEnv(name, value) {
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const documentMatrix = [
  { type: 'athlete_registration', title: 'Athlete Registration Packet' },
  { type: 'emergency_contact', title: 'Emergency Contact Form' },
  { type: 'medical_form', title: 'Medical Form' },
  { type: 'waiver_consent', title: 'Waiver Consent Form' },
  { type: 'assessment_document', title: 'Assessment Document' },
  { type: 'general_intake', title: 'General Intake Document' },
];

try {
  // The administrator and guardian fixtures are authenticated by minting a
  // session directly (see lib/gate-session.mjs), because a PIN login cannot
  // produce a session for either role. The athlete still signs in with a PIN,
  // which is a real supported path and worth exercising here.
  requireEnv('AZURE_POSTGRES_CONNECTION_STRING', connectionString);
  requireEnv('PILOT_ADMIN_ACCOUNT_ID', adminAccountId);
  requireEnv('PILOT_ORG_A_ID or PPBF_PILOT_DEFAULT_ORG_ID', organizationId);
  requireEnv('PILOT_ORG_A_NAME', organizationName);
  requireEnv('PILOT_SHADOW_ATHLETE_ACCOUNT_ID', athleteAccountId);
  requireEnv('PILOT_SHADOW_ATHLETE_PIN', athletePin);
  requireEnv('PILOT_SHADOW_ATHLETE_ID', athleteId);
  requireEnv('PILOT_SHADOW_GUARDIAN_ACCOUNT_ID', guardianAccountId);
  requireEnv('PILOT_SHADOW_GUARDIAN_PARENT_ID', guardianParentId);
} catch (error) {
  console.error(String(error));
  process.exit(1);
}

function createClient(name, initialCookie = '') {
  let cookieHeader = initialCookie;

  return {
    async call(pathname, { method = 'GET', body, formData } = {}) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: {
          ...(formData ? {} : { 'Content-Type': 'application/json' }),
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        body: formData || (body ? JSON.stringify(body) : undefined),
      });

      const setCookie = response.headers.get('set-cookie');
      if (setCookie) {
        cookieHeader = setCookie.split(';')[0];
      }

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`${name}: ${method} ${pathname} failed (${response.status}) ${JSON.stringify(payload)}`);
      }

      return payload;
    },
  };
}

async function writePdf(filePath, title, details) {
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const stream = doc.pipe(createWriteStream(filePath));

    doc.fontSize(18).text(title);
    doc.moveDown();
    doc.fontSize(11).text(`Generated at: ${new Date().toISOString()}`);
    doc.moveDown();

    for (const line of details) {
      doc.fontSize(12).text(`- ${line}`);
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}


async function uploadRequiredDocuments(admin, tempDir) {
  const uploaded = [];
  let intakeCaseId = '';

  for (const docInfo of documentMatrix) {
    const fileName = `${docInfo.type}.pdf`;
    const filePath = path.join(tempDir, fileName);

    await writePdf(filePath, docInfo.title, [
      `Organization: ${organizationId}`,
      `Athlete ID: ${athleteId}`,
      `Doc Type: ${docInfo.type}`,
    ]);

    const bytes = await fs.readFile(filePath);
    const formData = new FormData();
    formData.append('file', new Blob([bytes], { type: 'application/pdf' }), fileName);
    formData.append('document_type', docInfo.type);
    formData.append('hint', docInfo.type);
    if (intakeCaseId) {
      formData.append('intake_case_id', intakeCaseId);
    }

    const uploadResult = await admin.call('/api/pilot/shadow/upload', {
      method: 'POST',
      formData,
    });

    if (!intakeCaseId) {
      intakeCaseId = uploadResult.intake_case_id;
    }

    uploaded.push({
      ...docInfo,
      intake_id: uploadResult.intake_id,
      intake_document_id: uploadResult.intake_document_id,
    });
  }

  if (!intakeCaseId) {
    throw new Error('No intake case id returned from uploads');
  }

  return { intakeCaseId, uploaded };
}

function assertQueueContainsCase(queue, intakeCaseId) {
  const queueContainsCase = queue.queue.some((item) => item.intake_case_id === intakeCaseId);
  if (!queueContainsCase) {
    throw new Error('Uploaded intake case not present in review queue');
  }
}

function assertAggregateReady(aggregate) {
  if (!aggregate?.found) {
    throw new Error('Intake case aggregate not found');
  }

  const aggregateDocs = aggregate.aggregate?.documents || [];
  if (aggregateDocs.length < documentMatrix.length) {
    throw new Error(`Expected ${documentMatrix.length} documents in case aggregate, found ${aggregateDocs.length}`);
  }
}

function assertDomainPersistence(domain) {
  if (!domain.emergency_contacts?.length) throw new Error('Missing emergency_contacts persistence');
  if (!domain.medical_intake?.length) throw new Error('Missing medical_intake persistence');
  if (!domain.waivers?.length) throw new Error('Missing waivers persistence');
  if (!domain.assessments?.length) throw new Error('Missing assessments persistence');
  if (!domain.attendance?.length) throw new Error('Missing attendance persistence');
  if (!domain.readiness?.length) throw new Error('Missing readiness persistence');
  if (!domain.coach_observations?.length) throw new Error('Missing coach observations persistence');
  if (!domain.guardians?.length) throw new Error('Missing guardian linkage persistence');
}

function assertAuditPromotionEvent(audit) {
  if (!audit.events?.some((row) => row.entity_type === 'intake_case_promotion')) {
    throw new Error('Missing intake_case_promotion audit event');
  }
}

function assertShadowReadModels({ events, telemetry, observation, knowledge, research, intakeCaseId, athleteId }) {
  const eventNames = new Set((events.events || []).map((row) => row.event_name));
  if (!eventNames.has('SHADOW_UPLOAD_CLASSIFIED_AND_ROUTED')) {
    throw new Error('Missing SHADOW upload event in shadow/events read model');
  }
  if (!eventNames.has('SHADOW_INTAKE_CASE_PROMOTED')) {
    throw new Error('Missing SHADOW promotion event in shadow/events read model');
  }

  const telemetryMetrics = new Set((telemetry.telemetry || []).map((row) => row.metric_name));
  if (!telemetryMetrics.has('shadow.intake.upload')) {
    throw new Error('Missing shadow.intake.upload telemetry metric');
  }
  if (!telemetryMetrics.has('shadow.intake.review.promote')) {
    throw new Error('Missing shadow.intake.review.promote telemetry metric');
  }

  if (!observation.items?.some((item) => item.label === 'SHADOW_INTAKE_CASE_PROMOTED')) {
    throw new Error('Observation projection missing SHADOW_INTAKE_CASE_PROMOTED item');
  }

  if (!knowledge.items?.some((item) => item.source_event_name === 'SHADOW_INTAKE_CASE_PROMOTED')) {
    throw new Error('Knowledge projection missing SHADOW_INTAKE_CASE_PROMOTED item');
  }

  const researchPromoted = research.items?.find((item) => item.source_event_name === 'SHADOW_INTAKE_CASE_PROMOTED');
  if (!researchPromoted) {
    throw new Error('Research projection missing SHADOW_INTAKE_CASE_PROMOTED item');
  }

  if (!researchPromoted.requirement || !researchPromoted.knowledge_gap || !researchPromoted.source_status) {
    throw new Error('Research projection item missing populated requirement/knowledge gap/source status');
  }

  const eventForCase = (events.events || []).some((row) => row.payload?.intake_case_id === intakeCaseId);
  if (!eventForCase) {
    throw new Error('Shadow events stream missing payload correlation to intake case id');
  }

  const telemetryForAthlete = (telemetry.telemetry || []).some((row) => row.dimensions?.athlete_id === athleteId);
  if (!telemetryForAthlete) {
    throw new Error('Shadow telemetry stream missing athlete_id correlation signal');
  }
}

function assertAthleteSession(athleteSession) {
  if (!athleteSession.authenticated || athleteSession.athlete_id !== athleteId) {
    throw new Error('Athlete login/session verification failed');
  }
}

async function run() {
  console.log('1) Mint administrator session');
  const adminSession = await mintGateSession({
    connectionString,
    accountId: adminAccountId,
    expectedRole: 'organization_admin',
  });
  sessionsToRevoke.push(adminSession);

  const admin = createClient('shadow-admin', adminSession.cookie);
  const athlete = createClient('shadow-athlete');
  // The guardian account does not exist yet -- the promotion step below is what
  // creates it -- so its session is minted at step 11, not here.
  let guardian;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ppbf-shadow-intake-'));

  console.log('2) Generate and upload required PDF document types');
  const { intakeCaseId, uploaded } = await uploadRequiredDocuments(admin, tempDir);

  console.log('3) Verify review queue contains case');
  const queue = await admin.call('/api/pilot/intake/review-queue', { method: 'POST', body: {} });
  assertQueueContainsCase(queue, intakeCaseId);

  console.log('4) Approve case');
  await admin.call('/api/pilot/intake/review-action', {
    method: 'POST',
    body: {
      intake_case_id: intakeCaseId,
      action: 'approve',
      notes: 'Gate approval before promotion',
    },
  });

  console.log('5) Promote case to domain records + accounts + linkage');
  await admin.call('/api/pilot/intake/review-action', {
    method: 'POST',
    body: {
      intake_case_id: intakeCaseId,
      action: 'promote',
      notes: 'Gate promotion',
      promotion: {
        athlete: {
          athlete_id: athleteId,
          account_id: athleteAccountId,
          pin: athletePin,
          full_name: 'Gate Athlete',
          dob: '2011-02-10',
          weight_class: '119',
          gym_status: 'active',
          emergency_contact: 'Guardian 555-0102',
          coach_id: adminAccountId,
        },
        guardian: {
          parent_id: guardianParentId,
          account_id: guardianAccountId,
          pin: guardianPin,
          full_name: 'Gate Guardian',
          phone: '555-0102',
          email: 'guardian@example.org',
          relationship_to_athlete: 'parent',
        },
        emergency_contact: {
          full_name: 'Gate Guardian',
          relationship_to_athlete: 'parent',
          phone: '555-0102',
          email: 'guardian@example.org',
          is_primary: true,
          notes: 'Primary emergency contact from intake packet',
        },
        medical: {
          conditions: 'None reported',
          medications: 'None',
          allergies: 'Peanuts',
          physician_name: 'Dr. Ring',
          physician_phone: '555-0110',
          clearance_status: 'cleared',
          notes: 'Medical form attached',
        },
        waiver: {
          waiver_type: 'program_consent',
          signed_by_name: 'Gate Guardian',
          signed_by_role: 'parent',
          signed_at: new Date().toISOString(),
          consent_version: 'v1.0',
          status: 'signed',
          notes: 'Waiver signed during intake',
        },
        assessment: {
          assessment_type: 'initial_skill_assessment',
          result: { score: 72, notes: 'Baseline captured from packet' },
        },
        attendance: {
          attendance_date: new Date().toISOString().slice(0, 10),
          status: 'present',
          notes: 'Present during onboarding day',
        },
        readiness: {
          score: 7.4,
          category: 'onboarding',
          measured_at: new Date().toISOString(),
          recovery_notes: 'No restrictions',
        },
        coach_note: {
          note_type: 'onboarding_observation',
          note_text: 'Athlete packet reviewed and approved by SHADOW intake flow.',
        },
      },
    },
  });

  console.log('6) Verify intake case retrieval and document traceability');
  const aggregate = await admin.call('/api/pilot/intake/cases/get', {
    method: 'POST',
    body: { intake_case_id: intakeCaseId },
  });
  assertAggregateReady(aggregate);

  console.log('7) Verify SHADOW projection/read-model streams');
  const [events, telemetry, observation, knowledge, research] = await Promise.all([
    admin.call('/api/pilot/shadow/events', {
      method: 'POST',
      body: { correlation_id: intakeCaseId, limit: 200 },
    }),
    admin.call('/api/pilot/shadow/telemetry', {
      method: 'POST',
      body: { limit: 200 },
    }),
    admin.call('/api/pilot/shadow/observation-projection', {
      method: 'POST',
      body: { limit: 200 },
    }),
    admin.call('/api/pilot/shadow/knowledge-projection', {
      method: 'POST',
      body: { limit: 200 },
    }),
    admin.call('/api/pilot/shadow/research-projection', {
      method: 'POST',
      body: { limit: 200 },
    }),
  ]);
  assertShadowReadModels({ events, telemetry, observation, knowledge, research, intakeCaseId, athleteId });

  console.log('8) Verify domain retrieval endpoint');
  const domain = await admin.call('/api/pilot/intake/domain-get', {
    method: 'POST',
    body: { athlete_id: athleteId },
  });
  assertDomainPersistence(domain);

  console.log('9) Verify audit trail exists');
  const audit = await admin.call('/api/pilot/audit/get', {
    method: 'POST',
    body: { entity_id: intakeCaseId, limit: 100 },
  });
  assertAuditPromotionEvent(audit);

  console.log('10) Verify athlete login and retrieval');
  await athlete.call('/api/pilot/auth/login', {
    method: 'POST',
    body: { account_id: athleteAccountId, pin: athletePin },
  });

  const athleteSession = await athlete.call('/api/pilot/auth/session', { method: 'POST', body: {} });
  assertAthleteSession(athleteSession);

  const athleteRead = await athlete.call('/api/pilot/athletes/get', {
    method: 'POST',
    body: { athlete_id: athleteId },
  });
  if (!athleteRead.found) {
    throw new Error('Athlete cannot retrieve persisted profile');
  }

  console.log('11) Verify guardian retrieval permissions');
  // A parent cannot sign in with a PIN -- PIN sessions are athlete-only -- so
  // the guardian is authenticated the same way the administrator is.
  //
  // This will refuse while the promotion step above still provisions guardians
  // through createParentAccount, which writes a local PIN account. Such an
  // account cannot hold a session at all: resolvePrincipal revokes any
  // ppbf_local non-athlete session on sight. mintGateSession reports that
  // precisely rather than letting it surface as an unexplained 401, and the
  // gate will pass once guardians are provisioned through the Microsoft invite
  // path that 'parent' is already listed for in INVITABLE_STAFF_ROLES.
  const guardianSession = await mintGateSession({
    connectionString,
    accountId: guardianAccountId,
    expectedRole: 'parent',
  });
  sessionsToRevoke.push(guardianSession);
  guardian = createClient('shadow-guardian', guardianSession.cookie);

  const guardianDomain = await guardian.call('/api/pilot/intake/domain-get', {
    method: 'POST',
    body: { athlete_id: athleteId },
  });
  if (!guardianDomain.guardians?.length) {
    throw new Error('Guardian retrieval verification failed');
  }

  console.log('SHADOW INTAKE GATE PASS');
  console.log(
    JSON.stringify(
      {
        intake_case_id: intakeCaseId,
        athlete_id: athleteId,
        guardian_parent_id: guardianParentId,
        uploaded_documents: uploaded,
      },
      null,
      2,
    ),
  );
}

try {
  await run();
} catch (error) {
  console.error('SHADOW INTAKE GATE FAIL');
  console.error(String(error));
  process.exit(1);
} finally {
  // Runs on success and on failure alike. A gate that fails partway through is
  // exactly the case where a live administrator session must not be left
  // behind, so revocation failures are reported rather than thrown -- they must
  // not mask the original error or turn a passing gate into a failing one.
  for (const session of sessionsToRevoke) {
    try {
      await session.revoke();
    } catch (revokeError) {
      console.error(`WARNING: could not revoke a gate session: ${String(revokeError)}`);
    }
  }
}
