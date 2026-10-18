// Lane N4-01, OD-2026-10-08-006 A-Q19 ("Build one answer").
//
// What these pin: the answer follows the two rules main already has (a
// training hold, a medical clearance in force) and nothing else; a source
// nobody could read is 'unavailable' and never 'cleared'; and the records
// listed under the answer are reported as they stand without moving it.

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));

jest.mock('./waiverCompliance', () => ({
  ...jest.requireActual('./waiverCompliance'),
  readOrganizationWaiverRoster: jest.fn(),
}));

jest.mock('./trainingHolds', () => ({
  listTrainingHolds: jest.fn(),
}));

jest.mock('./shadowMedicalStatus', () => ({
  ...jest.requireActual('./shadowMedicalStatus'),
  getLatestMedicalAdministrativeStatus: jest.fn(),
}));

jest.mock('./guardianConsent', () => ({
  ...jest.requireActual('./guardianConsent'),
  readOwnMediaConsent: jest.fn(),
}));
jest.mock('./compliance', () => ({
  countOpenViolationsByAthlete: jest.fn(),
}));

import fs from 'node:fs';
import path from 'node:path';

import {
  clearedTonightAnswer,
  getOrganizationClearedTonight,
  type ClearedTonightHold,
  type ClearedTonightHoldRead,
  type ClearedTonightMedical,
  type ClearedTonightMedicalRead,
} from './clearedTonight';
import { countOpenViolationsByAthlete } from './compliance';
import { readOwnMediaConsent } from './guardianConsent';
import {
  getLatestMedicalAdministrativeStatus,
  type MedicalAdministrativeStatusValue,
  type ShadowMedicalAdministrativeStatusRow,
} from './shadowMedicalStatus';
import { listTrainingHolds, type TrainingHoldRow, type TrainingHoldScope } from './trainingHolds';
import { readOrganizationWaiverRoster, type AthleteWaiverRosterEntry } from './waiverCompliance';

const mockRoster = jest.mocked(readOrganizationWaiverRoster);
const mockHolds = jest.mocked(listTrainingHolds);
const mockMedical = jest.mocked(getLatestMedicalAdministrativeStatus);
const mockViolations = jest.mocked(countOpenViolationsByAthlete);
const mockOwn = jest.mocked(readOwnMediaConsent);

const NOW = new Date('2026-10-11T22:00:00.000Z');

function holdRead(scope: TrainingHoldScope): ClearedTonightHold {
  return { scope, athlete_explanation: '', lift_condition_text: '', expires_at: null };
}

function medicalRead(status: string, current = status === 'cleared'): ClearedTonightMedical {
  return { status, current, expires_at: null };
}

const CLEARED = medicalRead('cleared');

describe('clearedTonightAnswer', () => {
  const cases: Array<[string, ClearedTonightHoldRead, ClearedTonightMedicalRead, string]> = [
    ['no hold and a clearance in force', null, CLEARED, 'cleared'],
    ['an all-training hold', holdRead('all_training'), CLEARED, 'not_cleared'],
    ['a contact-only hold', holdRead('contact_only'), CLEARED, 'cleared_no_contact'],
    // The historical scope nothing on main enforces: on record, and it stops nothing.
    ['a conditioning-only hold', holdRead('conditioning_only'), CLEARED, 'cleared'],
    ['a medical record that says not cleared', null, medicalRead('not_cleared'), 'not_cleared'],
    ['a restricted medical record', null, medicalRead('restricted'), 'cleared_no_contact'],
    // Nobody decided anything about contact for these three: the answer says
    // cleared to train and never "no contact".
    ['a pending medical record', null, medicalRead('pending'), 'cleared_to_train'],
    ['a clearance past its expiry', null, medicalRead('cleared_expired', false), 'cleared_to_train'],
    ['no medical record on file', null, medicalRead('no_record'), 'cleared_to_train'],
    ['a conditioning-only hold and no medical record', holdRead('conditioning_only'), medicalRead('no_record'), 'cleared_to_train'],
    ['a contact-only hold and a restricted record', holdRead('contact_only'), medicalRead('restricted'), 'cleared_no_contact'],
    ['the more restrictive of the two wins (hold)', holdRead('all_training'), medicalRead('pending'), 'not_cleared'],
    ['the more restrictive of the two wins (medical)', holdRead('contact_only'), medicalRead('not_cleared'), 'not_cleared'],
    ['a contact-only hold and no medical record', holdRead('contact_only'), medicalRead('no_record'), 'cleared_no_contact'],
  ];

  test.each(cases)('%s', (_name, hold, medical, expected) => {
    expect(clearedTonightAnswer(hold, medical)).toBe(expected);
  });

  // The rule this module must never break: nobody looked is not "cleared".
  test.each<[string, ClearedTonightHoldRead, ClearedTonightMedicalRead]>([
    ['the hold read failed', 'unavailable', CLEARED],
    ['the medical read failed', null, 'unavailable'],
    ['the medical read failed under a contact-only hold', holdRead('contact_only'), 'unavailable'],
    ['the hold read failed and medical is not current', 'unavailable', medicalRead('no_record')],
    ['both reads failed', 'unavailable', 'unavailable'],
    // A status word this module does not know is not read as cleared.
    ['the medical record holds a word nobody here knows', null, medicalRead('suspended', false)],
  ])('%s: unavailable, never cleared', (_name, hold, medical) => {
    expect(clearedTonightAnswer(hold, medical)).toBe('unavailable');
  });

  // A known "no" does not become "unavailable" because the other half is
  // unread: nothing the unread half could say makes it less true.
  test.each<[string, ClearedTonightHoldRead, ClearedTonightMedicalRead]>([
    ['an all-training hold with medical unread', holdRead('all_training'), 'unavailable'],
    ['medical not cleared with holds unread', 'unavailable', medicalRead('not_cleared')],
  ])('%s: still not cleared', (_name, hold, medical) => {
    expect(clearedTonightAnswer(hold, medical)).toBe('not_cleared');
  });
});

function rosterEntry(overrides: Partial<AthleteWaiverRosterEntry> = {}): AthleteWaiverRosterEntry {
  return {
    athleteId: 'ath-1',
    athleteName: 'Jordan T.',
    activeFlag: true,
    waivers: { general: 'signed', medical_release: 'signed', photo_media: 'signed', travel: 'signed' },
    dob: '2012-05-01',
    recordedOn: { general: '2026-09-02', medical_release: '2026-09-02', travel: '2026-09-03' },
    ...overrides,
  };
}

function holdRow(overrides: Partial<TrainingHoldRow> = {}): TrainingHoldRow {
  return {
    hold_id: 'hold-1',
    athlete_id: 'ath-1',
    scope: 'all_training',
    reason_category: 'medical',
    reason_text: 'STAFF-ONLY: suspected concussion, see doctor note',
    athlete_explanation: 'Rest this week.',
    lift_condition_text: 'A note from your doctor.',
    placed_by_account_id: 'coach@example.test',
    placed_by_role: 'coach',
    placed_at: '2026-10-10 12:00:00+00',
    expires_at: null,
    lifted_by_account_id: null,
    lifted_at: null,
    lift_note: '',
    status: 'active',
    created_at: '2026-10-10 12:00:00+00',
    updated_at: '2026-10-10 12:00:00+00',
    ...overrides,
  };
}

function medicalRow(
  status: MedicalAdministrativeStatusValue,
  overrides: Partial<ShadowMedicalAdministrativeStatusRow> = {},
): ShadowMedicalAdministrativeStatusRow {
  return {
    status_id: 'status-1',
    organization_id: 'org-1',
    athlete_id: 'ath-1',
    status,
    restriction_flags: { detail: 'STAFF-ONLY: no head contact' },
    source_reference: 'STAFF-ONLY: Dr. Example letter',
    set_by_account_id: 'admin@example.test',
    set_by_role: 'organization_admin',
    effective_at: '2026-09-01T00:00:00.000Z',
    expires_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

// The three Overwatch asked to be pinned by name.
describe('the words go no further than what a record says', () => {
  test('a not_cleared record with no hold never reads cleared', () => {
    expect(clearedTonightAnswer(null, medicalRead('not_cleared'))).toBe('not_cleared');
    expect(clearedTonightAnswer(holdRead('conditioning_only'), medicalRead('not_cleared'))).toBe('not_cleared');
  });

  test('an athlete with no medical record reads cleared to train, never no contact', () => {
    for (const status of ['no_record', 'pending', 'cleared_expired']) {
      expect(clearedTonightAnswer(null, medicalRead(status, false))).toBe('cleared_to_train');
    }
  });

  test('no contact is only ever something a person entered: a contact hold or a restricted record', () => {
    const holds: ClearedTonightHoldRead[] = [null, holdRead('conditioning_only'), holdRead('contact_only'), holdRead('all_training')];
    const medicals = ['cleared', 'restricted', 'not_cleared', 'pending', 'cleared_expired', 'no_record'];
    for (const hold of holds) {
      for (const status of medicals) {
        if (clearedTonightAnswer(hold, medicalRead(status)) !== 'cleared_no_contact') continue;
        const holdSaysSo = hold !== null && hold !== 'unavailable' && hold.scope === 'contact_only';
        expect(holdSaysSo || status === 'restricted').toBe(true);
      }
    }
  });

  test('a failed medical read is unavailable', () => {
    expect(clearedTonightAnswer(null, 'unavailable')).toBe('unavailable');
  });
});

// OWNERSHIP PIN (Overwatch): this answer is read by one route and nothing
// else. A second importer would be a second place the answer could start
// deciding something, which the module's header says it never does.
describe('who reads the cleared-tonight answer', () => {
  const APP_WEB = path.resolve(__dirname, '../../..');

  function sourceFilesUnder(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const found: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        found.push(...sourceFilesUnder(full));
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push(full);
      }
    }
    return found;
  }

  test('the waiver-status route is its only importer', () => {
    const files = ['app', 'src', 'components', 'lib'].flatMap((dir) => sourceFilesUnder(path.join(APP_WEB, dir)));
    // The walk found the tree: an empty walk must not pass this.
    expect(files.length).toBeGreaterThan(500);
    const importers = files
      .filter((file) => /['"][^'"]*\/clearedTonight['"]/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(APP_WEB, file).split(path.sep).join('/'));
    expect(importers).toEqual(['app/api/pilot/admin/waiver-status/route.ts']);
  });
});

describe('a record this module has no word for', () => {
  test('a hold scope outside the vocabulary is unavailable, never cleared', () => {
    const stray = { ...holdRead('all_training'), scope: 'weekends_only' as unknown as TrainingHoldScope };
    expect(clearedTonightAnswer(stray, CLEARED)).toBe('unavailable');
  });
});

describe('getOrganizationClearedTonight', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockRoster.mockResolvedValue([rosterEntry()]);
    mockHolds.mockResolvedValue([]);
    mockMedical.mockResolvedValue(medicalRow('cleared'));
    mockViolations.mockResolvedValue(new Map());
  });

  afterEach(() => {
    errorSpy.mockRestore();
    jest.clearAllMocks();
  });

  test('an athlete with no hold and a clearance in force is cleared, with every record listed', async () => {
    const [row] = await getOrganizationClearedTonight('org-1', NOW);

    expect(row).toEqual({
      athleteId: 'ath-1',
      athleteName: 'Jordan T.',
      activeFlag: true,
      waivers: { general: 'signed', medical_release: 'signed', photo_media: 'signed', travel: 'signed' },
      tonight: {
        answer: 'cleared',
        hold: null,
        medical: { status: 'cleared', current: true, expires_at: null },
        waivers: [
          { type: 'general', status: 'signed', recorded_on: '2026-09-02' },
          { type: 'medical_release', status: 'signed', recorded_on: '2026-09-02' },
          { type: 'travel', status: 'signed', recorded_on: '2026-09-03' },
        ],
        media_consent: { basis: 'guardian', status: 'signed' },
        open_violations: 0,
      },
    });
    expect(mockHolds).toHaveBeenCalledWith('org-1', { status: 'active' });
    expect(mockMedical).toHaveBeenCalledWith('org-1', 'ath-1');
    expect(mockViolations).toHaveBeenCalledWith('org-1');
  });

  // Q2 as ruled: papers, consent and violations are facts on file. No rule on
  // main makes any of them a condition of training, so none moves the answer.
  test('unsigned papers, refused media consent and open violations are listed and do not change the answer', async () => {
    mockRoster.mockResolvedValue([
      rosterEntry({
        waivers: { general: 'missing', medical_release: 'declined', photo_media: 'withdrawn', travel: 'withdrawn' },
        recordedOn: { medical_release: '2026-08-01', travel: '2026-08-02' },
      }),
    ]);
    mockViolations.mockResolvedValue(new Map([['ath-1', 3]]));

    const [row] = await getOrganizationClearedTonight('org-1', NOW);

    expect(row.tonight.answer).toBe('cleared');
    expect(row.tonight.waivers).toEqual([
      { type: 'general', status: 'missing', recorded_on: null },
      { type: 'medical_release', status: 'declined', recorded_on: '2026-08-01' },
      { type: 'travel', status: 'withdrawn', recorded_on: '2026-08-02' },
    ]);
    expect(row.tonight.media_consent).toEqual({ basis: 'guardian', status: 'withdrawn' });
    expect(row.tonight.open_violations).toBe(3);
  });

  test('a hold is reported in the athlete-facing words and never with the staff reason', async () => {
    mockHolds.mockResolvedValue([holdRow({ expires_at: '2026-10-20 12:00:00+00' })]);

    const [row] = await getOrganizationClearedTonight('org-1', NOW);

    expect(row.tonight.answer).toBe('not_cleared');
    expect(row.tonight.hold).toEqual({
      scope: 'all_training',
      athlete_explanation: 'Rest this week.',
      lift_condition_text: 'A note from your doctor.',
      // ISO, not the Postgres text it was read as: a tablet's browser must be
      // able to read the day.
      expires_at: '2026-10-20T12:00:00.000Z',
    });
    const sent = JSON.stringify(row);
    expect(sent).not.toContain('STAFF-ONLY');
    expect(sent).not.toContain('coach@example.test');
    expect(sent).not.toContain('reason_text');
  });

  test('the medical record is reported as a status only: no restriction detail, source or author', async () => {
    mockMedical.mockResolvedValue(medicalRow('restricted'));

    const [row] = await getOrganizationClearedTonight('org-1', NOW);

    expect(row.tonight.answer).toBe('cleared_no_contact');
    expect(row.tonight.medical).toEqual({ status: 'restricted', current: false, expires_at: null });
    const sent = JSON.stringify(row);
    expect(sent).not.toContain('STAFF-ONLY');
    expect(sent).not.toContain('admin@example.test');
  });

  // The time bound is shadowMedicalStatus's own (isClearanceCurrent): a stored
  // 'cleared' past its expiry is not a clearance.
  test('a clearance past its stated expiry is not a clearance tonight', async () => {
    // As Postgres hands it over (expires_at::text), not as ISO.
    mockMedical.mockResolvedValue(medicalRow('cleared', { expires_at: '2026-10-01 00:00:00+00' }));

    const [row] = await getOrganizationClearedTonight('org-1', NOW);

    expect(row.tonight.medical).toEqual({ status: 'cleared_expired', current: false, expires_at: '2026-10-01T00:00:00.000Z' });
    expect(row.tonight.answer).toBe('cleared_to_train');
  });

  test('no medical record on file is reported as none, and is not a clearance', async () => {
    mockMedical.mockResolvedValue(null);

    const [row] = await getOrganizationClearedTonight('org-1', NOW);

    expect(row.tonight.medical).toEqual({ status: 'no_record', current: false, expires_at: null });
    expect(row.tonight.answer).toBe('cleared_to_train');
  });

  // OD-2026-10-08-015: at 18 a guardian's media consent stops counting for a
  // new publication and the adult's own cannot be recorded yet.
  test('an adult athlete with no consent of their own: none, and the guardian-era row is not reported as theirs', async () => {
    mockRoster.mockResolvedValue([rosterEntry({ dob: '2008-10-11' })]);
    mockOwn.mockResolvedValue(null);

    const [row] = await getOrganizationClearedTonight('org-1', NOW);

    expect(row.tonight.media_consent).toEqual({ basis: 'adult_own_consent', own: 'none' });
    expect(mockOwn).toHaveBeenCalledWith('org-1', 'ath-1');
    // The worklist column is untouched by this lane.
    expect(row.waivers.photo_media).toBe('signed');
    // A paper an adult signed for themselves is read like any other row.
    expect(row.tonight.waivers[0]).toEqual({ type: 'general', status: 'signed', recorded_on: '2026-09-02' });
    expect(row.tonight.answer).toBe('cleared');
  });

  const ownRow = (over: Record<string, unknown> = {}) => ({
    status: 'signed', coversVideo: true, publicUseAllowed: false, signedAt: '2026-10-01T00:00:00Z', recordedByOwnLogin: true, ...over,
  });

  test.each([
    ['their own video consent', ownRow(), 'video'],
    ['an untidy signature', ownRow({ status: ' Signed ' }), 'video'],
    ['photo only', ownRow({ coversVideo: false }), 'photo_only'],
    ['a withdrawal', ownRow({ status: 'withdrawn', coversVideo: false }), 'withdrawn'],
    ['a signed row their own login did not record', ownRow({ recordedByOwnLogin: false }), 'none'],
    ['a status nobody can read', ownRow({ status: 'declined' }), 'none'],
  ])('an adult with %s reads %s, as the publication gate would', async (_label, own, word) => {
    mockRoster.mockResolvedValue([rosterEntry({ dob: '2000-01-01' })]);
    mockOwn.mockResolvedValue(own);
    const [row] = await getOrganizationClearedTonight('org-1', NOW);
    expect(row.tonight.media_consent).toEqual({ basis: 'adult_own_consent', own: word });
  });

  test("an adult's own consent that cannot be read is unavailable, not none, and the rest of the row still answers", async () => {
    mockRoster.mockResolvedValue([rosterEntry({ dob: '2000-01-01' })]);
    mockOwn.mockRejectedValue(new Error('connection reset'));
    const [row] = await getOrganizationClearedTonight('org-1', NOW);
    expect(row.tonight.media_consent).toEqual({ basis: 'adult_own_consent', own: 'unavailable' });
    expect(row.tonight.answer).toBe('cleared');
  });

  test.each([
    ['the day before the 18th birthday', '2008-10-12'],
    ['an unknown date of birth', null],
  ])('a minor (%s): media consent is the guardians’', async (_name, dob) => {
    mockRoster.mockResolvedValue([
      rosterEntry({ dob, waivers: { general: 'signed', medical_release: 'signed', photo_media: 'missing', travel: 'signed' } }),
    ]);

    const [row] = await getOrganizationClearedTonight('org-1', NOW);

    expect(row.tonight.media_consent).toEqual({ basis: 'guardian', status: 'missing' });
  });

  test('a hold read that failed makes every athlete unavailable, and is logged without the error text', async () => {
    mockRoster.mockResolvedValue([rosterEntry(), rosterEntry({ athleteId: 'ath-2', athleteName: 'Sam R.' })]);
    mockHolds.mockRejectedValue(new Error('connection refused: ath-1 hold text'));

    const rows = await getOrganizationClearedTonight('org-1', NOW);

    expect(rows.map((row) => row.tonight.answer)).toEqual(['unavailable', 'unavailable']);
    expect(rows.map((row) => row.tonight.hold)).toEqual(['unavailable', 'unavailable']);
    expect(errorSpy).toHaveBeenCalledWith({
      event: 'cleared-tonight-source-unreadable',
      source: 'training_holds',
      errorClass: 'Error',
    });
  });

  test('a medical read that failed for one athlete makes that athlete unavailable and no other', async () => {
    mockRoster.mockResolvedValue([rosterEntry(), rosterEntry({ athleteId: 'ath-2', athleteName: 'Sam R.' })]);
    mockMedical.mockImplementation(async (_organizationId, athleteId) => {
      if (athleteId === 'ath-2') throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
      return medicalRow('cleared');
    });

    const rows = await getOrganizationClearedTonight('org-1', NOW);

    expect(rows[0].tonight.answer).toBe('cleared');
    expect(rows[1].tonight.answer).toBe('unavailable');
    expect(rows[1].tonight.medical).toBe('unavailable');
  });

  test('a violation count that could not be read says so and leaves the answer alone', async () => {
    mockViolations.mockRejectedValue(new Error('timeout'));

    const [row] = await getOrganizationClearedTonight('org-1', NOW);

    expect(row.tonight.open_violations).toBe('unavailable');
    expect(row.tonight.answer).toBe('cleared');
  });

  // The waiver and consent read fails the way it always has: loudly.
  test('a waiver roster that could not be read is an error, not a roster with consent guessed', async () => {
    mockRoster.mockRejectedValue(new Error('consent read failed'));

    await expect(getOrganizationClearedTonight('org-1', NOW)).rejects.toThrow('consent read failed');
  });

  test('each athlete gets their own hold, and the more restrictive of two', async () => {
    mockRoster.mockResolvedValue([rosterEntry(), rosterEntry({ athleteId: 'ath-2', athleteName: 'Sam R.' })]);
    mockHolds.mockResolvedValue([
      holdRow({ hold_id: 'h1', athlete_id: 'ath-2', scope: 'contact_only' }),
      holdRow({ hold_id: 'h2', athlete_id: 'ath-2', scope: 'all_training' }),
      holdRow({ hold_id: 'h3', athlete_id: 'ath-3', scope: 'all_training' }),
    ]);

    const rows = await getOrganizationClearedTonight('org-1', NOW);

    expect(rows[0].tonight.hold).toBeNull();
    expect(rows[0].tonight.answer).toBe('cleared');
    expect(rows[1].tonight.hold).toMatchObject({ scope: 'all_training' });
    expect(rows[1].tonight.answer).toBe('not_cleared');
  });
});
