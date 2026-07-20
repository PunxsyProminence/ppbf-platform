'use client';

import Link from 'next/link';
import React, { useState, useEffect } from 'react';
import { ParentSummaryPanel, HelpPanel, RoleSpecificShadow } from './RoleSummaryPanels';
import { cx, ui } from './uiStyles';

type TabID = 'overview' | 'parent-floor' | 'home-assignments' | 'observations' | 'family-goals' | 'messages' | 'attendance' | 'progress' | 'resources' | 'shadow';

interface Child {
  id: string;
  name: string;
  track: string;
  attendancePercent: number;
  currentProgress: string;
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

  const [activeChildId, setActiveChildId] = useState<string | null>(null);

  const [homeAssignments] = useState<HomeAssignment[]>([
    { id: 'ha_1', title: 'Watch Footwork Fundamentals Video', dueDate: '2026-07-13', status: 'Pending', description: 'Coach Jason assigned - 12 minute instructional video' },
    { id: 'ha_2', title: 'Record 2 Rounds of Shadowboxing', dueDate: '2026-07-14', status: 'In Progress', description: 'Evidence upload optional - form check focus' },
    { id: 'ha_3', title: 'Complete Family Reflection Survey', dueDate: '2026-07-15', status: 'Pending', description: 'How is training affecting home life?' }
  ]);

  const [parentObservations] = useState<ParentObservation[]>([
    { id: 'po_1', category: 'Energy Level', value: 7, notes: 'Seems energetic after training' },
    { id: 'po_2', category: 'Sleep Quality', value: 8, notes: 'Good sleep patterns on training days' },
    { id: 'po_3', category: 'Motivation', value: 8, notes: 'Excited about upcoming belt test' },
    { id: 'po_4', category: 'Home Behavior', value: 7, notes: 'More focused on schoolwork' }
  ]);

  const [familyGoals] = useState<FamilyGoal[]>([
    { id: 'fg_1', title: 'Attend 90% of Sessions', supportAction: 'Maintain consistent schedule', progress: 92, targetDate: '2026-12-31' },
    { id: 'fg_2', title: 'Maintain Grade Average', supportAction: 'Check homework, reduce distractions', progress: 85, targetDate: '2026-12-31' },
    { id: 'fg_3', title: 'Prepare for Belt Test', supportAction: 'Support home practice, nutrition', progress: 60, targetDate: '2026-08-15' }
  ]);

  const [messages] = useState<ParentMessage[]>([
    { id: 'm_1', sender: 'coach', subject: 'Great Progress This Week', body: 'Alex showed excellent focus during today\'s session. Footwork improvements are very noticeable.', date: '2026-07-11' },
    { id: 'm_2', sender: 'coach', subject: 'Upcoming Belt Test', body: 'Jordan is ready for the August test. Recommend continued focus on defensive combinations.', date: '2026-07-10' }
  ]);

  const [attendanceEntries] = useState<AttendanceEntry[]>([
    { id: 'att_1', childId: 'c_1', date: '2026-07-08', session: 'Youth Class 4:00 PM', status: 'Present' },
    { id: 'att_2', childId: 'c_1', date: '2026-07-09', session: 'Youth Class 4:00 PM', status: 'Present' },
    { id: 'att_3', childId: 'c_1', date: '2026-07-10', session: 'Youth Class 4:00 PM', status: 'Excused' },
    { id: 'att_4', childId: 'c_2', date: '2026-07-08', session: 'Competition 5:00 PM', status: 'Present' },
    { id: 'att_5', childId: 'c_2', date: '2026-07-10', session: 'Competition 5:00 PM', status: 'Absent' },
  ]);

  const [upcomingSessions] = useState<UpcomingSession[]>([
    { id: 'up_1', date: '2026-07-14', time: '4:00 PM', title: 'Youth Class', focus: 'Footwork and guard discipline' },
    { id: 'up_2', date: '2026-07-16', time: '5:00 PM', title: 'Competition Track', focus: 'Combination defense and ring movement' },
    { id: 'up_3', date: '2026-07-18', time: '10:00 AM', title: 'Saturday Skills', focus: 'Conditioning and spar prep' },
  ]);

  const [progressMilestones] = useState<ProgressMilestone[]>([
    { id: 'pm_1', childId: 'c_1', category: 'Technical', title: 'Jab and guard consistency', percent: 82, status: 'On Track' },
    { id: 'pm_2', childId: 'c_1', category: 'Conditioning', title: 'Round stamina development', percent: 71, status: 'On Track' },
    { id: 'pm_3', childId: 'c_2', category: 'Technical', title: 'Counter-defense transitions', percent: 64, status: 'Needs Work' },
    { id: 'pm_4', childId: 'c_2', category: 'Academics', title: 'School attendance compliance', percent: 95, status: 'Achieved' },
  ]);

  const [parentResources] = useState<ParentResource[]>([
    {
      id: 'res_1',
      title: 'Weekly Parent Support Checklist',
      type: 'Checklist',
      summary: 'Simple weekly checklist for attendance, hydration, nutrition, and home drills.',
      actionLabel: 'Use Checklist',
    },
    {
      id: 'res_2',
      title: 'SafeSport Family Communication Guidelines',
      type: 'Policy',
      summary: 'Family-facing communication boundaries and safety escalation path.',
      actionLabel: 'Review Policy',
    },
    {
      id: 'res_3',
      title: 'At-Home Fundamentals Video Pack',
      type: 'Video',
      summary: 'Short video references for stance, footwork, and basic combinations.',
      actionLabel: 'Open Video Pack',
    },
  ]);

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
        
        // Convert PilotAthlete to Child format
        const childList: Child[] = items.map((item, index: number) => {
          // Generate deterministic placeholder attendance (80-100%) based on item index
          const placeholderAttendance = 80 + (index % 21);
          return {
            id: item.athlete_id,
            name: item.full_name || 'Unknown',
            track: 'Foundations', // Placeholder - gym_status not available from API
            attendancePercent: placeholderAttendance,
            currentProgress: 'Developing skills' // Placeholder - would need separate API
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
  }, [activeChildId]);

  const activeChild = children.find(c => c.id === activeChildId);
  const tasksDue = homeAssignments.filter(a => a.status !== 'Completed').length;
  const upcomingEvents = 3;
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
        </div>

        <div className="border border-[#694838] bg-[#14100d] p-4">
          <p className="text-sm text-[#d4a574] font-semibold">Family Commitment</p>
          <p className="mt-1 text-sm text-[#cfbfae]">Consistency at home builds confidence in the gym. Every ride, reminder, and check-in strengthens grit and motivation.</p>
        </div>

        {/* ROLE SUMMARY PANEL */}
        <ParentSummaryPanel
          childProgress={activeChild?.currentProgress || ''}
          tasksDue={tasksDue}
          upcomingEvents={upcomingEvents}
          attendancePercent={activeChild?.attendancePercent || 0}
          unreadMessages={messages.filter(m => !m.read).length}
        />

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
                  // Effect will re-run
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
                onAskShadow={() => {}}
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
                        <p className="text-base font-semibold">{activeChild.currentProgress}</p>
                      </div>
                      <div>
                        <p className="text-xs text-[#b0a095] block mb-1">Attendance</p>
                        <p className="text-base font-semibold text-green-400">{activeChild.attendancePercent}%</p>
                      </div>
                      <div>
                        <p className="text-xs text-[#b0a095] block mb-1">Membership Status</p>
                        <p className="text-base font-semibold">Active Member</p>
                      </div>
                      <div>
                        <p className="text-xs text-[#b0a095] block mb-1">Support Status</p>
                        <p className="text-base font-semibold">Scholarship Supported</p>
                      </div>
                      <div>
                        <p className="text-xs text-[#b0a095] block mb-1">Scholarship Status</p>
                        <p className="text-base font-semibold">Scholarship Supported</p>
                      </div>
                      <div>
                        <p className="text-xs text-[#b0a095] block mb-1">Community Service Support Status</p>
                        <p className="text-base font-semibold">Community Service Supported</p>
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
                onAskShadow={() => {}}
              />

              <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4">
                <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">This Week&apos;s Parent Support Tasks</h3>

                <div className="space-y-3">
                  {[
                    { task: 'Watch Jab Video', completed: false },
                    { task: 'Record 2 Shadowboxing Rounds', completed: true },
                    { task: 'Complete Family Reflection', completed: false },
                    { task: 'Verify School Progress', completed: true },
                    { task: 'Prepare for Saturday Session', completed: false }
                  ].map((item) => (
                    <div key={item.task} className={`border-2 p-3 rounded flex items-center gap-3 ${
                      item.completed ? 'bg-green-900/20 border-green-700' : 'bg-[#0f0f0f] border-[#8b4444]'
                    }`}>
                      <input type="checkbox" checked={item.completed} readOnly aria-label={`${item.task} completion`} className="w-4 h-4" />
                      <span className="font-semibold">{item.task}</span>
                    </div>
                  ))}
                </div>

                <div className="bg-[#0f0f0f] border-2 border-[#8b4444] p-4">
                  <p className="text-xs text-[#8a8a8a]">Progress: 40%</p>
                  <div className="w-full bg-[#2a2a2a] h-2 mt-2">
                    <div className="bg-[#d4a574] h-2" style={{width: '40%'}}></div>
                  </div>
                </div>
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
                onAskShadow={() => {}}
              />

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
                onAskShadow={() => {}}
              />

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
                onAskShadow={() => {}}
              />

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
                onAskShadow={() => {}}
              />

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
                <textarea
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="Type your message..."
                  className="w-full h-20 px-3 py-2 bg-[#1a1a1a] border-2 border-[#8b4444] text-[#e8d7c6] focus:outline-none resize-none"
                />
                <button className="px-4 py-2 bg-[#8b4444] hover:bg-[#5a2a2a] text-white font-semibold transition">
                  Send Message
                </button>
              </div>
            </div>
          )}

          {/* ATTENDANCE */}
          {activeTab === 'attendance' && (
            <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[#d4a574] uppercase">Attendance Tracking</h3>
              <p className="text-[#b0a095]">View attendance history and upcoming sessions.</p>

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
                query="How can I support my child?"
                response="Current focus: Footwork development and competition preparation. Support this week by: 1) Ensure practice sessions aren't interrupted, 2) Maintain healthy sleep schedule, 3) Support the home drill assignments, 4) Keep nutrition consistent. Child is progressing well - focus on consistent attendance and positive reinforcement."
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

