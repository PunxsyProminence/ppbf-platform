'use client';

import React, { useState } from 'react';
import { CoachSummaryPanel, HelpPanel, RoleSpecificShadow } from './RoleSummaryPanels';
import { cx, ui } from './uiStyles';

type TabID = 'dashboard' | 'floor' | 'development' | 'goals' | 'tasks' | 'assessments' | 'film-study' | 'athlete-reviews' | 'shadow';
type SessionMode = 'Group' | 'One-on-One';

interface Athlete {
  id: string;
  name: string;
  track: string;
  readiness: 'GREEN' | 'YELLOW' | 'RED';
  injuryFlag: boolean;
  attendance: 'Present' | 'Late' | 'Excused' | 'Absent';
}

interface WorkoutBlock {
  id: string;
  title: string;
  duration: number;
  status: 'Not Started' | 'In Progress' | 'Completed' | 'Skipped';
}

interface CoachTask {
  id: string;
  title: string;
  dueDate: string;
  priority: 'High' | 'Normal' | 'Low';
  status: 'Open' | 'In Progress' | 'Completed';
  relatedAthlete?: string;
}

interface CoachGoal {
  id: string;
  title: string;
  category: string;
  progress: number;
  dueDate: string;
}

export default function CoachWorkspace() {
  const [activeTab, setActiveTab] = useState<TabID>('dashboard');
  const [sessionMode, setSessionMode] = useState<SessionMode>('Group');

  // Dashboard data
  const [athletes] = useState<Athlete[]>([
    { id: 'a_1', name: 'Marcus Rodriguez', track: 'Foundations', readiness: 'GREEN', injuryFlag: false, attendance: 'Present' },
    { id: 'a_2', name: 'Sophia Chen', track: 'Competition', readiness: 'YELLOW', injuryFlag: false, attendance: 'Present' },
    { id: 'a_3', name: 'James Thompson', track: 'Non-Contact', readiness: 'RED', injuryFlag: true, attendance: 'Absent' }
  ]);

  const [selectedAthleteId, setSelectedAthleteId] = useState<string | null>('a_1');

  const [coachTasks] = useState<CoachTask[]>([
    { id: 't_1', title: 'Review athlete goals - Marcus', dueDate: '2026-07-13', priority: 'High', status: 'Open', relatedAthlete: 'a_1' },
    { id: 't_2', title: 'Approve track application - Sophia', dueDate: '2026-07-14', priority: 'High', status: 'Open', relatedAthlete: 'a_2' },
    { id: 't_3', title: 'Conduct athlete evaluation', dueDate: '2026-07-15', priority: 'Normal', status: 'In Progress' },
    { id: 't_4', title: 'Film review - last session', dueDate: '2026-07-16', priority: 'Normal', status: 'Open' },
    { id: 't_5', title: 'Submit monthly coach report', dueDate: '2026-07-20', priority: 'Normal', status: 'Open' }
  ]);

  const [workoutBlocks] = useState<WorkoutBlock[]>([
    { id: 'wb_1', title: 'Warmup', duration: 10, status: 'Completed' },
    { id: 'wb_2', title: 'Footwork Drills', duration: 15, status: 'In Progress' },
    { id: 'wb_3', title: 'Defense Combinations', duration: 15, status: 'Not Started' },
    { id: 'wb_4', title: 'Conditioning', duration: 15, status: 'Not Started' },
    { id: 'wb_5', title: 'Cooldown', duration: 5, status: 'Not Started' }
  ]);

  const [coachGoals] = useState<CoachGoal[]>([
    { id: 'cg_1', title: 'Complete 10 athlete film reviews', category: 'Development', progress: 30, dueDate: '2026-09-30' },
    { id: 'cg_2', title: 'Improve class retention', category: 'Coaching', progress: 65, dueDate: '2026-12-31' },
    { id: 'cg_3', title: 'Bronze Certification', category: 'Certification', progress: 45, dueDate: '2026-10-15' }
  ]);

  const sessionStatus = 'In Progress';
  const activeAthletes = athletes.filter(a => a.attendance !== 'Absent').length;
  const injuryFlags = athletes.filter(a => a.injuryFlag).length;
  const reviewsNeeded = coachTasks.filter(t => t.status === 'Open' && t.title.includes('Review')).length;
  const assignmentsDue = coachTasks.filter(t => t.status === 'Open').length;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6] font-sans">
      <div className="max-w-7xl mx-auto p-4 space-y-8">
        {/* HEADER */}
        <div className="border-b-2 border-[#8b4444] pb-6 space-y-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.15em] text-[#d4a574]">Coach Development Workspace</p>
            <h1 className="text-3xl md:text-4xl font-black mt-2">Live Session Management</h1>
            <p className="text-base text-[#b0a095] mt-2">Manage your program floor, develop yourself, and track athlete progress with SMART goals and assessments.</p>
          </div>
        </div>

        {/* ROLE SUMMARY PANEL */}
        <CoachSummaryPanel
          sessionStatus={sessionStatus}
          activeAthletes={activeAthletes}
          injuryFlags={injuryFlags}
          reviewsNeeded={reviewsNeeded}
          assignmentsDue={assignmentsDue}
        />

        {/* MODE TOGGLE */}
        <div className="flex w-fit gap-2 border-2 border-[#8b4444] bg-[#0f0f0f] p-2">
          {(['Group', 'One-on-One'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => setSessionMode(mode)}
              className={cx(
                ui.modeButtonBase,
                sessionMode === mode ? ui.modeButtonActive : ui.modeButtonInactive,
              )}
            >
              {mode} Mode
            </button>
          ))}
        </div>

        {/* TAB NAVIGATION */}
        <div className={ui.tabContainer}>
          <div className={ui.tabRow}>
            {[
              { id: 'dashboard', label: 'Dashboard' },
              { id: 'floor', label: 'Floor' },
              { id: 'development', label: 'Development' },
              { id: 'goals', label: 'Goals' },
              { id: 'tasks', label: 'Tasks' },
              { id: 'assessments', label: 'Assessments' },
              { id: 'film-study', label: 'Film Study' },
              { id: 'athlete-reviews', label: 'Athlete Reviews' },
              { id: 'shadow', label: 'SHADOW AI' }
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
          {/* DASHBOARD */}
          {activeTab === 'dashboard' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Coach Dashboard"
                description="Overview of your session status, athlete roster, and immediate action items."
                usage={[
                  'Check session status and athlete readiness before class',
                  'Review flagged athletes (RED/YELLOW readiness)',
                  'See athletes with injury concerns',
                  'Monitor open tasks and due dates'
                ]}
                mistakes={[
                  'Missing injury flags before session start',
                  'Not reviewing task deadlines',
                  'Overlooking RED readiness athletes'
                ]}
                onAskShadow={() => {}}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Session Status */}
                <div className={ui.panelSpaced}>
                  <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Today&apos;s Session</h3>
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs text-[#b0a095] block mb-1">Session Name</label>
                      <p className="text-base font-semibold">Youth Non-Contact Development</p>
                    </div>
                    <div>
                      <label className="text-xs text-[#b0a095] block mb-1">Time</label>
                      <p className="text-base font-semibold">4:00 PM - 5:00 PM</p>
                    </div>
                    <div>
                      <label className="text-xs text-[#b0a095] block mb-1">Status</label>
                      <p className="text-base font-semibold text-green-400">In Progress</p>
                    </div>
                    <div>
                      <label className="text-xs text-[#b0a095] block mb-1">Athletes Present</label>
                      <p className="text-base font-semibold">{activeAthletes}/{athletes.length}</p>
                    </div>
                  </div>
                </div>

                {/* Athlete Roster */}
                <div className={ui.panelSpaced}>
                  <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Athlete Roster</h3>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {athletes.map(athlete => (
                      <div
                        key={athlete.id}
                        onClick={() => setSelectedAthleteId(athlete.id)}
                        className={`p-3 border-2 rounded cursor-pointer transition ${
                          selectedAthleteId === athlete.id
                            ? 'bg-[#2a2a2a] border-[#8b4444]'
                            : 'bg-[#0f0f0f] border-[#4a4a4a] hover:border-[#8b4444]'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full ${
                              athlete.readiness === 'GREEN' ? 'bg-green-500' :
                              athlete.readiness === 'YELLOW' ? 'bg-yellow-500' : 'bg-red-500'
                            }`}></div>
                            <span className="font-semibold">{athlete.name}</span>
                          </div>
                          <span className="text-xs text-[#8a8a8a]">{athlete.attendance}</span>
                        </div>
                        {athlete.injuryFlag && (
                          <p className="text-xs text-red-400 mt-1">🚨 Injury flag active</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Open Tasks */}
                <div className="md:col-span-2 border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4">
                  <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Tasks Due</h3>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {coachTasks.filter(t => t.status !== 'Completed').map(task => (
                      <div key={task.id} className="border-2 border-[#8b4444] bg-[#0f0f0f] p-3">
                        <div className="flex justify-between items-start mb-2">
                          <h4 className="font-semibold">{task.title}</h4>
                          <span className={`text-xs px-2 py-1 rounded font-semibold ${
                            task.priority === 'High' ? 'bg-red-900 text-red-200' :
                            task.priority === 'Normal' ? 'bg-yellow-900 text-yellow-200' :
                            'bg-blue-900 text-blue-200'
                          }`}>
                            {task.priority}
                          </span>
                        </div>
                        <p className="text-xs text-[#b0a095]">Due: {task.dueDate}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* FLOOR */}
          {activeTab === 'floor' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Coach Floor"
                description="Live session management. Track workout blocks, athlete observations, and make real-time adjustments."
                usage={[
                  'Start session when class begins',
                  'Progress through workout blocks',
                  'Record quick observations for each athlete',
                  'Mark modifications for individual athletes',
                  'End session and review summary'
                ]}
                mistakes={[
                  'Not starting session timer',
                  'Missing critical observations',
                  'Forgetting to record modifications'
                ]}
                onAskShadow={() => {}}
              />

              <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4">
                <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Session Workout Plan</h3>

                <div className="space-y-2">
                  {workoutBlocks.map((block) => (
                    <div key={block.id} className={`border-2 p-3 rounded ${
                      block.status === 'Completed' ? 'bg-green-900/20 border-green-700' :
                      block.status === 'In Progress' ? 'bg-yellow-900/20 border-yellow-700' :
                      'bg-[#0f0f0f] border-[#8b4444]'
                    }`}>
                      <div className="flex justify-between items-center">
                        <div>
                          <p className="font-semibold">{block.title}</p>
                          <p className="text-xs text-[#b0a095]">{block.duration} minutes</p>
                        </div>
                        <span className={`text-xs px-2 py-1 rounded font-semibold ${
                          block.status === 'Completed' ? 'bg-green-900 text-green-200' :
                          block.status === 'In Progress' ? 'bg-yellow-900 text-yellow-200' :
                          'bg-[#4a4a4a] text-[#8a8a8a]'
                        }`}>
                          {block.status}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="bg-[#0f0f0f] border-2 border-[#8b4444] p-4">
                  <p className="text-xs text-[#8a8a8a]">Session Progress: 40%</p>
                  <div className="w-full bg-[#2a2a2a] h-2 mt-2">
                    <div className="bg-[#d4a574] h-2" style={{width: '40%'}}></div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* DEVELOPMENT */}
          {activeTab === 'development' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Coach Development"
                description="Your personal coaching growth path. Track certifications, skills, and professional development."
                usage={[
                  'Review your current coaching level',
                  'Track certification requirements',
                  'Set coach development goals',
                  'Record training hours and completed courses',
                  'Monitor mentorship progress'
                ]}
                mistakes={[
                  'Neglecting your own development',
                  'Not tracking training hours',
                  'Waiting until renewal deadlines'
                ]}
                onAskShadow={() => {}}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4">
                  <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Current Certifications</h3>
                  <div className="space-y-3">
                    <div className="bg-[#0f0f0f] p-3 border-2 border-[#8b4444]">
                      <p className="font-semibold">Bronze Certification</p>
                      <p className="text-xs text-[#8a8a8a] mt-1">Expires: 2026-12-31</p>
                    </div>
                    <div className="bg-[#0f0f0f] p-3 border-2 border-[#8b4444]">
                      <p className="font-semibold">USA Boxing Coach License</p>
                      <p className="text-xs text-[#8a8a8a] mt-1">Expires: 2027-06-30</p>
                    </div>
                  </div>
                </div>

                <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4">
                  <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Development Topics</h3>
                  <div className="space-y-2">
                    {[
                      'Boxing Technique Instruction',
                      'Youth Development Psychology',
                      'Injury Prevention Basics',
                      'Class Management Skills',
                      'Adaptive Coaching'
                    ].map((topic, i) => (
                      <label key={i} className="flex items-center gap-2 cursor-pointer p-2 border-2 border-[#8b4444] bg-[#0f0f0f] hover:bg-[#1a1a1a]">
                        <input type="checkbox" className="w-4 h-4" />
                        <span className="text-sm">{topic}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* GOALS */}
          {activeTab === 'goals' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Coach Goals"
                description="Set and track your coaching development goals using SMART framework."
                usage={[
                  'Create specific, measurable goals',
                  'Link to certification or skill development',
                  'Track progress monthly',
                  'Reflect on achievements'
                ]}
                mistakes={[
                  'Vague goals without metrics',
                  'Unrealistic timeframes',
                  'Not reviewing progress regularly'
                ]}
                onAskShadow={() => {}}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {coachGoals.map(goal => (
                  <div key={goal.id} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4 space-y-3">
                    <div className="flex justify-between items-start">
                      <h4 className="font-semibold">{goal.title}</h4>
                      <span className="text-xs bg-[#4a4a4a] text-[#8a8a8a] px-2 py-1">{goal.category}</span>
                    </div>
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-[#b0a095]">Progress</span>
                        <span className="font-semibold">{goal.progress}%</span>
                      </div>
                      <div className="w-full bg-[#4a4a4a] h-2">
                        <div className="bg-[#d4a574] h-2" style={{width: `${goal.progress}%`}}></div>
                      </div>
                    </div>
                    <p className="text-xs text-[#b0a095]">Due: {goal.dueDate}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TASKS */}
          {activeTab === 'tasks' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Coach Tasks"
                description="Mission board with athlete evaluations, reviews, and administrative tasks."
                usage={[
                  'Complete task reviews before deadlines',
                  'Related athlete tasks link to athlete profiles',
                  'Update status as you work through tasks',
                  'Prioritize HIGH tasks first'
                ]}
                mistakes={[
                  'Missing task deadlines',
                  'Not updating task status',
                  'Ignoring related athlete information'
                ]}
                onAskShadow={() => {}}
              />

              <div className="space-y-3">
                {coachTasks.map(task => (
                  <div key={task.id} className={`border-2 p-4 rounded ${
                    task.status === 'Completed' ? 'bg-[#2a5a2a]/30 border-green-700' : 'bg-[#1a1a1a] border-[#8b4444]'
                  }`}>
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <h4 className="font-semibold">{task.title}</h4>
                        <p className="text-xs text-[#b0a095] mt-1">Due: {task.dueDate}</p>
                      </div>
                      <div className="flex gap-2">
                        <span className={`text-xs px-2 py-1 rounded font-semibold ${
                          task.priority === 'High' ? 'bg-red-900 text-red-200' :
                          task.priority === 'Normal' ? 'bg-yellow-900 text-yellow-200' :
                          'bg-blue-900 text-blue-200'
                        }`}>
                          {task.priority}
                        </span>
                        <span className={`text-xs px-2 py-1 rounded font-semibold ${
                          task.status === 'Open' ? 'bg-[#6b4a2a] text-[#d4a574]' :
                          task.status === 'In Progress' ? 'bg-[#4a6b2a] text-[#b4d474]' :
                          'bg-[#4a4a6b] text-[#a4a4d4]'
                        }`}>
                          {task.status}
                        </span>
                      </div>
                    </div>
                    {task.relatedAthlete && (
                      <p className="text-xs text-[#8a8a8a]">Related: {athletes.find(a => a.id === task.relatedAthlete)?.name}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SHADOW AI */}
          {activeTab === 'shadow' && (
            <div className="space-y-6 animate-fadeIn">
              <RoleSpecificShadow
                role="coach"
                query="Which athletes need attention?"
                response="3 athletes flagged: Sophia Chen (YELLOW readiness, soreness issues), James Thompson (RED readiness, injury flag). Marcus Rodriguez is GREEN and performing well. Recommend modified rounds for Sophia and observation-only for James."
              />

              <div className="border-2 border-[#d4a574] bg-[#0f0f0f] p-6 space-y-4">
                <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">SHADOW Coach Assistant</h3>
                <p className="text-sm text-[#b0a095]">Ask questions about session management, athlete readiness, goals, tasks, or coaching strategy.</p>
              </div>
            </div>
          )}

          {/* ASSESSMENTS */}
          {activeTab === 'assessments' && (
            <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[#d4a574] uppercase">Coach Assessments</h3>
              <p className="text-[#b0a095]">Evaluate coaching effectiveness, communication, and athlete development.</p>
              <div className="text-sm text-[#8a8a8a]">Coming soon: Leadership assessment, communication effectiveness survey, teaching impact evaluation.</div>
            </div>
          )}

          {/* FILM STUDY */}
          {activeTab === 'film-study' && (
            <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[#d4a574] uppercase">Film Study</h3>
              <p className="text-[#b0a095]">Record observations from training videos and self-evaluations.</p>
              <div className="text-sm text-[#8a8a8a]">Coming soon: Video upload, timestamp annotations, technical analysis tools.</div>
            </div>
          )}

          {/* ATHLETE REVIEWS */}
          {activeTab === 'athlete-reviews' && (
            <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[#d4a574] uppercase">Athlete Performance Reviews</h3>
              <p className="text-[#b0a095]">Comprehensive athlete progress tracking and performance feedback.</p>
              <div className="text-sm text-[#8a8a8a]">Coming soon: Technical progression reports, readiness trends, goal achievement tracking.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

