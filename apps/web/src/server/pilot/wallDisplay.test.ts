import { MILESTONES } from '../../../components/TrainingCard';
import {
  ADULT_AGE_YEARS,
  DISPLAY_CONSENT_MAX_AGE_DAYS,
  MARQUEE_MAX,
  MARQUEE_WINDOW_DAYS,
  ON_FLOOR_MAX,
  WALL_DISPLAY_CONSENT_TYPES,
  WALL_MILESTONES,
  ageInYears,
  buildWallBoard,
  formatYmdInZone,
  gymDayBounds,
  isMinor,
  pickNotice,
  renderWallName,
  resolveDisplayVisibility,
  resolveWallNameMode,
  selectMarquee,
  shiftYmd,
  wallKey,
  type WallAthleteRow,
  type WallBoardSources,
  type WallNameMode,
  type WallWaiverRow,
} from './wallDisplay';

const NOW = new Date('2026-08-03T18:30:00.000Z'); // 2:30pm in America/New_York
const ZONE = 'America/New_York';

const CHILD: WallAthleteRow = { athlete_id: 'ath-1', full_name: 'Marcus Ruiz', dob: '2012-04-09' };
const ADULT: WallAthleteRow = { athlete_id: 'ath-2', full_name: 'Dana Okafor', dob: '1991-01-20' };

function waiver(over: Partial<WallWaiverRow> = {}): WallWaiverRow {
  return {
    athlete_id: 'ath-1',
    waiver_type: 'wall_display_first_name',
    status: 'signed',
    signed_by_role: 'guardian',
    signed_at: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

function decide(input: {
  athlete?: WallAthleteRow;
  waivers?: WallWaiverRow[];
  mode?: WallNameMode;
  now?: Date;
}) {
  return resolveDisplayVisibility({
    athlete: input.athlete ?? CHILD,
    waivers: input.waivers ?? [],
    now: input.now ?? NOW,
    mode: input.mode ?? 'consent',
  });
}

/* ------------------------------------------------------------------------ */

describe('the consent gate', () => {
  it('shows initials when no display consent exists at all', () => {
    // The state the platform is actually in today: pilot.waivers has no row
    // that names this screen, because nothing writes one yet. That must read
    // as a refusal, not as a gap to be filled with a default.
    expect(decide({})).toEqual({ visibility: 'initials', reason: 'no_display_consent' });
  });

  it('does not accept an unrelated signed waiver as permission to publish a name', () => {
    // 'general' is what every writer in the codebase defaults waiver_type to.
    // If that counted, every athlete with any paperwork on file would be named
    // on a public screen the day this shipped.
    for (const type of ['general', 'medical_form', 'liability', 'waiver_consent', 'photo']) {
      expect(decide({ waivers: [waiver({ waiver_type: type })] })).toEqual({
        visibility: 'initials',
        reason: 'no_display_consent',
      });
    }
  });

  it('grants first name on an explicit, guardian-signed, current release', () => {
    expect(decide({ waivers: [waiver()] })).toEqual({ visibility: 'first_name', reason: 'granted' });
  });

  it('grants a full name only on the release that names a full name', () => {
    expect(decide({ waivers: [waiver({ waiver_type: 'wall_display_full_name' })] })).toEqual({
      visibility: 'full_name',
      reason: 'granted',
    });
  });

  it('refuses a status that is not affirmative, including pending', () => {
    for (const status of ['pending', 'revoked', 'withdrawn', 'expired', 'declined', '', 'yes']) {
      expect(decide({ waivers: [waiver({ status })] }).visibility).toBe('initials');
    }
  });

  it('lets a withdrawal supersede an earlier grant', () => {
    const decision = decide({
      waivers: [
        waiver({ signed_at: '2026-03-01T00:00:00.000Z', status: 'signed' }),
        waiver({ signed_at: '2026-05-01T00:00:00.000Z', status: 'revoked' }),
      ],
    });
    expect(decision).toEqual({ visibility: 'initials', reason: 'consent_withdrawn' });
  });

  it('lets a fresh grant supersede an earlier withdrawal', () => {
    // A family that changed its mind twice must not be locked out forever.
    const decision = decide({
      waivers: [
        waiver({ signed_at: '2026-03-01T00:00:00.000Z', status: 'revoked' }),
        waiver({ signed_at: '2026-05-01T00:00:00.000Z', status: 'signed' }),
      ],
    });
    expect(decision).toEqual({ visibility: 'first_name', reason: 'granted' });
  });

  it('resolves a same-instant tie toward the more restrictive row', () => {
    const at = '2026-05-01T00:00:00.000Z';
    const decision = decide({
      waivers: [
        waiver({ signed_at: at, waiver_type: 'wall_display_full_name' }),
        waiver({ signed_at: at, waiver_type: 'wall_display_first_name' }),
      ],
    });
    expect(decision.visibility).toBe('first_name');
  });

  it('refuses a release older than the staleness window', () => {
    const stale = new Date(NOW.getTime() - (DISPLAY_CONSENT_MAX_AGE_DAYS + 1) * 86_400_000);
    expect(decide({ waivers: [waiver({ signed_at: stale.toISOString() })] })).toEqual({
      visibility: 'initials',
      reason: 'consent_expired',
    });
  });

  it('refuses a future-dated signature', () => {
    const ahead = new Date(NOW.getTime() + 86_400_000);
    expect(decide({ waivers: [waiver({ signed_at: ahead.toISOString() })] }).visibility).toBe('initials');
  });

  it('refuses an undated or unparseable signature', () => {
    expect(decide({ waivers: [waiver({ signed_at: null })] }).reason).toBe('consent_undated');
    expect(decide({ waivers: [waiver({ signed_at: 'sometime last spring' })] }).reason).toBe('consent_undated');
  });

  it('refuses a release for a minor that a guardian did not sign', () => {
    // Specifically including the roles that run the gym: an administrator
    // cannot put a child's name up by signing the form themselves.
    for (const role of ['athlete', 'coach', 'admin', 'organization_admin', 'staff', 'self', '']) {
      expect(decide({ waivers: [waiver({ signed_by_role: role })] })).toEqual({
        visibility: 'initials',
        reason: 'signer_not_guardian',
      });
    }
  });

  it('lets an adult sign for themselves', () => {
    expect(
      decide({
        athlete: ADULT,
        waivers: [waiver({ athlete_id: ADULT.athlete_id, signed_by_role: 'self' })],
      }),
    ).toEqual({ visibility: 'first_name', reason: 'granted' });
  });

  it('treats an unknown date of birth as a minor', () => {
    // An incomplete record must not be read as "adult, publish freely".
    const unknown: WallAthleteRow = { athlete_id: 'ath-3', full_name: 'Sam Vance', dob: null };
    expect(
      resolveDisplayVisibility({
        athlete: unknown,
        waivers: [waiver({ athlete_id: 'ath-3', signed_by_role: 'self' })],
        now: NOW,
        mode: 'consent',
      }).reason,
    ).toBe('signer_not_guardian');
  });

  it('never reads another athlete\'s waiver', () => {
    expect(decide({ athlete: ADULT, waivers: [waiver({ athlete_id: 'ath-1' })] }).visibility).toBe('initials');
  });

  it('ignores case and padding in the vocabulary fields', () => {
    expect(
      decide({
        waivers: [waiver({ waiver_type: '  WALL_Display_First_Name ', status: ' Signed ', signed_by_role: 'Parent' })],
      }).visibility,
    ).toBe('first_name');
  });
});

describe('the operator switch', () => {
  it('defaults to initials for anything it does not recognise', () => {
    for (const raw of [undefined, null, '', '  ', 'true', 'yes', 'names', 'full']) {
      expect(resolveWallNameMode(raw)).toBe('initials');
    }
  });

  it('accepts only the three modes, case-insensitively', () => {
    expect(resolveWallNameMode('off')).toBe('off');
    expect(resolveWallNameMode('CONSENT')).toBe('consent');
    expect(resolveWallNameMode(' initials ')).toBe('initials');
  });

  it('can only ever reduce what consent allows, never raise it', () => {
    const granted = [waiver({ waiver_type: 'wall_display_full_name' })];
    expect(decide({ waivers: granted, mode: 'consent' }).visibility).toBe('full_name');
    expect(decide({ waivers: granted, mode: 'initials' }).visibility).toBe('initials');
    expect(decide({ waivers: granted, mode: 'off' }).visibility).toBe('initials');
  });
});

describe('renderWallName', () => {
  it('reduces to initials by default', () => {
    expect(renderWallName('Marcus Ruiz', 'initials')).toBe('M.R.');
    expect(renderWallName('Ana Sofia Delgado', 'initials')).toBe('A.S.D.');
    expect(renderWallName('Cher', 'initials')).toBe('C.');
  });

  it('prints only the first word at first-name scope', () => {
    expect(renderWallName('Ana Sofia Delgado', 'first_name')).toBe('Ana');
  });

  it('prints the whole name only at full-name scope', () => {
    expect(renderWallName('  Ana   Sofia Delgado ', 'full_name')).toBe('Ana Sofia Delgado');
  });

  it('says nothing rather than guessing when the name is blank', () => {
    for (const visibility of ['initials', 'first_name', 'full_name'] as const) {
      expect(renderWallName('   ', visibility)).toBe('—');
    }
  });
});

describe('wallKey', () => {
  it('is stable, opaque, and does not contain the athlete id', () => {
    const key = wallKey('ppbf-default-org', 'ath-1');
    expect(key).toBe(wallKey('ppbf-default-org', 'ath-1'));
    expect(key).not.toContain('ath-1');
    expect(key).not.toBe(wallKey('ppbf-default-org', 'ath-2'));
  });
});

describe('age', () => {
  it('reads a calendar date of birth without inventing a timezone', () => {
    expect(ageInYears('2012-04-09', NOW)).toBe(14);
    // The day before a birthday is still the younger age.
    expect(ageInYears('2008-08-04', NOW)).toBe(17);
    expect(ageInYears('2008-08-03', NOW)).toBe(18);
  });

  it('returns null, and therefore minor, for anything unreadable', () => {
    for (const dob of [null, undefined, '', 'unknown', '04/09/2012', '2012-13-01']) {
      expect(ageInYears(dob, NOW)).toBeNull();
      expect(isMinor(dob, NOW)).toBe(true);
    }
  });

  it('uses 18 as the line', () => {
    expect(ADULT_AGE_YEARS).toBe(18);
  });
});

describe('the gym day', () => {
  it('is the gym\'s day, not the server\'s', () => {
    // 00:30 UTC on Aug 4 is 8:30pm on Aug 3 in Punxsutawney -- mid evening
    // class. A UTC server would have rolled the board over to tomorrow and
    // dropped the class that is running.
    const lateEvening = new Date('2026-08-04T00:30:00.000Z');
    expect(formatYmdInZone(lateEvening, ZONE)).toBe('2026-08-03');
    expect(gymDayBounds(lateEvening, ZONE).ymd).toBe('2026-08-03');
  });

  it('brackets exactly 24 hours from local midnight in summer', () => {
    const { startUtc, endUtc } = gymDayBounds(NOW, ZONE);
    expect(startUtc.toISOString()).toBe('2026-08-03T04:00:00.000Z'); // EDT, UTC-4
    expect(endUtc.getTime() - startUtc.getTime()).toBe(86_400_000);
  });

  it('lands on the right offset in winter too', () => {
    const winter = new Date('2026-01-15T18:30:00.000Z');
    expect(gymDayBounds(winter, ZONE).startUtc.toISOString()).toBe('2026-01-15T05:00:00.000Z'); // EST, UTC-5
  });

  it('handles the spring-forward day, where local midnight is not 24h before', () => {
    // 2026-03-08 is the US DST transition. Midnight is still midnight; the
    // single-pass version of this calculation lands an hour out.
    const dstDay = new Date('2026-03-08T18:00:00.000Z');
    expect(gymDayBounds(dstDay, ZONE).startUtc.toISOString()).toBe('2026-03-08T05:00:00.000Z');
  });

  it('shifts calendar days without drifting across a DST boundary', () => {
    expect(shiftYmd('2026-03-09', -1)).toBe('2026-03-08');
    expect(shiftYmd('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftYmd('2026-08-03', -13)).toBe('2026-07-21');
  });
});

describe('the marquee', () => {
  const crossing = (over: Partial<{ athlete_id: string; session_number: number; crossed_on: string }> = {}) => ({
    athlete_id: 'ath-1',
    session_number: 13,
    crossed_on: '2026-08-03',
    ...over,
  });

  it('uses the same Fibonacci ladder the training card does', () => {
    // Duplicated across a server module and a client component on purpose;
    // this is what stops the two drifting.
    expect([...WALL_MILESTONES]).toEqual([...MILESTONES]);
  });

  it('only counts ranks that are actually rungs on the ladder', () => {
    const rows = [crossing({ session_number: 12 }), crossing({ session_number: 13 }), crossing({ session_number: 14 })];
    expect(selectMarquee(rows, NOW, ZONE).map((r) => r.session_number)).toEqual([13]);
  });

  it('drops crossings older than the window and anything dated ahead', () => {
    const rows = [
      crossing({ crossed_on: shiftYmd('2026-08-03', -(MARQUEE_WINDOW_DAYS - 1)) }),
      crossing({ crossed_on: shiftYmd('2026-08-03', -MARQUEE_WINDOW_DAYS) }),
      crossing({ crossed_on: '2026-08-04' }),
    ];
    expect(selectMarquee(rows, NOW, ZONE)).toHaveLength(1);
  });

  it('puts the newest first, and the bigger milestone first within a day', () => {
    const rows = [
      crossing({ athlete_id: 'a', session_number: 5, crossed_on: '2026-08-03' }),
      crossing({ athlete_id: 'b', session_number: 89, crossed_on: '2026-08-03' }),
      crossing({ athlete_id: 'c', session_number: 233, crossed_on: '2026-08-01' }),
    ];
    expect(selectMarquee(rows, NOW, ZONE).map((r) => r.athlete_id)).toEqual(['b', 'a', 'c']);
  });

  it('caps the band so a busy fortnight cannot push it off a 16:9 screen', () => {
    const rows = Array.from({ length: 30 }, (_, i) => crossing({ athlete_id: `a${i}` }));
    expect(selectMarquee(rows, NOW, ZONE)).toHaveLength(MARQUEE_MAX);
  });

  it('survives a malformed date instead of throwing on the wall', () => {
    expect(selectMarquee([crossing({ crossed_on: 'not-a-date' })], NOW, ZONE)).toEqual([]);
  });
});

describe('the gym\'s voice', () => {
  const row = (over: Partial<{ message: string; kind: string; created_at: string }> = {}) => ({
    message: 'Open mat Saturday, all ages.',
    author_name: 'Coach Dan',
    author_role: 'coach',
    created_at: '2026-08-01T12:00:00.000Z',
    kind: 'notice',
    ...over,
  });

  it('prefers a standing notice over a motivation line', () => {
    const chosen = pickNotice([
      row({ kind: 'motivation', message: 'Hands up.', created_at: '2026-08-02T12:00:00.000Z' }),
      row({ kind: 'notice', message: 'Closed Monday.' }),
    ]);
    expect(chosen?.message).toBe('Closed Monday.');
  });

  it('falls back to a motivation line when nothing operational is posted', () => {
    expect(pickNotice([row({ kind: 'motivation', message: 'Hands up.' })])?.message).toBe('Hands up.');
  });

  it('returns null rather than an empty quote when nothing is posted', () => {
    expect(pickNotice([])).toBeNull();
    expect(pickNotice([row({ message: '   ' })])).toBeNull();
  });

  it('credits the author', () => {
    expect(pickNotice([row()])?.author).toBe('Coach Dan · coach');
  });
});

/* ------------------------------------------------------------------------ */

function sources(over: Partial<WallBoardSources> = {}): WallBoardSources {
  return {
    organizationId: 'ppbf-default-org',
    now: NOW,
    timeZone: ZONE,
    mode: 'consent',
    classes: [],
    attendance: [],
    athletes: [CHILD, ADULT],
    waivers: [],
    crossings: [],
    notices: [],
    ...over,
  };
}

describe('buildWallBoard', () => {
  it('names nobody by default, and still reports that they are here', () => {
    const board = buildWallBoard(
      sources({
        attendance: [{ athlete_id: 'ath-1', class_id: 'c1', checked_in_at: '2026-08-03T17:00:00.000Z' }],
      }),
    );
    expect(board.on_floor).toEqual([{ key: expect.any(String), name: 'M.R.', visibility: 'initials' }]);
    expect(board.on_floor_total).toBe(1);
  });

  it('gives the floor list and the marquee the same answer about the same child', () => {
    const board = buildWallBoard(
      sources({
        waivers: [waiver({ waiver_type: 'wall_display_full_name' })],
        attendance: [{ athlete_id: 'ath-1', class_id: 'c1', checked_in_at: '2026-08-03T17:00:00.000Z' }],
        crossings: [{ athlete_id: 'ath-1', session_number: 34, crossed_on: '2026-08-03' }],
      }),
    );
    expect(board.on_floor[0].name).toBe('Marcus Ruiz');
    expect(board.marquee[0].name).toBe('Marcus Ruiz');
  });

  it('withholds every name and keeps the headcount when the mode is off', () => {
    const board = buildWallBoard(
      sources({
        mode: 'off',
        waivers: [waiver({ waiver_type: 'wall_display_full_name' })],
        attendance: [
          { athlete_id: 'ath-1', class_id: 'c1', checked_in_at: '2026-08-03T17:00:00.000Z' },
          { athlete_id: 'ath-2', class_id: 'c1', checked_in_at: '2026-08-03T17:05:00.000Z' },
        ],
      }),
    );
    expect(board.on_floor).toEqual([]);
    expect(board.on_floor_total).toBe(2);
  });

  it('shows presence without a name when the athlete row did not come back', () => {
    const board = buildWallBoard(
      sources({
        athletes: [],
        attendance: [{ athlete_id: 'ath-9', class_id: 'c1', checked_in_at: '2026-08-03T17:00:00.000Z' }],
      }),
    );
    expect(board.on_floor[0]).toMatchObject({ name: '—', visibility: 'initials' });
  });

  it('counts a person once however many classes they checked into', () => {
    const board = buildWallBoard(
      sources({
        attendance: [
          { athlete_id: 'ath-1', class_id: 'c1', checked_in_at: '2026-08-03T17:00:00.000Z' },
          { athlete_id: 'ath-1', class_id: 'c2', checked_in_at: '2026-08-03T19:00:00.000Z' },
        ],
      }),
    );
    expect(board.on_floor).toHaveLength(1);
    expect(board.on_floor_total).toBe(1);
  });

  it('caps the floor list and lets the caller report the remainder', () => {
    const attendance = Array.from({ length: ON_FLOOR_MAX + 6 }, (_, i) => ({
      athlete_id: `ath-${i}`,
      class_id: 'c1',
      checked_in_at: `2026-08-03T17:${String(i).padStart(2, '0')}:00.000Z`,
    }));
    const board = buildWallBoard(sources({ athletes: [], attendance }));
    expect(board.on_floor).toHaveLength(ON_FLOOR_MAX);
    expect(board.on_floor_total).toBe(ON_FLOOR_MAX + 6);
  });

  it('marks a class that is running now, one that has finished, and one that was cancelled', () => {
    const board = buildWallBoard(
      sources({
        classes: [
          { class_id: 'past', title: 'Sunrise', start_at: '2026-08-03T11:00:00.000Z', end_at: '2026-08-03T12:00:00.000Z', location: 'Ring', status: 'open' },
          { class_id: 'live', title: 'Youth Boxing', start_at: '2026-08-03T18:00:00.000Z', end_at: '2026-08-03T19:00:00.000Z', location: 'Floor', status: 'open' },
          { class_id: 'later', title: 'Open Mat', start_at: '2026-08-03T22:00:00.000Z', end_at: '2026-08-03T23:00:00.000Z', location: 'Floor', status: 'open' },
          { class_id: 'gone', title: 'Sparring', start_at: '2026-08-03T23:30:00.000Z', end_at: '2026-08-04T00:30:00.000Z', location: 'Ring', status: 'cancelled' },
        ],
      }),
    );
    expect(board.sessions.map((s) => [s.key, s.state])).toEqual([
      ['past', 'done'],
      ['live', 'now'],
      ['later', 'upcoming'],
      ['gone', 'cancelled'],
    ]);
  });

  it('carries no health, clearance, injury, attendance-status or behaviour field anywhere', () => {
    // The rule this whole screen is built around, asserted against the shape
    // that actually ships rather than against the intention.
    const board = buildWallBoard(
      sources({
        classes: [{ class_id: 'c1', title: 'Youth Boxing', start_at: '2026-08-03T18:00:00.000Z', end_at: '2026-08-03T19:00:00.000Z', location: 'Floor', status: 'open' }],
        attendance: [{ athlete_id: 'ath-1', class_id: 'c1', checked_in_at: '2026-08-03T17:00:00.000Z' }],
        crossings: [{ athlete_id: 'ath-1', session_number: 34, crossed_on: '2026-08-03' }],
        notices: [{ message: 'Open mat Saturday.', author_name: 'Coach Dan', author_role: 'coach', created_at: '2026-08-01T12:00:00.000Z', kind: 'notice' }],
      }),
    );

    const serialized = JSON.stringify(board);
    for (const forbidden of [
      'readiness', 'clearance', 'medical', 'injury', 'pain', 'concussion', 'diagnosis',
      'medication', 'allergy', 'physician', 'discipline', 'behaviour', 'behavior',
      'observation', 'absent', 'excused', 'suspend', 'weight_class', 'gym_status',
      'emergency_contact', 'dob', 'athlete_id',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('reports the mode it ran under, so an operator can see it from the payload', () => {
    expect(buildWallBoard(sources({ mode: 'off' })).name_mode).toBe('off');
  });

  it('exposes only the two consent types it will honour', () => {
    expect(Object.keys(WALL_DISPLAY_CONSENT_TYPES).sort()).toEqual([
      'wall_display_first_name',
      'wall_display_full_name',
    ]);
  });
});
