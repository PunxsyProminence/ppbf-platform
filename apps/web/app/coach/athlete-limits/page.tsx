'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import MinorLimitsPanel from '@/components/MinorLimitsPanel';
import { apiBase } from '@/lib/apiBase';
import WorkAxis from '@/components/WorkAxis';

// Athlete limits (OD-2026-10-06-024 ruling 2): the limits a coach sets for a
// minor, as data -- heat exposure in minutes per session, the most weight cut
// as a percentage of body weight, and the supervision the coach requires in
// their own words. Contact level keeps its own home on /coach/sparring-caps
// and is shown here read-only. An adult's limits are recorded the same way,
// labelled adult (OD-2026-10-07-005 "A").
//
// ITS OWN PAGE in the clinic, beside Sparring Caps: the sports-medicine
// board's surface rule (owner decision 2026-08-15) is clearance and holds
// only, so limits do not sit on it.
//
// Coach-set data: nothing on this page proposes a limit, and nothing blocks
// training. Authorization is the route's: the roster is the whole gym, so
// this page offers only the athletes the limits route will open for this
// person (a coach's own and covered athletes; an admin's whole gym). Staff
// only (OD-2026-10-08-007 Q5): no athlete or guardian door leads here.

interface RosterAthlete { athlete_id: string; full_name?: string }

export default function AthleteLimitsPage() {
  const [roster, setRoster] = useState<RosterAthlete[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/pilot/athletes/list`, { method: 'GET', credentials: 'include' });
        const payload = res.ok ? ((await res.json()) as { items?: unknown } | null) : null;
        if (!payload || !Array.isArray(payload.items)) throw new Error('roster');
        const all = payload.items as RosterAthlete[];
        const allowedRes = await fetch(`${apiBase()}/api/pilot/coach/athlete-minor-limits`, {
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
      routeLabel="/coach/athlete-limits"
      allowedRoles={['coach', 'admin']}
      room="clinic"
      showShellHeader={false}
    >
      {/* data-surface="kiosk" -- Law 5: a coach sets these between rounds on
          the floor tablet, so every control takes the 55px tap floor and the
          text the 19.1px type floor. */}
      <div data-surface="kiosk" className="mx-auto max-w-4xl">
        <div className="mat-wood mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow text-[color:var(--brass-200)]">Sports Medicine</p>
          <h1 className="t-gothic mt-[var(--s3)] text-[color:var(--bone-100)]" style={{ fontSize: 'var(--t-2xl)' }}>
            Athlete Limits
          </h1>
          <p className="mt-[var(--s3)] text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
            The limits you set for each athlete: heat exposure in minutes per session, the most weight cut as a
            percent of body weight, and the supervision you require. The app never picks a limit, and nothing here
            blocks training — the coach decides.
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
          <p className="t-body">No athletes you can set limits for.</p>
        ) : (
          <ul className="space-y-[var(--s3)]">
            {roster.map((athlete) => (
              <li key={athlete.athlete_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <span className="t-body font-semibold text-[color:var(--bone-100)]">
                  {athlete.full_name || athlete.athlete_id}
                </span>
                <MinorLimitsPanel athleteId={athlete.athlete_id} athleteName={athlete.full_name || athlete.athlete_id} />
              </li>
            ))}
          </ul>
        )}

        <div className="mt-[var(--s5)] flex flex-wrap gap-[var(--s3)]">
          <Link href="/coach/sparring-caps" className="btn btn--ghost">Sparring Caps</Link>
          <Link href="/coach/sports-medicine" className="btn btn--ghost">Clearance Board</Link>
        </div>
        <WorkAxis />
      </div>
    </RoleStandaloneView>
  );
}
