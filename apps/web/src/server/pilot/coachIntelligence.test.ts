import { COMPLIANCE_VIOLATION_OPEN_STATUSES } from './compliance';
import { query } from './db';
import { listEscalations } from './escalationLadder';
import { getPerformanceRollup } from './performanceAnalytics';
import {
  ATTENDANCE_WINDOW_DAYS,
  ESCALATION_DIGEST_STATUS,
  HOLD_EXPIRY_DAYS,
  READINESS_RED_DAYS,
  READINESS_RED_WINDOW_DAYS,
  STALLED_GAP_DAYS,
  UNREVIEWED_SESSION_DAYS,
  getCoachIntelligence,
} from './coachIntelligence';
import { TRAINING_DAYS_MIN_EARLY, TRAINING_DAYS_DROP_RATIO } from './progressionSuggestions';

// The owner-approved definition, pinned: every item is a stored fact plus a
// named threshold; the attendance rule REUSES the gap-suggestion constants
// (imported, not restated); an empty roster never queries; and the fading
// filter applies the exact half-drop rule.
//
// Items 6 and 7 are pinned harder than the rest, because their absence was
// the defect: a digest blind to pilot.safety_escalations and
// pilot.compliance_violations reported "nothing needs your eyes" for a child
// with an open safeguarding record. These tests fail if either register stops
// being read, if the athlete_voice exclusion is dropped, if the org or roster
// scope loosens, or if "open" starts meaning something local to this module.

jest.mock('./db', () => ({ query: jest.fn() }));
jest.mock('./performanceAnalytics', () => ({ getPerformanceRollup: jest.fn() }));
jest.mock('./escalationLadder', () => ({ listEscalations: jest.fn() }));

const mockQuery = query as jest.Mock;
const mockRollup = getPerformanceRollup as jest.Mock;
const mockListEscalations = listEscalations as jest.Mock;

beforeEach(() => {
  // The two safety reads default to "nothing filed" so a test that is about
  // one of the other five items does not have to know they exist.
  mockListEscalations.mockResolvedValue([]);
});

afterEach(() => {
  jest.clearAllMocks();
});

test('the thresholds are the approved definition, and attendance reuses the suggestion constants', () => {
  expect(STALLED_GAP_DAYS).toBe(14);
  expect(READINESS_RED_DAYS).toBe(3);
  expect(READINESS_RED_WINDOW_DAYS).toBe(7);
  expect(UNREVIEWED_SESSION_DAYS).toBe(7);
  expect(HOLD_EXPIRY_DAYS).toBe(14);
  expect(ATTENDANCE_WINDOW_DAYS).toBe(28);
  // The reuse is the point: one attendance rule, two consumers, no drift.
  expect(TRAINING_DAYS_MIN_EARLY).toBe(3);
  expect(TRAINING_DAYS_DROP_RATIO).toBe(0.5);
});

test('an empty roster returns an empty digest without touching the database', async () => {
  const digest = await getCoachIntelligence('org-1', []);

  expect(digest).toEqual({
    open_safety_escalations: [], open_compliance_violations: [],
    stalled_gaps: [], readiness_concerns: [], fading_attendance: [], unreviewed_sessions: [], expiring_holds: [],
  });
  expect(mockQuery).not.toHaveBeenCalled();
  expect(mockRollup).not.toHaveBeenCalled();
  // No roster means no athlete to be scoped to, so the safety registers are
  // not consulted either -- a listEscalations call with an empty athleteIds
  // array would be a read this caller has no subject for.
  expect(mockListEscalations).not.toHaveBeenCalled();
});

test('the digest shape declares the two safety registers first', async () => {
  mockQuery.mockResolvedValue([]);
  mockRollup.mockResolvedValue([]);

  const digest = await getCoachIntelligence('org-1', ['ath-1']);

  // Key order is the only ordering this object carries and the page reads it
  // as precedence. A safeguarding item must not land below attendance.
  expect(Object.keys(digest)).toEqual([
    'open_safety_escalations',
    'open_compliance_violations',
    'stalled_gaps',
    'readiness_concerns',
    'fading_attendance',
    'unreviewed_sessions',
    'expiring_holds',
  ]);
});

test('the queries carry the org scope, the thresholds, and the no-assignment/no-review exclusions', async () => {
  mockQuery.mockResolvedValue([]);
  mockRollup.mockResolvedValue([]);

  await getCoachIntelligence('org-1', ['ath-1']);

  const sqls = mockQuery.mock.calls.map((call) => String(call[0]));
  const gapSql = sqls.find((sql) => sql.includes('progression_gaps'));
  expect(gapSql).toContain("g.status = 'identified'");
  expect(gapSql).toContain('not exists');
  const sessionSql = sqls.find((sql) => sql.includes('pilot.sessions'));
  expect(sessionSql).toContain('completed_flag = true');
  expect(sessionSql).toContain('not exists');
  const readinessSql = sqls.find((sql) => sql.includes('pilot.readiness'));
  expect(readinessSql).toContain('distinct on (r.athlete_id, r.measured_at::date)');
  const holdSql = sqls.find((sql) => sql.includes('training_holds'));
  expect(holdSql).toContain("h.status = 'active'");
  for (const call of mockQuery.mock.calls) {
    expect(call[1][0]).toBe('org-1');
  }
  expect(mockRollup).toHaveBeenCalledWith('org-1', ['ath-1'], ATTENDANCE_WINDOW_DAYS);
});

test('the fading filter applies the half-drop rule exactly, with names from the roster read', async () => {
  // Name query resolves for everyone; other queries return nothing.
  mockQuery.mockImplementation(async (sql: string) => {
    if (String(sql).includes('full_name from pilot.athletes')) {
      return [
        { athlete_id: 'ath-fading', full_name: 'Rosa D.' },
        { athlete_id: 'ath-fine', full_name: 'Sam R.' },
        { athlete_id: 'ath-new', full_name: 'Kim L.' },
      ];
    }
    return [];
  });
  mockRollup.mockResolvedValue([
    // 6 -> 2 training days: under half of early -- fading.
    { athlete_id: 'ath-fading', training_days_early: 6, training_days_late: 2 },
    // 6 -> 3: exactly half is NOT under half -- fine.
    { athlete_id: 'ath-fine', training_days_early: 6, training_days_late: 3 },
    // 2 -> 0: early below the minimum floor -- too little signal to flag.
    { athlete_id: 'ath-new', training_days_early: 2, training_days_late: 0 },
  ]);

  const digest = await getCoachIntelligence('org-1', ['ath-fading', 'ath-fine', 'ath-new']);

  expect(digest.fading_attendance).toEqual([
    { athlete_id: 'ath-fading', athlete_name: 'Rosa D.', training_days_early: 6, training_days_late: 2 },
  ]);
});

// ─── item 6: open safety escalations (#194) ──────────────────────────────────

test('item 6 reads the escalation ladder, open only, roster-scoped, athlete_voice excluded', async () => {
  mockQuery.mockResolvedValue([]);
  mockRollup.mockResolvedValue([]);

  await getCoachIntelligence('org-1', ['ath-1', 'ath-2']);

  // Delegated, not re-queried: the digest must not carry its own copy of the
  // escalation SQL, and it must not widen any of the three filters.
  expect(mockListEscalations).toHaveBeenCalledWith('org-1', {
    status: ESCALATION_DIGEST_STATUS,
    athleteIds: ['ath-1', 'ath-2'],
    excludeAthleteVoice: true,
  });
  expect(ESCALATION_DIGEST_STATUS).toBe('open');
  // Nothing here writes to pilot.safety_escalations -- the digest stores
  // nothing at all, which is the register-111 contract.
  for (const call of mockQuery.mock.calls) {
    expect(String(call[0]).toLowerCase()).not.toContain('insert');
    expect(String(call[0]).toLowerCase()).not.toContain('update');
  }
});

test('item 6 surfaces an open escalation with the roster name, narrowed to the digest shape', async () => {
  mockQuery.mockImplementation(async (sql: string) => {
    if (String(sql).includes('full_name from pilot.athletes')) {
      return [{ athlete_id: 'ath-1', full_name: 'Rosa D.' }];
    }
    return [];
  });
  mockRollup.mockResolvedValue([]);
  mockListEscalations.mockResolvedValue([
    {
      escalation_id: 'esc-1',
      source_type: 'pain_report',
      source_id: 'pain-9',
      athlete_id: 'ath-1',
      severity: 'critical',
      reason: 'Reported sharp elbow pain during bag work.',
      escalated_to_role: 'organization_admin',
      triggered_by: 'system',
      triggered_by_account_id: null,
      triggered_by_role: null,
      status: 'open',
      acknowledged_by_account_id: null,
      acknowledged_at: null,
      resolved_by_account_id: null,
      resolved_at: null,
      resolution_note: '',
      metadata: { trigger: 'pain' },
      created_at: '2026-08-16T12:00:00.000Z',
      updated_at: '2026-08-16T12:00:00.000Z',
    },
  ]);

  const digest = await getCoachIntelligence('org-1', ['ath-1']);

  // Exactly the item shape, and only it: resolution notes, acknowledging
  // accounts, and the metadata blob stay on the surface that can act on them.
  expect(digest.open_safety_escalations).toEqual([
    {
      athlete_id: 'ath-1',
      athlete_name: 'Rosa D.',
      escalation_id: 'esc-1',
      source_type: 'pain_report',
      severity: 'critical',
      reason: 'Reported sharp elbow pain during bag work.',
      created_at: '2026-08-16T12:00:00.000Z',
    },
  ]);
});

test('an athlete whose ONLY signal is an open escalation still produces a non-empty digest', async () => {
  // The defect itself, pinned. Every other register is silent for this
  // athlete; before item 6 existed the digest came back with zero items and
  // the page printed "Nothing needs your eyes" over an open safety record.
  mockQuery.mockResolvedValue([]);
  mockRollup.mockResolvedValue([]);
  mockListEscalations.mockResolvedValue([
    {
      escalation_id: 'esc-2', source_type: 'near_miss', source_id: null, athlete_id: 'ath-9',
      severity: 'high', reason: 'Sparring without a mouthguard.', escalated_to_role: 'organization_admin',
      triggered_by: 'system', triggered_by_account_id: null, triggered_by_role: null, status: 'open',
      acknowledged_by_account_id: null, acknowledged_at: null, resolved_by_account_id: null,
      resolved_at: null, resolution_note: '', metadata: {},
      created_at: '2026-08-17T06:00:00.000Z', updated_at: '2026-08-17T06:00:00.000Z',
    },
  ]);

  const digest = await getCoachIntelligence('org-1', ['ath-9']);

  const itemCount = Object.values(digest).reduce((sum, items) => sum + items.length, 0);
  expect(itemCount).toBe(1);
  expect(digest.open_safety_escalations).toHaveLength(1);
});

// compliance.ts files an escalation with source_type 'compliance_violation' on
// the same transaction as the violation insert, so most violations now land in
// BOTH registers this digest reads. Without the filter a coach sees one
// incident twice, in two sections, under two vocabularies. Item 7 is the side
// that survives: it reads the authoritative row, and it also covers the
// 'board'/'parent' rules that produce no escalation at all.
test('a compliance-derived escalation is reported once, by item 7, not twice', async () => {
  mockRollup.mockResolvedValue([]);
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('pilot.compliance_violations')) {
      return [{
        athlete_id: 'ath-1',
        athlete_name: 'Rosa D.',
        violation_id: 'viol-1',
        rule_id: 'rule-mouthguard',
        rule_name: 'Mouthguard required for contact',
        severity: 'high',
        status: 'new',
        days_open: 2,
      }];
    }
    if (sql.includes('full_name')) return [{ athlete_id: 'ath-1', full_name: 'Rosa D.' }];
    return [];
  });
  mockListEscalations.mockResolvedValue([
    {
      escalation_id: 'esc-from-viol', source_type: 'compliance_violation', source_id: 'viol-1',
      athlete_id: 'ath-1', severity: 'high', reason: 'Mouthguard required for contact',
      escalated_to_role: 'organization_admin', triggered_by: 'system',
      triggered_by_account_id: null, triggered_by_role: null, status: 'open',
      acknowledged_by_account_id: null, acknowledged_at: null, resolved_by_account_id: null,
      resolved_at: null, resolution_note: '', metadata: {},
      created_at: '2026-08-17T06:00:00.000Z', updated_at: '2026-08-17T06:00:00.000Z',
    },
  ]);

  const digest = await getCoachIntelligence('org-1', ['ath-1']);

  // The escalation half is dropped; the violation half remains.
  expect(digest.open_safety_escalations).toHaveLength(0);
  expect(digest.open_compliance_violations).toHaveLength(1);
  expect(digest.open_compliance_violations[0].violation_id).toBe('viol-1');
});

test('every other escalation source still reaches item 6', async () => {
  // The dedup must be surgical. Only 'compliance_violation' is item 7's;
  // if this filter ever widens, a real safeguarding record goes silent.
  mockQuery.mockResolvedValue([]);
  mockRollup.mockResolvedValue([]);
  const OTHER_SOURCES = [
    'near_miss', 'pain_report', 'safety_gate_evaluation',
    'repeated_pattern', 'training_hold', 'incident', 'video_scan',
  ];
  mockListEscalations.mockResolvedValue(OTHER_SOURCES.map((source_type, i) => ({
    escalation_id: `esc-${i}`, source_type, source_id: null, athlete_id: 'ath-1',
    severity: 'high', reason: `${source_type} reason`, escalated_to_role: 'organization_admin',
    triggered_by: 'system', triggered_by_account_id: null, triggered_by_role: null, status: 'open',
    acknowledged_by_account_id: null, acknowledged_at: null, resolved_by_account_id: null,
    resolved_at: null, resolution_note: '', metadata: {},
    created_at: '2026-08-17T06:00:00.000Z', updated_at: '2026-08-17T06:00:00.000Z',
  })));

  const digest = await getCoachIntelligence('org-1', ['ath-1']);

  expect(digest.open_safety_escalations).toHaveLength(OTHER_SOURCES.length);
  expect(digest.open_safety_escalations.map((e) => e.source_type).sort()).toEqual([...OTHER_SOURCES].sort());
});

// ─── item 7: open compliance violations ──────────────────────────────────────

function violationSql(): string {
  const sql = mockQuery.mock.calls
    .map((call) => String(call[0]))
    .find((text) => text.includes('pilot.compliance_violations'));
  if (!sql) throw new Error('the digest never queried pilot.compliance_violations');
  return sql;
}

test('item 7 queries compliance violations with the imported open-status list, org and roster scoped', async () => {
  mockQuery.mockResolvedValue([]);
  mockRollup.mockResolvedValue([]);

  await getCoachIntelligence('org-1', ['ath-1']);

  const sql = violationSql();
  expect(sql).toContain('v.organization_id = $1');
  expect(sql).toContain('v.athlete_id = any($2::text[])');
  expect(sql).toContain('v.status = any($3::text[])');
  // A missing or cross-org rule row must not drop a violation off a safety
  // list, so the rule is a LEFT join with the id as the fallback label.
  expect(sql).toContain('left join pilot.compliance_rules');
  expect(sql).toContain('coalesce(r.rule_name, v.rule_id)');

  const call = mockQuery.mock.calls.find((entry) => String(entry[0]).includes('pilot.compliance_violations'));
  expect(call?.[1]).toEqual(['org-1', ['ath-1'], ['new', 'acknowledged', 'escalated']]);
  // The list is compliance.ts's, not a local copy: this is the assertion that
  // fails if the two ever disagree about what "open" means.
  expect(call?.[1]?.[2]).toEqual([...COMPLIANCE_VIOLATION_OPEN_STATUSES]);
  // 'resolved' and 'dismissed' are terminal and must never be listed as open.
  expect(COMPLIANCE_VIOLATION_OPEN_STATUSES).not.toContain('resolved');
  expect(COMPLIANCE_VIOLATION_OPEN_STATUSES).not.toContain('dismissed');
  // An acknowledged violation stays on the coach's read: acknowledgement is
  // an admin action and says nothing about whether the coach has seen it.
  expect(COMPLIANCE_VIOLATION_OPEN_STATUSES).toContain('acknowledged');
});

test('item 7 passes the stored violation rows straight through as the digest item', async () => {
  const row = {
    athlete_id: 'ath-1', athlete_name: 'Rosa D.', violation_id: 'violation_1', rule_id: 'rule-headgear',
    rule_name: 'Headgear required for contact', severity: 'high', status: 'new', days_open: 4,
  };
  mockQuery.mockImplementation(async (sql: string) => (
    String(sql).includes('pilot.compliance_violations') ? [row] : []
  ));
  mockRollup.mockResolvedValue([]);

  const digest = await getCoachIntelligence('org-1', ['ath-1']);

  expect(digest.open_compliance_violations).toEqual([row]);
});

test('an athlete whose ONLY signal is an open violation still produces a non-empty digest', async () => {
  mockQuery.mockImplementation(async (sql: string) => (
    String(sql).includes('pilot.compliance_violations')
      ? [{
        athlete_id: 'ath-9', athlete_name: 'Kim L.', violation_id: 'violation_2', rule_id: 'rule-sparring',
        rule_name: 'No sparring without clearance', severity: 'critical', status: 'escalated', days_open: 11,
      }]
      : []
  ));
  mockRollup.mockResolvedValue([]);

  const digest = await getCoachIntelligence('org-1', ['ath-9']);

  const itemCount = Object.values(digest).reduce((sum, items) => sum + items.length, 0);
  expect(itemCount).toBe(1);
  expect(digest.open_compliance_violations).toHaveLength(1);
});
