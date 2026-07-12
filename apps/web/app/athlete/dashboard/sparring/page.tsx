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
    <main
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(180deg, #0a0a0a 0%, #0f0f0f 100%)',
        color: '#e8d7c6',
      }}
    >
      <header
        style={{
          background: 'rgba(9, 15, 33, 0.9)',
          color: '#f9fafb',
          padding: '18px 40px',
          borderBottom: '1px solid #263150',
          backdropFilter: 'blur(12px)',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: '0.72rem', letterSpacing: '0.24em', textTransform: 'uppercase', color: '#93c5fd' }}>
              Track D/E
            </div>
            <div style={{ fontSize: '1.1rem', fontWeight: 800 }}>Combat Telemetry Log</div>
          </div>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              border: '1px solid rgba(96,165,250,0.35)',
              background: 'rgba(30,64,175,0.2)',
              color: '#bfdbfe',
              borderRadius: '999px',
              padding: '8px 12px',
              fontSize: '0.82rem',
            }}
          >
            Layer 20 AI Engine surface
          </div>
        </div>
      </header>

      <form onSubmit={onSubmit} style={{ padding: '28px 40px 36px' }}>
        <div
          style={{
            display: 'grid',
            gap: '18px',
            gridTemplateColumns: 'minmax(0, 1.2fr) minmax(320px, 0.8fr)',
            alignItems: 'start',
          }}
        >
          <section
            style={{
              display: 'grid',
              gap: '16px',
              padding: '22px',
              border: '1px solid rgba(60,79,131,0.7)',
              borderRadius: '18px',
              background: 'rgba(17,25,54,0.88)',
              boxShadow: '0 22px 60px rgba(0,0,0,0.28)',
            }}
          >
            <div style={{ display: 'grid', gap: '6px' }}>
              <h2 style={{ margin: 0, fontSize: '1.25rem' }}>Session Capture</h2>
              <p style={{ margin: 0, color: '#9ca3af', lineHeight: 1.5 }}>
                Log the round count, stance, and damage absorption level for the coach review pipeline.
              </p>
            </div>

            <div style={{ display: 'grid', gap: '8px' }}>
              <label htmlFor="roundsCompleted" style={{ fontWeight: 700 }}>
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
                  padding: '12px 14px',
                  border: '1px solid #3c4f83',
                  borderRadius: '10px',
                  background: '#0a1024',
                  color: '#e5e7eb',
                  width: '160px',
                }}
              />
            </div>

            <div style={{ display: 'grid', gap: '8px' }}>
              <label htmlFor="opponentStance" style={{ fontWeight: 700 }}>
                Opponent Stance
              </label>
              <select
                id="opponentStance"
                value={opponentStance}
                onChange={(event) => setOpponentStance(event.target.value as OpponentStance)}
                style={{
                  padding: '12px 14px',
                  border: '1px solid #3c4f83',
                  borderRadius: '10px',
                  background: '#0a1024',
                  color: '#e5e7eb',
                  width: '100%',
                  maxWidth: '280px',
                }}
              >
                <option value="Orthodox">Orthodox</option>
                <option value="Southpaw">Southpaw</option>
                <option value="Switch">Switch</option>
              </select>
            </div>

            <div style={{ display: 'grid', gap: '10px' }}>
              <label htmlFor="defensiveHitAbsorption" style={{ fontWeight: 700 }}>
                Defensive Hit Absorption
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
                <input
                  id="defensiveHitAbsorption"
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={defensiveHitAbsorption}
                  onChange={(event) => setDefensiveHitAbsorption(Number(event.target.value))}
                  style={{ accentColor: '#60a5fa', flex: '1 1 260px' }}
                />
                <span
                  style={{
                    minWidth: '122px',
                    textAlign: 'center',
                    borderRadius: '999px',
                    border: '1px solid rgba(96,165,250,0.35)',
                    background: 'rgba(37,99,235,0.16)',
                    color: '#bfdbfe',
                    padding: '8px 12px',
                    fontSize: '0.84rem',
                  }}
                >
                  {defensiveHitAbsorption}/10 {readinessBand}
                </span>
              </div>
            </div>

            <button
              type="submit"
              style={{
                marginTop: '4px',
                padding: '12px 16px',
                borderRadius: '12px',
                border: 'none',
                background: 'linear-gradient(135deg, #2563eb, #60a5fa)',
                color: '#f8fafc',
                cursor: 'pointer',
                width: 'fit-content',
                fontWeight: 700,
                boxShadow: '0 12px 30px rgba(37,99,235,0.28)',
              }}
            >
              Log Combat Session
            </button>
          </section>

          <aside
            style={{
              display: 'grid',
              gap: '16px',
              padding: '22px',
              border: '1px solid rgba(60,79,131,0.7)',
              borderRadius: '18px',
              background: 'rgba(9,15,33,0.92)',
            }}
          >
            <div style={{ display: 'grid', gap: '8px' }}>
              <div style={{ fontSize: '0.72rem', letterSpacing: '0.22em', textTransform: 'uppercase', color: '#93c5fd' }}>
                AI/ML status
              </div>
              <p style={{ margin: 0, lineHeight: 1.6, color: '#dbeafe' }}>{statusMessage}</p>
            </div>

            <div
              style={{
                display: 'grid',
                gap: '12px',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              }}
            >
              <div style={{ borderRadius: '14px', background: 'rgba(17,25,54,0.92)', border: '1px solid rgba(60,79,131,0.7)', padding: '14px' }}>
                <div style={{ fontSize: '0.75rem', color: '#93c5fd', textTransform: 'uppercase', letterSpacing: '0.16em' }}>Rounds</div>
                <div style={{ marginTop: '8px', fontSize: '1.5rem', fontWeight: 800 }}>{totalRoundsCompleted}</div>
              </div>
              <div style={{ borderRadius: '14px', background: 'rgba(17,25,54,0.92)', border: '1px solid rgba(60,79,131,0.7)', padding: '14px' }}>
                <div style={{ fontSize: '0.75rem', color: '#93c5fd', textTransform: 'uppercase', letterSpacing: '0.16em' }}>Stance</div>
                <div style={{ marginTop: '8px', fontSize: '1.5rem', fontWeight: 800 }}>{opponentStance}</div>
              </div>
              <div style={{ borderRadius: '14px', background: 'rgba(17,25,54,0.92)', border: '1px solid rgba(60,79,131,0.7)', padding: '14px' }}>
                <div style={{ fontSize: '0.75rem', color: '#93c5fd', textTransform: 'uppercase', letterSpacing: '0.16em' }}>Load</div>
                <div style={{ marginTop: '8px', fontSize: '1.5rem', fontWeight: 800 }}>{readinessBand}</div>
              </div>
              <div style={{ borderRadius: '14px', background: 'rgba(17,25,54,0.92)', border: '1px solid rgba(60,79,131,0.7)', padding: '14px' }}>
                <div style={{ fontSize: '0.75rem', color: '#93c5fd', textTransform: 'uppercase', letterSpacing: '0.16em' }}>Last save</div>
                <div style={{ marginTop: '8px', fontSize: '1.05rem', fontWeight: 800 }}>{lastSubmitted}</div>
              </div>
            </div>

            <div
              style={{
                borderRadius: '14px',
                border: '1px solid rgba(96,165,250,0.25)',
                background: 'rgba(30,64,175,0.12)',
                padding: '14px',
                color: '#dbeafe',
                lineHeight: 1.6,
              }}
            >
              This is a v1 polished telemetry card: clear inputs, visible feedback, and a small analytics summary for the athlete floor.
            </div>
          </aside>
        </div>
      </form>

      <footer style={{ padding: '0 40px 32px', fontSize: '0.85rem', color: '#9ca3af' }}>
        Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715
      </footer>
    </main>
  );
}