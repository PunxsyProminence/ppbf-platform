'use client';

import { useState } from 'react';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { GYM_ADDRESS, GYM_NAME } from '@/components/PrintSheet';

export default function PassbookCheckPage() {
  const [usaBoxingId, setUsaBoxingId] = useState('');

  return (
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/environment/passbook-check" allowedRoles={['coach']} room="floor" showShellHeader={false}>
      <div className="text-[color:var(--bone-200)]">
        <header className="mat-leather--raised rounded-[var(--r-lg)] border-b-4 border-[color:var(--brass-700)] px-[var(--s5)] py-[var(--s4)]">
          <p className="t-command text-[length:var(--t-md)]">Track C: USA Boxing Passbook Verification</p>
        </header>

        <div className="grid gap-[var(--s5)] py-[var(--s5)]">
          <p className="max-w-[640px]">
            <span className="stamp stamp--brass stamp--flat">Planned — Not Yet Implemented</span>
          </p>
          <p className="t-body max-w-[640px] text-[color:var(--bone-400)]">
            Front-end scaffold for future USA Boxing passbook verification. No lookup, insurance check, or
            clearance logic is implemented -- there is nothing behind this field yet, so no result below should
            be treated as real. Verify physical and insurance status through USA Boxing directly until this is
            wired to a real source.
          </p>

          <section className="mat-leather grid max-w-[640px] gap-[var(--s3)] rounded-[var(--r-lg)] p-[var(--s5)]">
            <div className="field">
              <label htmlFor="usa-boxing-id" className="t-label">
                Athlete USA Boxing ID
              </label>
              <input
                id="usa-boxing-id"
                type="search"
                value={usaBoxingId}
                onChange={(event) => setUsaBoxingId(event.target.value)}
                placeholder="Enter USA Boxing ID"
                className="input input--kiosk"
              />
            </div>
          </section>
        </div>

        {/* Reuses PrintSheet's GYM_NAME/GYM_ADDRESS rather than its own copy of
            either -- this exact literal (in a different capitalization the
            original address fix's grep missed) was still the office address,
            not the training location, until this pass. */}
        <footer className="t-muted pb-[var(--s5)]">
          {GYM_NAME}, Registered Office: {GYM_ADDRESS}
        </footer>
      </div>
    </RoleStandaloneView>
  );
}
