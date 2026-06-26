'use client';

import { FormEvent, useState } from 'react';

type OpponentStance = 'Orthodox' | 'Southpaw' | 'Switch';

export default function SparringTelemetryPage() {
  const [totalRoundsCompleted, setTotalRoundsCompleted] = useState(6);
  const [opponentStance, setOpponentStance] = useState<OpponentStance>('Orthodox');
  const [defensiveHitAbsorption, setDefensiveHitAbsorption] = useState(4);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    alert('Telemetry sent to Layer 20 AI Engine');
  }

  return (
    <main style={{ minHeight: '100vh', background: '#070b17', color: '#e5e7eb' }}>
      <header
        style={{
          background: '#090f21',
          color: '#f9fafb',
          padding: '16px 40px',
          borderBottom: '1px solid #263150',
          fontWeight: 700,
          letterSpacing: '0.02em',
        }}
      >
        TRACK D/E: COMBAT TELEMETRY LOG
      </header>

      <form onSubmit={onSubmit} style={{ padding: '28px 40px', display: 'grid', gap: '18px' }}>
        <section
          style={{
            display: 'grid',
            gap: '12px',
            padding: '18px',
            border: '1px solid #2a3557',
            borderRadius: '10px',
            background: '#111936',
            maxWidth: '640px',
          }}
        >
          <label htmlFor="roundsCompleted" style={{ fontWeight: 600 }}>
            Total Rounds Completed
          </label>
          <input
            id="roundsCompleted"
            type="number"
            min={1}
            max={12}
            value={totalRoundsCompleted}
            onChange={(event) => setTotalRoundsCompleted(Number(event.target.value))}
            style={{
              padding: '10px 12px',
              border: '1px solid #3c4f83',
              borderRadius: '8px',
              background: '#0a1024',
              color: '#e5e7eb',
              width: '140px',
            }}
          />

          <label htmlFor="opponentStance" style={{ fontWeight: 600 }}>
            Opponent Stance
          </label>
          <select
            id="opponentStance"
            value={opponentStance}
            onChange={(event) => setOpponentStance(event.target.value as OpponentStance)}
            style={{
              padding: '10px 12px',
              border: '1px solid #3c4f83',
              borderRadius: '8px',
              background: '#0a1024',
              color: '#e5e7eb',
            }}
          >
            <option value="Orthodox">Orthodox</option>
            <option value="Southpaw">Southpaw</option>
            <option value="Switch">Switch</option>
          </select>

          <label htmlFor="defensiveHitAbsorption" style={{ fontWeight: 600 }}>
            Defensive Hit Absorption (1 = clean defense, 10 = took heavy damage): {defensiveHitAbsorption}
          </label>
          <input
            id="defensiveHitAbsorption"
            type="range"
            min={1}
            max={10}
            step={1}
            value={defensiveHitAbsorption}
            onChange={(event) => setDefensiveHitAbsorption(Number(event.target.value))}
            style={{ accentColor: '#2563eb' }}
          />

          <button
            type="submit"
            style={{
              marginTop: '8px',
              padding: '10px 14px',
              borderRadius: '8px',
              border: 'none',
              background: '#2563eb',
              color: '#f9fafb',
              cursor: 'pointer',
              width: 'fit-content',
            }}
          >
            Log Combat Session
          </button>
        </section>
      </form>

      <footer style={{ padding: '0 40px 32px', fontSize: '0.85rem', color: '#9ca3af' }}>
        Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715
      </footer>
    </main>
  );
}