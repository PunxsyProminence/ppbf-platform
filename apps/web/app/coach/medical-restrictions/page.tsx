'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import ClusterNav from '@/components/ClusterNav';
import MedicalRestrictionsPanel from '@/components/MedicalRestrictionsPanel';
import { apiBase } from '@/lib/apiBase';
import WorkAxis from '@/components/WorkAxis';

// USA Boxing medical restrictions, the staff page (Backbone P22, lane P22a).
//
// ITS OWN PAGE, linked from the Sports Medicine clearance board, because that
// board's 2026-08-15 rule is "clearance and holds only, never diagnoses or
// clinical detail", and a restriction's source and loss-of-consciousness answer
// are clinical detail. Jason has twice put records of this kind on their own
// page for that reason: OD-2026-10-04-001 (the injury log, /coach/injuries) and
// OD-2026-10-04-017 (the sparring cap editor, /coach/sparring-caps).
//
// WHO. The shell admits coach and admin (a gym admin reads as 'admin' on the
// client); the route admits coach, organization_admin and admin, and checks
// standing on every athlete (assertActorCanAccessAthlete). Those are exactly
// the roles that may write a restriction (OW25-05 A), so the page shows them
// the full staff record (Overwatch's approved design, "staff: full row"). The
// member and their parent never reach this page.
//
// The roster is the athlete list the app already serves this signed-in user;
// the restrictions route refuses any athlete it does not admit.

interface RosterAthlete { athlete_id: string; full_name?: string }

export default function MedicalRestrictionsPage() {
  const [roster, setRoster] = useState<RosterAthlete[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/pilot/athletes/list`, { method: 'GET', credentials: 'include' });
        const payload = res.ok ? ((await res.json()) as { items?: unknown } | null) : null;
        if (!payload || !Array.isArray(payload.items)) throw new Error('roster');
        setRoster(payload.items as RosterAthlete[]);
      } catch {
        setFailed(true);
      }
    })();
  }, []);

  return (
    <RoleStandaloneView
      roleLabel="Coach Workspace"
      routeLabel="/coach/medical-restrictions"
      allowedRoles={['coach', 'admin']}
      room="clinic"
      showShellHeader={false}
    >
      <div className="mx-auto max-w-4xl">
        <div className="mat-wood mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow text-[color:var(--brass-200)]">Sports Medicine</p>
          <h1 className="t-gothic mt-[var(--s3)] text-[color:var(--bone-100)]" style={{ fontSize: 'var(--t-2xl)' }}>
            Medical Restrictions
          </h1>
          <ClusterNav cluster="clinic" />
          <p className="mt-[var(--s3)] text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
            USA Boxing medical restrictions: from a ringside Restriction Affidavit, a training knockout or
            concussion, or another source. The app stores the dates, not the documents.
          </p>
        </div>

        {failed ? (
          <div className="alert alert--warning mb-[var(--s4)]" role="alert">
            <span className="alert-icon" aria-hidden="true">▲</span>
            <div className="alert-body">
              {/* Inline size: .alert-title/.alert-msg are unlayered fixed sizes the kiosk type floor (layout.tsx) does not reach. */}
              <p className="alert-title" style={{ fontSize: 'var(--t-md)', lineHeight: 1.25 }}>Not loaded</p>
              <p className="alert-msg" style={{ fontSize: 'var(--t-md)' }}>Your roster could not be loaded. Reload to try again.</p>
            </div>
          </div>
        ) : roster === null ? (
          <p className="t-body" role="status">Loading your roster…</p>
        ) : (
          <MedicalRestrictionsPanel athletes={roster} />
        )}

        <div className="mt-[var(--s5)]">
          <Link href="/coach/sports-medicine" className="btn btn--ghost">Clearance Board</Link>
        </div>
        <WorkAxis />
      </div>
    </RoleStandaloneView>
  );
}
