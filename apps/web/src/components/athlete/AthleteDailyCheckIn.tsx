'use client';

import { useMemo, useState } from 'react';

import DrillLibraryAccordion, { type DrillTaxonomy } from '@/src/components/drills/DrillLibraryAccordion';
import { calculateReadinessL14 } from '@/src/server/pilot/readinessMath';

const ATHLETE_DRILL_TAXONOMY: DrillTaxonomy = {
  'Level 01: Core Direct Cue': 'Guard high, chin down, exhale on impact, recover stance before next action.',
  'Level 02: Field Instruction Architecture': 'Run clean interval blocks: 45s output, 15s reset, with one technical focal point per block.',
  'Level 03: Psycho-Physiological Mapping': 'Track confidence shifts by round and identify when fatigue alters guard discipline or timing control.',
  'Level 04: Biomechanical Evidence Anchor': 'Prioritize hip-to-shoulder sequencing and stable foot pressure transfer to reduce overreach mechanics.',
  'Level 05: Lab Genesis & Sources': 'Use coach-reviewed session film and validated gym telemetry to confirm progression decisions.',
  'Level 06: Historical Chronology Genesis (Who, What, Where, When)': 'Document who issued cues, what changed, where drift occurred, and when adaptation stabilized.',
};

export default function AthleteDailyCheckIn() {
  const [sleepHours, setSleepHours] = useState(8);
  const [sorenessLevel, setSorenessLevel] = useState(4);
  const [disciplineScore, setDisciplineScore] = useState(7);
  const [preTrainingPhase, setPreTrainingPhase] = useState('Balanced Carbs + Hydration');
  const [intraTrainingPhase, setIntraTrainingPhase] = useState('Electrolyte Sips');
  const [postTrainingPhase, setPostTrainingPhase] = useState('Recovery Protein + Fruit');

  const readinessScore = useMemo(
    () => calculateReadinessL14(sleepHours, sorenessLevel, disciplineScore),
    [sleepHours, sorenessLevel, disciplineScore],
  );

  return (
    <section className="bg-[#09090b] text-slate-300 font-mono rounded-none border border-zinc-800 p-4">
      <header className="mb-4 border border-zinc-800 rounded-none p-3">
        <p className="text-xs uppercase tracking-[0.12em] text-slate-500">Role 1 Athlete View</p>
        <h1 className="mt-2 text-lg uppercase tracking-[0.12em] text-slate-200">Daily Readiness Check-In</h1>
      </header>

      <div className="grid gap-4">
        <label className="border border-zinc-800 rounded-none p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm">Sleep Hours (0-12)</span>
            <span className="text-sm text-slate-400">{sleepHours.toFixed(1)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={12}
            step={0.5}
            value={sleepHours}
            onChange={(event) => setSleepHours(Number(event.target.value))}
            data-testid="athlete-sleep-slider"
            className="mt-3 w-full"
          />
        </label>

        <label className="border border-zinc-800 rounded-none p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm">Soreness Level (1-10)</span>
            <span className="text-sm text-slate-400">{sorenessLevel}</span>
          </div>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={sorenessLevel}
            onChange={(event) => setSorenessLevel(Number(event.target.value))}
            data-testid="athlete-soreness-slider"
            className="mt-3 w-full"
          />
        </label>

        <label className="border border-zinc-800 rounded-none p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm">Discipline Score (1-10)</span>
            <span className="text-sm text-slate-400">{disciplineScore}</span>
          </div>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={disciplineScore}
            onChange={(event) => setDisciplineScore(Number(event.target.value))}
            data-testid="athlete-discipline-slider"
            className="mt-3 w-full"
          />
        </label>
      </div>

      <section className="mt-4 border border-zinc-800 rounded-none p-3">
        <h2 className="text-xs uppercase tracking-[0.12em] text-slate-500">Tri-Phase Nutritional Intake Data</h2>
        <div className="mt-3 grid gap-3">
          <label className="text-sm">
            Pre-Training Phase
            <select
              value={preTrainingPhase}
              onChange={(event) => setPreTrainingPhase(event.target.value)}
              data-testid="athlete-pre-training-phase"
              className="mt-2 w-full border border-zinc-800 bg-[#09090b] p-2 text-slate-300"
            >
              <option>Balanced Carbs + Hydration</option>
              <option>Light Protein + Hydration</option>
              <option>Minimal Intake / Fasted Session</option>
            </select>
          </label>

          <label className="text-sm">
            Intra-Training Phase
            <input
              type="text"
              value={intraTrainingPhase}
              onChange={(event) => setIntraTrainingPhase(event.target.value)}
              data-testid="athlete-intra-training-phase"
              className="mt-2 w-full border border-zinc-800 bg-[#09090b] p-2 text-slate-300"
            />
          </label>

          <label className="text-sm">
            Post-Training Phase
            <select
              value={postTrainingPhase}
              onChange={(event) => setPostTrainingPhase(event.target.value)}
              data-testid="athlete-post-training-phase"
              className="mt-2 w-full border border-zinc-800 bg-[#09090b] p-2 text-slate-300"
            >
              <option>Recovery Protein + Fruit</option>
              <option>High-Protein Meal Window</option>
              <option>Hydration + Rest-Only Window</option>
            </select>
          </label>
        </div>
      </section>

      <div className="mt-4 border border-zinc-800 rounded-none p-3">
        <p className="text-xs uppercase tracking-[0.12em] text-slate-500">L14 Readiness Score</p>
        <p className="mt-2 text-2xl text-slate-200">{readinessScore.toFixed(1)}</p>
      </div>

      {readinessScore < 5.0 ? (
        <p className="mt-3 animate-pulse bg-[#b91c1c] text-white rounded-none border border-[#7f1d1d] px-3 py-2 text-sm">
          ALERT: Readiness is below 5.0. Reduce output intensity and notify coach before contact work.
        </p>
      ) : null}

      <div className="mt-5">
        <DrillLibraryAccordion drill={ATHLETE_DRILL_TAXONOMY} />
      </div>

      <footer className="mt-5 border border-zinc-800 rounded-none p-3 text-xs uppercase tracking-[0.1em] text-slate-400">
        Pending Coach Verification Flag {"{"}&quot;verified_by_jason&quot;: false{"}"}
      </footer>
    </section>
  );
}
