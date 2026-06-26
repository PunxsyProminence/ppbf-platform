'use client';

import { FormEvent, useState } from 'react';
import { stageDataTransaction } from '@/utils/gateway';

type InformationCategory = 'DRILL_WORKOUT' | 'RESEARCH_EVIDENCE' | 'OPERATIONAL_NOTE';
type TargetTrack =
  | 'GLOBAL_SYSTEM'
  | 'TRACK_A_YOUTH'
  | 'TRACK_B_MULTI'
  | 'TRACK_C_USA_BOXING'
  | 'TRACK_D_A2P'
  | 'TRACK_E_PRO';

export default function IntakeRouterPage() {
  const [informationCategory, setInformationCategory] = useState<InformationCategory>('DRILL_WORKOUT');
  const [targetTrack, setTargetTrack] = useState<TargetTrack>('GLOBAL_SYSTEM');
  const [rawContentString, setRawContentString] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [stagingUuid, setStagingUuid] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setIsSubmitting(true);
    setErrorMessage('');
    setStagingUuid('');

    const payload = {
      intakeRouter: {
        informationCategory,
        targetTrack,
        rawContentString,
      },
      submittedBy: 'Head Coach Jason',
      submittedAt: new Date().toISOString(),
    };

    try {
      const response = await stageDataTransaction(payload);
      setStagingUuid(response.stagingId ?? '');
    } catch {
      setErrorMessage('Unable to stage this payload right now. Please retry.');
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
          borderBottom: '1px solid #263150',
          fontWeight: 700,
          letterSpacing: '0.02em',
        }}
      >
        PPBF UNIFIED INFORMATION TRIAGE ROUTER
      </header>

      <form onSubmit={onSubmit} style={{ padding: '28px 40px', display: 'grid', gap: '16px' }}>
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
          <label htmlFor="informationCategory" style={{ fontWeight: 600 }}>
            Information Category
          </label>
          <select
            id="informationCategory"
            value={informationCategory}
            onChange={(event) => setInformationCategory(event.target.value as InformationCategory)}
            style={{
              padding: '10px',
              border: '1px solid #3c4f83',
              borderRadius: '8px',
              background: '#0a1024',
              color: '#e5e7eb',
            }}
          >
            <option value="DRILL_WORKOUT">Drill/Workout</option>
            <option value="RESEARCH_EVIDENCE">Research/Evidence</option>
            <option value="OPERATIONAL_NOTE">Operational Note</option>
          </select>

          <label htmlFor="targetTrack" style={{ fontWeight: 600 }}>
            Target Track
          </label>
          <select
            id="targetTrack"
            value={targetTrack}
            onChange={(event) => setTargetTrack(event.target.value as TargetTrack)}
            style={{
              padding: '10px',
              border: '1px solid #3c4f83',
              borderRadius: '8px',
              background: '#0a1024',
              color: '#e5e7eb',
            }}
          >
            <option value="GLOBAL_SYSTEM">Global System</option>
            <option value="TRACK_A_YOUTH">Track A Youth</option>
            <option value="TRACK_B_MULTI">Track B Multi</option>
            <option value="TRACK_C_USA_BOXING">Track C USA Boxing</option>
            <option value="TRACK_D_A2P">Track D A2P</option>
            <option value="TRACK_E_PRO">Track E Pro</option>
          </select>

          <label htmlFor="rawContentString" style={{ fontWeight: 600 }}>
            Raw Content String
          </label>
          <textarea
            id="rawContentString"
            rows={10}
            required
            value={rawContentString}
            onChange={(event) => setRawContentString(event.target.value)}
            placeholder="Paste raw workout descriptions or research here..."
            style={{
              padding: '12px',
              border: '1px solid #3c4f83',
              borderRadius: '8px',
              resize: 'vertical',
              background: '#0a1024',
              color: '#e5e7eb',
            }}
          />

          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
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
              {isSubmitting ? 'Staging...' : 'Submit to Staging'}
            </button>

            {stagingUuid && <span>Staged successfully. Staging UUID: {stagingUuid}</span>}
            {errorMessage && <span style={{ color: '#fca5a5' }}>{errorMessage}</span>}
          </div>
        </section>
      </form>

      <footer style={{ padding: '0 40px 32px', fontSize: '0.85rem', color: '#9ca3af' }}>
        Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715
      </footer>
    </main>
  );
}