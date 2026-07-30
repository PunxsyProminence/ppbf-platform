import { ReactNode } from 'react';

interface AthleteLayoutProps {
  children: ReactNode;
}

export default function AthleteLayout({ children }: AthleteLayoutProps) {
  const isConcussionProtocolActive = false;

  if (isConcussionProtocolActive) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#0a0a0a] px-8 py-8 text-[#e8d7c6]">
        <section className="w-full max-w-[720px] border-4 border-[#8b4444] bg-[#450a0a] p-10 text-center shadow-2xl shadow-black/70">
          <div className="mb-5 inline-block border-2 border-[#dc2626] bg-[#7f1d1d] px-4 py-2 font-mono text-sm font-bold uppercase tracking-[0.08em] text-[#fecaca]">
            MEDICAL FAILSAFE
          </div>
          <h1 className="mb-4 font-display text-4xl leading-[1.15] md:text-5xl">
            MEDICAL SUSPENSION ACTIVE: Cleared by Head Coach Jason Required. Floor access denied.
          </h1>
          <p className="m-0 text-base text-[#fecaca]">
            Athlete-facing floor operations remain locked until protocol review is cleared.
          </p>
        </section>
      </main>
    );
  }

  return <>{children}</>;
}

// Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715