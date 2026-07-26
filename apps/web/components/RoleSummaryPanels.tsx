'use client';

import React from 'react';

interface AthleteSummaryPanelProps {
  readiness: 'GREEN' | 'YELLOW' | 'RED' | null;
  tasksDue: number | null;
  goalsActive: number | null;
  upcomingSession?: string;
  unreadMessages: number | null;
}

interface CoachSummaryPanelProps {
  sessionStatus: string | null;
  rosterAthletes: number | null;
  healthReports: number | null;
  reviewsNeeded: number | null;
  assignmentsDue: number | null;
}

interface ParentSummaryPanelProps {
  childProgress: string;
  tasksDue: number;
  upcomingEvents: number;
  attendancePercent: number;
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
  onAskShadow?: () => void;
}

interface RoleSpecificShadowProps {
  role: 'athlete' | 'coach' | 'parent' | 'admin';
  query: string;
  response: string;
}

function getAttendanceColor(attendancePercent: number | null): string {
  if (attendancePercent === null) return 'border-[var(--black)] bg-[var(--canvas-tan-light)]';
  if (attendancePercent >= 90) return 'bg-[#dce7ca] border-[var(--status-ready)]';
  if (attendancePercent >= 75) return 'bg-[#efe3c4] border-[var(--status-warning)]';
  return 'bg-[#f1d6d1] border-[var(--red-primary)]';
}

function metricValue(value: number | null, unavailable = 'Unavailable'): string {
  return value === null ? unavailable : String(value);
}

// ATHLETE SUMMARY PANEL
export function AthleteSummaryPanel({
  readiness,
  tasksDue,
  goalsActive,
  upcomingSession,
  unreadMessages
}: Readonly<AthleteSummaryPanelProps>) {
  return (
    <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-5">
      {/* Readiness */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Reported Check-in</p>
        <p className="mt-2 text-lg font-black text-[var(--black)]">{readiness ?? 'Not reported'}</p>
        <p className="mt-1 text-xs text-[var(--gray-dark)]">Self-report only; not medical or sparring clearance.</p>
      </div>

      {/* Tasks */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Tasks Due</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{metricValue(tasksDue)}</p>
      </div>

      {/* Goals */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Active Goals</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{metricValue(goalsActive)}</p>
      </div>

      {/* Upcoming Session */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4 md:col-span-1">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Next Session</p>
        <p className="mt-2 text-sm font-semibold text-[var(--black)]">{upcomingSession || 'Not reported'}</p>
      </div>

      {/* Messages */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Messages</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{metricValue(unreadMessages)}</p>
      </div>
    </div>
  );
}

// COACH SUMMARY PANEL
export function CoachSummaryPanel({
  sessionStatus,
  rosterAthletes,
  healthReports,
  reviewsNeeded,
  assignmentsDue
}: Readonly<CoachSummaryPanelProps>) {
  const healthReportTone = healthReports !== null && healthReports > 0
    ? 'bg-[#f1d6d1] border-[var(--red-primary)]'
    : 'border-[var(--black)] bg-[var(--canvas-tan-light)]';

  return (
    <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-5">
      {/* Session Status */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Session</p>
        <p className="mt-2 text-sm font-semibold text-[var(--black)]">{sessionStatus ?? 'Unavailable'}</p>
      </div>

      {/* Active Athletes */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Roster</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{metricValue(rosterAthletes)}</p>
      </div>

      {/* Injury Flags */}
      <div className={`border-2 p-4 ${healthReportTone}`}>
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Health Reports</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{metricValue(healthReports, 'Not reported')}</p>
      </div>

      {/* Reviews */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Reviews</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{metricValue(reviewsNeeded)}</p>
      </div>

      {/* Assignments */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Due</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{metricValue(assignmentsDue)}</p>
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
  const attendanceColor = getAttendanceColor(attendancePercent);

  return (
    <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-5">
      {/* Progress */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Progress</p>
        <p className="mt-2 text-sm font-semibold text-[var(--black)]">{childProgress}</p>
      </div>

      {/* Tasks */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Home Tasks</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{tasksDue}</p>
      </div>

      {/* Events */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Upcoming</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{upcomingEvents}</p>
      </div>

      {/* Attendance */}
      <div className={`border-2 p-4 ${attendanceColor}`}>
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Attendance</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{attendancePercent}%</p>
      </div>

      {/* Messages */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Messages</p>
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
  const programAlert = programAlerts > 0 ? 'bg-[#f1d6d1] border-[var(--red-primary)]' : 'border-[var(--black)] bg-[var(--canvas-tan-light)]';
  const boardAlert = boardAlerts > 0 ? 'bg-[#efe3c4] border-[var(--status-warning)]' : 'border-[var(--black)] bg-[var(--canvas-tan-light)]';

  return (
    <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-5">
      {/* Program Alerts */}
      <div className={`border-2 p-4 ${programAlert}`}>
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Program</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{programAlerts}</p>
      </div>

      {/* Board Alerts */}
      <div className={`border-2 p-4 ${boardAlert}`}>
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Board</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{boardAlerts}</p>
      </div>

      {/* Open Assignments */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Open</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{openAssignments}</p>
      </div>

      {/* Compliance */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Compliance</p>
        <p className="mt-2 text-3xl font-black text-[var(--black)]">{complianceItems}</p>
      </div>

      {/* Reviews */}
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--red-primary)]">Reviews</p>
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
  onAskShadow
}: Readonly<HelpPanelProps>) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className="border-l-4 border-[var(--red-primary)] bg-[var(--canvas-tan)] p-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between text-left"
      >
        <h3 className="text-sm font-semibold text-[var(--red-primary)]">HELP: {title}</h3>
        <span className="text-xl text-[var(--red-primary)]">{expanded ? '−' : '+'}</span>
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
          {onAskShadow ? (
            <button
              onClick={onAskShadow}
              className="mt-3 w-full border-2 border-[var(--black)] bg-[var(--red-primary)] px-4 py-2 text-xs font-semibold uppercase text-[var(--canvas-tan-light)] transition hover:brightness-110"
            >
              ASK SHADOW
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ROLE-SPECIFIC SHADOW COMPONENT
export function RoleSpecificShadow({
  role
}: Readonly<RoleSpecificShadowProps>) {
  const roleIdentity = {
    athlete: 'SHADOW (ATHLETE MODE)',
    coach: 'SHADOW (COACH MODE)',
    parent: 'SHADOW (PARENT MODE)',
    admin: 'SHADOW (ADMIN MODE)'
  }[role];

  const borderColor = {
    athlete: 'border-[var(--status-ready)]',
    coach: 'border-[var(--red-primary)]',
    parent: 'border-[var(--status-warning)]',
    admin: 'border-[var(--black)]'
  }[role];

  return (
    <div className={`border-l-4 ${borderColor} space-y-2 bg-[var(--canvas-tan-light)] p-4 font-mono text-xs`}>
      <p className="text-[var(--red-primary)]">&gt; {roleIdentity}</p>
      <p className="text-[var(--gray-dark)]">&gt; Not connected yet</p>
      <p className="mt-3 whitespace-pre-wrap text-[var(--black)]">No verified live-data response is available on this panel. Open SHADOW Chat for an interactive response and confirm any consequential decision with a responsible human.</p>
    </div>
  );
}
