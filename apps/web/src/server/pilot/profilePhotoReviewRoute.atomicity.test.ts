import { NextRequest } from 'next/server';

import { POST } from '@/app/api/pilot/profile/photo/review/route';
import { deletePilotProfilePhoto } from '@/src/server/pilot/blob';
import { query, queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  assertViewerMayReachSubject,
  getSubjectIdentity,
  resolveRelationship,
} from '@/src/server/pilot/profileDb';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';

/**
 * THE DECISION AND THE PHOTOGRAPH IT WAS MADE ABOUT MUST COMMIT TOGETHER.
 *
 * This route is the human appropriateness review for a portrait of a child.
 * It reads the row, a person looks at the picture, and then it writes the
 * decision -- and until the guard these tests pin, nothing tied the write to
 * what the read had found. A member may replace their portrait at any moment
 * (setPhoto rewrites the bytes and sends the row back to 'pending_review'),
 * so the gap between the two is a real window with a real actor in it.
 *
 * WHY IT IS NOT NEXT TO THE ROUTE. profileIdentity.privacy.test.ts walks
 * EVERY .ts file under app/api/pilot/profile and requires each one that names
 * writePilotAuditEvent to carry an audited `details` block -- a source-level
 * privacy guard that a test file placed in that tree would trip on without
 * being a route at all. The guard is right and stays untouched; the test
 * lives here instead and reaches the route by path alias.
 *
 * getSubjectIdentity / assertViewerMayReachSubject / resolveRelationship are
 * mocked -- they read athletes, accounts and guardian_links, which are not
 * what is under test. releasePhoto, clearPhoto and getAccountProfile are the
 * REAL functions: what is being proven is the SQL those emit, so replacing
 * them would prove nothing at all. They run against the row emulator below.
 */
jest.mock('@/src/server/pilot/profileDb', () => {
  const actual = jest.requireActual('@/src/server/pilot/profileDb');
  return {
    ...actual,
    getSubjectIdentity: jest.fn(),
    assertViewerMayReachSubject: jest.fn(),
    resolveRelationship: jest.fn(),
  };
});

jest.mock('@/src/server/pilot/blob', () => ({
  deletePilotProfilePhoto: jest.fn(),
}));

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockGetSubjectIdentity = jest.mocked(getSubjectIdentity);
const mockAssertReach = jest.mocked(assertViewerMayReachSubject);
const mockResolveRelationship = jest.mocked(resolveRelationship);
const mockDeleteBlob = jest.mocked(deletePilotProfilePhoto);
const mockAudit = jest.mocked(writePilotAuditEvent);
// `as jest.Mock` rather than jest.mocked: both are generic and the emulator
// returns one concrete row shape. Same pattern the sibling
// admin/portrait-review route test uses.
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

/* ----------------------------------------------------- THE ROW EMULATOR -- */

/**
 * One pilot.account_profiles row, and a faithful-enough evaluator for the
 * statements profileDb sends at it on this path.
 *
 * The evaluator reads the guards OUT OF THE SQL the module actually emitted
 * rather than assuming which ones are there: a statement with no
 * photo_review_state / photo_uploaded_at predicate matches unconditionally,
 * exactly as Postgres would. That is the whole point -- a version of
 * profileDb that drops a guard must make these tests fail, not quietly pass
 * because the harness applied a guard the code no longer sends.
 */
interface ProfileRow {
  organization_id: string;
  account_id: string;
  display_nickname: string | null;
  nickname_cleared_at: string | null;
  corner: string;
  program: string;
  photo_blob_path: string | null;
  photo_content_type: string | null;
  photo_review_state: string;
  photo_uploaded_at: string | null;
  photo_reviewed_by_account_id: string | null;
}

const ORG = 'org-a';
const SUBJECT = 'acct-athlete';
const FIRST_UPLOAD_AT = '2026-08-10 09:00:00.123456+00';
const REPLACEMENT_UPLOAD_AT = '2026-08-10 09:00:04.987654+00';

let row: ProfileRow;
/** Runs once, immediately after the route's profile SELECT returns -- the
 * member's replacement upload committing in the gap. */
let onProfileRead: (() => void) | null = null;
/** Every statement the emulator saw, so a test can assert ordering. */
let statements: string[];

function seedRow(overrides: Partial<ProfileRow> = {}): void {
  row = {
    organization_id: ORG,
    account_id: SUBJECT,
    display_nickname: null,
    nickname_cleared_at: null,
    corner: 'none',
    program: 'unstated',
    photo_blob_path: 'portrait/org-a/acct-athlete/portrait.jpg',
    photo_content_type: 'image/jpeg',
    photo_review_state: 'pending_review',
    photo_uploaded_at: FIRST_UPLOAD_AT,
    photo_reviewed_by_account_id: null,
    ...overrides,
  };
}

/** The member replaces their portrait: new bytes, new identity, and setPhoto
 * sends the row straight back to 'pending_review'. */
function replacementUploadCommits(): void {
  row.photo_blob_path = 'portrait/org-a/acct-athlete/portrait.png';
  row.photo_content_type = 'image/png';
  row.photo_uploaded_at = REPLACEMENT_UPLOAD_AT;
  row.photo_review_state = 'pending_review';
  row.photo_reviewed_by_account_id = null;
}

function guardsSatisfied(sql: string, params: unknown[]): boolean {
  if (row.organization_id !== params[0] || row.account_id !== params[1]) return false;
  if (/photo_blob_path is not null/.test(sql) && row.photo_blob_path === null) return false;

  const stateGuard = /and photo_review_state = \$(\d+)/.exec(sql);
  if (stateGuard && row.photo_review_state !== params[Number(stateGuard[1]) - 1]) return false;

  const identityGuard = /and photo_uploaded_at = \$(\d+)/.exec(sql);
  if (identityGuard) {
    const expected = params[Number(identityGuard[1]) - 1] ?? null;
    if ((row.photo_uploaded_at ?? null) !== expected) return false;
  }
  return true;
}

function installEmulator(): void {
  statements = [];

  mockQueryOne.mockImplementation(async (sql: string, params: unknown[] = []) => {
    statements.push(sql);
    if (!/select[\s\S]*from pilot\.account_profiles/.test(sql)) {
      throw new Error(`Unexpected SQL through db.queryOne: ${sql}`);
    }
    const found = row.organization_id === params[0] && row.account_id === params[1]
      ? { ...row }
      : null;
    const hook = onProfileRead;
    onProfileRead = null;
    hook?.();
    return found;
  });

  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    statements.push(sql);
    if (!/update pilot\.account_profiles/.test(sql)) {
      throw new Error(`Unexpected SQL through db.query: ${sql}`);
    }
    if (!guardsSatisfied(sql, params)) return [];

    if (/photo_review_state = 'released'/.test(sql)) {
      row.photo_review_state = 'released';
      row.photo_reviewed_by_account_id = params[2] as string;
    } else {
      row.photo_blob_path = null;
      row.photo_content_type = null;
      row.photo_review_state = params[2] as string;
      row.photo_reviewed_by_account_id = params[3] as string | null;
    }
    return [{ account_id: row.account_id }];
  });
}

function coach() {
  return { accountId: 'acct-coach', role: 'coach', organizationId: ORG, athleteId: null } as never;
}

function decisionRequest(decision: string): NextRequest {
  return new NextRequest('https://ppbf.example/api/pilot/profile/photo/review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account_id: SUBJECT, decision }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  seedRow();
  onProfileRead = null;
  installEmulator();
  mockRequirePrincipal.mockResolvedValue(coach());
  mockGetSubjectIdentity.mockResolvedValue({
    accountId: SUBJECT,
    fullName: 'Sample Athlete',
    athleteId: 'ath-1',
    dob: '2014-03-02',
    coachAccountId: 'acct-coach',
    memberSince: null,
  });
  mockAssertReach.mockResolvedValue(undefined);
  mockResolveRelationship.mockResolvedValue('coach_of_subject');
  mockAudit.mockResolvedValue(undefined as never);
});

describe('POST /api/pilot/profile/photo/review -- the decision is bound to the photograph', () => {
  test('with nothing racing it, a release lands and the reviewer is recorded', async () => {
    const response = await POST(decisionRequest('release'));

    expect(response.status).toBe(200);
    expect(row.photo_review_state).toBe('released');
    expect(row.photo_reviewed_by_account_id).toBe('acct-coach');
  });

  test('a replacement uploaded between the read and the write LOSES: the never-seen photograph is not released', async () => {
    // The exact interleaving: the reviewer looked at the first portrait, and
    // the member's replacement commits while this request is still in flight.
    onProfileRead = replacementUploadCommits;

    const response = await POST(decisionRequest('release'));

    // The end state is what matters. Before the guard, the UPDATE named only
    // the account, so it matched the replacement row and flipped a
    // photograph nobody has ever looked at to 'released' -- which
    // decidePortrait then shows to this minor's coaches and guardians, with
    // this reviewer's name on it.
    expect(row.photo_review_state).toBe('pending_review');
    expect(row.photo_reviewed_by_account_id).toBeNull();
    expect(row.photo_uploaded_at).toBe(REPLACEMENT_UPLOAD_AT);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'This portrait changed before your decision was recorded. Reload and look at it again.',
    });
    // A decision that did not land must not be recorded as one that did.
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a replacement uploaded between the read and the write LOSES a block too -- no bytes are destroyed and the row keeps its photo', async () => {
    onProfileRead = replacementUploadCommits;

    const response = await POST(decisionRequest('block'));

    expect(response.status).toBe(409);
    // Before the guard this deleted the blob the reviewer had read while the
    // row was nulled out from under the replacement -- stranding the
    // never-reviewed bytes in the container with nothing referencing them
    // and no path left that could ever remove them.
    expect(mockDeleteBlob).not.toHaveBeenCalled();
    expect(row.photo_blob_path).toBe('portrait/org-a/acct-athlete/portrait.png');
    expect(row.photo_review_state).toBe('pending_review');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('an uncontested block clears the row FIRST and only then deletes the bytes', async () => {
    const response = await POST(decisionRequest('block'));

    expect(response.status).toBe(200);
    expect(row.photo_review_state).toBe('blocked');
    expect(row.photo_blob_path).toBeNull();
    expect(mockDeleteBlob).toHaveBeenCalledWith('portrait/org-a/acct-athlete/portrait.jpg');
    // Ordering, not just occurrence: deleting before the compare-and-set
    // means a reviewer who LOSES the race has already destroyed a photograph
    // the winning decision is still using.
    expect(mockQuery.mock.invocationCallOrder).toHaveLength(1);
    expect(mockDeleteBlob.mock.invocationCallOrder[0])
      .toBeGreaterThan(mockQuery.mock.invocationCallOrder[0]);
  });

  test('the write actually carries both halves of the guard -- state AND photo identity', async () => {
    await POST(decisionRequest('release'));

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // Asserted on the emitted SQL so the emulator above cannot be the only
    // thing enforcing the guard: a vacuous predicate would fail here.
    expect(sql).toMatch(/and photo_review_state = \$\d+/);
    expect(sql).toMatch(/and photo_uploaded_at = \$\d+/);
    expect(params).toContain('pending_review');
    expect(params).toContain(FIRST_UPLOAD_AT);
    expect(statements.length).toBeGreaterThan(1);
  });

  test('a decision that already landed elsewhere loses cleanly rather than overwriting it', async () => {
    // Another reviewer blocked this portrait while this request was in
    // flight: the row is no longer the one this reviewer read.
    onProfileRead = () => {
      row.photo_review_state = 'blocked';
      row.photo_blob_path = null;
      row.photo_reviewed_by_account_id = 'acct-other-coach';
    };

    const response = await POST(decisionRequest('release'));

    expect(response.status).toBe(409);
    expect(row.photo_review_state).toBe('blocked');
    expect(row.photo_reviewed_by_account_id).toBe('acct-other-coach');
  });
});
