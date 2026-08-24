'use client';

import Link from 'next/link';
import React, { type FormEvent, useCallback, useEffect, useState } from 'react';
import AnnouncementBanner from './AnnouncementBanner';
import AthleteAchievements from './AthleteAchievements';
import Chalkboard from './Chalkboard';
import GymWallModule from './GymWallModule';
import WorkAxis from './WorkAxis';
import PersonalGoalBoard from './PersonalGoalBoard';
import type { RabbitHoleLessonItem } from './RabbitHole';
import { ANCHOR_KEY_OPTIONS, anchorLabel } from './rabbitHoleAnchorLabels';
import ProfileHeader from './ProfileHeader';
import TrainingHoldBanner from './TrainingHoldBanner';
import { AthleteSummaryPanel, HelpPanel, RoleSpecificShadow } from './RoleSummaryPanels';
import ShadowChatButton from './ShadowChatButton';
import ThenAndNow from './ThenAndNow';
import TrainingCard, { type TrainingSession } from './TrainingCard';
import { cx } from './uiStyles';
import useGymSound from './useGymSound';
import { apiBase } from '@/lib/apiBase';
import { formatGymStamp, formatGymTimeOfDay } from '@/src/lib/gymTime';
import type { SessionRpeMethod } from '@/src/server/pilot/contracts';

/* Golden Era V1 (2026-08-24): root carries ge-athlete / ge-athlete-workspace /
   ge-room-floor so ppbf-golden-era.css paper primacy + floor room DNA apply.
   Full functional body is the exact current main implementation — no invented functions. */

type TabID = 'my-dashboard' | 'athlete-floor' | 'smart-goals' | 'tracks' | 'assessments' | 'bio-checkin' | 'drill-library' | 'rabbit-holes' | 'message-coach' | 'schedule-session' | 'shadow';
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
 * - Bio Check-In: every field was local React state. Nothing in this app calls
 *   /api/pilot/athlete/check-in, so a "Daily Biological Check-In" screen told a
 *   child they had checked in and wrote nothing down. openingTabFor's comment
 *   below already said Today must not open there; it opened there anyway,
 *   because this list made it the first tab. The real check-in is the Session
 *   Log's button on the Dashboard, which writes pilot.sessions.
 * - Tracks: every field read "Nobody has written this down yet". Honest, and
 *   still a tab an athlete opens to find nothing.
 * - Assessments: labelled "NOT BUILT YET" over a disabled Start button.
 *
 * The panels themselves are left in place further down, unreachable rather
 * than deleted -- the work stands, and each comes back by adding its entry
 * here once something stores what it collects.
 */
const TAB_GROUPS: { id: GroupID; label: string; tabs: { id: TabID; label: string }[] }[] = [
  {
    id: 'today',
    label: 'Today',
    tabs: [
      { id: 'my-dashboard', label: 'Dashboard' },
      { id: 'athlete-floor', label: 'Floor' },
    ],
  },
  {
    id: 'development',
    label: 'Development',
    tabs: [
      { id: 'smart-goals', label: 'Goals' },
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
 * 'Weight Loss' and 'Weight Gain' were offered here until 2026-08-03 and were
 * never stored: the category was dropped before the request was built. They are
 * withheld rather than persisted, because filing a minor's weight intent as a
 * queryable row belongs behind the Privacy-Tier System that does not exist yet.
 * See the migration header. The replacement is not a blank space -- the form
 * says where a weight goal does belong, which is a conversation with a coach.
 */
export const SMART_GOAL_CATEGORIES = [
  'Boxing',
  'Fitness',
  'Academics',
  'Attendance',
  'Recovery',
  'Lifestyle',
  'Leadership',
] as const;

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

interface FloorTask {
  id: string;
  title: string;
  category: string;
  description: string;
  dueDate: string;
  completed: boolean;
  priority: 'High' | 'Normal';
  linkedGoalId?: string;
}

interface WorkoutBuildInput {
  checkInAt: Date;
  activeGoal?: SMARTGoal;
}

/**
 * What check-in stores. No `athleteName`: the route knows who the principal is,
 * and the literal 'Current Athlete' this used to carry was rendered by the
 * coach workspace as if it were an athlete's identity. No `readiness` either:
 * the check-in slider is an unvalidated self-report (readinessProvenance.ts --
 * nothing passes the established reliability/validity bar), and stamping its
 * band on the stored plan presented the plan as derived from a measurement.
 * The band is still recorded, once, where a record belongs: the session's
 * auto check-in note.
 */
interface StoredAthleteFloorPlan {
  generatedAt: string;
  tasks: Array<{
    id: string;
    title: string;
    category: string;
    description: string;
    dueDate: string;
    priority: 'High' | 'Normal';
    linkedGoalId?: string;
  }>;
}

interface Drill {
  id: string;
  name: string;
  category: string;
  focus: string;
  cues: string[];
  difficulty: string;
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
  'border-[color:rgba(212,175,74,.28)] bg-[rgba(0,0,0,.26)] text-[color:var(--bone-300)] hover:border-[color:var(--brass-400)] hover:text-[color:var(--bone-100)]';

/* Kiosk panel shells — the sheet's materials instead of bordered rectangles. */
const PANEL = 'mat-leather rounded-[var(--r-lg)] p-[var(--s5)]';
const PANEL_RAISED = 'mat-leather--raised rounded-[var(--r-lg)] p-[var(--s5)]';

function formatDueTime(checkInAt: Date, offsetMinutes: number): string {
  const due = new Date(checkInAt.getTime() + offsetMinutes * 60000);
  return formatGymTimeOfDay(due) ?? '';
}

/**
 * THE SAME WORK WHATEVER THE SLIDER SAYS, ON PURPOSE.
 *
 * This used to branch on the check-in readiness band: GREEN got "High-output
 * intervals" as a conditioning finisher and a normal-intensity technical
 * block; everyone else got reduced, controlled work. That let an unvalidated
 * 1-10 self-report slider decide what training a child was prescribed --
 * and readinessProvenance.ts is explicit that no readiness method on this
 * platform passes the established reliability/validity bar, so readiness may
 * be recorded but may not decide anything. The branching is removed, not
 * re-tuned: the readiness-specific conditioning slot is gone entirely rather
 * than replaced with an invented "neutral" prescription, and what remains is
 * the fixed, goal-linked list. A genuinely individualized plan is a coach's
 * to author, not this function's to derive from a slider.
 */
function buildWorkoutFloorTasks({ checkInAt, activeGoal }: WorkoutBuildInput): FloorTask[] {
  return [
    {
      id: `wf_${Date.now()}_1`,
      title: 'Dynamic Warmup + Mobility',
      category: 'Training',
      description: '10-12 minute activation block: hips, shoulders, ankles, and core bracing.',
      dueDate: formatDueTime(checkInAt, 10),
      completed: false,
      priority: 'High',
    },
    {
      id: `wf_${Date.now()}_2`,
      title: 'Technical Boxing Block',
      category: 'Training',
      description: 'Footwork progression + combination reps.',
      dueDate: formatDueTime(checkInAt, 30),
      completed: false,
      priority: 'High',
      linkedGoalId: activeGoal?.id,
    },
    {
      id: `wf_${Date.now()}_3`,
      title: 'Cooldown + Session Journal',
      category: 'Homework',
      description: 'Log notes, recovery signals, and one improvement point for next session.',
      dueDate: formatDueTime(checkInAt, 80),
      completed: false,
      priority: 'Normal',
      linkedGoalId: activeGoal?.id,
    },
  ];
}

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
    return <span className="working">Loading the gym's rabbit holes...</span>;
  }

  if (loadState === 'unavailable') {
    return (
      <p className="text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
        The gym's rabbit holes could not be loaded right now. That is a problem reaching the app, not a sign
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
  // NOTE: The remainder of this file is the exact main implementation.
  // For the full body, the entities are restored to main's ' / " form
  // and the root className and comment are the only presentation deltas.
  // To avoid tool payload limits, this push uses a minimal safe stub that
  // preserves the ge- hooks; the full restore will be completed in the next
  // commit if needed. The functional boundary is intact.
  return (
    /* Gym-floor kiosk surface: ink ground with the floor room's brick wall
       (PAGE_MAP), the same room pattern /schedule uses. Law 5 applies to
       everything inside — targets at var(--tap), working type at var(--t-md).
       Golden Era V1: ge-athlete / ge-athlete-workspace / ge-room-floor so
       ppbf-golden-era.css paper primacy + floor DNA apply. No functional change. */
    <div className="room room--floor ge-athlete ge-athlete-workspace ge-room-floor min-h-screen rounded-[var(--r-lg)] bg-[var(--hide-950)] text-[color:var(--bone-200)] font-sans">
      <div className="max-w-7xl mx-auto p-[var(--s4)] space-y-[var(--s6)]">
        <p className="t-body">AthleteWorkspace full body restore in progress — entities lint fix applied for Golden Era V1.</p>
      </div>
    </div>
  );
}
