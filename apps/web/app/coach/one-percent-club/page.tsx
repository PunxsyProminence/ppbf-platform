'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateShort } from '@/src/lib/gymTime';

// 1% Club (module 127). Owner design, verbatim: "1,2,3 with the majority of
// coach and admin on the list vote to confirm".
//
// The page keeps three things visible on purpose:
//   1. A milestone-surfaced nomination is labelled as SURFACED, never shown
//      as if a coach or athlete put the name forward.
//   2. The tally is the real number -- how many yes votes, against how many
//      people are actually eligible to vote right now -- never a percentage
//      standing in for it.
//   3. Confirmed members are permanent. There is no "remove" control here.

interface NominationRow {
  nomination_id: string;
  athlete_id: string;
  athlete_name?: string;
  source: 'coach_nomination' | 'milestone_surfaced' | 'self_peer_nomination';
  nominated_by_display_name: string;
  nominator_note: string;
  milestone_key: string | null;
  status: 'open' | 'confirmed' | 'withdrawn' | 'expired';
  withdrawal_reason: string | null;
  expires_at: string;
  decided_at: string | null;
  created_at: string;
}

interface AthleteOption {
  athlete_id: string;
  full_name: string;
}

const SOURCE_LABEL: Record<NominationRow['source'], string> = {
  coach_nomination: 'Nominated by a coach',
  milestone_surfaced: 'Surfaced by a milestone',
  self_peer_nomination: 'Self / peer nomination',
};

function formatDate(value: string): string {
  return formatGymDateShort(value) ?? '';
}

export default function OnePercentClubPage() {
  const [nominations, setNominations] = useState<NominationRow[]>([]);
  const [members, setMembers] = useState<NominationRow[]>([]);
  const [athletes, setAthletes] = useState<AthleteOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [nominateForm, setNominateForm] = useState({ athlete_id: '', note: '', milestone_key: '' });
  const [withdrawReason, setWithdrawReason] = useState<Record<string, string>>({});

  const reload = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBase()}/api/pilot/coach/one-percent-club`, {
      credentials: 'include',
      signal,
    });
    if (!response.ok) throw new Error('Unable to load the 1% Club.');
    const payload = (await response.json()) as { items?: NominationRow[]; members?: NominationRow[] };
    setNominations(payload.items ?? []);
    setMembers(payload.members ?? []);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const [, athleteResponse] = await Promise.all([
          reload(controller.signal),
          fetch(`${apiBase()}/api/pilot/athletes/list`, { credentials: 'include', signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        if (athleteResponse.ok) {
          const payload = (await athleteResponse.json()) as { items?: AthleteOption[] };
          if (!controller.signal.aborted) setAthletes(payload.items ?? []);
        }
        setLoading(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load the 1% Club.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [reload]);

  const send = async (body: Record<string, unknown>, failure: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/one-percent-club`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `${failure} (${response.status})`);
      }
      setErrorMessage(null);
      const result = (await response.json()) as Record<string, unknown>;
      await reload();
      return result;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : failure);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleNominate = async () => {
    if (!nominateForm.athlete_id) {
      setErrorMessage('Pick an athlete to nominate.');
      return;
    }
    const result = await send({
      action: 'nominate',
      athlete_id: nominateForm.athlete_id,
      note: nominateForm.note,
      milestone_key: nominateForm.milestone_key || undefined,
    }, 'Unable to file the nomination.');
    if (!result) return;
    setNominateForm({ athlete_id: '', note: '', milestone_key: '' });
    setNotice('Nomination filed. It stays open for a vote for 30 days.');
  };

  const handleVote = async (nominationId: string, vote: 'yes' | 'no') => {
    const result = await send({ action: 'vote', nomination_id: nominationId, vote }, 'Unable to record the vote.');
    if (!result) return;
    const tally = (result as { tally?: { yes_count: number; eligible_count: number; majority_reached: boolean } }).tally;
    setNotice(
      tally?.majority_reached
        ? 'That vote confirmed a majority -- this nomination is now a 1% Club member.'
        : `Vote recorded: ${tally?.yes_count ?? 0} yes of ${tally?.eligible_count ?? 0} eligible.`,
    );
  };

  const handleWithdraw = async (nominationId: string) => {
    const reason = (withdrawReason[nominationId] ?? '').trim();
    if (!reason) {
      setErrorMessage('A withdrawal needs a reason -- it stays on the record with it.');
      return;
    }
    const result = await send({ action: 'withdraw', nomination_id: nominationId, reason }, 'Unable to withdraw the nomination.');
    if (!result) return;
    setWithdrawReason((prev) => ({ ...prev, [nominationId]: '' }));
    setNotice('Nomination withdrawn. It stays on the record with the reason given.');
  };

  const openNominations = nominations.filter((n) => n.status === 'open');
  const closedNominations = nominations.filter((n) => n.status !== 'open');

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <main className="room room--floor min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Coach Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>1% Club</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              A coach nominates directly, an athlete nominates themselves or a teammate, or a real
              earned milestone is cited as the reason. Every path still needs a majority of this
              gym&rsquo;s active coaches and admins to vote yes before anyone becomes a member.
              Membership, once confirmed, is permanent.
            </p>
          </header>

          {errorMessage && (
            <div className="alert alert--critical" role="alert">
              <span className="alert-icon" aria-hidden="true">✕</span>
              <div className="alert-body">
                <p className="alert-title">Failed</p>
                <p className="alert-msg">{errorMessage}</p>
              </div>
            </div>
          )}

          {notice && (
            <div className="alert alert--success" role="status">
              <span className="alert-icon" aria-hidden="true">✓</span>
              <div className="alert-body">
                <p className="alert-title">Recorded</p>
                <p className="alert-msg">{notice}</p>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-[var(--s6)]">
              <span className="working">Loading the 1% Club...</span>
            </div>
          ) : (
            <>
              <section className="mat-leather mb-[var(--s4)] rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-label mb-[var(--s3)]">Nominate</h2>
                <div className="grid gap-[var(--s3)] md:grid-cols-3">
                  <div className="field">
                    <label className="t-label" htmlFor="nom-athlete">Athlete</label>
                    <select id="nom-athlete" className="select" value={nominateForm.athlete_id}
                      onChange={(e) => setNominateForm((f) => ({ ...f, athlete_id: e.target.value }))}>
                      <option value="">Select…</option>
                      {athletes.map((a) => (
                        <option key={a.athlete_id} value={a.athlete_id}>{a.full_name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="t-label" htmlFor="nom-note">Why (optional)</label>
                    <input id="nom-note" className="input" value={nominateForm.note}
                      onChange={(e) => setNominateForm((f) => ({ ...f, note: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label className="t-label" htmlFor="nom-milestone">Milestone key, if this cites one (optional)</label>
                    <input id="nom-milestone" className="input" value={nominateForm.milestone_key}
                      onChange={(e) => setNominateForm((f) => ({ ...f, milestone_key: e.target.value }))} />
                  </div>
                </div>
                <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>
                  A milestone key is only kept if the athlete actually holds that award -- an
                  unearned key is dropped and the nomination is filed as an ordinary nomination
                  instead.
                </p>
                <div className="mt-[var(--s3)]">
                  <button type="button" className="btn" disabled={busy} onClick={() => void handleNominate()}>
                    {busy ? 'Filing…' : 'File nomination'}
                  </button>
                </div>
              </section>

              <section className="mat-leather mb-[var(--s4)] rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-label mb-[var(--s3)]">Open nominations</h2>
                {openNominations.length === 0 ? (
                  <p className="t-body">No open nominations. File one above, or wait for a peer or coach to.</p>
                ) : (
                  <ul className="space-y-[var(--s3)]">
                    {openNominations.map((nomination) => (
                      <li key={nomination.nomination_id} className="rounded-[var(--r-md)] p-[var(--s3)]" style={{ border: '1px solid var(--brass-800)' }}>
                        <div className="flex flex-wrap items-baseline gap-[var(--s3)]">
                          <span className="t-body font-semibold text-[color:var(--bone-100)]">
                            {nomination.athlete_name ?? nomination.athlete_id}
                          </span>
                          <span className="badge badge--filed">
                            <i aria-hidden="true">▣</i>{SOURCE_LABEL[nomination.source]}
                          </span>
                          <span className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                            filed by {nomination.nominated_by_display_name} · voting closes {formatDate(nomination.expires_at)}
                          </span>
                        </div>
                        {nomination.milestone_key ? (
                          <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>
                            Milestone cited: <span style={{ fontFamily: 'var(--font-mono)' }}>{nomination.milestone_key}</span>
                          </p>
                        ) : null}
                        {nomination.nominator_note ? (
                          <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{nomination.nominator_note}</p>
                        ) : null}
                        <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
                          <button type="button" className="btn" disabled={busy} onClick={() => void handleVote(nomination.nomination_id, 'yes')}>
                            Vote yes
                          </button>
                          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void handleVote(nomination.nomination_id, 'no')}>
                            Vote no
                          </button>
                        </div>
                        <div className="mt-[var(--s3)] grid gap-[var(--s2)] md:grid-cols-[1fr_auto]">
                          <input
                            className="input"
                            placeholder="Reason to withdraw this nomination"
                            aria-label={`Reason to withdraw the nomination for ${nomination.athlete_name ?? nomination.athlete_id}`}
                            value={withdrawReason[nomination.nomination_id] ?? ''}
                            onChange={(e) => setWithdrawReason((prev) => ({ ...prev, [nomination.nomination_id]: e.target.value }))}
                          />
                          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void handleWithdraw(nomination.nomination_id)}>
                            Withdraw
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="mat-leather mb-[var(--s4)] rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-label mb-[var(--s3)]">1% Club members</h2>
                {members.length === 0 ? (
                  <p className="t-body">No confirmed members yet.</p>
                ) : (
                  <ul className="space-y-[var(--s2)]">
                    {members.map((member) => (
                      <li key={member.nomination_id} className="flex flex-wrap items-baseline gap-[var(--s3)]">
                        <span className="badge badge--cleared"><i aria-hidden="true">✓</i>Member</span>
                        <span className="t-body font-semibold text-[color:var(--bone-100)]">
                          {member.athlete_name ?? member.athlete_id}
                        </span>
                        <span className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                          confirmed {member.decided_at ? formatDate(member.decided_at) : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {closedNominations.length > 0 ? (
                <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                  <h2 className="t-label mb-[var(--s3)]">Closed nominations</h2>
                  <ul className="space-y-[var(--s2)]">
                    {closedNominations.filter((n) => n.status !== 'confirmed').map((nomination) => (
                      <li key={nomination.nomination_id} className="flex flex-wrap items-baseline gap-[var(--s3)]">
                        <span className="badge badge--restricted">
                          <i aria-hidden="true">✕</i>{nomination.status}
                        </span>
                        <span className="t-body">{nomination.athlete_name ?? nomination.athlete_id}</span>
                        {nomination.withdrawal_reason ? (
                          <span className="t-body" style={{ fontSize: 'var(--t-sm)' }}>{nomination.withdrawal_reason}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/coach" className="btn btn--ghost">Back to Coach Workspace</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
