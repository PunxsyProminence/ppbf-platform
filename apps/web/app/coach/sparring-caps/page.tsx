'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import ContactCapPanel from '@/components/ContactCapPanel';
import { apiBase } from '@/lib/apiBase';
import WorkAxis from '@/components/WorkAxis';

// Sparring caps (map item 15): the limits a coach sets for each athlete's
// sparring -- the highest contact stage, and the most hard or open sparring
// sessions in any 7 days (sessions = gym days).
//
// ITS OWN PAGE, linked from the sports-medicine board, because that board's
// surface rule (owner decision 2026-08-15) is clearance and holds only; Jason
// chose this page 2026-10-04 ("Own page"), the same placement the injury
// record has. The labelled staff note (OD-2026-10-04-013) lives here with the
// caps.
//
// Coach-set data, warn only (OD-2026-10-04-004): nothing on this page proposes
// a limit or blocks sparring. Authorization is the route's: the roster is the
// whole gym, so this page offers only the athletes the cap route will open for
// this person (a coach's own and covered athletes; an admin's whole gym).

interface RosterAthlete { athlete_id: string; full_name?: string }

export default function SparringCapsPage() {
  const [roster, setRoster] = useState<RosterAthlete[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/pilot/athletes/list`, { method: 'GET', credentials: 'include' });
        const payload = res.ok ? ((await res.json()) as { items?: unknown } | null) : null;
        if (!payload || !Array.isArray(payload.items)) throw new Error('roster');
        const all = payload.items as RosterAthlete[];
        const allowedRes = await fetch(`${apiBase()}/api/pilot/coach/athlete-contact-caps`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'accessible_athletes', athlete_ids: all.map((a) => a.athlete_id) }),
        });
        const allowed = allowedRes.ok ? ((await allowedRes.json()) as { athlete_ids?: unknown } | null) : null;
        if (!allowed || !Array.isArray(allowed.athlete_ids)) throw new Error('roster');
        const ids = new Set(allowed.athlete_ids as string[]);
        setRoster(all.filter((a) => ids.has(a.athlete_id)));
      } catch {
        // A roster that could not be read is never shown as "no athletes".
        setFailed(true);
      }
    })();
  }, []);

  return (
    <RoleStandaloneView
      roleLabel="Coach Workspace"
      routeLabel="/coach/sparring-caps"
      allowedRoles={['coach', 'admin']}
      room="clinic"
      showShellHeader={false}
    >
      <div className="mx-auto max-w-4xl">
        <div className="mat-wood mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow text-[color:var(--brass-200)]">Sports Medicine</p>
          <h1 className="t-gothic mt-[var(--s3)] text-[color:var(--bone-100)]" style={{ fontSize: 'var(--t-2xl)' }}>
            Sparring Caps
          </h1>
          <p className="mt-[var(--s3)] text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
            The limits you set for each athlete&apos;s sparring: the highest contact stage, and the most hard or open
            sparring sessions in any 7 days. The app never picks a limit, and a cap never blocks sparring — the coach
            decides.
          </p>
        </div>

        {failed ? (
          <div className="alert alert--warning mb-[var(--s4)]" role="alert">
            <span className="alert-icon" aria-hidden="true">▲</span>
            <div className="alert-body">
              <p className="alert-title">Not loaded</p>
              <p className="alert-msg">Your roster could not be loaded. Reload to try again.</p>
            </div>
          </div>
        ) : roster === null ? (
          <p className="t-body" role="status">Loading your roster…</p>
        ) : roster.length === 0 ? (
          <p className="t-body">No athletes you can set caps for.</p>
        ) : (
          <ul className="space-y-[var(--s3)]">
            {roster.map((athlete) => (
              <li key={athlete.athlete_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <span className="t-body font-semibold text-[color:var(--bone-100)]">
                  {athlete.full_name || athlete.athlete_id}
                </span>
                <ContactCapPanel athleteId={athlete.athlete_id} athleteName={athlete.full_name || athlete.athlete_id} />
              </li>
            ))}
          </ul>
        )}

        <div className="mt-[var(--s5)]">
          <Link href="/coach/sports-medicine" className="btn btn--ghost">Clearance Board</Link>
        </div>
        <WorkAxis />
      </div>
    </RoleStandaloneView>
  );
}
