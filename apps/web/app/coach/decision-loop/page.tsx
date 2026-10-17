'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import WorkAxis from '@/components/WorkAxis';
import FamilyNotesPosted from '@/components/FamilyNotesPosted';
import FamilyObservations from '@/components/FamilyObservations';
import MessageAthlete from '@/components/MessageAthlete';
import ArmedButton from '@/components/ArmedButton';
import { takeArrivalAthlete } from '@/components/decisionLoopArrival';
import { formatGymDate, formatGymDateTimeShort, formatGymDay } from '@/src/lib/gymTime';
import { isPainReportNearMiss, painReportLabel, painScoreFromMetadata } from '@/src/shared/painScoreLabel';

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
  /* The medical status on file when it was recorded (issue #1474), in the
     route's words ('no_record' for none), and that status's end date. */
  medical_status_on_file?: string;
  medical_status_expires_at?: string | null;
}

interface NearMissRow {
  near_miss_id: string;
  athlete_id: string;
  decision_id: string | null;
  description: string;
  severity: NearMissSeverity;
  detected_by: 'system' | 'human';
  created_at: string;
  // Read only to tell a pain report and its score (#1528).
  metadata?: Record<string, unknown> | null;
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

/* A stored instant as the gym reads it: "Oct 11, 2026, 7:45 PM". The routes
   send ISO or Postgres text; either way a coach never reads the raw form or
   the UTC day (F-072). Anything unreadable is shown as sent. */
function gymStamp(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') return '';
  return formatGymDateTimeShort(isoInstant(value)) ?? value;
}

/* The medical status on file, stated as a fact (issue #1474): the words after
   "Medical status on file:". Never a warning and never a reason to refuse;
   the coach makes the assessment (OD-2026-10-10-004 to -007). Wording
   PROPOSED for Jason's look. */
function medicalStatusOnFileWords(status: string | null | undefined, expiresAt: string | null | undefined): string {
  const date = typeof expiresAt === 'string' && expiresAt.trim() !== ''
    ? formatGymDate(isoInstant(expiresAt)) ?? expiresAt
    : null;
  switch (status) {
    case 'pending':
      return 'pending';
    case 'restricted':
      return 'restricted';
    case 'not_cleared':
      return 'not cleared';
    case 'cleared':
      return date ? `cleared, expires ${date}` : 'cleared';
    case 'cleared_expired':
      return date ? `cleared, expired ${date}` : 'cleared, expired';
    default:
      return 'none';
  }
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

/* The six writes below the first three lock while in flight and say when they
   landed (UXB-02): a double tap used to write two records to a child's file. */
type DoneKind = 'medicalStatus' | 'recommendation' | 'decision' | 'nearMiss' | 'outcome';
type SubmitKind = 'incident' | 'behaviorNote' | 'messageHome' | DoneKind;

const MEDICAL_STATUS_WORDS: Record<MedicalStatusValue, string> = {
  pending: 'Pending',
  cleared: 'Cleared',
  restricted: 'Restricted',
  not_cleared: 'Not Cleared',
};

/** A roster read that has not answered by then is treated as failed, so the
    coach is offered Check again rather than a picker that never fills. */
const ROSTER_TIMEOUT_MS = 15_000;

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
  /* ONE ERROR LINE PER FORM, UNDER THAT FORM (UXB-15). Every error used to
     print in one line in the picker header, several panels above the form
     that failed, so a coach scrolled down to Report Incident could not see
     that it had not gone in -- and the next thing to happen anywhere on the
     page replaced it. Keyed by the form (a SubmitKind), 'records' for the
     athlete's read, or `outcomes:<decision id>` for one decision's outcomes.
     Each is set and cleared only by its own form or read. */
  const [errorLines, setErrorLines] = useState<Readonly<Record<string, string>>>({});
  function setErrorAt(at: string, text: string) {
    setErrorLines((shown) => ({ ...shown, [at]: text }));
  }
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
  /* A confirmed write clears its own form's line: an old refusal left under
     "Incident filed" would make one of the two false. A not-confirmed line
     goes only if this write was started after it appeared. */
  function beginWrite(at: SubmitKind): () => void {
    const startedAt = unconfirmedSeqRef.current;
    return () => {
      setErrorLines((shown) =>
        !shown[at] || (shown[at] === WRITE_NOT_CONFIRMED && startedAt !== unconfirmedSeqRef.current)
          ? shown
          : { ...shown, [at]: '' },
      );
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
  // Bumped after a post lands, so the list under the form re-reads (#1542).
  const [familyNotesRefresh, setFamilyNotesRefresh] = useState(0);

  /* In flight, per athlete. One flag for the page left athlete B's button
     reading "Filing…" and locked while a report for A was still out. */
  const [submitting, setSubmitting] = useState<ReadonlySet<string>>(new Set());
  // The same set, readable by a second press that arrives before the render
  // that disables the button.
  const inFlightRef = useRef<Set<string>>(new Set());
  function markSubmitting(kind: SubmitKind, forAthleteId: string, on: boolean) {
    if (on) inFlightRef.current.add(`${kind}:${forAthleteId}`);
    else inFlightRef.current.delete(`${kind}:${forAthleteId}`);
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
  // "Status set." and the like, under the form that was sent. Emptied with the
  // other confirmation lines on every read and every switch.
  const [doneLines, setDoneLines] = useState<Partial<Record<DoneKind, string>>>({});
  // The decisions whose outcomes are being read: "Load Outcomes" says so (UXB-38).
  const [outcomesReading, setOutcomesReading] = useState<ReadonlySet<string>>(new Set());
  /** The error line, under the form or read it belongs to; nothing anywhere else. */
  const errorUnder = (at: string) => (errorLines[at] ? (
    <p role="alert" className="text-[length:var(--t-sm)] font-bold text-[var(--restricted-ink)]">{errorLines[at]}</p>
  ) : null);
  const isSubmitting = (kind: DoneKind) => submitting.has(`${kind}:${athleteId}`);
  /** Starts a write of `kind` for `forAthleteId`, or says one is already out. */
  function startWrite(kind: DoneKind, forAthleteId: string): boolean {
    if (inFlightRef.current.has(`${kind}:${forAthleteId}`)) return false;
    markSubmitting(kind, forAthleteId, true);
    setDoneLines((shown) => ({ ...shown, [kind]: '' }));
    return true;
  }
  const athleteName = athletes.find((athlete) => athlete.athlete_id === athleteId)?.full_name?.trim() || 'this athlete';

  /* ARRIVING FROM "Record what you did" (#1474 item 5): the athlete the coach
     came for, handed over in page memory (decisionLoopArrival.ts). Taken once,
     on the first effect; undefined means not yet taken. */
  const arrivalAthleteRef = useRef<string | null | undefined>(undefined);
  /* The picker is the only way to choose an athlete, so it is never an empty
     picker that reads as "no athletes": while the roster is read it says so,
     and a roster that would not load -- or has not answered within
     ROSTER_TIMEOUT_MS -- says that and offers another try. */
  const [rosterState, setRosterState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const loadRoster = useCallback(async () => {
    let roster: AthleteListItem[] | null = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ROSTER_TIMEOUT_MS);
    // Settles the read as failed on the timeout even if the request ignores the abort.
    const timedOut = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Roster read timed out')));
    });
    try {
      const response = await Promise.race([
        fetch(`${apiBase()}/api/pilot/athletes/list`, { credentials: 'include', signal: controller.signal }),
        timedOut,
      ]);
      if (response.ok) {
        const payload = (await Promise.race([response.json(), timedOut])) as { items?: unknown };
        // A 200 without the list is not an empty roster (UXB-38): it fails, and Check again is offered.
        if (Array.isArray(payload.items)) {
          roster = payload.items as AthleteListItem[];
          setAthletes(roster);
        }
      }
    } catch {
      // Said on the page below the picker.
    } finally {
      clearTimeout(timer);
    }
    setRosterState(roster ? 'loaded' : 'failed');
    /* The arriving athlete is selected only if the roster lists them: the
       roster is the server's answer to whom this coach may reach. Not listed,
       and the page opens as it always has, with nobody chosen. With no roster
       yet, the arrival waits for a "Check again" that loads one. */
    if (!roster) return;
    const arriving = arrivalAthleteRef.current;
    arrivalAthleteRef.current = null;
    if (arriving && roster.some((athlete) => athlete.athlete_id === arriving)) {
      selectAthlete(arriving);
    }
    // selectAthlete moves refs and state setters only.
  }, []);
  useEffect(() => {
    if (arrivalAthleteRef.current === undefined) arrivalAthleteRef.current = takeArrivalAthlete();
    // The roster's answer sets state when it arrives, never in this effect's body.
    void Promise.resolve().then(loadRoster);
  }, [loadRoster]);

  const refreshAll = useCallback(async (targetAthleteId: string) => {
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
    setDoneLines({});
    if (!targetAthleteId) {
      return;
    }
    setLoading(true);
    setErrorLines((shown) => ({ ...shown, records: '' }));
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
      // Its own line: a not-confirmed line under a form ("check before
      // sending it again") stays where it is beside this one.
      const readFailure = error instanceof Error ? error.message : 'Failed to load decision loop data.';
      setErrorLines((shown) => ({ ...shown, records: readFailure }));
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
     past the end date while the contact gate counts it as lapsed. So the medical status of the
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
    setDoneLines({});
    setLoading(false);
    setErrorLines({});
    setPreviousAthleteNotice('');
  }


  /* EVERY HANDLER BELOW answers for the athlete it was submitted under --
     the `athleteId` its closure captured. A write for athlete A that lands
     after the switch to B used to print its result under B: a refusal that
     quotes A's medical status ("this athlete's medical administrative status
     is 'restricted'"), or "Incident filed" / "Posted to the family's page"
     for a child nobody is looking at.

     On a late SUCCESS the submitted draft is still cleared, in the draft of
     the athlete it was sent for (it was sent; left in their box it reads as
     unsent and one click sends it again), and the confirmation and the
     re-read are dropped. On a late FAILURE the
     server's text is withheld -- it describes A -- but the coach is still
     told that something they did has not gone through: an incident report
     that silently failed is worse than a vague line. */
  function reportWriteError(forAthleteId: string, error: unknown, fallback: string, at: SubmitKind) {
    if (forAthleteId !== selectedAthleteRef.current) {
      setPreviousAthleteNotice(PREVIOUS_ATHLETE_WRITE_FAILED);
      return;
    }
    const message = error instanceof Error ? error.message : fallback;
    setErrorAt(at, message);
    // "Check before sending it again" has to be checkable. A write that was
    // not confirmed may have landed: read the athlete again, keeping this
    // line up, so the status, decisions and near-misses on screen are what
    // the server holds now.
    if (message === WRITE_NOT_CONFIRMED) {
      unconfirmedSeqRef.current += 1;
      void refreshAll(forAthleteId);
    }
  }

  // Run by the armed Set Status button only (UXB-03); Enter in the form does not send it.
  async function handleSetMedicalStatus() {
    if (!athleteId || !startWrite('medicalStatus', athleteId)) return;
    const writeConfirmed = beginWrite('medicalStatus');
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
      if (athleteId === selectedAthleteRef.current) setDoneLines((shown) => ({ ...shown, medicalStatus: 'Status set.' }));
    } catch (error) {
      reportWriteError(athleteId, error, 'Failed to set medical status.', 'medicalStatus');
    } finally {
      markSubmitting('medicalStatus', athleteId, false);
    }
  }

  async function handleDecideRecommendation(recommendationId: string, decision: 'accepted' | 'rejected') {
    if (!athleteId || !startWrite('recommendation', athleteId)) return;
    const writeConfirmed = beginWrite('recommendation');
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
      if (athleteId === selectedAthleteRef.current) {
        setDoneLines((shown) => ({
          ...shown,
          recommendation: decision === 'accepted' ? 'Recommendation accepted.' : 'Recommendation rejected.',
        }));
      }
    } catch (error) {
      reportWriteError(athleteId, error, 'Failed to record decision on recommendation.', 'recommendation');
    } finally {
      markSubmitting('recommendation', athleteId, false);
    }
  }

  async function handleRecordDecision(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!athleteId || !decisionText.trim() || !decisionExpectedOutcome.trim()) return;
    if (!startWrite('decision', athleteId)) return;
    const writeConfirmed = beginWrite('decision');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/decisions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // Exactly the four fields /api/pilot/shadow/decisions declares it
        // reads. This body used to carry a fifth, isMedicallySensitive, off a
        // checkbox the coach could tick; the route never mentioned it, so the
        // control moved nothing in either direction while its label said it
        // gated a clearance check. No such check refuses a decision now (issue
        // #1474), and a request must not carry a field that claims one.
        // decisionRequestContract.test.ts holds this shut.
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
      if (athleteId === selectedAthleteRef.current) setDoneLines((shown) => ({ ...shown, decision: 'Decision recorded.' }));
    } catch (error) {
      reportWriteError(athleteId, error, 'Failed to record decision.', 'decision');
    } finally {
      markSubmitting('decision', athleteId, false);
    }
  }

  async function handleFlagNearMiss(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!athleteId || !nearMissDescription.trim()) return;
    if (!startWrite('nearMiss', athleteId)) return;
    const writeConfirmed = beginWrite('nearMiss');
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
      if (athleteId === selectedAthleteRef.current) setDoneLines((shown) => ({ ...shown, nearMiss: 'Near-miss flagged.' }));
    } catch (error) {
      reportWriteError(athleteId, error, 'Failed to flag near-miss.', 'nearMiss');
    } finally {
      markSubmitting('nearMiss', athleteId, false);
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
    const writeConfirmed = beginWrite('incident');
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
      reportWriteError(athleteId, error, 'Failed to file incident report.', 'incident');
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
    const writeConfirmed = beginWrite('behaviorNote');
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
      reportWriteError(athleteId, error, 'Failed to log the note.', 'behaviorNote');
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
    const writeConfirmed = beginWrite('messageHome');
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
      // The due date is attached BEFORE the athlete guard: it is bound to the
      // acknowledged note and to the athlete this handler captured, so a
      // switch cannot send it anywhere else, and skipping it would drop a
      // date the coach set with nothing said.
      const due = messageHomeDueDate ? await attachDueDate(noteId, athleteId, messageHomeDueDate) : null;
      if (athleteId !== selectedAthleteRef.current) {
        if (due && due.outcome !== 'saved') setPreviousAthleteNotice(PREVIOUS_ATHLETE_WRITE_FAILED);
        return;
      }
      writeConfirmed();
      setMessageHomeMessage(due ? due.text : "Posted to the family's page.");
      setFamilyNotesRefresh((n) => n + 1);
    } catch (error) {
      reportWriteError(athleteId, error, 'Failed to post the message.', 'messageHome');
    } finally {
      markSubmitting('messageHome', athleteId, false);
    }
  }

  /* THE DUE DATE IS A SECOND WRITE, and it is reported as one. The message is
     a coach_note the family's page already reads; the deadline lives in
     pilot.parent_task_state and is set through /api/pilot/parent-tasks after
     the note exists. Whatever happens to that second write the note has
     landed and the family will read it, so this never throws: a refusal and
     a not-confirmed answer are each told as what they are (the page's rule
     at confirmWriteOrThrow: not confirmed is not failed, the date may well
     have saved), and neither is reported as a failed post, which would
     invite the coach to post it twice. Nothing on this page can re-attach a
     date to a posted message; a coach who needs the deadline posts a short
     follow-up with the date set.

     The date is a bare calendar day (YYYY-MM-DD). It is printed through
     formatGymDay, which keeps a bare day on the day it names ("October 20,
     2026"); the instant formatters would read it as UTC midnight and show
     the day before. */
  async function attachDueDate(
    noteId: string,
    forAthleteId: string,
    dueDate: string,
  ): Promise<{ outcome: 'saved' | 'refused' | 'unconfirmed'; text: string }> {
    // A refusal is an answer the server gave; a dropped connection or an
    // unreadable 200 is not, and the date may have saved.
    let answered = false;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/parent-tasks`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note_id: noteId, athlete_id: forAthleteId, due_date: dueDate }),
      });
      answered = true;
      await confirmWriteOrThrow(response, 'the due date was refused.', (envelope) => {
        const task = returnedRow(envelope, 'task');
        return task !== null && task.due_date === dueDate;
      });
      return { outcome: 'saved', text: `Posted to the family's page, due ${formatGymDay(dueDate) ?? dueDate}.` };
    } catch (error) {
      if (answered && error instanceof Error && error.message !== WRITE_NOT_CONFIRMED) {
        return {
          outcome: 'refused',
          text: `Posted to the family's page, but without the due date -- ${error.message}`,
        };
      }
      return {
        outcome: 'unconfirmed',
        text: "Posted to the family's page, but the due date was not confirmed -- it may or may not have saved.",
      };
    }
  }

  async function handleLoadOutcomes(decisionId: string) {
    setOutcomesReading((current) => new Set(current).add(decisionId));
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
      setErrorAt(`outcomes:${decisionId}`, '');
    } catch (error) {
      if (athleteId !== selectedAthleteRef.current) return;
      setErrorAt(`outcomes:${decisionId}`, error instanceof Error ? error.message : 'Failed to load decision outcomes.');
    } finally {
      setOutcomesReading((current) => {
        const next = new Set(current);
        next.delete(decisionId);
        return next;
      });
    }
  }

  async function handleEvaluateOutcome(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!outcomeDecisionId || !startWrite('outcome', athleteId)) return;
    const writeConfirmed = beginWrite('outcome');
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
      setDoneLines((shown) => ({ ...shown, outcome: 'Outcome recorded.' }));
      await handleLoadOutcomes(outcomeDecisionId);
    } catch (error) {
      reportWriteError(athleteId, error, 'Failed to evaluate decision outcome.', 'outcome');
    } finally {
      markSubmitting('outcome', athleteId, false);
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
              never equals acceptance.
            </p>
          </header>

          <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)]">
            <label className="field block">
              <span className="t-label">Athlete</span>
              <select
                value={athleteId}
                onChange={(event) => selectAthlete(event.target.value)}
                disabled={rosterState === 'loading'}
                className="select max-w-md"
              >
                <option value="">Select an athlete…</option>
                {athletes.map((athlete) => (
                  <option key={athlete.athlete_id} value={athlete.athlete_id}>
                    {/* Never the raw id: an athlete with no name on file is named as such. */}
                    {athlete.full_name?.trim() || 'Unnamed athlete'}
                  </option>
                ))}
              </select>
            </label>
            {rosterState === 'loading' && <p className="t-muted mt-[var(--s3)]">Loading your athletes…</p>}
            {rosterState === 'failed' && (
              <div className="mt-[var(--s3)] flex flex-wrap items-center gap-[var(--s3)]">
                <p className="t-body">Couldn&apos;t load your athletes.</p>
                <button
                  type="button"
                  onClick={() => {
                    setRosterState('loading');
                    void loadRoster();
                  }}
                  className="btn btn--ghost"
                >
                  Check again
                </button>
              </div>
            )}
            {rosterState === 'loaded' && athletes.length === 0 && (
              <p className="t-body mt-[var(--s3)]">No athletes on your roster.</p>
            )}
            {loading && <p className="t-muted mt-[var(--s3)]">Loading…</p>}
            {/* --restricted-ink, not --locked-ink. A roster that would not
                load is a network fact, not a medical one; sports-medicine
                already made this correction and states the reason -- red is
                left to mean a child is in danger. */}
            {errorLines.records && (
              <p className="mt-[var(--s3)] text-[length:var(--t-sm)] font-bold text-[var(--restricted-ink)]">{errorLines.records}</p>
            )}
            {/* The athlete's records would not read: the same read again, with
                every draft on the page kept (UXB-13). */}
            {athleteId && (loadFailed || statusUnread) && (
              <button
                type="button"
                onClick={() => void refreshAll(athleteId)}
                disabled={loading}
                className="btn btn--ghost mt-[var(--s3)]"
              >
                {loading ? 'Checking…' : 'Check again'}
              </button>
            )}
            {previousAthleteNotice && <p className="mt-[var(--s3)] text-[length:var(--t-sm)] font-bold text-[var(--restricted-ink)]">{previousAthleteNotice}</p>}
          </section>

          {!athleteId ? (
            <p className="t-body mt-[var(--s5)] text-[color:var(--bone-300)]">Select an athlete to review their decision loop.</p>
          ) : (
            <div className="mt-[var(--s5)] grid gap-[var(--s5)] xl:grid-cols-2">
              {/* Medical Administrative Status */}
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-command text-[length:var(--t-lg)]">Medical Administrative Status</h2>
                <p className="t-muted mt-[var(--s2)]">
                  Setting a new status never clears an existing restriction automatically — each change is its own
                  explicit, human-attributed record.
                </p>
                {medicalStatus && !statusUnread ? (
                  <div className="mt-[var(--s3)] space-y-[var(--s2)] text-[length:var(--t-sm)]">
                    <p className="flex flex-wrap items-center gap-[var(--s3)]">
                      Current status: <StatusBadge status={medicalStatus.effective_status} />
                    </p>
                    {medicalStatus.effective_status === 'cleared_expired' && (
                      <p className="t-body text-[color:var(--bone-300)]">
                        This clearance passed its end date.
                      </p>
                    )}
                    <p className="t-data text-[color:var(--bone-400)]">
                      Set by {medicalStatus.set_by_role.replaceAll('_', ' ')}, {gymStamp(medicalStatus.effective_at)}
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

                <form onSubmit={(event) => event.preventDefault()} className="mt-[var(--s4)] space-y-[var(--s3)] border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s3)]">
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
                  <ArmedButton
                    className="btn btn--danger"
                    armKey={`${athleteId}:${medicalStatusDraft}`}
                    busy={isSubmitting('medicalStatus')}
                    busyLabel="Setting…"
                    armedLabel={`Press again: set ${athleteName} to ${MEDICAL_STATUS_WORDS[medicalStatusDraft]}`}
                    onConfirm={() => void handleSetMedicalStatus()}
                  >
                    Set Status
                  </ArmedButton>
                  {doneLines.medicalStatus && <p role="status" className="t-body text-[color:var(--brass-300)]">{doneLines.medicalStatus}</p>}
                  {errorUnder('medicalStatus')}
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
                        <span className="t-data text-[color:var(--bone-400)]">expires {gymStamp(rec.expires_at)}</span>
                      </p>
                      {rec.status === 'provisional' && (
                        <div className="mt-[var(--s3)] flex gap-[var(--s3)]">
                          <button
                            type="button"
                            onClick={() => void handleDecideRecommendation(rec.recommendation_id, 'accepted')}
                            disabled={isSubmitting('recommendation')}
                            className="btn"
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDecideRecommendation(rec.recommendation_id, 'rejected')}
                            disabled={isSubmitting('recommendation')}
                            className="btn btn--ghost"
                          >
                            Reject
                          </button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
                {doneLines.recommendation && <p role="status" className="t-body text-[color:var(--brass-300)]">{doneLines.recommendation}</p>}
                {errorUnder('recommendation')}
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
                        By {decision.decided_by_role.replaceAll('_', ' ')} at {formatGymDateTimeShort(decision.decided_at) ?? decision.decided_at}
                      </p>
                      {typeof decision.medical_status_on_file === 'string' && (
                        <p className="t-data mt-[var(--s2)] text-[color:var(--bone-400)]">
                          Medical status on file then:{' '}
                          {medicalStatusOnFileWords(decision.medical_status_on_file, decision.medical_status_expires_at)}
                        </p>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleLoadOutcomes(decision.decision_id)}
                        disabled={outcomesReading.has(decision.decision_id)}
                        className="btn btn--ghost mt-[var(--s3)]"
                      >
                        {outcomesReading.has(decision.decision_id) ? 'Loading outcomes…' : 'Load Outcomes'}
                      </button>
                      {errorUnder(`outcomes:${decision.decision_id}`)}
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
                  {/* The status on file, as a fact beside the form (issue #1474).
                      It is recorded with the decision and never refuses it. */}
                  <p className="t-muted">
                    Medical status on file:{' '}
                    {loadFailed || statusUnread
                      ? 'could not be read'
                      : loadState === 'loading'
                        ? 'reading…'
                        : medicalStatus
                          ? medicalStatusOnFileWords(medicalStatus.effective_status, medicalStatus.expires_at)
                          : 'none'}
                  </p>
                  <button type="submit" className="btn" disabled={isSubmitting('decision')}>
                    {isSubmitting('decision') ? 'Recording…' : 'Record Decision'}
                  </button>
                  {doneLines.decision && <p role="status" className="t-body text-[color:var(--brass-300)]">{doneLines.decision}</p>}
                  {errorUnder('decision')}
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
                        {/* A pain report reads as its number only (#1528). */}
                        {isPainReportNearMiss(nearMiss.metadata)
                          ? painReportLabel(painScoreFromMetadata(nearMiss.metadata))
                          : `Severity: ${nearMiss.severity}`} · {gymStamp(nearMiss.created_at)}
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
                  <button type="submit" className="btn btn--ghost" disabled={isSubmitting('nearMiss')}>
                    {isSubmitting('nearMiss') ? 'Flagging…' : 'Flag Near-Miss'}
                  </button>
                  {doneLines.nearMiss && <p role="status" className="t-body text-[color:var(--brass-300)]">{doneLines.nearMiss}</p>}
                  {errorUnder('nearMiss')}
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
                  {errorUnder('incident')}
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
                  {errorUnder('behaviorNote')}
                </form>
              </section>

              {/* Post to the family's page */}
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-command text-[length:var(--t-lg)]">Post to the Family&apos;s Page</h2>
                <p className="t-muted mt-[var(--s2)]">
                  A note to the athlete&apos;s family -- they&apos;ll see it on their Messages tab.
                  Give it a due date to mark it as something the family needs to do by then.
                  The family can reply under each message, and their replies show below it.
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
                      disabled={messageHomeSubmitting}
                      className="input"
                    />
                  </label>
                  <button type="submit" className="btn btn--ghost" disabled={messageHomeSubmitting}>
                    {messageHomeSubmitting ? 'Posting…' : 'Post to Family'}
                  </button>
                  {errorUnder('messageHome')}
                </form>

                <FamilyNotesPosted athleteId={athleteId} refreshKey={familyNotesRefresh} />
                <FamilyObservations athleteId={athleteId} />
              </section>

              {/* Message the athlete (#1542, FC-06): read on their Dashboard. */}
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <MessageAthlete key={athleteId} athleteId={athleteId} />
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
                  <button type="submit" className="btn w-fit md:col-span-2" disabled={isSubmitting('outcome')}>
                    {isSubmitting('outcome') ? 'Recording…' : 'Evaluate Outcome'}
                  </button>
                  {doneLines.outcome && <p role="status" className="t-body text-[color:var(--brass-300)] md:col-span-2">{doneLines.outcome}</p>}
                  {errorLines.outcome && <div className="md:col-span-2">{errorUnder('outcome')}</div>}
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
