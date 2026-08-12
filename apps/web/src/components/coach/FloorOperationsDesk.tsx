'use client';

import { useState } from 'react';

type ClearanceItem = {
  id: string;
  athlete: string;
  checkpoint: string;
  status: 'pending' | 'ready';
};

type AttendanceRecord = {
  id: string;
  athlete: string;
  streakDays: number;
  absenceTag: 'excused' | 'unexcused';
  sessionsBooked: number;
  sessionCapacity: number;
};

type MatchupCard = {
  id: string;
  athleteA: string;
  athleteB: string;
  division: string;
  weighInChecklist: string[];
  opponentResearchWorkspace: string[];
};

const clearanceChecklist: ClearanceItem[] = [
  {
    id: 'clr-001',
    athlete: 'Mila Ortega',
    checkpoint: 'Concussion protocol sign-off',
    status: 'pending',
  },
  {
    id: 'clr-002',
    athlete: 'Andre Porter',
    checkpoint: 'Mobility and pain-free movement',
    status: 'ready',
  },
  {
    id: 'clr-003',
    athlete: 'Lena Cho',
    checkpoint: 'Cardio tolerance re-evaluation',
    status: 'pending',
  },
];

const attendanceMonitor: AttendanceRecord[] = [
  {
    id: 'att-001',
    athlete: 'Mila Ortega',
    streakDays: 9,
    absenceTag: 'excused',
    sessionsBooked: 4,
    sessionCapacity: 6,
  },
  {
    id: 'att-002',
    athlete: 'Andre Porter',
    streakDays: 14,
    absenceTag: 'unexcused',
    sessionsBooked: 6,
    sessionCapacity: 6,
  },
  {
    id: 'att-003',
    athlete: 'Lena Cho',
    streakDays: 5,
    absenceTag: 'excused',
    sessionsBooked: 3,
    sessionCapacity: 6,
  },
];

const matchmakerBoard: MatchupCard[] = [
  {
    id: 'mm-001',
    athleteA: 'Andre Porter',
    athleteB: 'Jonah Ruiz',
    division: 'Youth Welterweight',
    weighInChecklist: [
      'Photo ID verified',
      'Hydration check complete',
      'Official scale signed',
    ],
    opponentResearchWorkspace: [
      'Counter right-hand tendency mapped',
      'Front-foot pressure entry noted',
      'Defensive shell drop in rounds 2-3',
    ],
  },
  {
    id: 'mm-002',
    athleteA: 'Mila Ortega',
    athleteB: 'Rina Alvarez',
    division: 'Youth Flyweight',
    weighInChecklist: [
      'Guardian consent reconfirmed',
      'Weight class confirmed',
      'Medical notes attached',
    ],
    opponentResearchWorkspace: [
      'Lead hook exit lane identified',
      'Clinching frequency high near ropes',
      'Late-round cardio decline trend',
    ],
  },
];

const IMMUTABLE_GATE = 'Pending Coach Verification Flag {"verified_by_jason": false}';

export default function FloorOperationsDesk() {
  const [downgradeRationale, setDowngradeRationale] = useState('');

  return (
    <section className="mx-auto w-full max-w-7xl border border-zinc-800 bg-black rounded-none p-4">
      <header className="border-b border-zinc-800 pb-3">
        <h1 className="text-sm uppercase tracking-[0.2em] text-zinc-400">Coach Floor Operations Desk</h1>
        <p className="mt-2 text-xs text-zinc-500">Bundle 2: Layers 12, 27, 29</p>
      </header>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <article className="border border-zinc-800 bg-black rounded-none p-3">
          <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">
            L12 Medical / Recovery [V-COACH]
          </h2>
          <p className="mt-2 text-xs text-zinc-400">Return-to-Play Clearance Checklist</p>
          <label className="mt-3 block text-xs text-zinc-400" htmlFor="downgrade-rationale">
            Mandatory Downgrade / Modification Rationale
          </label>
          <input
            id="downgrade-rationale"
            type="text"
            value={downgradeRationale}
            onChange={(event) => setDowngradeRationale(event.target.value)}
            data-testid="drpe-lockout-input"
            className="mt-1 w-full border border-zinc-800 bg-black p-2 text-xs text-slate-200"
          />
          <ul className="mt-3 space-y-2 text-xs">
            {clearanceChecklist.map((item) => (
              <li key={item.id} className="border border-zinc-800 bg-black p-2">
                <p className="text-[10px] text-zinc-500">[V-COACH]</p>
                <p className="text-slate-200">{item.athlete}</p>
                <p className="text-zinc-400">{item.checkpoint}</p>
                <p className={item.status === 'pending' ? 'text-[#b91c1c]' : 'text-emerald-400'}>
                  Status: {item.status.toUpperCase()}
                </p>
                <p className="mt-1 text-[11px] text-[#b91c1c]">{IMMUTABLE_GATE}</p>
              </li>
            ))}
          </ul>
        </article>

        <article className="border border-zinc-800 bg-black rounded-none p-3">
          <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">
            L27 Attendance Control [V-COACH]
          </h2>
          <p className="mt-2 text-xs text-zinc-400">
            Consecutive Streak Monitor / Excused-Unexcused Absence Tags / Session Capacity Counter
          </p>
          <ul className="mt-3 space-y-2 text-xs">
            {attendanceMonitor.map((record) => (
              <li key={record.id} className="border border-zinc-800 bg-black p-2">
                <p className="text-[10px] text-zinc-500">[V-COACH]</p>
                <p className="text-slate-200">{record.athlete}</p>
                <p className="text-zinc-400">Consecutive Streak Monitor: {record.streakDays} days</p>
                <p className={record.absenceTag === 'unexcused' ? 'text-[#b91c1c]' : 'text-zinc-400'}>
                  {record.absenceTag === 'unexcused' ? 'Unexcused Absence Tag' : 'Excused Absence Tag'}
                </p>
                <p className="text-zinc-400">
                  Session Capacity Counter: {record.sessionsBooked}/{record.sessionCapacity}
                </p>
              </li>
            ))}
          </ul>
        </article>

        <article className="border border-zinc-800 bg-black rounded-none p-3">
          <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">
            L29 Competition Management [V-COACH]
          </h2>
          <p className="mt-2 text-xs text-zinc-400">Matchmaker Board</p>
          <ul className="mt-3 space-y-2 text-xs">
            {matchmakerBoard.map((card) => (
              <li key={card.id} className="border border-zinc-800 bg-black p-2">
                <p className="text-[10px] text-zinc-500">[V-COACH]</p>
                <p className="text-slate-200">{card.athleteA} vs {card.athleteB}</p>
                <p className="text-zinc-400">Division: {card.division}</p>
                <p className="mt-1 text-zinc-400">Weigh-In Checklist:</p>
                <ul className="mt-1 space-y-1 text-zinc-500">
                  {card.weighInChecklist.map((item) => (
                    <li key={item}>- {item}</li>
                  ))}
                </ul>
                <p className="mt-2 text-zinc-400">Opponent Research Workspace [V-COACH]:</p>
                <ul className="mt-1 space-y-1 text-zinc-500">
                  {card.opponentResearchWorkspace.map((item) => (
                    <li key={item}>- {item}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </article>
      </div>
    </section>
  );
}
