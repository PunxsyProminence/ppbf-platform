import { NextRequest } from 'next/server';

import { POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  assertViewerMayReachSubject,
  clearNickname,
  getSubjectIdentity,
  resolveRelationship,
} from '@/src/server/pilot/profileDb';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotRole } from '@/src/server/pilot/contracts';
import type { ProfileRelationship } from '@/src/server/pilot/profileVisibility';

/**
 * The ring-name takedown, from the server side.
 *
 * profileIdentity.ts declines to run a wordlist over children's ring names and
 * says why: a blocklist on a children's platform buys the wrong thing. What it
 * offers instead is this route -- "any of the athlete's assigned coaches, any
 * organization admin, and any linked guardian can clear a ring name outright,
 * immediately, with no appeal step and no queue". That sentence is the
 * platform's entire moderation answer for the field, and until now nothing
 * asserted that the route behind it admits those three and refuses everyone
 * else.
 *
 * requirePrincipal is faked and profileDb is stubbed, because what is under
 * test is the DECISION the route composes from them: role gate, reachability,
 * relationship, and the audit row it writes afterwards. The real access.ts and
 * the real http.ts are kept, so the 403 and the hidden 404 are the ones a
 * caller would actually receive.
 */
jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/profileDb', () => ({
  getSubjectIdentity: jest.fn(),
  assertViewerMayReachSubject: jest.fn(),
  resolveRelationship: jest.fn(),
  clearNickname: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetSubjectIdentity = getSubjectIdentity as jest.Mock;
const mockAssertViewerMayReachSubject = assertViewerMayReachSubject as jest.Mock;
const mockResolveRelationship = resolveRelationship as jest.Mock;
const mockClearNickname = clearNickname as jest.Mock;
const mockWriteAudit = writePilotAuditEvent as jest.Mock;

const ORGANIZATION = 'org-1';
const SUBJECT_ACCOUNT = 'acct-marisol';

/** The child whose ring name is being taken down. A minor, on purpose. */
const SUBJECT = {
  accountId: SUBJECT_ACCOUNT,
  fullName: 'Marisol Vance',
  athleteId: 'ATH-1',
  dob: '2012-03-04',
  coachAccountId: 'coach-alvarez@punxsyprominence.org',
  memberSince: '2025-09-01',
};

function principal(role: PilotRole, accountId: string): PilotPrincipal {
  return {
    accountId,
    role,
    organizationId: ORGANIZATION,
    athleteId: null,
    sessionToken: 'session-token',
    authProvider: 'ppbf_local',
    mustChangePin: false,
  };
}

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/pilot/profile/nickname/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Sets up one caller. `relationship` is what resolveRelationship answers for
 * them -- the single fact that separates a coach of record from a covering
 * coach, and a linked guardian from another family's parent.
 */
function callerIs(role: PilotRole, accountId: string, relationship: ProfileRelationship): void {
  mockRequirePrincipal.mockResolvedValue(principal(role, accountId));
  mockGetSubjectIdentity.mockResolvedValue(SUBJECT);
  mockAssertViewerMayReachSubject.mockResolvedValue(undefined);
  mockResolveRelationship.mockResolvedValue(relationship);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('who may take a ring name down', () => {
  it('admits the coach of record', async () => {
    callerIs('coach', SUBJECT.coachAccountId, 'coach_of_subject');

    const response = await POST(request({ account_id: SUBJECT_ACCOUNT }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    // The lock is reported so the screen that called this can tell the coach
    // what it did, instead of restating a constant of its own.
    expect(payload.locked_for_hours).toBe(72);
    expect(mockClearNickname).toHaveBeenCalledWith(
      ORGANIZATION,
      SUBJECT_ACCOUNT,
      SUBJECT.coachAccountId,
    );
  });

  it('admits a linked guardian, which is a decision and not an oversight', async () => {
    // The route's own header: a guardian "is responsible for the child, they
    // are the person most likely to recognise that a name is a problem, and
    // making them wait for a coach to be free is making them wait for
    // something they should not have to wait for."
    callerIs('parent', 'acct-parent-vance', 'guardian_of_subject');

    const response = await POST(request({ account_id: SUBJECT_ACCOUNT }));

    expect(response.status).toBe(200);
    expect(mockClearNickname).toHaveBeenCalledTimes(1);
  });

  it.each(['organization_admin', 'admin'] as const)(
    'admits %s on the role alone, with no direct relationship to the child',
    async (role) => {
      // An organization admin has no coach_id and no guardian link, so
      // resolveRelationship answers 'organization_staff' for them. The route
      // admits them by ROLE, which is what makes a takedown reachable when the
      // coach is unreachable and the family is not linked.
      callerIs(role, 'acct-admin', 'organization_staff');

      const response = await POST(request({ account_id: SUBJECT_ACCOUNT }));

      expect(response.status).toBe(200);
      expect(mockClearNickname).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses a coach who is not the coach of record, without saying so', async () => {
    // A covering coach under an active pilot.coach_coverage grant REACHES this
    // athlete -- assertViewerMayReachSubject passes for them -- and
    // resolveRelationship still answers 'organization_staff'. Reaching a child
    // is not standing to moderate their name.
    callerIs('coach', 'coach-substitute@punxsyprominence.org', 'organization_staff');

    const response = await POST(request({ account_id: SUBJECT_ACCOUNT }));
    const payload = await response.json();

    // The same 404 an unknown account gets. A distinct 403 would tell an
    // outsider that this account exists.
    expect(response.status).toBe(404);
    expect(payload.error).toBe('Not found');
    expect(mockClearNickname).not.toHaveBeenCalled();
  });

  it('refuses a parent who is not this child\'s guardian', async () => {
    callerIs('parent', 'acct-another-family', 'none');

    const response = await POST(request({ account_id: SUBJECT_ACCOUNT }));

    expect(response.status).toBe(404);
    expect(mockClearNickname).not.toHaveBeenCalled();
  });

  it('refuses a role that is not on the list before it looks the child up', async () => {
    // An athlete clearing another athlete's ring name is the obvious one. The
    // assertion that matters is the SECOND one: the role gate runs before any
    // read, so a refused caller learns nothing about whether the account
    // exists.
    mockRequirePrincipal.mockResolvedValue(principal('athlete', 'acct-other-kid'));

    const response = await POST(request({ account_id: SUBJECT_ACCOUNT }));

    expect(response.status).toBe(403);
    expect(mockGetSubjectIdentity).not.toHaveBeenCalled();
    expect(mockClearNickname).not.toHaveBeenCalled();
  });

  it('refuses when the subject cannot be reached at all', async () => {
    // assertViewerMayReachSubject is the athlete-access gate every other
    // per-child route runs. A coach in another organization, or one whose
    // coverage grant expired, fails here rather than at the relationship
    // check -- and gets the same hidden 404.
    callerIs('coach', 'coach-elsewhere', 'coach_of_subject');
    mockAssertViewerMayReachSubject.mockRejectedValue(new Error('Forbidden: athlete not accessible'));

    const response = await POST(request({ account_id: SUBJECT_ACCOUNT }));

    expect(response.status).toBe(404);
    expect(mockResolveRelationship).not.toHaveBeenCalled();
    expect(mockClearNickname).not.toHaveBeenCalled();
  });

  it('answers 404 for an account that does not exist', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin', 'acct-admin'));
    mockGetSubjectIdentity.mockResolvedValue(null);

    const response = await POST(request({ account_id: 'acct-nobody' }));

    expect(response.status).toBe(404);
    expect(mockClearNickname).not.toHaveBeenCalled();
  });
});

describe('what the request has to carry', () => {
  it.each([
    ['an absent account_id', {}],
    ['a blank account_id', { account_id: '   ' }],
    ['an account_id that is not a string', { account_id: 42 }],
  ])('rejects %s with 400 and looks nothing up', async (_label, body) => {
    mockRequirePrincipal.mockResolvedValue(principal('coach', SUBJECT.coachAccountId));

    const response = await POST(request(body));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe('account_id is required.');
    expect(mockGetSubjectIdentity).not.toHaveBeenCalled();
  });
});

describe('the audit row', () => {
  it('records who cleared it, on which profile, without republishing the name', async () => {
    // THE ASSERTION THIS FILE EXISTS FOR, after the role gate.
    //
    // An audit row is read by more people, for longer, than the ring name ever
    // was. Writing the cleared string into it would take the exact thing a
    // coach just removed from three screens and publish it to a wider audience
    // permanently -- an "audit completeness" change that undoes the takedown it
    // documents. The route deliberately records the ACTION and not the string,
    // and this is what makes that deliberate rather than incidental.
    callerIs('coach', SUBJECT.coachAccountId, 'coach_of_subject');

    await POST(request({ account_id: SUBJECT_ACCOUNT }));

    expect(mockWriteAudit).toHaveBeenCalledTimes(1);
    const event = mockWriteAudit.mock.calls[0][0];

    expect(event.actor_account_id).toBe(SUBJECT.coachAccountId);
    expect(event.actor_role).toBe('coach');
    expect(event.organization_id).toBe(ORGANIZATION);
    expect(event.entity_type).toBe('account_profile');
    expect(event.entity_id).toBe(SUBJECT_ACCOUNT);
    expect(event.details).toEqual({ action: 'nickname_cleared_by_staff', lock_hours: 72 });

    // Belt and braces on the same point: nothing anywhere in the event may
    // carry a nickname, under any key somebody adds later.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toMatch(/nickname["']?\s*:\s*["'][^"']/i);
    expect(serialized).not.toContain('display_nickname');

    // SHADOW mirroring is off: a takedown is an administrative act on one
    // profile, not an observation about the athlete.
    expect(event.shadow_mirror).toBe(false);
  });

  it('writes nothing when the clear was refused', async () => {
    // An audit trail that records attempts as though they were actions is a
    // trail that cannot be read.
    callerIs('coach', 'coach-substitute@punxsyprominence.org', 'organization_staff');

    await POST(request({ account_id: SUBJECT_ACCOUNT }));

    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('uses a verb the audit vocabulary permits', async () => {
    // pilot_slice_postgres_audit_event_vocabulary_migration.sql constrains
    // event_type. A verb outside it is a constraint violation at write time --
    // which is to say, the takedown succeeds and the record of it does not.
    callerIs('coach', SUBJECT.coachAccountId, 'coach_of_subject');

    await POST(request({ account_id: SUBJECT_ACCOUNT }));

    expect(['create', 'update', 'delete']).toContain(mockWriteAudit.mock.calls[0][0].event_type);
  });
});
