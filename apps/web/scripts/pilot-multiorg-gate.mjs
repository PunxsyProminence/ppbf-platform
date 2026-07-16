/*
  Multi-organization mandatory gate:
  1) Bootstrap platform owner
  2) Create two organizations
  3) Bootstrap org admins
  4) Create duplicate athlete IDs in each org (must both succeed)
  5) Verify cross-org read isolation
  6) Verify platform owner can manage org status
*/

const baseUrl = process.env.PILOT_GATE_BASE_URL || 'http://localhost:3000';
const bootstrapKey = process.env.PPBF_PILOT_BOOTSTRAP_KEY || '';

const platformOwnerAccountId = process.env.PILOT_PLATFORM_OWNER_ACCOUNT_ID || '';
const platformOwnerPin = process.env.PILOT_PLATFORM_OWNER_PIN || '';

const orgAId = process.env.PILOT_ORG_A_ID || '';
const orgAName = process.env.PILOT_ORG_A_NAME || '';
const orgAAdminAccountId = process.env.PILOT_ORG_A_ADMIN_ACCOUNT_ID || '';
const orgAAdminPin = process.env.PILOT_ORG_A_ADMIN_PIN || '';

const orgBId = process.env.PILOT_ORG_B_ID || '';
const orgBName = process.env.PILOT_ORG_B_NAME || '';
const orgBAdminAccountId = process.env.PILOT_ORG_B_ADMIN_ACCOUNT_ID || '';
const orgBAdminPin = process.env.PILOT_ORG_B_ADMIN_PIN || '';

const sharedAthleteId = process.env.PILOT_SHARED_ATHLETE_ID || '';

function requireEnv(name, value) {
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

if (!bootstrapKey) {
  console.error('Missing PPBF_PILOT_BOOTSTRAP_KEY');
  process.exit(1);
}

try {
  requireEnv('PILOT_PLATFORM_OWNER_ACCOUNT_ID', platformOwnerAccountId);
  requireEnv('PILOT_PLATFORM_OWNER_PIN', platformOwnerPin);
  requireEnv('PILOT_ORG_A_ID', orgAId);
  requireEnv('PILOT_ORG_A_NAME', orgAName);
  requireEnv('PILOT_ORG_A_ADMIN_ACCOUNT_ID', orgAAdminAccountId);
  requireEnv('PILOT_ORG_A_ADMIN_PIN', orgAAdminPin);
  requireEnv('PILOT_ORG_B_ID', orgBId);
  requireEnv('PILOT_ORG_B_NAME', orgBName);
  requireEnv('PILOT_ORG_B_ADMIN_ACCOUNT_ID', orgBAdminAccountId);
  requireEnv('PILOT_ORG_B_ADMIN_PIN', orgBAdminPin);
  requireEnv('PILOT_SHARED_ATHLETE_ID', sharedAthleteId);
} catch (error) {
  console.error(String(error));
  process.exit(1);
}

function createClient(name) {
  let cookieHeader = '';

  return {
    async call(path, { method = 'GET', body, extraHeaders = {} } = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...extraHeaders,
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
        throw new Error(`${name}: ${method} ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
      }

      return payload;
    },

    async expectForbidden(path, body) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        body: JSON.stringify(body),
      });

      if (response.status !== 403) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(`${name}: expected 403 for ${path}, got ${response.status} with ${JSON.stringify(payload)}`);
      }
    },
  };
}

async function bootstrapAccount(accountId, pin, organizationId, organizationName, bootstrapRole) {
  const response = await fetch(`${baseUrl}/api/pilot/admin/bootstrap`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ppbf-bootstrap-key': bootstrapKey,
    },
    body: JSON.stringify({
      account_id: accountId,
      pin,
      organization_id: organizationId,
      organization_name: organizationName,
      bootstrap_role: bootstrapRole,
    }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(`bootstrap failed (${response.status}): ${JSON.stringify(payload)}`);
  }
}

async function createAthleteAsOrgAdmin(client, athleteId, coachId) {
  const nowIso = new Date().toISOString();
  await client.call('/api/pilot/athletes', {
    method: 'POST',
    body: {
      athlete_id: athleteId,
      full_name: `Athlete ${athleteId}`,
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
}

async function run() {
  const platformOwner = createClient('platform-owner');
  const orgAAdmin = createClient('org-a-admin');
  const orgBAdmin = createClient('org-b-admin');

  console.log('1) Bootstrap platform owner account');
  await bootstrapAccount(platformOwnerAccountId, platformOwnerPin, orgAId, orgAName, 'platform_owner');

  console.log('2) Login as platform owner');
  await platformOwner.call('/api/pilot/auth/login', {
    method: 'POST',
    body: { account_id: platformOwnerAccountId, pin: platformOwnerPin },
  });

  console.log('3) Create organizations');
  await platformOwner.call('/api/pilot/platform/organizations', {
    method: 'POST',
    body: { organization_id: orgAId, organization_name: orgAName },
  });
  await platformOwner.call('/api/pilot/platform/organizations', {
    method: 'POST',
    body: { organization_id: orgBId, organization_name: orgBName },
  });

  console.log('4) Bootstrap organization admins');
  await bootstrapAccount(orgAAdminAccountId, orgAAdminPin, orgAId, orgAName, 'organization_admin');
  await bootstrapAccount(orgBAdminAccountId, orgBAdminPin, orgBId, orgBName, 'organization_admin');

  console.log('5) Login as org admins');
  await orgAAdmin.call('/api/pilot/auth/login', {
    method: 'POST',
    body: { account_id: orgAAdminAccountId, pin: orgAAdminPin },
  });
  await orgBAdmin.call('/api/pilot/auth/login', {
    method: 'POST',
    body: { account_id: orgBAdminAccountId, pin: orgBAdminPin },
  });

  console.log('6) Create same athlete_id in both orgs (must both succeed)');
  await createAthleteAsOrgAdmin(orgAAdmin, sharedAthleteId, orgAAdminAccountId);
  await createAthleteAsOrgAdmin(orgBAdmin, sharedAthleteId, orgBAdminAccountId);

  console.log('7) Verify org-local reads');
  const orgARead = await orgAAdmin.call('/api/pilot/athletes/get', {
    method: 'POST',
    body: { athlete_id: sharedAthleteId },
  });
  if (!orgARead?.found) {
    throw new Error('Org A failed to read own athlete');
  }

  const orgBRead = await orgBAdmin.call('/api/pilot/athletes/get', {
    method: 'POST',
    body: { athlete_id: sharedAthleteId },
  });
  if (!orgBRead?.found) {
    throw new Error('Org B failed to read own athlete');
  }

  console.log('8) Verify platform owner cannot read organization-private athlete endpoint');
  await platformOwner.expectForbidden('/api/pilot/athletes/get', { athlete_id: sharedAthleteId });

  console.log('9) Toggle organization status');
  await platformOwner.call('/api/pilot/platform/organizations/status', {
    method: 'POST',
    body: { organization_id: orgBId, status: 'suspended' },
  });
  await platformOwner.call('/api/pilot/platform/organizations/status', {
    method: 'POST',
    body: { organization_id: orgBId, status: 'active' },
  });

  console.log('MULTI-ORG GATE PASS');
}

try {
  await run();
} catch (error) {
  console.error('MULTI-ORG GATE FAIL');
  console.error(String(error));
  process.exit(1);
}
