/*
  Mandatory gate runner:
  Create Athlete -> Create Goal -> Create Session -> Create Coach Review -> Logout -> Login -> Reload(session check)
*/

const baseUrl = process.env.PILOT_GATE_BASE_URL || 'http://localhost:3000';

const adminAccountId = process.env.PILOT_ADMIN_ACCOUNT_ID || '';
const adminPin = process.env.PILOT_ADMIN_PIN || '';
const bootstrapKey = process.env.PPBF_PILOT_BOOTSTRAP_KEY || '';
const athleteAccountId = process.env.PILOT_ATHLETE_ACCOUNT_ID || 'athlete_account_001';
const athletePin = process.env.PILOT_ATHLETE_PIN || '';

const athleteId = process.env.PILOT_ATHLETE_ID || 'athlete_001';
const coachId = process.env.PILOT_COACH_ID || adminAccountId || 'coach_001';
const goalId = process.env.PILOT_GOAL_ID || 'goal_001';
const sessionId = process.env.PILOT_SESSION_ID || 'session_001';
const reviewId = process.env.PILOT_REVIEW_ID || 'review_001';

if (!adminAccountId || !adminPin) {
  console.error('Missing PILOT_ADMIN_ACCOUNT_ID or PILOT_ADMIN_PIN for gate execution.');
  process.exit(1);
}

if (!athletePin) {
  console.error('Missing PILOT_ATHLETE_PIN for gate execution.');
  process.exit(1);
}

if (bootstrapKey) {
  console.log('Bootstrap mode enabled via PPBF_PILOT_BOOTSTRAP_KEY');
}

let cookieHeader = '';

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    cookieHeader = setCookie.split(';')[0];
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function maybeBootstrapAdmin() {
  if (!bootstrapKey) {
    return;
  }

  console.log('0) Bootstrap admin account');
  await fetch(`${baseUrl}/api/pilot/admin/bootstrap`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ppbf-bootstrap-key': bootstrapKey,
    },
    body: JSON.stringify({
      account_id: adminAccountId,
      pin: adminPin,
    }),
  });
}

const nowIso = new Date().toISOString();

async function run() {
  await maybeBootstrapAdmin();

  console.log('1) Admin login');
  await call('/api/pilot/auth/login', {
    method: 'POST',
    body: {
      account_id: adminAccountId,
      pin: adminPin,
    },
  });

  console.log('2) Create athlete account');
  await call('/api/pilot/admin/athlete-accounts', {
    method: 'POST',
    body: {
      account_id: athleteAccountId,
      athlete_id: athleteId,
      pin: athletePin,
    },
  });

  console.log('3) Create athlete');
  await call('/api/pilot/athletes', {
    method: 'POST',
    body: {
      athlete_id: athleteId,
      full_name: 'Pilot Athlete',
      dob: '2010-01-01',
      weight_class: '125',
      gym_status: 'active',
      emergency_contact: 'Parent 555-0100',
      active_flag: true,
      coach_id: coachId,
      created_at: nowIso,
      updated_at: nowIso,
    },
  });

  console.log('4) Create goal');
  await call('/api/pilot/goals', {
    method: 'POST',
    body: {
      goal_id: goalId,
      athlete_id: athleteId,
      title: 'Improve jab consistency',
      target_date: '2026-12-31',
      metric: 'land 70% in drills',
      status: 'active',
      created_at: nowIso,
      updated_at: nowIso,
    },
  });

  console.log('5) Create session');
  await call('/api/pilot/sessions', {
    method: 'POST',
    body: {
      session_id: sessionId,
      athlete_id: athleteId,
      date: '2026-07-13',
      rpe: 7,
      notes: 'Good technical session',
      completed_flag: true,
      created_at: nowIso,
      updated_at: nowIso,
    },
  });

  console.log('6) Create coach review');
  await call('/api/pilot/coach-reviews', {
    method: 'POST',
    body: {
      review_id: reviewId,
      session_id: sessionId,
      coach_id: coachId,
      decision: 'approved',
      notes: 'Progress on target',
      approved_flag: true,
      created_at: nowIso,
      updated_at: nowIso,
    },
  });

  console.log('7) Logout');
  await call('/api/pilot/auth/logout', {
    method: 'POST',
  });

  console.log('8) Athlete login');
  await call('/api/pilot/auth/login', {
    method: 'POST',
    body: {
      account_id: athleteAccountId,
      pin: athletePin,
    },
  });

  console.log('9) Reload/session check');
  const sessionCheck = await call('/api/pilot/auth/session', {
    method: 'POST',
  });

  if (!sessionCheck?.authenticated) {
    throw new Error('Session check did not return authenticated=true');
  }

  console.log('10) Verify athlete persistence');
  const athleteCheck = await call('/api/pilot/athletes/get', {
    method: 'POST',
    body: { athlete_id: athleteId },
  });

  if (!athleteCheck?.found || athleteCheck?.athlete?.athlete_id !== athleteId) {
    throw new Error('Athlete persistence verification failed');
  }

  console.log('11) Verify goal persistence and linkage');
  const goalCheck = await call('/api/pilot/goals/get', {
    method: 'POST',
    body: { goal_id: goalId },
  });

  if (!goalCheck?.found || goalCheck?.goal?.goal_id !== goalId || goalCheck?.goal?.athlete_id !== athleteId) {
    throw new Error('Goal persistence/link verification failed');
  }

  console.log('12) Verify session persistence and linkage');
  const sessionRecordCheck = await call('/api/pilot/sessions/get', {
    method: 'POST',
    body: { session_id: sessionId },
  });

  if (!sessionRecordCheck?.found || sessionRecordCheck?.session?.session_id !== sessionId || sessionRecordCheck?.session?.athlete_id !== athleteId) {
    throw new Error('Session persistence/link verification failed');
  }

  console.log('12.5) Re-auth as admin for coach review verification');
  await call('/api/pilot/auth/logout', {
    method: 'POST',
  });

  await call('/api/pilot/auth/login', {
    method: 'POST',
    body: {
      account_id: adminAccountId,
      pin: adminPin,
    },
  });

  console.log('13) Verify coach review persistence and linkage');
  const reviewCheck = await call('/api/pilot/coach-reviews/get', {
    method: 'POST',
    body: { review_id: reviewId },
  });

  if (
    !reviewCheck?.found ||
    reviewCheck?.review?.review_id !== reviewId ||
    reviewCheck?.review?.session_id !== sessionId ||
    reviewCheck?.athlete_id !== athleteId
  ) {
    throw new Error('Coach review persistence/link verification failed');
  }

  console.log('MANDATORY GATE PASS');
}

try {
  await run();
} catch (error) {
  console.error('MANDATORY GATE FAIL');
  console.error(String(error));
  process.exit(1);
}
