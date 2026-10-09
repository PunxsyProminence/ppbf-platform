'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import WorkAxis from '@/components/WorkAxis';

type MedicalStatusValue = 'cleared' | 'restricted' | 'not_cleared' | 'pending';
/* What the gates act on, as the route reports it beside the stored row: the
   stored value, or 'cleared_expired' for a 'cleared' row past its end date. */
type EffectiveMedicalStatus = MedicalStatusValue | 'cleared_expired';
type RecommendationStatus = 'provisional' | 'accepted' | 'rejected' | 'expired' | 'superseded';
type NearMissSeverity = 'low' | 'moderate' | 'high' | 'critical';
type IncidentSeverity = 'high' | 'critical';
type MatchState = 'match' | 'partial' | 'miss' | 'confounded';

interface AthleteListItem {
  athlete_id: string;
  full_name?: string;
}

interface MedicalStatusRow {
  status_id: string;
  athlete_id: string;
  status: MedicalStatusValue;
  restriction_flags: Record<string, unknown>;
  source_reference: string | null;
  set_by_account_id: string;
  set_by_role: string;
  effective_at: string;
  /* When a 'cleared' row stops counting, as Postgres text; null for none. */
  expires_at?: string | null;
  created_at: string;
  /* Not a column: the route's `effectiveStatus`, kept with the row it reads. */
  effective_status: EffectiveMedicalStatus;
}

interface RecommendationRow {
  recommendation_id: string;
  athlete_id: string;
  recommendation_text: string;
  expected_outcome: string;
  status: RecommendationStatus;
  created_by_account_id: string;
  created_at: string;
  expires_at: string;
  decided_by_account_id: string | null;
  decided_at: string | null;
}

interface DecisionRow {
  decision_id: string;
  athlete_id: string;
  recommendation_id: string | null;
  decision_text: string;
  expected_outcome: string;
  decided_by_account_id: string;
  decided_by_role: string;
  status: 'active' | 'superseded' | 'reversed';
  decided_at: string;
}

interface NearMissRow {
  near_miss_id: string;
  athlete_id: string;
  decision_id: string | null;
  description: string;
  severity: NearMissSeverity;
  detected_by: 'system' | 'human';
  created_at: string;
}

interface DecisionOutcomeRow {
  outcome_id: string;
  decision_id: string;
  observation_ids: string[];
  match_state: MatchState;
  notes: string | null;
  evaluated_by_account_id: string;
  evaluated_at: string;
}

const WRITE_NOT_CONFIRMED =
  'The server did not confirm this. It may or may not have gone through: check before sending it again.';

/* A WRITE IS CONFIRMED BY ITS ROUTE'S OWN ACKNOWLEDGEMENT, not by a 2xx. This
   used to read any 2xx as success and a body that would not parse as `{}`, so
   an incident report answered by a proxy's HTML page printed "Incident filed
   -- it is now in the escalation queue." Three outcomes, and only one of them
   is a success:
     - not ok, or a 200 that says `ok: false`: the server said no, or broke;
       shown with the server's own reason;
     - `{ ok: true, ... }` carrying what that route promises (`acknowledged`):
       confirmed;
     - anything else under a 200: NOT CONFIRMED. Not "failed" either -- the
       write may have landed -- so the coach is told exactly that, and what
       they typed stays in the box. */
async function confirmWriteOrThrow(
  response: Response,
  fallbackMessage: string,
  acknowledged: (envelope: Record<string, unknown>) => boolean,
): Promise<void> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const envelope = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
  if (!response.ok || envelope?.ok === false) {
    throw new Error(typeof envelope?.error === 'string' && envelope.error ? envelope.error : fallbackMessage);
  }
  if (!envelope || envelope.ok !== true || !acknowledged(envelope)) {
    throw new Error(WRITE_NOT_CONFIRMED);
  }
}

/** The row a write route returns under `key`, if it is one. */
function returnedRow(envelope: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const row = envelope[key];
  return row && typeof row === 'object' && !Array.isArray(row) ? (row as Record<string, unknown>) : null;
}

/* A READ. A body that will not parse used to become `{}`, and `{}` has no
   `status` and no lists -- and "no status, no lists" is exactly what a clean
   record looks like. A 200 that does not
   carry the envelope the route always sends has answered some other
   question -- a proxy page, a truncated body -- and is not a statement that
   there is nothing on record. */
async function readEnvelopeOrThrow(response: Response, fallbackMessage: string): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(fallbackMessage);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage);
  }
  const envelope = payload as Record<string, unknown>;
  // Every read route here answers success as `{ ok: true, ... }`. Anything
  // else under a 200 -- ok missing, 0, "false", null -- is not a success.
  if (!response.ok || envelope.ok !== true) {
    throw new Error(typeof envelope.error === 'string' && envelope.error ? envelope.error : fallbackMessage);
  }
  return envelope;
}

const MEDICAL_STATUS_VALUES: ReadonlySet<string> = new Set(['cleared', 'restricted', 'not_cleared', 'pending']);

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/* The status panel prints who set the status, in what role and when. A row
   that says "cleared" and nothing else is not a readable record: it would
   render "Current status: cleared -- Set by undefined (undefined) at
   undefined". And a row that belongs to a different athlete than the one
   asked about is not this athlete's status at all.

   The badge prints `effectiveStatus`, the reading the gates act on, never the
   stored word: a lapsed clearance is still stored as 'cleared'. It is taken
   only when it agrees with the row it came with -- 'no_record' for no row,
   the stored value, or 'cleared_expired' for a stored 'cleared'. A body
   without it, or one that contradicts its own row, is not a status. */
function readMedicalStatus(
  envelope: Record<string, unknown>,
  forAthleteId: string,
  fallbackMessage: string,
): MedicalStatusRow | null {
  if (!('status' in envelope)) throw new Error(fallbackMessage);
  const status = envelope.status;
  const effective = envelope.effectiveStatus;
  if (status === null) {
    if (effective !== 'no_record') throw new Error(fallbackMessage);
    return null;
  }
  if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error(fallbackMessage);
  const row = status as Record<string, unknown>;
  if (
    !isFilled(row.status_id)
    || !isFilled(row.athlete_id)
    || row.athlete_id !== forAthleteId
    || typeof row.status !== 'string'
    || !MEDICAL_STATUS_VALUES.has(row.status)
    || !isFilled(row.set_by_account_id)
    || !isFilled(row.set_by_role)
    || !isFilled(row.effective_at)
    || !(row.source_reference === null || typeof row.source_reference === 'string')
    || !(effective === row.status || (row.status === 'cleared' && effective === 'cleared_expired'))
  ) {
    throw new Error(fallbackMessage);
  }
  return { ...(status as MedicalStatusRow), effective_status: effective as EffectiveMedicalStatus };
}

/* The route sends `expires_at` as Postgres text ('2026-09-01 16:00:00+00'),
   which not every browser's Date will read. ISO 8601 all of them do. */
function isoInstant(value: string): string {
  return value.trim().replace(' ', 'T').replace(/(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?[+-]\d{2})$/, '$1:00');
}

/* The clock is looked at again at least this often while waiting. One long
   timer would not do: a timer does not run while a tablet sleeps, so a
   clearance ending during the night would be noticed hours into the morning;
   and setTimeout overflows a little under 25 days out and fires at once. */
const LONGEST_WAIT_MS = 60_000;
const RECHECK_MS = 30_000;

/* Calls `onDue` once `instant` has passed, and again every RECHECK_MS until it
   is cancelled. It decides nothing: `onDue` asks the route again, and the
   caller cancels when the route stops answering 'cleared'. The repeat is for a
   device whose clock runs ahead of the server's, which gets 'cleared' back the
   first time it asks. */
function whenPassed(instant: string, onDue: () => void): () => void {
  const due = new Date(isoInstant(instant)).getTime();
  if (Number.isNaN(due)) return () => {};
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    if (cancelled) return;
    const wait = due - Date.now();
    timer = setTimeout(() => {
      if (Date.now() >= due) onDue();
      arm();
    }, wait > 0 ? Math.min(wait, LONGEST_WAIT_MS) : RECHECK_MS);
  };
  arm();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

/* `textFields` are the fields the page prints or slices for each row. A row
   without one of them would throw in the middle of rendering and take the
   whole page down, which is a worse answer than "could not be read". */
function readList<T>(
  envelope: Record<string, unknown>,
  key: string,
  textFields: readonly string[],
  fallbackMessage: string,
): T[] {
  const list = envelope[key];
  if (
    !Array.isArray(list)
    || list.some(
      (item) =>
        !item
        || typeof item !== 'object'
        || textFields.some((field) => typeof (item as Record<string, unknown>)[field] !== 'string'),
    )
  ) {
    throw new Error(fallbackMessage);
  }
  return list as T[];
}

/* The four things read for one athlete, plus the outcomes loaded on demand. */
interface AthleteRecords {
  medicalStatus: MedicalStatusRow | null;
  recommendations: RecommendationRow[];
  decisions: DecisionRow[];
  nearMisses: NearMissRow[];
  outcomesByDecision: Record<string, DecisionOutcomeRow[]>;
}

const NO_RECORDS: AthleteRecords = {
  medicalStatus: null,
  recommendations: [],
  decisions: [],
  nearMisses: [],
  outcomesByDecision: {},
};

/* Every status on this page is a queue outcome or the safety gate itself, so
   it maps onto the design system's four-rung ladder and renders as a `.badge`:
   glyph + uppercase label, never colour alone (Laws 2 + 3). Lifecycle values
   that are neither a safety state nor an outcome (expired, superseded,
   confounded) take a neutral chip. */
type BadgeTone = 'cleared' | 'monitor' | 'restricted' | 'locked' | 'neutral';

const BADGE_GLYPH: Record<Exclude<BadgeTone, 'neutral'>, string> = {
  cleared: '✓',
  monitor: '◉',
  restricted: '▲',
  locked: '✕',
};

function statusBadgeTone(status: string): BadgeTone {
  if (status === 'accepted' || status === 'cleared' || status === 'active' || status === 'match') return 'cleared';
  if (status === 'provisional' || status === 'pending' || status === 'partial' || status === 'cleared_expired') return 'restricted';
  if (status === 'rejected' || status === 'not_cleared' || status === 'miss') return 'locked';
  return 'neutral';
}

/* The one status whose stored word is not the word a coach reads
   (OD-2026-10-01-007 section 4). */
const STATUS_LABEL: Record<string, string> = { cleared_expired: 'clearance expired' };

function StatusBadge({ status }: { readonly status: string }) {
  const tone = statusBadgeTone(status);
  if (tone === 'neutral') {
    return (
      <span className="badge badge--filed">
        <i>◌</i>
        {status}
      </span>
    );
  }
  return (
    <span className={`badge badge--${tone}`}>
      <i>{BADGE_GLYPH[tone]}</i>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

/* Everything a coach can type or choose on this page before pressing a button.
   One object per athlete: a draft belongs to the athlete it was written for. */
interface Drafts {
  medicalStatusDraft: MedicalStatusValue;
  medicalSourceRef: string;
  decisionText: string;
  decisionExpectedOutcome: string;
  decisionRecommendationId: string;
  nearMissDescription: string;
  nearMissSeverity: NearMissSeverity;
  nearMissDecisionId: string;
  incidentDescription: string;
  incidentSeverity: IncidentSeverity;
  incidentOccurredAt: string;
  behaviorNoteText: string;
  messageHomeText: string;
  messageHomeDueDate: string;
  outcomeDecisionId: string;
  outcomeObservationIds: string;
  outcomeMatchState: MatchState;
  outcomeNotes: string;
}

const EMPTY_DRAFTS: Drafts = {
  medicalStatusDraft: 'pending',
  medicalSourceRef: '',
  decisionText: '',
  decisionExpectedOutcome: '',
  decisionRecommendationId: '',
  nearMissDescription: '',
  nearMissSeverity: 'low',
  nearMissDecisionId: '',
  incidentDescription: '',
  incidentSeverity: 'high',
  incidentOccurredAt: '',
  behaviorNoteText: '',
  messageHomeText: '',
  messageHomeDueDate: '',
  outcomeDecisionId: '',
  outcomeObservationIds: '',
  outcomeMatchState: 'match',
  outcomeNotes: '',
};

type SubmitKind = 'incident' | 'behaviorNote' | 'messageHome';

const PREVIOUS_ATHLETE_WRITE_FAILED =
  'Something you submitted for the athlete you were on before did not go through. Go back to them and check.';

export default function DecisionLoopReviewPage() {
  const [athletes, setAthletes] = useState<AthleteListItem[]>([]);
  const [athleteId, setAthleteId] = useState('');
  const [loading, setLoading] = useState(false);
  /* THE RECORDS ON SCREEN CARRY THE ATHLETE THEY WERE READ FOR. They used to
     be four loose pieces of state that only a successful read replaced, so a
     failed switch from A to B left A's medical administrative status under
     B; and clearing them in an effect still left one render in which the
     selection said B and the records said A. Now they are one value with its
     athlete's id on it, and the page looks at it only when that id is the
     selected one. For anyone else it is 'loading': nobody has looked yet.

     'loaded' is the only state in which an empty list is a fact ("the
     platform looked and there is nothing"). */
  const [readFor, setReadFor] = useState<{
    athleteId: string;
    state: 'loaded' | 'unavailable';
    records: AthleteRecords;
  } | null>(null);
  const current = readFor && readFor.athleteId === athleteId ? readFor : null;
  const loadState: 'loading' | 'loaded' | 'unavailable' = current ? current.state : 'loading';
  const loadFailed = loadState === 'unavailable';
  const { medicalStatus, recommendations, decisions, nearMisses, outcomesByDecision } = current?.records ?? NO_RECORDS;
  /* Which athlete is selected, and which read is the newest, readable from
     inside a request that started under a different render. A read or a write
     answers for the athlete it was made for, not for whoever is selected when
     it comes back. Both are moved in selectAthlete, in the same event as the
     selection itself. */
  const selectedAthleteRef = useRef('');
  const readSeqRef = useRef(0);
  /* The athlete whose medical status a timed re-read failed to get: for them
     the status is unknown until a read succeeds. See rereadMedicalStatus. */
  const [statusUnreadFor, setStatusUnreadFor] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  /* "Something you submitted for the athlete you were on before did not go
     through." Its own slot, not the error line: every read blanks or
     overwrites the error line, so the next thing that happened under the new
     athlete used to erase this before the coach had seen it -- and for an
     incident report that is the only trace that it failed. It stays until
     the coach changes the selection. */
  const [previousAthleteNotice, setPreviousAthleteNotice] = useState('');
  /* THE NOT-CONFIRMED LINE OUTLIVES READS. "The server did not confirm this
     ... check before sending it again" is the one thing standing between a
     coach and a second send, and every read used to blank the error line: a
     different write confirming a moment later (its re-read) erased it within
     milliseconds. A read no longer touches that line. It goes when the coach
     changes the selection, when another message replaces it, or when a write
     that was STARTED AFTER it appeared is confirmed -- which is what
     `beginWrite` hands each handler the means to say. */
  const unconfirmedSeqRef = useRef(0);
  function beginWrite(): () => void {
    const startedAt = unconfirmedSeqRef.current;
    return () => {
      if (startedAt === unconfirmedSeqRef.current) {
        setErrorMessage((shown) => (shown === WRITE_NOT_CONFIRMED ? '' : shown));
      }
    };
  }

  /* DRAFTS BELONG TO AN ATHLETE. Every box and selector below used to be its
     own piece of page state, and the page sends whatever is in them with the
     athlete selected AT THE MOMENT THE BUTTON IS PRESSED. So a Message Home
     written about athlete A, then a switch to B, then one click, went to B's
     family; "Cleared" plus A's physician reference could be set on B; A's
     incident could be filed against B.

     The drafts are now kept PER ATHLETE, keyed by the athlete they were
     written for. A draft is shown, and can be submitted, only while its
     athlete is the one on screen: for anyone else the forms hold that
     athlete's own draft or their empty defaults, in the same render as the
     switch -- there is no moment where A's text sits under B, and no request
     for B can be built from it. (The athlete-ID box changes the selection on
     every keystroke, so "switch" cannot mean a deliberate act: the draft is
     looked up by the selected id on every render instead.)

     Per athlete rather than one slot with an owner, because one slot is
     emptied by the first keystroke under the next athlete: an incident report
     for A that fails after the coach has started typing for B must still be
     there when the page says "go back to them and check".

     Page memory only. Nothing here is written to storage or sent anywhere
     until a button is pressed; a reload or a sign-out drops every draft. */
  // A Map, not a plain object: the ID box takes any text, and "constructor"
  // or "toString" looked up on an object finds something that is not a draft.
  const [draftsByAthlete, setDraftsByAthlete] = useState<ReadonlyMap<string, Drafts>>(new Map());
  const drafts = draftsByAthlete.get(athleteId) ?? EMPTY_DRAFTS;
  const {
    medicalStatusDraft,
    medicalSourceRef,
    decisionText,
    decisionExpectedOutcome,
    nearMissDescription,
    nearMissSeverity,
    incidentDescription,
    incidentSeverity,
    incidentOccurredAt,
    behaviorNoteText,
    messageHomeText,
    messageHomeDueDate,
    outcomeObservationIds,
    outcomeMatchState,
    outcomeNotes,
  } = drafts;

  /* The three selections that point INTO the athlete's loaded records are
     only real while the record they point at is on screen. A kept id whose
     option is not in the list (the lists are cleared on every switch and on a
     failed read) shows as "None" in its selector -- so it must be none in the
     request too, not a link the coach cannot see. */
  const decisionRecommendationId = recommendations.some(
    (rec) => rec.recommendation_id === drafts.decisionRecommendationId && (rec.status === 'provisional' || rec.status === 'accepted'),
  )
    ? drafts.decisionRecommendationId
    : '';
  const nearMissDecisionId = decisions.some((decision) => decision.decision_id === drafts.nearMissDecisionId)
    ? drafts.nearMissDecisionId
    : '';
  const outcomeDecisionId = decisions.some((decision) => decision.decision_id === drafts.outcomeDecisionId)
    ? drafts.outcomeDecisionId
    : '';

  function editDraft<K extends keyof Drafts>(key: K, value: Drafts[K]) {
    setDraftsByAthlete((current) =>
      new Map(current).set(athleteId, { ...(current.get(athleteId) ?? EMPTY_DRAFTS), [key]: value }),
    );
  }

  /* After a write lands: empty the fields it sent -- in the draft of the
     athlete it was sent for, whoever is on screen now, and only where the box
     still holds what was sent. A late answer for athlete A must not wipe what
     the coach has typed for B, or typed again for A; and it must not leave the
     sent text in A's box to be sent a second time.

     `links` are the record selections that went with the send. They are
     emptied whatever they hold: the value sent is the DERIVED one (none, if
     its record was off screen), so comparing would leave a kept id behind to
     reappear over empty boxes on the next good read. */
  function clearSentDrafts(forAthleteId: string, sent: Partial<Drafts>, links: ReadonlyArray<keyof Drafts> = []) {
    setDraftsByAthlete((current) => {
      const mine = current.get(forAthleteId);
      if (!mine) return current;
      const next: Drafts = { ...mine };
      for (const key of Object.keys(sent) as Array<keyof Drafts>) {
        if (next[key] === sent[key]) Object.assign(next, { [key]: EMPTY_DRAFTS[key] });
      }
      for (const key of links) Object.assign(next, { [key]: EMPTY_DRAFTS[key] });
      return new Map(current).set(forAthleteId, next);
    });
  }

  const [incidentFiledMessage, setIncidentFiledMessage] = useState('');
  const [behaviorNoteMessage, setBehaviorNoteMessage] = useState('');
  const [messageHomeMessage, setMessageHomeMessage] = useState('');

  /* In flight, per athlete. One flag for the page left athlete B's button
     reading "Filing…" and locked while a report for A was still out. */
  const [submitting, setSubmitting] = useState<ReadonlySet<string>>(new Set());
  function markSubmitting(kind: SubmitKind, forAthleteId: string, on: boolean) {
    setSubmitting((current) => {
      const next = new Set(current);
      if (on) next.add(`${kind}:${forAthleteId}`);
      else next.delete(`${kind}:${forAthleteId}`);
      return next;
    });
  }
  const incidentSubmitting = submitting.has(`incident:${athleteId}`);
  const behaviorNoteSubmitting = submitting.has(`behaviorNote:${athleteId}`);
  const messageHomeSubmitting = submitting.has(`messageHome:${athleteId}`);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, { credentials: 'include' });
        if (!response.ok) return;
        const payload = (await response.json()) as { items?: AthleteListItem[] };
        setAthletes(payload.items ?? []);
      } catch {
        // Manual athleteId entry remains available if the roster fetch fails.
      }
    })();
  }, []);

  const refreshAll = useCallback(async (targetAthleteId: string, keepErrorLine = false) => {
    // A write for athlete A that finishes after the coach moved to B asks to
    // re-read A. B is on screen; A's records do not belong there.
    if (targetAthleteId !== selectedAthleteRef.current) {
      return;
    }
    const seq = ++readSeqRef.current;
    // Round 9 review: these confirmation banners are scoped to whichever
    // athlete was on screen when the form was submitted. Without this they
    // survive a switch to a different athlete's data below them, reading as
    // if that report/note was just filed for the athlete now selected.
    setIncidentFiledMessage('');
    setBehaviorNoteMessage('');
    setMessageHomeMessage('');
    if (!targetAthleteId) {
      return;
    }
    setLoading(true);
    if (!keepErrorLine) setErrorMessage((shown) => (shown === WRITE_NOT_CONFIRMED ? shown : ''));
    try {
      const [statusRes, recsRes, decisionsRes, nearMissesRes] = await Promise.all([
        fetch(`${apiBase()}/api/pilot/shadow/medical-status?athleteId=${encodeURIComponent(targetAthleteId)}`, { credentials: 'include' }),
        fetch(`${apiBase()}/api/pilot/shadow/recommendations?athleteId=${encodeURIComponent(targetAthleteId)}`, { credentials: 'include' }),
        fetch(`${apiBase()}/api/pilot/shadow/decisions?athleteId=${encodeURIComponent(targetAthleteId)}`, { credentials: 'include' }),
        fetch(`${apiBase()}/api/pilot/shadow/near-misses?athleteId=${encodeURIComponent(targetAthleteId)}`, { credentials: 'include' }),
      ]);

      const records: AthleteRecords = {
        medicalStatus: readMedicalStatus(
          await readEnvelopeOrThrow(statusRes, 'Failed to load medical status.'),
          targetAthleteId,
          'Failed to load medical status.',
        ),
        recommendations: readList<RecommendationRow>(
          await readEnvelopeOrThrow(recsRes, 'Failed to load recommendations.'),
          'recommendations',
          ['recommendation_id', 'recommendation_text', 'expected_outcome', 'status', 'expires_at'],
          'Failed to load recommendations.',
        ),
        decisions: readList<DecisionRow>(
          await readEnvelopeOrThrow(decisionsRes, 'Failed to load decisions.'),
          'decisions',
          ['decision_id', 'decision_text', 'expected_outcome', 'decided_by_role', 'decided_at'],
          'Failed to load decisions.',
        ),
        nearMisses: readList<NearMissRow>(
          await readEnvelopeOrThrow(nearMissesRes, 'Failed to load near-misses.'),
          'nearMisses',
          ['near_miss_id', 'description', 'severity', 'created_at'],
          'Failed to load near-misses.',
        ),
        outcomesByDecision: {},
      };

      if (seq !== readSeqRef.current) return;
      setReadFor({ athleteId: targetAthleteId, state: 'loaded', records });
      setStatusUnreadFor(null);
    } catch (error) {
      if (seq !== readSeqRef.current) return;
      /* ALL FOUR SECTIONS BELOW ARE NOW UNREADABLE, NOT EMPTY. This one load
         feeds the medical status, the recommendations, the decisions and the
         near-misses, and each of their empty states asserts a fact -- "No
         medical administrative status recorded yet" most of all, which is
         what a coach reads before putting a child into contact work. The
         error line alone was not enough: it renders in the picker header
         while four sections below independently say "clear".

         They are also EMPTIED, not left as they were. Whatever they hold was
         read before this failure: after a failed re-read that follows a
         write, the old medical status would otherwise still read "Current
         status" under an error line. */
      setReadFor({ athleteId: targetAthleteId, state: 'unavailable', records: NO_RECORDS });
      // A line that was deliberately kept up for this read ("the server did
      // not confirm this ... check before sending it again") is not replaced
      // by the news that the check itself failed. The four panels already say
      // they could not be read; the line the coach must not lose is the one
      // about the write.
      const readFailure = error instanceof Error ? error.message : 'Failed to load decision loop data.';
      setErrorMessage((shown) => (keepErrorLine || shown === WRITE_NOT_CONFIRMED ? shown : readFailure));
    } finally {
      if (seq === readSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The read for whoever is selected. Everything that must be gone BEFORE
    // this athlete is on screen was done in selectAthlete, in the event.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshAll(athleteId);
  }, [athleteId, refreshAll]);

  /* A CLEARANCE CAN RUN OUT WHILE THIS SCREEN IS OPEN. The badge is what the
     route said at the last read; left alone it would go on saying "cleared"
     past the end date while the gate refuses. So the medical status of the
     athlete on screen is read again when a clearance in force reaches its end
     date, and the panel shows what the route answers. The page does not work
     out the verdict from the date itself.

     Only the status is read, and only the status is replaced: nobody pressed
     anything, so the coach's confirmation lines, the opened outcomes and the
     other three panels stay as they are. It is dropped if the selection has
     changed or a full read has started since it was sent (that read brings its
     own status), and it paints only onto the records of the athlete it was
     read for.

     If it fails, the status is unknown: the panel says "could not be read"
     for that athlete instead of the badge it had, the other panels are left
     alone, and the timer keeps asking until the route answers. A tablet that
     wakes before its network does gets its status back by itself. */
  const statusRereadSeqRef = useRef(0);
  const rereadMedicalStatus = useCallback(async (targetAthleteId: string) => {
    if (targetAthleteId !== selectedAthleteRef.current) return;
    const readSeq = readSeqRef.current;
    const seq = ++statusRereadSeqRef.current;
    const stale = () => readSeq !== readSeqRef.current || seq !== statusRereadSeqRef.current;
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/shadow/medical-status?athleteId=${encodeURIComponent(targetAthleteId)}`,
        { credentials: 'include' },
      );
      const reread = readMedicalStatus(
        await readEnvelopeOrThrow(response, 'Failed to load medical status.'),
        targetAthleteId,
        'Failed to load medical status.',
      );
      if (stale()) return;
      setReadFor((shown) =>
        shown && shown.athleteId === targetAthleteId && shown.state === 'loaded'
          ? { ...shown, records: { ...shown.records, medicalStatus: reread } }
          : shown,
      );
      setStatusUnreadFor(null);
    } catch {
      if (stale()) return;
      setStatusUnreadFor(targetAthleteId);
    }
  }, []);
  const statusUnread = !!athleteId && statusUnreadFor === athleteId;
  const clearanceEndsAt =
    medicalStatus?.effective_status === 'cleared' && typeof medicalStatus.expires_at === 'string'
      ? medicalStatus.expires_at
      : null;
  useEffect(() => {
    if (!athleteId || !clearanceEndsAt) return undefined;
    return whenPassed(clearanceEndsAt, () => void rereadMedicalStatus(athleteId));
  }, [athleteId, clearanceEndsAt, rereadMedicalStatus]);

  /* THE ONE PLACE THE SELECTION CHANGES, for the dropdown and for the ID box.
     Everything that belonged to the previous athlete goes in the same event
     that selects the next one, so React renders the new selection and the
     emptied page together: there is no render with B selected and A's error
     line or confirmation still up. (The records
     themselves need no clearing here: they carry their athlete's id and are
     not looked at for anyone else. See readFor.)

     The refs move here too, not in an effect: a write for A that resolves
     between this event and the next effect must already see that A is no
     longer the selection. */
  function selectAthlete(nextAthleteId: string) {
    selectedAthleteRef.current = nextAthleteId;
    readSeqRef.current += 1;
    setAthleteId(nextAthleteId);
    setStatusUnreadFor(null);
    /* The one draft that is NOT kept for its athlete: the medical status
       selection and its source reference. A "Cleared" left selected from an
       earlier visit is one click from being set; every arrival at an athlete
       starts that form at its default, Pending with no reference. (The
       selections that carry recommendation and decision ids are drafts too,
       kept per athlete and honoured only while the record they point at is
       loaded: see draftsByAthlete.) */
    setDraftsByAthlete((kept) => {
      const next = new Map<string, Drafts>();
      for (const [id, draft] of kept) {
        next.set(id, {
          ...draft,
          medicalStatusDraft: EMPTY_DRAFTS.medicalStatusDraft,
          medicalSourceRef: EMPTY_DRAFTS.medicalSourceRef,
        });
      }
      return next;
    });
    setIncidentFiledMessage('');
    setBehaviorNoteMessage('');
    setMessageHomeMessage('');
    setLoading(false);
    setErrorMessage('');
    setPreviousAthleteNotice('');
  }


  /* EVERY HANDLER BELOW answers for the athlete it was submitted under --
     the `athleteId` its closure captured. A write for athlete A that lands
     after the switch to B used to print its result under B: a refusal that
     quotes A's medical status ("this athlete's medical administrative status
     is 'restricted'"), or "Incident filed" / "Posted to the family's page" for a child
     nobody is looking at.

     On a late SUCCESS the submitted draft is still cleared, in the draft of
     the athlete it was sent for (it was sent; left in their box it reads as
     unsent and one click sends it again), and the confirmation and the
     re-read are dropped. On a late FAILURE the
     server's text is withheld -- it describes A -- but the coach is still
     told that something they did has not gone through: an incident report
     that silently failed is worse than a vague line. */
  function reportWriteError(forAthleteId: string, error: unknown, fallback: string) {
    if (forAthleteId !== selectedAthleteRef.current) {
      setPreviousAthleteNotice(PREVIOUS_ATHLETE_WRITE_FAILED);
      return;
    }
    const message = error instanceof Error ? error.message : fallback;
    setErrorMessage(message);
    // "Check before sending it again" has to be checkable. A write that was
    // not confirmed may have landed: read the athlete again, keeping this
    // line up, so the status, decisions and near-misses on screen are what
    // the server holds now.
    if (message === WRITE_NOT_CONFIRMED) {
      unconfirmedSeqRef.current += 1;
      void refreshAll(forAthleteId, true);
    }
  }

  async function handleSetMedicalStatus(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!athleteId) return;
    const writeConfirmed = beginWrite();
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/medical-status`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athleteId,
          status: medicalStatusDraft,
          sourceReference: medicalSourceRef || undefined,
        }),
      });
      // shadow/medical-status answers { ok: true, status: <the new row> }.
      await confirmWriteOrThrow(response, 'Failed to set medical status.', (envelope) => {
        const row = returnedRow(envelope, 'status');
        return !!row && isFilled(row.status_id) && row.athlete_id === athleteId && row.status === medicalStatusDraft;
      });
      // The selection goes back to Pending too: a status left selected after
      // it was set is one click from being set again.
      clearSentDrafts(athleteId, { medicalSourceRef, medicalStatusDraft });
      if (athleteId !== selectedAthleteRef.current) return;
      writeConfirmed();
      await refreshAll(athleteId);
    } catch (error) {
      reportWriteError(athleteId, error, 'Failed to set medical status.');
    }
  }

  async function handleDecideRecommendation(recommendationId: string, decision: 'accepted' | 'rejected') {
    const writeConfirmed = beginWrite();
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/recommendations/decide`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ athleteId, recommendationId, decision }),
      });
      // shadow/recommendations/decide answers { ok: true, recommendation: <row> }.
      await confirmWriteOrThrow(response, 'Failed to record decision on recommendation.', (envelope) => {
        const row = returnedRow(envelope, 'recommendation');
        return (
          !!row
          && row.recommendation_id === recommendationId
          && row.athlete_id === athleteId
          && row.status === decision
        );
      });
      if (athleteId !== selectedAthleteRef.current) return;
      writeConfirmed();
      await refreshAll(athleteId);
    } catch (error) {
      reportWriteError(athleteId, error, 'Failed to record decision on recommendation.');
    }
  }

  async function handleRecordDecision(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!athleteId || !decisionText.trim() || !decisionExpectedOutcome.trim()) return;
    const writeConfirmed = beginWrite();
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/decisions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // Exactly the four fields /api/pilot/shadow/decisions declares it
        // reads. This body used to carry a fifth, isMedicallySensitive, off a
        // checkbox the coach could tick; the route never mentioned it, so the
        // control moved nothing in either direction while its label said it
        // gated the clearance check. The check is not optional -- see the note
        // above the form -- and a request must not carry a field that claims
        // otherwise. decisionRequestContract.test.ts holds this shut.
        body: JSON.stringify({
          athleteId,
          recommendationId: decisionRecommendationId || undefined,
          decisionText,
          expectedOutcome: decisionExpectedOutcome,
        }),
      });
      // shadow/decisions answers { ok: true, decision: <row> }.
      await confirmWriteOrThrow(response, 'Failed to record decision.', (envelope) => {
        const row = returnedRow(envelope, 'decision');
        return !!row && isFilled(row.decision_id) && row.athlete_id === athleteId;
      });
      clearSentDrafts(athleteId, { decisionText, decisionExpectedOutcome }, ['decisionRecommendationId']);
      if (athleteId !== selectedAthleteRef.current) return;
      writeConfirmed();
      await refreshAll(athleteId);
    } catch (error) {
      reportWriteError(athleteId, error, 'Failed to record decision.');
    }
  }

  async function handleFlagNearMiss(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!athleteId || !nearMissDescription.trim()) return;
    const writeConfirmed = beginWrite();
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/near-misses`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athleteId,
          decisionId: nearMissDecisionId || undefined,
          description: nearMissDescription,
          severity: nearMissSeverity,
        }),
      });
      // shadow/near-misses answers { ok: true, nearMiss: <row> }.
      await confirmWriteOrThrow(response, 'Failed to flag near-miss.', (envelope) => {
        const row = returnedRow(envelope, 'nearMiss');
        return !!row && isFilled(row.near_miss_id) && row.athlete_id === athleteId;
      });
      clearSentDrafts(athleteId, { nearMissDescription, nearMissSeverity }, ['nearMissDecisionId']);
      if (athleteId !== selectedAthleteRef.current) return;
      writeConfirmed();
      await refreshAll(athleteId);
    } catch (error) {
      reportWriteError(athleteId, error, 'Failed to flag near-miss.');
    }
  }

  // Capability #152: a post-hoc report that something actually happened --
  // distinct from a near-miss above, which is a close call. Filing lands
  // directly in the escalation ladder (severity forced high/critical), so
  // there is no separate list to refresh here -- /admin/escalations is
  // where a filed incident is read back and acted on.
  async function handleReportIncident(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!athleteId || !incidentDescription.trim() || incidentSubmitting) return;
    setIncidentFiledMessage('');
    markSubmitting('incident', athleteId, true);
    const writeConfirmed = beginWrite();
    try {
      const response = await fetch(`${apiBase()}/api/pilot/incidents`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athleteId,
          description: incidentDescription,
          severity: incidentSeverity,
          occurredAt: incidentOccurredAt || undefined,
        }),
      });
      // incidents answers { ok: true, escalation: <the escalation row> }.
      await confirmWriteOrThrow(response, 'Failed to file incident report.', (envelope) => {
        const row = returnedRow(envelope, 'escalation');
        return !!row && isFilled(row.escalation_id) && row.athlete_id === athleteId;
      });
      clearSentDrafts(athleteId, { incidentDescription, incidentSeverity, incidentOccurredAt });
      if (athleteId !== selectedAthleteRef.current) return;
      writeConfirmed();
      setIncidentFiledMessage('Incident filed -- it is now in the escalation queue.');
    } catch (error) {
      reportWriteError(athleteId, error, 'Failed to file incident report.');
    } finally {
      markSubmitting('incident', athleteId, false);
    }
  }

  // Capability #125/#70/#74: capture only, deliberately. pilot.coach_observations'
  // note_type column already accepts any free-text value with no taxonomy
  // (createCoachObservation/domain-upsert), so this is a UI wiring gap, not
  // a schema one -- reuses domain-upsert directly rather than a new route.
  // A single generic note_type ('behavior_standard') is used on purpose:
  // picking specific category names (e.g. "respect," "effort") is a
  // coaching-philosophy decision for the gym's own staff, not something to
  // invent here. Pattern detection, streaks, and consequences are Phase 6
  // scope (#70/#74's own engines) and are not attempted by this capture form.
  async function handleLogBehaviorNote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!athleteId || !behaviorNoteText.trim() || behaviorNoteSubmitting) return;
    setBehaviorNoteMessage('');
    markSubmitting('behaviorNote', athleteId, true);
    const writeConfirmed = beginWrite();
    try {
      const response = await fetch(`${apiBase()}/api/pilot/intake/domain-upsert`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_type: 'coach_note',
          athlete_id: athleteId,
          payload: { note_type: 'behavior_standard', note_text: behaviorNoteText },
        }),
      });
      // intake/domain-upsert answers { ok: true, entity_type, entity_id,
      // athlete_id }, with the athlete id TRIMMED (the route trims it).
      await confirmWriteOrThrow(response, 'Failed to log the note.', (envelope) =>
        envelope.entity_type === 'coach_note' && isFilled(envelope.entity_id) && envelope.athlete_id === athleteId.trim(),
      );
      clearSentDrafts(athleteId, { behaviorNoteText });
      if (athleteId !== selectedAthleteRef.current) return;
      writeConfirmed();
      setBehaviorNoteMessage('Note logged.');
    } catch (error) {
      reportWriteError(athleteId, error, 'Failed to log the note.');
    } finally {
      markSubmitting('behaviorNote', athleteId, false);
    }
  }

  // Capability #90, scoped down deliberately to one-directional send: a
  // coach/admin message to the athlete's guardian(s), read on
  // /parent/messages. Reply, threading, and messaging any coach besides the
  // athlete's own are real moderation/product decisions, not attempted
  // here. Reuses domain-upsert exactly like the Behavior Note panel above --
  // note_type: 'parent_message' is the one value listParentMessages reads
  // back, so a message sent here and nothing else ever reaches a guardian's
  // feed.
  async function handleMessageHome(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!athleteId || !messageHomeText.trim() || messageHomeSubmitting) return;
    setMessageHomeMessage('');
    markSubmitting('messageHome', athleteId, true);
    const writeConfirmed = beginWrite();
    try {
      const response = await fetch(`${apiBase()}/api/pilot/intake/domain-upsert`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_type: 'coach_note',
          athlete_id: athleteId,
          payload: { note_type: 'parent_message', note_text: messageHomeText },
        }),
      });
      // intake/domain-upsert answers { ok: true, entity_type, entity_id,
      // athlete_id }, with the athlete id TRIMMED (the route trims it).
      let noteId = '';
      await confirmWriteOrThrow(response, 'Failed to post the message.', (envelope) => {
        if (envelope.entity_type !== 'coach_note' || !isFilled(envelope.entity_id) || envelope.athlete_id !== athleteId.trim()) {
          return false;
        }
        noteId = envelope.entity_id;
        return true;
      });
      clearSentDrafts(athleteId, { messageHomeText, messageHomeDueDate });
      if (athleteId !== selectedAthleteRef.current) return;
      writeConfirmed();
      setMessageHomeMessage(
        messageHomeDueDate ? await attachDueDate(noteId, athleteId, messageHomeDueDate) : "Posted to the family's page.",
      );
    } catch (error) {
      reportWriteError(athleteId, error, 'Failed to post the message.');
    } finally {
      markSubmitting('messageHome', athleteId, false);
    }
  }

  /* THE DUE DATE IS A SECOND WRITE, and it is reported as one. The message is
     a coach_note the family's page already reads; the deadline lives in
     pilot.parent_task_state and is set through /api/pilot/parent-tasks after
     the note exists. If that second write fails the note has still landed and
     the family will read it, so the confirmation says exactly that rather
     than reporting a failure that would invite the coach to post it twice.
     Nothing on this page can re-attach a date to a posted message; a coach
     who needs the deadline posts a short follow-up with the date set. */
  async function attachDueDate(noteId: string, forAthleteId: string, dueDate: string): Promise<string> {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/parent-tasks`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note_id: noteId, athlete_id: forAthleteId, due_date: dueDate }),
      });
      await confirmWriteOrThrow(response, 'Failed to set the due date.', (envelope) => {
        const task = returnedRow(envelope, 'task');
        return task !== null && task.due_date === dueDate;
      });
      return `Posted to the family's page, due ${dueDate}.`;
    } catch {
      return "Posted to the family's page, but without the due date -- the date did not save. Post a short follow-up with the date if the family needs it.";
    }
  }

  async function handleLoadOutcomes(decisionId: string) {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/decision-outcomes?decisionId=${encodeURIComponent(decisionId)}`, {
        credentials: 'include',
      });
      const outcomes = readList<DecisionOutcomeRow>(
        await readEnvelopeOrThrow(response, 'Failed to load decision outcomes.'),
        'outcomes',
        ['outcome_id', 'match_state'],
        'Failed to load decision outcomes.',
      );
      if (athleteId !== selectedAthleteRef.current) return;
      setReadFor((held) =>
        held && held.athleteId === athleteId
          ? { ...held, records: { ...held.records, outcomesByDecision: { ...held.records.outcomesByDecision, [decisionId]: outcomes } } }
          : held,
      );
    } catch (error) {
      if (athleteId !== selectedAthleteRef.current) return;
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load decision outcomes.');
    }
  }

  async function handleEvaluateOutcome(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!outcomeDecisionId) return;
    const writeConfirmed = beginWrite();
    try {
      const observationIds = outcomeObservationIds
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0);

      const response = await fetch(`${apiBase()}/api/pilot/shadow/decision-outcomes`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decisionId: outcomeDecisionId,
          observationIds,
          matchState: outcomeMatchState,
          notes: outcomeNotes || undefined,
        }),
      });
      // shadow/decision-outcomes answers { ok: true, outcome: <row> }.
      await confirmWriteOrThrow(response, 'Failed to evaluate decision outcome.', (envelope) => {
        const row = returnedRow(envelope, 'outcome');
        return !!row && isFilled(row.outcome_id) && row.decision_id === outcomeDecisionId;
      });
      clearSentDrafts(athleteId, { outcomeObservationIds, outcomeNotes });
      if (athleteId !== selectedAthleteRef.current) return;
      writeConfirmed();
      await handleLoadOutcomes(outcomeDecisionId);
    } catch (error) {
      reportWriteError(athleteId, error, 'Failed to evaluate decision outcome.');
    }
  }

  const actionableRecommendations = recommendations.filter((rec) => rec.status === 'provisional' || rec.status === 'accepted');

  return (
    <RoleStandaloneView
      roleLabel="Decision Loop Review"
      routeLabel="/coach/decision-loop"
      allowedRoles={['coach', 'admin']}
      showShellHeader={false}
      room="floor"
    >
      <div className="text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-6xl">
          <header className="space-y-[var(--s3)] border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
            <p className="t-eyebrow">Coach Workspace</p>
            <h1 className="t-command text-[length:var(--t-2xl)]">SHADOW Decision Loop</h1>
            <p className="t-body max-w-4xl text-[color:var(--bone-300)]">
              Review provisional recommendations, record human decisions, flag near-misses, and evaluate outcomes.
              Every recommendation starts provisional and stays that way until a human accepts or rejects it — silence
              never equals acceptance, and medical/sparring-clearance topics are gated by the athlete&apos;s current
              medical administrative status below.
            </p>
          </header>

          <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)]">
            <label className="field block">
              <span className="t-label">Athlete</span>
              <select
                value={athleteId}
                onChange={(event) => selectAthlete(event.target.value)}
                className="select max-w-md"
              >
                <option value="">Select an athlete…</option>
                {athletes.map((athlete) => (
                  <option key={athlete.athlete_id} value={athlete.athlete_id}>
                    {athlete.full_name || athlete.athlete_id}
                  </option>
                ))}
              </select>
            </label>
            <label className="field mt-[var(--s3)] block">
              <span className="t-label">Or enter an athlete ID directly</span>
              <input
                value={athleteId}
                onChange={(event) => selectAthlete(event.target.value)}
                placeholder="athlete-id"
                className="input max-w-md"
              />
            </label>
            {loading && <p className="t-muted mt-[var(--s3)]">Loading…</p>}
            {/* --restricted-ink, not --locked-ink. A roster that would not
                load is a network fact, not a medical one; sports-medicine
                already made this correction and states the reason -- red is
                left to mean a child is in danger. */}
            {errorMessage && <p className="mt-[var(--s3)] text-[length:var(--t-sm)] font-bold text-[var(--restricted-ink)]">{errorMessage}</p>}
            {previousAthleteNotice && <p className="mt-[var(--s3)] text-[length:var(--t-sm)] font-bold text-[var(--restricted-ink)]">{previousAthleteNotice}</p>}
          </section>

          {!athleteId ? (
            <p className="t-body mt-[var(--s5)] text-[color:var(--bone-300)]">Select or enter an athlete to review their decision loop.</p>
          ) : (
            <div className="mt-[var(--s5)] grid gap-[var(--s5)] xl:grid-cols-2">
              {/* Medical Administrative Status */}
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-command text-[length:var(--t-lg)]">Medical Administrative Status</h2>
                <p className="t-muted mt-[var(--s2)]">
                  Read-only gate for medically sensitive recommendations/decisions. Setting a new status never clears an
                  existing restriction automatically — each change is its own explicit, human-attributed record.
                </p>
                {medicalStatus && !statusUnread ? (
                  <div className="mt-[var(--s3)] space-y-[var(--s2)] text-[length:var(--t-sm)]">
                    <p className="flex flex-wrap items-center gap-[var(--s3)]">
                      Current status: <StatusBadge status={medicalStatus.effective_status} />
                    </p>
                    {medicalStatus.effective_status === 'cleared_expired' && (
                      <p className="t-body text-[color:var(--bone-300)]">
                        This clearance passed its end date, so it no longer counts. The medical gate blocks
                        recommendations until a new clearance is recorded.
                      </p>
                    )}
                    <p className="t-data text-[color:var(--bone-400)]">
                      Set by {medicalStatus.set_by_role} ({medicalStatus.set_by_account_id}) at {medicalStatus.effective_at}
                    </p>
                    {medicalStatus.source_reference && (
                      <p className="t-data text-[color:var(--bone-400)]">Reference: {medicalStatus.source_reference}</p>
                    )}
                  </div>
                ) : loadFailed || statusUnread ? (
                  <p className="t-body mt-[var(--s3)] text-[var(--restricted-ink)]">
                    This athlete&apos;s medical administrative status could not be read. UNKNOWN —
                    not &quot;no restriction on record&quot;.
                  </p>
                ) : loadState === 'loading' ? (
                  <p className="t-muted mt-[var(--s3)]">Reading medical administrative status…</p>
                ) : (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">No medical administrative status recorded yet.</p>
                )}

                <form onSubmit={handleSetMedicalStatus} className="mt-[var(--s4)] space-y-[var(--s3)] border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s3)]">
                  <label className="field block">
                    <span className="t-label">New status</span>
                    <select
                      value={medicalStatusDraft}
                      onChange={(event) => editDraft('medicalStatusDraft', event.target.value as MedicalStatusValue)}
                      className="select"
                    >
                      <option value="pending">Pending</option>
                      <option value="cleared">Cleared</option>
                      <option value="restricted">Restricted</option>
                      <option value="not_cleared">Not Cleared</option>
                    </select>
                  </label>
                  <label className="field block">
                    <span className="t-label">Source reference (optional)</span>
                    <input
                      value={medicalSourceRef}
                      onChange={(event) => editDraft('medicalSourceRef', event.target.value)}
                      placeholder="e.g. physician note, incident id"
                      className="input"
                    />
                  </label>
                  {/* The one danger-face control on this page: it operates the
                      medical gate itself. Red is not reserved
                      (OD-2026-09-29-001). */}
                  <button type="submit" className="btn btn--danger">
                    Set Status
                  </button>
                </form>
              </section>

              {/* Recommendations */}
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-command text-[length:var(--t-lg)]">Recommendations</h2>
                <p className="t-muted mt-[var(--s2)]">
                  Always created provisional. Only a human decision below can move one to accepted or rejected.
                </p>
                <div className="mt-[var(--s3)] max-h-[360px] space-y-[var(--s3)] overflow-y-auto">
                  {recommendations.length === 0 && loadState !== 'loading' && (loadFailed
                    ? <p className="t-body text-[var(--restricted-ink)]">Recommendations could not be read — not a statement that there are none.</p>
                    : <p className="t-body text-[color:var(--bone-300)]">No recommendations yet.</p>)}
                  {recommendations.map((rec) => (
                    <article key={rec.recommendation_id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s3)] text-[length:var(--t-sm)]">
                      <p className="font-semibold text-[color:var(--bone-100)]">{rec.recommendation_text}</p>
                      <p className="t-muted mt-[var(--s2)]">Expected: {rec.expected_outcome}</p>
                      <p className="mt-[var(--s2)] flex flex-wrap items-center gap-[var(--s3)]">
                        <StatusBadge status={rec.status} />
                        <span className="t-data text-[color:var(--bone-400)]">expires {rec.expires_at}</span>
                      </p>
                      {rec.status === 'provisional' && (
                        <div className="mt-[var(--s3)] flex gap-[var(--s3)]">
                          <button
                            type="button"
                            onClick={() => void handleDecideRecommendation(rec.recommendation_id, 'accepted')}
                            className="btn"
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDecideRecommendation(rec.recommendation_id, 'rejected')}
                            className="btn btn--ghost"
                          >
                            Reject
                          </button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </section>

              {/* Decisions */}
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-command text-[length:var(--t-lg)]">Decisions</h2>
                <p className="t-muted mt-[var(--s2)]">
                  A decision always requires a human. It may reference a still-live recommendation, or be logged directly.
                </p>
                <div className="mt-[var(--s3)] max-h-[280px] space-y-[var(--s3)] overflow-y-auto">
                  {decisions.length === 0 && loadState !== 'loading' && (loadFailed
                    ? <p className="t-body text-[var(--restricted-ink)]">Decisions could not be read — not a statement that none were recorded.</p>
                    : <p className="t-body text-[color:var(--bone-300)]">No decisions recorded yet.</p>)}
                  {decisions.map((decision) => (
                    <article key={decision.decision_id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s3)] text-[length:var(--t-sm)]">
                      <p className="font-semibold text-[color:var(--bone-100)]">{decision.decision_text}</p>
                      <p className="t-muted mt-[var(--s2)]">Expected: {decision.expected_outcome}</p>
                      <p className="t-data mt-[var(--s2)] text-[color:var(--bone-400)]">
                        By {decision.decided_by_role} at {decision.decided_at}
                      </p>
                      <button
                        type="button"
                        onClick={() => void handleLoadOutcomes(decision.decision_id)}
                        className="btn btn--ghost mt-[var(--s3)]"
                      >
                        Load Outcomes
                      </button>
                      {outcomesByDecision[decision.decision_id] && (
                        <div className="mt-[var(--s3)] space-y-[var(--s2)] border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s3)]">
                          {outcomesByDecision[decision.decision_id].length === 0 ? (
                            <p className="t-muted">No outcomes evaluated yet.</p>
                          ) : (
                            outcomesByDecision[decision.decision_id].map((outcome) => (
                              <p key={outcome.outcome_id} className="flex flex-wrap items-center gap-[var(--s3)] text-[length:var(--t-xs)]">
                                <StatusBadge status={outcome.match_state} />
                                {outcome.notes}
                              </p>
                            ))
                          )}
                        </div>
                      )}
                    </article>
                  ))}
                </div>

                <form onSubmit={handleRecordDecision} className="mt-[var(--s4)] space-y-[var(--s3)] border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s3)]">
                  <label className="field block">
                    <span className="t-label">Link to recommendation (optional)</span>
                    <select
                      value={decisionRecommendationId}
                      onChange={(event) => editDraft('decisionRecommendationId', event.target.value)}
                      className="select"
                    >
                      <option value="">None — log directly</option>
                      {actionableRecommendations.map((rec) => (
                        <option key={rec.recommendation_id} value={rec.recommendation_id}>
                          {rec.recommendation_text.slice(0, 60)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field block">
                    <span className="t-label">Decision text</span>
                    <textarea
                      value={decisionText}
                      onChange={(event) => editDraft('decisionText', event.target.value)}
                      className="textarea min-h-[72px]"
                    />
                  </label>
                  <label className="field block">
                    <span className="t-label">Expected outcome</span>
                    <textarea
                      value={decisionExpectedOutcome}
                      onChange={(event) => editDraft('decisionExpectedOutcome', event.target.value)}
                      className="textarea min-h-[56px]"
                    />
                  </label>
                  {/* This replaced a "Medically sensitive" checkbox. The box
                      claimed to switch the clearance check on, and nothing read
                      it: the server runs that check on every decision, whatever
                      the wording, and refuses the write when the athlete's
                      record does not allow one. Saying so is the honest version
                      of what the checkbox implied. */}
                  <p className="t-muted">
                    The athlete&apos;s medical status is checked on every decision recorded here.
                    There is nothing to switch on: if their record does not allow one, this refuses
                    and tells you why.
                  </p>
                  <button type="submit" className="btn">
                    Record Decision
                  </button>
                </form>
              </section>

              {/* Near-Misses */}
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-command text-[length:var(--t-lg)]">Near-Misses</h2>
                <p className="t-muted mt-[var(--s2)]">
                  Human-flagged only. Use this when something almost went wrong that a Decision didn&apos;t already cover.
                </p>
                <div className="mt-[var(--s3)] max-h-[220px] space-y-[var(--s3)] overflow-y-auto">
                  {nearMisses.length === 0 && loadState !== 'loading' && (loadFailed
                    ? <p className="t-body text-[var(--restricted-ink)]">Near-misses could not be read — not a statement that none were flagged.</p>
                    : <p className="t-body text-[color:var(--bone-300)]">No near-misses flagged yet.</p>)}
                  {nearMisses.map((nearMiss) => (
                    <article key={nearMiss.near_miss_id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s3)] text-[length:var(--t-sm)]">
                      <p className="text-[color:var(--bone-100)]">{nearMiss.description}</p>
                      <p className="t-data mt-[var(--s2)] text-[color:var(--bone-400)]">
                        Severity: {nearMiss.severity} · {nearMiss.created_at}
                      </p>
                    </article>
                  ))}
                </div>

                <form onSubmit={handleFlagNearMiss} className="mt-[var(--s4)] space-y-[var(--s3)] border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s3)]">
                  <label className="field block">
                    <span className="t-label">Description</span>
                    <textarea
                      value={nearMissDescription}
                      onChange={(event) => editDraft('nearMissDescription', event.target.value)}
                      className="textarea min-h-[56px]"
                    />
                  </label>
                  <label className="field block">
                    <span className="t-label">Severity</span>
                    <select
                      value={nearMissSeverity}
                      onChange={(event) => editDraft('nearMissSeverity', event.target.value as NearMissSeverity)}
                      className="select"
                    >
                      <option value="low">Low</option>
                      <option value="moderate">Moderate</option>
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </select>
                  </label>
                  <label className="field block">
                    <span className="t-label">Related decision (optional)</span>
                    <select
                      value={nearMissDecisionId}
                      onChange={(event) => editDraft('nearMissDecisionId', event.target.value)}
                      className="select"
                    >
                      <option value="">None</option>
                      {decisions.map((decision) => (
                        <option key={decision.decision_id} value={decision.decision_id}>
                          {decision.decision_text.slice(0, 60)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" className="btn btn--ghost">
                    Flag Near-Miss
                  </button>
                </form>
              </section>

              {/* Report Incident */}
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-command text-[length:var(--t-lg)]">Report Incident</h2>
                <p className="t-muted mt-[var(--s2)]">
                  Use this when something actually happened -- an injury, a broken rule with a real
                  consequence -- not a close call. This files directly into the safety escalation queue.
                </p>

                {incidentFiledMessage && (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--brass-300)]">{incidentFiledMessage}</p>
                )}

                <form onSubmit={handleReportIncident} className="mt-[var(--s4)] space-y-[var(--s3)]">
                  <label className="field block">
                    <span className="t-label">What happened</span>
                    <textarea
                      value={incidentDescription}
                      onChange={(event) => editDraft('incidentDescription', event.target.value)}
                      className="textarea min-h-[56px]"
                    />
                  </label>
                  <label className="field block">
                    <span className="t-label">Severity</span>
                    <select
                      value={incidentSeverity}
                      onChange={(event) => editDraft('incidentSeverity', event.target.value as IncidentSeverity)}
                      className="select"
                    >
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </select>
                  </label>
                  <label className="field block">
                    <span className="t-label">When it happened (optional, if not today)</span>
                    <input
                      type="text"
                      value={incidentOccurredAt}
                      onChange={(event) => editDraft('incidentOccurredAt', event.target.value)}
                      placeholder="e.g. 2026-08-05"
                      className="input"
                    />
                  </label>
                  <button type="submit" className="btn btn--ghost" disabled={incidentSubmitting}>
                    {incidentSubmitting ? 'Filing…' : 'File Incident Report'}
                  </button>
                </form>
              </section>

              {/* Behavior & Habit Note */}
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-command text-[length:var(--t-lg)]">Behavior &amp; Habit Note</h2>
                <p className="t-muted mt-[var(--s2)]">
                  A quick note on behavior, discipline, or a habit you noticed -- not a safety concern (use
                  Near-Misses or Report Incident for those). This just records it; nothing acts on it yet.
                </p>

                {behaviorNoteMessage && (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--brass-300)]">{behaviorNoteMessage}</p>
                )}

                <form onSubmit={handleLogBehaviorNote} className="mt-[var(--s4)] space-y-[var(--s3)]">
                  <label className="field block">
                    <span className="t-label">Note</span>
                    <textarea
                      value={behaviorNoteText}
                      onChange={(event) => editDraft('behaviorNoteText', event.target.value)}
                      className="textarea min-h-[56px]"
                    />
                  </label>
                  <button type="submit" className="btn btn--ghost" disabled={behaviorNoteSubmitting}>
                    {behaviorNoteSubmitting ? 'Logging…' : 'Log Note'}
                  </button>
                </form>
              </section>

              {/* Post to the family's page (was "Message Home"; reworded under A-Q17) */}
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-command text-[length:var(--t-lg)]">Post to the Family&apos;s Page</h2>
                <p className="t-muted mt-[var(--s2)]">
                  A one-way note to the athlete&apos;s family -- they&apos;ll see it on their Messages tab.
                  Give it a due date and it also shows as something to do, with a box the family ticks when it is done.
                  There&apos;s no reply yet; call the family directly for anything that needs a conversation.
                </p>

                {messageHomeMessage && (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--brass-300)]">{messageHomeMessage}</p>
                )}

                <form onSubmit={handleMessageHome} className="mt-[var(--s4)] space-y-[var(--s3)]">
                  <label className="field block">
                    <span className="t-label">Message</span>
                    <textarea
                      value={messageHomeText}
                      onChange={(event) => editDraft('messageHomeText', event.target.value)}
                      className="textarea min-h-[56px]"
                    />
                  </label>
                  <label className="field block">
                    <span className="t-label">Due by (optional)</span>
                    <input
                      type="date"
                      value={messageHomeDueDate}
                      onChange={(event) => editDraft('messageHomeDueDate', event.target.value)}
                      className="input"
                    />
                  </label>
                  <button type="submit" className="btn btn--ghost" disabled={messageHomeSubmitting}>
                    {messageHomeSubmitting ? 'Posting…' : 'Post to Family'}
                  </button>
                </form>
              </section>

              {/* Decision Outcomes */}
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)] xl:col-span-2">
                <h2 className="t-command text-[length:var(--t-lg)]">Evaluate a Decision Outcome</h2>
                <p className="t-muted mt-[var(--s2)]">
                  Always a human judgment: compare the decision&apos;s expected outcome against what actually happened.
                </p>
                <form onSubmit={handleEvaluateOutcome} className="mt-[var(--s3)] grid gap-[var(--s3)] md:grid-cols-2">
                  <label className="field block">
                    <span className="t-label">Decision</span>
                    <select
                      value={outcomeDecisionId}
                      onChange={(event) => editDraft('outcomeDecisionId', event.target.value)}
                      className="select"
                    >
                      <option value="">Select a decision…</option>
                      {decisions.map((decision) => (
                        <option key={decision.decision_id} value={decision.decision_id}>
                          {decision.decision_text.slice(0, 60)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field block">
                    <span className="t-label">Match state</span>
                    <select
                      value={outcomeMatchState}
                      onChange={(event) => editDraft('outcomeMatchState', event.target.value as MatchState)}
                      className="select"
                    >
                      <option value="match">Match</option>
                      <option value="partial">Partial</option>
                      <option value="miss">Miss</option>
                      <option value="confounded">Confounded</option>
                    </select>
                  </label>
                  <label className="field block md:col-span-2">
                    <span className="t-label">Observation IDs (comma-separated)</span>
                    <input
                      value={outcomeObservationIds}
                      onChange={(event) => editDraft('outcomeObservationIds', event.target.value)}
                      placeholder="obs-1, obs-2"
                      className="input"
                    />
                  </label>
                  <label className="field block md:col-span-2">
                    <span className="t-label">Notes</span>
                    <textarea
                      value={outcomeNotes}
                      onChange={(event) => editDraft('outcomeNotes', event.target.value)}
                      className="textarea min-h-[56px]"
                    />
                  </label>
                  <button type="submit" className="btn w-fit md:col-span-2">
                    Evaluate Outcome
                  </button>
                </form>
              </section>
            </div>
          )}

          <div className="mt-[var(--s6)]">
            <Link href="/coach/environment/intake-router" className="btn btn--ghost">
              Back to Coach Workspace
            </Link>
          </div>

        {/* The four words, at the foot of the page — the same foot the
            approved boards put under every full screen. See WorkAxis. */}
        <WorkAxis />
        </div>
      </div>
    </RoleStandaloneView>
  );
}
