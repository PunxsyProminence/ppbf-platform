'use client';

import { useMemo, useState } from 'react';

type RouteTrack = 'NON_PROFIT_BOXING_PROGRAM' | 'AIR_FORCE_SPECOPS_PREP_LINE';

type SkillPrerequisite = {
  id: string;
  skill: string;
  prerequisites: string[];
  certificationStatus: 'pending' | 'ready';
};

type DrillLessonMap = {
  id: string;
  drill: string;
  lesson: string;
  route: RouteTrack;
};

type BadgeAward = {
  id: string;
  athlete: string;
  badge: string;
  points: number;
};

type KnowledgeGraphRow = {
  id: string;
  drillToGoal: string;
  drillToResearch: string;
  drillToInjuryRisk: string;
  drillToRoute: string;
  drillToHistoricalMapping: string;
};

const IMMUNITY_GATE = 'Pending Coach Verification Flag {"verified_by_jason": false}';

const skillTree: SkillPrerequisite[] = [
  {
    id: 'sk-001',
    skill: 'Defensive Ring Navigation',
    prerequisites: ['Footwork Grid Level 2', 'Guard Retention Basics'],
    certificationStatus: 'pending',
  },
  {
    id: 'sk-002',
    skill: 'Pressure Counter Sequencing',
    prerequisites: ['Slip-Line Timing', 'Controlled Spar Recall Drill'],
    certificationStatus: 'ready',
  },
  {
    id: 'sk-003',
    skill: 'Scenario Decision Flow',
    prerequisites: ['Film Room Pattern Lab', 'Pulse Recovery Checkpoint'],
    certificationStatus: 'pending',
  },
];

const drillLessonMappings: DrillLessonMap[] = [
  {
    id: 'dl-001',
    drill: 'Three-Lane Exit Drill',
    lesson: 'Ring Control Under Pressure',
    route: 'NON_PROFIT_BOXING_PROGRAM',
  },
  {
    id: 'dl-002',
    drill: 'Breathing Ladder with Interval Stress',
    lesson: 'Load Management and Recovery Windows',
    route: 'AIR_FORCE_SPECOPS_PREP_LINE',
  },
  {
    id: 'dl-003',
    drill: 'Partner Reaction Bell Matrix',
    lesson: 'Decision Latency Reduction',
    route: 'NON_PROFIT_BOXING_PROGRAM',
  },
];

const startingBadges: BadgeAward[] = [
  { id: 'bd-001', athlete: 'Mila Ortega', badge: 'Discipline Anchor', points: 20 },
  { id: 'bd-002', athlete: 'Andre Porter', badge: 'Leadership Relay', points: 25 },
];

const knowledgeGraphRows: KnowledgeGraphRow[] = [
  {
    id: 'kg-001',
    drillToGoal: 'Three-Lane Exit Drill -> Safe Ring Exit Timing',
    drillToResearch: 'Linked to adolescent reaction latency study',
    drillToInjuryRisk: 'Mitigates corner entrapment risk',
    drillToRoute: 'Non-Profit Boxing Program Track',
    drillToHistoricalMapping: 'Derived from 2025 district spar incident review',
  },
  {
    id: 'kg-002',
    drillToGoal: 'Breathing Ladder -> Recovery Control Under Stress',
    drillToResearch: 'Linked to cardiorespiratory threshold paper',
    drillToInjuryRisk: 'Reduces overexertion spike risk',
    drillToRoute: 'Air Force SpecOps Prep Line',
    drillToHistoricalMapping: 'Mapped to archived military prep simulation logs',
  },
  {
    id: 'kg-003',
    drillToGoal: 'Reaction Bell Matrix -> Decision Speed Gain',
    drillToResearch: 'Linked to perception-action coupling research',
    drillToInjuryRisk: 'Lowers delayed guard response risk',
    drillToRoute: 'Cross-Track Shared Core',
    drillToHistoricalMapping: 'Correlated with 2024-2026 training cycle deltas',
  },
];

export default function CurriculumProgressionEngine() {
  const [activeRoute, setActiveRoute] = useState<RouteTrack>('NON_PROFIT_BOXING_PROGRAM');
  const [badgeAwards, setBadgeAwards] = useState<BadgeAward[]>(startingBadges);
  const [serviceCredits, setServiceCredits] = useState(42);
  const [leadershipCredits, setLeadershipCredits] = useState(18);

  const filteredDrillLessonMappings = useMemo(
    () => drillLessonMappings.filter((mapping) => mapping.route === activeRoute),
    [activeRoute],
  );

  function issueMockBadge() {
    setBadgeAwards((prev) => [
      ...prev,
      {
        id: `bd-${String(prev.length + 1).padStart(3, '0')}`,
        athlete: activeRoute === 'NON_PROFIT_BOXING_PROGRAM' ? 'Lena Cho' : 'Jonah Ruiz',
        badge: activeRoute === 'NON_PROFIT_BOXING_PROGRAM' ? 'Community Standard Keeper' : 'Stress Adaptation Marker',
        points: activeRoute === 'NON_PROFIT_BOXING_PROGRAM' ? 15 : 18,
      },
    ]);
  }

  return (
    <section className="mx-auto w-full max-w-7xl bg-black border border-zinc-800 rounded-none p-4">
      <header className="border-b border-zinc-800 pb-3">
        <h1 className="text-sm uppercase tracking-[0.2em] text-slate-200">Dual-Track and Curriculum Engine</h1>
        <p className="mt-2 text-xs text-zinc-500">Layers 05, 31, 35, 36</p>
        <p className="mt-3"><span className="stamp stamp--brass stamp--flat">Planned — Not Yet Implemented</span></p>
        <p className="mt-2 text-xs text-zinc-400">
          Every athlete, badge, progression, and curriculum figure below is fabricated sample data.
          Nothing on this page reads or writes real records — do not act on anything it shows.
        </p>
      </header>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <section className="bg-black border border-zinc-800 rounded-none p-3">
          <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">[L05] Development Routes [V-COACH]</h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setActiveRoute('NON_PROFIT_BOXING_PROGRAM')}
              className={`border border-zinc-800 rounded-none p-2 text-xs text-left ${
                activeRoute === 'NON_PROFIT_BOXING_PROGRAM' ? 'bg-zinc-900 text-slate-100' : 'bg-black text-zinc-400 hover:text-slate-200'
              }`}
            >
              Non-Profit Boxing Program
            </button>
            <button
              type="button"
              onClick={() => setActiveRoute('AIR_FORCE_SPECOPS_PREP_LINE')}
              className={`border border-zinc-800 rounded-none p-2 text-xs text-left ${
                activeRoute === 'AIR_FORCE_SPECOPS_PREP_LINE' ? 'bg-zinc-900 text-slate-100' : 'bg-black text-zinc-400 hover:text-slate-200'
              }`}
            >
              Air Force SpecOps Prep Line
            </button>
          </div>
          <p className="mt-3 border border-zinc-800 bg-black p-2 text-xs text-zinc-300">
            Active Route: {activeRoute === 'NON_PROFIT_BOXING_PROGRAM' ? 'Non-Profit Boxing Program' : 'Air Force SpecOps Prep Line'}
          </p>
        </section>

        <section className="bg-black border border-zinc-800 rounded-none p-3">
          <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">[L31] Curriculum Engine [V-COACH]</h2>
          <p className="mt-2 text-xs text-zinc-400">Skill Prerequisite Tree</p>
          <ul className="mt-2 space-y-2 text-xs">
            {skillTree.map((item) => (
              <li key={item.id} className="border border-zinc-800 bg-black p-2">
                <p className="text-slate-200">{item.skill}</p>
                <p className="text-zinc-500">Prerequisites: {item.prerequisites.join(' -> ')}</p>
                <p className={item.certificationStatus === 'ready' ? 'text-emerald-400' : 'text-[#b91c1c]'}>
                  Skill Certification: {item.certificationStatus.toUpperCase()}
                </p>
                <p className="mt-1 text-[11px] text-[#b91c1c]">{IMMUNITY_GATE}</p>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-xs text-zinc-400">Drill-to-Lesson Mapping</p>
          <ul className="mt-2 space-y-2 text-xs">
            {filteredDrillLessonMappings.map((item) => (
              <li key={item.id} className="border border-zinc-800 bg-black p-2">
                <p className="text-slate-200">{item.drill}</p>
                <p className="text-zinc-500">Lesson: {item.lesson}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="bg-black border border-zinc-800 rounded-none p-3">
          <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">[L35] Athlete Achievement [V-COACH]</h2>
          <p className="mt-2 text-xs text-zinc-400">Badge Award Console</p>
          <button
            type="button"
            onClick={issueMockBadge}
            className="mt-2 border border-zinc-700 bg-black px-3 py-1 text-xs text-slate-200 hover:bg-zinc-900"
          >
            Issue Mock Badge
          </button>
          <ul className="mt-2 space-y-2 text-xs">
            {badgeAwards.map((badge) => (
              <li key={badge.id} className="border border-zinc-800 bg-black p-2">
                <p className="text-slate-200">{badge.athlete} - {badge.badge}</p>
                <p className="text-zinc-500">Points: {badge.points}</p>
                <p className="mt-1 text-[11px] text-[#b91c1c]">{IMMUNITY_GATE}</p>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-xs text-zinc-400">Service and Leadership Credits</p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <div className="border border-zinc-800 bg-black p-2">
              <p className="text-zinc-500">Service Credits</p>
              <p className="text-slate-200">{serviceCredits}</p>
              <button
                type="button"
                onClick={() => setServiceCredits((prev) => prev + 1)}
                className="mt-2 w-full border border-zinc-700 bg-black px-2 py-1 text-xs text-slate-200 hover:bg-zinc-900"
              >
                +1 Service
              </button>
            </div>
            <div className="border border-zinc-800 bg-black p-2">
              <p className="text-zinc-500">Leadership Credits</p>
              <p className="text-slate-200">{leadershipCredits}</p>
              <button
                type="button"
                onClick={() => setLeadershipCredits((prev) => prev + 1)}
                className="mt-2 w-full border border-zinc-700 bg-black px-2 py-1 text-xs text-slate-200 hover:bg-zinc-900"
              >
                +1 Leadership
              </button>
            </div>
          </div>
        </section>

        <section className="bg-black border border-zinc-800 rounded-none p-3 xl:col-span-2">
          <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">[L36] Knowledge Graph [V-COACH]</h2>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border border-zinc-800">
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Drill-to-Goal</th>
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Drill-to-Research</th>
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Drill-to-Injury Risk</th>
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Drill-to-Route</th>
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Drill-to-Historical Mapping</th>
                </tr>
              </thead>
              <tbody>
                {knowledgeGraphRows.map((row) => (
                  <tr key={row.id} className="border border-zinc-800">
                    <td className="border border-zinc-800 p-2">{row.drillToGoal}</td>
                    <td className="border border-zinc-800 p-2">{row.drillToResearch}</td>
                    <td className="border border-zinc-800 p-2">{row.drillToInjuryRisk}</td>
                    <td className="border border-zinc-800 p-2">{row.drillToRoute}</td>
                    <td className="border border-zinc-800 p-2">{row.drillToHistoricalMapping}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </section>
  );
}
