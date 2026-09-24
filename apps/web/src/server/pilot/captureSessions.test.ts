jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));

import { query, queryOne, withTransaction } from './db';
import {
  advanceTake,
  closeRecordingSession,
  createRecordingSession,
  findOpenSessionByJoinCode,
  generateJoinCode,
  listTakeFiles,
  normalizeJoinCode,
} from './captureSessions';

const mockQuery = jest.mocked(query);
const mockQueryOne = jest.mocked(queryOne);
const mockWithTransaction = jest.mocked(withTransaction);

const mockClient = { query: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  mockWithTransaction.mockImplementation(((fn: (c: unknown) => unknown) => fn(mockClient)) as never);
});

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    recording_session_id: 'rs-1',
    organization_id: 'org-a',
    created_by_account_id: 'acct-coach',
    training_context: 'heavy_bag',
    join_code: 'H7K2QP',
    state: 'open',
    created_at: '2026-09-23T10:00:00Z',
    ...overrides,
  };
}

function takeRow(overrides: Record<string, unknown> = {}) {
  return {
    capture_take_id: 'take-1',
    recording_session_id: 'rs-1',
    take_number: 1,
    state: 'open',
    created_at: '2026-09-23T10:00:00Z',
    ...overrides,
  };
}

describe('the join code', () => {
  /*
   * The alphabet is the one activation codes use, and for the same reason:
   * this gets read aloud across a gym or off one phone onto another. I, L, O
   * and U are absent because I/1, L/1 and O/0 are routinely mis-transcribed
   * and U turns accidental codes into unfortunate words.
   */
  test('never contains a glyph people reliably mistype', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateJoinCode()).not.toMatch(/[ILOU]/);
    }
  });

  test('is six characters, which is a length someone can read across a room', () => {
    expect(generateJoinCode()).toHaveLength(6);
  });

  test('is not the same code twice in a row', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateJoinCode()));
    expect(codes.size).toBeGreaterThan(40);
  });

  /*
   * Folding the confusables is SAFE HERE FOR AN EXTRA REASON, and the reason
   * matters: widening what a code matches cannot widen access, because the
   * code grants no access. It only says which session. A reader who assumes
   * this is like activation.ts -- where the code IS the credential -- would
   * find this alarming; it is the opposite case.
   */
  test.each([
    ['h7k2qp', 'H7K2QP'],
    ['H7K2QP', 'H7K2QP'],
    [' h7k2-qp ', 'H7K2QP'],
    ['HIK2QP', 'H1K2QP'],
    ['HOK2QP', 'H0K2QP'],
    ['HLK2QP', 'H1K2QP'],
    ['HUK2QP', 'HVK2QP'],
  ])('normalizes %s to %s', (raw, expected) => {
    expect(normalizeJoinCode(raw)).toBe(expected);
  });
});

describe('creating a recording session', () => {
  test('opens the session and its first take together', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [sessionRow()] })
      .mockResolvedValueOnce({ rows: [takeRow()] });

    const result = await createRecordingSession({
      organizationId: 'org-a',
      createdByAccountId: 'acct-coach',
      trainingContext: 'heavy_bag',
    });

    expect(result.session.joinCode).toBe('H7K2QP');
    expect(result.take.takeNumber).toBe(1);
    // A session with no take would leave a device with nothing to record
    // against, so both are written in the same transaction.
    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
  });

  /*
   * A code collision is RETRIED, not pre-checked. A select-then-insert would
   * be a race: two coaches starting sessions in the same second can both read
   * a code as free. The partial unique index is the arbiter, so the insert
   * simply asks it -- `on conflict do nothing` returns no row -- and another
   * code is tried.
   */
  test('tries another code when the database says that one is taken', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [sessionRow({ join_code: 'ZZ99XY' })] })
      .mockResolvedValueOnce({ rows: [takeRow()] });

    const result = await createRecordingSession({
      organizationId: 'org-a',
      createdByAccountId: 'acct-coach',
      trainingContext: 'sparring',
    });

    expect(result.session.joinCode).toBe('ZZ99XY');
  });

  test('gives up rather than looping forever when no code can be allocated', async () => {
    mockClient.query.mockResolvedValue({ rows: [] });

    await expect(
      createRecordingSession({
        organizationId: 'org-a',
        createdByAccountId: 'acct-coach',
        trainingContext: 'other',
      }),
    ).rejects.toThrow(/could not allocate a join code/);
  });
});

describe('finding a session by its code', () => {
  test('is scoped to the caller organization and to open sessions only', async () => {
    mockQueryOne.mockResolvedValueOnce(sessionRow());

    await findOpenSessionByJoinCode('org-a', 'h7k2qp');

    const [sql, params] = mockQueryOne.mock.calls[0];
    // Both predicates are load-bearing: without the organization a code read
    // aloud in one gym would reach another's session, and without the state a
    // finished session could still be joined.
    expect(String(sql)).toContain('organization_id = $1');
    expect(String(sql)).toContain("state = 'open'");
    // The typed code is normalized before it reaches the query.
    expect(params).toEqual(['org-a', 'H7K2QP']);
  });

  test('a code that matches nothing is null, not an error', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    await expect(findOpenSessionByJoinCode('org-a', 'NOPE12')).resolves.toBeNull();
  });
});

describe('advancing to the next take', () => {
  test('closes the open take and opens the next one in one transaction', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ state: 'open' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [takeRow({ capture_take_id: 'take-2', take_number: 2 })] });

    const take = await advanceTake({ organizationId: 'org-a', recordingSessionId: 'rs-1' });

    expect(take.takeNumber).toBe(2);
    // One transaction, because a gap with no open take is a window in which a
    // device that pressed record has nothing to attach its file to.
    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    const statements = mockClient.query.mock.calls.map(([sql]) => String(sql));
    expect(statements[0]).toContain('for update');
    expect(statements[1]).toContain("set state = 'closed'");
    expect(statements[2]).toContain('insert into pilot.capture_takes');
  });

  test('a session that does not exist in this organization is not found', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      advanceTake({ organizationId: 'org-a', recordingSessionId: 'rs-other-gym' }),
    ).rejects.toThrow(/Not found/);
  });

  test('a closed session refuses a new take rather than silently reopening', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ state: 'closed' }] });

    await expect(
      advanceTake({ organizationId: 'org-a', recordingSessionId: 'rs-1' }),
    ).rejects.toThrow(/closed/);
  });
});

describe('closing a session', () => {
  /*
   * THE LOCK ORDERING IS THE WHOLE TEST. close did not take the session lock,
   * and the interleaving that allowed was real: close shuts the open take, an
   * advance already holding the session creates take N+1 as open, then close
   * marks the session closed. End state -- a CLOSED session with an OPEN take,
   * the exact contradiction the take table exists to prevent, with neither
   * statement wrong on its own.
   *
   * A mocked test cannot reproduce the interleaving. It CAN pin the property
   * that prevents it: both writers claim the same row before touching takes.
   */
  test('claims the session row before it touches any take', async () => {
    mockClient.query.mockResolvedValue({ rows: [] });

    await closeRecordingSession({ organizationId: 'org-a', recordingSessionId: 'rs-1' });

    const statements = mockClient.query.mock.calls.map(([sql]) => String(sql));
    expect(statements[0]).toContain('for update');
    expect(statements[0]).toContain('pilot.recording_sessions');
    expect(statements[1]).toContain('pilot.capture_takes');
  });

  test('locks the same row advancing does, so the two serialize against each other', async () => {
    mockClient.query.mockResolvedValue({ rows: [] });
    await closeRecordingSession({ organizationId: 'org-a', recordingSessionId: 'rs-1' });
    const closeLock = String(mockClient.query.mock.calls[0][0]);
    const closeParams = mockClient.query.mock.calls[0][1];

    jest.clearAllMocks();
    mockWithTransaction.mockImplementation(((fn: (c: unknown) => unknown) => fn(mockClient)) as never);
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ state: 'open' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [takeRow()] });
    await advanceTake({ organizationId: 'org-a', recordingSessionId: 'rs-1' });
    const advanceLock = String(mockClient.query.mock.calls[0][0]);

    /*
     * The SQL text differs -- advance reads `state`, close reads a literal --
     * and that is fine. What must match is the ROW each one claims: same
     * table, same two predicate columns, same FOR UPDATE. Comparing the text
     * would fail on a harmless rewording while missing a changed predicate,
     * which is the wrong way round.
     */
    for (const lock of [closeLock, advanceLock]) {
      expect(lock).toContain('pilot.recording_sessions');
      expect(lock).toContain('organization_id = $1');
      expect(lock).toContain('recording_session_id = $2');
      expect(lock).toContain('for update');
    }
    expect(closeParams).toEqual(['org-a', 'rs-1']);
  });
});

describe('the files on a take', () => {
  test('are read for one take within one organization, oldest first', async () => {
    mockQuery.mockResolvedValueOnce([
      {
        video_session_id: 'vs-1',
        camera_view_id: 'view-1',
        camera_view: 'front',
        uploaded_by_account_id: 'acct-coach',
        status: 'quarantined',
        recorded_at: '2026-09-23T10:01:00Z',
        created_at: '2026-09-23T10:02:00Z',
      },
    ]);

    const files = await listTakeFiles('org-a', 'take-1');

    expect(files).toEqual([
      expect.objectContaining({ videoSessionId: 'vs-1', cameraView: 'front', cameraViewId: 'view-1' }),
    ]);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('organization_id = $1');
    expect(String(sql)).toContain('capture_take_id = $2');
    expect(String(sql)).toContain('order by created_at asc');
    expect(params).toEqual(['org-a', 'take-1']);
  });
});
