'use client';

import Link from 'next/link';
import React, { type FormEvent, useCallback, useEffect, useState } from 'react';
import AnnouncementBanner from './AnnouncementBanner';
import AthleteAchievements from './AthleteAchievements';
import AthleteAttemptLog from './AthleteAttemptLog';
import AthleteCheckInPanel, { type AthleteCheckInRecord } from './AthleteCheckInPanel';
import Chalkboard from './Chalkboard';
import GymWallModule from './GymWallModule';
import WorkAxis from './WorkAxis';
import PersonalGoalBoard from './PersonalGoalBoard';
import type { RabbitHoleLessonItem } from './RabbitHole';
import { ANCHOR_KEY_OPTIONS, anchorLabel } from './rabbitHoleAnchorLabels';
import ProfileHeader from './ProfileHeader';
import TrainingHoldBanner from './TrainingHoldBanner';
import { AthleteSummaryPanel, HelpPanel, RoleSpecificShadow, type AthleteCountRead } from './RoleSummaryPanels';
import ShadowChatButton from './ShadowChatButton';
import ThenAndNow from './ThenAndNow';
import TrainingCard, { type TrainingSession } from './TrainingCard';
import { cx } from './uiStyles';
import useGymSound from './useGymSound';
import DrillDetail from './drills/DrillDetail';
import { fromAthleteDrillDetail, type DrillDetailView } from './drills/drillDetailView';
import { apiBase } from '@/lib/apiBase';
import { formatCalendarDay } from '@/lib/calendarDay';
import { humanizeContactLevel } from '@/src/lib/drillPresentation';
import { formatGymStamp } from '@/src/lib/gymTime';
import type { SessionRpeMethod } from '@/src/server/pilot/contracts';
import type { AthleteDrillDetail } from '@/src/server/pilot/drillLibraryV3';

type TabID = 'my-dashboard' | 'athlete-floor' | 'smart-goals' | 'attempt-log' | 'tracks' | 'assessments' | 'bio-checkin' | 'drill-library' | 'rabbit-holes' | 'message-coach' | 'schedule-session' | 'shadow';
type GroupID = 'today' | 'development' | 'learn' | 'schedule' | 'messages' | 'shadow';

/**
 * The six task-oriented groups the eleven surfaces sit under, approved by the
 * owner on 2026-08-16 (see docs/design/ATHLETE_WORKSPACE_IA_MOCKUP.md).
 *
 * Grouping is the whole change: every panel below still renders off its own
 * TabID exactly as before, so no surface moved, gained, or lost content. What
 * moved is how an athlete reaches it -- eleven equal-weight buttons asked a kid
 * to know the whole app before choosing, which is the opposite of task-oriented.
 *
 * The order is the order of a visit: check in, do the work, look at your own
 * record, study, then the things that are not about today at all.
 *
 * WHAT IS NOT LISTED HERE, AND WHY (2026-08-21). Three surfaces an athlete
 * could reach carried nothing behind them, and a tab is a promise that there
 * is something behind it:
 *
 * - Bio Check-In: every field was local React state. Nothing in this app called
 *   /api/pilot/athlete/check-in, so a "Daily Biological Check-In" screen told a
 *   child they had checked in and wrote nothing down.
 * - Tracks: every field read "Nobody has written this down yet". Honest, and
 *   still a tab an athlete opens to find nothing.
 * - Assessments: labelled "NOT BUILT YET" over a disabled Start button.
 *
 * The panels themselves are left in place further down, unreachable rather
 * than deleted -- the work stands, and each comes back by adding its entry
 * here once something stores what it collects.
 *
 * BIO CHECK-IN CAME BACK (2026-08-28), on exactly that condition. Something
 * stores what it collects: /api/pilot/athlete/check-in is built, tested and
 * live, and the panel is now AthleteCheckInPanel writing to it rather than to
 * local state. The old sliders could not have come back as they were -- an
 * HTML range always has a position, so they recorded four opinions the child
 * never expressed -- so the questions are described choices that start
 * unanswered and stay absent when skipped.
 *
 * IT IS LABELLED "Wellness", NOT "Check In". The Session Log's button on the
 * Dashboard is already called Check In and opens a TRAINING SESSION -- a
 * different record with a different meaning. Two controls sharing that name
 * one screen apart is the confusion this workspace has been carrying since
 * the two check-ins diverged, and naming this one after what it collects
 * ends it. (It also stopped six tests dead on an ambiguous accessible name,
 * which is the cheap version of the same lesson.)
 *
 * It is FIRST in Today by owner decision: "wellness and bios should be the
 * first screen that opens, to encourage use". openingTabFor's comment below
 * described the opposite and has been corrected rather than left to rot; this
 * list is what actually decides, which is the lesson from last time.
 *
 * Tracks and Assessments stay unlisted. Nothing has changed for them.
 */
const TAB_GROUPS: { id: GroupID; label: string; tabs: { id: TabID; label: string }[] }[] = [
  {
    id: 'today',
    label: 'Today',
    tabs: [
      { id: 'bio-checkin', label: 'Wellness' },
      { id: 'my-dashboard', label: 'Dashboard' },
      { id: 'athlete-floor', label: 'Floor' },
    ],
  },
  {
    id: 'development',
    label: 'Development',
    tabs: [
      { id: 'smart-goals', label: 'Goals' },
      // BASE-05: the athlete's own attempt log over the training-attempts ledger.
      { id: 'attempt-log', label: 'Attempts' },
    ],
  },
  {
    id: 'learn',
    label: 'Learn',
    tabs: [
      { id: 'drill-library', label: 'Drills' },
      { id: 'rabbit-holes', label: 'Rabbit Holes' },
    ],
  },
  { id: 'schedule', label: 'Schedule', tabs: [{ id: 'schedule-session', label: 'Schedule' }] },
  { id: 'messages', label: 'Messages', tabs: [{ id: 'message-coach', label: 'Messages' }] },
  { id: 'shadow', label: 'SHADOW', tabs: [{ id: 'shadow', label: 'SHADOW Intel' }] },
];

/** Which group owns a surface. Derived, never stored -- the tab stays the truth. */
function groupForTab(tab: TabID): GroupID {
  return TAB_GROUPS.find((group) => group.tabs.some((entry) => entry.id === tab))?.id ?? 'today';
}
type ReadinessLevel = 'GREEN' | 'YELLOW' | 'RED';
/**
 * The categories a goal can be filed under, and the mirror of GOAL_CATEGORIES
 * in src/server/pilot/contracts.ts and the CHECK in
 * pilot_slice_postgres_goal_category_progress_migration.sql. Exported so
 * athleteWorkspace.test.tsx can assert the three stay identical -- a value
 * offered here that the API rejects would fail goal creation outright, and this
 * component cannot import the server contract to find that out at build time.
 *
 * 'Weight Loss' and 'Weight Gain' have a history worth knowing before touching
 * them: offered here until 2026-08-03 but never stored (the category was
 * dropped before the request was built), then deliberately withheld, then
 * admitted by owner decision 2026-08-28 once the Privacy-Tier System the
 * withholding waited on had shipped. See the migration header.
 *
 * Choosing one is now a real, stored choice -- and the guidance that replaced
 * them is kept rather than deleted, shown when one of the two is selected. The
 * 2026-08-03 owner principle is that the stop carries the lesson; the lesson
 * outlived the stop. Making weight is still a plan built with a coach and a
 * guardian, and the form still says so.
 */
export const SMART_GOAL_CATEGORIES = [
  'Boxing',
  'Fitness',
  'Academics',
  'Attendance',
  'Recovery',
  'Lifestyle',
  'Leadership',
  'Weight Loss',
  'Weight Gain',
] as const;

/** The two categories whose selection surfaces the coach-and-guardian note. */
export const WEIGHT_GOAL_CATEGORIES: readonly string[] = ['Weight Loss', 'Weight Gain'];

type SMARTCategory = (typeof SMART_GOAL_CATEGORIES)[number];
type GoalStatus = 'Not Started' | 'Active' | 'Completed' | 'Paused';
type PainType = 'Sharp' | 'Dull' | 'Burning' | 'Tight' | 'Pulling' | 'Throbbing' | 'Swollen' | 'Numbness/Tingling' | 'Instability' | 'Other';

interface SMARTGoal {
  id: string;
  title: string;
  // Null is a goal nobody categorised and a goal nobody has reported progress
  // on. Both render as unknown rather than as a category and a 0% bar -- until
  // 2026-08-03 this screen substituted 'Boxing' and 0 for the two columns that
  // did not exist, so every goal in the gym read as an untouched boxing goal.
  category: SMARTCategory | null;
  targetDate: string;
  successMetric: string;
  progressPercent: number | null;
  status: GoalStatus;
  // The two fields a progress report has to send back untouched. /api/pilot/
  // goals/update takes a whole goal and writes what it is given, so a partial
  // payload does not leave the rest alone -- it clears it. `status` is held
  // separately from the display-cased `status` above because the round trip
  // must return the server's own value, not 'Active' where it wrote 'active'.
  createdAt: string;
  statusRaw: string;
  specific: string;
  measurable: string;
  achievable: string;
  relevant: string;
  timeBound: string;
}

/**
 * One piece of work a coach assigned this athlete, as the Floor shows it.
 *
 * A read of GET /api/pilot/progression/assignments -- the same rows
 * /athlete/progression-intelligence lists -- carrying only the fields the Floor
 * draws. Nothing here is derived: the dose and the due date are the coach's,
 * or absent. The Progression page stays the owner of the full record, the
 * drill instruction and the completion log; the Floor links to them.
 *
 * The Floor used to hold a plan this component generated at check-in -- the
 * same three items for every athlete, stored as if it were somebody's plan.
 * That is gone (A-FIN-04): the Floor is what a coach assigned, or it says
 * nobody has.
 */
interface CoachWorkItem {
  assignment_id: string;
  drill_id?: string | null;
  drill_name: string;
  drill_display_name?: string | null;
  status: string;
  rep_count?: number | null;
  duration_minutes?: number | null;
  frequency_per_week?: number | null;
  due_date?: string | null;
}

/** 'assigned' and 'in_progress' mean "still to do"; the rest are record, not today. */
function isOpenCoachWork(status: string | undefined): boolean {
  return status === 'assigned' || status === 'in_progress';
}

/** Where the Floor sends an athlete to act on one assignment. See the deep-link on that page. */
function progressionLink(assignmentId: string, intent: 'instruction' | 'log'): string {
  return `/athlete/progression-intelligence?assignment=${encodeURIComponent(assignmentId)}&intent=${intent}`;
}

/**
 * A reference drill the gym has adopted, as an athlete reads it.
 *
 * This is REFERENCE material, not the gym's operational drill list. Before W-D2
 * this panel read /api/pilot/drills -- the operational library -- which meant
 * an athlete's "Learn" surface was showing the same rows a coach assigns from,
 * and the instructional content behind them was unreachable. It now reads the
 * reference library itself, already filtered by the server to what this gym has
 * promoted and still runs, and already stripped of authoring and provenance
 * metadata.
 *
 * THE BROWSE SHAPE -- LEVEL 1 of OD-2026-09-19-001. The card renders only the
 * name, what the drill is for, the contact level and the coach-authorization
 * flag. Everything else -- steps, what good and bad look like, corrections,
 * scaling and stop rules -- is LEVEL 2, read from AthleteDrillDetail when the
 * athlete opens a drill, and rendered by the shared DrillDetail component.
 *
 * What is excluded outright is planning taxonomy -- no category, no difficulty
 * band, no skill code -- because this screen is for learning the drill, not for
 * planning sessions.
 */
/** What the athlete reads when an opened drill has been withdrawn since the list loaded. */
const DRILL_WITHDRAWN = "This drill is no longer in your gym's library.";

/** The Learn card's Open button, addressable so Back can return focus to it. */
function learnOpenButtonId(drillId: string): string {
  return `learn-open-${drillId}`;
}

interface ReferenceDrill {
  id: string;
  name: string;
  purpose: string;
  setup: string;
  execution: string;
  contactLevel: string;
  requiresCoachAuthorization: boolean;
  cues: string[];
}

interface ShadowObservationItem {
  id: string;
  source: 'event' | 'telemetry';
  label: string;
  review_state: 'pending_review' | 'approved' | 'rejected' | 'promoted' | 'unknown';
  created_at: string;
}

interface PainLogEntry {
  id: string;
  location: string;
  type: PainType;
  severity: number;
  capturedAt: string;
}

/**
 * The stored session a check-out updates. Held from check-in because
 * /api/pilot/sessions/update replaces the whole record: every field below has
 * to be sent back unchanged for the notes to be added to it.
 */
interface ActiveSessionRecord {
  sessionId: string;
  athleteId: string;
  date: string;
  // NULL until check-out. An open session has not been trained yet, so there
  // is no exertion to rate -- see the rpe comment on PilotSession.
  rpe: number | null;
  rpeMethod: SessionRpeMethod;
  checkInNote: string;
  createdAt: string;
}

/** A row of pilot.sessions as GET /api/pilot/sessions/list returns it. */
interface StoredSession {
  sessionId: string;
  athleteId: string;
  date: string;
  rpe: number | null;
  rpeMethod: SessionRpeMethod;
  notes: string;
  completed: boolean;
  createdAt: string;
}

type StoredSessionLoadState = 'loading' | 'loaded' | 'unavailable';
type NotesSaveState = 'idle' | 'saving' | 'saved' | 'failed';
type AthleteIdentityState = 'loading' | 'resolved' | 'unavailable';

// How long the athlete stops typing before the draft is written to their open
// session. Short enough that a tablet recycling the tab loses a phrase at
// worst, long enough that ordinary typing is not one request per keystroke.
const NOTES_DRAFT_SAVE_DELAY_MS = 1200;

/**
 * The note stored when the athlete typed nothing at check-in. pilot.sessions
 * requires a non-empty note, so something has to be written; recognising that
 * exact form on the way back is what keeps it out of the athlete's own notes
 * box, where it would read as a sentence they wrote.
 */
function autoCheckInNote(readiness: ReadinessLevel): string {
  return `Auto check-in readiness ${readiness}`;
}

const AUTO_CHECK_IN_NOTE_PATTERN = /^Auto check-in readiness (GREEN|YELLOW|RED)$/;

/**
 * The post-session effort question an athlete answers at check-out, on the
 * 0-10 range pilot.sessions.rpe and validateSessionPayload accept.
 *
 * The words are the session-RPE convention (Foster et al., 2001: the modified
 * CR-10 scale used for session RPE). It puts words at 0, 1, 2, 3, 4, 5, 7 and
 * 10 and deliberately none at 6, 8 and 9, which sit between the words either
 * side -- so those stay bare numbers here rather than being given labels the
 * scale does not have.
 *
 * Asked about the session JUST FINISHED, never about how ready the athlete
 * felt beforehand: that is the check-in slider, which is a different record
 * and must never reach this one.
 */
const POST_SESSION_EFFORT_QUESTION = 'How hard was the session you just finished?';
const POST_SESSION_EFFORT_SCALE: ReadonlyArray<{ value: number; anchor: string | null }> = [
  { value: 0, anchor: 'Rest' },
  { value: 1, anchor: 'Very, very easy' },
  { value: 2, anchor: 'Easy' },
  { value: 3, anchor: 'Moderate' },
  { value: 4, anchor: 'Somewhat hard' },
  { value: 5, anchor: 'Hard' },
  { value: 6, anchor: null },
  { value: 7, anchor: 'Very hard' },
  { value: 8, anchor: null },
  { value: 9, anchor: null },
  { value: 10, anchor: 'Maximal' },
];

/**
 * pilot.sessions stores date as `date` and rpe as `numeric`, and node-postgres
 * hands both back in shapes the session validator rejects on the way in: a
 * timestamp for the first, a string for the second. A rehydrated record is
 * sent straight back by check-out, so it is normalized on arrival. A row that
 * cannot be normalized is dropped rather than half-trusted -- a session whose
 * identity or timing is unreadable must not become the one the athlete is
 * offered a check-out for.
 */
/**
 * pilot.sessions.rpe as the training card needs it: a number, or null for
 * "nobody has rated this session".
 *
 * The column is `numeric` and node-postgres hands it back as a string, so a
 * coercion is unavoidable -- but absence is tested first, because Number(null)
 * is 0 and 0 is a real RPE. An unparseable value is absent too: a row that
 * cannot be read is not a row rated zero.
 */
function normalizeCardRpe(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStoredSession(row: unknown): StoredSession | null {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const record = row as Record<string, unknown>;
  const sessionId = typeof record.session_id === 'string' ? record.session_id.trim() : '';
  const athleteId = typeof record.athlete_id === 'string' ? record.athlete_id.trim() : '';
  const date = typeof record.date === 'string' ? record.date.slice(0, 10) : '';
  const createdAt = typeof record.created_at === 'string' ? record.created_at : '';

  // null and undefined are checked BEFORE Number(), because Number(null) is 0
  // and 0 is a legitimate RPE. Coercing first would turn "not rated yet" into
  // "rated it zero" -- a fabricated reading, and the exact class of defect the
  // rpe/readiness separation exists to end.
  const rpeIsAbsent = record.rpe === null || record.rpe === undefined;
  const rpe = rpeIsAbsent ? null : Number(record.rpe);

  if (!sessionId || !athleteId || !date || !createdAt) {
    return null;
  }
  if (rpe !== null && !Number.isFinite(rpe)) {
    return null;
  }

  // An unrecognised method is not silently treated as the honest one. Anything
  // this client does not know reads as UNKNOWN, which is what a row predating
  // the method column genuinely is.
  const rpeMethod: SessionRpeMethod = record.rpe_method === 'athlete_post_session_self_report'
    ? 'athlete_post_session_self_report'
    : 'UNKNOWN';

  return {
    sessionId,
    athleteId,
    date,
    rpe,
    rpeMethod,
    notes: typeof record.notes === 'string' ? record.notes : '',
    completed: record.completed_flag === true,
    createdAt,
  };
}

function getReadinessLevel(readinessToTrain: number): ReadinessLevel {
  if (readinessToTrain >= 7) return 'GREEN';
  if (readinessToTrain >= 5) return 'YELLOW';
  return 'RED';
}

/* Goal states are queue outcomes, so they wear the design system's badge rungs
   with a glyph beside the label (Laws 2 + 3), never colour alone. */
function getGoalStatusBadge(status: GoalStatus): { className: string; glyph: string } {
  if (status === 'Active') return { className: 'badge badge--monitor', glyph: '◉' };
  if (status === 'Completed') return { className: 'badge badge--cleared', glyph: '✓' };
  return { className: 'badge badge--restricted', glyph: '▲' };
}

/* This workspace is a gym-floor kiosk surface (PAGE_MAP: ink, Law 5), so tabs
   are floor-sized: every target clears var(--tap). A selected tab is a control
   in the "on" position — brass chassis, never a status colour (Laws 1 + 2). */
const KIOSK_TAB_BASE =
  'inline-flex min-h-[var(--tap)] items-center rounded-[var(--r-md)] border-2 px-[var(--s4)] font-mono text-[length:var(--t-sm)] font-bold uppercase tracking-[0.08em] transition focus-visible:outline-none focus-visible:shadow-[var(--focus)]';
const KIOSK_TAB_ACTIVE = 'border-[color:var(--brass-600)] bg-[var(--brass-500)] text-[color:var(--hide-950)]';
const KIOSK_TAB_INACTIVE =
  'border-[color:rgb(var(--brass-400-rgb)_/_.28)] bg-[rgba(0,0,0,.26)] text-[color:var(--bone-300)] hover:border-[color:var(--brass-400)] hover:text-[color:var(--bone-100)]';

/* Kiosk panel shells — the sheet's materials instead of bordered rectangles. */
const PANEL = 'mat-leather rounded-[var(--r-lg)] p-[var(--s5)]';
const PANEL_RAISED = 'mat-leather--raised rounded-[var(--r-lg)] p-[var(--s5)]';

// Fast-Track observation feed: best-effort only. The athlete's check-out
// (POST /api/pilot/sessions/update) already fully succeeds or fails on its
// own -- these calls only enrich SHADOW's formula engine with a Session Load
// (RPE x duration) input, so a failure here must never block or roll back the
// primary write.
//
// THIS RUNS AT CHECK-OUT, NOT CHECK-IN, and that is the whole point. Session
// Load multiplies session RPE by duration; both inputs only exist once the
// session is over. It used to run at check-in with the pre-session readiness
// slider as `session_rpe` and the pre-session duration box as `duration`, so
// SHADOW was multiplying two numbers that had not measured anything yet.
//
// Both values are passed as null when the athlete did not give them, and
// NOTHING is submitted in that case. There is no default and no prefill here
// on purpose: a prefilled control that nobody touches is indistinguishable
// from an answer, which is exactly how the planned 60 minutes became an
// observed duration.

// The vocabularies this tab reads. A rabbit hole is stored against one stable
// key, and the read takes one anchor at a time, so the tab asks for the terms
// that describe an athlete's own development: every progression gap type and
// every severity. Built from the shared vocabulary rather than retyped, so a
// term added to either list is asked for here without another edit.
const RABBIT_HOLE_TAB_ANCHORS: ReadonlyArray<{ anchorType: 'gap_type' | 'severity'; anchorKey: string }> = [
  ...ANCHOR_KEY_OPTIONS.gap_type.map((option) => ({ anchorType: 'gap_type' as const, anchorKey: option.key })),
  ...ANCHOR_KEY_OPTIONS.severity.map((option) => ({ anchorType: 'severity' as const, anchorKey: option.key })),
];

interface RabbitHoleTopic {
  anchorType: string;
  anchorKey: string;
  lessons: RabbitHoleLessonItem[];
}

type RabbitHoleLoadState = 'loading' | 'loaded' | 'unavailable';

/**
 * The gym's authored lessons, as the athlete reads them.
 *
 * Every lesson here was written by a person at this gym. Nothing on this
 * surface carries a SHADOW evidence tier -- PROVEN / EMERGING / EXPERIMENTAL /
 * RESEARCH_NEEDED grade retrieved and cited material, and coaching written by
 * hand cannot borrow that authority.
 *
 * A topic with no lesson is not drawn at all, and a read that did not complete
 * is never reported as an empty library: "the gym has published nothing" is a
 * claim about the coaches, not about the network.
 */
function AthleteRabbitHoleLibrary() {
  const [topics, setTopics] = useState<RabbitHoleTopic[]>([]);
  const [loadState, setLoadState] = useState<RabbitHoleLoadState>('loading');
  const [isPartial, setIsPartial] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      const results = await Promise.all(RABBIT_HOLE_TAB_ANCHORS.map(async (anchor) => {
        try {
          const response = await fetch(`${apiBase()}/api/pilot/rabbit-holes/get`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ anchor_type: anchor.anchorType, anchor_key: anchor.anchorKey }),
            signal: controller.signal,
          });

          if (!response.ok) {
            return { anchor, lessons: null };
          }

          const payload = (await response.json()) as { ok?: boolean; rabbit_holes?: RabbitHoleLessonItem[] };
          if (payload.ok !== true || !Array.isArray(payload.rabbit_holes)) {
            return { anchor, lessons: null };
          }

          return { anchor, lessons: payload.rabbit_holes };
        } catch {
          return { anchor, lessons: null };
        }
      }));

      if (controller.signal.aborted) {
        return;
      }

      const failures = results.filter((result) => result.lessons === null).length;
      if (failures === results.length) {
        setTopics([]);
        setIsPartial(false);
        setLoadState('unavailable');
        return;
      }

      setTopics(
        results
          .filter((result) => result.lessons !== null && result.lessons.length > 0)
          .map((result) => ({
            anchorType: result.anchor.anchorType,
            anchorKey: result.anchor.anchorKey,
            lessons: result.lessons as RabbitHoleLessonItem[],
          })),
      );
      setIsPartial(failures > 0);
      setLoadState('loaded');
    })();

    return () => controller.abort();
  }, []);

  if (loadState === 'loading') {
    return <span className="working">Loading the gym&apos;s rabbit holes...</span>;
  }

  if (loadState === 'unavailable') {
    return (
      <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
        The gym&apos;s rabbit holes could not be loaded right now. That is a problem reaching the app, not a sign
        that none have been written.
      </p>
    );
  }

  return (
    <div className="space-y-[var(--s5)]">
      {isPartial ? (
        <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
          Some topics could not be loaded, so what follows is not the full list.
        </p>
      ) : null}

      {topics.length === 0 && !isPartial ? (
        <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
          Your coaches have not published a rabbit hole yet. When they do, it appears here.
        </p>
      ) : null}

      {topics.map((topic) => (
        <div key={`${topic.anchorType}:${topic.anchorKey}`} className="space-y-[var(--s4)]">
          <h3 className="t-eyebrow">
            {anchorLabel(topic.anchorType, topic.anchorKey)}
          </h3>
          {/* A lesson is an authored sheet, so it is a paper object on the
              leather ground — its ink comes from the material itself. */}
          {topic.lessons.map((lesson) => (
            <article key={lesson.rabbit_hole_id} className="mat-paper rounded-[var(--r-md)] p-[var(--s5)] space-y-[var(--s4)]">
              {/* Provenance before content: who is talking, and on what
                  authority, before the claim itself. */}
              <p className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] opacity-70">
                Gym coaching · Written by {lesson.author_display_name}
              </p>
              <h4 className="text-[length:var(--t-md)] font-semibold">{lesson.title}</h4>
              <p className="text-[length:var(--t-sm)] leading-relaxed"><strong>Concept:</strong> {lesson.concept}</p>
              {lesson.homework ? (
                <div className="rounded-[var(--r-md)] border-l-4 border-[color:var(--brass-700)] bg-[var(--paper-2)] p-[var(--s4)]">
                  <p className="text-[length:var(--t-sm)] leading-relaxed"><strong>Homework:</strong> {lesson.homework}</p>
                </div>
              ) : null}
              {lesson.citation ? (
                <p className="text-[length:var(--t-xs)] opacity-80">
                  <strong>Library source:</strong> {lesson.citation.document_name}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function AthleteWorkspace() {
  const [activeTab, setActiveTab] = useState<TabID>('my-dashboard');
  const [backendAthleteId, setBackendAthleteId] = useState<string | null>(null);
  const [athleteIdentityState, setAthleteIdentityState] = useState<AthleteIdentityState>('loading');
  const [backendSyncMessage, setBackendSyncMessage] = useState('');

  // Check-In State.
  //
  // The five sliders that used to sit here (sleepHours, motivation, soreness,
  // hydrationStatus, expandedCheckIn) are gone: they were local state bound to
  // controls that persisted nothing, and their replacements live in
  // AthleteCheckInPanel writing to /api/pilot/athlete/check-in.
  //
  // The RECORD is owned here rather than in the panel on purpose. The Floor tab
  // is gated on having checked in, and that gate has to be right whether or not
  // the athlete has ever opened the check-in tab -- a panel that fetches its own
  // state would leave the gate guessing until it mounted.
  const [todayCheckIn, setTodayCheckIn] = useState<AthleteCheckInRecord | null>(null);
  const [recentCheckIns, setRecentCheckIns] = useState<AthleteCheckInRecord[]>([]);
  const [checkInLoading, setCheckInLoading] = useState(true);
  const [checkInLoadError, setCheckInLoadError] = useState<string | null>(null);
  /* Set by the pain report below, never by the athlete directly. It is a
     display of "a pain report was filed this session", which is why it is
     rendered as a status line and not as a tickbox: the tickbox let an athlete
     set it by hand, and that hand-set value went nowhere. */
  const [injuryFlag, setInjuryFlag] = useState(false);
  const [readinessToTrain, setReadinessToTrain] = useState(8);
  const [selectedPainLocation, setSelectedPainLocation] = useState<string | null>(null);
  const [showPainModal, setShowPainModal] = useState(false);
  const [currentPainType, setCurrentPainType] = useState<PainType>('Dull');
  const [currentPainSeverity, setCurrentPainSeverity] = useState(3);
  const [painLog, setPainLog] = useState<PainLogEntry[]>([]);
  const [isSavingPain, setIsSavingPain] = useState(false);
  const [painSaveMessage, setPainSaveMessage] = useState('');

  // Goals State - Real API data
  const [smartGoals, setSmartGoals] = useState<SMARTGoal[]>([]);
  const [goalsLoading, setGoalsLoading] = useState(true);
  const [goalsError, setGoalsError] = useState<string | null>(null);
  const [trainingSessions, setTrainingSessions] = useState<TrainingSession[]>([]);

  const [showGoalForm, setShowGoalForm] = useState(false);
  const [isCreatingGoal, setIsCreatingGoal] = useState(false);
  const [savingGoalProgressId, setSavingGoalProgressId] = useState<string | null>(null);
  const [newGoalTitle, setNewGoalTitle] = useState('');
  const [newGoalCategory, setNewGoalCategory] = useState<SMARTCategory>('Boxing');
  const [newGoalTargetDate, setNewGoalTargetDate] = useState('');
  const [newGoalSuccessMetric, setNewGoalSuccessMetric] = useState('');

  // The work a coach assigned this athlete that is still open: the Floor's
  // list and the Today card's count, from the one read. Kept in the order the
  // API returned it -- the Floor does not re-rank a coach's list.
  const [openCoachWork, setOpenCoachWork] = useState<CoachWorkItem[]>([]);
  const [assignedWorkLoading, setAssignedWorkLoading] = useState(true);
  const [assignedWorkError, setAssignedWorkError] = useState<string | null>(null);

  // The gym's own drill library, written by its coaches.
  const [drills, setDrills] = useState<ReferenceDrill[]>([]);
  const [drillsLoading, setDrillsLoading] = useState(true);
  const [drillsError, setDrillsError] = useState<string | null>(null);
  // LEVEL 2 of OD-2026-09-19-001: the one drill an athlete has opened. Read
  // from the athlete detail endpoint, which is the server's constructive,
  // provenance-free projection. Reading it writes nothing.
  const [openDrillId, setOpenDrillId] = useState<string | null>(null);
  const [openDrill, setOpenDrill] = useState<DrillDetailView | null>(null);
  const [openDrillLoading, setOpenDrillLoading] = useState(false);
  const [openDrillError, setOpenDrillError] = useState<string | null>(null);

  // Shadow State
  const [shadowObservations, setShadowObservations] = useState<ShadowObservationItem[]>([]);
  const [shadowObservationError, setShadowObservationError] = useState('');
  const [coachMessageBody, setCoachMessageBody] = useState('');
  const [isSendingCoachMessage, setIsSendingCoachMessage] = useState(false);
  const [coachMessageStatus, setCoachMessageStatus] = useState('');

  // Session Log State. The open session is the server's, not this tab's: a
  // shared gym tablet recycles the tab without warning, and an athlete who
  // came back to a check-in button had no way to close the session they were
  // still inside.
  const [storedSessions, setStoredSessions] = useState<StoredSession[]>([]);
  const [storedSessionLoad, setStoredSessionLoad] = useState<StoredSessionLoadState>('loading');
  const [checkInNotes, setCheckInNotes] = useState('');
  const [activeSessionRecord, setActiveSessionRecord] = useState<ActiveSessionRecord | null>(null);
  const [notesSaveState, setNotesSaveState] = useState<NotesSaveState>('idle');
  const [isCheckingIn, setIsCheckingIn] = useState(false);
  const [isCheckingOut, setIsCheckingOut] = useState(false);

  /* The athlete's answer to the post-session effort question, if they gave
     one (A-FIN-05). The check-in controls that used to supply an RPE measured
     the wrong thing -- readiness before training -- and were disconnected; this
     is the control that was missing, asked at the end of the session.

     KEYED TO THE SESSION IT WAS GIVEN FOR. An answer carries the session id,
     and it only counts while that session is the open one, so an answer can
     never drift onto a later session -- "no value from previous sessions" is
     structural, not a reset someone has to remember. It starts null, which is
     "not answered", and stays null unless the athlete picks a number.

     Observed duration is still not collected by anything, so there is still
     no Session Load to send. */
  const [postSessionEffort, setPostSessionEffort] = useState<{ sessionId: string; value: number } | null>(null);

  /* The gym's own noises, off unless this browser opted in. play() is safe to
     call unconditionally: it returns false and does nothing when sound is off,
     which is the default and is what a loud floor kiosk stays on. Every call
     below sits beside a visible change that already carries the whole message,
     so the volume being down costs nothing. */
  const { play } = useGymSound();

  const currentReadiness: ReadinessLevel = getReadinessLevel(readinessToTrain);
  const checkInTime = activeSessionRecord ? formatGymStamp(activeSessionRecord.createdAt) : null;

  /* Which group is open is DERIVED from the open tab, never stored alongside
     it. Two sources of truth for one selection is how a nav starts lying: the
     tab is the truth, the group is a read of it. */
  const activeGroup = groupForTab(activeTab);
  const activeGroupTabs = TAB_GROUPS.find((group) => group.id === activeGroup)?.tabs ?? [];
  /* The masthead names where you actually are, the way the approved board
     does: the open group as the title, the open surface underneath it. It
     used to read "My Training Dashboard" no matter which of the eleven
     surfaces was showing, so the one line on the page that claimed to say
     where you were was wrong nine times out of eleven. Both fall out of
     activeTab, so neither can drift from the nav. */
  const activeGroupLabel = TAB_GROUPS.find((group) => group.id === activeGroup)?.label ?? 'Today';
  const activeTabLabel = activeGroupTabs.find((tab) => tab.id === activeTab)?.label ?? activeGroupLabel;

  /* Where a group opens when its button is pressed. Only Today varies: it
     opens on check-in until the athlete has checked in, then on their
     dashboard, because the useful surface changes once that fact is recorded.
     Every other group opens on its first surface. */
  const openingTabFor = (group: GroupID): TabID => {
    /* Today opens on Check In, because that is the first thing a visit is
       (owner decision 2026-08-28: "wellness and bios should be the first
       screen that opens, to encourage use").

       This comment used to claim Today always opened on the dashboard. It was
       false the whole time it stood: tabs[0] was Bio Check-In, and this
       function returns tabs[0]. The intention lived here while the behaviour
       lived in TAB_GROUPS, and only one of them decided anything. So this is
       deliberately a DESCRIPTION of what the list does, not a second opinion
       about what it should do -- change the list, not this. */
    return TAB_GROUPS.find((entry) => entry.id === group)?.tabs[0]?.id ?? 'my-dashboard';
  };
  const notesDraft = checkInNotes.trim();
  const notesStored = notesDraft.length > 0 && notesDraft === activeSessionRecord?.checkInNote;
  const recentSessions = storedSessions.filter((session) => session.completed).slice(0, 5);
  // The answer for the session that is open now, or null. See postSessionEffort.
  const answeredEffort = postSessionEffort !== null && activeSessionRecord !== null
    && postSessionEffort.sessionId === activeSessionRecord.sessionId
    ? postSessionEffort.value
    : null;
  // Only a successful read is a number. See AthleteCountRead.
  const openCoachWorkRead: AthleteCountRead = assignedWorkError
    ? { status: 'unavailable' }
    : assignedWorkLoading
      ? { status: 'loading' }
      : { status: 'read', count: openCoachWork.length };
  /* The day's workout and tasks open once the athlete has checked in (owner
     decision 2026-08-28: they have to do it to see that day's workout and
     tasks, and it must not block any other tool or capability).

     So this gates the FLOOR AND NOTHING ELSE. Dashboard, Goals, Drills,
     Rabbit Holes, Schedule, Messages and SHADOW stay open all day, checked in
     or not -- including the pain report, which a child must be able to reach
     without first filling in a form.

     IT FAILS OPEN, deliberately. While the record is still loading, and if it
     could not be read at all, the gate lifts. A child who checked in this
     morning must never be told to do it again because a fetch failed, and a
     floor locked by an error is worse than an ungated one. This is an
     encouragement, not a security boundary: it protects no data, and the
     server decides what it will serve regardless of what this renders. */
  const floorLockedPendingCheckIn = !checkInLoading && checkInLoadError === null && todayCheckIn === null;
  const goalsActive = smartGoals.filter(g => g.status === 'Active').length;

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/auth/session`, { method: 'POST', credentials: 'include' });
        const payload = (await response.json()) as { authenticated?: boolean; athlete_id?: string };
        if (response.ok && payload.authenticated && payload.athlete_id) {
          setBackendAthleteId(payload.athlete_id);
          setAthleteIdentityState('resolved');
          return;
        }
        setAthleteIdentityState('unavailable');
      } catch {
        // Keep workspace usable in local-only mode when backend session is
        // unavailable. Nothing about a session can be read or written in that
        // state, so the session panel says so rather than offering buttons.
        setAthleteIdentityState('unavailable');
      }
    })();
  }, []);

  // The reference library is gym-wide coaching content, so it loads once and
  // does not depend on which athlete is signed in. The SERVER decides what is
  // in it: this request carries no promotion filter and no field list, because
  // a filter the client applies is a filter the client can also drop.
  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/drill-library`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('The reference library did not load.');

        // `drills`, not `items` -- this route answers under a different key
        // from /api/pilot/drills, and reading the wrong one renders an empty
        // library instead of failing.
        const payload = (await response.json()) as {
          drills?: Array<{
            drill_id: string;
            name: string;
            purpose: string;
            setup: string;
            execution: string;
            contact_level: string;
            requires_coach_authorization: boolean;
            cues: string[];
          }>;
        };
        if (controller.signal.aborted) return;

        setDrills((payload.drills ?? []).map((drill) => ({
          id: drill.drill_id,
          name: drill.name,
          purpose: drill.purpose,
          setup: drill.setup,
          execution: drill.execution,
          contactLevel: drill.contact_level,
          requiresCoachAuthorization: drill.requires_coach_authorization,
          cues: drill.cues ?? [],
        })));
        setDrillsError(null);
      } catch (error) {
        if (controller.signal.aborted) return;
        setDrills([]);
        setDrillsError(error instanceof Error ? error.message : 'The reference library did not load.');
      } finally {
        if (!controller.signal.aborted) setDrillsLoading(false);
      }
    })();

    return () => controller.abort();
  }, []);

  // The opened drill's full detail. Keyed to the drill id and abortable, so a
  // slow answer for a drill the athlete has already left cannot land on the
  // one they opened next. GET only: opening a drill is reading.
  useEffect(() => {
    if (!openDrillId) return;
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(
          `${apiBase()}/api/pilot/drill-library?drill_id=${encodeURIComponent(openDrillId)}`,
          { method: 'GET', credentials: 'include', signal: controller.signal },
        );
        // 404 is an answer, not a failure: the drill was retired or its
        // reference withdrawn after the list loaded. Trying again cannot help,
        // so it is not described as a load failure.
        if (response.status === 404) throw new Error(DRILL_WITHDRAWN);
        if (!response.ok) throw new Error('This drill did not load.');
        const payload = (await response.json()) as { drill?: AthleteDrillDetail };
        if (controller.signal.aborted) return;
        if (!payload.drill) throw new Error('This drill did not load.');
        setOpenDrill(fromAthleteDrillDetail(payload.drill));
      } catch (error) {
        if (controller.signal.aborted) return;
        setOpenDrillError(error instanceof Error ? error.message : 'This drill did not load.');
      } finally {
        if (!controller.signal.aborted) setOpenDrillLoading(false);
      }
    })();

    return () => controller.abort();
  }, [openDrillId]);

  // State is reset here, in the handler, rather than at the top of the effect:
  // a synchronous setState inside an effect cascades a render before the
  // request has even left.
  const openReferenceDrill = (drillId: string) => {
    setOpenDrill(null);
    setOpenDrillError(null);
    setOpenDrillLoading(true);
    setOpenDrillId(drillId);
  };

  // Back returns focus to the card that opened the drill: the Back button is
  // about to disappear, and focus would otherwise fall to <body>.
  const closeReferenceDrill = () => {
    const openerId = openDrillId;
    setOpenDrillId(null);
    setOpenDrill(null);
    setOpenDrillError(null);
    setOpenDrillLoading(false);
    if (openerId && typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        const opener = document.getElementById(learnOpenButtonId(openerId));
        opener?.scrollIntoView?.({ block: 'center' });
        opener?.focus();
      });
    }
  };

  // Fetch goals when athlete ID is set
  const loadGoals = useCallback(async () => {
    if (!backendAthleteId) {
      return;
    }

    try {
      setGoalsLoading(true);
      setGoalsError(null);
      const response = await fetch(
        `${apiBase()}/api/pilot/goals/list?athlete_id=${encodeURIComponent(backendAthleteId)}`,
        { method: 'GET', credentials: 'include' }
      );
      if (!response.ok) throw new Error('Your goals did not load. Try again.');

      const data = (await response.json()) as { items?: Array<{ goal_id: string; title: string; category?: string | null; target_date?: string; metric?: string; progress_percent?: number | null; status?: string; created_at?: string }> };
      const items = data.items || [];

      // Convert PilotGoal to SMARTGoal format.
      //
      // Neither null is coerced. `item.category || 'Boxing'` and
      // `item.progress_percent || 0` are what this did before the columns
      // existed, and both were claims the row did not support -- the second
      // doubly so, since `|| 0` also rewrites a real reported 0 into the same
      // value as "unreported" and then draws a bar from it.
      const goals: SMARTGoal[] = items.map((item) => ({
        id: item.goal_id,
        title: item.title,
        category: (item.category ?? null) as SMARTCategory | null,
        targetDate: item.target_date?.split('T')[0] || '',
        successMetric: item.metric || '',
        progressPercent: item.progress_percent ?? null,
        status: (item.status ? item.status.charAt(0).toUpperCase() + item.status.slice(1).toLowerCase() : 'Not Started') as GoalStatus,
        createdAt: item.created_at || '',
        statusRaw: item.status || 'active',
        specific: '',
        measurable: '',
        achievable: '',
        relevant: '',
        timeBound: ''
      }));
      setSmartGoals(goals);
    } catch (error) {
      setGoalsError(error instanceof Error ? error.message : 'Your goals did not load. Try again.');
    } finally {
      setGoalsLoading(false);
    }
  }, [backendAthleteId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadGoals();
  }, [loadGoals]);

  /**
   * The coach-assigned work that is still open -- what the Floor shows.
   *
   * This is the one thing on the athlete's screen that a person put there by
   * hand, and it was the hardest thing on the screen to find: the drills a
   * coach assigned live at /athlete/progression-intelligence, reachable from
   * here only through a collapsed "More in your workspace" at the foot of the
   * page. Today states the day back to the athlete, so it has to include the
   * part of the day somebody else set.
   *
   * Every open item, in the order the API returned it. No "due today" window:
   * nothing on the record says which day a coach meant work for beyond its
   * due date, and a window would hide work a coach did assign. 'assigned' and
   * 'in_progress' are the two statuses that mean "still to do"; 'completed',
   * 'incomplete' and 'cancelled' are record, not today -- the Progression page
   * keeps that history.
   *
   * The route derives nothing from this id beyond the athlete named: it runs
   * assertActorCanAccessAthlete, which refuses an athlete any record but their
   * own. The value sent is the one the session handed back.
   */
  const loadAssignedWork = useCallback(async () => {
    // Identity is still resolving: "Checking..." is telling the truth.
    if (athleteIdentityState === 'loading') return;

    if (!backendAthleteId) {
      /* Identity RESOLVED with no athlete record -- the same case loadCheckIn
         handles below. A bare return would leave the Floor on "Loading your
         coach's work..." for the rest of the session, describing a request
         that is never going to be made. */
      setAssignedWorkLoading(false);
      setAssignedWorkError("This account is not linked to an athlete record, so there is no coach's work to show.");
      return;
    }

    try {
      setAssignedWorkLoading(true);
      setAssignedWorkError(null);
      const response = await fetch(
        `${apiBase()}/api/pilot/progression/assignments?athlete_id=${encodeURIComponent(backendAthleteId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('Your assigned work did not load.');

      const data = (await response.json()) as { items?: CoachWorkItem[] };
      setOpenCoachWork((data.items ?? []).filter((item) => isOpenCoachWork(item.status)));
    } catch (error) {
      // A failed read is not an empty list: the error is what renders, and
      // nothing from an earlier read is left standing as if it were current.
      setOpenCoachWork([]);
      setAssignedWorkError(error instanceof Error ? error.message : 'Your assigned work did not load.');
    } finally {
      setAssignedWorkLoading(false);
    }
  }, [backendAthleteId, athleteIdentityState]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAssignedWork();
  }, [loadAssignedWork]);

  /**
   * Today's check-in, and the athlete's own recent history.
   *
   * SELF-SCOPED WITH NO PARAMETER, unlike every other loader here: the route
   * takes the athlete id from the session principal and there is no
   * athlete_id to send. backendAthleteId is still awaited, because an account
   * not yet linked to an athlete record would only earn a 400.
   *
   * Failure is NOT silent, and does not fall back to "not checked in". The
   * Floor tab is gated on todayCheckIn, so a swallowed error would lock a
   * child out of their own workout and tell them to do something they had
   * already done. checkInLoadError opens the gate instead -- see the Floor
   * panel.
   */
  const loadCheckIn = useCallback(async () => {
    // Identity is still resolving: the spinner is telling the truth, so leave
    // it alone rather than deciding anything yet.
    if (athleteIdentityState === 'loading') return;

    if (!backendAthleteId) {
      /* Identity RESOLVED and this account has no athlete record. An early
         `return` alone -- which is what the sibling loaders above do -- would
         leave checkInLoading true forever, and this one is rendered: the
         Wellness tab would sit on "Loading your check-in..." for the rest of
         the session, which is a lie about a request that is never going to be
         made. The route would only answer 400 here, so say so instead.

         This also lifts the floor gate, which is correct: nothing here knows
         whether this person checked in, and a floor locked on an unknown is
         the failure mode the gate is written to avoid. */
      setCheckInLoading(false);
      setCheckInLoadError('This account is not linked to an athlete record, so there is no check-in to show.');
      return;
    }

    try {
      setCheckInLoading(true);
      setCheckInLoadError(null);
      const response = await fetch(`${apiBase()}/api/pilot/athlete/check-in`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Your check-in did not load.');

      const data = (await response.json()) as {
        today?: AthleteCheckInRecord | null;
        recent?: AthleteCheckInRecord[];
      };
      setTodayCheckIn(data.today ?? null);
      setRecentCheckIns(data.recent ?? []);
    } catch (error) {
      setCheckInLoadError(error instanceof Error ? error.message : 'Your check-in did not load.');
    } finally {
      setCheckInLoading(false);
    }
  }, [backendAthleteId, athleteIdentityState]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCheckIn();
  }, [loadCheckIn]);

  /**
   * The training card's rows. Read-only and honest: one stamp per session row,
   * so the card cannot show progress the ledger does not have. Failure is silent
   * on purpose -- an athlete's card is an encouragement, not an operational
   * surface, and an error banner over it would be louder than the thing itself.
   */
  const loadTrainingCard = useCallback(async () => {
    if (!backendAthleteId) return;
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/sessions/list?athlete_id=${encodeURIComponent(backendAthleteId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) { setTrainingSessions([]); return; }
      const data = (await response.json()) as { items?: TrainingSession[] };
      setTrainingSessions(
        (data.items ?? []).map((s) => ({
          session_id: s.session_id,
          date: s.date,
          // `Number(s.rpe) || 0` stood here and it fabricated a reading twice
          // over: Number(null) is 0, and `|| 0` then swallowed a genuine 0 as
          // well. pilot.sessions.rpe is nullable, so an un-checked-out session
          // arrives as null and must reach the card as null -- the card draws
          // "not recorded" for it. Absence is tested before the coercion, and
          // a value that will not parse stays absent rather than becoming 0.
          rpe: normalizeCardRpe(s.rpe),
          completed_flag: Boolean(s.completed_flag),
        })),
      );
    } catch {
      setTrainingSessions([]);
    }
  }, [backendAthleteId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadTrainingCard();
  }, [loadTrainingCard]);

  const loadShadowObservations = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/observation-projection`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 20 }),
      });

      if (!response.ok) {
        throw new Error("SHADOW's notes did not load.");
      }

      const payload = (await response.json()) as { items?: ShadowObservationItem[] };
      setShadowObservations(payload.items ?? []);
      setShadowObservationError('');
    } catch (error) {
      setShadowObservationError(error instanceof Error ? error.message : "SHADOW's notes did not load.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadShadowObservations();
  }, [loadShadowObservations]);

  /**
   * Read this athlete's sessions and recover the one still open.
   *
   * pilot.sessions is the only durable record of a check-in, so it is also the
   * only thing that can answer "am I still checked in" after a reload. The
   * list route orders by date alone, which cannot separate two sessions on the
   * same day, so ordering is redone here on created_at.
   */
  const loadStoredSessions = useCallback(async () => {
    if (!backendAthleteId) {
      return;
    }

    setStoredSessionLoad('loading');

    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/sessions/list?athlete_id=${encodeURIComponent(backendAthleteId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('Session history could not be read.');

      const payload = (await response.json()) as { items?: unknown[] };
      const sessions = (payload.items ?? [])
        .map(normalizeStoredSession)
        .filter((session): session is StoredSession => session !== null)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

      const open = sessions.find((session) => !session.completed) ?? null;

      setStoredSessions(sessions);
      setActiveSessionRecord(open
        ? {
            sessionId: open.sessionId,
            athleteId: open.athleteId,
            date: open.date,
            rpe: open.rpe,
            rpeMethod: open.rpeMethod,
            checkInNote: open.notes,
            createdAt: open.createdAt,
          }
        : null);

      if (open && !AUTO_CHECK_IN_NOTE_PATTERN.test(open.notes)) {
        // Put back what the athlete had written. A draft already in the box
        // wins: this read also runs on a manual retry and after a check-out
        // failure, where overwriting would destroy the notes it exists to
        // protect.
        setCheckInNotes((current) => current || open.notes);
      }

      setStoredSessionLoad('loaded');
    } catch {
      // "No open session" and "could not ask" have to stay distinguishable:
      // the first offers a check-in, the second must not claim the athlete is
      // checked out when nobody knows.
      setStoredSessionLoad('unavailable');
    }
  }, [backendAthleteId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStoredSessions();
  }, [loadStoredSessions]);

  /**
   * Write the notes box through to the open session while it is still open.
   *
   * Notes typed here used to exist only in this tab until check-out, so a
   * reload, a navigation, or a tablet recycling the tab threw away everything
   * the athlete had written for their coach. The session record is updated in
   * place instead, which is also what makes those notes survive a check-out
   * that never happens.
   */
  useEffect(() => {
    const record = activeSessionRecord;
    if (!record || isCheckingOut) {
      return;
    }

    const draft = checkInNotes.trim();
    // pilot.sessions requires a non-empty note, so an emptied box is not a
    // write -- clearing it must not erase what was already stored.
    if (!draft || draft === record.checkInNote) {
      return;
    }

    const timer = setTimeout(() => {
      void (async () => {
        setNotesSaveState('saving');
        try {
          const response = await fetch(`${apiBase()}/api/pilot/sessions/update`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              session_id: record.sessionId,
              athlete_id: record.athleteId,
              date: record.date,
              // Replayed unchanged: this is a notes save, not a rating. For an
              // open session both are still null/UNKNOWN.
              rpe: record.rpe,
              rpe_method: record.rpeMethod,
              notes: draft,
              completed_flag: false,
              created_at: record.createdAt,
              updated_at: new Date().toISOString(),
            }),
          });

          if (!response.ok) throw new Error('Notes were not saved.');

          setActiveSessionRecord((current) => (
            current && current.sessionId === record.sessionId
              ? { ...current, checkInNote: draft }
              : current
          ));
          setNotesSaveState('saved');
        } catch {
          setNotesSaveState('failed');
        }
      })();
    }, NOTES_DRAFT_SAVE_DELAY_MS);

    return () => clearTimeout(timer);
  }, [checkInNotes, activeSessionRecord, isCheckingOut]);

  const handleCreateGoal = async () => {
    if (isCreatingGoal) return;
    if (!newGoalTitle || !newGoalTargetDate || !newGoalSuccessMetric) return;
    if (!backendAthleteId) {
      // There is no local goal store -- goals exist only in pilot.goals -- so
      // without a backend session nothing is written anywhere.
      setBackendSyncMessage("That goal did not save. You are not signed in right now -- sign in again and put it back up.");
      return;
    }

    const now = new Date().toISOString();
    const goalId = `goal_${Date.now()}`;

    setIsCreatingGoal(true);

    try {
      const response = await fetch(`${apiBase()}/api/pilot/goals`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal_id: goalId,
          athlete_id: backendAthleteId,
          title: newGoalTitle,
          target_date: newGoalTargetDate,
          metric: newGoalSuccessMetric,
          status: 'active',
          // The chosen category now actually leaves the browser. It was held in
          // React state and never sent, and could not have been: the payload
          // validator rejects unknown fields, so a `category` key would have
          // 400'd. progress_percent is deliberately absent rather than 0 -- a
          // goal created a second ago has no progress report, and 0 would be a
          // report saying no progress has been made.
          category: newGoalCategory,
          created_at: now,
          updated_at: now,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ error: "That goal did not take. Try it again." }))) as { error?: string };
        setBackendSyncMessage(payload.error || "That goal did not take. Try it again.");
        return;
      }

      const newGoal: SMARTGoal = {
        id: goalId,
        title: newGoalTitle,
        category: newGoalCategory,
        targetDate: newGoalTargetDate,
        successMetric: newGoalSuccessMetric,
        progressPercent: null,
        status: 'Active',
        createdAt: now,
        statusRaw: 'active',
        specific: '',
        measurable: '',
        achievable: '',
        relevant: '',
        timeBound: ''
      };
      setSmartGoals([...smartGoals, newGoal]);
      setNewGoalTitle('');
      setNewGoalTargetDate('');
      setNewGoalSuccessMetric('');
      setShowGoalForm(false);
      setBackendSyncMessage("Goal's on the board. Now go work it.");
    } catch (error) {
      setBackendSyncMessage(error instanceof Error ? error.message : "That goal did not take. Try it again.");
    } finally {
      setIsCreatingGoal(false);
    }
  };

  /**
   * Report progress against a goal, or withdraw the report.
   *
   * Until this existed the progress bar was decoration: no column held a
   * percentage, nothing wrote one, and the width came from `|| 0`. A bar an
   * athlete cannot move is worse than no bar, because it reads as a measurement
   * of them rather than as an empty control.
   *
   * `percent` of null clears the report and returns the goal to untracked,
   * which is not the same as reporting 0. The whole goal goes back on every
   * call because /api/pilot/goals/update writes the record it is handed.
   */
  const handleUpdateGoalProgress = async (goalId: string, percent: number | null) => {
    const goal = smartGoals.find((candidate) => candidate.id === goalId);
    if (!goal || !backendAthleteId || savingGoalProgressId) {
      return;
    }

    const previous = goal.progressPercent;
    setSavingGoalProgressId(goalId);
    // Optimistic, then reverted on failure -- the alternative is a control that
    // appears not to respond until the round trip lands.
    setSmartGoals((current) => current.map(
      (candidate) => (candidate.id === goalId ? { ...candidate, progressPercent: percent } : candidate),
    ));

    try {
      const response = await fetch(`${apiBase()}/api/pilot/goals/update`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal_id: goal.id,
          athlete_id: backendAthleteId,
          title: goal.title,
          target_date: goal.targetDate,
          metric: goal.successMetric,
          status: goal.statusRaw,
          category: goal.category,
          progress_percent: percent,
          created_at: goal.createdAt,
          updated_at: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ error: 'Progress update failed' }))) as { error?: string };
        setSmartGoals((current) => current.map(
          (candidate) => (candidate.id === goalId ? { ...candidate, progressPercent: previous } : candidate),
        ));
        setBackendSyncMessage(payload.error || 'Progress update failed');
        return;
      }

      setBackendSyncMessage(
        percent === null ? 'Progress report cleared.' : `Progress saved: ${percent}%.`,
      );
    } catch (error) {
      setSmartGoals((current) => current.map(
        (candidate) => (candidate.id === goalId ? { ...candidate, progressPercent: previous } : candidate),
      ));
      setBackendSyncMessage(error instanceof Error ? error.message : 'Progress update failed');
    } finally {
      setSavingGoalProgressId(null);
    }
  };

  const handleCheckIn = async () => {
    // A second check-in over an open session would leave the first one open
    // forever, which is the state this screen exists to get out of.
    if (isCheckingIn || activeSessionRecord) {
      return;
    }

    const now = new Date();
    // The band is classified here for exactly one purpose: the session's
    // auto check-in NOTE -- a record of how the athlete said they felt. The
    // slider is an unvalidated self-report (readinessProvenance.ts), so it may
    // be written down but may not change what work is shown or sent anywhere.
    const readiness = getReadinessLevel(readinessToTrain);

    // Check-in builds nothing. It used to generate a plan -- the same three
    // items for everyone -- and POST it to /api/pilot/floor-plans as today's
    // floor. The Floor is now the work a coach assigned (A-FIN-04), so the only
    // thing this writes is the session.
    if (!backendAthleteId) {
      setBackendSyncMessage("That check-in did not take -- you are not signed in, so nothing was saved. "
        + "There is no session to check out of, so tell a coach you are here.");
      return;
    }

    setIsCheckingIn(true);

    const sessionId = `session_${Date.now()}`;
    const sessionDate = now.toISOString().slice(0, 10);
    const checkInNote = checkInNotes.trim() || autoCheckInNote(readiness);

    try {
      const sessionResponse = await fetch(`${apiBase()}/api/pilot/sessions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          athlete_id: backendAthleteId,
          date: sessionDate,
          // No RPE at check-in. The session has not happened, so there is no
          // exertion to rate; `rpe` stays null until check-out collects a real
          // one. This field used to carry `readinessToTrain` -- a pre-session
          // readiness self-report stored in the column named for session RPE,
          // which is the defect this change exists to end.
          rpe: null,
          rpe_method: 'UNKNOWN',
          notes: checkInNote,
          completed_flag: false,
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
        }),
      });

      if (sessionResponse.ok) {
        // Only a stored session becomes the active one. An athlete offered a
        // check-out for a session the app never wrote would lose everything
        // they typed into it at the moment they tried to hand it over.
        setActiveSessionRecord({
          sessionId,
          athleteId: backendAthleteId,
          date: sessionDate,
          rpe: null,
          rpeMethod: 'UNKNOWN',
          checkInNote,
          createdAt: now.toISOString(),
        });
        setNotesSaveState(checkInNotes.trim() ? 'saved' : 'idle');
        // Where a stored check-in takes the athlete depends on the one gate
        // this screen has (floorLockedPendingCheckIn): with today's wellness
        // recorded, straight to their coach's work; without it, to Wellness,
        // which is what opens that work. A check-in that did not store goes
        // nowhere -- the message is the whole answer, and moving the athlete
        // off the screen they pressed it on would bury it.
        setActiveTab(floorLockedPendingCheckIn ? 'bio-checkin' : 'athlete-floor');
        setBackendSyncMessage(floorLockedPendingCheckIn
          ? 'You are checked in. Do your wellness check next -- it opens your floor.'
          : "You are checked in. Your coach's work is on your floor.");
        // Accepted — two notes rising a fifth. It confirms the line above; it
        // never carries anything that line does not.
        play('accept');
        // The card gains an open box for the session just started. Without
        // this it still showed yesterday's card until the next page load.
        void loadTrainingCard();
      } else {
        const payload = (await sessionResponse.json().catch(() => ({ error: 'That check-in did not take.' }))) as { error?: string };
        setBackendSyncMessage(`${payload.error || 'That check-in did not take.'} `
          + "Nothing was saved, so there is no session to check out of. Tell a coach you are here.");
      }
    } catch (error) {
      setBackendSyncMessage(`${error instanceof Error ? error.message : 'That check-in did not take.'} `
        + "Nothing was saved, so there is no session to check out of. Tell a coach you are here.");
    } finally {
      setIsCheckingIn(false);
    }

    // Nothing is sent to SHADOW here any more. Check-in used to post the
    // readiness slider as `session_rpe` and the planned-duration box as
    // `duration` -- two pre-session numbers submitted as observations of a
    // session that had not started. Both now come from check-out, from what
    // the athlete actually reports afterwards.
  };

  const handleCheckOut = async () => {
    // Only ever reachable with a stored session behind it, so there is no
    // longer a path where check-out is offered and the notes go nowhere.
    if (!activeSessionRecord || isCheckingOut) {
      return;
    }

    const record = activeSessionRecord;
    const now = new Date();
    const notes = checkInNotes.trim();
    // Read once, so the value and its method cannot disagree in the body.
    const rpe = answeredEffort;

    setIsCheckingOut(true);

    try {
      const response = await fetch(`${apiBase()}/api/pilot/sessions/update`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: record.sessionId,
          athlete_id: record.athleteId,
          date: record.date,
          // Check-out is the first and only point at which a session RPE can
          // exist, and the athlete's own answer to the effort question is its
          // only source. Answered: that number, attributed to the athlete's
          // post-session self-report. Unanswered: null with an UNKNOWN method,
          // "not recorded" -- never a default. The test is `=== null`, not
          // truthiness, because 0 is a real answer. The stored record.rpe is
          // deliberately NOT a fallback: on a pre-migration row it holds the
          // readiness slider, and promoting it here is the old defect.
          rpe,
          rpe_method: rpe === null ? ('UNKNOWN' as const) : ('athlete_post_session_self_report' as const),
          // The check-in note is the fallback because the session record
          // requires a note and an empty box must not erase what check-in
          // already stored.
          notes: notes || record.checkInNote,
          completed_flag: true,
          created_at: record.createdAt,
          updated_at: now.toISOString(),
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || '');
      }

      setActiveSessionRecord(null);
      setCheckInNotes('');
      setNotesSaveState('idle');
      // Cleared only now, after the server took it -- a refused check-out
      // keeps the answer on screen for the retry (see the catch below).
      setPostSessionEffort(null);
      const effortLine = rpe === null ? '' : ` Your effort, ${rpe} of 10, is on it too.`;
      setBackendSyncMessage((notes
        ? "Logged. What you wrote is on the session for your coach to read."
        : "Logged. That one is on your card.") + effortLine);
      // Re-read rather than trust the write: the recent list below and the
      // "are you still checked in" question are both answered from the server.
      await loadStoredSessions();
      // And the card, which is where a completed session actually lands. This
      // was missing, so the count only moved on the next page load — which is
      // also why crossing a milestone could never produce a moment: the card
      // was never looking when it happened.
      await loadTrainingCard();
    } catch (error) {
      // Nothing is cleared on a failure. The session is still open, and the
      // notes and the effort answer are still on screen, so the athlete can
      // try again instead of watching the screen empty itself.
      const detail = error instanceof Error && error.message ? `: ${error.message}` : '.';
      setBackendSyncMessage(
        `That did not take and you are still checked in${detail} `
        + "Hit Check Out again, and tell a coach anything they need to know.",
      );
    } finally {
      setIsCheckingOut(false);
    }

    /* No Session Load feed here. It used to sit at the end of check-IN and pass
       the readiness slider as `session_rpe` and the PLANNED duration as
       `duration`, so SHADOW multiplied two numbers that had measured nothing
       yet. Check-out can now carry a real post-session RPE, but Session Load
       is RPE x OBSERVED duration and nothing collects a duration, so it still
       sends nothing: check-out records only what the athlete actually
       supplied, on the session itself. */
  };

  const handleSavePainReport = async () => {
    if (!selectedPainLocation) {
      return;
    }

    const now = new Date();
    const newPainLogEntry: PainLogEntry = {
      id: `pain_${Date.now()}`,
      location: selectedPainLocation,
      type: currentPainType,
      severity: currentPainSeverity,
      capturedAt: now.toISOString(),
    };

    setIsSavingPain(true);
    setPainSaveMessage('');

    try {
      /* NOTHING IS RECORDED UNTIL THE SERVER SAYS SO. These three state
         writes used to sit here, before the guard and the fetch, and the
         catch below never reverted them -- so a FAILED save still lit the
         "Pain reported this session. A coach has been told." indicator and
         the "Last report:" line, directly above the honest failure message.
         On a safety card the optimistic line wins: a child who reads "a
         coach has been told" stops looking for another way to tell someone.
         The local record now follows the server's answer, never precedes
         it. */
      if (!backendAthleteId) {
        // Nothing outside this browser tab holds a pain report, so a missing
        // session means it reached no one at all.
        setPainSaveMessage('Pain report was not saved and no coach was told. Sign in again and report it, '
          + 'and tell a coach in person.');
        return;
      }

      const response = await fetch(`${apiBase()}/api/pilot/shadow/formulas/observations`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athleteId: backendAthleteId,
          contextId: newPainLogEntry.id,
          kind: 'pain_report',
          value: currentPainSeverity,
          unit: 'severity_1_10',
          dimensions: {
            location: selectedPainLocation,
            painType: currentPainType,
            injuryFlag: true,
          },
          observedAt: now.toISOString(),
          idempotencyKey: `${newPainLogEntry.id}-pain_report`,
        }),
      });

      if (!response.ok) {
        throw new Error('Pain report was not saved and no coach was told. Report it again, '
          + 'and tell a coach in person.');
      }

      const payload = (await response.json().catch(() => ({}))) as {
        painReport?: { coachNotified?: boolean };
      };

      setPainLog((current) => [newPainLogEntry, ...current]);
      setInjuryFlag(true);
      /* `setSoreness((current) => Math.max(current, currentPainSeverity))`
         stood here and is deliberately NOT carried forward.

         It raised the Bio Check-In soreness slider to match a pain report.
         That was harmless while the slider persisted nothing. It is not
         harmless now: soreness is a stored 1-5 SELF-report, and this would
         write a number the athlete never chose into their own account of how
         they feel -- from a 1-10 severity scale into a 1-5 one, on a record
         the check-in API deliberately makes one-per-day and does not update.
         A pain report and a wellness self-report are different claims by
         different rules; the pain report already has its own escalating path
         above, which is where that severity belongs. */

      setPainSaveMessage(payload.painReport?.coachNotified
        ? 'Logged, and flagged for a coach to look at.'
        : 'Logged on your record. No coach was flagged for it, so tell one in person.');

      setShowPainModal(false);
    } catch (error) {
      setPainSaveMessage(error instanceof Error
        ? error.message
        : 'That pain report did not save. Report it again, and tell a coach in person.');
    } finally {
      setIsSavingPain(false);
    }
  };

  const handleSendCoachMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const message = coachMessageBody.trim();
    if (!message) {
      setCoachMessageStatus('Write a message before sending.');
      return;
    }

    setIsSendingCoachMessage(true);
    setCoachMessageStatus('');

    try {
      const response = await fetch(`${apiBase()}/api/pilot/athlete/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // 'individual_support' is not one of the session types the canonical
        // chat validator accepts, and an unrecognized sessionType is rejected
        // outright rather than ignored -- so this form answered 400 ("Enter a
        // question for SHADOW.") on every submission and the success message
        // below was unreachable. Omitting it lets the request classify normally.
        body: JSON.stringify({
          message,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ error: 'That message did not send. Try it again.' }))) as { error?: string };
        throw new Error(payload.error || 'That message did not send. Try it again.');
      }

      setCoachMessageBody('');
      // The old copy promised a coach reply. This posts to SHADOW, not to a
      // person: it is recorded in the athlete's own conversation and answered
      // by SHADOW. No coach is notified and none ever sees it, so saying so
      // would be a promise the system does not keep.
      //
      // The coach's name is gone from this string along with the picker that
      // produced it. Naming a person beside "saved" invited exactly the reading
      // the rest of this copy spends its time denying.
      setCoachMessageStatus(
        'Saved to your SHADOW conversation. SHADOW answers there -- open SHADOW Chat to read it. No coach is notified.',
      );
    } catch (error) {
      setCoachMessageStatus(error instanceof Error ? error.message : 'That message did not send. Try it again.');
    } finally {
      setIsSendingCoachMessage(false);
    }
  };

  const painLocations = ['Neck', 'Shoulders', 'Upper back', 'Lower back', 'Core', 'Hips', 'Quads', 'Hamstrings', 'Calves', 'Hands/Wrists'];
  const suggestedQuestions = [
    'What workout is scheduled for today?',
    'Why is my readiness score low?',
    'What SMART goal am I working on this week?',
    'Do I have any outstanding tasks?',
    'What does soreness score mean for my training?'
  ];

  return (
    /* Gym-floor kiosk surface: ink ground with the floor room's brick wall
       (PAGE_MAP), the same room pattern /schedule uses. Law 5 applies to
       everything inside — targets at var(--tap), working type at var(--t-md). */
    <div className="room room--floor min-h-screen rounded-[var(--r-lg)] bg-[var(--hide-950)] text-[color:var(--bone-200)] font-sans">
      <div className="max-w-7xl mx-auto p-[var(--s4)] space-y-[var(--s6)]">
        {/* HEADER */}
        <div className="border-b-2 border-[color:var(--brass-700)] pb-[var(--s5)] space-y-[var(--s4)]">
          <div>
            {/* Coach in the corner, not a product manager. "Athlete
                Development Workspace" and "execute daily work... achieve SMART
                goals" is the voice of a spec, on the one screen a kid thinks
                of as theirs. Same information, said the way it would be said
                across the floor. */}
            <p className="t-eyebrow">Your Floor</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-2xl)' }}>{activeGroupLabel}</h1>
            <p className="t-label mt-[var(--s3)] text-[color:var(--bone-400)]">
              Athlete workspace · {activeTabLabel}
            </p>
            {/* The standing description of the workspace, kept on Today only.
                Under "SHADOW" or "Messages" it would be describing a screen
                the athlete is not looking at. */}
            {activeGroup === 'today' && (
              <p className="mt-[var(--s3)] text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">Say how you feel, do today&apos;s work, and keep your goals where you can see them.</p>
            )}
            {/* The motto strip is gone from here, from the coach workspace, from
                the parent hub and from the funding centre -- the same six words
                at --t-xs, four times, always directly above the fold.

                It is the gym's voice, and the gym already has one on this page:
                the chalkboard, a few hundred pixels down, where a person writes
                a line by hand and rubs it out when they feel like it. A motto
                hardcoded into four component headers is not that. Law 5 also
                asks for 19.1px on anything an athlete reads on the floor, and
                this was rendering at roughly half of it. */}
          </div>
        </div>

        {/* The athlete's own fight card. Self-contained: it fetches its own
            data and renders nothing until it has some, so this is the single
            insertion the profile layer makes into this file. */}
        <ProfileHeader />

        {/* #82: an active training hold, in the athlete's own language.
            Same self-contained contract as ProfileHeader -- renders nothing
            when there is no hold. */}
        <TrainingHoldBanner />

        {/* Notices are posted paper on the leather wall. */}
        <AnnouncementBanner
          placement="athlete_workspace"
          kind="notice"
          heading="Gym Notices"
          className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)]"
        />

        {/* The chalkboard REPLACES the paper "From the Gym" card that used to
            sit here. Same table, same placement, same kind ('motivation') --
            what changed is the object. A line somebody wrote by hand was being
            rendered as a clean UI card with a heading on it; it is slate and
            chalk now, and it shows one line rather than a list, because that is
            what a board by the door holds. See Chalkboard.tsx. */}
        <Chalkboard placement="athlete_workspace" />

        {/* The role summary, the training card, achievements, "Off the
            screen", and "What's Coming" all moved to the foot of the
            page, below the tab content -- same reasoning already applied to
            the gym wall (see its comment below): these are ambient/summary
            content, not something an athlete opens this dashboard to act on,
            and they used to sit between the header and Quick Actions, pushing
            Quick Actions -- including Check-In -- below the fold. */}

        {/* GROUP NAVIGATION — floor-sized targets (Law 5), two levels.
            Six groups an athlete can hold in their head, each opening onto the
            surfaces it owns. A group with one surface has no second row: there
            is nothing to choose between, so nothing is drawn. */}
        <div className="mat-leather rounded-[var(--r-md)]">
          <div className="flex flex-wrap gap-[var(--s2)] p-[var(--s3)]">
            {TAB_GROUPS.map(group => (
              <button
                key={group.id}
                onClick={() => setActiveTab(openingTabFor(group.id))}
                aria-current={activeGroup === group.id ? 'page' : undefined}
                className={cx(
                  KIOSK_TAB_BASE,
                  activeGroup === group.id ? KIOSK_TAB_ACTIVE : KIOSK_TAB_INACTIVE,
                )}
              >
                {group.label}
              </button>
            ))}
          </div>

          {/* Second row: the surfaces inside the open group. */}
          {activeGroupTabs.length > 1 && (
            <div className="flex flex-wrap items-center gap-[var(--s2)] border-t border-[color:var(--hide-800)] px-[var(--s3)] pb-[var(--s3)] pt-[var(--s2)]">
              {activeGroupTabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  aria-current={activeTab === tab.id ? 'page' : undefined}
                  className={cx(
                    KIOSK_TAB_BASE,
                    activeTab === tab.id ? KIOSK_TAB_ACTIVE : KIOSK_TAB_INACTIVE,
                  )}
                >
                  {tab.label}
                </button>
              ))}

              {/* The check-in gateway, and the reason Today leads with it.
                  This is a statement of fact about the athlete's own record,
                  not a lock: every group above stays reachable whether or not
                  they have checked in. Gating a minor's access to their own
                  data behind a daily action would be compulsion, which the
                  engagement direction forbids outright. So Today OPENS on
                  check-in until it is done, and says so plainly -- nothing
                  more. */}
              {activeGroup === 'today' && (
                <p className="t-label ml-[var(--s2)] text-[color:var(--bone-400)]">
                  {checkInTime ? `Checked in ${checkInTime}` : 'Not checked in yet'}
                </p>
              )}
            </div>
          )}
        </div>

        {/* TAB CONTENT */}
        <div className="space-y-6">
          {/* MY DASHBOARD */}
          {activeTab === 'my-dashboard' && (
            <div className="space-y-6 panel-settle">
              {/* The before/after frame from the Phase 2 roadmap, built from
                  the record rather than photographs -- see ThenAndNow.tsx for
                  why photographs cannot do this here. Renders nothing until
                  the athlete's identity resolves and history exists. */}
              <ThenAndNow athleteId={backendAthleteId} />

              {/* TODAY.
                  This was a flat row of five identical buttons, which asked the
                  athlete to already know what needed doing. It states the day
                  back to them instead: what is true right now, and the one
                  action each fact implies.

                  Every line here is a read of state this component already
                  holds. Nothing is counted that was not recorded, and an empty
                  collection says so in words rather than showing a 0 -- "none
                  recorded" and "zero" are different claims, and only one of
                  them is true before anything has happened. */}
              <section className={PANEL}>
                <h3 className="t-label">Today</h3>
                <div className="mt-[var(--s4)] grid gap-[var(--s3)] md:grid-cols-3">
                  <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)] space-y-[var(--s3)]">
                    <p className="t-label">Check in</p>
                    <p className="t-body text-[color:var(--bone-300)]">
                      {checkInTime ? `Checked in ${checkInTime}.` : 'You have not checked in today.'}
                    </p>
                    {/* This calls the same handler as the Session Log's own
                        button rather than navigating somewhere -- checking in
                        is one tap from the first thing an athlete sees, and
                        both controls stay one behaviour because they are one
                        handler. */}
                    {activeSessionRecord ? null : (
                      <button
                        type="button"
                        onClick={() => void handleCheckIn()}
                        disabled={isCheckingIn}
                        className="btn btn--kiosk w-full disabled:opacity-50 disabled:grayscale"
                      >
                        {isCheckingIn ? 'Checking in...' : 'Start check-in'}
                      </button>
                    )}
                  </div>

                  <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)] space-y-[var(--s3)]">
                    <p className="t-label">Your goals</p>
                    <p className="t-body text-[color:var(--bone-300)]">
                      {goalsError
                        ? 'Not available right now.'
                        : goalsLoading
                          ? 'Checking...'
                          : goalsActive === 0
                            ? 'No active goals recorded.'
                            : `${goalsActive} active.`}
                    </p>
                    <button
                      type="button"
                      onClick={() => setActiveTab('smart-goals')}
                      className="btn btn--kiosk btn--ghost w-full"
                    >
                      Open goals
                    </button>
                  </div>

                  {/* The one card on Today that is not about what the athlete
                      decided: what a coach assigned them. It opens the Floor,
                      which lists that work -- until A-FIN-04 the Floor held a
                      plan generated at check-in instead, and the coach's work
                      was reachable only from a page this card linked away to.

                      Same grammar as its siblings: an empty collection says
                      "none recorded" rather than showing a 0, and a read that
                      failed says so instead of reporting nothing assigned. */}
                  <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)] space-y-[var(--s3)]">
                    <p className="t-label">From your coach</p>
                    <p className="t-body text-[color:var(--bone-300)]">
                      {assignedWorkError
                        ? 'Not available right now.'
                        : assignedWorkLoading
                          ? 'Checking...'
                          : openCoachWork.length === 0
                            ? 'No assigned work recorded.'
                            : `${openCoachWork.length} still to do.`}
                    </p>
                    <button
                      type="button"
                      onClick={() => setActiveTab('athlete-floor')}
                      className="btn btn--kiosk btn--ghost w-full"
                    >
                      Open the floor
                    </button>
                  </div>
                </div>

                <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
                  <Link href="/schedule" className="btn btn--kiosk btn--ghost">
                    Open Scheduler
                  </Link>
                  <button
                    type="button"
                    onClick={() => setActiveTab('shadow')}
                    className="btn btn--kiosk btn--ghost"
                  >
                    Ask SHADOW
                  </button>
                </div>
              </section>

              {/* This help copy predated #597 and kept promising what #597
                  removed: it told the athlete to "check your readiness status"
                  as if the slider were a gate, warned against "ignoring LOW
                  readiness scores before intense training" when no reading
                  gates anything, and sent them to "complete biological
                  check-in" -- a surface deliberately unreachable because it
                  persists nothing (see the TAB_GROUPS note at the top of this
                  file). Instructions may only name things this screen actually
                  does. */}
              <HelpPanel
                title="My Dashboard"
                description="Your daily command center. Say how you feel, check in, see assigned work, and monitor your progress toward goals."
                usage={[
                  'Check in to open your session',
                  'See how much work your coach has assigned you',
                  'Monitor active SMART goals',
                  'Note any pain or injury concerns'
                ]}
                mistakes={[
                  'Not reporting pain to your coach',
                  'Skipping the check-in process',
                  'Assuming academic status is still current'
                ]}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--s5)]">
                {/* Self-report card. Headed "Current Readiness" over a
                    "Readiness to Train" slider until 2026-08-24 -- vocabulary
                    from when this number decided the generated work. #597
                    ended that authority (an unvalidated self-report may be
                    recorded, never prescribe), so the card now presents the
                    slider as what it is: the athlete saying how they feel,
                    written on their session, deciding nothing. The band and
                    the stored note format are untouched; only what is said to
                    the athlete changed. */}
                <div className={PANEL_RAISED}>
                  <h3 className="t-label mb-[var(--s4)]">Pre-Session Self-Report</h3>
                  <div className="space-y-[var(--s4)]">
                    {/* Sleep and Energy Level stood here until 2026-08-23 and
                        recorded nothing: neither reached any request body, on
                        check-in or anywhere else. Removed rather than stamped,
                        the way the guardian consent prototype was: a control
                        that silently discards what it asks for is worse than
                        no control.

                        Session Duration followed on 2026-08-25. When Sleep and
                        Energy went it still wrote -- check-in posted it to
                        SHADOW as an observed `duration`, which is how a
                        PLANNED 60 minutes became an observed one -- but the
                        same rework that ended that (see the check-out handler)
                        left the box standing, asking a child for a number no
                        code read. Wiring any of these is a real option and a
                        separate decision -- it needs an owner call on what the
                        reading would mean and who, if anyone, it should
                        reach. */}
                    <div>
                      <label className="t-label block mb-[var(--s3)]" htmlFor="readiness-train">How ready do you feel today? (1-10)</label>
                      <input id="readiness-train" type="range" min="1" max="10" value={readinessToTrain} onChange={(e) => setReadinessToTrain(Number.parseInt(e.target.value, 10))} className="range--kiosk cursor-pointer" />
                      <p className="t-data mt-[var(--s1)]" style={{ fontSize: 'var(--t-sm)' }}>{readinessToTrain}/10</p>
                      {/* Said here, at the control, not in a help panel: the
                          number is a subjective self-report. It is recorded on
                          the session at check-in and that is all it does. The
                          sentence is the owner's (2026-08-24). */}
                      <p className="mt-[var(--s2)] text-[length:var(--t-sm)] leading-relaxed text-[color:var(--bone-300)]">
                        This records how you say you feel before training.
                        It does not medically clear you and does not determine your workout.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Pain/Injury Card */}
                <div className={PANEL_RAISED}>
                  <h3 className="t-label mb-[var(--s4)]">Pain/Soreness Report</h3>
                  <div className="space-y-[var(--s4)]">
                    {/* THIS WAS A TICKBOX, AND TICKING IT DID NOTHING.

                        The flag is written in one place -- setInjuryFlag(true)
                        when a pain report is filed -- so as an INDICATOR it
                        tells the truth. As a CONTROL it did not: an athlete
                        could tick it by hand, and that hand-set value reached
                        nobody. Its only transport was a dimension on the
                        check-in `session_rpe` observation, and that observation
                        was the readiness slider mislabelled as session RPE.
                        Removing the fabricated measurement removed the
                        transport with it.

                        So the affordance is gone and the signal is kept. A
                        control that silently records nothing on a safety card
                        is worse than no control: an athlete who ticks it stops
                        looking for another way to tell someone. Re-wiring it
                        onto a measurement observation is what produced this in
                        the first place and is not done here; giving it a signal
                        of its own would be a separate safety change.

                        A Soreness Level slider stood here too. It never
                        recorded anything and is not reinstated.

                        The pain report below -- location, type, severity -- is
                        the path that actually reaches a coach. It raises a near
                        miss and a pending-review shadow event, and it says so
                        in plain words when it fails. */}
                    {injuryFlag ? (
                      <p className="text-[length:var(--t-md)]" data-testid="pain-reported-indicator">
                        Pain reported this session. A coach has been told.
                      </p>
                    ) : null}
                    {/* All 10 locations, not just the first 3 -- a dropdown
                        scales to the list where a row of buttons did not, and
                        the other 7 were previously unreachable from this
                        screen entirely. */}
                    <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-[var(--s3)] pt-[var(--s2)] items-end">
                      <div className="field">
                        <label className="t-label block mb-[var(--s2)]" htmlFor="pain-location-select">Body location</label>
                        <select
                          id="pain-location-select"
                          value={selectedPainLocation ?? ''}
                          onChange={(e) => setSelectedPainLocation(e.target.value || null)}
                          className="select input--kiosk"
                        >
                          <option value="">Select a location...</option>
                          {painLocations.map(loc => (
                            <option key={loc} value={loc}>{loc}</option>
                          ))}
                        </select>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowPainModal(true)}
                        disabled={!selectedPainLocation}
                        className="btn btn--ghost min-h-[var(--tap)] px-[var(--s3)] disabled:opacity-50 disabled:grayscale"
                      >
                        Report Pain
                      </button>
                    </div>
                    {painSaveMessage ? (
                      <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-200)]" role="status">{painSaveMessage}</p>
                    ) : null}
                    {painLog[0] ? (
                      <p className="t-muted">
                        Last report: {painLog[0].location} ({painLog[0].type}, {painLog[0].severity}/10)
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Session Check-In/Out. The open session comes from the server
                  on every load, so a reload, a new tab, or a different device
                  all find the same session still open. */}
              <div className={`${PANEL_RAISED} space-y-[var(--s4)]`}>
                <h3 className="t-label">Session Log</h3>

                {athleteIdentityState === 'loading' ? (
                  <span className="working">Checking your sign-in...</span>
                ) : athleteIdentityState === 'unavailable' ? (
                  <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
                    You are not signed in as an athlete right now, so a session cannot be started or saved here.
                    Sign in again, and tell a coach you are on the floor.
                  </p>
                ) : storedSessionLoad === 'loading' ? (
                  <span className="working">Checking whether you are still checked in...</span>
                ) : storedSessionLoad === 'unavailable' ? (
                  <div className="space-y-[var(--s4)]">
                    <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
                      Your sessions could not be read, so nobody can tell right now whether you are already checked in.
                      That is a problem reaching the app, not a sign that you have no session open.
                    </p>
                    <button
                      type="button"
                      onClick={() => void loadStoredSessions()}
                      className="btn btn--kiosk btn--ghost"
                    >
                      Try Again
                    </button>
                  </div>
                ) : activeSessionRecord ? (
                  <div className="space-y-[var(--s4)]">
                    <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">Session active since {checkInTime}</p>
                    <textarea
                      value={checkInNotes}
                      onChange={(e) => setCheckInNotes(e.target.value)}
                      placeholder="Session notes for your coach..."
                      aria-label="Session notes for your coach"
                      className="textarea input--kiosk h-[89px]"
                    />
                    <p className="text-[length:var(--t-sm)] text-[color:var(--bone-300)]" role="status">
                      {notesSaveState === 'failed'
                        ? 'Your notes are not saved yet -- this screen could not reach your session. Keep the tab open and keep writing; it will keep trying.'
                        : notesSaveState === 'saving'
                          ? 'Saving your notes...'
                          : notesStored
                            ? 'Saved. What you wrote stays put, even if this tab closes.'
                            : notesDraft
                              ? 'Not saved yet.'
                              : 'Anything you write here saves as you go.'}
                    </p>
                    {/* POST-SESSION EFFORT (A-FIN-05). Eleven described choices
                        rather than a slider, for the reason the Wellness panel
                        gives: a range input always has a position, so it
                        records an answer nobody gave. Nothing is selected until
                        the athlete selects it, skipping is said out loud, and
                        only Check Out writes it -- the notes draft save above
                        never carries it. */}
                    <fieldset className="space-y-[var(--s2)]">
                      <legend className="t-label mb-[var(--s2)]">{POST_SESSION_EFFORT_QUESTION}</legend>
                      <p style={{ fontSize: 'var(--t-sm)', color: 'var(--bone-400)' }}>
                        0 is rest, 10 is the hardest you could go. It goes on the session when you check out.
                      </p>
                      <div className="grid grid-cols-3 sm:grid-cols-6 gap-[var(--s2)]">
                        {POST_SESSION_EFFORT_SCALE.map(({ value, anchor }) => {
                          const selected = answeredEffort === value;
                          return (
                            <button
                              key={value}
                              type="button"
                              aria-label={anchor
                                ? `${POST_SESSION_EFFORT_QUESTION} ${value}: ${anchor}`
                                : `${POST_SESSION_EFFORT_QUESTION} ${value}`}
                              aria-pressed={selected}
                              disabled={isCheckingOut}
                              onClick={() => setPostSessionEffort({ sessionId: activeSessionRecord.sessionId, value })}
                              className={`btn btn--kiosk ${selected ? '' : 'btn--ghost'} text-left`}
                            >
                              <span className="t-data block" style={{ fontSize: 'var(--t-sm)' }}>{value}</span>
                              {anchor ? <span className="block" style={{ fontSize: 'var(--t-sm)' }}>{anchor}</span> : null}
                            </button>
                          );
                        })}
                      </div>
                      {answeredEffort === null ? (
                        <p style={{ fontSize: 'var(--t-sm)', color: 'var(--bone-400)' }}>
                          Not answered — you can skip this. Checking out without it records no effort.
                        </p>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPostSessionEffort(null)}
                          disabled={isCheckingOut}
                          className="btn btn--ghost"
                        >
                          Clear my answer
                        </button>
                      )}
                    </fieldset>
                    <button
                      type="button"
                      onClick={() => void handleCheckOut()}
                      disabled={isCheckingOut}
                      className="btn btn--kiosk disabled:opacity-50 disabled:grayscale"
                    >
                      {isCheckingOut ? 'Checking out...' : 'Check Out'}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-[var(--s4)]">
                    <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">You are not checked in right now.</p>
                    <button
                      type="button"
                      onClick={() => void handleCheckIn()}
                      disabled={isCheckingIn}
                      className="btn btn--kiosk disabled:opacity-50 disabled:grayscale"
                    >
                      {isCheckingIn ? 'Checking in...' : 'Check In'}
                    </button>
                  </div>
                )}

                {/* Read back from the server, so "my notes were saved" is
                    something the athlete can see rather than be told. */}
                {storedSessionLoad === 'loaded' && recentSessions.length > 0 ? (
                  <div className="space-y-[var(--s3)] border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s4)]">
                    <p className="t-label">
                      Your Last Sessions
                    </p>
                    <ul className="space-y-[var(--s3)]">
                      {recentSessions.map((session) => (
                        <li key={session.sessionId} className="text-[length:var(--t-sm)] text-[color:var(--bone-300)]">
                          <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>{session.date}</span>
                          {' - '}
                          {AUTO_CHECK_IN_NOTE_PATTERN.test(session.notes)
                            ? 'No notes on this one.'
                            : session.notes}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </div>
          )}

          {/* ATHLETE FLOOR -- gated on today's check-in, and only this. */}
          {activeTab === 'athlete-floor' && floorLockedPendingCheckIn && (
            <div className="space-y-6 panel-settle">
              <div className={`${PANEL_RAISED} space-y-[var(--s4)]`}>
                <h3 className="t-label">Check in first</h3>
                <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
                  Your work for today opens once you have checked in. It takes a few
                  seconds, and every question is optional.
                </p>
                <button
                  type="button"
                  onClick={() => setActiveTab('bio-checkin')}
                  className="btn btn--kiosk"
                >
                  Go to check in
                </button>
                <p style={{ fontSize: 'var(--t-sm)', color: 'var(--bone-400)' }}>
                  Everything else stays open — goals, drills, messages, and telling a
                  coach about pain.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'athlete-floor' && !floorLockedPendingCheckIn && (
            <div className="space-y-6 panel-settle">
              <HelpPanel
                title="Athlete Floor"
                description="The work your coach assigned you that is still open. Open a drill to read how it is done, and log it once you have done it."
                usage={[
                  'See every piece of open work your coach assigned',
                  'Open a drill to read how it is done -- reading it records nothing',
                  'Log completion when you have done the work',
                  'Check the due date your coach set'
                ]}
                mistakes={[
                  'Finishing work and not logging it, so your coach cannot see it',
                  'Missing a due date by not checking the floor'
                ]}
              />

              {assignedWorkLoading && (
                <div className={`${PANEL} text-center`}>
                  <span className="working">Loading your coach&apos;s work...</span>
                </div>
              )}

              {/* A failed read is never drawn as an empty floor: "nobody has
                  assigned you anything" is a claim about a coach, and a
                  network failure is not evidence for it. */}
              {assignedWorkError && !assignedWorkLoading && (
                <div className="alert alert--critical" role="alert">
                  <span className="alert-icon" aria-hidden="true">✕</span>
                  <div className="alert-body">
                    <p className="alert-title">Could not load your coach&apos;s work</p>
                    <p className="alert-msg">{assignedWorkError}</p>
                    <div className="alert-action">
                      <button
                        onClick={() => void loadAssignedWork()}
                        className="btn btn--ghost min-h-[var(--tap)]"
                        aria-label="Retry loading your coach's work"
                      >
                        Retry
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* One card per open assignment, in the order the API returned
                  them. Every figure is the coach's, drawn only when they set
                  it -- an absent dose is left absent, never filled with a
                  default that would read as an instruction.

                  The two actions are LINKS to the Progression page's own
                  controls, not copies of them (see the deep-link there): one
                  drill opener, one log form, one place a completion is
                  written. Open drill writes nothing; Log completion opens the
                  form, and only its Save writes. */}
              {!assignedWorkLoading && !assignedWorkError && openCoachWork.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--s4)]">
                  {openCoachWork.map((work) => {
                    const name = work.drill_display_name || work.drill_name;
                    return (
                      <div key={work.assignment_id} className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s4)] space-y-[var(--s4)]">
                        <div className="flex items-start justify-between gap-[var(--s4)]">
                          <h4 className="text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">{name}</h4>
                          <span className="t-label">{work.status.replaceAll('_', ' ')}</span>
                        </div>
                        <dl className="grid grid-cols-2 gap-[var(--s3)] text-[length:var(--t-sm)]">
                          {work.rep_count != null && (
                            <div>
                              <dt className="t-label">Reps</dt>
                              <dd className="t-data mt-[var(--s2)]">{work.rep_count}</dd>
                            </div>
                          )}
                          {work.duration_minutes != null && (
                            <div>
                              <dt className="t-label">Duration</dt>
                              <dd className="t-data mt-[var(--s2)]">{work.duration_minutes} min</dd>
                            </div>
                          )}
                          {work.frequency_per_week != null && (
                            <div>
                              <dt className="t-label">Frequency</dt>
                              <dd className="t-data mt-[var(--s2)]">{work.frequency_per_week}x/week</dd>
                            </div>
                          )}
                          {work.due_date && (
                            <div>
                              <dt className="t-label">Due</dt>
                              <dd className="t-data mt-[var(--s2)]">{formatCalendarDay(work.due_date)}</dd>
                            </div>
                          )}
                        </dl>
                        <div className="flex flex-wrap gap-[var(--s3)]">
                          {work.drill_id ? (
                            <Link
                              href={progressionLink(work.assignment_id, 'instruction')}
                              aria-label={`Open drill: ${name}`}
                              className="btn btn--kiosk btn--ghost"
                            >
                              Open drill
                            </Link>
                          ) : null}
                          <Link
                            href={progressionLink(work.assignment_id, 'log')}
                            aria-label={`Log completion: ${name}`}
                            className="btn btn--kiosk"
                          >
                            Log completion
                          </Link>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* AN EMPTY FLOOR IS THE HERO, not a footnote. On the day an
                  athlete opens this tab to nothing, this IS the screen. It
                  says the true thing -- no coach has assigned open work -- and
                  offers nothing to press that would pretend otherwise. It used
                  to promise that checking in would build the day's work, and
                  checking in no longer builds anything. */}
              {!assignedWorkLoading && !assignedWorkError && openCoachWork.length === 0 && (
                <div className={`${PANEL} px-[var(--s5)] py-[var(--s7)] text-center`}>
                  <span
                    aria-hidden="true"
                    className="mx-auto grid h-[var(--s7)] w-[var(--s7)] place-items-center rounded-full border-2 border-[color:var(--brass-600)] text-[color:var(--brass-300)]"
                    style={{ fontSize: 'var(--t-lg)' }}
                  >
                    ☑
                  </span>
                  <h3 className="t-command mt-[var(--s5)]" style={{ fontSize: 'var(--t-xl)' }}>
                    No open work from your coach.
                  </h3>
                  <p className="mt-[var(--s3)] text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
                    When a coach assigns you a drill, it shows up here.
                  </p>
                </div>
              )}

              {/* The richer record -- finished work, completion history, what
                  each drill was assigned for -- stays on the Progression page. */}
              <Link href="/athlete/progression-intelligence" className="btn btn--kiosk btn--ghost">
                Open your progression
              </Link>
            </div>
          )}

          {/* SMART GOALS */}
          {activeTab === 'smart-goals' && (
            <div className="space-y-6 panel-settle">
              <div className="flex justify-between items-start">
                <HelpPanel
                  title="SMART Goals"
                  description="Create and track measurable goals using SMART framework. Monitor progress and connect workouts/tasks."
                  usage={[
                    'Create specific, measurable goals',
                    'Set realistic target dates',
                    'Track progress regularly',
                    'Link workouts and tasks to goals'
                  ]}
                  mistakes={[
                    'Vague goals without specific metrics',
                    'Unrealistic timeframes',
                    'Not reviewing progress weekly'
                  ]}
                />
              </div>

              {/* YOUR OWN WORDS FIRST, THE SMART FORM SECOND.
                  The form below asks for a category from a picklist of boxing
                  metrics, a deadline, and a success metric -- four required
                  fields before somebody is allowed to want something. "Show up
                  on the days I don't want to" cannot be typed into it. This
                  board asks for a sentence, and it extends the same pilot.goals
                  table rather than replacing it, so the measurable conditioning
                  target a coach wants still has its form. */}
              <PersonalGoalBoard athleteId={backendAthleteId} />

              <button
                onClick={() => setShowGoalForm(!showGoalForm)}
                className="btn min-h-[var(--tap)]"
              >
                + New SMART Goal
              </button>

              {showGoalForm && (
                <div className={`${PANEL_RAISED} space-y-[var(--s4)]`}>
                  <h3 className="t-label">Create SMART Goal</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--s4)]">
                    <input
                      type="text"
                      value={newGoalTitle}
                      onChange={(e) => setNewGoalTitle(e.target.value)}
                      placeholder="Goal title"
                      aria-label="Goal title"
                      className="input input--kiosk"
                    />
                    <select
                      value={newGoalCategory}
                      onChange={(e) => setNewGoalCategory(e.target.value as SMARTCategory)}
                      aria-label="Goal category"
                      className="select input--kiosk"
                    >
                      {SMART_GOAL_CATEGORIES.map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                    <input
                      type="date"
                      value={newGoalTargetDate}
                      onChange={(e) => setNewGoalTargetDate(e.target.value)}
                      aria-label="Goal target date"
                      className="input input--kiosk"
                    />
                    <input
                      type="text"
                      value={newGoalSuccessMetric}
                      onChange={(e) => setNewGoalSuccessMetric(e.target.value)}
                      placeholder="Success metric"
                      aria-label="Success metric"
                      className="input input--kiosk"
                    />
                  </div>
                  {/* Kept from when these two categories were withheld, and now
                      shown only when one is chosen. The categories are real
                      choices since 2026-08-28; the guidance beside them is not
                      deleted, because the owner principle recorded 2026-08-03
                      is that the stop carries the lesson -- and the lesson
                      (a weight goal is built with a coach and a guardian, not
                      set alone) outlived the stop. Unconditional, it would be
                      noise on a jab goal; absent, a minor would file a weight
                      goal with no route to the people who should be in it. */}
                  {WEIGHT_GOAL_CATEGORIES.includes(newGoalCategory) && (
                    <p className="t-muted">
                      Making weight is a plan you build with your coach — bring this to them and
                      they will set it up with your guardian.
                    </p>
                  )}
                  <div className="flex gap-[var(--s3)]">
                    <button
                      onClick={handleCreateGoal}
                      disabled={isCreatingGoal}
                      className="btn btn--kiosk flex-1 disabled:opacity-50 disabled:grayscale"
                    >
                      {isCreatingGoal ? 'Creating...' : 'Create Goal'}
                    </button>
                    <button
                      onClick={() => setShowGoalForm(false)}
                      className="btn btn--kiosk btn--ghost flex-1"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {goalsLoading && (
                <div className={`${PANEL} text-center`}>
                  <span className="working">Loading your goals...</span>
                </div>
              )}

              {goalsError && !goalsLoading && (
                <div className="alert alert--critical" role="alert">
                  <span className="alert-icon" aria-hidden="true">✕</span>
                  <div className="alert-body">
                    <p className="alert-title">Could not load your goals</p>
                    <p className="alert-msg">{goalsError}</p>
                    <div className="alert-action">
                      <button
                        onClick={() => {
                          setGoalsError(null);
                          void loadGoals();
                        }}
                        className="btn btn--ghost min-h-[var(--tap)]"
                        aria-label="Retry loading goals"
                      >
                        Retry
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {!goalsLoading && smartGoals.length === 0 && !goalsError && (
                <div className={`${PANEL} text-center`}>
                  <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">Nothing on the board yet. Put up one goal and we&apos;ll track it.</p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--s4)]">
                {smartGoals.map(goal => {
                  const statusBadge = getGoalStatusBadge(goal.status);
                  return (
                    <div key={goal.id} className={`${PANEL_RAISED} space-y-[var(--s4)]`}>
                      <div className="flex justify-between items-start gap-[var(--s3)]">
                        <div>
                          {/* Goals created before 2026-08-03 carry no category,
                              because there was no column to carry it in. Saying so
                              is honest; the 'Boxing' this used to print was not. */}
                          <span className="t-label mb-[var(--s3)] inline-block rounded-[var(--r-sm)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s2)]">{goal.category ?? 'No category'}</span>
                          <h4 className="text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">{goal.title}</h4>
                        </div>
                        <span className={statusBadge.className}><i>{statusBadge.glyph}</i>{goal.status}</span>
                      </div>
                      <div className="space-y-[var(--s2)]">
                        <div className="flex justify-between">
                          <span className="t-label">Progress</span>
                          <span className="t-data" style={{ fontSize: 'var(--t-sm)' }} data-testid={`goal-progress-value-${goal.id}`}>
                            {goal.progressPercent === null ? 'Not reported yet' : `${goal.progressPercent}%`}
                          </span>
                        </div>
                        {/* No track at all when nothing has been reported. An empty
                            bar and a 0% bar look identical, and one of them is a
                            statement about how the athlete is doing. Progress is
                            chrome — a brass fill, never a status hue. */}
                        {goal.progressPercent !== null && (
                          <div className="h-[8px] w-full rounded-[var(--r-pill)] bg-[rgba(0,0,0,.4)]" data-testid={`goal-progress-bar-${goal.id}`}>
                            <div className="h-full rounded-[var(--r-pill)] bg-[var(--brass-500)]" style={{width: `${goal.progressPercent}%`}}></div>
                          </div>
                        )}
                        <label className="flex items-center gap-[var(--s2)] t-label">
                          <span>Report progress</span>
                          <select
                            value={goal.progressPercent === null ? '' : String(goal.progressPercent)}
                            disabled={savingGoalProgressId === goal.id}
                            onChange={(e) => void handleUpdateGoalProgress(
                              goal.id,
                              e.target.value === '' ? null : Number(e.target.value),
                            )}
                            aria-label={`Report progress for ${goal.title}`}
                            className="select input--kiosk"
                          >
                            <option value="">Not reported yet</option>
                            {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((step) => (
                              <option key={step} value={step}>{step}%</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <p className="text-[length:var(--t-sm)] text-[color:var(--bone-300)]">Target: {goal.targetDate}</p>
                      <p className="t-muted">{goal.successMetric}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ATTEMPTS - BASE-05: the athlete's own log over the training-attempts ledger. */}
          {activeTab === 'attempt-log' && (
            <div className={`${PANEL} space-y-[var(--s4)] panel-settle`}>
              <AthleteAttemptLog athleteId={backendAthleteId} />
            </div>
          )}

          {/* TRACKS - Placeholder */}
          {activeTab === 'tracks' && (
            <div className={`${PANEL} space-y-[var(--s4)] panel-settle`}>
              <h3 className="t-label">Track Management</h3>
              <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">View current track assignment and request upgrades as you progress.</p>
              {/* Track assignment, membership, scholarship, and support status
                  have no backing column anywhere in the schema -- the track
                  itself would come from pilot.admin_track_assignments, which
                  does not exist in staging or prod. These were hardcoded to the
                  same "supported / active member" values for every athlete
                  regardless of their actual status, which is a billing- and
                  eligibility-adjacent misstatement, not a placeholder. Show
                  unavailable honestly until real fields exist.

                  The HONESTY is unchanged; only the voice is. "Unavailable -
                  not yet tracked" is a field status read out to a child, and
                  this file already had the right grammar for an honest empty a
                  few hundred lines up -- the Floor's "No open work from your
                  coach." A coach says nobody has written
                  it down; a console reports a null column. Both refuse to
                  invent a value, which is the part that matters. */}
              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)] space-y-[var(--s2)]">
                <p className="text-[length:var(--t-md)]"><strong>Your track:</strong> <span className="text-[color:var(--bone-400)]">Nobody has written this down yet.</span></p>
                <p className="text-[length:var(--t-md)] text-[color:var(--bone-400)]"><strong>Your programme:</strong> <span>Nobody has written this down yet.</span></p>
                <p className="text-[length:var(--t-md)] text-[color:var(--bone-400)]"><strong>Where you stand:</strong> <span>Nobody has written this down yet.</span></p>
                <p className="text-[length:var(--t-md)] text-[color:var(--bone-400)]"><strong>Support:</strong> <span>Nobody has written this down yet.</span></p>
                <p className="text-[length:var(--t-md)] text-[color:var(--bone-400)]"><strong>Hours you have put in for the gym:</strong> <span>Nobody has written this down yet.</span></p>
              </div>
            </div>
          )}

          {/* ASSESSMENTS - Placeholder */}
          {activeTab === 'assessments' && (
            <div className={`${PANEL} space-y-[var(--s4)] panel-settle`}>
              <h3 className="t-label">Assessments</h3>
              <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">Complete personality tests, surveys, and skill assessments.</p>
              {/* Not-built-yet is a statement of fact, not a refusal or a safety
                  state — the label voice, never the safety gate's red (Law 2). */}
              <p className="t-label">
                NOT BUILT YET -- there is nothing behind this tab, so nothing here can start or score anything.
              </p>
              {/* The card here advertised an "MBTI Personality Test" that would
                  "Discover your personality type and learning style." Both
                  halves promise something this platform will not do: MBTI sorts
                  a person into a fixed type, and learning styles are a contested
                  construct with no instrument here to measure them. Advertised
                  to a child, on their own screen, it says the gym is going to
                  decide what kind of person they are.

                  Nothing was ever built behind it, so this is copy removal
                  rather than a feature removal -- but the copy had to go BEFORE
                  the tab could ever be re-enabled, because whoever turns it on
                  would have built what the card promised. What replaces it
                  names the one thing an assessment tab could honestly hold. */}
              <div className="space-y-[var(--s4)]">
                <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                  <p className="text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">Skill checks</p>
                  <p className="mt-[var(--s2)] text-[length:var(--t-sm)] text-[color:var(--bone-300)]">
                    If this is ever built, it records what you did on a given day — not what kind of person you are.
                  </p>
                  <button
                    type="button"
                    disabled
                    className="btn btn--ghost mt-[var(--s4)] min-h-[var(--tap)] cursor-not-allowed opacity-50"
                  >
                    Start Assessment
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* CHECK IN -- the athlete's own arrival record.

              The ~70 lines of sliders that stood here wrote to local React
              state and persisted nothing; that is why the tab was pulled on
              2026-08-21. The panel now writes to /api/pilot/athlete/check-in.
              It lives in its own file because a surface a child uses every day
              should be readable without scrolling through three thousand lines
              of everything else. */}
          {activeTab === 'bio-checkin' && (
            <AthleteCheckInPanel
              today={todayCheckIn}
              recent={recentCheckIns}
              loading={checkInLoading}
              loadError={checkInLoadError}
              onSaved={(row) => {
                setTodayCheckIn(row);
                setRecentCheckIns((current) =>
                  current.some((entry) => entry.check_in_id === row.check_in_id)
                    ? current
                    : [row, ...current]);
              }}
            />
          )}


          {/* DRILL LIBRARY */}
          {activeTab === 'drill-library' && (
            <div className="space-y-6 panel-settle">
              <HelpPanel
                title="Reference Library"
                /* THE COPY MAY ONLY NAME WHAT THIS SCREEN ACTUALLY RENDERS.
                   Before W-D4 the cards showed no stop rules and this copy was
                   narrowed to say so. Opening a drill now renders its stop
                   rules and scaling (OD-2026-09-19-001), so the copy names them
                   -- and names them as one click away, because that is where
                   they are. */
                description="Reference material for the drills your gym has adopted. Open a drill to see what it is for, what it needs, how it runs, how to make it easier or harder, and when to stop."
                usage={[
                  'Open a drill before or after you train it',
                  'Check the contact level, whether a coach has to be there, and the stop rules',
                  'Bring a question to your coach about anything here'
                ]}
                mistakes={[
                  'Skipping the coaching cues',
                  'Treating a drill you read here as work your coach has given you'
                ]}
              />

              <div className={PANEL}>
                <p className="t-label">Reference · Learning</p>
                <p className="mt-[var(--s2)] text-[length:var(--t-sm)] leading-relaxed text-[color:var(--bone-300)]">
                  This is reading material, not training your coach has given you. Opening a drill here does not assign
                  it to you, does not log it, and does not count toward anything. Your assigned work lives on the
                  progression page.
                </p>
              </div>

              {drillsLoading && (
                <span className="working">Loading the reference library...</span>
              )}

              {!drillsLoading && drillsError && (
                <div className="alert alert--critical" role="alert">
                  <span className="alert-icon" aria-hidden="true">✕</span>
                  <div className="alert-body">
                    <p className="alert-title">Could not load the reference library</p>
                    <p className="alert-msg">{drillsError}</p>
                    <p className="alert-msg mt-[var(--s2)]">The gym&apos;s reference material is still there. This screen just could not reach them.</p>
                  </div>
                </div>
              )}

              {/* An empty list here means something specific and narrow: the gym
                  has not adopted any reference drills yet. It does NOT mean the
                  reference corpus is empty -- the whole corpus exists, and a
                  coach chooses which of it this gym teaches. Saying "your
                  coaches have not added any drills yet" would describe the
                  operational library this panel no longer reads. */}
              {!drillsLoading && !drillsError && drills.length === 0 && (
                <div className={`${PANEL} text-center`}>
                  <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
                    Your coaches have not added any reference drills to this gym&apos;s library yet.
                  </p>
                </div>
              )}

              {/* LEVEL 2: one opened drill, in full. The list is replaced rather
                  than stacked under it, and "Back to drills" returns to it. */}
              {openDrillId && (
                <div className="space-y-[var(--s4)]">
                  <button type="button" className="btn btn--ghost" onClick={closeReferenceDrill}>
                    Back to drills
                  </button>
                  {openDrillLoading && <span className="working">Loading the drill...</span>}
                  {!openDrillLoading && openDrillError && (
                    <div className={PANEL}>
                      <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">{openDrillError}</p>
                      {openDrillError !== DRILL_WITHDRAWN && (
                        <p className="mt-[var(--s2)] text-[length:var(--t-sm)] text-[color:var(--bone-300)]">
                          This is a failure to load the drill, not a sign it was removed. Go back and try again.
                        </p>
                      )}
                    </div>
                  )}
                  {!openDrillLoading && openDrill && <DrillDetail view={openDrill} audience="athlete" focusOnMount />}
                </div>
              )}

              {/* LEVEL 1: concise cards. Name, what it is for, and the two safety
                  facts an athlete should see before opening anything. */}
              <div className={cx('grid grid-cols-1 md:grid-cols-2 gap-[var(--s4)]', openDrillId && 'hidden')}>
                {drills.map(drill => (
                  <div key={drill.id} className={`${PANEL_RAISED} space-y-[var(--s3)]`}>
                    <div className="flex justify-between items-start gap-[var(--s3)]">
                      <h4 className="text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">{drill.name}</h4>
                      {drill.requiresCoachAuthorization && (
                        <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>Coach authorization required</span>
                      )}
                    </div>
                    <p className="text-[length:var(--t-sm)] leading-relaxed text-[color:var(--bone-300)]">{drill.purpose}</p>
                    <p className="text-[length:var(--t-sm)] leading-relaxed text-[color:var(--bone-300)]">
                      <span className="font-semibold text-[color:var(--bone-200)]">Contact:</span> {humanizeContactLevel(drill.contactLevel)}
                    </p>
                    <button
                      type="button"
                      id={learnOpenButtonId(drill.id)}
                      className="btn btn--ghost"
                      aria-label={`Open drill: ${drill.name}`}
                      onClick={() => openReferenceDrill(drill.id)}
                    >
                      Open drill
                    </button>
                    {/* NO COMPLETION CONTROL HERE, AND THAT IS THE DESIGN.
                        "Mark Complete" stood here once and set a React flag.
                        There is no row anywhere for "this athlete practised this
                        library drill": pilot.assignment_completions is keyed on
                        an assignment_id, which only a coach's assignment
                        creates, and no table is keyed on (athlete, drill_id).
                        So the button recorded a completion that reloading
                        erased. It was removed rather than wired, and W-D2 keeps
                        it removed for a second and stronger reason: this panel
                        is Reference, and the owner rule holds that reading
                        reference material creates no assignment, completion or
                        progression state. The completions that ARE stored are
                        logged against ASSIGNED drills on the progression page. */}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* RABBIT HOLES / LEARNING */}
          {activeTab === 'rabbit-holes' && (
            <div className="space-y-6 panel-settle">
              <HelpPanel
                title="Rabbit Holes - Deep Learning"
                description="Deep-dive lessons your coaches wrote, each one a concept to understand and something to go and do with it."
                usage={[
                  'Read concept breakdowns carefully',
                  'Complete homework to internalize learning',
                  'Apply learnings to your training',
                  'Ask a coach for clarification'
                ]}
                mistakes={[
                  'Reading but not doing homework',
                  'Not applying concepts to actual training'
                ]}
              />

              {/* The honesty line the whole tab depends on. A rabbit hole is a
                  person's coaching, so it makes no evidence claim and carries
                  no SHADOW evidence tier. */}
              <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
                Everything here is this gym&apos;s own coaching, written by a coach and published under their name. It
                is not research and it is not SHADOW evidence.
              </p>

              <AthleteRabbitHoleLibrary />
            </div>
          )}

          {/* ASK SHADOW.
              Named for what it does. The copy here has been accurate for a
              while -- it already said SHADOW answers and no coach is notified
              -- but the surface around the copy said something else: it was
              titled "Message Coach", its form said "Send Message to Coach",
              and it opened with a coach picker. Structure outranks body text,
              so an athlete reasonably read all that as "a coach will see this".
              The naming now matches the behaviour, and the picker is gone. */}
          {activeTab === 'message-coach' && (
            <div className="space-y-6 panel-settle">
              <HelpPanel
                title="Ask SHADOW"
                description="Write a question. It is recorded in your own SHADOW conversation and answered by SHADOW -- it does not reach a coach."
                usage={[
                  'Be clear and specific in questions',
                  'Everything you send here is kept',
                  'Open SHADOW Chat to read the response',
                  'Speak to a coach in person for anything urgent'
                ]}
                mistakes={[
                  'Vague questions without context',
                  'Assuming a coach has read what you sent here'
                ]}
              />

              {/* No parent notification exists anywhere in the messaging path --
                  no recipient, address, or delivery step is stored or sent --
                  so this surface cannot claim parent CC is in force. A missing
                  safeguard is a caution, not a Layer 11 lock, so it takes the
                  warning rung with its glyph (Laws 2 + 3). */}
              <div className="alert alert--warning">
                <span className="alert-icon" aria-hidden="true">▲</span>
                <div className="alert-body">
                  <p className="alert-title">Not Built Yet</p>
                  <p className="alert-msg"><strong>SafeSport:</strong> what you send here is kept, but your parent is not automatically copied and no coach is notified. Tell a coach or a trusted adult in person about anything urgent or unsafe.</p>
                </div>
              </div>

              <div className={`${PANEL_RAISED} space-y-[var(--s4)]`}>
                <h3 className="t-label">Ask SHADOW</h3>
                {/* The coach picker that stood here offered two hardcoded names
                    ("Coach Jason (Head Coach)", "Coach Danielle (Fitness
                    Director)") -- invented data on an athlete surface, and a
                    control that changed nothing, since every message goes to
                    the same place regardless of who was chosen. It is removed
                    rather than wired to the real roster: no athlete-scoped
                    coach roster endpoint exists yet, and a picker only earns
                    its place once choosing actually does something. */}
                <form onSubmit={handleSendCoachMessage} className="space-y-[var(--s4)]">
                  <div className="field">
                    <label className="t-label" htmlFor="message-coach-body">Your Question</label>
                    <textarea
                      id="message-coach-body"
                      value={coachMessageBody}
                      onChange={(event) => setCoachMessageBody(event.target.value)}
                      placeholder="Type your question..."
                      className="textarea input--kiosk h-24 resize-none"
                    />
                  </div>
                  {coachMessageStatus ? <p className="text-[length:var(--t-sm)] text-[color:var(--bone-300)]" role="status">{coachMessageStatus}</p> : null}
                  <button
                    type="submit"
                    disabled={isSendingCoachMessage}
                    className="btn btn--kiosk disabled:opacity-50 disabled:grayscale"
                  >
                    {isSendingCoachMessage ? 'Sending...' : 'Ask SHADOW'}
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* SCHEDULE SESSION */}
          {activeTab === 'schedule-session' && (
            <div className="space-y-6 panel-settle">
              <div className="flex flex-wrap gap-[var(--s3)]">
                <Link href="/schedule" className="btn min-h-[var(--tap)]">
                  Open Unified Scheduler
                </Link>
              </div>
              {/* This tab was a "NOT BUILT YET" wrapper around a link to a
                  scheduler that IS built. A tab whose whole content is an
                  apology for itself teaches an athlete to stop opening tabs;
                  what it actually holds is the door to the real thing, so it
                  says that and gets out of the way. The scheduler owns
                  classes, booking and eligibility -- nothing here duplicates
                  them. */}
              <HelpPanel
                title="Schedule Session"
                description="Classes and sign-ups live in the unified scheduler. This is the door to it."
                usage={[
                  'Open the unified scheduler to see live classes',
                  'Check your academic status first',
                  'Readiness RED may limit contact work'
                ]}
                mistakes={[
                  'Booking while on academic hold',
                  'Booking contact work with RED readiness'
                ]}
              />
            </div>
          )}

          {/* SHADOW AI */}
          {activeTab === 'shadow' && (
            <div className="space-y-6 panel-settle">
              <RoleSpecificShadow
                role="athlete"
                description="Ask SHADOW about your next workout, goals, or progress. Open the real SHADOW chat to get a response -- this workspace does not answer questions inline."
                chatContext="Athlete Workspace"
              />

              {/* This panel used to render a hardcoded three-message exchange --
                  including a fabricated athlete utterance -- above a text input
                  whose Send button had no handler at all, under a description
                  claiming "nothing here is a canned example". Nothing shown to an
                  athlete may be a static transcript that could be mistaken for
                  their own conversation, and a control that cannot send must not
                  look like one. Route to the real chat instead; see the same
                  correction in RoleSummaryPanels.tsx. */}
              <div className={`${PANEL_RAISED} space-y-[var(--s4)]`}>
                <div>
                  <p className="t-label">SHADOW Chat</p>
                  <p className="mt-[var(--s2)] text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
                    You cannot chat with SHADOW from this screen yet. Open the full SHADOW chat to ask a
                    question and get a real answer.
                  </p>
                </div>

                <ShadowChatButton context="Athlete Workspace" />

                <div className="space-y-[var(--s3)] border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s4)]">
                  <p className="t-label">Things you can ask SHADOW:</p>
                  <ul className="list-disc space-y-[var(--s2)] pl-[var(--s5)]">
                    {suggestedQuestions.map((q) => (
                      <li key={q} className="text-[length:var(--t-sm)] text-[color:var(--bone-300)]">{q}</li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* A scope note, not a caution state — plain leather, no rung. */}
              <div className={PANEL}>
                <p className="text-[length:var(--t-sm)] leading-relaxed text-[color:var(--bone-200)]"><strong>Note:</strong> SHADOW cannot answer questions about other athletes, board operations, financial data, or provide medical/legal advice.</p>
              </div>

              <div className={PANEL}>
                <h3 className="t-label">What SHADOW Has Noticed</h3>
                {shadowObservationError ? (
                  <div className="alert alert--critical" role="alert">
                    <span className="alert-icon" aria-hidden="true">✕</span>
                    <div className="alert-body">
                      <p className="alert-title">Could not load SHADOW&apos;s notes</p>
                      <p className="alert-msg">{shadowObservationError}</p>
                      <div className="alert-action">
                        <button
                          onClick={() => {
                            setShadowObservationError('');
                            void loadShadowObservations();
                          }}
                          className="btn btn--ghost min-h-[var(--tap)]"
                          aria-label="Retry loading SHADOW observations"
                        >
                          Retry
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
                {!shadowObservationError && shadowObservations.length === 0 ? (
                  <p className="t-muted mt-[var(--s3)]">SHADOW has not noticed anything yet. Keep training and checking in.</p>
                ) : null}
                <div className="mt-[var(--s3)] space-y-[var(--s3)]">
                  {shadowObservations.slice(0, 6).map((item) => (
                    <div key={item.id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s3)] text-[length:var(--t-sm)] text-[color:var(--bone-300)]">
                      <p className="font-semibold text-[color:var(--bone-100)]">{item.label}</p>
                      <p>Source: {item.source}</p>
                      <p>State: {item.review_state}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* THE ANTI-EGG IS GONE. This box was headed "Daily Reminder" and held
            a permanent, unattributed line -- "Show up. Do the hard rounds. Own
            the details. Progress is earned through consistent grit and
            disciplined effort." -- on the screen every single time an athlete
            opened it. That is precisely the wallpaper gymSayings.ts exists to
            forbid: nobody at this gym said it, nobody's name is under it, and
            it is a flatter rewrite of the owner's own line #4, "SHOW UP. DO
            THE WORK. GO HOME BETTER.", which is attributed and which appears
            at a moment instead of forever. The gym's voice on this page is the
            chalkboard a few hundred pixels up, where a person writes a line by
            hand and rubs it out when they feel like it.

            What is left is the one true thing the box carried: the last word
            from the backend about what just saved. It appears when there is
            one and the box is not there when there is not -- an empty panel
            reserved for a message is still furniture. Read at --t-md rather
            than the --t-xs it used to sit at, because an athlete reads this
            standing up on the floor (Law 5). */}
        {backendSyncMessage ? (
          <div className={PANEL}>
            <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-200)]" role="status">{backendSyncMessage}</p>
          </div>
        ) : null}

        {/* ROLE SUMMARY PANEL */}
        {/* Class times and registrations live behind the unified scheduler;
            this workspace has no feed for the athlete's next class, so the
            tile must not name one. */}
        <AthleteSummaryPanel
          readiness={currentReadiness}
          readinessValue={readinessToTrain}
          openCoachWork={openCoachWorkRead}
          goalsActive={goalsActive}
          upcomingSession="Nothing posted yet."
        />

        {/* The training card. One stamp per session row from the ledger -- a
            record the athlete accumulates, so there is something to come back
            to. Cumulative, never a streak: see TrainingCard.tsx.

            The athlete id scopes the ceremony's record of which seals have
            already been pressed. This is a shared gym tablet: without it, the
            first athlete to open their card on one would silence the next
            athlete's first milestone. */}
        <TrainingCard sessions={trainingSessions} athleteId={backendAthleteId ?? undefined} />

        {/* Everything the card cannot count. The card measures attendance, and
            attendance is one of four programmes this gym runs -- a fitness-only
            member and a kid here for the mentorship both had a progression
            system that was measuring somebody else's sport. This panel carries
            what a coach said, the conditioning / craft / community path, and
            who mentors whom. Complete for every programme: what somebody's
            programme does not include is absent, never greyed out. */}
        <AthleteAchievements athleteId={backendAthleteId} />

        {/* Two things that leave the screen. A route nobody can reach is a dead
            feature, and neither of these has a home anywhere else. */}
        <div className={PANEL}>
          <p className="t-eyebrow">Off the screen</p>
          <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/print" className="btn btn--ghost min-h-[var(--tap)]">
              Print your card
            </Link>
            <Link href="/names" className="btn btn--ghost min-h-[var(--tap)]">
              The Wall of Names
            </Link>
          </div>
        </div>

        {/* This panel was headed "What's Coming" and described both pages below
            as "Not Built Yet", one of them as "The screens are drawn. Nothing
            behind them works yet." Both shipped since that copy was written:
            /athlete/video-analysis reads pilot.video via /api/pilot/video/list
            and the SHADOW observation projection, and
            /athlete/progression-intelligence reads real gaps and drill
            assignments and writes completions back.

            Telling an athlete a working feature does not exist is the same
            class of error as claiming one that does not -- it just fails in the
            direction that hides their own record from them. What stays "not
            built" is narrower and named: automatic scoring, which is PARKED by
            owner decision and which those pages already label for themselves. */}
        <details className={PANEL}>
          <summary className="t-label cursor-pointer">More in your workspace</summary>
          <div className="mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2">
            <article className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
              <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">Your Film</p>
              <p className="t-muted mt-[var(--s2)]">Your own film, and what SHADOW noticed in it. Nothing scores your technique automatically -- that part is not built.</p>
              <Link href="/athlete/video-analysis" className="btn btn--ghost mt-[var(--s3)] min-h-[var(--tap)]">
                Open Your Film
              </Link>
            </article>
            <article className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
              <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">Your Progression</p>
              <p className="t-muted mt-[var(--s2)]">The gaps your coach identified and the drills they assigned, where you can log what you finished. Your coach still decides what comes next.</p>
              <Link href="/athlete/progression-intelligence" className="btn btn--ghost mt-[var(--s3)] min-h-[var(--tap)]">
                Open Your Progression
              </Link>
            </article>
            {/* /athlete/dashboard/sparring existed with a real, tested,
                API-backed form (rounds, contact, punch output feeding the
                same SHADOW formulas this tab is named for) and no link to it
                anywhere in the app -- reachable only by typing the URL or
                using site search. This card is the only thing that changed;
                the page itself and its own naming are untouched. */}
            <article className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
              <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">Sparring Log</p>
              <p className="t-muted mt-[var(--s2)]">Write down a sparring session -- rounds, contact, what you threw and what landed. Your coach reads it.</p>
              <Link href="/athlete/dashboard/sparring" className="btn btn--ghost mt-[var(--s3)] min-h-[var(--tap)]">
                Open Sparring Log
              </Link>
            </article>
          </div>
        </details>

        {/* PAIN MODAL */}
        {showPainModal && selectedPainLocation && (
          <div className="fixed inset-0 bg-[var(--hide-950)]/80 backdrop-blur-sm flex items-center justify-center z-50 p-[var(--s4)]">
            <div className="mat-leather--raised w-full max-w-md space-y-[var(--s4)] rounded-[var(--r-lg)] p-[var(--s5)]">
              <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Soreness Details: {selectedPainLocation}</h3>
              <div className="space-y-[var(--s4)]">
                <div className="field">
                  <label className="t-label" htmlFor="pain-type-select">Pain Type</label>
                  <select id="pain-type-select" value={currentPainType} onChange={(e) => setCurrentPainType(e.target.value as PainType)} className="select input--kiosk">
                    {(['Sharp', 'Dull', 'Burning', 'Tight', 'Pulling', 'Throbbing', 'Swollen', 'Numbness/Tingling', 'Instability', 'Other'] as PainType[]).map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="t-label block mb-[var(--s3)]" htmlFor="pain-severity-range">Severity (1-10)</label>
                  <input id="pain-severity-range" type="range" min="1" max="10" value={currentPainSeverity} onChange={(e) => setCurrentPainSeverity(Number.parseInt(e.target.value, 10))} className="range--kiosk cursor-pointer" />
                  <p className="t-data mt-[var(--s1)]" style={{ fontSize: 'var(--t-sm)' }}>{currentPainSeverity}/10</p>
                </div>
              </div>
              <div className="flex gap-[var(--s3)]">
                <button
                  onClick={() => void handleSavePainReport()}
                  disabled={isSavingPain}
                  className="btn btn--kiosk flex-1 disabled:opacity-50 disabled:grayscale"
                >
                  {isSavingPain ? 'Saving...' : 'Save'}
                </button>
                <button onClick={() => setShowPainModal(false)} className="btn btn--kiosk btn--ghost flex-1">Cancel</button>
              </div>
            </div>
          </div>
        )}

        {/* The gym wall, at the foot of the page where ambient furniture
            belongs. See the note where it used to hang, above the daily
            reminder. */}
        <GymWallModule className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s5)]" />

        {/* The four words, at the foot of the page. See WorkAxis for why this
            is not the motto strip that was taken out of this header. */}
        <WorkAxis />
      </div>
    </div>
  );
}

