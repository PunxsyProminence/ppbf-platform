import { ReactNode } from 'react';

interface AthleteLayoutProps {
  children: ReactNode;
}

export default function AthleteLayout({ children }: AthleteLayoutProps) {
  const isConcussionProtocolActive = false;

  if (isConcussionProtocolActive) {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-8 py-8 text-[var(--black)]">
        <section className="w-full max-w-[720px] border-4 border-[var(--red-primary)] bg-[var(--canvas-tan-light)] p-10 text-center shadow-[var(--shadow-lg)]">
          <div className="tactical-chip tactical-chip-critical mb-5 inline-block px-4 py-2 text-sm tracking-[0.08em]">
            MEDICAL FAILSAFE
          </div>
          <h1 className="mb-4 font-display text-4xl leading-[1.15] md:text-5xl">
            MEDICAL SUSPENSION ACTIVE: Cleared by Head Coach Jason Required. Floor access denied.
          </h1>
          <p className="m-0 text-base text-[var(--red-primary)]">
            Athlete-facing floor operations remain locked until protocol review is cleared.
          </p>
        </section>
      </main>
    );
  }

  return <>{children}</>;
}

// Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715