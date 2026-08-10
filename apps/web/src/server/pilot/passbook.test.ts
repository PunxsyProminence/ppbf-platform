import { query, queryOne } from './db';
import {
  getAthletePassbook,
  getCoachPassbookGapQueue,
  PASSBOOK_ATTENDANCE_STATUSES,
  PASSBOOK_GYM_STATUSES,
} from './passbook';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

describe('getAthletePassbook', () => {
  test('returns null without reading child tables when the athlete does not exist in the organization', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await expect(getAthletePassbook('org-1', 'ath-missing')).resolves.toBeNull();

    expect(mockQueryOne).toHaveBeenCalledWith(expect.stringContaining('organization_id = $1 and athlete_id = $2'), ['org-1', 'ath-missing']);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('fails closed when the athlete lookup returns a row from another organization', async () => {
    mockQueryOne.mockResolvedValueOnce({
      organization_id: 'org-2',
      athlete_id: 'ath-1',
      full_name: 'Wrong Organization',
      dob: '2010-05-01',
      weight_class: '125',
      gym_status: 'active',
      active_flag: true,
      coach_id: 'coach-1',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    await expect(getAthletePassbook('org-1', 'ath-1')).resolves.toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('assembles the existing athlete tables and makes status-domain drift explicit', async () => {
    mockQueryOne.mockResolvedValueOnce({
      organization_id: 'org-1',
      athlete_id: 'ath-1',
      full_name: 'Avery Boxer',
      dob: '2010-05-01',
      weight_class: '125',
      gym_status: ' Active ',
      active_flag: true,
      coach_id: 'coach-1',
      created_at: '2026-01-01T00:00:00.000Z',
      emergency_contact: 'must not leave the data layer',
      pin_hash: 'must not leave the data layer',
    });
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('from pilot.sessions')) return Promise.resolve([
        { organization_id: 'org-1', session_id: 'session-1', date: '2026-08-01', rpe: 7, notes: '', completed_flag: true, medical_private: 'excluded' },
        { organization_id: 'org-2', session_id: 'session-cross-org', date: '2026-08-01', rpe: 1, notes: 'cross-org', completed_flag: true },
      ]);
      if (sql.includes('from pilot.attendance')) return Promise.resolve([
        { organization_id: 'org-1', attendance_id: 'attendance-1', attendance_date: '2026-08-01', status: ' Present ', notes: '', audit_id: 42 },
        { organization_id: 'org-1', attendance_id: 'attendance-2', attendance_date: '2026-07-30', status: 'excused', notes: 'school event' },
        { organization_id: 'org-2', attendance_id: 'attendance-cross-org', attendance_date: '2026-08-02', status: 'present', notes: 'cross-org' },
      ]);
      if (sql.includes('from pilot.readiness')) return Promise.resolve([{ organization_id: 'org-1', readiness_id: 'ready-1', score: 8, category: 'ready', measured_at: '2026-08-01T12:00:00.000Z', medical_detail: 'excluded' }]);
      if (sql.includes('from pilot.goals')) return Promise.resolve([{ organization_id: 'org-1', goal_id: 'goal-1', title: 'Footwork', target_date: '2026-09-01', metric: 'rounds', status: 'open', private_metadata: 'excluded' }]);
      if (sql.includes('from pilot.coach_observations')) return Promise.resolve([
        { organization_id: 'org-1', note_id: 'note-1', coach_account_id: 'coach-1', note_type: 'weekly_corner', note_text: 'Keep the lead hand home.', created_at: '2026-08-01T12:00:00.000Z', audit_internal: 'excluded' },
        { organization_id: 'org-2', note_id: 'note-cross-org', coach_account_id: 'coach-2', note_type: 'weekly_corner', note_text: 'must not appear', created_at: '2026-08-01T12:00:00.000Z' },
      ]);
      if (sql.includes('from pilot.guardian_links')) return Promise.resolve([
        { organization_id: 'org-1', parent_id: 'parent-1', full_name: 'Jordan Boxer', relationship_to_athlete: 'guardian', phone: '555-0100', email: 'private@example.com', account_id: 'parent-account-1' },
        { organization_id: 'org-2', parent_id: 'parent-cross-org', full_name: 'Wrong Guardian', relationship_to_athlete: 'guardian' },
      ]);
      if (sql.includes('from pilot.progression_gaps')) return Promise.resolve([
        { organization_id: 'org-1', gap_id: 'gap-1', gap_type: 'technique', gap_description: 'Drops lead hand', severity: 'medium', detected_from: 'coach_observation', status: 'identified', created_at: '2026-08-01T12:00:00.000Z', detection_data: { private: true } },
        { organization_id: 'org-2', gap_id: 'gap-cross-org', gap_type: 'technique', gap_description: 'must not appear', severity: 'high', detected_from: 'coach_observation', status: 'identified', created_at: '2026-08-01T12:00:00.000Z' },
      ]);
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await getAthletePassbook('org-1', 'ath-1');

    expect(result?.pages.attendance).toEqual([
      expect.objectContaining({ canonical_status: 'present', stamp_code: 'PRESENT', domain_status: 'canonical' }),
      expect.objectContaining({ status: 'excused', canonical_status: null, stamp_code: null, domain_status: 'unsupported' }),
    ]);
    expect(result?.pages.corner).toEqual({
      coach: { account_id: 'coach-1' },
      guardians: [expect.objectContaining({ parent_id: 'parent-1' })],
      observations: [expect.objectContaining({ note_id: 'note-1', note_text: 'Keep the lead hand home.' })],
    });
    expect(result?.pages.sessions).toHaveLength(1);
    expect(result?.pages.readiness).toHaveLength(1);
    expect(result?.pages.goals).toHaveLength(1);
    expect(result?.pages.progression_gaps).toHaveLength(1);
    expect(Object.keys(result ?? {}).sort()).toEqual(['athlete', 'pages', 'status_domains']);
    expect(Object.keys(result?.athlete ?? {}).sort()).toEqual([
      'active_flag',
      'athlete_id',
      'canonical_gym_status',
      'coach_id',
      'created_at',
      'dob',
      'full_name',
      'gym_status',
      'gym_status_domain',
      'weight_class',
    ]);
    expect(Object.keys(result?.pages ?? {}).sort()).toEqual([
      'attendance',
      'corner',
      'goals',
      'progression_gaps',
      'readiness',
      'sessions',
    ]);
    expect(Object.keys(result?.pages.corner.guardians[0] ?? {}).sort()).toEqual([
      'full_name',
      'parent_id',
      'relationship_to_athlete',
    ]);
    expect(Object.keys(result?.pages.sessions[0] ?? {}).sort()).toEqual([
      'completed_flag',
      'date',
      'notes',
      'rpe',
      'session_id',
    ]);
    expect(Object.keys(result?.pages.attendance[0] ?? {}).sort()).toEqual([
      'attendance_date',
      'attendance_id',
      'canonical_status',
      'domain_status',
      'notes',
      'stamp_code',
      'status',
    ]);
    expect(Object.keys(result?.pages.readiness[0] ?? {}).sort()).toEqual([
      'category',
      'measured_at',
      'readiness_id',
      'score',
    ]);
    expect(Object.keys(result?.pages.goals[0] ?? {}).sort()).toEqual([
      'goal_id',
      'metric',
      'status',
      'target_date',
      'title',
    ]);
    expect(Object.keys(result?.pages.corner.observations[0] ?? {}).sort()).toEqual([
      'coach_account_id',
      'created_at',
      'note_id',
      'note_text',
      'note_type',
    ]);
    expect(Object.keys(result?.pages.progression_gaps[0] ?? {}).sort()).toEqual([
      'created_at',
      'detected_from',
      'gap_description',
      'gap_id',
      'gap_type',
      'severity',
      'status',
    ]);
    const serialized = JSON.stringify(result);
    for (const excludedKey of [
      'organization_id',
      'emergency_contact',
      'phone',
      'email',
      'pin_hash',
      'login_email',
      'audit_id',
      'audit_internal',
      'medical_private',
      'medical_detail',
      'private_metadata',
      'detection_data',
    ]) {
      expect(serialized).not.toContain(`"${excludedKey}"`);
    }
    expect(serialized).not.toContain('cross-org');
    expect(serialized).not.toContain('must not appear');
    expect(result?.status_domains).toEqual({
      attendance: {
        canonical_values: PASSBOOK_ATTENDANCE_STATUSES,
        unsupported_values: ['excused'],
      },
      gym_status: {
        canonical_values: PASSBOOK_GYM_STATUSES,
        unsupported_value: null,
        note: 'gym_status is a roster membership state, not a stamp code',
      },
    });
    expect(result?.athlete.gym_status_domain).toBe('canonical');
    expect(result?.athlete.canonical_gym_status).toBe('active');
    expect(mockQuery).toHaveBeenCalledTimes(7);
    for (const call of mockQuery.mock.calls) {
      expect(call[0]).toContain('organization_id');
      expect(call[1]).toEqual(['org-1', 'ath-1']);
    }
    const childSql = mockQuery.mock.calls.map((call) => call[0] as string);
    for (const table of ['sessions', 'attendance', 'readiness', 'goals', 'coach_observations', 'progression_gaps']) {
      const sql = childSql.find((candidate) => candidate.includes(`from pilot.${table}`));
      expect(sql).toContain('where organization_id = $1 and athlete_id = $2');
    }
    const guardianSql = childSql.find((candidate) => candidate.includes('from pilot.guardian_links')) ?? '';
    expect(guardianSql).toContain('p.organization_id = g.organization_id');
    expect(guardianSql).toContain('where g.organization_id = $1 and g.athlete_id = $2');
  });

  test('reports an unsupported gym membership value without coercing it', async () => {
    mockQueryOne.mockResolvedValueOnce({
      organization_id: 'org-1',
      athlete_id: 'ath-1',
      full_name: 'Avery Boxer',
      dob: '2010-05-01',
      weight_class: '125',
      gym_status: 'paused',
      active_flag: true,
      coach_id: 'coach-1',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    mockQuery.mockResolvedValue([]);

    const result = await getAthletePassbook('org-1', 'ath-1');

    expect(result?.athlete.gym_status).toBe('paused');
    expect(result?.athlete.canonical_gym_status).toBeNull();
    expect(result?.athlete.gym_status_domain).toBe('unsupported');
    expect(result?.status_domains.gym_status.unsupported_value).toBe('paused');
  });
});

describe('getCoachPassbookGapQueue', () => {
  test('scopes a coach queue to assigned athletes and includes attendance context', async () => {
    mockQuery.mockResolvedValueOnce([
      {
        organization_id: 'org-1', gap_id: 'gap-assigned', gap_type: 'technique', gap_description: 'assigned',
        severity: 'high', detected_from: 'attendance', status: 'identified', created_at: '2026-08-01T00:00:00.000Z',
        athlete_id: 'ath-1', athlete_name: 'Assigned Athlete', coach_id: 'coach-1', last_attended_on: '2026-07-01',
        recorded_absences_since_last_visit: 3, detection_data: { private: true },
      },
      {
        organization_id: 'org-1', gap_id: 'gap-unassigned', gap_type: 'technique', gap_description: 'unassigned',
        severity: 'high', detected_from: 'attendance', status: 'identified', created_at: '2026-08-01T00:00:00.000Z',
        athlete_id: 'ath-2', athlete_name: 'Unassigned Athlete', coach_id: 'coach-2', last_attended_on: null,
        recorded_absences_since_last_visit: 4,
      },
      {
        organization_id: 'org-2', gap_id: 'gap-cross-org', gap_type: 'technique', gap_description: 'cross-org',
        severity: 'critical', detected_from: 'attendance', status: 'identified', created_at: '2026-08-01T00:00:00.000Z',
        athlete_id: 'ath-3', athlete_name: 'Other Organization', coach_id: 'coach-1', last_attended_on: null,
        recorded_absences_since_last_visit: 9,
      },
    ]);

    const result = await getCoachPassbookGapQueue('org-1', 'coach-1');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('and ($2::text is null or a.coach_id = $2)'),
      ['org-1', 'coach-1'],
    );
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("g.status not in ('completed', 'deferred')");
    expect(sql).toContain('join pilot.athletes a');
    expect(sql).toContain('a.organization_id = g.organization_id');
    expect(sql).toContain('where g.organization_id = $1');
    expect(sql).toContain("lower(trim(status)) in ('present', 'late')");
    expect(sql).toContain("lower(trim(status)) = 'absent'");
    expect(sql.match(/organization_id = g\.organization_id/g)).toHaveLength(3);
    expect(result).toEqual([
      {
        gap_id: 'gap-assigned', gap_type: 'technique', gap_description: 'assigned', severity: 'high',
        detected_from: 'attendance', status: 'identified', created_at: '2026-08-01T00:00:00.000Z',
        athlete_id: 'ath-1', athlete_name: 'Assigned Athlete', coach_id: 'coach-1',
        last_attended_on: '2026-07-01', recorded_absences_since_last_visit: 3,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('organization_id');
    expect(JSON.stringify(result)).not.toContain('detection_data');
  });

  test('uses null coach scope for an organization-wide admin queue while retaining organization isolation', async () => {
    mockQuery.mockResolvedValueOnce([
      {
        organization_id: 'org-1', gap_id: 'gap-org-1', gap_type: 'technique', gap_description: 'same org',
        severity: 'medium', detected_from: 'attendance', status: 'identified', created_at: '2026-08-01T00:00:00.000Z',
        athlete_id: 'ath-1', athlete_name: 'Same Organization', coach_id: 'coach-2', last_attended_on: null,
        recorded_absences_since_last_visit: 2,
      },
      {
        organization_id: 'org-2', gap_id: 'gap-org-2', gap_type: 'technique', gap_description: 'other org',
        severity: 'critical', detected_from: 'attendance', status: 'identified', created_at: '2026-08-01T00:00:00.000Z',
        athlete_id: 'ath-2', athlete_name: 'Other Organization', coach_id: 'coach-2', last_attended_on: null,
        recorded_absences_since_last_visit: 9,
      },
    ]);

    const result = await getCoachPassbookGapQueue('org-1', null);

    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ['org-1', null]);
    expect(result.map((item) => item.gap_id)).toEqual(['gap-org-1']);
  });
});
