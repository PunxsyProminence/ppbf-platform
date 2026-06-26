'use client';

import { useState } from 'react';

export default function PassbookCheckPage() {
  const [usaBoxingId, setUsaBoxingId] = useState('');

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
        TRACK C: USA BOXING PASSBOOK VERIFICATION
      </header>

      <div style={{ padding: '28px 40px', display: 'grid', gap: '18px' }}>
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
          <label htmlFor="usa-boxing-id" style={{ fontWeight: 600 }}>
            Athlete USA Boxing ID
          </label>
          <input
            id="usa-boxing-id"
            type="search"
            value={usaBoxingId}
            onChange={(event) => setUsaBoxingId(event.target.value)}
            placeholder="Enter USA Boxing ID"
            style={{
              padding: '10px 12px',
              border: '1px solid #3c4f83',
              borderRadius: '8px',
              background: '#0a1024',
              color: '#e5e7eb',
            }}
          />
        </section>

        <section
          style={{
            display: 'grid',
            gap: '14px',
            padding: '22px',
            border: '1px solid #41213a',
            borderRadius: '14px',
            background: '#1a1026',
            maxWidth: '640px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <span style={{ color: '#cbd5e1' }}>Physical Status: EXPIRED</span>
            <span style={{ color: '#86efac' }}>Book Registration: ACTIVE</span>
          </div>

          <div
            style={{
              borderRadius: '12px',
              border: '1px solid #b91c1c',
              background: '#450a0a',
              color: '#fca5a5',
              padding: '22px',
              fontSize: '1.65rem',
              fontWeight: 800,
              lineHeight: 1.15,
            }}
          >
            DO NOT ALLOW ON MAT - INSURANCE LAPSE
          </div>
        </section>
      </div>

      <footer style={{ padding: '0 40px 32px', fontSize: '0.85rem', color: '#9ca3af' }}>
        Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715
      </footer>
    </main>
  );
}