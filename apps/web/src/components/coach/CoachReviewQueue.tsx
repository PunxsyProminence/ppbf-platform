'use client';

import { useMemo, useState } from 'react';
import {
  calculateReadinessL14,
  calculateDeltaRPE,
  isDeltaRPELocked,
} from '@/src/server/pilot/readinessMath';
import DrillLibraryAccordion, { type DrillTaxonomy } from '@/src/components/drills/DrillLibraryAccordion';

const MOCK_DRILL_009: DrillTaxonomy = {
  'Level 01: Core Direct Cue':
    'Lead Hand Slip-Counter Angular Deviation: slip outside the jab by three inches, return on a 35-degree line, and re-center guard before the second beat.',
  'Level 02: Field Instruction Architecture':
    'Phase A (shadow): 3 rounds x 90 seconds on rhythm call. Phase B (partner): jab feed with delayed return. Phase C (bag): slip-counter-exit chain at coach whistle intervals.',
  'Level 03: Psycho-Physiological Mapping':
    'Primary signal is autonomic over-bracing under visual pressure. Corrective cue is relaxed exhale on slip entry with jaw release to reduce panic freeze and preserve timing windows.',
  'Level 04: Biomechanical Evidence Anchor':
    'Anchor checkpoints: cervical neutrality, thoracic rotation without lumbar collapse, rear-heel torque transfer under 120 ms, and lead-knee tracking over second toe on counter step.',
  'Level 05: Lab Genesis & Sources':
    'Derived from floor review sessions (Queue Cohort C-11), mitt telemetry from 2024-2026 coach notebooks, and frame-step annotations in SHADOW film study packets.',
  'Level 06: Historical Chronology Genesis (Who, What, Where, When)':
    'Who: Daniel Mendoza. What: angular defensive slip to immediate straight-counter recovery. Where: London prize ring circuits. When: documented in 1789 technical journals and later gym transcription notes.',
};

function toNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function CoachReviewQueue() {
  const [sleepHours, setSleepHours] = useState('7');
  const [sorenessLevel, setSorenessLevel] = useState('4');
  const [disciplineScore, setDisciplineScore] = useState('6');
  const [forceGrindState, setForceGrindState] = useState(false);

  const [rpeObserved, setRpeObserved] = useState('6');
  const [rpeIntended, setRpeIntended] = useState('5');
  const [rationale, setRationale] = useState('');

  const readinessScore = useMemo(
    () => calculateReadinessL14(
      toNumber(sleepHours),
      toNumber(sorenessLevel),
      toNumber(disciplineScore),
    ),
    [sleepHours, sorenessLevel, disciplineScore],
  );

  const deltaRpe = useMemo(
    () => calculateDeltaRPE(toNumber(rpeObserved), toNumber(rpeIntended)),
    [rpeObserved, rpeIntended],
  );

  const deltaRpeLocked = useMemo(
    () => isDeltaRPELocked(deltaRpe, rationale),
    [deltaRpe, rationale],
  );

  const showRationaleField = deltaRpe >= 2 || rationale.trim().length > 0;
  const mustModifyTraining = readinessScore < 5.0 && !forceGrindState;

  return (
    <section
      className={[
        'bg-[#09090b] border border-zinc-800 rounded-none font-mono text-slate-300 p-3',
        deltaRpeLocked ? 'bg-[#b91c1c]/10' : '',
      ].join(' ')}
    >
      <header className="border border-zinc-800 rounded-none p-2">
        <h2 className="text-slate-300 text-xs">Initiative D - Coach Primary Loop Compression</h2>
      </header>

      <div className="mt-2 border border-zinc-800 rounded-none p-2">
        <h3 className="text-xs">Daily Metrics Review</h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mt-2">
          <label className="text-xs">
            Sleep (hours)
            <input
              type="number"
              step="0.1"
              value={sleepHours}
              onChange={(event) => setSleepHours(event.target.value)}
              className="w-full mt-1 bg-[#09090b] border border-zinc-800 rounded-none text-slate-300 px-2 py-1"
            />
          </label>

          <label className="text-xs">
            Soreness (0-10)
            <input
              type="number"
              step="0.1"
              value={sorenessLevel}
              onChange={(event) => setSorenessLevel(event.target.value)}
              className="w-full mt-1 bg-[#09090b] border border-zinc-800 rounded-none text-slate-300 px-2 py-1"
            />
          </label>

          <label className="text-xs">
            Discipline (0-10)
            <input
              type="number"
              step="0.1"
              value={disciplineScore}
              onChange={(event) => setDisciplineScore(event.target.value)}
              className="w-full mt-1 bg-[#09090b] border border-zinc-800 rounded-none text-slate-300 px-2 py-1"
            />
          </label>
        </div>

        <div className="mt-2 border border-zinc-800 rounded-none p-2 text-xs">
          L14 Readiness Score: {readinessScore.toFixed(1)}
        </div>

        {mustModifyTraining && (
          <div className="mt-2 animate-pulse bg-[#b91c1c] text-white border border-zinc-800 rounded-none p-2 text-xs">
            WARNING: L14 readiness below 5.0. Exercise modification is mandatory before session approval.
          </div>
        )}

        <button
          type="button"
          onClick={() => setForceGrindState((value) => !value)}
          className="mt-2 w-full bg-[#09090b] border border-zinc-800 rounded-none text-slate-300 px-2 py-1 text-xs"
        >
          [BREAK MY 40% RULE - FORCE GRIND STATE]
        </button>
      </div>

      <div className="mt-2 border border-zinc-800 rounded-none p-2">
        <h3 className="text-xs">Delta RPE Gate</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
          <label className="text-xs">
            RPE_Observed
            <input
              type="number"
              step="0.1"
              value={rpeObserved}
              onChange={(event) => setRpeObserved(event.target.value)}
              className="w-full mt-1 bg-[#09090b] border border-zinc-800 rounded-none text-slate-300 px-2 py-1"
            />
          </label>

          <label className="text-xs">
            RPE_Intended
            <input
              type="number"
              step="0.1"
              value={rpeIntended}
              onChange={(event) => setRpeIntended(event.target.value)}
              className="w-full mt-1 bg-[#09090b] border border-zinc-800 rounded-none text-slate-300 px-2 py-1"
            />
          </label>
        </div>

        <div className="mt-2 border border-zinc-800 rounded-none p-2 text-xs">
          Delta RPE: {deltaRpe.toFixed(1)}
        </div>

        {showRationaleField && (
          <label className="block mt-2 text-xs">
            Mandatory Downgrade / Modification Rationale
            <textarea
              value={rationale}
              required={deltaRpeLocked}
              onChange={(event) => setRationale(event.target.value)}
              className="w-full mt-1 min-h-24 bg-[#09090b] border border-zinc-800 rounded-none text-slate-300 px-2 py-1"
            />
          </label>
        )}

        {deltaRpeLocked && (
          <p className="mt-2 text-xs text-[#b91c1c]">
            LOCKED: Approval blocked until rationale is provided for Delta RPE greater than or equal to 2.
          </p>
        )}

        <button
          type="button"
          disabled={deltaRpeLocked}
          className="mt-2 w-full bg-[#09090b] border border-zinc-800 rounded-none text-slate-300 px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Approve Session
        </button>
      </div>

      <div className="mt-2">
        <DrillLibraryAccordion drill={MOCK_DRILL_009} />
      </div>

      <footer className="mt-2 border border-zinc-800 rounded-none p-2 text-xs">
        <span className="text-slate-300">Pending Coach Verification Flag</span>
        <div className="mt-1 text-slate-300">{'{"verified_by_jason": false}'}</div>
      </footer>
    </section>
  );
}
