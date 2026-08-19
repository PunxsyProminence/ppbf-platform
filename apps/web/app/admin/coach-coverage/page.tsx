"use client";

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateTimeShort } from '@/src/lib/gymTime';

interface ActiveCoverageRow {
  coverage_id: string;
  athlete_id: string;
  athlete_full_name: string;
  covering_coach_id: string;
  covering_coach_email: string | null;
  granted_by_account_id: string;
  granted_by_email: string | null;
  starts_at: string;
  expires_at: string;
}

function formatDate(value: string): string {
  return formatGymDateTimeShort(value) ?? value;
}

/** One option in the athlete picker, from /api/pilot/athletes/list. */
interface RosterAthleteOption {
  athlete_id: string;
  full_name: string;
}

/** One option in the coach picker, from /api/pilot/admin/staff's member roster. */
interface CoachOption {
  account_id: string;
  login_email: string;
}

export default function CoachCoveragePage() {
  const [items, setItems] = useState<ActiveCoverageRow[] | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [pendingCoverageIds, setPendingCoverageIds] = useState<Set<string>>(new Set());

  const [athleteId, setAthleteId] = useState('');
  const [coveringCoachId, setCoveringCoachId] = useState('');
  const [ttlHours, setTtlHours] = useState('');
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState('');

  // The pickers' feeds. Both reads answer to the same organization-admin
  // session this console already requires, and both are existing routes.
  // 'unavailable' disables granting: with no list to pick from, the honest
  // states are "here is who exists" or "the list could not be loaded" --
  // never a blank field inviting a transcribed id.
  const [roster, setRoster] = useState<RosterAthleteOption[]>([]);
  const [rosterState, setRosterState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');
  const [coaches, setCoaches] = useState<CoachOption[]>([]);
  const [coachesState, setCoachesState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/coach-coverage`, { credentials: 'include' });
      const payload = (await response.json().catch(() => ({}))) as { coverage?: ActiveCoverageRow[]; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to load active coverage grants.');
      }
      setItems(payload.coverage ?? []);
      setErrorMessage('');
    } catch (error) {
      setItems([]);
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load active coverage grants.');
    }
  }, []);

  const loadRoster = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, { credentials: 'include' });
      if (!response.ok) throw new Error('roster');
      const payload = (await response.json()) as { items?: Array<{ athlete_id?: unknown; full_name?: unknown }> };
      setRoster(
        (payload.items ?? [])
          .filter((row): row is { athlete_id: string; full_name?: unknown } => typeof row.athlete_id === 'string' && row.athlete_id !== '')
          .map((row) => ({
            athlete_id: row.athlete_id,
            full_name: typeof row.full_name === 'string' && row.full_name.trim() !== '' ? row.full_name : row.athlete_id,
          })),
      );
      setRosterState('loaded');
    } catch {
      setRoster([]);
      setRosterState('unavailable');
    }
  }, []);

  const loadCoaches = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/staff`, { credentials: 'include' });
      if (!response.ok) throw new Error('members');
      const payload = (await response.json()) as {
        members?: Array<{ account_id?: unknown; login_email?: unknown; role?: unknown; active_flag?: unknown; membership_active?: unknown }>;
      };
      // Only what the server itself would accept: grantCoachCoverage requires
      // an ACTIVE coach account in this organization, so the picker offers
      // exactly that set rather than every member.
      setCoaches(
        (payload.members ?? [])
          .filter((member) =>
            member.role === 'coach'
            && member.active_flag !== false
            && member.membership_active !== false
            && typeof member.account_id === 'string'
            && member.account_id !== '')
          .map((member) => ({
            account_id: member.account_id as string,
            login_email: typeof member.login_email === 'string' && member.login_email !== '' ? member.login_email : (member.account_id as string),
          })),
      );
      setCoachesState('loaded');
    } catch {
      setCoaches([]);
      setCoachesState('unavailable');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await Promise.all([load(), loadRoster(), loadCoaches()]);
    })();
  }, [load, loadRoster, loadCoaches]);

  async function grant(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setGrantError('');
    setGranting(true);
    try {
      const body: { athlete_id: string; covering_coach_id: string; ttl_hours?: number } = {
        athlete_id: athleteId.trim(),
        covering_coach_id: coveringCoachId.trim(),
      };
      const parsedTtl = ttlHours.trim();
      if (parsedTtl) {
        body.ttl_hours = Number(parsedTtl);
      }

      const response = await fetch(`${apiBase()}/api/pilot/admin/coach-coverage`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to grant coverage.');
      }
      setAthleteId('');
      setCoveringCoachId('');
      setTtlHours('');
      setActionMessage('Coverage granted.');
      await load();
    } catch (error) {
      setGrantError(error instanceof Error ? error.message : 'Unable to grant coverage.');
    } finally {
      setGranting(false);
    }
  }

  async function revoke(coverageId: string) {
    const confirmed = window.confirm('Revoke this coverage grant? The covering coach loses access immediately.');
    if (!confirmed) return;

    setPendingCoverageIds((prev) => new Set(prev).add(coverageId));
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/coach-coverage`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coverage_id: coverageId }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || 'Unable to revoke coverage.');
      }
      setActionMessage('Coverage revoked.');
      await load();
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : 'Unable to revoke coverage.');
    } finally {
      setPendingCoverageIds((prev) => {
        const next = new Set(prev);
        next.delete(coverageId);
        return next;
      });
    }
  }

  const isLoading = items === null;

  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <main className="room room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
            <p className="t-eyebrow">Admin Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Coach Coverage</h1>
            <p className="t-data mt-[var(--s3)] uppercase tracking-[0.14em] text-[color:var(--brass-300)]">LIVE | pilot.coach_coverage</p>
            <p className="t-body mt-[var(--s3)] max-w-4xl">
              A coverage grant lets a covering coach read one athlete&rsquo;s record temporarily -- a sub, a
              guest instructor, a coach filling in on short notice. Grants expire on their own; revoke ends one
              immediately.
            </p>
            {errorMessage ? (
              <p role="alert" className="alert alert--critical mt-[var(--s3)]">
                <span className="alert-icon">✕</span>
                <span className="alert-msg">{errorMessage}</span>
              </p>
            ) : null}
            {actionMessage ? <p className="t-body mt-[var(--s3)] font-semibold text-[color:var(--brass-300)]">{actionMessage}</p> : null}
          </header>

          <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
            <h2 className="t-eyebrow">Grant coverage</h2>
            <form onSubmit={(event) => void grant(event)} className="mt-[var(--s3)] flex flex-wrap items-end gap-[var(--s3)]">
              <label className="flex flex-col gap-[var(--s1)]">
                <span className="t-eyebrow">Athlete</span>
                <select
                  required
                  value={athleteId}
                  onChange={(event) => setAthleteId(event.target.value)}
                  disabled={rosterState !== 'loaded'}
                  className="select min-h-[44px]"
                >
                  <option value="">
                    {rosterState === 'loading' ? 'Loading athletes...' : 'Select an athlete'}
                  </option>
                  {roster.map((athlete) => (
                    <option key={athlete.athlete_id} value={athlete.athlete_id}>
                      {athlete.full_name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-[var(--s1)]">
                <span className="t-eyebrow">Covering coach</span>
                <select
                  required
                  value={coveringCoachId}
                  onChange={(event) => setCoveringCoachId(event.target.value)}
                  disabled={coachesState !== 'loaded'}
                  className="select min-h-[44px]"
                >
                  <option value="">
                    {coachesState === 'loading' ? 'Loading coaches...' : 'Select a coach'}
                  </option>
                  {coaches.map((coach) => (
                    <option key={coach.account_id} value={coach.account_id}>
                      {coach.login_email}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-[var(--s1)]">
                <span className="t-eyebrow">Hours (default 24, max 336)</span>
                <input
                  type="number"
                  min={1}
                  max={336}
                  value={ttlHours}
                  onChange={(event) => setTtlHours(event.target.value)}
                  className="input min-h-[44px] w-32"
                />
              </label>
              <button
                type="submit"
                disabled={granting || rosterState !== 'loaded' || coachesState !== 'loaded'}
                className="btn--lever min-h-[44px] disabled:opacity-50"
              >
                Grant
              </button>
            </form>
            {(rosterState === 'unavailable' || coachesState === 'unavailable') && (
              <p role="alert" className="alert alert--critical mt-[var(--s3)]">
                <span className="alert-icon">✕</span>
                <span className="alert-msg">
                  {rosterState === 'unavailable' && 'The athlete roster could not be loaded. '}
                  {coachesState === 'unavailable' && 'The coach list could not be loaded. '}
                  Granting is disabled until the lists load -- reload to retry.
                </span>
              </p>
            )}
            {coachesState === 'loaded' && coaches.length === 0 && (
              <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
                No active coach accounts exist in this organization, so there is nobody to grant
                coverage to.
              </p>
            )}
            {grantError ? (
              <p role="alert" className="alert alert--critical mt-[var(--s3)]">
                <span className="alert-icon">✕</span>
                <span className="alert-msg">{grantError}</span>
              </p>
            ) : null}
          </section>

          {isLoading ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">Loading active grants…</div>
            </div>
          ) : errorMessage ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">✕</div>
              <div className="empty-title">The list could not be loaded</div>
              <div className="empty-msg">The list above is unavailable, not empty. Reload to retry.</div>
            </div>
          ) : items.length === 0 ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">No active coverage grants</div>
              <div className="empty-msg">Nobody is currently covering another coach&rsquo;s athlete.</div>
            </div>
          ) : (
            <section className="mat-leather mt-[var(--s5)] overflow-x-auto rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)]">
              <table className="w-full text-left">
                <thead>
                  <tr className="t-eyebrow border-b border-[color:var(--hide-700)]">
                    <th className="px-[var(--s4)] py-[var(--s3)]">Athlete</th>
                    <th className="px-[var(--s4)] py-[var(--s3)]">Covering coach</th>
                    <th className="px-[var(--s4)] py-[var(--s3)]">Granted by</th>
                    <th className="px-[var(--s4)] py-[var(--s3)]">Expires</th>
                    <th className="px-[var(--s4)] py-[var(--s3)]">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.coverage_id} className="border-b border-[color:var(--hide-800)] last:border-b-0 align-top">
                      <td className="t-body px-[var(--s4)] py-[var(--s3)]">{item.athlete_full_name}</td>
                      <td className="t-body px-[var(--s4)] py-[var(--s3)]">{item.covering_coach_email ?? item.covering_coach_id}</td>
                      <td className="t-body px-[var(--s4)] py-[var(--s3)]">{item.granted_by_email ?? item.granted_by_account_id}</td>
                      <td className="t-body px-[var(--s4)] py-[var(--s3)]">{formatDate(item.expires_at)}</td>
                      <td className="px-[var(--s4)] py-[var(--s3)]">
                        <button
                          type="button"
                          disabled={pendingCoverageIds.has(item.coverage_id)}
                          onClick={() => void revoke(item.coverage_id)}
                          className="btn--lever min-h-[44px] disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <div className="mt-[var(--s6)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/operations" className="btn btn--ghost">
              Back to Mission Control
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
