'use client';

import Link from 'next/link';
import React, { useState, useEffect } from 'react';
import AnnouncementBanner from './AnnouncementBanner';
import { ParentSummaryPanel, HelpPanel, RoleSpecificShadow } from './RoleSummaryPanels';
import ShadowChatButton from './ShadowChatButton';
import { cx } from './uiStyles';
import { apiBase } from '@/lib/apiBase';

type TabID = 'overview' | 'parent-floor' | 'home-assignments' | 'observations' | 'family-goals' | 'messages' | 'attendance' | 'progress' | 'resources' | 'shadow';

interface Child {
  id: string;
  name: string;
  track: string;
  attendancePercent: number | null;
  currentProgress: string | null;
}

interface HomeAssignment {
  id: string;
  title: string;
  dueDate: string;
  status: 'Pending' | 'In Progress' | 'Completed';
  description: string;
}

interface ParentObservation {
  id: string;
  category: string;
  value: number;
  notes: string;
}

interface FamilyGoal {
  id: string;
  title: string;
  supportAction: string;
  progress: number;
  targetDate: string;
}

interface ParentMessage {
  id: string;
  sender: 'coach';
  subject: string;
  body: string;
  date: string;
  read?: boolean;
}

interface AttendanceEntry {
  id: string;
  childId: string;
  date: string;
  session: string;
  status: 'Present' | 'Excused' | 'Absent';
}

interface UpcomingSession {
  id: string;
  date: string;
  time: string;
  title: string;
  focus: string;
}

interface ProgressMilestone {
  id: string;
  childId: string;
  category: string;
  title: string;
  percent: number;
  status: 'On Track' | 'Needs Work' | 'Achieved';
}

interface ParentResource {
  id: string;
  title: string;
  type: 'Guide' | 'Checklist' | 'Video' | 'Policy';
  summary: string;
  actionLabel: string;
}

/* This hub sits on the warm canvas ground (Law 6 — family-facing), so every
   tone below is mixed against paper, and every state pairs its colour with a
   glyph and an uppercase label via the .badge component (Law 3). */

function assignmentCardTone(status: HomeAssignment['status']): string {
  if (status === 'Completed') return 'bg-[color-mix(in_srgb,var(--cleared)_10%,var(--paper))] border-[color:var(--cleared)]';
  if (status === 'In Progress') return 'bg-[color-mix(in_srgb,var(--monitor)_10%,var(--paper))] border-[color:var(--monitor)]';
  return 'bg-[var(--paper)] border-[color:rgba(0,0,0,.18)]';
}

function assignmentBadge(status: HomeAssignment['status']): { className: string; glyph: string } {
  if (status === 'Completed') return { className: 'badge badge--cleared', glyph: '✓' };
  if (status === 'In Progress') return { className: 'badge badge--monitor', glyph: '◉' };
  return { className: 'badge badge--restricted', glyph: '▲' };
}

/* Selected tab / selected child: a control in the "on" position is brass
   chassis, never a status colour (Laws 1 and 2). */
const TAB_BASE =
  'inline-flex min-h-[44px] items-center rounded-[var(--r-sm)] border-2 px-[var(--s4)] font-mono text-[length:var(--t-xs)] font-bold uppercase tracking-[0.1em] transition focus-visible:outline-none focus-visible:shadow-[var(--focus)]';
const TAB_ACTIVE = 'border-[color:var(--brass-700)] bg-[var(--brass-500)] text-[color:var(--hide-950)]';
const TAB_INACTIVE =
  'border-[color:rgba(0,0,0,.18)] bg-[var(--paper-2)] text-[color:var(--hide-800)] hover:border-[color:var(--brass-700)]';

/* Progress on canvas: a brass fill on a recessed paper track — chrome, not a
   status claim. The percent is always printed next to it. */
const TRACK_CLASS = 'h-[8px] w-full rounded-[var(--r-pill)] border border-[color:rgba(0,0,0,.14)] bg-[var(--paper-2)]';
const FILL_CLASS = 'h-full rounded-[var(--r-pill)] bg-[var(--brass-600)]';

export default function ParentHub() {
  const [activeTab, setActiveTab] = useState<TabID>('overview');

  // Real API: Children (athletes accessible to parent)
  const [children, setChildren] = useState<Child[]>([]);
  const [childrenLoading, setChildrenLoading] = useState(true);
  const [childrenError, setChildrenError] = useState<string | null>(null);
  const [childrenRetryNonce, setChildrenRetryNonce] = useState(0);

  const [activeChildId, setActiveChildId] = useState<string | null>(null);

  const [homeAssignments] = useState<HomeAssignment[]>([]);

  const [parentObservations] = useState<ParentObservation[]>([]);

  const [familyGoals] = useState<FamilyGoal[]>([]);

  const [messages] = useState<ParentMessage[]>([]);

  const [attendanceEntries] = useState<AttendanceEntry[]>([]);

  const [upcomingSessions] = useState<UpcomingSession[]>([]);

  const [progressMilestones] = useState<ProgressMilestone[]>([]);

  const [parentResources] = useState<ParentResource[]>([]);

  const [newMessage, setNewMessage] = useState('');

  // Fetch parent's children (athletes) from API
  useEffect(() => {
    void (async () => {
      try {
        setChildrenLoading(true);
        setChildrenError(null);
        const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, {
          method: 'GET',
          credentials: 'include',
        });
        if (!response.ok) throw new Error('Failed to load children');
        
        const data = (await response.json()) as { items?: Array<{ athlete_id: string; full_name?: string }> };
        const items = data.items || [];
        
        // Do not fabricate attendance/progression values from index-based placeholders.
        const childList: Child[] = items.map((item) => {
          return {
            id: item.athlete_id,
            name: item.full_name || 'Unknown',
            track: 'Unavailable',
            attendancePercent: null,
            currentProgress: null,
          };
        });
        
        setChildren(childList);
        // Functional update so the default selection does not read activeChildId
        // here: depending on it would refetch the whole roster and re-show the
        // loading spinner every time the parent switches child.
        setActiveChildId((current) => current || childList[0]?.id || current);
      } catch (error) {
        setChildrenError(error instanceof Error ? error.message : 'Failed to load children');
        setChildren([]);
      } finally {
        setChildrenLoading(false);
      }
    })();
  }, [childrenRetryNonce]);

  const activeChild = children.find(c => c.id === activeChildId);
  const tasksDue = homeAssignments.filter(a => a.status !== 'Completed').length;
  const upcomingEvents = upcomingSessions.length;
  const hasLiveChildMetrics = activeChild?.attendancePercent !== null && Boolean(activeChild?.currentProgress);
  const activeAttendanceEntries = attendanceEntries.filter((entry) => entry.childId === activeChildId);
  const activeProgressMilestones = progressMilestones.filter((item) => item.childId === activeChildId);

  function milestoneStatusTone(status: ProgressMilestone['status']): string {
    if (status === 'Achieved') return 'border-[color:var(--cleared)] bg-[color-mix(in_srgb,var(--cleared)_10%,var(--paper))]';
    if (status === 'Needs Work') return 'border-[color:var(--restricted)] bg-[color-mix(in_srgb,var(--restricted)_10%,var(--paper))]';
    return 'border-[color:rgba(0,0,0,.18)] bg-[var(--paper)]';
  }

  function milestoneBadge(status: ProgressMilestone['status']): { className: string; glyph: string } {
    if (status === 'Achieved') return { className: 'badge badge--cleared', glyph: '✓' };
    if (status === 'Needs Work') return { className: 'badge badge--restricted', glyph: '▲' };
    return { className: 'badge badge--monitor', glyph: '◉' };
  }

  /* Attendance outcomes on canvas take the -deep rungs (the text weights the
     sheet ships for the warm ground) and always carry their glyph. */
  function attendanceStatusTone(status: AttendanceEntry['status']): string {
    if (status === 'Present') return 'text-[color:var(--cleared-deep)]';
    if (status === 'Excused') return 'text-[color:var(--restricted-deep)]';
    return 'text-[color:var(--locked-deep)]';
  }

  function attendanceGlyph(status: AttendanceEntry['status']): string {
    if (status === 'Present') return '✓';
    if (status === 'Excused') return '▲';
    return '✕';
  }

  return (
    /* Family-facing surface — the warm canvas ground itself (Law 6), stated on
       the full-bleed wrapper so every component inside restates for cream. */
    <div className="on-canvas min-h-screen rounded-[var(--r-lg)] font-sans text-[color:var(--hide-900)]">
      <div className="max-w-7xl mx-auto p-[var(--s4)] space-y-[var(--s6)]">
        {/* HEADER */}
        <div className="border-b-2 border-[color:var(--brass-700)] pb-[var(--s5)] space-y-[var(--s4)]">
          <div>
            <p className="t-eyebrow">Parent Support Hub</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-2xl)' }}>Family Development Dashboard</h1>
            <p className="t-body mt-[var(--s3)]">Support your child&apos;s boxing journey with at-home assignments, family goals, and coach communication.</p>
            <p className="t-label mt-[var(--s3)]">Old Gauze | Sweat | Grit | Grind | Dedication | Motivation</p>
          </div>
          <div className="flex flex-wrap gap-[var(--s3)]">
            <ShadowChatButton
              context="Parent Hub"
              label="Open SHADOW Chat"
            />
            <button
              type="button"
              onClick={() => setActiveTab('shadow')}
              className={`${TAB_BASE} ${TAB_INACTIVE}`}
            >
              Open SHADOW Intel Tab
            </button>
          </div>
        </div>

        {/* The placement vocabulary names no parent surface, so this hub asks
            for 'everywhere' and draws only gym-wide items. An author who wants
            parents to read something has to post it everywhere; nothing placed
            on the athlete or coach workspace reaches this page. */}
        <AnnouncementBanner
          placement="everywhere"
          kind="notice"
          heading="Gym Notices"
          className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)]"
        />
        <AnnouncementBanner
          placement="everywhere"
          kind="motivation"
          heading="From the Gym"
          className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)]"
        />

        <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)]">
          <p className="t-label">Family Commitment</p>
          <p className="t-body mt-[var(--s2)]">Consistency at home builds confidence in the gym. Every ride, reminder, and check-in strengthens grit and motivation.</p>
        </div>

        {/* ROLE SUMMARY PANEL */}
        <ParentSummaryPanel
          childProgress={activeChild?.currentProgress || 'Unavailable - awaiting backend progression feed'}
          tasksDue={tasksDue}
          upcomingEvents={upcomingEvents}
          attendancePercent={activeChild?.attendancePercent ?? null}
          unreadMessages={messages.filter(m => !m.read).length}
        />

        {!hasLiveChildMetrics && activeChild ? (
          <div className="mat-paper rounded-[var(--r-md)] p-[var(--s4)]">
            <p className="t-label">Data Availability</p>
            <p className="t-body mt-[var(--s2)]">Attendance and progression metrics are hidden until backend-authoritative feeds are available.</p>
          </div>
        ) : null}

        {/* CHILD SELECTOR */}
        {childrenLoading && (
          <div className="mat-paper rounded-[var(--r-md)] p-[var(--s4)] text-center">
            <p className="t-muted">Loading your children...</p>
            <div className="mt-[var(--s4)] flex justify-center">
              <div className="animate-spin h-5 w-5 rounded-[var(--r-pill)] border-2 border-[color:var(--brass-700)] border-t-transparent"></div>
            </div>
          </div>
        )}

        {childrenError && !childrenLoading && (
          <div
            className="rounded-[var(--r-md)] border-2 border-[color:var(--locked)] p-[var(--s4)]"
            style={{ background: 'color-mix(in srgb, var(--locked) 10%, var(--canvas-warm))' }}
            role="alert"
          >
            <div className="mb-[var(--s3)] flex items-center justify-between gap-[var(--s4)]">
              <span className="badge badge--locked"><i>✕</i>Failed</span>
              <button
                onClick={() => {
                  setChildrenError(null);
                  setChildrenRetryNonce((value) => value + 1);
                }}
                className="btn btn--ghost"
                aria-label="Retry loading children"
              >
                Retry
              </button>
            </div>
            <p className="t-body">Error loading children: {childrenError}</p>
          </div>
        )}

        {!childrenLoading && children.length === 0 && !childrenError && (
          <div className="mat-paper rounded-[var(--r-md)] p-[var(--s4)] text-center">
            <p className="t-muted">No children found</p>
          </div>
        )}

        {!childrenLoading && children.length > 0 && (
          <div className="mat-paper flex flex-wrap gap-[var(--s3)] rounded-[var(--r-md)] p-[var(--s3)]">
            {children.map(child => (
              <button
                key={child.id}
                onClick={() => setActiveChildId(child.id)}
                className={cx(
                  TAB_BASE,
                  activeChildId === child.id ? TAB_ACTIVE : TAB_INACTIVE,
                )}
              >
                {child.name}
              </button>
            ))}
          </div>
        )}

        {/* TAB NAVIGATION */}
        <div className="mat-paper rounded-[var(--r-md)]">
          <div className="flex flex-wrap gap-[var(--s2)] p-[var(--s3)]">
            {[
              { id: 'overview', label: 'Overview' },
              { id: 'parent-floor', label: 'Parent Floor' },
              { id: 'home-assignments', label: 'Assignments' },
              { id: 'observations', label: 'Observations' },
              { id: 'family-goals', label: 'Family Goals' },
              { id: 'messages', label: 'Messages' },
              { id: 'attendance', label: 'Attendance' },
              { id: 'progress', label: 'Progress' },
              { id: 'resources', label: 'Resources' },
              { id: 'shadow', label: 'SHADOW Intel' }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as TabID)}
                className={cx(
                  TAB_BASE,
                  activeTab === tab.id ? TAB_ACTIVE : TAB_INACTIVE,
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* TAB CONTENT */}
        <div className="space-y-6">
          {/* OVERVIEW */}
          {activeTab === 'overview' && (
            <div className="space-y-6 animate-fadeIn">
              <section className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)]">
                <h3 className="t-label">Quick Actions</h3>
                <div className="mt-[var(--s4)] grid gap-[var(--s3)] md:grid-cols-2 lg:grid-cols-4">
                  <ShadowChatButton
                    context="Parent Overview"
                    label="SHADOW Chat"
                  />
                  <Link href="/schedule" className="btn w-full">
                    Open Scheduler
                  </Link>
                  <button
                    type="button"
                    onClick={() => setActiveTab('home-assignments')}
                    className="btn w-full"
                  >
                    Open Assignments
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('attendance')}
                    className="btn btn--ghost w-full"
                  >
                    Check Attendance
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('messages')}
                    className="btn btn--ghost w-full"
                  >
                    View Coach Messages
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('shadow')}
                    className="btn btn--ghost w-full"
                  >
                    Open SHADOW Intel
                  </button>
                </div>
              </section>

              <HelpPanel
                title="Child Overview"
                description="Quick snapshot of your child's current training status, progress, and upcoming events."
                usage={[
                  'Review current track and skill level',
                  'Check attendance and progress summary',
                  'See upcoming events and important dates',
                  'Review coach messages'
                ]}
                mistakes={[
                  'Not staying informed about upcoming events',
                  'Missing coach communication',
                  'Overlooking skill milestones'
                ]}
              />

              {activeChild && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--s5)]">
                  <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
                    <h3 className="t-label">Current Status</h3>
                    <div className="space-y-[var(--s4)]">
                      <div>
                        <p className="t-label mb-[var(--s2)]">Child Name</p>
                        <p className="t-body font-semibold">{activeChild.name}</p>
                      </div>
                      <div>
                        <p className="t-label mb-[var(--s2)]">Current Track</p>
                        <p className="t-body font-semibold">{activeChild.track}</p>
                      </div>
                      <div>
                        <p className="t-label mb-[var(--s2)]">Progress</p>
                        <p className="t-body font-semibold">{activeChild.currentProgress || 'Unavailable - awaiting backend progression feed'}</p>
                      </div>
                      <div>
                        <p className="t-label mb-[var(--s2)]">Attendance</p>
                        {activeChild.attendancePercent !== null ? (
                          <p className="t-data" style={{ fontSize: 'var(--t-sm)' }}>{activeChild.attendancePercent}%</p>
                        ) : (
                          <p className="t-body font-semibold">Unavailable - not yet tracked</p>
                        )}
                      </div>
                      {/* Membership/scholarship/community-service status has no
                          backing column anywhere in the schema -- these used to
                          be hardcoded to the same "supported" values for every
                          family regardless of their actual status, which is a
                          real billing-adjacent misstatement, not a placeholder.
                          Show unavailable honestly until a real field exists. */}
                      <div>
                        <p className="t-label mb-[var(--s2)]">Membership Status</p>
                        <p className="t-muted">Unavailable - not yet tracked</p>
                      </div>
                      <div>
                        <p className="t-label mb-[var(--s2)]">Scholarship Status</p>
                        <p className="t-muted">Unavailable - not yet tracked</p>
                      </div>
                      <div>
                        <p className="t-label mb-[var(--s2)]">Community Service Support Status</p>
                        <p className="t-muted">Unavailable - not yet tracked</p>
                      </div>
                    </div>
                  </div>

                  <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
                    <h3 className="t-label">How to Support</h3>
                    <ul className="space-y-[var(--s3)] t-body">
                      <li className="flex items-start gap-[var(--s3)]">
                        <span aria-hidden="true">✓</span>
                        <span>Attend training sessions consistently</span>
                      </li>
                      <li className="flex items-start gap-[var(--s3)]">
                        <span aria-hidden="true">✓</span>
                        <span>Support home assignments and drills</span>
                      </li>
                      <li className="flex items-start gap-[var(--s3)]">
                        <span aria-hidden="true">✓</span>
                        <span>Maintain nutrition and sleep</span>
                      </li>
                      <li className="flex items-start gap-[var(--s3)]">
                        <span aria-hidden="true">✓</span>
                        <span>Stay informed through coach messages</span>
                      </li>
                    </ul>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* PARENT FLOOR */}
          {activeTab === 'parent-floor' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Parent Floor"
                description="Your at-home support tasks. Track drills, assignments, and parent verification items."
                usage={[
                  'Review this week\'s parent support tasks',
                  'Help with assigned home drills',
                  'Track completion status',
                  'Report progress back to coaches'
                ]}
                mistakes={[
                  'Forgetting to review home assignments',
                  'Not providing dedicated practice time',
                  'Missing reporting deadlines'
                ]}
              />

              <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
                <h3 className="t-label">This Week&apos;s Parent Support Tasks</h3>
                {/* Not-built-yet is a statement of fact, not a refusal or a
                    safety state, so it wears the label voice — never the
                    safety gate's red (Law 2). */}
                <p className="t-label max-w-[520px]">
                  PLANNED | NOT YET IMPLEMENTED
                </p>
                <p className="t-body">
                  There is no parent-task assignment feed wired to the backend yet. The checklist and progress
                  bar previously shown here were hardcoded example data, not real tasks -- they have been
                  removed rather than left showing fake completion status. Home assignments from your child&apos;s
                  coach appear in the Assignments tab once that feed is connected.
                </p>
              </div>
            </div>
          )}

          {/* HOME ASSIGNMENTS */}
          {activeTab === 'home-assignments' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Home Assignments"
                description="Coach-assigned work for home practice. Videos, drills, reflections, and skill development."
                usage={[
                  'Review assignment details and due dates',
                  'Support your child with execution',
                  'Upload evidence if requested',
                  'Mark completion status'
                ]}
                mistakes={[
                  'Missing assignment deadlines',
                  'Not understanding assignment goals',
                  'Skipping optional evidence uploads'
                ]}
              />

              <p className="t-label">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed for home assignments yet, so this
                list is always empty.
              </p>

              <div className="space-y-[var(--s4)]">
                {homeAssignments.map(assignment => {
                  const badge = assignmentBadge(assignment.status);
                  return (
                    <div key={assignment.id} className={`border-2 p-[var(--s4)] rounded-[var(--r-md)] ${assignmentCardTone(assignment.status)}`}>
                      <div className="flex justify-between items-start gap-[var(--s3)] mb-[var(--s3)]">
                        <h4 className="t-body font-semibold">{assignment.title}</h4>
                        <span className={badge.className}><i>{badge.glyph}</i>{assignment.status}</span>
                      </div>
                      <p className="t-body mb-[var(--s3)]">{assignment.description}</p>
                      <p className="t-muted">Due: {assignment.dueDate}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* OBSERVATIONS */}
          {activeTab === 'observations' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Parent Observations"
                description="Record what you notice at home about your child's energy, motivation, stress, and development."
                usage={[
                  'Note energy and motivation levels',
                  'Track sleep and recovery',
                  'Observe behavior changes',
                  'Report concerns to coaches'
                ]}
                mistakes={[
                  'Not reporting concerning changes',
                  'Minimizing stress or pain mentions',
                  'Not sharing positive observations'
                ]}
              />

              <p className="t-label">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed or entry form for parent observations
                yet, so this section is always empty.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--s4)]">
                {parentObservations.map(obs => (
                  <div key={obs.id} className="mat-paper rounded-[var(--r-md)] p-[var(--s4)] space-y-[var(--s3)]">
                    <h4 className="t-body font-semibold">{obs.category}</h4>
                    <div>
                      <div className="flex justify-between mb-[var(--s2)]">
                        <span className="t-label">Rating</span>
                        <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>{obs.value}/10</span>
                      </div>
                      <div className={TRACK_CLASS}>
                        <div className={FILL_CLASS} style={{width: `${obs.value * 10}%`}}></div>
                      </div>
                    </div>
                    {obs.notes && (
                      <p className="t-muted italic mt-[var(--s3)]">{obs.notes}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* FAMILY GOALS */}
          {activeTab === 'family-goals' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Family Goals"
                description="Collaborative family goals that support your child's boxing journey."
                usage={[
                  'Review family support goals',
                  'Track progress toward goals',
                  'Work together as a family',
                  'Celebrate achievements'
                ]}
                mistakes={[
                  'Setting unrealistic goals',
                  'Not reviewing progress regularly',
                  'Not involving the whole family'
                ]}
              />

              <p className="t-label">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed for family goals yet, so this section
                is always empty.
              </p>

              <div className="space-y-[var(--s4)]">
                {familyGoals.map(goal => (
                  <div key={goal.id} className="mat-paper rounded-[var(--r-md)] p-[var(--s4)] space-y-[var(--s4)]">
                    <div className="flex justify-between items-start gap-[var(--s3)]">
                      <h4 className="t-body font-semibold">{goal.title}</h4>
                      <span className="t-muted">{goal.targetDate}</span>
                    </div>
                    <p className="t-body">{goal.supportAction}</p>
                    <div>
                      <div className="flex justify-between mb-[var(--s2)]">
                        <span className="t-label">Progress</span>
                        <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>{goal.progress}%</span>
                      </div>
                      <div className={TRACK_CLASS}>
                        <div className={FILL_CLASS} style={{width: `${goal.progress}%`}}></div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* MESSAGES */}
          {activeTab === 'messages' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Coach Messages"
                description="Receive updates and messages from coaches about your child's progress."
                usage={[
                  'Check regularly for coach updates',
                  'Respond to coach requests promptly',
                  'Ask questions about training',
                  'Share relevant home observations'
                ]}
                mistakes={[
                  'Ignoring coach messages',
                  'Delayed responses to urgent matters',
                  'Not sharing important information'
                ]}
              />

              <p className="t-label">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed for coach messages yet, so this list
                is always empty.
              </p>

              <div className="space-y-[var(--s4)] max-h-96 overflow-y-auto">
                {messages.map(msg => (
                  <div key={msg.id} className="mat-paper rounded-[var(--r-md)] p-[var(--s4)]">
                    <div className="flex justify-between items-start gap-[var(--s3)] mb-[var(--s3)]">
                      <h4 className="t-body font-semibold">{msg.subject}</h4>
                      <span className="t-label">From Coach</span>
                    </div>
                    <p className="t-body mb-[var(--s3)]">{msg.body}</p>
                    <p className="t-muted">{msg.date}</p>
                  </div>
                ))}
              </div>

              <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)] space-y-[var(--s4)]">
                <h4 className="t-label">Reply to Coach</h4>
                <p className="t-label">
                  PLANNED | NOT YET IMPLEMENTED
                </p>
                <p className="t-muted">
                  There is no coach-messaging backend yet. This field is disabled so a message can&apos;t be typed
                  and silently discarded -- until this is wired up, contact your child&apos;s coach directly.
                </p>
                <textarea
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="Messaging is not yet available."
                  disabled
                  className="textarea h-20 resize-none cursor-not-allowed opacity-60"
                />
                <button
                  type="button"
                  disabled
                  className="btn cursor-not-allowed opacity-50 grayscale"
                >
                  Send Message (unavailable)
                </button>
              </div>
            </div>
          )}

          {/* ATTENDANCE */}
          {activeTab === 'attendance' && (
            <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)] animate-fadeIn">
              <h3 className="t-label">Attendance Tracking</h3>
              <p className="t-body">View attendance history and upcoming sessions.</p>
              <p className="t-label">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed for attendance history or upcoming
                sessions yet, so these lists are always empty.
              </p>

              <div className="space-y-[var(--s3)]">
                {activeAttendanceEntries.map((entry) => (
                  <div key={entry.id} className="flex flex-wrap items-center justify-between gap-[var(--s4)] rounded-[var(--r-md)] border border-[color:rgba(0,0,0,.14)] bg-[var(--paper-2)] p-[var(--s4)]">
                    <div>
                      <p className="t-body font-semibold">{entry.date} | {entry.session}</p>
                    </div>
                    <span className={`text-[length:var(--t-sm)] font-semibold uppercase ${attendanceStatusTone(entry.status)}`}>
                      <span aria-hidden="true">{attendanceGlyph(entry.status)}</span> {entry.status}
                    </span>
                  </div>
                ))}
              </div>

              <div className="rounded-[var(--r-md)] border border-[color:rgba(0,0,0,.14)] bg-[var(--paper-2)] p-[var(--s4)] space-y-[var(--s3)]">
                <h4 className="t-body font-semibold">Upcoming Sessions</h4>
                {upcomingSessions.map((session) => (
                  <div key={session.id} className="t-body">
                    <p><strong>{session.date} {session.time}</strong> - {session.title}</p>
                    <p>Focus: {session.focus}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* PROGRESS */}
          {activeTab === 'progress' && (
            <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)] animate-fadeIn">
              <h3 className="t-label">Progress & Achievements</h3>
              <p className="t-body">Track skill development and milestone achievements.</p>

              <details className="rounded-[var(--r-md)] border border-[color:rgba(0,0,0,.14)] bg-[var(--paper-2)] p-[var(--s4)]">
                <summary className="t-body cursor-pointer font-semibold">Parent-Support Visibility Placeholder</summary>
                <p className="t-label mt-[var(--s3)]">
                  CLOSED-LOOP PROGRESSION INTELLIGENCE - PLANNED | FRONT-END PLACEHOLDER | BACKEND REQUIRED
                </p>
                <Link href="/parent/progression-visibility" className="btn btn--ghost mt-[var(--s3)]">
                  Open Parent Progression Visibility
                </Link>
              </details>

              <p className="t-label">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed for progress milestones yet, so this
                list is always empty.
              </p>

              <div className="space-y-[var(--s4)]">
                {activeProgressMilestones.map((milestone) => {
                  const badge = milestoneBadge(milestone.status);
                  return (
                    <div key={milestone.id} className={`rounded-[var(--r-md)] border-2 p-[var(--s4)] ${milestoneStatusTone(milestone.status)}`}>
                      <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
                        <p className="t-body font-semibold">{milestone.category}: {milestone.title}</p>
                        <span className={badge.className}><i>{badge.glyph}</i>{milestone.status}</span>
                      </div>
                      <div className="mt-[var(--s3)]">
                        <div className="flex justify-between mb-[var(--s2)]">
                          <span className="t-label">Progress</span>
                          <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>{milestone.percent}%</span>
                        </div>
                        <div className={TRACK_CLASS}>
                          <div className={FILL_CLASS} style={{ width: `${milestone.percent}%` }}></div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* RESOURCES */}
          {activeTab === 'resources' && (
            <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)] animate-fadeIn">
              <h3 className="t-label">Parent Support Resources</h3>
              <p className="t-body">Guides, videos, and tips for supporting young athletes.</p>
              <p className="t-label">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed for parent resources yet, so this
                list is always empty.
              </p>
              <div className="space-y-[var(--s3)]">
                {parentResources.map((resource) => (
                  <div key={resource.id} className="rounded-[var(--r-md)] border border-[color:rgba(0,0,0,.14)] bg-[var(--paper-2)] p-[var(--s4)]">
                    <p className="t-body font-semibold">{resource.title}</p>
                    <p className="t-muted mt-[var(--s2)]">Type: {resource.type}</p>
                    <p className="t-body mt-[var(--s2)]">{resource.summary}</p>
                    <button className="btn mt-[var(--s3)]">
                      {resource.actionLabel}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SHADOW AI */}
          {activeTab === 'shadow' && (
            <div className="space-y-6 animate-fadeIn">
              <RoleSpecificShadow
                role="parent"
                description="Ask SHADOW how to support your child at home. Tap below to open a live chat scoped to your family -- there is no canned answer here."
                chatContext="Parent Hub"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

