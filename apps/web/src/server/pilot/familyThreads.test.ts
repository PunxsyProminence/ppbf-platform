// Unit tests for the guardian half of familyThreads.ts (W4 item 4, PM-1b) that a real database
// cannot reach: an athlete whose date of birth is unknown still counts as linked to their
// guardian (OD-2026-10-04-010: an unknown date of birth is treated as a minor; guardianAccess.ts
// guardianLinkEnded). pilot.athletes.dob is NOT NULL, so familyThreadsGuardian.pg.test.ts cannot
// seed one; here the link query answers with a null dob and the real guardianAccess.ts decides.
import { query, queryOne } from './db';
import { listOwnFamilyThreads, startFamilyThread } from './familyThreads';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));
jest.mock('./achievements', () => ({
  getStaffAuthorName: jest.fn(async () => 'Coach Name'),
}));

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

beforeEach(() => {
  mockQuery.mockReset();
  mockQueryOne.mockReset();
});

describe('familyThreads: an unknown date of birth reads as a minor (OD-2026-10-04-010)', () => {
  test('a guardian may open a thread about a linked child whose date of birth is unknown', async () => {
    mockQueryOne
      // isGuardianLinkedToAthlete: linked, date of birth unknown.
      .mockResolvedValueOnce({ athlete_id: 'ath-unknown-dob', dob: null })
      // the insert's returning row.
      .mockResolvedValueOnce({ post_id: 'p-1', thread_id: 'p-1', created_at: '2026-11-25T03:00:00.000Z' });

    await expect(
      startFamilyThread({ organizationId: 'org-1', accountId: 'guardian-1', athleteId: 'ath-unknown-dob', text: 'Hello' }),
    ).resolves.toEqual({ thread_id: 'p-1', post_id: 'p-1', created_at: '2026-11-25T03:00:00.000Z' });
    const [insertSql, insertParams] = mockQueryOne.mock.calls[1];
    expect(String(insertSql)).toContain('insert into pilot.family_thread_posts');
    expect(insertParams.slice(3)).toEqual(['ath-unknown-dob', 'guardian-1', 'Hello']);
  });

  test('the same child, 18 or over by a known date of birth, is refused', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-adult', dob: '2000-01-01' });
    await expect(
      startFamilyThread({ organizationId: 'org-1', accountId: 'guardian-1', athleteId: 'ath-adult', text: 'Hello' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  test("a child whose date of birth is unknown stays in the guardian's thread list; an adult's thread drops out, in the one read", async () => {
    const row = (athleteId: string, dob: string | null) => ({
      thread_id: `t-${athleteId}`, athlete_id: athleteId, athlete_dob: dob, thread_created_at: '2026-11-25T03:00:00.000Z',
      post_id: `t-${athleteId}`, author_role: 'parent', author_account_id: null, post_text: 'Hello',
      created_at: '2026-11-25T03:00:00.000Z', seen: false,
    });
    // One statement returns the threads with each child's date of birth (Codex P2 on #2179).
    mockQuery.mockResolvedValueOnce([row('ath-adult', '2000-01-01'), row('ath-unknown-dob', null)]);
    const list = await listOwnFamilyThreads('org-1', 'guardian-1');
    expect(list.map((thread) => thread.athlete_id)).toEqual(['ath-unknown-dob']);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][1]).toEqual(['org-1', 'guardian-1']);
  });
});
