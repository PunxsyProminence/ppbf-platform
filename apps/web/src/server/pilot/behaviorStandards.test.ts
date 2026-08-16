// Behavior standards (module 125). What these pin -- and these are the
// point of the module, not incidental:
//
//   1. Meeting a standard is a RECOGNITION, with a typed link.
//   2. A conduct concern files into the SAFEGUARDING LADDER as an
//      incident, carrying an acknowledge/resolve lifecycle -- it is never
//      written into a behavior log, a note field, or a score.
//   3. Severity on a concern is the filer's stated judgment, never
//      computed from anything about the child.

import { raiseConductConcern, recognizeStandardMet } from './behaviorStandards';
import { fileEscalation } from './escalationLadder';
import { queryOne } from './db';

jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('./escalationLadder', () => ({ fileEscalation: jest.fn() }));

const mockQueryOne = queryOne as jest.Mock;
const mockFileEscalation = fileEscalation as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

test('meeting a standard writes an ordinary recognition with a typed standard link', async () => {
  mockQueryOne
    .mockResolvedValueOnce({ standard_id: 'std-1', recognition_kind: 'took_the_correction' }) // standard lookup
    .mockResolvedValueOnce({ athlete_id: 'ath-1' })                                            // athlete lookup
    .mockResolvedValueOnce({ recognition_id: 'rec-1' });                                       // insert

  const result = await recognizeStandardMet({
    organizationId: 'org-1',
    athleteId: 'ath-1',
    standardId: 'std-1',
    coachAccountId: 'acct-coach',
    coachDisplayName: 'Coach A',
    note: 'walked away, came back, finished the round',
  });

  const insert = mockQueryOne.mock.calls[2];
  expect(insert[0]).toContain('insert into pilot.recognitions');
  // The kind comes from the STANDARD, not the caller -- a posted
  // expectation already says how it is recognized.
  expect(insert[1]).toContain('took_the_correction');
  expect(insert[1]).toContain('std-1');
  // The returned id is the one written, not a DB echo.
  expect(result?.recognition_id).toBe(insert[1][1]);
});

test('a retired standard or an out-of-org athlete recognizes nothing', async () => {
  mockQueryOne.mockResolvedValueOnce(null); // retired/unknown standard
  expect(await recognizeStandardMet({
    organizationId: 'org-1', athleteId: 'ath-1', standardId: 'std-gone',
    coachAccountId: 'acct-coach', coachDisplayName: 'Coach A',
  })).toBeNull();

  mockQueryOne.mockReset();
  mockQueryOne
    .mockResolvedValueOnce({ standard_id: 'std-1', recognition_kind: 'showed_up_hard_day' })
    .mockResolvedValueOnce(null); // athlete not in this org
  expect(await recognizeStandardMet({
    organizationId: 'org-1', athleteId: 'ath-elsewhere', standardId: 'std-1',
    coachAccountId: 'acct-coach', coachDisplayName: 'Coach A',
  })).toBeNull();
});

test('a conduct concern goes to the safeguarding ladder as an incident -- never to a behavior log', async () => {
  mockFileEscalation.mockResolvedValue({ escalation_id: 'esc-1' });

  const result = await raiseConductConcern({
    organizationId: 'org-1',
    athleteId: 'ath-1',
    reason: 'repeatedly ignored a stop instruction during sparring',
    severity: 'moderate',
    standardId: 'std-1',
    raisedByAccountId: 'acct-coach',
    raisedByRole: 'coach',
  });

  expect(result).toEqual({ escalation_id: 'esc-1' });
  expect(mockFileEscalation).toHaveBeenCalledWith(expect.objectContaining({
    sourceType: 'incident',
    athleteId: 'ath-1',
    severity: 'moderate',
    triggeredBy: 'human',
    metadata: expect.objectContaining({ concern_kind: 'conduct' }),
  }));
  // Nothing about the concern was written anywhere else -- no recognition,
  // no behavior row, no note field.
  expect(mockQueryOne).not.toHaveBeenCalled();
});

test('severity travels as the filer stated it and is never derived', async () => {
  mockFileEscalation.mockResolvedValue({ escalation_id: 'esc-2' });

  for (const severity of ['low', 'moderate', 'high', 'critical'] as const) {
    await raiseConductConcern({
      organizationId: 'org-1', athleteId: 'ath-1', reason: 'stated concern',
      severity, raisedByAccountId: 'acct-coach', raisedByRole: 'coach',
    });
    expect(mockFileEscalation).toHaveBeenLastCalledWith(expect.objectContaining({ severity }));
  }
});
