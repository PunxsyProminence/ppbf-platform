'use client';

import React, { useState } from 'react';

type MessageType = 'Note' | 'Question' | 'Concern' | 'Achievement' | 'Update';
type RelationshipType = 'Parent' | 'Guardian' | 'Coach Contact';

interface StudentProfile {
  id: string;
  name: string;
  track: string;
  joinDate: string;
  attendance: number;
  skillLevel: 'Beginner' | 'Intermediate' | 'Advanced' | 'Competitive';
  recentProgress: string[];
  currentGoals: string[];
  upcomingEvents: string[];
}

interface ParentMessage {
  id: string;
  studentId: string;
  sender: 'parent' | 'coach';
  messageType: MessageType;
  subject: string;
  body: string;
  timestamp: string;
  read: boolean;
}

interface AttendanceRecord {
  date: string;
  sessionType: string;
  attended: boolean;
  performance?: string;
}

export default function ParentHub() {
  const [activeStudent, setActiveStudent] = useState<string>('student_001');
  const [students, setStudents] = useState<StudentProfile[]>([
    {
      id: 'student_001',
      name: 'Alex Thompson',
      track: 'Foundations',
      joinDate: '2025-09-15',
      attendance: 92,
      skillLevel: 'Beginner',
      recentProgress: ['Improved stance mechanics', 'Better left jab accuracy', 'Increased cardio endurance', 'Mastered basic combinations'],
      currentGoals: ['Perfect 5-punch combo', 'Build conditioning to 10 rounds', 'Improve defensive footwork'],
      upcomingEvents: ['Youth Belt Test - Aug 20', 'Friendly Sparring - Aug 27', 'Summer Showcase - Sep 10']
    },
    {
      id: 'student_002',
      name: 'Jordan Chen',
      track: 'Competition',
      joinDate: '2025-08-01',
      attendance: 88,
      skillLevel: 'Intermediate',
      recentProgress: ['Advanced ring IQ', 'Counter-punching techniques', 'Strategic round planning'],
      currentGoals: ['Win 3 consecutive matches', 'Master head movement patterns', 'Build power in cross'],
      upcomingEvents: ['Regional Tournament - Aug 25', 'Technical Workshop - Sep 5']
    }
  ]);

  const [messages, setMessages] = useState<ParentMessage[]>([
    { id: 'pm_1', studentId: 'student_001', sender: 'coach', messageType: 'Achievement', subject: 'Great Progress This Week!', body: 'Alex showed excellent focus during today\'s session. His footwork has improved dramatically and he\'s taking feedback really well.', timestamp: new Date(Date.now() - 86400000).toISOString(), read: true },
    { id: 'pm_2', studentId: 'student_001', sender: 'coach', messageType: 'Note', subject: 'Attendance Reminder', body: 'Just a friendly reminder about Friday\'s 5pm session. Let us know if there are any schedule conflicts.', timestamp: new Date(Date.now() - 172800000).toISOString(), read: true },
    { id: 'pm_3', studentId: 'student_001', sender: 'parent', messageType: 'Question', subject: 'Sparring Gear', body: 'What protective equipment does Alex need before the friendly sparring session?', timestamp: new Date(Date.now() - 259200000).toISOString(), read: false }
  ]);

  const [attendanceHistory, setAttendanceHistory] = useState<AttendanceRecord[]>([
    { date: '2026-07-11', sessionType: 'Youth Class', attended: true, performance: 'Great focus and effort' },
    { date: '2026-07-10', sessionType: 'Open Gym', attended: true, performance: 'Worked on combinations' },
    { date: '2026-07-09', sessionType: 'Youth Class', attended: false },
    { date: '2026-07-08', sessionType: 'Conditioning', attended: true, performance: 'Strong performance' },
    { date: '2026-07-07', sessionType: 'Youth Class', attended: true, performance: 'Excellent stance work' }
  ]);

  const [showNewMessage, setShowNewMessage] = useState(false);
  const [newMessageType, setNewMessageType] = useState<MessageType>('Note');
  const [newMessageSubject, setNewMessageSubject] = useState('');
  const [newMessageBody, setNewMessageBody] = useState('');

  const [selectedTab, setSelectedTab] = useState<'overview' | 'messages' | 'attendance' | 'progress' | 'resources'>('overview');
  const [expandedMessage, setExpandedMessage] = useState<string | null>(null);

  const currentStudent = students.find(s => s.id === activeStudent);

  const handleSendMessage = () => {
    if (!newMessageSubject || !newMessageBody || !activeStudent) return;
    const newMsg: ParentMessage = {
      id: `pm_${Date.now()}`,
      studentId: activeStudent,
      sender: 'parent',
      messageType: newMessageType,
      subject: newMessageSubject,
      body: newMessageBody,
      timestamp: new Date().toISOString(),
      read: false
    };
    setMessages([...messages, newMsg]);
    setNewMessageSubject('');
    setNewMessageBody('');
    setNewMessageType('Note');
    setShowNewMessage(false);
  };

  const studentMessages = messages.filter(m => m.studentId === activeStudent);
  const unreadCount = studentMessages.filter(m => !m.read && m.sender === 'coach').length;

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* HEADER */}
      <div className="bg-[#1a1a1a] border-4 border-[#8b4444] p-4">
        <div className="text-xs font-mono text-[#d4a574] font-bold uppercase">Parent Portal</div>
        <h2 className="text-xl font-black font-mono text-[#e8d7c6]">My Child's Progress</h2>
      </div>

      {/* STUDENT SELECTOR */}
      <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-4">
        <h3 className="text-xs font-mono font-bold text-[#d4a574] uppercase mb-3">Select Student</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {students.map(student => (
            <button
              key={student.id}
              onClick={() => setActiveStudent(student.id)}
              className={`p-3 border-2 transition text-left ${activeStudent === student.id ? 'bg-[#5a2a2a] border-[#8b4444] text-[#e8d7c6]' : 'bg-[#1a1a1a] border-[#8b4444]/50 text-[#b0a095] hover:text-[#e8d7c6]'}`}
            >
              <div className="font-bold font-mono text-sm">{student.name}</div>
              <div className="text-xs font-mono text-[#8a8a8a] mt-1">{student.track} • {student.attendance}% Attendance</div>
            </button>
          ))}
        </div>
      </div>

      {currentStudent && (
        <>
          {/* QUICK STATS */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-4">
              <div className="text-[#8a8a8a] text-[10px] font-mono mb-2">Skill Level</div>
              <div className="text-[#e8d7c6] font-bold font-mono">{currentStudent.skillLevel}</div>
            </div>
            <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-4">
              <div className="text-[#8a8a8a] text-[10px] font-mono mb-2">Attendance</div>
              <div className="text-[#e8d7c6] font-bold font-mono">{currentStudent.attendance}%</div>
            </div>
            <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-4">
              <div className="text-[#8a8a8a] text-[10px] font-mono mb-2">Member Since</div>
              <div className="text-[#e8d7c6] font-bold font-mono">{new Date(currentStudent.joinDate).toLocaleDateString()}</div>
            </div>
            <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-4">
              <div className="text-[#8a8a8a] text-[10px] font-mono mb-2">Track</div>
              <div className="text-[#e8d7c6] font-bold font-mono">{currentStudent.track}</div>
            </div>
          </div>

          {/* TAB NAVIGATION */}
          <div className="flex flex-wrap gap-2 border-b-2 border-[#8b4444] pb-3">
            {(['overview', 'messages', 'attendance', 'progress', 'resources'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setSelectedTab(tab)}
                className={`px-4 py-2 font-mono text-xs font-bold transition border-b-2 ${selectedTab === tab ? 'text-[#e8d7c6] border-[#8b4444]' : 'text-[#b0a095] border-transparent hover:text-[#e8d7c6]'}`}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>

          {/* OVERVIEW TAB */}
          {selectedTab === 'overview' && (
            <div className="space-y-4">
              <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-4">
                <h3 className="text-sm font-bold font-mono text-[#e8d7c6] uppercase">Recent Progress</h3>
                <div className="space-y-2">
                  {currentStudent.recentProgress.map((prog, idx) => (
                    <div key={idx} className="bg-[#1a1a1a] border-l-4 border-[#2a6b2a] p-3 flex items-start gap-3">
                      <span className="text-[#2a6b2a] font-bold">✓</span>
                      <p className="text-sm font-mono text-[#e8d7c6]">{prog}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-3">
                  <h3 className="text-xs font-bold font-mono text-[#d4a574] uppercase">Current Goals</h3>
                  <div className="space-y-2">
                    {currentStudent.currentGoals.map((goal, idx) => (
                      <div key={idx} className="bg-[#1a1a1a] p-2 border-2 border-[#8b4444]/30 text-[10px] font-mono text-[#b0a095]">
                        • {goal}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-3">
                  <h3 className="text-xs font-bold font-mono text-[#d4a574] uppercase">Upcoming Events</h3>
                  <div className="space-y-2">
                    {currentStudent.upcomingEvents.map((event, idx) => (
                      <div key={idx} className="bg-[#1a1a1a] p-2 border-2 border-[#8b4444]/30 text-[10px] font-mono text-[#e8d7c6]">
                        📅 {event}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* MESSAGES TAB */}
          {selectedTab === 'messages' && (
            <div className="space-y-4">
              {!showNewMessage ? (
                <button onClick={() => setShowNewMessage(true)} className="w-full bg-[#8b4444] hover:bg-[#5a2a2a] text-[#e8d7c6] font-mono font-bold text-xs py-2 border-2 border-[#8b4444] transition">
                  + Send Message to Coach
                </button>
              ) : (
                <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-4 space-y-3">
                  <select value={newMessageType} onChange={(e) => setNewMessageType(e.target.value as MessageType)} className="w-full bg-[#1a1a1a] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none">
                    <option value="Note">Note</option>
                    <option value="Question">Question</option>
                    <option value="Concern">Concern</option>
                    <option value="Achievement">Achievement</option>
                    <option value="Update">Update</option>
                  </select>
                  <input type="text" value={newMessageSubject} onChange={(e) => setNewMessageSubject(e.target.value)} placeholder="Subject" className="w-full bg-[#1a1a1a] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none" />
                  <textarea value={newMessageBody} onChange={(e) => setNewMessageBody(e.target.value)} placeholder="Message body..." className="w-full h-20 bg-[#1a1a1a] border-2 border-[#8b4444] px-3 py-2 text-xs font-mono text-[#e8d7c6] focus:outline-none resize-none" />
                  <div className="flex gap-2">
                    <button onClick={handleSendMessage} className="flex-1 bg-[#2a6b2a] hover:bg-[#1a5a1a] text-[#e8d7c6] font-mono font-bold text-xs py-2 border-2 border-[#2a6b2a] transition">✅ Send</button>
                    <button onClick={() => setShowNewMessage(false)} className="flex-1 bg-[#4a4a4a] hover:bg-[#3a3a3a] text-[#e8d7c6] font-mono font-bold text-xs py-2 border-2 border-[#4a4a4a] transition">Cancel</button>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {unreadCount > 0 && (
                  <div className="bg-[#6b5a2a]/30 border-2 border-[#d4a574] p-2 text-xs font-mono text-[#d4a574] font-bold">
                    🔔 {unreadCount} new message{unreadCount > 1 ? 's' : ''} from coach
                  </div>
                )}
                {studentMessages.map(msg => (
                  <div key={msg.id} className="bg-[#0a0a0a] border-2 border-[#8b4444] overflow-hidden">
                    <button onClick={() => setExpandedMessage(expandedMessage === msg.id ? null : msg.id)} className="w-full p-3 text-left hover:bg-[#1a1a1a] transition flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 ${msg.sender === 'coach' ? 'bg-[#2a5a6b]/30 text-[#7ab5c9]' : 'bg-[#5a3a1a]/30 text-[#d4a574]'}`}>
                            {msg.sender === 'coach' ? '👨‍🏫 Coach' : '👤 You'}
                          </span>
                          <span className={`text-[9px] font-mono ${msg.messageType === 'Achievement' ? 'text-[#2a6b2a]' : msg.messageType === 'Concern' ? 'text-[#ff6b6b]' : 'text-[#d4a574]'}`}>{msg.messageType}</span>
                          {!msg.read && msg.sender === 'coach' && <span className="w-2 h-2 bg-[#d4a574] rounded-full"></span>}
                        </div>
                        <div className="text-sm font-mono font-bold text-[#e8d7c6]">{msg.subject}</div>
                        <div className="text-[10px] text-[#8a8a8a] font-mono mt-1">{new Date(msg.timestamp).toLocaleString()}</div>
                      </div>
                      <div className="text-[#b0a095] ml-4">{expandedMessage === msg.id ? '▼' : '▶'}</div>
                    </button>
                    {expandedMessage === msg.id && (
                      <div className="bg-[#1a1a1a] border-t-2 border-[#8b4444]/30 p-3 text-sm font-mono text-[#b0a095]">
                        {msg.body}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ATTENDANCE TAB */}
          {selectedTab === 'attendance' && (
            <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-4">
              <div className="space-y-3">
                {attendanceHistory.map((record, idx) => (
                  <div key={idx} className={`border-2 p-3 ${record.attended ? 'bg-[#2a5a2a]/20 border-[#2a6b2a]' : 'bg-[#5a2a2a]/20 border-[#8b4444]'}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono font-bold text-[#e8d7c6] text-sm">{record.sessionType}</span>
                      <span className={`text-[9px] font-bold px-2 py-0.5 font-mono ${record.attended ? 'bg-[#2a6b2a] text-[#a0d0a0]' : 'bg-[#8b4444] text-[#e8d7c6]'}`}>
                        {record.attended ? '✓ Present' : '✕ Absent'}
                      </span>
                    </div>
                    <div className="flex justify-between items-center text-xs">
                      <span className="font-mono text-[#8a8a8a]">{new Date(record.date).toLocaleDateString()}</span>
                      {record.performance && <span className="font-mono text-[#b0a095]">{record.performance}</span>}
                    </div>
                  </div>
                ))}
              </div>
              <div className="bg-[#1a1a1a] border-2 border-[#8b4444]/30 p-3 text-center">
                <div className="text-xs font-mono text-[#8a8a8a] mb-1">Overall Attendance</div>
                <div className="text-2xl font-mono font-bold text-[#d4a574]">{currentStudent.attendance}%</div>
              </div>
            </div>
          )}

          {/* PROGRESS TAB */}
          {selectedTab === 'progress' && (
            <div className="space-y-4">
              <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-4">
                <h3 className="text-sm font-bold font-mono text-[#e8d7c6] uppercase">Skills Development</h3>
                <div className="space-y-3">
                  {['Footwork', 'Punching Technique', 'Defensive Skills', 'Conditioning', 'Boxing IQ', 'Discipline'].map((skill, idx) => (
                    <div key={idx} className="space-y-1">
                      <div className="flex justify-between text-xs font-mono">
                        <span className="text-[#b0a095]">{skill}</span>
                        <span className="text-[#d4a574] font-bold">{45 + idx * 10}%</span>
                      </div>
                      <div className="w-full bg-[#1a1a1a] border-2 border-[#8b4444]/30 h-2 overflow-hidden">
                        <div className="bg-[#8b4444] h-full transition-all" style={{ width: `${45 + idx * 10}%` }}></div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* RESOURCES TAB */}
          {selectedTab === 'resources' && (
            <div className="space-y-4">
              <div className="bg-[#0a0a0a] border-2 border-[#8b4444] p-6 space-y-4">
                <h3 className="text-sm font-bold font-mono text-[#e8d7c6] uppercase mb-4">Helpful Resources</h3>
                <div className="space-y-3">
                  <div className="bg-[#1a1a1a] border-2 border-[#8b4444]/30 p-4">
                    <div className="font-bold font-mono text-[#d4a574] mb-1">📋 Training Schedule</div>
                    <p className="text-xs font-mono text-[#b0a095]">View class times and book sessions for your child</p>
                  </div>
                  <div className="bg-[#1a1a1a] border-2 border-[#8b4444]/30 p-4">
                    <div className="font-bold font-mono text-[#d4a574] mb-1">💪 Nutrition Guide</div>
                    <p className="text-xs font-mono text-[#b0a095]">Best practices for fueling young athletes</p>
                  </div>
                  <div className="bg-[#1a1a1a] border-2 border-[#8b4444]/30 p-4">
                    <div className="font-bold font-mono text-[#d4a574] mb-1">🛡️ Safety Information</div>
                    <p className="text-xs font-mono text-[#b0a095]">Equipment requirements and injury prevention</p>
                  </div>
                  <div className="bg-[#1a1a1a] border-2 border-[#8b4444]/30 p-4">
                    <div className="font-bold font-mono text-[#d4a574] mb-1">📞 Contact Information</div>
                    <p className="text-xs font-mono text-[#b0a095]">Reach out to coaches and staff</p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
