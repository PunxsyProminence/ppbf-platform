'use client';

import { useState } from 'react';
import RoleStandaloneView from '@/components/RoleStandaloneView';

export default function PassbookCheckPage() {
  const [usaBoxingId, setUsaBoxingId] = useState('');

  return (
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/environment/passbook-check" allowedRoles={['coach']} showShellHeader={false}>
      <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
        <header className="border-b-4 border-[var(--black)] bg-[var(--canvas-tan-light)] px-10 py-4 font-mono text-sm font-bold uppercase tracking-[0.08em] text-[var(--red-primary)]">
          TRACK C: USA BOXING PASSBOOK VERIFICATION
        </header>

        <div className="grid gap-5 px-10 py-7">
          <p className="max-w-[640px] font-mono text-xs font-bold uppercase tracking-[0.14em] text-[var(--red-primary)]">
            PLANNED | NOT YET IMPLEMENTED
          </p>
          <p className="max-w-[640px] text-sm leading-6 text-[var(--gray-dark)]">
            Front-end scaffold for future USA Boxing passbook verification. No lookup, insurance check, or
            clearance logic is implemented -- there is nothing behind this field yet, so no result below should
            be treated as real. Verify physical and insurance status through USA Boxing directly until this is
            wired to a real source.
          </p>

          <section className="grid max-w-[640px] gap-3 border-4 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
            <label htmlFor="usa-boxing-id" className="font-semibold text-[var(--black)]">
              Athlete USA Boxing ID
            </label>
            <input
              id="usa-boxing-id"
              type="search"
              value={usaBoxingId}
              onChange={(event) => setUsaBoxingId(event.target.value)}
              placeholder="Enter USA Boxing ID"
              className="tactical-input"
            />
          </section>
        </div>

        <footer className="px-10 pb-8 text-sm text-[var(--gray-dark)]">
          Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715
        </footer>
      </main>
    </RoleStandaloneView>
  );
}
