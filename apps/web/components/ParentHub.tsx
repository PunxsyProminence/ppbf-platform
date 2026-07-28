'use client';

import Link from 'next/link';
import React, { useState, useEffect } from 'react';
import { ParentSummaryPanel, HelpPanel, RoleSpecificShadow } from './RoleSummaryPanels';
import ShadowChatButton from './ShadowChatButton';
import { cx, ui } from './uiStyles';

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

function assignmentCardTone(status: HomeAssignment['status']): string {
  if (status === 'Completed') return 'bg-green-900/20 border-green-700';
  if (status === 'In Progress') return 'bg-yellow-900/20 border-yellow-700';
  return 'bg-[#1a1a1a] border-[#8b4444]';
}

function assignmentBadgeTone(status: HomeAssignment['status']): string {
  if (status === 'Completed') return 'bg-green-900 text-green-200';
  if (status === 'In Progress') return 'bg-yellow-900 text-yellow-200';
  return 'bg-[#4a4a4a] text-[#8a8a8a]';
}

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
        const response = await fetch('/api/pilot/athletes/list', {
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
        if (childList.length > 0 && !activeChildId) {
          setActiveChildId(childList[0].id);
        }
      } catch (error) {
        setChildrenError(error instanceof Error ? error.message : 'Failed to load children');
        setChildren([]);
      } finally {
        setChildrenLoading(false);
      }
    })();
  }, [activeChildId, childrenRetryNonce]);

  const activeChild = children.find(c => c.id === activeChildId);
  const tasksDue = homeAssignments.filter(a => a.status !== 'Completed').length;
  const upcomingEvents = upcomingSessions.length;
  const hasLiveChildMetrics = activeChild?.attendancePercent !== null && Boolean(activeChild?.currentProgress);
  const activeAttendanceEntries = attendanceEntries.filter((entry) => entry.childId === activeChildId);
  const activeProgressMilestones = progressMilestones.filter((item) => item.childId === activeChildId);

  function milestoneStatusTone(status: ProgressMilestone['status']): string {
    if (status === 'Achieved') return 'border-green-700 bg-green-900/20 text-green-200';
    if (status === 'Needs Work') return 'border-yellow-700 bg-yellow-900/20 text-yellow-200';
    return 'border-[#8b4444] bg-[#1a1a1a] text-[#e8d7c6]';
  }

  function attendanceStatusTone(status: AttendanceEntry['status']): string {
    if (status === 'Present') return 'text-green-300';
    if (status === 'Excused') return 'text-yellow-300';
    return 'text-red-300';
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6] font-sans">
      <div className="max-w-7xl mx-auto p-4 space-y-8">
        {/* HEADER */}
        <div className="border-b-2 border-[#8b4444] pb-6 space-y-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.15em] text-[#d4a574]">Parent Support Hub</p>
            <h1 className="text-3xl md:text-4xl font-black mt-2">Family Development Dashboard</h1>
            <p className="text-base text-[#b0a095] mt-2">Support your child&apos;s boxing journey with at-home assignments, family goals, and coach communication.</p>
            <p className="text-sm font-mono uppercase tracking-[0.14em] text-[#cfbfae] mt-2">Old Gauze | Sweat | Grit | Grind | Dedication | Motivation</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <ShadowChatButton
              context="Parent Hub"
              label="Open SHADOW Chat"
              className="border-[#8b4444] bg-[#2a1414] text-[#e8d7c6] hover:bg-[#3a1a1a]"
            />
            <button
              type="button"
              onClick={() => setActiveTab('shadow')}
              className="min-h-[40px] border-2 border-[#5a4a3a] bg-[#101010] px-3 text-xs font-mono font-bold uppercase tracking-[0.12em] text-[#cfbfae] transition hover:border-[#8b4444]"
            >
              Open SHADOW Intel Tab
            </button>
          </div>
        </div>

        <div className="border border-[#694838] bg-[#14100d] p-4">
          <p className="text-sm text-[#d4a574] font-semibold">Family Commitment</p>
          <p className="mt-1 text-sm text-[#cfbfae]">Consistency at home builds confidence in the gym. Every ride, reminder, and check-in strengthens grit and motivation.</p>
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
          <div className="border border-[#8b4444] bg-[#14100d] p-3">
            <p className="text-xs font-mono uppercase tracking-[0.1em] text-[#d4a574]">Data Availability</p>
            <p className="mt-1 text-sm text-[#cfbfae]">Attendance and progression metrics are hidden until backend-authoritative feeds are available.</p>
          </div>
        ) : null}

        {/* CHILD SELECTOR */}
        {childrenLoading && (
          <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4 text-center">
            <p className="text-[#b0a095] text-sm">Loading your children...</p>
            <div className="mt-3 flex justify-center">
              <div className="animate-spin h-5 w-5 border-2 border-[#d4a574] border-t-transparent rounded-full"></div>
            </div>
          </div>
        )}
        
        {childrenError && !childrenLoading && (
          <div className="border-2 border-red-600 bg-red-900/20 p-3 rounded">
            <div className="flex items-center justify-between mb-1">
              <p className="text-red-400 text-sm font-semibold">Error loading children</p>
              <button
                onClick={() => {
                  setChildrenError(null);
                  setChildrenRetryNonce((value) => value + 1);
                }}
                className="px-2 py-0.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold uppercase transition"
                aria-label="Retry loading children"
              >
                Retry
              </button>
            </div>
            <p className="text-red-300 text-xs">{childrenError}</p>
          </div>
        )}
        
        {!childrenLoading && children.length === 0 && !childrenError && (
          <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4 text-center">
            <p className="text-[#b0a095] text-sm">No children found</p>
          </div>
        )}
        
        {!childrenLoading && children.length > 0 && (
          <div className="flex flex-wrap gap-2 border-2 border-[#8b4444] bg-[#0f0f0f] p-3">
            {children.map(child => (
              <button
                key={child.id}
                onClick={() => setActiveChildId(child.id)}
                className={cx(
                  ui.modeButtonBase,
                  activeChildId === child.id ? ui.modeButtonActive : ui.modeButtonInactive,
                )}
              >
                {child.name}
              </button>
            ))}
          </div>
        )}

        {/* TAB NAVIGATION */}
        <div className={ui.tabContainer}>
          <div className={ui.tabRow}>
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
                  ui.tabButtonBase,
                  activeTab === tab.id ? ui.tabButtonActive : ui.tabButtonInactive,
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
              <section className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
                <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Quick Actions</h3>
                <div className="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-4">
                  <ShadowChatButton
                    context="Parent Overview"
                    label="SHADOW Chat"
                    className="min-h-[44px] border-[#8b4444] bg-[#2a1414] text-[#e8d7c6] hover:bg-[#3a1a1a]"
                  />
                  <Link
                    href="/schedule"
                    className="min-h-[44px] border border-[#8b4444] bg-[#2a1414] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[#e8d7c6] transition hover:bg-[#3a1a1a] inline-flex items-center justify-center"
                  >
                    Open Scheduler
                  </Link>
                  <button
                    type="button"
                    onClick={() => setActiveTab('home-assignments')}
                    className="min-h-[44px] border border-[#8b4444] bg-[#2a1414] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[#e8d7c6] transition hover:bg-[#3a1a1a]"
                  >
                    Open Assignments
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('attendance')}
                    className="min-h-[44px] border border-[#5a4a3a] bg-[#101010] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[#cfbfae] transition hover:border-[#8b4444]"
                  >
                    Check Attendance
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('messages')}
                    className="min-h-[44px] border border-[#5a4a3a] bg-[#101010] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[#cfbfae] transition hover:border-[#8b4444]"
                  >
                    View Coach Messages
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('shadow')}
                    className="min-h-[44px] border border-[#5a4a3a] bg-[#101010] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[#cfbfae] transition hover:border-[#8b4444]"
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
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className={ui.panelSpaced}>
                    <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Current Status</h3>
                    <div className="space-y-3">
                      <div>
                        <p className="text-xs text-[#b0a095] block mb-1">Child Name</p>
                        <p className="text-base font-semibold">{activeChild.name}</p>
                      </div>
                      <div>
                        <p className="text-xs text-[#b0a095] block mb-1">Current Track</p>
                        <p className="text-base font-semibold">{activeChild.track}</p>
                      </div>
                      <div>
                        <p className="text-xs text-[#b0a095] block mb-1">Progress</p>
                        <p className="text-base font-semibold">{activeChild.currentProgress || 'Unavailable - awaiting backend progression feed'}</p>
                      </div>
                      <div>
                        <p className="text-xs text-[#b0a095] block mb-1">Attendance</p>
                        {activeChild.attendancePercent !== null ? (
                          <p className="text-base font-semibold text-green-400">{activeChild.attendancePercent}%</p>
                        ) : (
                          <p className="text-base font-semibold">Unavailable - not yet tracked</p>
                        )}
                      </div>
                      {/* Membership/scholarship/community-service status has no
                          backing column anywhere in the schema -- these used to
                          be hardcoded to the same "supported" values for every
                          family regardless of their actual status, which is a
                          real billing-adjacent misstatement, not a placeholder.
                          Show unavailable honestly until a real field exists. */}
                      <div>
                        <p className="text-xs text-[#b0a095] block mb-1">Membership Status</p>
                        <p className="text-base font-semibold text-[#8a8a8a]">Unavailable - not yet tracked</p>
                      </div>
                      <div>
                        <p className="text-xs text-[#b0a095] block mb-1">Scholarship Status</p>
                        <p className="text-base font-semibold text-[#8a8a8a]">Unavailable - not yet tracked</p>
                      </div>
                      <div>
                        <p className="text-xs text-[#b0a095] block mb-1">Community Service Support Status</p>
                        <p className="text-base font-semibold text-[#8a8a8a]">Unavailable - not yet tracked</p>
                      </div>
                    </div>
                  </div>

                  <div className={ui.panelSpaced}>
                    <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">How to Support</h3>
                    <ul className="space-y-2 text-sm">
                      <li className="flex items-start gap-2">
                        <span>✓</span>
                        <span>Attend training sessions consistently</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span>✓</span>
                        <span>Support home assignments and drills</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span>✓</span>
                        <span>Maintain nutrition and sleep</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span>✓</span>
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

              <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4">
                <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">This Week&apos;s Parent Support Tasks</h3>
                <p className="max-w-[520px] font-mono text-xs font-bold uppercase tracking-[0.1em] text-[#dc2626]">
                  PLANNED | NOT YET IMPLEMENTED
                </p>
                <p className="text-sm text-[#b0a095]">
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

              <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[#dc2626]">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed for home assignments yet, so this
                list is always empty.
              </p>

              <div className="space-y-3">
                {homeAssignments.map(assignment => (
                  <div key={assignment.id} className={`border-2 p-4 rounded ${assignmentCardTone(assignment.status)}`}>
                    <div className="flex justify-between items-start mb-2">
                      <h4 className="font-semibold">{assignment.title}</h4>
                      <span className={`text-xs px-2 py-1 rounded font-semibold ${assignmentBadgeTone(assignment.status)}`}>
                        {assignment.status}
                      </span>
                    </div>
                    <p className="text-sm text-[#b0a095] mb-2">{assignment.description}</p>
                    <p className="text-xs text-[#8a8a8a]">Due: {assignment.dueDate}</p>
                  </div>
                ))}
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

              <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[#dc2626]">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed or entry form for parent observations
                yet, so this section is always empty.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {parentObservations.map(obs => (
                  <div key={obs.id} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4 space-y-2">
                    <h4 className="font-semibold">{obs.category}</h4>
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-[#b0a095]">Rating</span>
                        <span className="font-semibold">{obs.value}/10</span>
                      </div>
                      <div className="w-full bg-[#4a4a4a] h-2">
                        <div className="bg-[#d4a574] h-2" style={{width: `${obs.value * 10}%`}}></div>
                      </div>
                    </div>
                    {obs.notes && (
                      <p className="text-xs text-[#b0a095] italic mt-2">{obs.notes}</p>
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

              <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[#dc2626]">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed for family goals yet, so this section
                is always empty.
              </p>

              <div className="space-y-3">
                {familyGoals.map(goal => (
                  <div key={goal.id} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4 space-y-3">
                    <div className="flex justify-between items-start">
                      <h4 className="font-semibold">{goal.title}</h4>
                      <span className="text-xs text-[#8a8a8a]">{goal.targetDate}</span>
                    </div>
                    <p className="text-sm text-[#b0a095]">{goal.supportAction}</p>
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-[#b0a095]">Progress</span>
                        <span className="font-semibold">{goal.progress}%</span>
                      </div>
                      <div className="w-full bg-[#4a4a4a] h-2">
                        <div className="bg-[#d4a574] h-2" style={{width: `${goal.progress}%`}}></div>
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

              <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[#dc2626]">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed for coach messages yet, so this list
                is always empty.
              </p>

              <div className="space-y-3 max-h-96 overflow-y-auto">
                {messages.map(msg => (
                  <div key={msg.id} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
                    <div className="flex justify-between items-start mb-2">
                      <h4 className="font-semibold">{msg.subject}</h4>
                      <span className="text-xs text-[#8a8a8a]">From Coach</span>
                    </div>
                    <p className="text-sm text-[#b0a095] mb-2">{msg.body}</p>
                    <p className="text-xs text-[#8a8a8a]">{msg.date}</p>
                  </div>
                ))}
              </div>

              <div className="border-2 border-[#d4a574] bg-[#0f0f0f] p-4 space-y-3">
                <h4 className="font-semibold text-[#d4a574]">Reply to Coach</h4>
                <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[#dc2626]">
                  PLANNED | NOT YET IMPLEMENTED
                </p>
                <p className="text-xs text-[#b0a095]">
                  There is no coach-messaging backend yet. This field is disabled so a message can&apos;t be typed
                  and silently discarded -- until this is wired up, contact your child&apos;s coach directly.
                </p>
                <textarea
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="Messaging is not yet available."
                  disabled
                  className="w-full h-20 px-3 py-2 bg-[#1a1a1a] border-2 border-[#5a4a3a] text-[#8a8a8a] focus:outline-none resize-none cursor-not-allowed"
                />
                <button
                  type="button"
                  disabled
                  className="px-4 py-2 bg-[#3a2a2a] text-[#8a8a8a] font-semibold cursor-not-allowed"
                >
                  Send Message (unavailable)
                </button>
              </div>
            </div>
          )}

          {/* ATTENDANCE */}
          {activeTab === 'attendance' && (
            <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[#d4a574] uppercase">Attendance Tracking</h3>
              <p className="text-[#b0a095]">View attendance history and upcoming sessions.</p>
              <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[#dc2626]">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed for attendance history or upcoming
                sessions yet, so these lists are always empty.
              </p>

              <div className="space-y-2">
                {activeAttendanceEntries.map((entry) => (
                  <div key={entry.id} className="border border-[#3a3a3a] bg-[#101010] p-3 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold text-[#f2e7da]">{entry.date} | {entry.session}</p>
                    </div>
                    <span className={`text-sm font-semibold ${attendanceStatusTone(entry.status)}`}>{entry.status}</span>
                  </div>
                ))}
              </div>

              <div className="border border-[#3a3a3a] bg-[#101010] p-4 space-y-2">
                <h4 className="font-semibold text-[#f2e7da]">Upcoming Sessions</h4>
                {upcomingSessions.map((session) => (
                  <div key={session.id} className="text-sm text-[#cfbfae]">
                    <p><strong>{session.date} {session.time}</strong> - {session.title}</p>
                    <p>Focus: {session.focus}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* PROGRESS */}
          {activeTab === 'progress' && (
            <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[#d4a574] uppercase">Progress & Achievements</h3>
              <p className="text-[#b0a095]">Track skill development and milestone achievements.</p>

              <details className="border border-[#5a4a3a] bg-[#101010] p-3">
                <summary className="cursor-pointer text-sm font-semibold text-[#e8d7c6]">Parent-Support Visibility Placeholder</summary>
                <p className="mt-2 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">
                  CLOSED-LOOP PROGRESSION INTELLIGENCE - PLANNED | FRONT-END PLACEHOLDER | BACKEND REQUIRED
                </p>
                <Link href="/parent/progression-visibility" className="mt-2 inline-flex border border-[#8b4444] bg-[#2a1414] px-3 py-1 text-[11px] font-mono uppercase tracking-[0.08em] text-[#e8d7c6]">
                  Open Parent Progression Visibility
                </Link>
              </details>

              <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[#dc2626]">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed for progress milestones yet, so this
                list is always empty.
              </p>

              <div className="space-y-3">
                {activeProgressMilestones.map((milestone) => (
                  <div key={milestone.id} className={`border p-4 ${milestoneStatusTone(milestone.status)}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold">{milestone.category}: {milestone.title}</p>
                      <span className="text-xs font-bold uppercase">{milestone.status}</span>
                    </div>
                    <div className="mt-2">
                      <div className="flex justify-between text-xs mb-1">
                        <span>Progress</span>
                        <span>{milestone.percent}%</span>
                      </div>
                      <div className="w-full bg-[#2a2a2a] h-2">
                        <div className="bg-[#d4a574] h-2" style={{ width: `${milestone.percent}%` }}></div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* RESOURCES */}
          {activeTab === 'resources' && (
            <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[#d4a574] uppercase">Parent Support Resources</h3>
              <p className="text-[#b0a095]">Guides, videos, and tips for supporting young athletes.</p>
              <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[#dc2626]">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed for parent resources yet, so this
                list is always empty.
              </p>
              <div className="space-y-2">
                {parentResources.map((resource) => (
                  <div key={resource.id} className="border-2 border-[#8b4444] bg-[#0f0f0f] p-3">
                    <p className="font-semibold">{resource.title}</p>
                    <p className="text-sm text-[#b0a095] mt-1">Type: {resource.type}</p>
                    <p className="text-sm text-[#cfbfae] mt-1">{resource.summary}</p>
                    <button className="mt-2 px-3 py-1 bg-[#8b4444] hover:bg-[#5a2a2a] text-white text-sm font-semibold transition">
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

