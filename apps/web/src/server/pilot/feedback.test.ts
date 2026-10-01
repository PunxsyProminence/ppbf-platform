// The two properties this module exists to hold, tested against the statements
// it actually sends:
//
// 1. The route is decided from the writer's capacity and words at INSERT time
//    and stored. Nothing recomputes it later.
// 2. The platform owner's cross-gym read carries no identity, because the SQL
//    has none in it -- not because a component declines to render one.

import {
  PLATFORM_FEEDBACK_SQL,
  createFeedbackSubmission,
  decideFeedbackRoute,
  feedbackAcknowledgement,
  isFeedbackKind,
  isFeedbackTriageStatus,
  listOrganizationFeedback,
  listPlatformFeedback,
  setFeedbackTriage,
} from './feedback';
import { query } from './db';

jest.mock('./db', () => ({
  query: jest.fn(),
}));

const mockQuery = jest.mocked(query);

const ORG = 'org-a';
const OTHER_ORG = 'org-b';
const DISCLOSURE = 'someone at the gym keeps hurting me and im scared to come back';
const BUG_REPORT = 'the attendance page loses my selection when i scroll';

function sqlOfCall(index: number): string {
  return String(mockQuery.mock.calls[index][0]);
}

function paramsOfCall(index: number): unknown[] {
  return mockQuery.mock.calls[index][1] as unknown[];
}

beforeEach(() => {
  jest.resetAllMocks();
  mockQuery.mockResolvedValue([]);
});

describe('the route is decided once, from capacity and words', () => {
  test('an athlete writing about being hurt or frightened goes to a human', () => {
    expect(decideFeedbackRoute({ role: 'athlete', body: DISCLOSURE })).toBe('safeguarding');
    expect(decideFeedbackRoute({ role: 'athlete', body: 'i dont want to come on thursday' })).toBe(
      'safeguarding',
    );
  });

  test('an athlete writing about the software goes to the product queue', () => {
    expect(decideFeedbackRoute({ role: 'athlete', body: BUG_REPORT })).toBe('product');
  });

  test.each(['coach', 'parent', 'organization_admin', 'admin', 'board', 'volunteer', 'staff', 'platform_owner'] as const)(
    'a %s submission is not scanned and goes to the product queue',
    (role) => {
      expect(decideFeedbackRoute({ role, body: DISCLOSURE })).toBe('product');
    },
  );

  test('the decided route is written into the insert rather than left to a default', async () => {
    mockQuery.mockResolvedValueOnce([{ submission_id: 'sub-1' }]);

    const created = await createFeedbackSubmission({
      organizationId: ORG,
      accountId: 'acct-athlete',
      role: 'athlete',
      kind: 'other',
      body: DISCLOSURE,
    });

    expect(created).toEqual({ submission_id: 'sub-1', route: 'safeguarding' });
    expect(sqlOfCall(0)).toContain('insert into pilot.feedback_submissions');
    expect(sqlOfCall(0)).toContain('route');
    expect(paramsOfCall(0)).toEqual([
      ORG,
      'acct-athlete',
      'athlete',
      'other',
      DISCLOSURE,
      'safeguarding',
    ]);
  });

  test('the capacity stored is the role that wrote it, so the row stays legible later', async () => {
    mockQuery.mockResolvedValueOnce([{ submission_id: 'sub-2' }]);

    await createFeedbackSubmission({
      organizationId: ORG,
      accountId: 'acct-coach',
      role: 'coach',
      kind: 'bug',
      body: BUG_REPORT,
    });

    expect(paramsOfCall(0)[2]).toBe('coach');
    expect(paramsOfCall(0)[5]).toBe('product');
  });

  test('a write the database did not confirm is an error, not a silent success', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await expect(
      createFeedbackSubmission({
        organizationId: ORG,
        accountId: 'acct-athlete',
        role: 'athlete',
        kind: 'other',
        body: DISCLOSURE,
      }),
    ).rejects.toThrow(/verification failed/);
  });
});

describe('what the writer is told', () => {
  // The confirmation cannot depend on the route in any way. Two messages made
  // it a classifier anyone could probe -- including an adult a child might be
  // disclosing about, sitting beside them while they type.
  test('the confirmation is one message that says a person reads it', () => {
    const message = feedbackAcknowledgement();

    expect(message.toLowerCase()).toContain('a person at the gym reads');
    expect(message.toLowerCase()).not.toContain('safeguard');
    expect(message.toLowerCase()).not.toContain('flag');
    expect(message.toLowerCase()).not.toContain('report');
  });

  test('it takes no argument, so no caller can vary it by route', () => {
    // A signature that accepted a route is a signature a future caller would
    // branch on. The function cannot be asked for a different answer.
    expect(feedbackAcknowledgement).toHaveLength(0);
  });

  test('it promises nothing the platform does not do', () => {
    // Nothing schedules a conversation, so the confirmation must not say one
    // is coming.
    const message = feedbackAcknowledgement().toLowerCase();
    expect(message).not.toContain('talk with you');
    expect(message).not.toContain('will contact');
    expect(message).not.toContain('get back to you');
  });
});

describe('the platform owner reads every gym without reading anyone', () => {
  test.each([
    'submitted_by_account_id',
    'triaged_by_account_id',
    'login_email',
    'full_name',
    'pilot.accounts',
    'pilot.athletes',
    'pilot.parents',
  ])('the cross-gym statement never mentions %p', (forbidden) => {
    expect(PLATFORM_FEEDBACK_SQL).not.toContain(forbidden);
  });

  test('it carries the gym and the capacity, which is what a pattern is made of', () => {
    expect(PLATFORM_FEEDBACK_SQL).toContain('s.organization_id');
    expect(PLATFORM_FEEDBACK_SQL).toContain('organization.organization_name');
    expect(PLATFORM_FEEDBACK_SQL).toContain('s.submitted_by_role');
  });

  // De-identifying the columns is not enough for a disclosure. A child's words
  // are about their own gym and routinely name the adult in it, so the text
  // re-identifies both however anonymous the metadata is. The row still
  // appears; the words stay with the gym admin who can act on them.
  test('a safeguarding body never leaves its own gym, even to the platform owner', () => {
    expect(PLATFORM_FEEDBACK_SQL).toContain("case when s.route = 'safeguarding' then null else s.body end");
    // The bare column must not also be selected somewhere else in the statement.
    expect(PLATFORM_FEEDBACK_SQL).not.toMatch(/^\s*s\.body\s*,?\s*$/m);
  });

  test('product bodies still cross gyms, because that is what the view is for', () => {
    expect(PLATFORM_FEEDBACK_SQL).toContain('else s.body end');
  });

  test('listPlatformFeedback sends exactly that statement, with no organization filter', async () => {
    await listPlatformFeedback({ limit: 10 });

    expect(sqlOfCall(0)).toBe(PLATFORM_FEEDBACK_SQL);
    expect(paramsOfCall(0)).toEqual([null, null, 10]);
  });

  test('safeguarding sorts ahead of the backlog rather than by age alone', async () => {
    await listPlatformFeedback();

    expect(sqlOfCall(0)).toContain("case when s.route = 'safeguarding' then 0 else 1 end");
  });

  test('an absurd limit is clamped instead of pulling every gym at once', async () => {
    await listPlatformFeedback({ limit: 100_000 });
    expect(paramsOfCall(0)[2]).toBe(200);

    await listPlatformFeedback({ limit: 0 });
    expect(paramsOfCall(1)[2]).toBe(1);

    await listPlatformFeedback({ limit: Number.NaN });
    expect(paramsOfCall(2)[2]).toBe(50);
  });
});

describe('a gym admin reads their own gym, named', () => {
  test('the organization is the first bound parameter and there is no way past it', async () => {
    await listOrganizationFeedback(ORG, { route: 'safeguarding', triageStatus: 'new', limit: 25 });

    expect(sqlOfCall(0)).toContain('where s.organization_id = $1');
    expect(paramsOfCall(0)).toEqual([ORG, 'safeguarding', 'new', 25]);
  });

  test('the submitter is resolved to a name the admin can act on', async () => {
    await listOrganizationFeedback(ORG);

    expect(sqlOfCall(0)).toContain('coalesce(athlete.full_name, account.login_email) as submitter_name');
    // Both joins stay inside the same organization, so a shared account id can
    // never pull a name across a gym boundary.
    expect(sqlOfCall(0)).toContain('and account.organization_id = s.organization_id');
    expect(sqlOfCall(0)).toContain('and athlete.organization_id = s.organization_id');
  });

  test('an unset filter reads both lanes rather than defaulting to one', async () => {
    await listOrganizationFeedback(ORG);

    expect(paramsOfCall(0)[1]).toBeNull();
    expect(paramsOfCall(0)[2]).toBeNull();
  });
});

describe('triage moves, and nothing else does', () => {
  test('the update is scoped to the caller organization and names the triager', async () => {
    mockQuery.mockResolvedValueOnce([
      { submission_id: 'sub-1', triage_status: 'triaged', triage_note: 'Called the family.', triaged_at: 'now' },
    ]);

    const result = await setFeedbackTriage({
      organizationId: ORG,
      submissionId: 'sub-1',
      triageStatus: 'triaged',
      note: 'Called the family.',
      triagedByAccountId: 'acct-admin',
    });

    expect(sqlOfCall(0)).toContain('where organization_id = $1 and submission_id = $2');
    expect(paramsOfCall(0)).toEqual([ORG, 'sub-1', 'triaged', 'Called the family.', 'acct-admin']);
    expect(result?.triage_status).toBe('triaged');
  });

  test('it never writes the body, the route or the capacity', async () => {
    await setFeedbackTriage({
      organizationId: ORG,
      submissionId: 'sub-1',
      triageStatus: 'done',
      note: null,
      triagedByAccountId: 'acct-admin',
    });

    const sql = sqlOfCall(0);
    expect(sql).not.toContain('set body');
    expect(sql).not.toMatch(/\broute\s*=/);
    expect(sql).not.toMatch(/\bbody\s*=/);
    expect(sql).not.toMatch(/\bsubmitted_by_role\s*=/);
  });

  test('a status change with no note keeps the note already there', async () => {
    await setFeedbackTriage({
      organizationId: ORG,
      submissionId: 'sub-1',
      triageStatus: 'planned',
      note: null,
      triagedByAccountId: 'acct-admin',
    });

    expect(sqlOfCall(0)).toContain('triage_note = coalesce($4, triage_note)');
  });

  test("another gym's submission id matches no row, so nothing is reported as changed", async () => {
    mockQuery.mockResolvedValueOnce([]);

    const result = await setFeedbackTriage({
      organizationId: OTHER_ORG,
      submissionId: 'sub-1',
      triageStatus: 'done',
      note: null,
      triagedByAccountId: 'acct-other-admin',
    });

    expect(result).toBeNull();
  });
});

describe('the vocabularies match what the database will accept', () => {
  test.each(['bug', 'idea', 'frustration', 'other'])('%p is a kind', (kind) => {
    expect(isFeedbackKind(kind)).toBe(true);
  });

  test.each(['feature-request', '', 'BUG', null, undefined])('%p is not a kind', (kind) => {
    expect(isFeedbackKind(kind)).toBe(false);
  });

  test.each(['new', 'triaged', 'planned', 'declined', 'done'])('%p is a triage status', (status) => {
    expect(isFeedbackTriageStatus(status)).toBe(true);
  });

  test.each(['wontfix', 'closed', '', 'NEW'])('%p is not a triage status', (status) => {
    expect(isFeedbackTriageStatus(status)).toBe(false);
  });
});
