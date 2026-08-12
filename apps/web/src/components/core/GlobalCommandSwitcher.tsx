'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

type BuildStatus = '[BUILT]' | '[PARTIALLY SCAFFOLDED]' | '[INTENDED / NOT YET BUILT]';

type CommandRoute = {
  role: number;
  account: string;
  href: string;
  status: BuildStatus;
};

type LaneAssignment = {
  athlete: string;
  lane: 'Deegan Lane (Heavy Bags)' | 'Neeko Lane (Sparring Ring)';
};

type LabSlot = {
  slot: string;
  owner: string;
  task: string;
};

const COMMAND_ROUTES: CommandRoute[] = [
  { role: 1, account: 'Athlete Mock Account', href: '/athlete/dashboard', status: '[BUILT]' },
  { role: 2, account: 'Guardian Mock Account', href: '/guardian/dashboard', status: '[PARTIALLY SCAFFOLDED]' },
  { role: 3, account: 'Coach Mock Account', href: '/coach/operations', status: '[BUILT]' },
  { role: 4, account: 'Admin Mock Account', href: '/admin', status: '[BUILT]' },
  { role: 5, account: 'Board President Mock Account', href: '/board/dashboard', status: '[PARTIALLY SCAFFOLDED]' },
  { role: 6, account: 'Volunteer Coordinator Mock Account', href: '/admin/volunteer-management', status: '[INTENDED / NOT YET BUILT]' },
  { role: 7, account: 'Board Secretary Mock Account', href: '/board/dashboard', status: '[BUILT]' },
  { role: 8, account: 'Board Treasurer Mock Account', href: '/board/dashboard', status: '[PARTIALLY SCAFFOLDED]' },
  { role: 9, account: 'Director Mock Account', href: '/director/dashboard', status: '[BUILT]' },
  { role: 10, account: 'Staff Communications Mock Account', href: '/admin/communications', status: '[PARTIALLY SCAFFOLDED]' },
  { role: 11, account: 'External Intake Mock Account', href: '/public', status: '[INTENDED / NOT YET BUILT]' },
  { role: 12, account: 'QA Sandbox Mock Account', href: '/admin/retro-lab', status: '[BUILT]' },
];

const L21_ASSIGNMENTS: LaneAssignment[] = [
  { athlete: 'Mila Ortega', lane: 'Deegan Lane (Heavy Bags)' },
  { athlete: 'Andre Porter', lane: 'Neeko Lane (Sparring Ring)' },
  { athlete: 'Lena Cho', lane: 'Deegan Lane (Heavy Bags)' },
  { athlete: 'Jonah Ruiz', lane: 'Neeko Lane (Sparring Ring)' },
];

const PRINT_LAB_SCHEDULE: LabSlot[] = [
  { slot: '08:00-09:00', owner: 'Coach Rivera', task: 'Mouthguard fit prototype run' },
  { slot: '12:30-13:30', owner: 'Staff Kim', task: 'Hand-wrap spacer print batch' },
  { slot: '17:00-18:00', owner: 'Ops Desk', task: 'Protective insert calibration test' },
];

export default function GlobalCommandSwitcher() {
  const [showHandoff, setShowHandoff] = useState(false);

  const zuluTelemetry = useMemo(
    () => [
      {
        timestamp: '2026-08-12T01:07:34Z',
        event: 'route_scan_completed',
        detail: 'Global Command Directory route matrix validated in mock mode.',
      },
      {
        timestamp: '2026-08-12T01:09:12Z',
        event: 'allocation_sync_preview',
        detail: 'Lane assignment payload prepared for L21 program management simulation.',
      },
      {
        timestamp: '2026-08-12T01:11:48Z',
        event: 'handoff_token_generated',
        detail: 'Build continuity markdown token staged for operator copy.',
      },
    ],
    [],
  );

  const handoffMarkdown = useMemo(
    () => [
      '# v21.1 Mock Handoff Token',
      '',
      '- Directory: 12 mock accounts mapped to route architecture.',
      '- L21 Program Management: lane assignment and 3D Print Lab schedule loaded.',
      '- L25 Build Continuity: token generated from admin command surface.',
      '- Telemetry Route: /system_control/pending/ with Zulu event snapshots.',
    ].join('\n'),
    [],
  );

  return (
    <section className="min-h-screen bg-[#09090b] font-mono text-slate-300 p-4">
      <div className="mx-auto w-full max-w-[1500px] space-y-4">
        <div className="border border-zinc-800 bg-black rounded-none p-3">
          <p className="text-sm text-[#b91c1c]">⚠️ WARNING: Live access permissions detached. System running in mock-only front-end simulation mode.</p>
        </div>

        <section className="border border-zinc-800 bg-black rounded-none p-4">
          <h2 className="text-sm uppercase tracking-[0.2em] text-slate-200">Global Command Directory</h2>
          <p className="mt-2 text-xs text-zinc-500">12 Mock Accounts - Route Architecture Switcher</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {COMMAND_ROUTES.map((entry) => (
              <Link
                key={`${entry.role}-${entry.href}`}
                href={entry.href}
                className="border border-zinc-800 hover:bg-zinc-900 rounded-none p-3 text-left transition-colors"
              >
                <p className="text-xs text-zinc-500">Role {entry.role}</p>
                <p className="mt-1 text-sm text-slate-200">{entry.account}</p>
                <p className="mt-1 text-xs text-zinc-500">{entry.href}</p>
                <p className="mt-2 text-xs text-slate-300">{entry.status}</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <article className="border border-zinc-800 bg-black rounded-none p-4">
            <h3 className="text-xs uppercase tracking-[0.2em] text-slate-200">[L21] Program Management</h3>
            <p className="mt-2 text-xs text-zinc-500">Lane Allocations</p>
            <ul className="mt-2 space-y-1 text-xs text-zinc-300">
              {L21_ASSIGNMENTS.map((assignment) => (
                <li key={`${assignment.athlete}-${assignment.lane}`} className="border border-zinc-800 bg-black rounded-none p-2">
                  {assignment.athlete}{' -> '}{assignment.lane}
                </li>
              ))}
            </ul>

            <p className="mt-3 text-xs text-zinc-500">3D Print Lab schedule</p>
            <ul className="mt-2 space-y-1 text-xs text-zinc-300">
              {PRINT_LAB_SCHEDULE.map((slot) => (
                <li key={`${slot.slot}-${slot.owner}`} className="border border-zinc-800 bg-black rounded-none p-2">
                  {slot.slot} | {slot.owner} | {slot.task}
                </li>
              ))}
            </ul>
          </article>

          <article className="border border-zinc-800 bg-black rounded-none p-4">
            <h3 className="text-xs uppercase tracking-[0.2em] text-slate-200">[L25] Build Continuity</h3>
            <button
              type="button"
              onClick={() => setShowHandoff((prev) => !prev)}
              className="mt-2 border border-zinc-800 bg-black hover:bg-zinc-900 rounded-none px-3 py-2 text-xs text-slate-200 transition-colors"
            >
              Generate Markdown Handoff Token
            </button>

            {showHandoff ? (
              <pre className="mt-3 overflow-x-auto border border-zinc-800 bg-black rounded-none p-3 text-xs text-zinc-300">
{handoffMarkdown}
              </pre>
            ) : null}
          </article>
        </section>
      </div>

      <section className="fixed inset-x-0 bottom-0 z-40 bg-black border-t border-zinc-800 text-green-500">
        <div className="mx-auto w-full max-w-[1500px] px-4 py-3">
          <p className="text-xs">ROUTE: /system_control/pending/</p>
          <pre className="mt-2 max-h-40 overflow-auto text-xs">{JSON.stringify(zuluTelemetry, null, 2)}</pre>
        </div>
      </section>
    </section>
  );
}
