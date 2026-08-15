'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric } from '@/src/lib/gymTime';

// The coach's clearance board (owner decision 2026-08-15): clearance status
// and active training holds with athlete-safe explanations ONLY.
//
// What this page deliberately does NOT show, and must never grow: diagnoses,
// clinical notes, restriction detail, source references, or any reason beyond
// what the athlete themselves reads. The medical-status route legitimately
// serves coaches more than this page displays (SHADOW_PHI_ROLES); the owner's
// decision constrains the SURFACE, and the constraint is the product.
//
// Reading is fail-closed in presentation: "no record" and "unknown" are
// rendered as action states, never as quiet. The medical gate itself
// (shadowRecommendations/shadowDecisions) already refuses to write against an
// athlete with no clearance record -- this board is where a coach sees that
// coming before the gate says no.
//
// This page replaced a scaffold that rendered org-wide SHADOW observation
// projections under a sports-medicine heading -- data that had nothing to do
// with any athlete's clearance.
interface RosterAthlete {
  athlete_id: string;
  full_name?: string;
}

type ClearanceValue = 'cleared' | 'restricted' | 'not_cleared' | 'pending';

interface ClearanceRow {
  athlete_id: string;
  full_name: string;
  // null = no clearance record on file; 'unavailable' = the read itself failed.
  clearance: ClearanceValue | null | 'unavailable';
  effective_at: string | null;
  hold: {
    scope: string;
    athlete_explanation: string;
    lift_condition_text: string;
  } | null;
}

const CLEARANCE_BADGE: Record<string, { className: string; glyph: string; label: string }> = {
  cleared: { className: 'badge badge--cleared', glyph: '✓', label: 'cleared' },
  restricted: { className: 'badge badge--restricted', glyph: '▲', label: 'restricted' },
  not_cleared: { className: 'badge badge--locked', glyph: '✕', label: 'not cleared' },
  pending: { className: 'badge badge--restricted', glyph: '▲', label: 'pending' },
  none: { className: 'badge badge--locked', glyph: '✕', label: 'no record' },
  unavailable: { className: 'badge badge--restricted', glyph: '▲', label: 'unavailable' },
};

function clearanceBadge(row: ClearanceRow) {
  if (row.clearance === 'unavailable') return CLEARANCE_BADGE.unavailable;
  if (row.clearance === null) return CLEARANCE_BADGE.none;
  return CLEARANCE_BADGE[row.clearance] ?? CLEARANCE_BADGE.unavailable;
}

export default function SportsMedicinePage() {
  const [rows, setRows] = useState<ClearanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const rosterRes = await fetch(`${apiBase()}/api/pilot/athletes/list`, {
          method: 'GET',
          credentials: 'include',
        });
        if (!rosterRes.ok) throw new Error('Unable to load your roster.');
        const rosterPayload = (await rosterRes.json()) as { items?: RosterAthlete[] };
        const roster = rosterPayload.items ?? [];

        // One clearance read and one hold read per athlete, through the same
        // routes that enforce coach-of-record/coverage access server-side. A
        // failed read renders as 'unavailable', never as cleared.
        const built = await Promise.all(
          roster.map(async (athlete): Promise<ClearanceRow> => {
            const base: ClearanceRow = {
              athlete_id: athlete.athlete_id,
              full_name: athlete.full_name || 'Unknown',
              clearance: 'unavailable',
              effective_at: null,
              hold: null,
            };
            try {
              const [statusRes, holdRes] = await Promise.all([
                fetch(
                  `${apiBase()}/api/pilot/shadow/medical-status?athleteId=${encodeURIComponent(athlete.athlete_id)}`,
                  { method: 'GET', credentials: 'include' },
                ),
                fetch(
                  `${apiBase()}/api/pilot/training-holds?athlete_id=${encodeURIComponent(athlete.athlete_id)}&status=active`,
                  { method: 'GET', credentials: 'include' },
                ),
              ]);

              if (statusRes.ok) {
                const payload = (await statusRes.json()) as {
                  status?: { status: ClearanceValue; effective_at: string } | null;
                };
                base.clearance = payload.status ? payload.status.status : null;
                base.effective_at = payload.status?.effective_at ?? null;
              }

              if (holdRes.ok) {
                const payload = (await holdRes.json()) as {
                  holds?: Array<{ scope: string; athlete_explanation: string; lift_condition_text: string }>;
                };
                base.hold = payload.holds?.[0] ?? null;
              }
            } catch {
              // Leave the fail-closed defaults: unavailable, no hold claim.
            }
            return base;
          }),
        );

        setRows(built);
        setErrorMessage(null);
      } catch (error) {
        setRows([]);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load the clearance board.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/sports-medicine" allowedRoles={['coach', 'admin']} room="clinic" showShellHeader={false}>
      <div className="min-h-screen rounded-[var(--r-lg)] bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto max-w-4xl">
          <div className="mb-[var(--s5)]">
            <p className="t-eyebrow">Sports Medicine</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Clearance Board</h1>
            <p className="mt-[var(--s3)] text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
              Clearance status and active training holds for your roster — exactly what the athlete themselves
              can read, and nothing more. Clearance records are set by the office; an athlete with no record
              cannot receive recommendations until one exists.
            </p>
          </div>

          {errorMessage && (
            <div className="alert alert--critical" role="alert">
              <span className="alert-icon" aria-hidden="true">✕</span>
              <div className="alert-body">
                <p className="alert-title">Failed</p>
                <p className="alert-msg">{errorMessage}</p>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-[var(--s7)]">
              <span className="working">Loading clearance board...</span>
            </div>
          ) : rows.length === 0 ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">No athletes on your roster</div>
                <p className="empty-msg mx-auto">Athletes you coach (or cover) will appear here with their clearance state.</p>
              </div>
            </div>
          ) : (
            <ul className="space-y-[var(--s3)]">
              {rows.map((row) => {
                const badge = clearanceBadge(row);
                return (
                  <li key={row.athlete_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                    <div className="flex flex-wrap items-center gap-[var(--s3)]">
                      <span className="t-body font-semibold text-[color:var(--bone-100)]">{row.full_name}</span>
                      <span className={badge.className}><i aria-hidden="true">{badge.glyph}</i>{badge.label}</span>
                      {row.effective_at ? (
                        <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                          since {formatGymDateNumeric(row.effective_at)}
                        </span>
                      ) : null}
                    </div>
                    {row.clearance === null ? (
                      <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]" style={{ fontSize: 'var(--t-sm)' }}>
                        No clearance record on file. The office sets one during onboarding; until then the
                        medical gate blocks recommendations for this athlete.
                      </p>
                    ) : null}
                    {row.clearance === 'unavailable' ? (
                      <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]" style={{ fontSize: 'var(--t-sm)' }}>
                        Clearance could not be read just now. Unknown is not cleared — check again before
                        making a call that depends on it.
                      </p>
                    ) : null}
                    {row.hold ? (
                      <div className="mat-paper mt-[var(--s3)] rounded-[var(--r-md)] border-l-4 border-[color:var(--brass-700)] p-[var(--s3)]">
                        <p className="t-eyebrow">Active Training Hold — {row.hold.scope.replaceAll('_', ' ')}</p>
                        <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{row.hold.athlete_explanation}</p>
                        {row.hold.lift_condition_text ? (
                          <p className="t-label mt-[var(--s2)]">Lifts when: {row.hold.lift_condition_text}</p>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-[var(--s5)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/coach/progression-intelligence" className="btn btn--ghost">
              Progression Intelligence
            </Link>
            <Link href="/coach/performance-analytics" className="btn btn--ghost">
              Performance Analytics
            </Link>
          </div>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
