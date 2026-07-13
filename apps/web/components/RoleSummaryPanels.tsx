'use client';

import React from 'react';

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
  attendancePercent: number;
  unreadMessages: number;
}

interface AdminSummaryPanelProps {
  gymAlerts: number;
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
  onAskShadow: () => void;
}

interface RoleSpecificShadowProps {
  role: 'athlete' | 'coach' | 'parent' | 'admin';
  query: string;
  response: string;
}

function getAttendanceColor(attendancePercent: number): string {
  if (attendancePercent >= 90) return 'bg-green-900/30 border-green-600';
  if (attendancePercent >= 75) return 'bg-yellow-900/30 border-yellow-600';
  return 'bg-red-900/30 border-red-600';
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
    GREEN: 'bg-green-900/30 border-green-600',
    YELLOW: 'bg-yellow-900/30 border-yellow-600',
    RED: 'bg-red-900/30 border-red-600'
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
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Status</p>
        <p className="mt-2 text-lg font-black text-white">{readinessText}</p>
      </div>

      {/* Tasks */}
      <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Tasks Due</p>
        <p className="mt-2 text-3xl font-black text-[#e8d7c6]">{tasksDue}</p>
      </div>

      {/* Goals */}
      <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Active Goals</p>
        <p className="mt-2 text-3xl font-black text-[#e8d7c6]">{goalsActive}</p>
      </div>

      {/* Upcoming Session */}
      <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4 md:col-span-1">
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Next Session</p>
        <p className="mt-2 text-sm font-semibold text-[#e8d7c6]">{upcomingSession || 'No session'}</p>
      </div>

      {/* Messages */}
      <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Messages</p>
        <p className="mt-2 text-3xl font-black text-[#e8d7c6]">{unreadMessages}</p>
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
  const injuryAlert = injuryFlags > 0 ? 'bg-red-900/30 border-red-600' : 'border-[#8b4444] bg-[#0f0f0f]';

  return (
    <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-5">
      {/* Session Status */}
      <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Session</p>
        <p className="mt-2 text-sm font-semibold text-[#e8d7c6]">{sessionStatus}</p>
      </div>

      {/* Active Athletes */}
      <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Athletes</p>
        <p className="mt-2 text-3xl font-black text-[#e8d7c6]">{activeAthletes}</p>
      </div>

      {/* Injury Flags */}
      <div className={`border-2 p-4 ${injuryAlert}`}>
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Injuries</p>
        <p className="mt-2 text-3xl font-black text-[#e8d7c6]">{injuryFlags}</p>
      </div>

      {/* Reviews */}
      <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Reviews</p>
        <p className="mt-2 text-3xl font-black text-[#e8d7c6]">{reviewsNeeded}</p>
      </div>

      {/* Assignments */}
      <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Due</p>
        <p className="mt-2 text-3xl font-black text-[#e8d7c6]">{assignmentsDue}</p>
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
      <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Progress</p>
        <p className="mt-2 text-sm font-semibold text-[#e8d7c6]">{childProgress}</p>
      </div>

      {/* Tasks */}
      <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Home Tasks</p>
        <p className="mt-2 text-3xl font-black text-[#e8d7c6]">{tasksDue}</p>
      </div>

      {/* Events */}
      <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Upcoming</p>
        <p className="mt-2 text-3xl font-black text-[#e8d7c6]">{upcomingEvents}</p>
      </div>

      {/* Attendance */}
      <div className={`border-2 p-4 ${attendanceColor}`}>
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Attendance</p>
        <p className="mt-2 text-3xl font-black text-[#e8d7c6]">{attendancePercent}%</p>
      </div>

      {/* Messages */}
      <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Messages</p>
        <p className="mt-2 text-3xl font-black text-[#e8d7c6]">{unreadMessages}</p>
      </div>
    </div>
  );
}

// ADMIN SUMMARY PANEL
export function AdminSummaryPanel({
  gymAlerts,
  boardAlerts,
  openAssignments,
  complianceItems,
  pendingReviews
}: Readonly<AdminSummaryPanelProps>) {
  const gymAlert = gymAlerts > 0 ? 'bg-red-900/30 border-red-600' : 'border-[#8b4444] bg-[#0f0f0f]';
  const boardAlert = boardAlerts > 0 ? 'bg-yellow-900/30 border-yellow-600' : 'border-[#8b4444] bg-[#0f0f0f]';

  return (
    <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-5">
      {/* Program Alerts */}
      <div className={`border-2 p-4 ${gymAlert}`}>
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Program</p>
        <p className="mt-2 text-3xl font-black text-[#e8d7c6]">{gymAlerts}</p>
      </div>

      {/* Board Alerts */}
      <div className={`border-2 p-4 ${boardAlert}`}>
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Board</p>
        <p className="mt-2 text-3xl font-black text-[#e8d7c6]">{boardAlerts}</p>
      </div>

      {/* Open Assignments */}
      <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Open</p>
        <p className="mt-2 text-3xl font-black text-[#e8d7c6]">{openAssignments}</p>
      </div>

      {/* Compliance */}
      <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Compliance</p>
        <p className="mt-2 text-3xl font-black text-[#e8d7c6]">{complianceItems}</p>
      </div>

      {/* Reviews */}
      <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-[#d4a574]">Reviews</p>
        <p className="mt-2 text-3xl font-black text-[#e8d7c6]">{pendingReviews}</p>
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
    <div className="border-l-4 border-[#d4a574] bg-[#1a1a1a] p-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between text-left"
      >
        <h3 className="text-sm font-semibold text-[#d4a574]">HELP: {title}</h3>
        <span className="text-xl text-[#d4a574]">{expanded ? '−' : '+'}</span>
      </button>

      {expanded && (
        <div className="mt-4 space-y-3 text-sm text-[#b0a095]">
          <div>
            <p className="font-semibold text-[#e8d7c6]">What it is:</p>
            <p>{description}</p>
          </div>
          <div>
            <p className="font-semibold text-[#e8d7c6]">How to use:</p>
            <ul className="list-inside list-disc space-y-1">
              {usage.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="font-semibold text-[#e8d7c6]">Common mistakes:</p>
            <ul className="list-inside list-disc space-y-1">
              {mistakes.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <button
            onClick={onAskShadow}
            className="mt-3 w-full border-2 border-[#d4a574] bg-[#0a0a0a] px-4 py-2 text-xs font-semibold uppercase text-[#d4a574] transition hover:bg-[#5a2a2a]"
          >
            ASK SHADOW
          </button>
        </div>
      )}
    </div>
  );
}

// ROLE-SPECIFIC SHADOW COMPONENT
export function RoleSpecificShadow({
  role,
  query,
  response
}: Readonly<RoleSpecificShadowProps>) {
  const roleIdentity = {
    athlete: 'SHADOW (ATHLETE MODE)',
    coach: 'SHADOW (COACH MODE)',
    parent: 'SHADOW (PARENT MODE)',
    admin: 'SHADOW (ADMIN MODE)'
  }[role];

  const borderColor = {
    athlete: 'border-blue-600',
    coach: 'border-[#d4a574]',
    parent: 'border-green-600',
    admin: 'border-[#8b4444]'
  }[role];

  return (
    <div className={`border-l-4 ${borderColor} space-y-2 bg-[#0f0f0f] p-4 font-mono text-xs`}>
      <p className="text-[#d4a574]">&gt; {roleIdentity}</p>
      <p className="text-[#b0a095]">&gt; {query}</p>
      <p className="mt-3 whitespace-pre-wrap text-[#e8d7c6]">{response}</p>
    </div>
  );
}
