import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { GET } from './route';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import { query } from '@/src/server/pilot/db';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { ROSTER_EXPORT_COLUMNS, buildRosterCsv, escapeCsvField, rosterExportFilename } from './csv';

jest.mock('@/src/server/pilot/http', () => ({
  requireMicrosoftAuthenticatedPrincipal: jest.fn(),
  jsonError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Unauthorized')) return new Response(JSON.stringify({ error: message }), { status: 401 });
    if (message.startsWith('Forbidden')) return new Response(JSON.stringify({ error: message }), { status: 403 });
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 });
  },
}));

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockPrincipal = requireMicrosoftAuthenticatedPrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

// Values a caller must never receive. They are spelled out here rather than
// described, so the assertions below fail on the string itself.
const PIN = '481902';
const PIN_HASH = '$2b$12$notarealbcrypthashvaluehere';
const SESSION_TOKEN = 'ppbf-session-3f9a1c2b4d5e6f708192a3b4c5d6e7f8';

// The row the query is mocked to return carries the forbidden fields
// deliberately. The serializer reads named columns rather than the row's own
// keys, so a query that one day selects too much still cannot widen the file.
const ROW = {
  athlete_id: 'ath-001',
  full_name: 'Marisol Quinteros',
  date_of_birth: '2013-04-19',
  weight_class: 'bantamweight',
  gym_status: 'training',
  active: true,
  coach_account_id: 'coach@punxsyprominence.org',
  coach_email: 'coach@punxsyprominence.org',
  emergency_contact_note: 'Aunt, lives two streets over',
  emergency_contact_name: 'Rosa Quinteros',
  emergency_contact_relationship: 'aunt',
  emergency_contact_phone: '814-555-0142',
  emergency_contact_email: 'rosa@example.org',
  guardian_count: 2,
  guardians: 'Ana Quinteros (mother) 814-555-0101; Luis Quinteros (father) 814-555-0102',
  athlete_login_id: 'ath-001',
  athlete_login_active: true,
  created_at: '2026-07-02T14:03:11Z',
  updated_at: '2026-07-20T09:41:00Z',
  pin: PIN,
  pin_hash: PIN_HASH,
  must_change_pin: false,
  token_hash: SESSION_TOKEN,
  password: 'hunter2',
};

function adminSession(role = 'organization_admin') {
  return {
    accountId: 'admin@punxsyprominence.org',
    role,
    organizationId: 'org-ppbf',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/pilot/admin/export/roster', { method: 'GET' });
}

beforeEach(() => {
  mockQuery.mockResolvedValue([ROW]);
  mockAudit.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/admin/export/roster', () => {
  test('refuses a PIN-authenticated session', async () => {
    mockPrincipal.mockRejectedValueOnce(new Error('Forbidden: Microsoft-authenticated session required'));

    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('refuses a coach', async () => {
    mockPrincipal.mockResolvedValueOnce({ ...adminSession(), role: 'coach' });

    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('refuses the platform owner, who has no claim on one gym\'s children', async () => {
    mockPrincipal.mockResolvedValueOnce({ ...adminSession(), role: 'platform_owner' });

    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('refuses a board member, who is entitled to aggregates only', async () => {
    mockPrincipal.mockResolvedValueOnce({ ...adminSession(), role: 'board' });

    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('serves the roster to an organization admin as a named CSV download', async () => {
    mockPrincipal.mockResolvedValueOnce(adminSession());

    const response = await GET(makeRequest());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="ppbf-roster-org-ppbf-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(response.headers.get('x-roster-row-count')).toBe('1');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(body).toContain('Marisol Quinteros');
    expect(body).toContain('814-555-0142');
    expect(body).toContain('Ana Quinteros (mother)');
  });

  test('accepts the legacy admin role the way its siblings do', async () => {
    mockPrincipal.mockResolvedValueOnce(adminSession('admin'));

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
  });

  test('reads only the calling session\'s organization', async () => {
    mockPrincipal.mockResolvedValueOnce(adminSession());

    await GET(makeRequest());

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][1]).toEqual(['org-ppbf']);
  });

  test('records the export before returning the file', async () => {
    mockPrincipal.mockResolvedValueOnce(adminSession());

    const response = await GET(makeRequest());

    expect(mockAudit).toHaveBeenCalledTimes(1);
    const event = mockAudit.mock.calls[0][0];
    expect(event.entity_type).toBe('roster_export');
    expect(event.organization_id).toBe('org-ppbf');
    expect(event.actor_account_id).toBe('admin@punxsyprominence.org');
    expect(event.details.athlete_row_count).toBe(1);
    expect(event.details.format).toBe('csv');
    expect(event.entity_id).toBe(response.headers.get('x-roster-export-id'));
  });

  test('fails the export when it cannot be recorded', async () => {
    mockPrincipal.mockResolvedValueOnce(adminSession());
    mockAudit.mockRejectedValueOnce(new Error('audit_events insert failed'));

    const response = await GET(makeRequest());
    const body = await response.text();

    // An unrecorded export of forty children's records is the thing nobody can
    // answer for later, so it must not be a partial success.
    expect(response.status).toBe(500);
    expect(body).not.toContain('Marisol Quinteros');
  });

  test('returns headers and no rows for a gym with no athletes', async () => {
    mockPrincipal.mockResolvedValueOnce(adminSession());
    mockQuery.mockResolvedValueOnce([]);

    const response = await GET(makeRequest());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('x-roster-row-count')).toBe('0');
    expect(body.trim().split('\r\n')).toHaveLength(1);
  });
});

describe('the export carries no credential', () => {
  test('no PIN, PIN hash, session token or password reaches the file', async () => {
    mockPrincipal.mockResolvedValueOnce(adminSession());

    const response = await GET(makeRequest());
    const body = await response.text();

    for (const forbidden of [PIN, PIN_HASH, SESSION_TOKEN, 'hunter2']) {
      expect(body).not.toContain(forbidden);
    }
    expect(body).not.toMatch(/pin_hash|must_change_pin|token_hash|password|\bpin\b/i);
  });

  test('no exported column is a credential field', () => {
    for (const column of ROSTER_EXPORT_COLUMNS) {
      expect(column.key).not.toMatch(/pin|hash|token|password|secret/i);
    }
  });

  test('the roster query selects no credential column', () => {
    expect(rosterSql()).toContain('pilot.athletes');
    expect(rosterSql()).not.toMatch(/pin_hash|must_change_pin|session_tokens|token_hash|password/);
  });
});

// Reads the route source rather than the mocked call, so these assertions
// survive any future change to how the query is issued.
function rosterSql(): string {
  const source = fs.readFileSync(path.join(__dirname, 'route.ts'), 'utf8');
  return source.slice(source.indexOf('const ROSTER_QUERY'), source.indexOf('export async function GET'));
}

describe('the export cannot reach another gym', () => {
  test('the only parameter is the organization, and it filters the athletes', () => {
    const sql = rosterSql();

    expect(sql).toMatch(/where ath\.organization_id = \$1/);
    // A second placeholder would mean something other than the session decides
    // part of the scope.
    expect(sql).not.toContain('$2');
  });

  test('every table the query reads is constrained by organization', () => {
    // Two gyms can both use "ath-001" and both use "par-004". A join matched on
    // the athlete or parent id alone would hand one gym the other gym's
    // guardian, so every alias that touches a pilot table has to be constrained
    // on organization_id somewhere in the statement.
    const sql = rosterSql();
    const aliases = [...sql.matchAll(/(?:from|join)\s+pilot\.[a-z_]+\s+([a-z_]+)/gi)].map((match) => match[1]);

    expect(aliases.length).toBeGreaterThanOrEqual(6);
    for (const alias of aliases) {
      expect(sql).toContain(`${alias}.organization_id`);
    }
  });
});

describe('CSV serialization', () => {
  test('quotes every field and doubles embedded quotes', () => {
    expect(escapeCsvField('plain')).toBe('"plain"');
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('she said "no"')).toBe('"she said ""no"""');
    expect(escapeCsvField('line one\nline two')).toBe('"line one\nline two"');
  });

  test('renders an absent value as empty rather than as a word', () => {
    // An empty cell is the absence of a value. "N/A" or "unknown" would be a
    // placeholder the reader could mistake for something the gym recorded.
    expect(escapeCsvField(null)).toBe('""');
    expect(escapeCsvField(undefined)).toBe('""');
    expect(escapeCsvField(false)).toBe('"false"');
    expect(escapeCsvField(0)).toBe('"0"');
  });

  test('stops a stored value from executing when the file is opened', () => {
    expect(escapeCsvField('=1+1')).toBe('"\'=1+1"');
    expect(escapeCsvField('@SUM(A1)')).toBe('"\'@SUM(A1)"');
    expect(escapeCsvField('+1 814 555 0100')).toBe('"\'+1 814 555 0100"');
    expect(escapeCsvField('-5')).toBe('"\'-5"');
  });

  test('emits only the declared columns, whatever else a row carries', () => {
    const csv = buildRosterCsv([ROW]);
    const headerCount = csv.trim().split('\r\n')[0].split('","').length;

    expect(headerCount).toBe(ROSTER_EXPORT_COLUMNS.length);
    expect(csv).not.toContain(PIN_HASH);
    expect(csv.startsWith('\uFEFF')).toBe(true);
  });

  test('sanitizes the filename so an organization id cannot forge a header', () => {
    const filename = rosterExportFilename('org "evil"\r\nX-Injected: 1', new Date('2026-08-01T00:00:00Z'));

    expect(filename).toBe('ppbf-roster-org-evil-x-injected-1-2026-08-01.csv');
    expect(filename).not.toMatch(/["\r\n]/);
  });
});
