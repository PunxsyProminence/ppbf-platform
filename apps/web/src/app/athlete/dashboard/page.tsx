'use client';

import { FormEvent, useState } from 'react';
import { stageDataTransaction } from '@/utils/gateway';

const muscleAreas = [
  'Neck',
  'Shoulders',
  'Chest',
  'Upper Back',
  'Lower Back',
  'Arms',
  'Core',
  'Glutes',
  'Quads',
  'Hamstrings',
  'Calves',
] as const;

export default function AthleteDashboardPage() {
  const [sleepScore, setSleepScore] = useState(7);
  const [hydrationChecked, setHydrationChecked] = useState(false);
  const [rpeScore, setRpeScore] = useState(5);
  const [sorenessAreas, setSorenessAreas] = useState<string[]>([]);
  const [reflection, setReflection] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastTransactionId, setLastTransactionId] = useState('');
  const [submitError, setSubmitError] = useState('');

  function toggleSorenessArea(area: string) {
    setSorenessAreas((current) =>
      current.includes(area) ? current.filter((item) => item !== area) : [...current, area],
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError('');
    setIsSubmitting(true);

    const payload = {
      athleteFloorDashboard: {
        preWorkoutReadiness: {
          sleep: sleepScore,
          hydrationChecked,
        },
        sessionBiometrics: {
          rpe: rpeScore,
          muscleSorenessAreas: sorenessAreas,
        },
        reflection,
      },
      submittedAt: new Date().toISOString(),
    };

    try {
      const response = await stageDataTransaction(payload);
      setLastTransactionId(response.stagingId);
    } catch {
      setSubmitError('Unable to stage this transaction right now. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main style={{ minHeight: '100vh', background: '#070b17', color: '#e5e7eb' }}>
      <header
        style={{
          background: '#090f21',
          color: '#f9fafb',
          padding: '16px 40px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: '1px solid #263150',
        }}
      >
        <div>
          <strong>PPBF</strong> Platform
        </div>
        <div style={{ fontSize: '0.9rem' }}>Athlete Floor Dashboard</div>
      </header>

      <section
        style={{
          background: '#131d38',
          padding: '8px 40px',
          fontSize: '0.875rem',
          borderBottom: '1px solid #2f426f',
          color: '#dbeafe',
        }}
      >
        All actions are logged. Jason approval required for production changes.
      </section>

      <form onSubmit={onSubmit} style={{ padding: '32px 40px', display: 'grid', gap: '18px' }}>
        <section
          style={{
            display: 'grid',
            gap: '12px',
            padding: '18px',
            border: '1px solid #2a3557',
            borderRadius: '10px',
            background: '#111936',
          }}
        >
          <h2 style={{ fontSize: '1.2rem' }}>Pre-Workout Readiness</h2>

          <label htmlFor="sleepScore">Sleep (1-10)</label>
          <input
            id="sleepScore"
            type="number"
            min={1}
            max={10}
            value={sleepScore}
            onChange={(event) => setSleepScore(Number(event.target.value))}
            style={{
              padding: '10px',
              border: '1px solid #3c4f83',
              borderRadius: '8px',
              width: '120px',
              background: '#0a1024',
              color: '#e5e7eb',
            }}
          />

          <label style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={hydrationChecked}
              onChange={(event) => setHydrationChecked(event.target.checked)}
            />
            Hydration check completed
          </label>
        </section>

        <section
          style={{
            display: 'grid',
            gap: '12px',
            padding: '18px',
            border: '1px solid #2a3557',
            borderRadius: '10px',
            background: '#111936',
          }}
        >
          <h2 style={{ fontSize: '1.2rem' }}>Session Biometrics</h2>

          <label htmlFor="rpeScore">RPE Slider (1-10): {rpeScore}</label>
          <input
            id="rpeScore"
            type="range"
            min={1}
            max={10}
            step={1}
            value={rpeScore}
            onChange={(event) => setRpeScore(Number(event.target.value))}
            style={{ accentColor: '#60a5fa' }}
          />

          <p style={{ marginTop: '8px' }}>Muscle Soreness Areas</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '8px' }}>
            {muscleAreas.map((area) => (
              <label key={area} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={sorenessAreas.includes(area)}
                  onChange={() => toggleSorenessArea(area)}
                />
                {area}
              </label>
            ))}
          </div>
        </section>

        <section
          style={{
            display: 'grid',
            gap: '12px',
            padding: '18px',
            border: '1px solid #2a3557',
            borderRadius: '10px',
            background: '#111936',
          }}
        >
          <h2 style={{ fontSize: '1.2rem' }}>Reflection</h2>
          <textarea
            rows={6}
            value={reflection}
            onChange={(event) => setReflection(event.target.value)}
            placeholder="How did you feel, what worked, and what needs adjustment?"
            style={{
              padding: '10px',
              border: '1px solid #3c4f83',
              borderRadius: '8px',
              resize: 'vertical',
              background: '#0a1024',
              color: '#e5e7eb',
            }}
          />
        </section>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <button
            type="submit"
            disabled={isSubmitting}
            style={{
              padding: '10px 14px',
              borderRadius: '8px',
              border: 'none',
              background: '#2563eb',
              color: '#f9fafb',
              cursor: 'pointer',
            }}
          >
            {isSubmitting ? 'Submitting...' : 'Submit to Pending'}
          </button>

          {lastTransactionId && <span>Staged successfully. Staging UUID: {lastTransactionId}</span>}
          {submitError && <span style={{ color: '#fca5a5' }}>{submitError}</span>}
        </div>
      </form>

      <footer style={{ padding: '0 40px 32px', fontSize: '0.85rem', color: '#9ca3af' }}>
        Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715
      </footer>
    </main>
  );
}

"Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715"