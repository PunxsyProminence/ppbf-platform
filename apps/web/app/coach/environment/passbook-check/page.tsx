'use client';

import { useState } from 'react';

export default function PassbookCheckPage() {
  const [usaBoxingId, setUsaBoxingId] = useState('');

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6]">
      <header className="border-b-4 border-[#8b4444] bg-[#1a1a1a] px-10 py-4 font-mono text-sm font-bold uppercase tracking-[0.08em] text-[#d4a574]">
        TRACK C: USA BOXING PASSBOOK VERIFICATION
      </header>

      <div className="grid gap-5 px-10 py-7">
        <section className="grid max-w-[640px] gap-3 border-4 border-[#3d2817] bg-[#1a1a1a] p-5">
          <label htmlFor="usa-boxing-id" className="font-semibold text-[#e8d7c6]">
            Athlete USA Boxing ID
          </label>
          <input
            id="usa-boxing-id"
            type="search"
            value={usaBoxingId}
            onChange={(event) => setUsaBoxingId(event.target.value)}
            placeholder="Enter USA Boxing ID"
            className="border-2 border-[#8b4444] bg-[#0f0f0f] px-3 py-2 text-[#e8d7c6] outline-none transition focus:border-[#d4a574]"
          />
        </section>

        <section className="grid max-w-[640px] gap-4 border-4 border-[#8b4444] bg-[#1a1a1a] p-6">
          <div className="flex flex-wrap justify-between gap-3 text-sm font-mono">
            <span className="text-[#b0a095]">Physical Status: EXPIRED</span>
            <span className="text-[#d4a574]">Book Registration: ACTIVE</span>
          </div>

          <div className="border-4 border-[#dc2626] bg-[#450a0a] p-6 font-display text-3xl leading-[1.15] text-[#fca5a5] md:text-[2rem]">
            DO NOT ALLOW ON MAT - INSURANCE LAPSE
          </div>
        </section>
      </div>

      <footer className="px-10 pb-8 text-sm text-[#8a8a8a]">
        Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715
      </footer>
    </main>
  );
}