'use client';

import { FormEvent, useState } from 'react';

type OpponentStance = 'Orthodox' | 'Southpaw' | 'Switch';

export default function SparringTelemetryPage() {
  const [totalRoundsCompleted, setTotalRoundsCompleted] = useState(6);
  const [opponentStance, setOpponentStance] = useState<OpponentStance>('Orthodox');
  const [defensiveHitAbsorption, setDefensiveHitAbsorption] = useState(4);
  const [lastSubmitted, setLastSubmitted] = useState('Not submitted yet');
  const [statusMessage, setStatusMessage] = useState('Ready for combat telemetry capture.');

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const timestamp = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    setLastSubmitted(timestamp);
    setStatusMessage('Telemetry staged for coach review and continuity logging.');
  }

  const readinessBand =
    defensiveHitAbsorption <= 3
      ? 'Controlled'
      : defensiveHitAbsorption <= 6
        ? 'Moderate'
        : 'High strain';

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6]">
      <header className="border-b-4 border-[#8b4444] bg-[#1a1a1a] px-10 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[0.72rem] uppercase tracking-[0.24em] text-[#d4a574] font-mono">
              Track D/E
            </div>
            <div className="font-display text-2xl tracking-tight">Combat Telemetry Log</div>
          </div>
          <div className="inline-flex items-center gap-2 border-2 border-[#8b4444] bg-[#3d2817] px-3 py-2 text-xs font-mono text-[#e8d7c6]">
            Layer 20 AI Engine surface
          </div>
        </div>
      </header>

      <form onSubmit={onSubmit} className="px-10 py-7">
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
          <section className="grid gap-4 border-4 border-[#8b4444] bg-[#1a1a1a] p-6 shadow-2xl shadow-black/70">
            <div className="grid gap-1.5">
              <h2 className="m-0 font-display text-2xl tracking-tight">Session Capture</h2>
              <p className="m-0 leading-6 text-[#b0a095]">
                Log the round count, stance, and damage absorption level for the coach review pipeline.
              </p>
            </div>

            <div className="grid gap-2">
              <label htmlFor="roundsCompleted" className="font-semibold">
                Total Rounds Completed
              </label>
              <input
                id="roundsCompleted"
                type="number"
                min={1}
                max={12}
                value={totalRoundsCompleted}
                onChange={(event) => setTotalRoundsCompleted(Number(event.target.value))}
                className="w-40 border-2 border-[#8b4444] bg-[#0f0f0f] px-3.5 py-3 text-[#e8d7c6] outline-none transition focus:border-[#d4a574]"
              />
            </div>

            <div className="grid gap-2">
              <label htmlFor="opponentStance" className="font-semibold">
                Opponent Stance
              </label>
              <select
                id="opponentStance"
                value={opponentStance}
                onChange={(event) => setOpponentStance(event.target.value as OpponentStance)}
                className="w-full max-w-[280px] border-2 border-[#8b4444] bg-[#0f0f0f] px-3.5 py-3 text-[#e8d7c6] outline-none transition focus:border-[#d4a574]"
              >
                <option value="Orthodox">Orthodox</option>
                <option value="Southpaw">Southpaw</option>
                <option value="Switch">Switch</option>
              </select>
            </div>

            <div className="grid gap-2.5">
              <label htmlFor="defensiveHitAbsorption" className="font-semibold">
                Defensive Hit Absorption
              </label>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <input
                  id="defensiveHitAbsorption"
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={defensiveHitAbsorption}
                  onChange={(event) => setDefensiveHitAbsorption(Number(event.target.value))}
                  style={{ accentColor: '#d4a574', flex: '1 1 260px' }}
                />
                <span className="min-w-[122px] border-2 border-[#8b4444] bg-[#3d2817] px-3 py-2 text-center text-sm text-[#e8d7c6]">
                  {defensiveHitAbsorption}/10 {readinessBand}
                </span>
              </div>
            </div>

            <button
              type="submit"
              className="mt-1 w-fit border-2 border-[#8b4444] bg-[#5a2a2a] px-4 py-3 font-semibold text-[#e8d7c6] transition hover:border-[#d4a574] hover:bg-[#8b4444]"
            >
              Log Combat Session
            </button>
          </section>

          <aside className="grid gap-4 border-4 border-[#3d2817] bg-[#1a1a1a] p-6">
            <div className="grid gap-2">
              <div className="font-mono text-[0.72rem] uppercase tracking-[0.22em] text-[#d4a574]">
                AI/ML status
              </div>
              <p className="m-0 leading-6 text-[#e8d7c6]">{statusMessage}</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="border-2 border-[#5a4a3a] bg-[#0f0f0f] p-3.5">
                <div className="font-mono text-xs uppercase tracking-[0.16em] text-[#d4a574]">Rounds</div>
                <div className="mt-2 text-2xl font-black text-[#e8d7c6]">{totalRoundsCompleted}</div>
              </div>
              <div className="border-2 border-[#5a4a3a] bg-[#0f0f0f] p-3.5">
                <div className="font-mono text-xs uppercase tracking-[0.16em] text-[#d4a574]">Stance</div>
                <div className="mt-2 text-2xl font-black text-[#e8d7c6]">{opponentStance}</div>
              </div>
              <div className="border-2 border-[#5a4a3a] bg-[#0f0f0f] p-3.5">
                <div className="font-mono text-xs uppercase tracking-[0.16em] text-[#d4a574]">Load</div>
                <div className="mt-2 text-2xl font-black text-[#e8d7c6]">{readinessBand}</div>
              </div>
              <div className="border-2 border-[#5a4a3a] bg-[#0f0f0f] p-3.5">
                <div className="font-mono text-xs uppercase tracking-[0.16em] text-[#d4a574]">Last save</div>
                <div className="mt-2 text-lg font-black text-[#e8d7c6]">{lastSubmitted}</div>
              </div>
            </div>

            <div className="border-2 border-[#8b4444] bg-[#3d2817] p-3.5 leading-6 text-[#e8d7c6]">
              This is a v1 polished telemetry card: clear inputs, visible feedback, and a small analytics summary for the athlete floor.
            </div>
          </aside>
        </div>
      </form>

      <footer className="px-10 pb-8 text-sm text-[#8a8a8a]">
        Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715
      </footer>
    </main>
  );
}