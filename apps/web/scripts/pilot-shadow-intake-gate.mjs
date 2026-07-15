/*
  SHADOW Intake mandatory gate:
  - Upload real PDFs for required document classes
  - Persist to Blob + shadow_intake + intake case/doc tables
  - Approve + promote to domain records
  - Verify retrieval and audit trail
*/

/* eslint-disable sonarjs/cognitive-complexity */

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import PDFDocument from 'pdfkit';

const baseUrl = process.env.PILOT_GATE_BASE_URL || 'http://localhost:3000';
const bootstrapKey = process.env.PPBF_PILOT_BOOTSTRAP_KEY || '';
const adminAccountId = process.env.PILOT_ADMIN_ACCOUNT_ID || 'org_admin_shadow';
const adminPin = process.env.PILOT_ADMIN_PIN || '15715';
const organizationId = process.env.PILOT_ORG_A_ID || process.env.PPBF_PILOT_DEFAULT_ORG_ID || 'ppbf-default-org';
const organizationName = process.env.PILOT_ORG_A_NAME || 'PPBF Default Organization';

const athleteAccountId = process.env.PILOT_SHADOW_ATHLETE_ACCOUNT_ID || `shadow_athlete_${Date.now()}`;
const athletePin = process.env.PILOT_SHADOW_ATHLETE_PIN || '25725';
const athleteId = process.env.PILOT_SHADOW_ATHLETE_ID || `shadow-athlete-${Date.now()}`;
const guardianAccountId = process.env.PILOT_SHADOW_GUARDIAN_ACCOUNT_ID || `shadow_guardian_${Date.now()}`;
const guardianPin = process.env.PILOT_SHADOW_GUARDIAN_PIN || '35735';
const guardianParentId = process.env.PILOT_SHADOW_GUARDIAN_PARENT_ID || `parent-${Date.now()}`;

const documentMatrix = [
  { type: 'athlete_registration', title: 'Athlete Registration Packet' },
  { type: 'emergency_contact', title: 'Emergency Contact Form' },
  { type: 'medical_form', title: 'Medical Form' },
  { type: 'waiver_consent', title: 'Waiver Consent Form' },
  { type: 'assessment_document', title: 'Assessment Document' },
  { type: 'general_intake', title: 'General Intake Document' },
];

function createClient(name) {
  let cookieHeader = '';

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

async function maybeBootstrapAdmin() {
  if (!bootstrapKey) return;

  await fetch(`${baseUrl}/api/pilot/admin/bootstrap`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ppbf-bootstrap-key': bootstrapKey,
    },
    body: JSON.stringify({
      account_id: adminAccountId,
      pin: adminPin,
      organization_id: organizationId,
      organization_name: organizationName,
      bootstrap_role: 'organization_admin',
    }),
  });
}

async function run() {
  const admin = createClient('shadow-admin');
  const athlete = createClient('shadow-athlete');
  const guardian = createClient('shadow-guardian');

  await maybeBootstrapAdmin();

  console.log('1) Admin login');
  await admin.call('/api/pilot/auth/login', {
    method: 'POST',
    body: { account_id: adminAccountId, pin: adminPin },
  });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ppbf-shadow-intake-'));
  const uploaded = [];
  let intakeCaseId = '';

  console.log('2) Generate and upload required PDF document types');
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

  console.log('3) Verify review queue contains case');
  const queue = await admin.call('/api/pilot/intake/review-queue', { method: 'POST', body: {} });
  const queueContainsCase = queue.queue.some((item) => item.intake_case_id === intakeCaseId);
  if (!queueContainsCase) {
    throw new Error('Uploaded intake case not present in review queue');
  }

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

  if (!aggregate?.found) {
    throw new Error('Intake case aggregate not found');
  }

  const aggregateDocs = aggregate.aggregate?.documents || [];
  if (aggregateDocs.length < documentMatrix.length) {
    throw new Error(`Expected ${documentMatrix.length} documents in case aggregate, found ${aggregateDocs.length}`);
  }

  console.log('7) Verify domain retrieval endpoint');
  const domain = await admin.call('/api/pilot/intake/domain-get', {
    method: 'POST',
    body: { athlete_id: athleteId },
  });

  if (!domain.emergency_contacts?.length) throw new Error('Missing emergency_contacts persistence');
  if (!domain.medical_intake?.length) throw new Error('Missing medical_intake persistence');
  if (!domain.waivers?.length) throw new Error('Missing waivers persistence');
  if (!domain.assessments?.length) throw new Error('Missing assessments persistence');
  if (!domain.attendance?.length) throw new Error('Missing attendance persistence');
  if (!domain.readiness?.length) throw new Error('Missing readiness persistence');
  if (!domain.coach_observations?.length) throw new Error('Missing coach observations persistence');
  if (!domain.guardians?.length) throw new Error('Missing guardian linkage persistence');

  console.log('8) Verify audit trail exists');
  const audit = await admin.call('/api/pilot/audit/get', {
    method: 'POST',
    body: { entity_id: intakeCaseId, limit: 100 },
  });

  if (!audit.events?.some((row) => row.entity_type === 'intake_case_promotion')) {
    throw new Error('Missing intake_case_promotion audit event');
  }

  console.log('9) Verify athlete login and retrieval');
  await athlete.call('/api/pilot/auth/login', {
    method: 'POST',
    body: { account_id: athleteAccountId, pin: athletePin },
  });

  const athleteSession = await athlete.call('/api/pilot/auth/session', { method: 'POST', body: {} });
  if (!athleteSession.authenticated || athleteSession.athlete_id !== athleteId) {
    throw new Error('Athlete login/session verification failed');
  }

  const athleteRead = await athlete.call('/api/pilot/athletes/get', {
    method: 'POST',
    body: { athlete_id: athleteId },
  });
  if (!athleteRead.found) {
    throw new Error('Athlete cannot retrieve persisted profile');
  }

  console.log('10) Verify guardian login and retrieval permissions');
  await guardian.call('/api/pilot/auth/login', {
    method: 'POST',
    body: { account_id: guardianAccountId, pin: guardianPin },
  });

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
}
