'use client';

import React from 'react';
import { RabbitHole, type RabbitHoleAnchor } from './RabbitHole';
import ShadowChatButton from './ShadowChatButton';

interface AthleteSummaryPanelProps {
  readiness: 'GREEN' | 'YELLOW' | 'RED';
  tasksDue: number;
  goalsActive: number;
  upcomingSession?: string;
  unreadMessages: number;
}

interface CoachSummaryPanelProps {
  sessionStatus: string;
  activeAthletes: number;
  injuryFlags: number;
  reviewsNeeded: number;
  assignmentsDue: number;
}

interface ParentSummaryPanelProps {
  childProgress: string;
  tasksDue: number;
  upcomingEvents: number;
  attendancePercent: number | null;
  unreadMessages: number;
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

function getAttendanceColor(attendancePercent: number): string {
  if (attendancePercent >= 90) return 'bg-[color-mix(in_srgb,var(--cleared)_16%,var(--canvas-tan-light))] border-[var(--status-ready)]';
  if (attendancePercent >= 75) return 'bg-[color-mix(in_srgb,var(--restricted)_16%,var(--canvas-tan-light))] border-[var(--status-warning)]';
  return 'bg-[color-mix(in_srgb,var(--locked)_16%,var(--canvas-tan-light))] border-[color:var(--locked)]';
}

// ATHLETE SUMMARY PANEL
export function AthleteSummaryPanel({
  readiness,
  tasksDue,
  goalsActive,
  upcomingSession,
  unreadMessages
}: Readonly<AthleteSummaryPanelProps>) {
  const readinessColor = {
    GREEN: 'bg-[color-mix(in_srgb,var(--cleared)_16%,var(--canvas-tan-light))] border-[var(--status-ready)]',
    YELLOW: 'bg-[color-mix(in_srgb,var(--restricted)_16%,var(--canvas-tan-light))] border-[var(--status-warning)]',
    RED: 'bg-[color-mix(in_srgb,var(--locked)_16%,var(--canvas-tan-light))] border-[color:var(--locked)]'
  }[readiness];

  const readinessText = {
    GREEN: 'READY FOR TRAINING',
    YELLOW: 'MODIFY TRAINING',
    RED: 'COACH REVIEW REQUIRED'
  }[readiness];

  return (
    <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-5">
      {/* Readiness */}
      <div className={`border-2 p-4 ${readinessColor}`}>
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Status</p>
        <p className="mt-2 text-lg font-black text-[var(--black)]">{readinessText}</p>
      </div>

      {/* Tasks */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Tasks Due</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{tasksDue}</p>
      </div>

      {/* Goals */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Active Goals</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{goalsActive}</p>
      </div>

      {/* Upcoming Session */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4 md:col-span-1">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Next Session</p>
        <p className="mt-2 text-sm font-semibold text-[var(--black)]">{upcomingSession || 'No session'}</p>
      </div>

      {/* Messages */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Messages</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{unreadMessages}</p>
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
  const injuryAlert = injuryFlags > 0 ? 'bg-[color-mix(in_srgb,var(--locked)_16%,var(--canvas-tan-light))] border-[color:var(--locked)]' : 'border-[var(--black)] bg-[var(--canvas-tan-light)]';

  return (
    <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-5">
      {/* Session Status */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Session</p>
        <p className="mt-2 text-sm font-semibold text-[var(--black)]">{sessionStatus}</p>
      </div>

      {/* Active Athletes */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Athletes</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{activeAthletes}</p>
      </div>

      {/* Injury Flags */}
      <div className={`border-2 p-4 ${injuryAlert}`}>
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Injuries</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{injuryFlags}</p>
      </div>

      {/* Reviews */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Reviews</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{reviewsNeeded}</p>
      </div>

      {/* Assignments */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Due</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{assignmentsDue}</p>
      </div>
    </div>
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
  // null means no attendance data has been tracked yet -- must render as a
  // neutral "no data" state, not a colored/numeric band. Feeding null
  // through as 0 would color-code an absence of data as the same red
  // "bad attendance" band a genuinely low percentage gets.
  const attendanceColor = attendancePercent === null
    ? 'bg-[var(--canvas-tan-light)] border-[var(--black)]'
    : getAttendanceColor(attendancePercent);

  return (
    <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-5">
      {/* Progress */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Progress</p>
        <p className="mt-2 text-sm font-semibold text-[var(--black)]">{childProgress}</p>
      </div>

      {/* Tasks */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Home Tasks</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{tasksDue}</p>
      </div>

      {/* Events */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Upcoming</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{upcomingEvents}</p>
      </div>

      {/* Attendance */}
      <div className={`border-2 p-4 ${attendanceColor}`}>
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Attendance</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{attendancePercent === null ? 'Unavailable' : `${attendancePercent}%`}</p>
      </div>

      {/* Messages */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Messages</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{unreadMessages}</p>
      </div>
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
  const programAlert = programAlerts > 0 ? 'bg-[color-mix(in_srgb,var(--locked)_16%,var(--canvas-tan-light))] border-[color:var(--locked)]' : 'border-[var(--black)] bg-[var(--canvas-tan-light)]';
  const boardAlert = boardAlerts > 0 ? 'bg-[color-mix(in_srgb,var(--restricted)_16%,var(--canvas-tan-light))] border-[var(--status-warning)]' : 'border-[var(--black)] bg-[var(--canvas-tan-light)]';

  return (
    <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-5">
      {/* Program Alerts */}
      <div className={`border-2 p-4 ${programAlert}`}>
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Program</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{programAlerts}</p>
      </div>

      {/* Board Alerts */}
      <div className={`border-2 p-4 ${boardAlert}`}>
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Board</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{boardAlerts}</p>
      </div>

      {/* Open Assignments */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Open</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{openAssignments}</p>
      </div>

      {/* Compliance */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Compliance</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{complianceItems}</p>
      </div>

      {/* Reviews */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--accent-quiet)]">Reviews</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{pendingReviews}</p>
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
    <div className="border-l-4 border-[var(--accent)] bg-[var(--canvas-tan)] p-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex min-h-[44px] w-full items-center justify-between text-left"
        aria-expanded={expanded}
      >
        <h3 className="text-sm font-semibold text-[var(--accent-quiet)]">HELP: {title}</h3>
        <span aria-hidden="true" className="text-xl text-[var(--accent-quiet)]">{expanded ? '−' : '+'}</span>
      </button>

      {expanded && (
        <div className="mt-4 space-y-3 text-sm text-[var(--gray-dark)]">
          <div>
            <p className="font-semibold text-[var(--black)]">What it is:</p>
            <p>{description}</p>
          </div>
          <div>
            <p className="font-semibold text-[var(--black)]">How to use:</p>
            <ul className="list-inside list-disc space-y-1">
              {usage.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="font-semibold text-[var(--black)]">Common mistakes:</p>
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
              className="mt-3 min-h-[44px] w-full border-2 border-[var(--black)] bg-[var(--accent)] px-4 py-2 text-xs font-semibold uppercase text-[var(--accent-ink)] transition hover:brightness-110"
            >
              ASK SHADOW
            </button>
          ) : (
            <ShadowChatButton
              context={title}
              label="ASK SHADOW"
              className="mt-3 min-h-[44px] w-full border-[var(--black)] bg-[var(--accent)] text-[var(--accent-ink)] hover:brightness-110"
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
    <div className={`border-l-4 ${borderColor} space-y-3 bg-[var(--canvas-tan-light)] p-4 font-mono text-xs`}>
      <p className="text-[var(--accent-quiet)]">&gt; {roleIdentity}</p>
      <p className="whitespace-pre-wrap text-[var(--black)]">{description}</p>
      <ShadowChatButton
        context={chatContext}
        label="Ask SHADOW"
        className="border-[var(--black)] bg-[var(--canvas-tan-light)] text-[var(--black)] hover:bg-[var(--canvas-tan-dark)]"
      />
    </div>
  );
}
