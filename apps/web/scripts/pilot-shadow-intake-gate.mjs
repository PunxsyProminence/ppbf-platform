/*
  SHADOW Intake mandatory gate:
  - Upload real PDFs for required document classes
  - Persist to Blob + shadow_intake + intake case/doc tables
  - Human security review of each document (the producer of the
    scanned+extracted state approval requires; unreviewed approval must
    still be refused, and a signed read link must open the document)
  - Approve + promote to domain records
  - Verify retrieval and audit trail
  - Verify SHADOW chat answers live (both sync tiers, then the background
    worker's full enqueue -> drain -> render cycle)
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

const athleteAccountId = process.env.PILOT_SHADOW_ATHLETE_ACCOUNT_ID || '';
const athletePin = process.env.PILOT_SHADOW_ATHLETE_PIN || '';
const athleteId = process.env.PILOT_SHADOW_ATHLETE_ID || '';
const guardianAccountId = process.env.PILOT_SHADOW_GUARDIAN_ACCOUNT_ID || '';
const guardianEmail = process.env.PILOT_SHADOW_GUARDIAN_EMAIL || 'guardian@example.org';
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
  // PILOT_ORG_A_NAME was required here but never read by anything below --
  // requiring it only made the gate harder to wire, so it is gone.
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

// One retry, and only on 'filtered': the response safety filter withholds an
// answer over phrasing (an uncited "research shows..." or a percentage), and a
// reasoning model's phrasing varies run to run, so a single filtered answer is
// weak evidence of a real regression. 'degraded' is never retried -- that is
// the model call itself failing, and it fails the gate on the first sight.
// Two consecutive filtered answers fail the gate: at that rate real users are
// seeing withheld answers too, which is a product problem, not gate noise.
async function askShadowChatExpectingAnswer(client, label, body) {
  let chat = await client.call('/api/pilot/shadow/chat', { method: 'POST', body });
  if (chat.state === 'filtered') {
    console.log(`   ${label}: answer was filtered once (phrasing); retrying to distinguish noise from regression.`);
    chat = await client.call('/api/pilot/shadow/chat', { method: 'POST', body });
  }
  assertShadowChatAnswered(label, chat);
  return chat;
}

function assertShadowChatAnswered(label, chat) {
  // 'degraded' is the state the chat route reports when the model call fails
  // or times out -- the exact failure mode that shipped to production when a
  // 15s provider timeout sat under models that need 33-95s. A degraded reply
  // still returns HTTP 200 with polite text, so checking success alone would
  // pass a gate whose entire purpose is to catch this.
  if (chat.success !== true || chat.state !== 'ok') {
    throw new Error(
      `SHADOW chat (${label}) did not produce a generated answer: `
      + `success=${chat.success} state=${chat.state} error=${chat.error ?? 'none'}`,
    );
  }
  if (typeof chat.response !== 'string' || chat.response.trim().length < 40) {
    throw new Error(`SHADOW chat (${label}) returned an implausibly short answer: ${JSON.stringify(chat.response)}`);
  }
}

// Step 14's poll budget. Worst case for one clean pass: the worker's default
// 30s tick to claim the job, the 120s staging provider timeout for the model
// call, then validation and persistence. 300s covers that with margin; a job
// still pending at the deadline means the flag is set but the worker loop is
// not draining, which is exactly the regression this step exists to catch.
const BACKGROUND_JOB_TIMEOUT_MS = 300_000;
const BACKGROUND_POLL_INTERVAL_MS = 5_000;

const BACKGROUND_HEAVY_BAG_QUESTION = 'Plan a four-station heavy bag circuit for a 60-minute youth class, '
  + 'with a coaching cue and a common fault to watch for at each station.';

async function runBackgroundHeavyBagOnce(admin) {
  const queued = await admin.call('/api/pilot/shadow/chat', {
    method: 'POST',
    body: {
      message: BACKGROUND_HEAVY_BAG_QUESTION,
      tier: 'heavy_bag',
      preferAsync: true,
    },
  });

  // A state of 'ok' here means the route answered synchronously: preferAsync
  // only queues when PPBF_SHADOW_WORKER_ENABLED is 'true' on the deployed
  // revision, so a sync answer is an env-var regression, not a chat failure.
  if (queued.state !== 'queued' || queued.async !== true || !queued.jobId || !queued.conversationId) {
    throw new Error(
      'Background Heavy Bag did not queue: '
      + `state=${queued.state} async=${queued.async} jobId=${queued.jobId ?? 'none'} `
      + `conversationId=${queued.conversationId ?? 'none'}. `
      + 'A synchronous answer here means PPBF_SHADOW_WORKER_ENABLED is not set on the app.',
    );
  }

  const deadline = Date.now() + BACKGROUND_JOB_TIMEOUT_MS;
  let job = await admin.call(`/api/pilot/shadow/jobs/${queued.jobId}`);
  while (job.status === 'pending' || job.status === 'running') {
    if (Date.now() >= deadline) {
      throw new Error(
        `Background Heavy Bag job ${queued.jobId} was still '${job.status}' after `
        + `${BACKGROUND_JOB_TIMEOUT_MS / 1000}s. The queue accepted the job but the worker `
        + 'never finished it -- check the container logs for the instrumentation worker loop.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, BACKGROUND_POLL_INTERVAL_MS));
    job = await admin.call(`/api/pilot/shadow/jobs/${queued.jobId}`);
  }

  // 'failed' and 'cancelled' fail on first sight, like 'degraded' does on the
  // sync path: both mean the execution itself broke, not that phrasing tripped
  // the safety filter.
  if (job.status !== 'completed') {
    throw new Error(
      `Background Heavy Bag job ${queued.jobId} ended '${job.status}': ${job.error ?? 'no error code'}`,
    );
  }

  return { queued, job };
}

async function assertBackgroundHeavyBagRendered(admin, queued, job) {
  const output = job.output ?? {};
  if (output.responseState !== 'ok') {
    throw new Error(
      `Background Heavy Bag completed but its answer was '${output.responseState}': `
      + 'two consecutive filtered answers mean real users are seeing withheld answers too.',
    );
  }
  if (typeof output.response !== 'string' || output.response.trim().length < 40) {
    throw new Error(`Background Heavy Bag returned an implausibly short answer: ${JSON.stringify(output.response)}`);
  }
  if (!output.assistantMessageId || output.conversationId !== queued.conversationId) {
    throw new Error(
      'Background Heavy Bag output is missing its conversation binding: '
      + `assistantMessageId=${output.assistantMessageId ?? 'none'} `
      + `conversationId=${output.conversationId ?? 'none'} expected=${queued.conversationId}`,
    );
  }

  // The poll payload alone proves the processor ran. The answer must ALSO read
  // back through the sessions API, because that is what the chat page renders
  // when the user returns to the conversation -- an answer that completes but
  // never renders is the 'merged but never worked' failure mode.
  const history = await admin.call(`/api/pilot/shadow/sessions/${queued.conversationId}?limit=50`);
  const messages = Array.isArray(history.messages) ? history.messages : [];
  const rendered = messages.find((m) => m.messageId === output.assistantMessageId);
  if (!rendered || rendered.role !== 'assistant' || rendered.content !== output.response) {
    throw new Error('Background Heavy Bag answer is not readable back through the sessions API.');
  }
  const question = messages.find((m) => m.role === 'user' && m.content === BACKGROUND_HEAVY_BAG_QUESTION);
  if (!question) {
    throw new Error('Background Heavy Bag conversation is missing the user question persisted at enqueue.');
  }
  const outputCitations = Array.isArray(output.citations) ? output.citations : [];
  const renderedCitations = Array.isArray(rendered.citations) ? rendered.citations : [];
  if (renderedCitations.length !== outputCitations.length || rendered.evidenceTier !== output.evidenceTier) {
    throw new Error(
      'Background Heavy Bag citations diverge between job output and rendered message: '
      + `output ${outputCitations.length} (${output.evidenceTier}), `
      + `rendered ${renderedCitations.length} (${rendered.evidenceTier}).`,
    );
  }
  return { citationCount: renderedCitations.length };
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

  console.log('4) Review each document, then approve case');
  // The KNOWN GAP that lived here (runs 30499019009 onward): approval requires
  // every document scanned clean and extraction-ready, a state nothing could
  // produce because the scanner assumed by #17 was never built. The producer
  // now exists -- the human review route (document-review) -- so the full
  // path runs. The refusal is still asserted FIRST, deliberately: if approval
  // ever succeeds on unreviewed documents, the security gate has stopped
  // enforcing, and that must fail this step loudly rather than let the
  // review quietly become decorative.
  let refusedBeforeReview = false;
  try {
    await admin.call('/api/pilot/intake/review-action', {
      method: 'POST',
      body: {
        intake_case_id: intakeCaseId,
        action: 'approve',
        notes: 'Gate approval attempt before document review',
      },
    });
  } catch (error) {
    if (String(error).includes('intake documents must pass security scanning and extraction')) {
      refusedBeforeReview = true;
    } else {
      throw error;
    }
  }
  if (!refusedBeforeReview) {
    throw new Error('Approval succeeded with unreviewed documents -- the intake security gate is not enforcing.');
  }

  // The reviewer must be able to open what they attest to; a signed read
  // link for the first document proves the seeing half of review works.
  const documentLink = await admin.call('/api/pilot/intake/document-link', {
    method: 'POST',
    body: { intake_document_id: uploaded[0].intake_document_id },
  });
  if (typeof documentLink.url !== 'string' || !documentLink.url.includes('?')) {
    throw new Error('Document link did not return a signed read URL');
  }

  for (const doc of uploaded) {
    const review = await admin.call('/api/pilot/intake/document-review', {
      method: 'POST',
      body: {
        intake_document_id: doc.intake_document_id,
        decision: 'clean',
        notes: 'Gate review: generated fixture PDF, contents as expected.',
      },
    });
    if (review.ready_for_review !== true) {
      throw new Error(`Document ${doc.intake_document_id} is not ready for approval after a clean review`);
    }
  }

  await admin.call('/api/pilot/intake/review-action', {
    method: 'POST',
    body: {
      intake_case_id: intakeCaseId,
      action: 'approve',
      notes: 'Gate approval after document review',
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
          full_name: 'Gate Guardian',
          phone: '555-0102',
          // The guardian's login identity. Promotion provisions a
          // Microsoft-authenticated 'parent' account from this; a PIN is
          // rejected, because a PIN account cannot sign in as a guardian.
          email: guardianEmail,
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

  // Promotion does NOT leave a usable credential, and that is deliberate on
  // the product side: createOrUpdateAthleteAccount writes pin_hash = null and
  // active_flag = false, so a promoted athlete exists but cannot sign in until
  // an administrator activates them. Verified on staging after the first run
  // with the KNOWN GAP closed -- the account was present with
  // active_flag=false, pin_hash null, and step 10 failed 401.
  //
  // NOTE for the auth backlog, not fixed here: the promotion payload accepts
  // athlete.pin and silently discards it. createOrUpdateAthleteAccount takes
  // it as a parameter literally named organizationIdOrLegacyPin and never
  // uses it, yet the request returns success -- so a caller believes it set a
  // credential that was never written. The guardian branch of this same route
  // handles the equivalent case correctly by throwing "Unsupported
  // guardian.pin ...". The athlete branch should either honour the PIN (with
  // must_change_pin = true, since an admin typed it) or refuse it as loudly.
  //
  // Activating here is not a workaround: it is the real administrative flow a
  // promoted athlete goes through, so the gate now covers promote -> activate
  // -> sign in rather than assuming promotion alone produces a login.
  console.log('9b) Activate the promoted athlete (real admin flow)');
  await admin.call('/api/pilot/admin/accounts/pin-reset', {
    method: 'POST',
    body: { account_id: athleteAccountId, pin: athletePin, mode: 'activate' },
  });

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
  // the guardian is authenticated the same way the administrator is. The
  // promotion step above provisioned this account through the Microsoft staff
  // path, so it can hold a session.
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

  // Steps 12-13 exercise the two SHADOW chat tiers end to end -- session,
  // capability check, context build, live model call, and the provider
  // timeout. Nothing else in CI proves the deployed app can actually get an
  // answer out of Azure AI; the intake steps above never call the model.
  console.log('12) Verify SHADOW chat Quick Round answers (athlete)');
  const quickChat = await askShadowChatExpectingAnswer(athlete, 'quick round / athlete', {
    message: 'What is one good warm-up before working the heavy bag, and why does it help?',
  });

  console.log('13) Verify SHADOW chat Heavy Bag answers (administrator)');
  // Heavy Bag runs synchronously against a reasoning deployment measured at
  // ~95s on a representative prompt (see shadowRouter.ts), so this step is
  // expected to take one to three minutes. fetch() has no default timeout in
  // Node, so the wait is bounded by the app's own provider timeout.
  const heavyChat = await askShadowChatExpectingAnswer(admin, 'heavy bag / administrator', {
    message: 'An athlete is strong on the bag but loses composure in the third round of sparring. '
      + 'Give a focused two-week plan a volunteer coach could run, with one measurable checkpoint per week.',
    tier: 'heavy_bag',
  });

  console.log('14) Verify background Heavy Bag completes through the job worker (administrator)');
  // Step 13 proves the model can answer; this step proves the deployment's
  // async spine: enqueue (question persisted immediately, job queued with the
  // evidence snapshot), drain (the instrumentation-started worker claims and
  // executes under the actor's re-validated authority), render (answer and
  // citations readable back through the sessions API). Nothing else in CI runs
  // this cycle against a deployed revision, and the production worker flag
  // only flips once this step has passed on staging. Filtered answers get the
  // same one-retry policy as the sync steps above.
  let background = await runBackgroundHeavyBagOnce(admin);
  if (background.job.output?.responseState === 'filtered') {
    console.log('   background heavy bag: answer was filtered once (phrasing); retrying to distinguish noise from regression.');
    background = await runBackgroundHeavyBagOnce(admin);
  }
  const backgroundRender = await assertBackgroundHeavyBagRendered(admin, background.queued, background.job);

  console.log('15) Film Study measurement diagnostic (records numbers; asserts nothing yet)');
  // #103 orders measured facts before the film_study executor exists:
  // in-container ffmpeg timing and one real vision call. The diagnostic
  // route answers only where PPBF_FILM_STUDY_DIAGNOSTIC_ENABLED is set
  // (staging), so this step self-detects -- 403/404 means the flag or route
  // is absent on this revision, recorded and skipped. The step never fails
  // the gate, because there is no product behavior to assert until the
  // executor ships; but a failure WITH the flag on is printed loudly, since
  // it means the measurement machinery itself is broken on the deployed
  // revision.
  let filmStudyDiagnostic;
  try {
    const diag = await admin.call('/api/pilot/shadow/film-study/diagnostic', {
      method: 'POST',
      body: { vision_frames: 3 },
    });
    filmStudyDiagnostic = {
      enabled: true,
      ffmpeg: diag.ffmpeg ?? null,
      vision: diag.vision ?? null,
    };
    const visionSummary = diag.vision?.attempted
      ? (diag.vision.ok
        ? `vision ok in ${diag.vision.latency_ms}ms (prompt ${diag.vision.prompt_tokens} / completion ${diag.vision.completion_tokens} / reasoning ${diag.vision.reasoning_tokens} tokens)`
        : `vision FAILED: ${diag.vision.error}`)
      : 'vision not attempted (deployment unconfigured)';
    console.log(`   film study: synthesize ${diag.ffmpeg?.synthesize_ms}ms, extract ${diag.ffmpeg?.extract_ms}ms for ${diag.ffmpeg?.frame_count} frames; ${visionSummary}`);
  } catch (error) {
    const status = Number(/failed \((\d{3})\)/.exec(String(error))?.[1] ?? 0);
    if (status === 403 || status === 404) {
      filmStudyDiagnostic = { enabled: false, status };
      console.log(`   film study diagnostic not enabled on this revision (${status}); skipping.`);
    } else {
      filmStudyDiagnostic = { enabled: true, error: String(error).slice(0, 300) };
      console.error('   FILM STUDY DIAGNOSTIC FAILED (gate continues; measurement missing):');
      console.error(`   ${String(error).slice(0, 300)}`);
    }
  }

  console.log('SHADOW INTAKE GATE PASS');
  console.log(
    JSON.stringify(
      {
        intake_case_id: intakeCaseId,
        athlete_id: athleteId,
        guardian_parent_id: guardianParentId,
        uploaded_documents: uploaded,
        promotion_tested: true,
        shadow_chat: {
          quick_round: quickChat.state,
          heavy_bag: heavyChat.state,
          background_heavy_bag: background.job.output?.responseState ?? 'unknown',
        },
        background_heavy_bag: {
          job_id: background.queued.jobId,
          conversation_id: background.queued.conversationId,
          assistant_message_id: background.job.output?.assistantMessageId ?? null,
          citations: backgroundRender.citationCount,
          evidence_tier: background.job.output?.evidenceTier ?? null,
        },
        film_study_diagnostic: filmStudyDiagnostic,
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
