import { ReactNode } from 'react';

interface AthleteLayoutProps {
  children: ReactNode;
}

export default function AthleteLayout({ children }: AthleteLayoutProps) {
  const isConcussionProtocolActive = false;

  if (isConcussionProtocolActive) {
    return (
      <main
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: 'linear-gradient(180deg, #2b0606 0%, #140404 100%)',
          color: '#fee2e2',
          padding: '32px',
        }}
      >
        <section
          style={{
            width: '100%',
            maxWidth: '720px',
            border: '1px solid #7f1d1d',
            borderRadius: '16px',
            background: '#450a0a',
            boxShadow: '0 24px 60px rgba(0, 0, 0, 0.45)',
            padding: '40px',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              display: 'inline-block',
              padding: '8px 14px',
              borderRadius: '999px',
              background: '#7f1d1d',
              color: '#fecaca',
              fontWeight: 700,
              letterSpacing: '0.05em',
              marginBottom: '20px',
            }}
          >
            MEDICAL FAILSAFE
          </div>
          <h1 style={{ fontSize: '2.4rem', lineHeight: 1.15, margin: '0 0 16px' }}>
            MEDICAL SUSPENSION ACTIVE: Cleared by Head Coach Jason Required. Floor access denied.
          </h1>
          <p style={{ margin: 0, color: '#fecaca', fontSize: '1rem' }}>
            Athlete-facing floor operations remain locked until protocol review is cleared.
          </p>
        </section>
      </main>
    );
  }

  return <>{children}</>;
}

// Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715