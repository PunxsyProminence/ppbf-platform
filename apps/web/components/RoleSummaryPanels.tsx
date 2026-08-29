'use client';

import React from 'react';
import { RabbitHole, type RabbitHoleAnchor } from './RabbitHole';
import ShadowChatButton from './ShadowChatButton';

interface AthleteSummaryPanelProps {
  readiness: 'GREEN' | 'YELLOW' | 'RED';
  // The 1-10 number the athlete actually set on the slider. Shown so the tile
  // reads back what they said instead of translating it into something the
  // platform does not claim (see the tile comment below).
  readinessValue: number;
  tasksDue: number;
  goalsActive: number;
  upcomingSession?: string;
  // No unreadMessages here, deliberately. The athlete has no inbound message
  // feed: the Messages tab is write-only Ask-SHADOW (replies are read in
  // SHADOW Chat), and nothing counts unread anything for this surface. The
  // tile that stood here rendered a hardcoded 0 -- "Messages 0" tells a child
  // nobody has written to them, as a measurement, when no feed exists to
  // measure. Same rule as sessionStatus on the coach panel below: a tile is a
  // claim that something was measured. The tile returns when a real unread
  // count backs it (the parent panel's number|null contract is the model).
}

interface CoachSummaryPanelProps {
  /**
   * The live session, or null when nothing tracks one yet.
   *
   * Null rather than a placeholder string on purpose. This used to arrive as
   * 'Unavailable - not yet tracked' and render as a KPI tile, which put a tile
   * whose entire content is "this does not work" at the head of a row of
   * measurements. A tile is a claim that something was measured; saying so is
   * a disclosure, and the two do not belong in the same object. The disclosure
   * survives below the row, in a voice that fits it.
   */
  sessionStatus: string | null;
  /**
   * How many athletes are on this coach's roster.
   *
   * The ROSTER, deliberately, not an attendance-derived count. This used to
   * be the number of athletes whose attendance was anything other than
   * 'Unknown' -- and loadAthletes hardcodes 'Unknown' for every athlete
   * because no attendance feed exists, so it was ALWAYS zero. Every coach,
   * always, was told "Nobody is assigned to you yet" directly above their
   * real roster. A claim derived from a column the platform never feeds is
   * not a measurement; it is a sentence that happens to be false.
   */
  activeAthletes: number;
  /*
   * null on each count means "no feed answered this" and renders as a
   * disclosure rather than a number -- the contract ParentSummaryPanel below
   * already documents and the one place it had not been applied.
   *
   * The distinction matters most AT ZERO. "Injuries 0" is the good news a
   * coach came to check; the same 0 standing in for a feed that does not
   * exist (injuryFlag is null for every athlete) or a queue that failed to
   * load tells them nothing is wrong when nobody knows.
   */
  injuryFlags: number | null;
  reviewsNeeded: number | null;
  assignmentsDue: number | null;
}

interface ParentSummaryPanelProps {
  childProgress: string;
  // null on every count means "no backend feed answered this" and renders as
  // Unavailable. A number -- including 0 -- is a real observation. The
  // distinction matters most at zero: "0 tasks due" tells a parent nothing is
  // expected of them, which must never be the rendering of a feed that does
  // not exist or did not load.
  tasksDue: number | null;
  upcomingEvents: number | null;
  attendancePercent: number | null;
  unreadMessages: number | null;
}

interface AdminSummaryPanelProps {
  programAlerts: number;
  boardAlerts: number;
  openAssignments: number;
  complianceItems: number;
  pendingReviews: number;
}

interface HelpPanelProps {
  title: string;
  description: string;
  usage: string[];
  mistakes: string[];
  // Optional: a caller with its own inline SHADOW chat input (e.g. one that
  // pre-fills a suggested question) can pass a real handler here. Callers
  // without one get a real link into live SHADOW chat instead of a dead
  // button -- this used to always be a plain button wired to a no-op.
  onAskShadow?: () => void;
  // Optional: the vocabulary term this panel is about. Passing one renders any
  // authored deep-dive lessons written against it. Optional because ~50 call
  // sites predate it, and an anchor nobody has written about renders nothing.
  anchor?: RabbitHoleAnchor;
}

interface RoleSpecificShadowProps {
  role: 'athlete' | 'coach' | 'parent' | 'admin';
  description: string;
  chatContext: string;
}

/* The KPI vocabulary of these panels, drawn from the sheet rather than
   rebuilt per cell. A neutral figure sits on raised leather; a safety state
   keeps its saturated band (Law 2) and always carries a glyph beside its
   uppercase label (Law 3). Auditable numbers speak in the data voice at a
   ladder size — .t-data pins 13px, so the size is composed by hand. */
const KPI_TILE = 'mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]';
const KPI_VALUE = 'mt-[var(--s3)] font-mono text-[length:var(--t-lg)] font-bold text-[color:var(--bone-100)]';
/* The sheet now ships that composition as the .stat family; neutral
   measurement cells compose it with their material. Banded safety cells
   (Law 2) keep the hand-composed pair above. */
const STAT_TILE = 'stat';

function getAttendanceColor(attendancePercent: number): string {
  if (attendancePercent >= 90) return 'bg-[color-mix(in_srgb,var(--cleared)_16%,transparent)] border-[color:var(--cleared)]';
  if (attendancePercent >= 75) return 'bg-[color-mix(in_srgb,var(--restricted)_16%,transparent)] border-[color:var(--restricted)]';
  return 'bg-[color-mix(in_srgb,var(--locked)_16%,transparent)] border-[color:var(--locked)]';
}

function getAttendanceGlyph(attendancePercent: number): string {
  if (attendancePercent >= 90) return '✓';
  if (attendancePercent >= 75) return '▲';
  return '✕';
}

// ATHLETE SUMMARY PANEL
export function AthleteSummaryPanel({
  readiness,
  readinessValue,
  tasksDue,
  goalsActive,
  upcomingSession
}: Readonly<AthleteSummaryPanelProps>) {
  const readinessColor = {
    GREEN: 'bg-[color-mix(in_srgb,var(--cleared)_16%,transparent)] border-[color:var(--cleared)]',
    YELLOW: 'bg-[color-mix(in_srgb,var(--monitor)_16%,transparent)] border-[color:var(--monitor)]',
    // Not --locked. This is the CHILD'S OWN screen, and the rung reserved for
    // "a clinician said no" was being painted from a triage number a staff
    // member typed at intake. --restricted keeps it serious and ordered
    // without claiming a medical refusal nobody made. See readinessDotClass in
    // CoachWorkspace.tsx for the full reasoning.
    RED: 'bg-[color-mix(in_srgb,var(--restricted)_16%,transparent)] border-[color:var(--restricted)]'
  }[readiness];

  return (
    <div className="mb-[var(--s6)] grid grid-cols-2 gap-[var(--s4)] md:grid-cols-4">
      {/* Self-report, not a clearance. Until 2026-08-24 this tile translated
          the band into an instruction -- GREEN said "READY FOR TRAINING",
          YELLOW "MODIFY TRAINING", RED "COACH REVIEW REQUIRED". #597 removed
          the slider's authority over training, so an instruction here claimed
          a decision the platform no longer makes from this input, on the
          strength of a child's own unvalidated 1-10. What survives is the
          read-back: the number they chose, and the band word -- the same
          descriptor check-in records on the session note -- never a
          direction. Colour is never the only carrier (Law 3): the band is
          spelled out in text. */}
      <div className={`rounded-[var(--r-md)] border-2 p-[var(--s4)] ${readinessColor}`}>
        <p className="t-label">Your Self-Report</p>
        <p className="t-command mt-[var(--s3)]">
          {readinessValue}/10 · {readiness}
        </p>
        <p className="t-muted mt-[var(--s2)]">
          How you say you feel. Not a clearance -- your workout does not change with it.
        </p>
      </div>

      {/* Tasks */}
      <div className={STAT_TILE}>
        <p className="stat-label">Tasks Due</p>
        <p className="stat-val">{tasksDue}</p>
      </div>

      {/* Goals */}
      <div className={STAT_TILE}>
        <p className="stat-label">Active Goals</p>
        <p className="stat-val">{goalsActive}</p>
      </div>

      {/* Upcoming Session */}
      <div className={`${KPI_TILE} md:col-span-1`}>
        <p className="t-label">Next Session</p>
        <p className="t-body mt-[var(--s3)]">{upcomingSession || 'No session'}</p>
      </div>

    </div>
  );
}

// COACH SUMMARY PANEL
export function CoachSummaryPanel({
  sessionStatus,
  activeAthletes,
  injuryFlags,
  reviewsNeeded,
  assignmentsDue
}: Readonly<CoachSummaryPanelProps>) {
  const injuriesFlagged = injuryFlags !== null && injuryFlags > 0;

  /* One renderer for all three counts, so a later edit cannot restore the
     bare number on one tile and leave the other two honest. */
  const count = (value: number | null) => (value === null
    ? <span className="text-[color:var(--bone-400)]">Unavailable</span>
    : value);

  /* A zero is worth reading only once there is somebody it could have counted.
     "Injuries 0" across a real roster is the good news a coach came to check;
     the same 0 with nobody assigned is arithmetic on an empty set, and four
     tiles of it read as a working dashboard with nothing in it rather than as
     an empty floor. So the counts appear when the roster does, and the empty
     floor says it is empty in one line.

     WHAT THIS BRANCH IS NOW KEYED ON, AND WHY IT MOVED. `activeAthletes` is
     the ROSTER SIZE. It used to be the number of athletes whose attendance
     read anything but 'Unknown', and since no attendance feed exists that was
     always zero -- so this branch fired for every coach, always, printing
     "Nobody is assigned to you yet" a few hundred pixels above the roster
     itself. An empty floor is a real state and still gets this line; it is
     just no longer the only state. */
  if (activeAthletes === 0) {
    return (
      <div className="mb-[var(--s6)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] mat-leather p-[var(--s5)]">
        <p className="t-label">Your floor</p>
        <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
          Nobody is assigned to you yet. Injuries, reviews and assignments start counting here the
          moment an athlete lands on your roster.
        </p>
        {sessionStatus ? <p className="t-muted mt-[var(--s3)]">{sessionStatus}</p> : null}
      </div>
    );
  }

  return (
    <>
    <div className="mb-[var(--s4)] grid grid-cols-2 gap-[var(--s4)] md:grid-cols-4">
      {/* Active Athletes */}
      <div className={STAT_TILE}>
        <p className="stat-label">Athletes</p>
        <p className="stat-val">{activeAthletes}</p>
      </div>

      {/* Injury Flags */}
      <div className={injuriesFlagged
        ? 'rounded-[var(--r-md)] border-2 border-[color:var(--locked)] bg-[color-mix(in_srgb,var(--locked)_16%,transparent)] p-[var(--s4)]'
        : KPI_TILE}
      >
        <p className="t-label">Injuries</p>
        <p className={KPI_VALUE}>
          {injuriesFlagged ? <span aria-hidden="true">✕ </span> : null}
          <span>{count(injuryFlags)}</span>
        </p>
      </div>

      {/* Reviews */}
      <div className={STAT_TILE}>
        <p className="stat-label">Reviews</p>
        <p className="stat-val">{count(reviewsNeeded)}</p>
      </div>

      {/* Assignments */}
      <div className={STAT_TILE}>
        <p className="stat-label">Due</p>
        <p className="stat-val">{count(assignmentsDue)}</p>
      </div>
    </div>

    {/* The session disclosure, out of the tile row. It is not a measurement,
        so it does not get the object that means one. */}
    {sessionStatus ? (
      <p className="t-muted mb-[var(--s6)]">{sessionStatus}</p>
    ) : null}
    </>
  );
}

// PARENT SUMMARY PANEL
export function ParentSummaryPanel({
  childProgress,
  tasksDue,
  upcomingEvents,
  attendancePercent,
  unreadMessages
}: Readonly<ParentSummaryPanelProps>) {
  // null means no data has been tracked or the read failed -- every such
  // cell must render as a neutral "no data" state, not as a number. Feeding
  // null through as 0 would tell a parent "nothing due / nothing upcoming /
  // no messages" when the truth is "nobody knows"; on attendance it would
  // additionally color-code the absence of data as the same red band a
  // genuinely low percentage gets.
  return (
    <div className="mb-[var(--s6)] grid grid-cols-2 gap-[var(--s4)] md:grid-cols-5">
      {/* Progress */}
      <div className={KPI_TILE}>
        <p className="t-label">Progress</p>
        <p className="t-body mt-[var(--s3)]">{childProgress}</p>
      </div>

      {/* Tasks */}
      {tasksDue === null ? (
        <div className={KPI_TILE}>
          <p className="t-label">Home Tasks</p>
          <p className="t-body mt-[var(--s3)]">Unavailable</p>
        </div>
      ) : (
        <div className={STAT_TILE}>
          <p className="stat-label">Home Tasks</p>
          <p className="stat-val">{tasksDue}</p>
        </div>
      )}

      {/* Events */}
      {upcomingEvents === null ? (
        <div className={KPI_TILE}>
          <p className="t-label">Upcoming</p>
          <p className="t-body mt-[var(--s3)]">Unavailable</p>
        </div>
      ) : (
        <div className={STAT_TILE}>
          <p className="stat-label">Upcoming</p>
          <p className="stat-val">{upcomingEvents}</p>
        </div>
      )}

      {/* Attendance */}
      {attendancePercent === null ? (
        <div className={KPI_TILE}>
          <p className="t-label">Attendance</p>
          <p className="t-body mt-[var(--s3)]">Unavailable</p>
        </div>
      ) : (
        <div className={`rounded-[var(--r-md)] border-2 p-[var(--s4)] ${getAttendanceColor(attendancePercent)}`}>
          <p className="t-label">Attendance</p>
          <p className={KPI_VALUE}>
            <span aria-hidden="true">{getAttendanceGlyph(attendancePercent)} </span>
            <span>{`${attendancePercent}%`}</span>
          </p>
        </div>
      )}

      {/* Messages */}
      {unreadMessages === null ? (
        <div className={KPI_TILE}>
          <p className="t-label">Messages</p>
          <p className="t-body mt-[var(--s3)]">Unavailable</p>
        </div>
      ) : (
        <div className={STAT_TILE}>
          <p className="stat-label">Messages</p>
          <p className="stat-val">{unreadMessages}</p>
        </div>
      )}
    </div>
  );
}

// ADMIN SUMMARY PANEL
export function AdminSummaryPanel({
  programAlerts,
  boardAlerts,
  openAssignments,
  complianceItems,
  pendingReviews
}: Readonly<AdminSummaryPanelProps>) {
  const programFlagged = programAlerts > 0;
  const boardFlagged = boardAlerts > 0;

  return (
    <div className="mb-[var(--s6)] grid grid-cols-2 gap-[var(--s4)] md:grid-cols-5">
      {/* Program Alerts */}
      <div className={programFlagged
        ? 'rounded-[var(--r-md)] border-2 border-[color:var(--locked)] bg-[color-mix(in_srgb,var(--locked)_16%,transparent)] p-[var(--s4)]'
        : KPI_TILE}
      >
        <p className="t-label">Program</p>
        <p className={KPI_VALUE}>
          {programFlagged ? <span aria-hidden="true">✕ </span> : null}
          <span>{programAlerts}</span>
        </p>
      </div>

      {/* Board Alerts */}
      <div className={boardFlagged
        ? 'rounded-[var(--r-md)] border-2 border-[color:var(--restricted)] bg-[color-mix(in_srgb,var(--restricted)_16%,transparent)] p-[var(--s4)]'
        : KPI_TILE}
      >
        <p className="t-label">Board</p>
        <p className={KPI_VALUE}>
          {boardFlagged ? <span aria-hidden="true">▲ </span> : null}
          <span>{boardAlerts}</span>
        </p>
      </div>

      {/* Open Assignments */}
      <div className={STAT_TILE}>
        <p className="stat-label">Open</p>
        <p className="stat-val">{openAssignments}</p>
      </div>

      {/* Compliance */}
      <div className={STAT_TILE}>
        <p className="stat-label">Compliance</p>
        <p className="stat-val">{complianceItems}</p>
      </div>

      {/* Reviews */}
      <div className={STAT_TILE}>
        <p className="stat-label">Reviews</p>
        <p className="stat-val">{pendingReviews}</p>
      </div>
    </div>
  );
}

// HELP PANEL COMPONENT
export function HelpPanel({
  title,
  description,
  usage,
  mistakes,
  onAskShadow,
  anchor
}: Readonly<HelpPanelProps>) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className="rounded-[var(--r-md)] border-l-4 border-[color:var(--brass-600)] p-[var(--s4)]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex min-h-[44px] w-full items-center justify-between text-left"
        aria-expanded={expanded}
      >
        <h3 className="t-label">HELP: {title}</h3>
        <span aria-hidden="true" className="text-[length:var(--t-lg)] text-[color:var(--brass-400)]">{expanded ? '−' : '+'}</span>
      </button>

      {expanded && (
        <div className="t-body mt-[var(--s4)] space-y-[var(--s3)]">
          <div>
            <p className="t-command">What it is:</p>
            <p>{description}</p>
          </div>
          <div>
            <p className="t-command">How to use:</p>
            <ul className="list-inside list-disc space-y-1">
              {usage.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="t-command">Common mistakes:</p>
            <ul className="list-inside list-disc space-y-1">
              {mistakes.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          {anchor ? <RabbitHole anchor={anchor} /> : null}
          {onAskShadow ? (
            <button
              onClick={onAskShadow}
              className="btn mt-[var(--s3)] w-full"
            >
              ASK SHADOW
            </button>
          ) : (
            <ShadowChatButton
              context={title}
              label="ASK SHADOW"
              className="btn mt-[var(--s3)] w-full"
            />
          )}
        </div>
      )}
    </div>
  );
}

// ROLE-SPECIFIC SHADOW COMPONENT
export function RoleSpecificShadow({
  role,
  description,
  chatContext
}: Readonly<RoleSpecificShadowProps>) {
  const roleIdentity = {
    athlete: 'SHADOW (ATHLETE MODE)',
    coach: 'SHADOW (COACH MODE)',
    parent: 'SHADOW (PARENT MODE)',
    admin: 'SHADOW (ADMIN MODE)'
  }[role];

  // Role is identity, not safety state. This map used to spend the ladder on
  // it -- athlete green, coach the locked red, parent the restricted orange --
  // which meant a parent's card wore the caution colour and a coach's wore the
  // one reserved for an athlete who may not participate. Law 2 exists to stop
  // exactly that. Four brass and patina tones stay just as distinguishable
  // while claiming nothing about anyone's clearance.
  const borderColor = {
    athlete: 'border-[var(--brass-400)]',
    coach: 'border-[var(--brass-700)]',
    parent: 'border-[var(--patina-500)]',
    admin: 'border-[var(--hide-600)]'
  }[role];

  // This card intentionally shows no canned question/answer example. A prior
  // version displayed a hardcoded sample exchange (including, in the coach
  // case, specific fabricated athlete names and injury/readiness flags) as if
  // it were a live SHADOW response. Every response shown to a user must come
  // from the real chat below/linked here, never a static placeholder that
  // could be mistaken for real guidance about a real athlete.
  return (
    <div className={`border-l-4 ${borderColor} space-y-[var(--s3)] p-[var(--s4)] font-mono text-[length:var(--t-xs)]`}>
      {/* prompt-line, not a stated brass: this card renders on leather for the
          coach and admin and on canvas inside ParentHub, and --brass-400 is a
          leather ink -- on cream it measured ~2.9:1. The sheet restates the
          class per ground the way it does for the type voices. */}
      <p className="prompt-line">&gt; {roleIdentity}</p>
      <p className="t-body whitespace-pre-wrap">{description}</p>
      <ShadowChatButton
        context={chatContext}
        label="Ask SHADOW"
        className="btn btn--ghost"
      />
    </div>
  );
}
