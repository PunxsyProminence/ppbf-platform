'use client';

import { useMemo, useState } from 'react';
import type { TrackType } from '@/utils/gateway';

type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

interface PendingRecord {
  id: string;
  athleteName: string;
  track: TrackType;
  rpe: number;
  reflection: string;
  status: ReviewStatus;
  coachRationale: string;
}

const initialRecords: PendingRecord[] = [
  {
    id: 'pending-001',
    athleteName: 'Athlete A',
    track: 'TRACK_A_YOUTH',
    rpe: 7,
    reflection: 'Felt sharp in combinations, but breathing control dropped in the final rounds.',
    status: 'PENDING',
    coachRationale: '',
  },
  {
    id: 'pending-002',
    athleteName: 'Athlete B',
    track: 'TRACK_C_USA_BOXING',
    rpe: 8,
    reflection: 'Good ring movement and pace control. Need cleaner exits after exchanges.',
    status: 'PENDING',
    coachRationale: '',
  },
  {
    id: 'pending-003',
    athleteName: 'Athlete C',
    track: 'TRACK_D_A2P',
    rpe: 6,
    reflection: 'Solid technical session. Recovery lagged after high-output intervals.',
    status: 'PENDING',
    coachRationale: '',
  },
];

export default function CoachReviewQueuePage() {
  const [records, setRecords] = useState<PendingRecord[]>(initialRecords);
  const [rationaleInputs, setRationaleInputs] = useState<Record<string, string>>({});
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [isDowngradeOpen, setIsDowngradeOpen] = useState<Record<string, boolean>>({});

  const pendingCount = useMemo(() => records.filter((record) => record.status === 'PENDING').length, [records]);

  function approveRecord(recordId: string) {
    setRecords((current) =>
      current.map((record) =>
        record.id === recordId ? { ...record, status: 'APPROVED', coachRationale: '' } : record,
      ),
    );

    setValidationErrors((current) => {
      const next = { ...current };
      delete next[recordId];
      return next;
    });
  }

  function openDowngrade(recordId: string) {
    setIsDowngradeOpen((current) => ({
      ...current,
      [recordId]: true,
    }));
  }

  function submitDowngrade(recordId: string) {
    const rationale = (rationaleInputs[recordId] ?? '').trim();
    if (!rationale) {
      setValidationErrors((current) => ({
        ...current,
        [recordId]: 'Coach Rationale is required before DOWNGRADE can be submitted.',
      }));
      return;
    }

    setRecords((current) =>
      current.map((record) =>
        record.id === recordId ? { ...record, status: 'REJECTED', coachRationale: rationale } : record,
      ),
    );

    setValidationErrors((current) => {
      const next = { ...current };
      delete next[recordId];
      return next;
    });

    setIsDowngradeOpen((current) => ({
      ...current,
      [recordId]: false,
    }));
  }

  function updateRationale(recordId: string, value: string) {
    setRationaleInputs((current) => ({ ...current, [recordId]: value }));

    if (value.trim()) {
      setValidationErrors((current) => {
        const next = { ...current };
        delete next[recordId];
        return next;
      });
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
        <div style={{ fontSize: '0.9rem' }}>Coach Review Queue</div>
      </header>

      <section
        style={{
          background: '#131d38',
          padding: '10px 40px',
          fontSize: '0.9rem',
          borderBottom: '1px solid #2f426f',
          fontWeight: 600,
          color: '#dbeafe',
        }}
      >
        LAYER 10 INGESTION VISUALIZER: Jason Approval Required
      </section>

      <div style={{ padding: '32px 40px' }}>
        <h1 style={{ marginBottom: '8px', fontSize: '2rem' }}>Pending Staging Records</h1>
        <p style={{ marginBottom: '18px', color: '#9ca3af' }}>Open pending records: {pendingCount}</p>

        <section
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '16px',
          }}
        >
          {records.map((record) => (
            <article
              key={record.id}
              style={{
                border: '1px solid #2a3557',
                borderRadius: '10px',
                background: '#111936',
                padding: '16px',
                display: 'grid',
                gap: '10px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                <strong>{record.athleteName}</strong>
                <span style={{ color: '#93c5fd' }}>{record.status}</span>
              </div>

              <span>Track: {record.track}</span>
              <span>RPE: {record.rpe}</span>
              <p style={{ margin: 0, color: '#cbd5e1' }}>Reflection: {record.reflection}</p>

              {isDowngradeOpen[record.id] && (
                <>
                  <label htmlFor={`rationale-${record.id}`} style={{ fontWeight: 600 }}>
                    Coach Rationale (required)
                  </label>
                  <textarea
                    id={`rationale-${record.id}`}
                    rows={3}
                    required
                    value={rationaleInputs[record.id] ?? ''}
                    onChange={(event) => updateRationale(record.id, event.target.value)}
                    placeholder="Document why this record is being downgraded"
                    style={{
                      padding: '10px',
                      border: '1px solid #3c4f83',
                      borderRadius: '8px',
                      resize: 'vertical',
                      background: '#0a1024',
                      color: '#e5e7eb',
                    }}
                  />
                </>
              )}

              {validationErrors[record.id] && (
                <span style={{ color: '#fca5a5', fontSize: '0.9rem' }}>{validationErrors[record.id]}</span>
              )}

              {record.status === 'REJECTED' && record.coachRationale && (
                <span style={{ color: '#fca5a5', fontSize: '0.9rem' }}>
                  Saved Rationale: {record.coachRationale}
                </span>
              )}

              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => approveRecord(record.id)}
                  style={{
                    padding: '10px 12px',
                    borderRadius: '8px',
                    border: 'none',
                    background: '#2563eb',
                    color: '#f9fafb',
                    cursor: 'pointer',
                  }}
                >
                  APPROVE
                </button>

                <button
                  type="button"
                  onClick={() => openDowngrade(record.id)}
                  style={{
                    padding: '10px 12px',
                    borderRadius: '8px',
                    border: '1px solid #3b82f6',
                    background: '#0a1024',
                    color: '#dbeafe',
                    cursor: 'pointer',
                  }}
                >
                  DOWNGRADE
                </button>

                {isDowngradeOpen[record.id] && (
                  <button
                    type="button"
                    onClick={() => submitDowngrade(record.id)}
                    disabled={!(rationaleInputs[record.id] ?? '').trim()}
                    style={{
                      padding: '10px 12px',
                      borderRadius: '8px',
                      border: '1px solid #fb7185',
                      background: '#3f1121',
                      color: '#ffe4e6',
                      cursor: 'pointer',
                      opacity: (rationaleInputs[record.id] ?? '').trim() ? 1 : 0.6,
                    }}
                  >
                    Submit DOWNGRADE
                  </button>
                )}
              </div>
            </article>
          ))}
        </section>
      </div>

      <footer style={{ padding: '0 40px 32px', fontSize: '0.85rem', color: '#9ca3af' }}>
        Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715
      </footer>
    </main>
  );
}

"Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715"