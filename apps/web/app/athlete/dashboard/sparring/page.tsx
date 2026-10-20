'use client';

import { FormEvent, useEffect, useState } from 'react';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateTimeShort, formatGymTimeOfDay } from '@/src/lib/gymTime';
import { GymRegisteredOfficeLine } from '@/components/PrintSheet';
import BackHome from '@/components/BackHome';
import { SESSION_TOTAL_DIMENSIONS, SPARRING_LOG_FIELD_KEYS } from '@/src/server/pilot/formulas/types';
import ClusterNav from '@/components/ClusterNav';

type OpponentStance = 'Orthodox' | 'Southpaw' | 'Switch';
type PunchType = 'Jab' | 'Cross' | 'Hook' | 'Uppercut' | 'Body' | 'Other';

const PUNCH_TYPES: PunchType[] = ['Jab', 'Cross', 'Hook', 'Uppercut', 'Body', 'Other'];

const RECOVERY_NOTES_MAX_LENGTH = 300;
const MINUTES_WORKED_MAX = 120;

/* How the "Punch you threw most" choice reads in a sentence. */
const PUNCH_TYPE_PLURAL: Record<PunchType, string> = {
  Jab: 'jabs',
  Cross: 'crosses',
  Hook: 'hooks',
  Uppercut: 'uppercuts',
  Body: 'body shots',
  Other: 'other punches',
};

// Deep-Track: the rich data-entry path for athletes/coaches willing to take
// the time to log a full sparring session, in exchange for the formula
// engine actually being able to compute Accuracy, Connect Differential,
// Contact Exposure, Focus Attainment, and 7-Day Weight Change from it.
interface DeepTrackResult {
  ok: boolean;
  // How many observations the server actually accepted. Zero means nothing was
  // recorded at all, which the athlete must be told to re-enter; anything above
  // zero is a kept record they must not submit a second time.
  savedCount: number;
  // Set when the server raised a safety review because contact was logged for an
  // athlete with no current medical clearance. The submission still succeeded --
  // the record is kept deliberately -- but the athlete should be told, not left
  // to discover it from a coach later.
  safetyReviewRaised: boolean;
  // What earns clearance, from the gate's own requirement_text -- the "teaching
  // moment" doctrine: a stop names what's missing and where to fix it, not just
  // that it happened. Undefined when no review was raised.
  safetyReviewLesson: string | undefined;
}

async function submitDeepTrackObservations(input: {
  athleteId: string;
  contextId: string;
  observedAt: string;
  totalRoundsCompleted: number;
  contactLevel: number;
  punchType: PunchType;
  punchesAttempted: number;
  punchesLanded: number;
  punchesAbsorbed: number;
  focusAchieved: boolean;
  recoveryNotes: string;
  bodyWeightKg: number | null;
  opponentStance: OpponentStance;
  /* The "Whole session" boxes: null when left blank, never sent as zero. */
  allThrown: number | null;
  allLanded: number | null;
  minutesWorked: number | null;
}): Promise<DeepTrackResult> {
  const baseDimensions = { opponentStance: input.opponentStance };

  const observations: Array<{
    kind: string;
    value: number | null;
    unit: string;
    dimensions?: Record<string, string | number | boolean>;
    /* Keeps a whole-session count's idempotency key apart from the per-type
       observation of the same kind in this context. */
    keySuffix?: string;
  }> = [
    // The contact pair is sent only when contact actually happened. The
    // rounds field on this form is TOTAL session rounds, so sending it as
    // 'contact_rounds' for a contact level of 0 ('None') would report 6
    // rounds of contact for a bag-work session -- which files a
    // contact-without-clearance safety flag against an athlete who honestly
    // logged that no contact occurred. Omitting the whole pair keeps the
    // formula engine's pair-per-context invariant intact and contributes
    // exactly what a zero-contact session should to Contact Exposure:
    // nothing.
    ...(input.contactLevel > 0
      ? [
          { kind: 'contact_level', value: input.contactLevel, unit: 'level_0_3', dimensions: baseDimensions },
          { kind: 'contact_rounds', value: input.totalRoundsCompleted, unit: 'count', dimensions: baseDimensions },
        ]
      : []),
    { kind: 'punch_attempted', value: input.punchesAttempted, unit: 'count', dimensions: { punchType: input.punchType } },
    { kind: 'punch_landed', value: input.punchesLanded, unit: 'count', dimensions: { punchType: input.punchType } },
    { kind: 'punch_absorbed', value: input.punchesAbsorbed, unit: 'count', dimensions: baseDimensions },
    { kind: 'focus_achieved', value: input.focusAchieved ? 1 : 0, unit: 'boolean_0_1' },
  ];

  // WHOLE SESSION (Jason 2026-10-17, "B: Longer sparring form"). The three
  // boxes are always sent, a blank one as null: data completeness (MVP-10)
  // counts a blank as a gap (Overwatch QD3), and a null is never a value for
  // MVP-02/04/05, which run only when the box was filled in. Tagged
  // SESSION_TOTAL_DIMENSIONS so the detector can tell the whole-session landed
  // count from the per-type one above, and with the box's fieldKey.
  const box = (fieldKey: string) => ({ ...SESSION_TOTAL_DIMENSIONS, fieldKey });
  observations.push(
    { kind: 'punch_count', value: input.allThrown, unit: 'count', dimensions: box(SPARRING_LOG_FIELD_KEYS.allThrown) },
    { kind: 'punch_landed', value: input.allLanded, unit: 'count', dimensions: box(SPARRING_LOG_FIELD_KEYS.allLanded), keySuffix: 'session_total' },
    { kind: 'active_time', value: input.minutesWorked, unit: 'minutes', dimensions: box(SPARRING_LOG_FIELD_KEYS.minutesWorked) },
  );
  // Rounds are sent whenever answered, so filling "All punches thrown" later
  // (Fix a number) can still give punches per round. A cleared rounds box
  // reads as 0, which is not a count of rounds, so it is not sent.
  if (input.totalRoundsCompleted >= 1) {
    observations.push({ kind: 'round_count', value: input.totalRoundsCompleted, unit: 'count', dimensions: { ...SESSION_TOTAL_DIMENSIONS } });
  }

  if (input.bodyWeightKg != null) {
    observations.push({ kind: 'body_weight', value: input.bodyWeightKg, unit: 'kilograms' });
  }

  const notes = input.recoveryNotes.trim();
  if (notes.length > 0) {
    observations.push({
      kind: 'recovery_notes',
      value: 1,
      unit: 'text_present_0_1',
      // The observations API rejects any dimension string over 300 characters
      // outright, so the note is bounded to what the record can hold.
      dimensions: { notes: notes.slice(0, RECOVERY_NOTES_MAX_LENGTH) },
    });
  }

  const results = await Promise.allSettled(observations.map(async (observation) => {
    const response = await fetch(`${apiBase()}/api/pilot/shadow/formulas/observations`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      athleteId: input.athleteId,
      contextId: input.contextId,
      kind: observation.kind,
      value: observation.value,
      unit: observation.unit,
      dimensions: observation.dimensions ?? {},
      observedAt: input.observedAt,
      idempotencyKey: observation.keySuffix
        ? `${input.contextId}-${observation.kind}-${observation.keySuffix}`
        : `${input.contextId}-${observation.kind}`,
    }),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      safetyReview?: { raised?: boolean; lesson?: string };
    };
    return {
      ok: response.ok,
      safetyReviewRaised: payload.safetyReview?.raised === true,
      safetyReviewLesson: payload.safetyReview?.lesson,
    };
  }));

  const fulfilled = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const savedCount = fulfilled.filter((value) => value.ok).length;

  return {
    ok: savedCount === results.length,
    savedCount,
    // Any one of the contact observations tripping the gate is enough; they all
    // concern the same session.
    safetyReviewRaised: fulfilled.some((value) => value.safetyReviewRaised),
    safetyReviewLesson: fulfilled.find((value) => value.safetyReviewLesson)?.safetyReviewLesson,
  };
}

/* FIX A NUMBER. A mistyped count used to be permanent from this screen: the
   observations route has always accepted a correction (supersedesObservationId,
   re-running every calculation the old number fed), but nothing here sent one,
   so the only fix was an API call with hand-copied observation ids. This lists
   the recent entries (GET on the same route, punch numbers only) and posts a
   correction per changed number. The old number stays on record as replaced.

   Corrections go one at a time, in order. Each one re-runs the calculations
   its old number fed, and a later one must see the earlier one stored.
   Copy in this block is PROPOSED (lane L50). */
type CorrectableKind = 'punch_attempted' | 'punch_landed' | 'punch_absorbed' | 'punch_count' | 'round_count' | 'active_time';
type CorrectableField = 'thrown' | 'landed' | 'taken' | 'allThrown' | 'rounds' | 'allLanded' | 'minutesWorked';

/* `sessionTotal` separates the whole-session counts from the per-type ones:
   one entry can hold two punch_landed numbers. */
const CORRECTABLE_FIELDS: ReadonlyArray<{ field: CorrectableField; kind: CorrectableKind; sessionTotal: boolean; label: string }> = [
  { field: 'thrown', kind: 'punch_attempted', sessionTotal: false, label: 'Thrown' },
  { field: 'landed', kind: 'punch_landed', sessionTotal: false, label: 'Landed' },
  { field: 'taken', kind: 'punch_absorbed', sessionTotal: false, label: 'Punches taken' },
  { field: 'allThrown', kind: 'punch_count', sessionTotal: true, label: 'All punches thrown' },
  { field: 'rounds', kind: 'round_count', sessionTotal: true, label: 'Rounds you finished' },
  { field: 'allLanded', kind: 'punch_landed', sessionTotal: true, label: 'All punches landed' },
  { field: 'minutesWorked', kind: 'active_time', sessionTotal: true, label: 'Minutes of actual work' },
];

interface SparringEntryObservation {
  observationId: string;
  kind: string;
  value: number | null;
  unit: string;
  dimensions: Record<string, string | number | boolean | null>;
  observedAt: string;
}

interface SparringEntry {
  contextId: string;
  observedAt: string;
  observations: SparringEntryObservation[];
}

function isSessionTotal(observation: SparringEntryObservation): boolean {
  return Object.entries(SESSION_TOTAL_DIMENSIONS)
    .every(([key, value]) => observation.dimensions[key] === value);
}

function entryObservation(entry: SparringEntry, field: CorrectableField) {
  const spec = CORRECTABLE_FIELDS.find((item) => item.field === field)!;
  return entry.observations.find((observation) => (
    observation.kind === spec.kind && isSessionTotal(observation) === spec.sessionTotal
  ));
}

function entryLabel(entry: SparringEntry): string {
  const punchType = entryObservation(entry, 'thrown')?.dimensions.punchType
    ?? entryObservation(entry, 'landed')?.dimensions.punchType;
  const when = formatGymDateTimeShort(entry.observedAt) ?? 'Unknown time';
  return typeof punchType === 'string' ? `${when} · ${punchType}` : when;
}

function FixSparringEntry({ athleteId }: { athleteId: string | null }) {
  const [entries, setEntries] = useState<SparringEntry[]>([]);
  const [listState, setListState] = useState<'idle' | 'loading' | 'loaded' | 'unavailable'>('idle');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<Record<CorrectableField, string>>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  async function loadEntries(subject: string) {
    setListState('loading');
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/shadow/formulas/observations?athlete_id=${encodeURIComponent(subject)}&limit=5`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('entries');
      const payload = (await response.json()) as { entries?: SparringEntry[] };
      setEntries(payload.entries ?? []);
      setListState('loaded');
    } catch {
      setEntries([]);
      setListState('unavailable');
    }
  }

  function startEditing(entry: SparringEntry) {
    const values: Partial<Record<CorrectableField, string>> = {};
    for (const { field } of CORRECTABLE_FIELDS) {
      const observation = entryObservation(entry, field);
      if (observation) values[field] = observation.value == null ? '' : String(observation.value);
    }
    setDraft(values);
    setEditing(entry.contextId);
    setMessage('');
  }

  async function saveFix(entry: SparringEntry) {
    if (!athleteId) return;
    const changes = CORRECTABLE_FIELDS.flatMap(({ field, sessionTotal }) => {
      const observation = entryObservation(entry, field);
      const raw = draft[field];
      if (!observation || raw === undefined) return [];
      // A cleared whole-session box means "not counted" -- the same as leaving
      // it blank on the log -- so the stored number is replaced by null rather
      // than kept. The per-type numbers always carry a count; a blank there
      // changes nothing.
      if (raw.trim() === '') {
        return sessionTotal && observation.value != null
          ? [{ field, observation, value: null as number | null }]
          : [];
      }
      const value: number | null = Number(raw);
      return value === observation.value ? [] : [{ field, observation, value }];
    });
    if (changes.some(({ field, value }) => value != null && field !== 'minutesWorked' && (!Number.isInteger(value) || value < 0))) {
      setMessage('Counts are whole numbers, 0 or more.');
      return;
    }
    // The log's own rounds box takes 1-12 (min/max on the input).
    if (changes.some(({ field, value }) => field === 'rounds' && value != null && (value < 1 || value > 12))) {
      setMessage('Rounds you finished has to be between 1 and 12.');
      return;
    }
    if (changes.some(({ field, value }) => field === 'minutesWorked' && value != null && (!Number.isFinite(value) || value < 1 || value > MINUTES_WORKED_MAX))) {
      setMessage(`Minutes of actual work has to be between 1 and ${MINUTES_WORKED_MAX}.`);
      return;
    }
    const finalValue = (field: CorrectableField) => {
      const change = changes.find((item) => item.field === field);
      return change ? change.value : entryObservation(entry, field)?.value ?? null;
    };
    const thrown = finalValue('thrown');
    const landed = finalValue('landed');
    if (thrown != null && landed != null && landed > thrown) {
      setMessage('You cannot land more than you threw. Check those two numbers.');
      return;
    }
    const wholeThrown = finalValue('allThrown');
    const wholeLanded = finalValue('allLanded');
    if (wholeThrown != null && wholeLanded != null && wholeLanded > wholeThrown) {
      setMessage("All punches landed can't be more than all punches thrown. Check those two numbers.");
      return;
    }
    // The same two checks the log itself makes (onSubmit).
    const typeName = (() => {
      const punchType = entryObservation(entry, 'thrown')?.dimensions.punchType;
      return typeof punchType === 'string' && punchType in PUNCH_TYPE_PLURAL
        ? PUNCH_TYPE_PLURAL[punchType as PunchType]
        : 'punches';
    })();
    if (wholeThrown != null && thrown != null && wholeThrown < thrown) {
      setMessage(`All punches thrown can't be fewer than the ${typeName} you threw above. Check those numbers.`);
      return;
    }
    if (wholeLanded != null && landed != null && wholeLanded < landed) {
      setMessage(`All punches landed can't be fewer than the ${typeName} you landed above. Check those numbers.`);
      return;
    }
    if (changes.length === 0) {
      setMessage('Nothing changed.');
      return;
    }

    const subject = athleteId;
    setSaving(true);
    let saved = 0;
    let safetyLesson: string | null | undefined;
    try {
      for (const { observation, value } of changes) {
        const response = await fetch(`${apiBase()}/api/pilot/shadow/formulas/observations`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            athleteId: subject,
            contextId: entry.contextId,
            kind: observation.kind,
            value,
            unit: observation.unit,
            dimensions: observation.dimensions,
            observedAt: observation.observedAt,
            // One key per replaced observation: a retry of this exact fix is
            // the same record, and fixing the fix replaces the new one.
            idempotencyKey: `${entry.contextId}-${observation.kind}-fix-${observation.observationId}`,
            supersedesObservationId: observation.observationId,
          }),
        }).catch(() => null);
        if (!response?.ok) break;
        saved += 1;
        // The route's contact gate runs on a correction exactly as on a new
        // entry; when it raises a review, say so the way the log above does.
        const payload = (await response.json().catch(() => ({}))) as {
          safetyReview?: { raised?: boolean; lesson?: string };
        };
        if (payload.safetyReview?.raised) safetyLesson = payload.safetyReview.lesson ?? null;
      }
    } finally {
      setSaving(false);
    }

    setEditing(null);
    const outcome = saved === changes.length
      ? 'Fixed. The old number stays on record as replaced.'
      : saved === 0
        ? 'That fix did not save. Check your connection and try again.'
        : 'Only part of that fix saved. The numbers below are what is on record now.';
    setMessage(safetyLesson !== undefined
      ? `${outcome} There is no current medical clearance on file for this athlete, so your coach has been asked to look at it.${safetyLesson ? ` ${safetyLesson}` : ''}`
      : outcome);
    await loadEntries(subject);
  }

  return (
    <section aria-labelledby="fixEntryHeading" className="px-[var(--s5)] pb-[var(--s6)]">
      <div className="mat-leather grid gap-[var(--s4)] rounded-[var(--r-lg)] p-[var(--s5)]">
        <h2 id="fixEntryHeading" className="t-command m-0" style={{ fontSize: 'var(--t-lg)' }}>Fix a number</h2>
        <p className="m-0 text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
          Typed a count wrong? Open a recent entry and put the right number in.
        </p>
        <button
          type="button"
          onClick={() => { if (athleteId) void loadEntries(athleteId); }}
          disabled={!athleteId || listState === 'loading'}
          className="btn btn--ghost min-h-[var(--tap)] justify-self-start disabled:cursor-not-allowed disabled:opacity-50"
        >
          {listState === 'loading' ? 'Loading…' : 'Show recent entries'}
        </button>
        {message && <p className="m-0 text-[length:var(--t-md)] text-[color:var(--bone-200)]" role="status">{message}</p>}
        {listState === 'unavailable' && (
          <p className="m-0 text-[length:var(--t-sm)] text-[var(--restricted-ink)]">
            Recent entries could not be loaded. Try again.
          </p>
        )}
        {listState === 'loaded' && entries.length === 0 && (
          <p className="m-0 text-[length:var(--t-sm)] text-[color:var(--bone-300)]">No sparring entries yet.</p>
        )}
        {entries.length > 0 && (
          <ul className="m-0 grid list-none gap-[var(--s3)] p-0">
            {entries.map((entry) => (
              <li key={entry.contextId} className="mat-leather--raised grid gap-[var(--s3)] rounded-[var(--r-md)] p-[var(--s4)]">
                <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
                  <p className="t-label m-0">{entryLabel(entry)}</p>
                  {editing !== entry.contextId && (
                    <button
                      type="button"
                      onClick={() => startEditing(entry)}
                      disabled={saving}
                      className="btn btn--ghost min-h-[var(--tap)]"
                    >
                      Fix
                    </button>
                  )}
                </div>
                {editing === entry.contextId ? (
                  <div className="grid gap-[var(--s3)]">
                    <div className="grid gap-[var(--s3)] sm:grid-cols-3">
                      {CORRECTABLE_FIELDS.filter(({ field }) => draft[field] !== undefined).map(({ field, label }) => (
                        <div key={field} className="field">
                          <label htmlFor={`fix-${entry.contextId}-${field}`} className="t-label">{label}</label>
                          <input
                            id={`fix-${entry.contextId}-${field}`}
                            type="number"
                            min={0}
                            step={field === 'minutesWorked' ? '0.5' : '1'}
                            value={draft[field] ?? ''}
                            onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))}
                            className="input input--kiosk"
                          />
                        </div>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-[var(--s3)]">
                      <button type="button" onClick={() => void saveFix(entry)} disabled={saving} className="btn min-h-[var(--tap)]">
                        {saving ? 'Saving…' : 'Save fix'}
                      </button>
                      <button type="button" onClick={() => setEditing(null)} disabled={saving} className="btn btn--ghost min-h-[var(--tap)]">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="t-data m-0 text-[length:var(--t-md)]">
                    {CORRECTABLE_FIELDS
                      .filter(({ field }) => entryObservation(entry, field))
                      .map(({ field, label }) => `${label} ${entryObservation(entry, field)?.value ?? '—'}`)
                      .join(' · ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * Who is filling this in. The page behaves differently for the two, and the
 * difference is not cosmetic: an athlete IS the subject of the record, a coach
 * has to say which athlete the record is about.
 *
 * 'unknown' is the state before the session read answers, and the state it
 * lands in if that read fails -- never a default of 'athlete', which would put
 * an athlete's voice on a coach's screen and leave a coach with no picker.
 */
type LogActor = 'unknown' | 'athlete' | 'staff';

/** An option on the staff athlete picker, as GET /api/pilot/coach/athletes returns it. */
interface AuthorizedAthlete {
  athlete_id: string;
  full_name: string;
}

export default function SparringTelemetryPage() {
  /* The athlete this log is ABOUT.
     For an athlete it is themselves and cannot be anything else. For staff it
     is whatever they pick, and it starts empty -- there is no sensible default
     subject for a coach, and defaulting to the first name on a list is how a
     session gets filed against the wrong child. */
  const [athleteId, setAthleteId] = useState<string | null>(null);
  const [actor, setActor] = useState<LogActor>('unknown');
  /* The picker's options, from the CENTRAL access contract by way of
     /api/pilot/coach/athletes -- for a coach, every live athlete of their own
     gym (issue #1480), the set the observations route's
     assertActorCanAccessAthlete admits.
     Deliberately NOT /api/pilot/athletes/list: that route is a display
     projection with field redaction, not the access contract, so a picker
     built on it can drift from what the observations route accepts.

     'loaded' and 'unavailable' are distinct because an empty picker must never
     be the rendering of a failed read: "you are assigned no athletes" and "we
     could not find out who you are assigned" are different things to tell a
     coach standing on the floor. */
  const [authorizedAthletes, setAuthorizedAthletes] = useState<AuthorizedAthlete[]>([]);
  const [rosterState, setRosterState] = useState<'idle' | 'loading' | 'loaded' | 'unavailable'>('idle');
  const [totalRoundsCompleted, setTotalRoundsCompleted] = useState(6);
  const [opponentStance, setOpponentStance] = useState<OpponentStance>('Orthodox');
  const [contactLevel, setContactLevel] = useState(1);
  const [punchType, setPunchType] = useState<PunchType>('Jab');
  const [punchesAttempted, setPunchesAttempted] = useState(0);
  const [punchesLanded, setPunchesLanded] = useState(0);
  const [punchesAbsorbed, setPunchesAbsorbed] = useState(0);
  const [focusAchieved, setFocusAchieved] = useState(true);
  const [bodyWeightKg, setBodyWeightKg] = useState('');
  const [allThrown, setAllThrown] = useState('');
  const [allLanded, setAllLanded] = useState('');
  const [minutesWorked, setMinutesWorked] = useState('');
  const [recoveryNotes, setRecoveryNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastSubmitted, setLastSubmitted] = useState('Nothing logged yet');
  const [statusMessage, setStatusMessage] = useState('Nothing logged yet. Fill this in after you spar.');

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/auth/session`, { method: 'POST', credentials: 'include' });
        const payload = (await response.json()) as {
          authenticated?: boolean;
          role?: string;
          athlete_id?: string | null;
        };
        if (!response.ok || !payload.authenticated) {
          return;
        }

        /* An athlete is only ever allowed to be themselves, so their subject
           comes off the session and no picker is drawn. Anyone else who may
           be on this page -- the role gate and the observations route agree on
           coach, organization_admin and admin -- picks. */
        if (payload.role === 'athlete') {
          if (payload.athlete_id) {
            setAthleteId(payload.athlete_id);
            setActor('athlete');
          }
          return;
        }

        setActor('staff');
        setRosterState('loading');
        try {
          const rosterResponse = await fetch(`${apiBase()}/api/pilot/coach/athletes`, {
            method: 'GET',
            credentials: 'include',
          });
          if (!rosterResponse.ok) {
            throw new Error('roster');
          }
          const rosterPayload = (await rosterResponse.json()) as { items?: AuthorizedAthlete[] };
          setAuthorizedAthletes(
            (rosterPayload.items ?? []).filter(
              (item) => typeof item?.athlete_id === 'string' && item.athlete_id.trim().length > 0,
            ),
          );
          setRosterState('loaded');
        } catch {
          // An empty picker here would read as "you have no athletes", which
          // this read did not establish.
          setAuthorizedAthletes([]);
          setRosterState('unavailable');
        }
      } catch {
        // actor stays 'unknown' and submission stays disabled below.
      }
    })();
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!athleteId) {
      /* Two different reasons the subject can be missing, and they need two
         different sentences. Telling a coach who has simply not chosen anybody
         yet that they have been signed out sends them to the login screen to
         fix a dropdown. */
      setStatusMessage(actor === 'staff'
        ? 'Choose which athlete this session is for before saving it.'
        : 'You are not signed in any more. Sign in again and this will save.');
      return;
    }
    if (punchesLanded > punchesAttempted) {
      setStatusMessage('You cannot land more than you threw. Check those two numbers.');
      return;
    }
    const wholeThrown = allThrown.trim() ? Number(allThrown) : null;
    const wholeLanded = allLanded.trim() ? Number(allLanded) : null;
    const wholeMinutes = minutesWorked.trim() ? Number(minutesWorked) : null;
    if ([wholeThrown, wholeLanded].some((value) => value != null && (!Number.isInteger(value) || value < 0))) {
      setStatusMessage('Counts are whole numbers, 0 or more.');
      return;
    }
    if (wholeThrown != null && wholeLanded != null && wholeLanded > wholeThrown) {
      setStatusMessage("All punches landed can't be more than all punches thrown. Check those two numbers.");
      return;
    }
    if (wholeThrown != null && wholeThrown < punchesAttempted) {
      setStatusMessage(`All punches thrown can't be fewer than the ${PUNCH_TYPE_PLURAL[punchType]} you threw above. Check those numbers.`);
      return;
    }
    if (wholeLanded != null && wholeLanded < punchesLanded) {
      setStatusMessage(`All punches landed can't be fewer than the ${PUNCH_TYPE_PLURAL[punchType]} you landed above. Check those numbers.`);
      return;
    }
    if (wholeMinutes != null && (!Number.isFinite(wholeMinutes) || wholeMinutes < 1 || wholeMinutes > MINUTES_WORKED_MAX)) {
      setStatusMessage(`Minutes of actual work has to be between 1 and ${MINUTES_WORKED_MAX}.`);
      return;
    }

    setIsSubmitting(true);
    const contextId = `sparring_${Date.now()}`;
    const observedAt = new Date().toISOString();

    try {
      const { ok, savedCount, safetyReviewRaised, safetyReviewLesson } = await submitDeepTrackObservations({
        athleteId,
        contextId,
        observedAt,
        totalRoundsCompleted,
        contactLevel,
        punchType,
        punchesAttempted,
        punchesLanded,
        punchesAbsorbed,
        focusAchieved,
        recoveryNotes,
        bodyWeightKg: bodyWeightKg.trim() ? Number(bodyWeightKg) : null,
        opponentStance,
        allThrown: wholeThrown,
        allLanded: wholeLanded,
        minutesWorked: wholeMinutes,
      });

      if (savedCount === 0) {
        setStatusMessage('Nothing saved. None of this got through -- check your connection '
          + 'and put it in again.');
        return;
      }

      const timestamp = formatGymTimeOfDay(new Date()) ?? '';
      setLastSubmitted(timestamp);
      // The ordinary-path copy does not tell the athlete a coach sees this
      // (Jason, D10: "No"), although /coach/athlete-intelligence now reads the
      // results calculated from it. The safety exceptions are different --
      // missing medical clearance, or contact during a hold, file a flagged
      // near miss a coach really receives -- so that branch keeps saying so.
      const savedMessage = safetyReviewRaised
        ? 'Saved. There is no current medical clearance on file for this athlete, so '
          + 'your coach has been asked to look at it. What you wrote is kept -- do not put it in again.'
          + (safetyReviewLesson ? ` ${safetyReviewLesson}` : '')
        : actor === 'staff'
          ? `Saved to ${subjectName ?? 'this athlete'}'s training record.`
          : 'Saved to your training record.';

      setStatusMessage(ok
        ? savedMessage
        : 'Some of it saved, some did not -- check your connection. What went through is on your record.');
    } finally {
      setIsSubmitting(false);
    }
  }

  const contactLevelLabel = ['None', 'Light', 'Moderate', 'Heavy'][contactLevel] ?? 'Unknown';
  /* The chosen athlete's name, from the option the server returned -- never
     from anything the client composed. Undefined until a choice is made, and
     for an athlete logging their own session, where there is no picker. */
  const subjectName = authorizedAthletes.find((item) => item.athlete_id === athleteId)?.full_name;

  return (
    /* This page had no role gate at all -- every sibling athlete route wraps in
       RoleStandaloneView, this one rendered the full form to a signed-out
       visitor and relied entirely on the API route's own requireRole to
       reject the eventual submit. The data was never actually exposed
       (observations/route.ts enforces this exact role list server-side), but
       the page shell painted for anyone, which every other gated surface
       refuses to do. RoleStandaloneView's own <main> now supplies the room
       ground and background this page used to set on its own top-level
       element, so those classes move off it to avoid nesting two <main>s.

       allowedRoles matches observations/route.ts, not just ['athlete']:
       buildingMap.ts already lists this route as OPEN rather than
       athlete-only, and the API accepts coach and admin roles too -- a coach
       logging a session on a shared tablet is a real path, not a leftover.
       Server-side that list is ['athlete', 'coach', 'organization_admin',
       'admin']; client-side ClubRole's 'admin' already represents
       organization_admin (roleRoutes.ts), and platform_owner (Omega) is
       deliberately absent here for the same reason it's absent from #414's
       film-study proposals route -- Omega is broader in breadth but strictly
       narrower in depth, and this is an ordinary operational surface, not
       one of the surfaces Omega is scoped for.
       roleLabel is a description of the surface, not a claim about who's
       allowed, matching how multi-role pages elsewhere name themselves
       (Evidence Review, Decision Loop Review) rather than naming one role. */
    <RoleStandaloneView roleLabel="Sparring Log" routeLabel="/athlete/dashboard/sparring" allowedRoles={['athlete', 'coach', 'admin']} showShellHeader={false} room="floor">
      {/* The night console's voice was on a child's sparring screen. "Combat
          Telemetry Log", "SHADOW formula engine surface", "Track D/E ·
          Deep-Track" -- telemetry is the After Hours room's own Feel word, and
          this is the gym floor: brick, caged lamps, and a coach in the corner
          saying short things. roleLabel above has said "Sparring Log" all
          along; the page now agrees with it.

          bg-[var(--hide-950)] is off the band too. It is not the dead
          page-level kind -- this header is a CHILD of the room, so the ink
          really did paint over the brick the room hangs, on the one strip
          across the top of the screen. The brass rule below it is what
          separates the header from the form; it never needed a second ground
          to do that. */}
      <header className="flex flex-wrap items-center justify-between gap-[var(--s4)] border-b-[3px] border-[color:var(--brass-500)] px-[var(--s5)] py-[var(--s4)]">
        <div>
          {/* The page's voice follows who is holding it. "Your Corner" over
              "Your training record" is written to the boxer whose record it
              is; a coach filling this in for a child is not that reader, and
              copy that tells them it is their own record is the same kind of
              small untruth this file's tests already police in the save
              messages. */}
          <p className="t-eyebrow">{actor === 'staff' ? 'Coach Entry' : 'Your Corner'}</p>
          <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-xl)' }}>Sparring Log</h1>
          <ClusterNav cluster="sparring" />
          <div className="mt-[var(--s3)]"><BackHome /></div>
        </div>
        <span className="plaque">{actor === 'staff' ? 'Athlete training record' : 'Your training record'}</span>
      </header>

      <form onSubmit={onSubmit} className="px-[var(--s5)] py-[var(--s6)]">
        <div className="grid items-start gap-[var(--s5)] lg:grid-cols-[var(--split-major)_var(--split-minor)]">
          <section className="mat-leather--raised grid gap-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s6)]">
            <div className="grid gap-[var(--s2)]">
              <h2 className="t-command m-0" style={{ fontSize: 'var(--t-lg)' }}>What happened today</h2>
              <p className="m-0 text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
                {actor === 'staff'
                  ? 'Rounds, contact, what they threw, what landed, what they took, and how they came out of it.'
                  : 'Rounds, contact, what you threw, what landed, what you took, and how you felt after. It takes a couple of minutes and it is the most complete record of your own work you can keep.'}
              </p>
            </div>

            {/* WHO THIS SESSION IS ABOUT -- staff only.

                This page has admitted coach and admin since it gained its role
                gate, the observations route has accepted a coach submission for
                an authorized athlete for just as long, and the page's own
                comment calls a coach logging on a shared tablet "a real path".
                It was not one. The subject came from payload.athlete_id on the
                session read, a coach's session carries none, and the submit
                button was therefore disabled forever with nothing on screen
                saying why. Reproduced before it was changed.

                The options come from /api/pilot/coach/athletes -- the central
                access contract -- and the submitted id is always one of them.
                This narrows the control; it does not authorize anything. The
                observations route's assertActorCanAccessAthlete is still the
                boundary and is untouched. */}
            {actor === 'staff' && (
              <div className="grid gap-[var(--s3)]">
                <div className="field">
                  <label htmlFor="subjectAthlete" className="t-label">Which athlete is this for</label>
                  <select
                    id="subjectAthlete"
                    value={athleteId ?? ''}
                    onChange={(event) => setAthleteId(event.target.value || null)}
                    disabled={rosterState !== 'loaded' || authorizedAthletes.length === 0}
                    className="select input--kiosk"
                  >
                    <option value="">
                      {rosterState === 'loading' ? 'Loading your athletes...' : 'Choose an athlete'}
                    </option>
                    {authorizedAthletes.map((item) => (
                      <option key={item.athlete_id} value={item.athlete_id}>{item.full_name}</option>
                    ))}
                  </select>
                </div>

                {rosterState === 'unavailable' && (
                  <div className="rounded-[var(--r-md)] border-2 border-[var(--restricted)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                    <p className="m-0 text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">
                      Your athletes could not be loaded, so there is nobody to choose. This is not a
                      statement that your gym has none -- reload and try again. Write the session down
                      on paper in the meantime; do not guess an athlete here.
                    </p>
                  </div>
                )}

                {rosterState === 'loaded' && authorizedAthletes.length === 0 && (
                  <p className="m-0 text-[length:var(--t-sm)] leading-relaxed text-[color:var(--bone-300)]">
                    There are no active athletes in your gym yet, so there is nobody you can log a session
                    for. An administrator adds athletes to the gym.
                  </p>
                )}
              </div>
            )}

            <div className="grid gap-[var(--s5)] sm:grid-cols-2">
              <div className="field">
                <label htmlFor="roundsCompleted" className="t-label">Rounds you finished</label>
                <input
                  id="roundsCompleted"
                  type="number"
                  min={1}
                  max={12}
                  value={totalRoundsCompleted}
                  onChange={(event) => setTotalRoundsCompleted(Number(event.target.value))}
                  className="input input--kiosk"
                />
              </div>

              <div className="field">
                <label htmlFor="opponentStance" className="t-label">Their stance</label>
                <select
                  id="opponentStance"
                  value={opponentStance}
                  onChange={(event) => setOpponentStance(event.target.value as OpponentStance)}
                  className="select input--kiosk"
                >
                  <option value="Orthodox">Orthodox</option>
                  <option value="Southpaw">Southpaw</option>
                  <option value="Switch">Switch</option>
                </select>
              </div>
            </div>

            <div className="grid gap-[var(--s3)]">
              <label htmlFor="contactLevel" className="t-label">How hard the contact was</label>
              <div className="flex flex-wrap items-center justify-between gap-[var(--s4)]">
                <input
                  id="contactLevel"
                  type="range"
                  min={0}
                  max={3}
                  step={1}
                  value={contactLevel}
                  onChange={(event) => setContactLevel(Number(event.target.value))}
                  className="min-h-[var(--tap)] cursor-pointer"
                  style={{ accentColor: 'var(--brass-400)', flex: '1 1 260px' }}
                />
                <span className="plaque min-w-[122px] text-center">
                  {contactLevel}/3 {contactLevelLabel}
                </span>
              </div>
            </div>

            <div className="grid gap-[var(--s5)] sm:grid-cols-3">
              <div className="field">
                <label htmlFor="punchType" className="t-label">Punch you threw most</label>
                <select
                  id="punchType"
                  value={punchType}
                  onChange={(event) => setPunchType(event.target.value as PunchType)}
                  className="select input--kiosk"
                >
                  {PUNCH_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="punchesAttempted" className="t-label">Thrown</label>
                <input
                  id="punchesAttempted"
                  type="number"
                  min={0}
                  value={punchesAttempted}
                  onChange={(event) => setPunchesAttempted(Math.max(0, Number(event.target.value)))}
                  className="input input--kiosk"
                />
              </div>
              <div className="field">
                <label htmlFor="punchesLanded" className="t-label">Landed</label>
                <input
                  id="punchesLanded"
                  type="number"
                  min={0}
                  value={punchesLanded}
                  onChange={(event) => setPunchesLanded(Math.max(0, Number(event.target.value)))}
                  className="input input--kiosk"
                />
              </div>
            </div>

            <div className="grid gap-[var(--s5)] sm:grid-cols-2">
              <div className="field">
                <label htmlFor="punchesAbsorbed" className="t-label">Punches you took</label>
                <input
                  id="punchesAbsorbed"
                  type="number"
                  min={0}
                  value={punchesAbsorbed}
                  onChange={(event) => setPunchesAbsorbed(Math.max(0, Number(event.target.value)))}
                  className="input input--kiosk"
                />
              </div>
              <div className="field">
                <label htmlFor="bodyWeight" className="t-label">Your weight (kg, if you want)</label>
                <input
                  id="bodyWeight"
                  type="number"
                  min={0}
                  step="0.1"
                  value={bodyWeightKg}
                  onChange={(event) => setBodyWeightKg(event.target.value)}
                  placeholder="Leave blank to skip"
                  className="input input--kiosk"
                />
              </div>
            </div>

            {/* WHOLE SESSION -- copy accepted by Overwatch 2026-10-17 (lane L50). */}
            <div className="grid gap-[var(--s3)]">
              <h3 className="t-label m-0">Whole session</h3>
              <p className="m-0 text-[length:var(--t-sm)] leading-relaxed text-[color:var(--bone-300)]">
                {actor === 'staff'
                  ? 'Every punch they threw, every round. Leave a box blank if nobody counted it.'
                  : "Every punch, every round. Leave a box blank if you didn't count it."}
              </p>
              <div className="grid gap-[var(--s5)] sm:grid-cols-3">
                <div className="field">
                  <label htmlFor="allThrown" className="t-label">All punches thrown</label>
                  <input
                    id="allThrown"
                    type="number"
                    min={0}
                    step="1"
                    value={allThrown}
                    onChange={(event) => setAllThrown(event.target.value)}
                    className="input input--kiosk"
                  />
                </div>
                <div className="field">
                  <label htmlFor="allLanded" className="t-label">All punches landed</label>
                  <input
                    id="allLanded"
                    type="number"
                    min={0}
                    step="1"
                    value={allLanded}
                    onChange={(event) => setAllLanded(event.target.value)}
                    className="input input--kiosk"
                  />
                </div>
                <div className="field">
                  <label htmlFor="minutesWorked" className="t-label">Minutes of actual work</label>
                  <input
                    id="minutesWorked"
                    type="number"
                    min={1}
                    max={MINUTES_WORKED_MAX}
                    step="0.5"
                    value={minutesWorked}
                    onChange={(event) => setMinutesWorked(event.target.value)}
                    placeholder="Round time only, not rest"
                    className="input input--kiosk"
                  />
                </div>
              </div>
            </div>

            <label className="flex min-h-[var(--tap)] cursor-pointer items-center gap-[var(--s3)] text-[length:var(--t-md)]">
              <input
                type="checkbox"
                checked={focusAchieved}
                onChange={(event) => setFocusAchieved(event.target.checked)}
                className="h-[21px] w-[21px] accent-[var(--brass-600)]"
              />
              <span>I did the thing we were working on</span>
            </label>

            <div className="field">
              <label htmlFor="recoveryNotes" className="t-label">Notes on how it went</label>
              <textarea
                id="recoveryNotes"
                value={recoveryNotes}
                onChange={(event) => setRecoveryNotes(event.target.value)}
                maxLength={RECOVERY_NOTES_MAX_LENGTH}
                placeholder="How you felt after, anything that hurt, anything you want to work on..."
                className="textarea input--kiosk h-[89px]"
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting || !athleteId}
              className="btn btn--kiosk disabled:cursor-not-allowed disabled:opacity-50 disabled:grayscale"
            >
              {isSubmitting ? 'Saving…' : 'Log This Session'}
            </button>
          </section>

          <aside className="mat-leather grid gap-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s5)]">
            <div className="grid gap-[var(--s2)]">
              <p className="t-eyebrow m-0">Where this stands</p>
              <p className="m-0 text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-200)]" role="status">{statusMessage}</p>
            </div>

            <div className="grid gap-[var(--s4)] sm:grid-cols-2">
              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-label m-0">Rounds</p>
                <p className="t-data m-0 mt-[var(--s2)]" style={{ fontSize: 'var(--t-lg)' }}>{totalRoundsCompleted}</p>
              </div>
              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-label m-0">Their stance</p>
                <p className="t-data m-0 mt-[var(--s2)]" style={{ fontSize: 'var(--t-lg)' }}>{opponentStance}</p>
              </div>
              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-label m-0">Contact</p>
                <p className="t-data m-0 mt-[var(--s2)]" style={{ fontSize: 'var(--t-lg)' }}>{contactLevelLabel}</p>
              </div>
              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-label m-0">Last saved</p>
                <p className="t-data m-0 mt-[var(--s2)]" style={{ fontSize: 'var(--t-md)' }}>{lastSubmitted}</p>
              </div>
            </div>

            <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)] text-[length:var(--t-sm)] leading-relaxed text-[color:var(--bone-200)]">
              {actor === 'staff'
                ? 'This is filed against the athlete you chose. Contact logged without a current medical clearance, or during a training hold, raises a safety review -- the record is still kept.'
                : 'Nothing here is graded and nothing here is shared with the other kids. It stays on your record, and over time it is how you can see what is actually changing instead of guessing.'}
            </div>
          </aside>
        </div>
      </form>

      {/* Keyed by athlete: a coach switching athletes gets a fresh section,
          so the previous child's entries -- including a list or a fix still
          in flight when the picker changed -- can never appear under the new
          one. A late response lands on the unmounted instance and is dropped. */}
      <FixSparringEntry key={athleteId ?? 'no-athlete'} athleteId={athleteId} />

      {/* Reuses PrintSheet's gym identity -- same fix as
          coach/environment/passbook-check/page.tsx, same reason. */}
      <GymRegisteredOfficeLine className="t-muted px-[var(--s5)] pb-[var(--s6)]" />
    </RoleStandaloneView>
  );
}
