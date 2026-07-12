'use client';

import React, { useState } from 'react';
import { AdminSummaryPanel, HelpPanel, RoleSpecificShadow } from './RoleSummaryPanels';

type TabID = 'mission-control' | 'people' | 'gym-operations' | 'board-operations' | 'communications' | 'assignments' | 'governance' | 'shadow-control' | 'system-control' | 'reports' | 'audit';
type ViewAsRole = 'Athlete' | 'Coach' | 'Parent' | 'Board' | 'Auditor' | 'Admin';

interface GymAlert {
  id: string;
  title: string;
  severity: 'High' | 'Medium' | 'Low';
  description: string;
}

interface BoardAlert {
  id: string;
  title: string;
  status: 'Open' | 'Pending' | 'Resolved';
  dueDate: string;
}

export default function AdminWorkspace() {
  const [activeTab, setActiveTab] = useState<TabID>('mission-control');
  const [viewAsRole, setViewAsRole] = useState<ViewAsRole>('Admin');
  const [missionControlSide, setMissionControlSide] = useState<'GYM' | 'BOARD'>('GYM');

  const [gymAlerts] = useState<GymAlert[]>([
    { id: 'ga_1', title: 'Class Cancellation - Equipment Issue', severity: 'High', description: 'Heavy bag rigging needs inspection before next class' },
    { id: 'ga_2', title: 'Low Attendance Alert', severity: 'Medium', description: 'Youth class attendance dropped 15% this month' },
    { id: 'ga_3', title: 'Coach Certification Expiring', severity: 'Medium', description: 'Coach Marcus certification expires in 30 days' }
  ]);

  const [boardAlerts] = useState<BoardAlert[]>([
    { id: 'ba_1', title: 'Annual Report Due', status: 'Open', dueDate: '2026-08-30' },
    { id: 'ba_2', title: 'Board Meeting Agenda Review', status: 'Pending', dueDate: '2026-07-20' },
    { id: 'ba_3', title: 'Bylaws Revision Approval', status: 'Open', dueDate: '2026-09-15' }
  ]);

  const [athletes] = useState([
    { id: 'a_1', name: 'Marcus Rodriguez', track: 'Foundations', status: 'Active' },
    { id: 'a_2', name: 'Sophia Chen', track: 'Competition', status: 'Active' },
    { id: 'a_3', name: 'James Thompson', track: 'Non-Contact', status: 'On Hold' }
  ]);

  const [coaches] = useState([
    { id: 'c_1', name: 'Coach Jason', role: 'Head Coach', status: 'Active' },
    { id: 'c_2', name: 'Coach Danielle', role: 'Fitness Director', status: 'Active' }
  ]);

  const [boardMembers] = useState([
    { id: 'bm_1', name: 'John Smith', role: 'President', status: 'Active' },
    { id: 'bm_2', name: 'Maria Garcia', role: 'Treasurer', status: 'Active' },
    { id: 'bm_3', name: 'David Lee', role: 'Secretary', status: 'Active' }
  ]);

  const [announcements, setAnnouncements] = useState<any[]>([
    { id: 'an_1', title: 'Summer Camp Registration Open', recipient: 'All Athletes', date: '2026-07-10', delivered: true },
    { id: 'an_2', title: 'New Class Schedule', recipient: 'Athletes & Parents', date: '2026-07-08', delivered: true }
  ]);

  const [newAnnouncementTitle, setNewAnnouncementTitle] = useState('');
  const [newAnnouncementRecipient, setNewAnnouncementRecipient] = useState('All Athletes');

  const gymSideStats = {
    activeAthletes: athletes.filter(a => a.status === 'Active').length,
    activeCoaches: coaches.length,
    activeClasses: 5,
    readyCount: 8,
    warningCount: 3,
    alertCount: 2
  };

  const boardSideStats = {
    boardMembers: boardMembers.length,
    committees: 3,
    upcomingMeetings: 2,
    openItems: 3,
    completedItems: 12
  };

  const handleAddAnnouncement = () => {
    if (!newAnnouncementTitle.trim()) return;
    const newItem = {
      id: `an_${Date.now()}`,
      title: newAnnouncementTitle,
      recipient: newAnnouncementRecipient,
      date: new Date().toLocaleDateString(),
      delivered: true
    };
    setAnnouncements([newItem, ...announcements]);
    setNewAnnouncementTitle('');
    setNewAnnouncementRecipient('All Athletes');
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6] font-sans">
      <div className="max-w-7xl mx-auto p-4 space-y-8">
        {/* HEADER */}
        <div className="border-b-2 border-[#8b4444] pb-6 space-y-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.15em] text-[#d4a574]">Admin Control Center</p>
            <h1 className="text-3xl md:text-4xl font-black mt-2">Mission Control</h1>
            <p className="text-base text-[#b0a095] mt-2">Gym operations, board governance, and platform management.</p>
          </div>
        </div>

        {/* ROLE SUMMARY PANEL */}
        <AdminSummaryPanel
          gymAlerts={gymAlerts.filter(a => a.severity === 'High').length}
          boardAlerts={boardAlerts.filter(a => a.status === 'Open').length}
          openAssignments={12}
          complianceItems={3}
          pendingReviews={2}
        />

        {/* VIEW AS ROLE SWITCHER */}
        <div className="border-2 border-[#d4a574] bg-[#0f0f0f] p-4 rounded">
          <p className="text-xs font-mono uppercase text-[#d4a574] mb-2 font-bold">Test Mode: View As Role</p>
          <div className="flex flex-wrap gap-2">
            {(['Admin', 'Athlete', 'Coach', 'Parent', 'Board', 'Auditor'] as ViewAsRole[]).map(role => (
              <button
                key={role}
                onClick={() => setViewAsRole(role)}
                className={`px-3 py-2 text-xs font-mono font-bold border-2 transition rounded ${
                  viewAsRole === role
                    ? 'bg-[#5a2a2a] border-[#d4a574] text-[#e8d7c6]'
                    : 'bg-[#1a1a1a] border-[#d4a574] text-[#b0a095] hover:text-[#e8d7c6]'
                }`}
              >
                View as {role}
              </button>
            ))}
          </div>
          <p className="text-xs text-[#8a8a8a] mt-2">Testing only: No auth changes. Current: <strong>{viewAsRole}</strong></p>
        </div>

        {/* TAB NAVIGATION */}
        <div className="border-2 border-[#8b4444] bg-[#0f0f0f] overflow-x-auto">
          <div className="flex gap-1 p-2 min-w-min">
            {[
              { id: 'mission-control', label: 'Mission Control' },
              { id: 'people', label: 'People' },
              { id: 'gym-operations', label: 'Gym Ops' },
              { id: 'board-operations', label: 'Board Ops' },
              { id: 'communications', label: 'Comms' },
              { id: 'assignments', label: 'Assignments' },
              { id: 'governance', label: 'Governance' },
              { id: 'shadow-control', label: 'SHADOW' },
              { id: 'system-control', label: 'System' },
              { id: 'reports', label: 'Reports' },
              { id: 'audit', label: 'Audit' }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as TabID)}
                className={`px-3 py-2 text-xs font-semibold uppercase transition border-2 whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'bg-[#5a2a2a] border-[#8b4444] text-[#e8d7c6]'
                    : 'bg-[#1a1a1a] border-[#4a4a4a] text-[#b0a095] hover:text-[#e8d7c6]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* TAB CONTENT */}
        <div className="space-y-6">
          {/* MISSION CONTROL */}
          {activeTab === 'mission-control' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel
                title="Mission Control"
                description="Split-view mission dashboard. GYM SIDE for operations. BOARD SIDE for governance."
                usage={['Review GYM SIDE for alerts', 'Check BOARD SIDE for governance tasks', 'Act on HIGH severity alerts first']}
                mistakes={['Missing high alerts', 'Overlooking board deadlines', 'Not prioritizing by severity']}
                onAskShadow={() => {}}
              />

              <div className="flex gap-2 mb-4">
                <button onClick={() => setMissionControlSide('GYM')} className={`px-4 py-2 font-mono font-bold text-xs border-2 transition ${missionControlSide === 'GYM' ? 'bg-[#5a2a2a] border-[#8b4444]' : 'bg-[#1a1a1a] border-[#4a4a4a]'}`}>GYM SIDE</button>
                <button onClick={() => setMissionControlSide('BOARD')} className={`px-4 py-2 font-mono font-bold text-xs border-2 transition ${missionControlSide === 'BOARD' ? 'bg-[#5a2a2a] border-[#8b4444]' : 'bg-[#1a1a1a] border-[#4a4a4a]'}`}>BOARD SIDE</button>
              </div>

              {missionControlSide === 'GYM' ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 rounded space-y-3">
                    <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Gym Statistics</h3>
                    <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                      {[
                        { label: 'Athletes', value: gymSideStats.activeAthletes },
                        { label: 'Coaches', value: gymSideStats.activeCoaches },
                        { label: '✓ Ready', value: gymSideStats.readyCount, color: 'green' },
                        { label: '⚠ Flags', value: gymSideStats.warningCount, color: 'yellow' }
                      ].map(stat => (
                        <div key={stat.label} className={`bg-[#0f0f0f] p-3 border-2 ${stat.color === 'green' ? 'border-[#2a6b2a]/50' : stat.color === 'yellow' ? 'border-[#d4a574]/50' : 'border-[#8b4444]/30'}`}>
                          <div className="text-[#8a8a8a]">{stat.label}</div>
                          <div className="text-xl font-bold text-[#e8d7c6]">{stat.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 rounded space-y-3">
                    <h3 className="font-mono text-sm font-bold uppercase text-[#ff6b6b]">Gym Alerts</h3>
                    <div className="space-y-2">
                      {gymAlerts.map(alert => (
                        <div key={alert.id} className={`border-2 p-3 rounded ${alert.severity === 'High' ? 'bg-red-900/20 border-red-700' : 'bg-yellow-900/20 border-yellow-700'}`}>
                          <p className={`font-semibold ${alert.severity === 'High' ? 'text-red-400' : 'text-yellow-400'}`}>{alert.title}</p>
                          <p className="text-xs text-[#b0a095] mt-1">{alert.description}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 rounded space-y-3">
                    <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Board Statistics</h3>
                    <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                      {[
                        { label: 'Members', value: boardSideStats.boardMembers },
                        { label: 'Committees', value: boardSideStats.committees },
                        { label: 'Meetings', value: boardSideStats.upcomingMeetings },
                        { label: 'Open Items', value: boardSideStats.openItems }
                      ].map(stat => (
                        <div key={stat.label} className="bg-[#0f0f0f] p-3 border-2 border-[#8b4444]/30">
                          <div className="text-[#8a8a8a]">{stat.label}</div>
                          <div className="text-xl font-bold text-[#e8d7c6]">{stat.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 rounded space-y-3">
                    <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Board Items</h3>
                    <div className="space-y-2">
                      {boardAlerts.map(alert => (
                        <div key={alert.id} className={`border-2 p-3 rounded ${alert.status === 'Open' ? 'bg-red-900/20 border-red-700' : alert.status === 'Pending' ? 'bg-yellow-900/20 border-yellow-700' : 'bg-green-900/20 border-green-700'}`}>
                          <p className={`font-semibold ${alert.status === 'Open' ? 'text-red-400' : alert.status === 'Pending' ? 'text-yellow-400' : 'text-green-400'}`}>{alert.title}</p>
                          <p className="text-xs text-[#b0a095] mt-1">Due: {alert.dueDate}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* PEOPLE COMMAND CENTER */}
          {activeTab === 'people' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel title="People Command Center" description="Manage all roles by type." usage={['View members by role', 'Check status', 'Monitor assignments']} mistakes={['Missing status checks']} onAskShadow={() => {}} />

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 rounded space-y-3">
                  <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Athletes ({athletes.length})</h3>
                  <div className="space-y-2">
                    {athletes.map(a => (
                      <div key={a.id} className="bg-[#0f0f0f] border-2 border-[#8b4444] p-3 rounded">
                        <p className="font-semibold text-sm">{a.name}</p>
                        <p className="text-xs text-[#8a8a8a]">{a.track} • {a.status}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 rounded space-y-3">
                  <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Coaches ({coaches.length})</h3>
                  <div className="space-y-2">
                    {coaches.map(c => (
                      <div key={c.id} className="bg-[#0f0f0f] border-2 border-[#8b4444] p-3 rounded">
                        <p className="font-semibold text-sm">{c.name}</p>
                        <p className="text-xs text-[#8a8a8a]">{c.role} • {c.status}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 rounded space-y-3">
                  <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Board ({boardMembers.length})</h3>
                  <div className="space-y-2">
                    {boardMembers.map(bm => (
                      <div key={bm.id} className="bg-[#0f0f0f] border-2 border-[#8b4444] p-3 rounded">
                        <p className="font-semibold text-sm">{bm.name}</p>
                        <p className="text-xs text-[#8a8a8a]">{bm.role} • {bm.status}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* GYM OPERATIONS */}
          {activeTab === 'gym-operations' && (
            <div className="space-y-6 animate-fadeIn">
              <HelpPanel title="Gym Operations" description="Announcements, events, workouts, assignments." usage={['Create broadcasts', 'Select recipients', 'Track delivery']} mistakes={['Wrong recipient group']} onAskShadow={() => {}} />

              <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 rounded space-y-4">
                <h3 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Broadcast Announcement</h3>
                <div className="space-y-3">
                  <input type="text" value={newAnnouncementTitle} onChange={(e) => setNewAnnouncementTitle(e.target.value)} placeholder="Announcement title..." className="w-full px-3 py-2 bg-[#0f0f0f] border-2 border-[#8b4444] rounded text-[#e8d7c6] text-sm" />
                  <select value={newAnnouncementRecipient} onChange={(e) => setNewAnnouncementRecipient(e.target.value)} className="w-full px-3 py-2 bg-[#0f0f0f] border-2 border-[#8b4444] rounded text-[#e8d7c6] text-sm">
                    <option>All Athletes</option>
                    <option>All Coaches</option>
                    <option>All Parents</option>
                    <option>All Members</option>
                  </select>
                  <button onClick={handleAddAnnouncement} className="w-full bg-[#8b4444] hover:bg-[#5a2a2a] text-white font-semibold py-2 rounded">Broadcast</button>
                </div>

                <div className="border-t border-[#8b4444] pt-4">
                  <h4 className="font-mono text-xs font-bold uppercase text-[#d4a574] mb-3">Recent Broadcasts</h4>
                  {announcements.map(ann => (
                    <div key={ann.id} className="bg-[#0f0f0f] border-2 border-[#8b4444] p-3 rounded mb-2 flex justify-between">
                      <div>
                        <p className="font-semibold text-sm">{ann.title}</p>
                        <p className="text-xs text-[#8a8a8a]">To: {ann.recipient}</p>
                      </div>
                      <span className="text-xs bg-green-900 text-green-200 px-2 py-1 rounded">✓</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* REMAINING TABS */}
          {['board-operations', 'communications', 'assignments', 'governance', 'system-control', 'reports', 'audit'].includes(activeTab) && (
            <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6 rounded space-y-4 animate-fadeIn">
              <h3 className="font-mono font-bold text-[#d4a574] uppercase">{activeTab.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}</h3>
              <p className="text-[#b0a095]">Framework ready for backend integration.</p>
            </div>
          )}

          {/* SHADOW CONTROL */}
          {activeTab === 'shadow-control' && (
            <div className="space-y-6 animate-fadeIn">
              <RoleSpecificShadow role="admin" query="What's the status?" response="Admin Dashboard: 3 HIGH gym alerts, 3 OPEN board items. All coaches active. Athletes: 2 GREEN, 1 YELLOW. Board compliance items due Sep 15. Ready for management action." />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
