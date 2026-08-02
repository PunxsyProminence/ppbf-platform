'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { isOrganizationAdminSessionRole, usePilotSession } from '@/components/usePilotSession';
import { apiBase } from '@/lib/apiBase';
// The same eight slugs the /board/[seat] pages route on and the
// pilot_board_seats_seat_check constraint admits. Reading them from the config
// rather than restating them keeps a seat this console can assign and a seat
// the database accepts from drifting apart.
import { boardSeatConfigs, type BoardSeatSlug } from '@/app/board/boardWorkspaceConfig';

/**
 * The roster read carries the appointment and nothing else about the person --
 * no email, no auth provider, no athlete identifier. A governance roster is not
 * a directory of personal data, so an account id is the identity here.
 */
interface SeatHolder {
  seat: string;
  account_id: string;
  is_primary: boolean;
  assigned_at: string | null;
}

interface DirectoryMember {
  account_id: string;
  login_email: string | null;
  role: string;
}

/** How a new holder joins a seat: outright, or alongside whoever holds it. */
type AssignmentKind = 'primary' | 'additional';

const SEATS_ENDPOINT = '/api/pilot/board/seats';
const PRESIDENT_SEAT = 'president';

const ASSIGNMENT_KINDS: Array<{ value: AssignmentKind; label: string; blurb: string }> = [
  {
    value: 'primary',
    label: 'Holds the seat',
    blurb: 'The officer of record. A seat has exactly one, and the database refuses a second.',
  },
  {
    value: 'additional',
    label: 'Additional holder',
    blurb: 'A co-chair, a successor shadowing an outgoing officer, or someone covering an absence. A seat may carry any number.',
  },
];

function normalizeHolders(raw: unknown): SeatHolder[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.seat !== 'string' || typeof record.account_id !== 'string') return [];
    return [{
      seat: record.seat,
      account_id: record.account_id,
      is_primary: record.is_primary === true,
      assigned_at: typeof record.assigned_at === 'string' ? record.assigned_at : null,
    }];
  });
}

function normalizeMembers(raw: unknown): DirectoryMember[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.account_id !== 'string') return [];
    return [{
      account_id: record.account_id,
      login_email: typeof record.login_email === 'string' ? record.login_email : null,
      role: typeof record.role === 'string' ? record.role : '',
    }];
  });
}

async function readError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  return payload.error || fallback;
}

function seatLabelFor(slug: string): string {
  return boardSeatConfigs.find((config) => config.slug === slug)?.seatLabel ?? slug;
}

function BoardSeatsConsole() {
  const session = usePilotSession();
  const [holders, setHolders] = useState<SeatHolder[]>([]);
  const [members, setMembers] = useState<DirectoryMember[]>([]);
  const [directoryAvailable, setDirectoryAvailable] = useState(false);
  const [organizationId, setOrganizationId] = useState('');
  const [loading, setLoading] = useState(true);
  const [rosterAvailable, setRosterAvailable] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [draftSeat, setDraftSeat] = useState<BoardSeatSlug>(boardSeatConfigs[0].slug);
  const [draftAccountId, setDraftAccountId] = useState('');
  const [draftKind, setDraftKind] = useState<AssignmentKind>('primary');

  const load = useCallback(async () => {
    setError('');
    try {
      const response = await fetch(`${apiBase()}${SEATS_ENDPOINT}`, {
        method: 'GET',
        credentials: 'include',
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        holders?: unknown;
        organization_id?: string;
        error?: string;
      };

      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || 'Unable to load the board roster');
      }

      setHolders(normalizeHolders(payload.holders));
      setOrganizationId(payload.organization_id || '');
      setRosterAvailable(true);

      // The roster names accounts, not people. The organization directory is
      // what turns an account id back into someone an admin recognises, and it
      // is readable only by an admin -- so the President gets a typed account
      // id instead, and can still seat anyone.
      const directoryResponse = await fetch(`${apiBase()}/api/pilot/admin/staff`, {
        method: 'GET',
        credentials: 'include',
      });
      const directoryPayload = (await directoryResponse.json().catch(() => ({}))) as {
        ok?: boolean;
        members?: unknown;
      };
      if (directoryResponse.ok && directoryPayload.ok !== false) {
        setMembers(normalizeMembers(directoryPayload.members));
        setDirectoryAvailable(true);
      } else {
        setDirectoryAvailable(false);
      }
    } catch (loadError) {
      setRosterAvailable(false);
      setError(loadError instanceof Error ? loadError.message : 'Unable to load the board roster');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const memberLabels = useMemo(
    () => new Map(members.map((member) => [member.account_id, member.login_email || member.account_id])),
    [members],
  );

  const nameFor = useCallback(
    (accountId: string) => memberLabels.get(accountId) ?? accountId,
    [memberLabels],
  );

  const seatRoster = useMemo(
    () => boardSeatConfigs.map((config) => {
      const seated = holders.filter((holder) => holder.seat === config.slug);
      return {
        config,
        primary: seated.find((holder) => holder.is_primary) ?? null,
        additional: seated.filter((holder) => !holder.is_primary),
      };
    }),
    [holders],
  );

  // The same rule the server enforces in assertCanManageBoardSeats: the
  // organization's administrators, and whoever holds the President seat
  // outright. Computing it here decides what is worth showing; it is never what
  // stops a write, which the server refuses on its own reading of the seat.
  const presidentAccountId = holders.find(
    (holder) => holder.seat === PRESIDENT_SEAT && holder.is_primary,
  )?.account_id ?? null;
  const canManage = isOrganizationAdminSessionRole(session.role)
    || (session.role === 'board'
      && Boolean(session.accountId)
      && presidentAccountId === session.accountId);

  // Board accounts first: they are who a seat is given to, and the server
  // refuses an account that is not an active board member of this gym.
  const memberOptions = useMemo(() => {
    const boardMembers = members.filter((member) => member.role === 'board');
    const others = members.filter((member) => member.role !== 'board');
    return [...boardMembers, ...others];
  }, [members]);

  const filledSeatCount = seatRoster.filter((row) => row.primary).length;
  const draftSeatRow = seatRoster.find((row) => row.config.slug === draftSeat);
  const currentPrimary = draftSeatRow?.primary ?? null;
  const trimmedAccountId = draftAccountId.trim();
  const alreadyOnSeat = draftSeatRow
    ? [...(draftSeatRow.primary ? [draftSeatRow.primary] : []), ...draftSeatRow.additional]
      .some((holder) => holder.account_id === trimmedAccountId)
    : false;

  // The occupied-seat case, named before the request is sent. The database
  // refuses a second primary outright, and a bare rejection would not tell the
  // admin the one thing they need: who is in the seat right now.
  const primaryConflict = Boolean(
    draftKind === 'primary'
    && currentPrimary
    && trimmedAccountId
    && currentPrimary.account_id !== trimmedAccountId,
  );

  const canSubmit = Boolean(trimmedAccountId) && !alreadyOnSeat && !primaryConflict && canManage;

  async function request(
    method: 'POST' | 'PATCH' | 'DELETE',
    body: { seat: string; account_id: string; is_primary?: boolean },
    failureMessage: string,
  ) {
    const url = method === 'DELETE'
      ? `${apiBase()}${SEATS_ENDPOINT}?seat=${encodeURIComponent(body.seat)}&account_id=${encodeURIComponent(body.account_id)}`
      : `${apiBase()}${SEATS_ENDPOINT}`;

    const response = await fetch(url, {
      method,
      credentials: 'include',
      ...(method === 'DELETE'
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      throw new Error(await readError(response, failureMessage));
    }

    const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (payload.ok === false) {
      throw new Error(payload.error || failureMessage);
    }
  }

  async function run(work: () => Promise<string>, failureMessage: string): Promise<boolean> {
    setBusy(true);
    setError('');
    setNotice('');

    try {
      const message = await work();
      await load();
      setNotice(message);
      return true;
    } catch (workError) {
      // The roster may have moved under this action -- a 409 means someone else
      // took the seat -- so re-read before reporting, or the message names a
      // holder who is no longer there.
      await load();
      setError(workError instanceof Error ? workError.message : failureMessage);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function assign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }

    const isPrimary = draftKind === 'primary';
    const saved = await run(async () => {
      await request(
        'POST',
        { seat: draftSeat, account_id: trimmedAccountId, is_primary: isPrimary },
        'Could not record that seat assignment',
      );
      return isPrimary
        ? `${nameFor(trimmedAccountId)} now holds ${seatLabelFor(draftSeat)}.`
        : `${nameFor(trimmedAccountId)} was added to ${seatLabelFor(draftSeat)} as an additional holder.`;
    }, 'Could not record that seat assignment');

    if (saved) {
      setDraftAccountId('');
    }
  }

  /**
   * The handover. Promotion changes who holds a seat outright and does not seat
   * someone new, so an incoming holder from outside the seat joins it first --
   * and if the promotion then fails, they are visibly an additional holder
   * rather than having vanished.
   */
  async function handOver(seat: string, accountId: string, alreadySeated: boolean) {
    const saved = await run(async () => {
      if (!alreadySeated) {
        await request(
          'POST',
          { seat, account_id: accountId, is_primary: false },
          'Could not add that member to the seat',
        );
      }
      await request(
        'PATCH',
        { seat, account_id: accountId },
        'Could not hand that seat over',
      );
      return `${nameFor(accountId)} now holds ${seatLabelFor(seat)}.`;
    }, 'Could not hand that seat over');

    if (saved) {
      setDraftAccountId('');
    }
  }

  async function remove(seat: string, accountId: string) {
    await run(async () => {
      await request(
        'DELETE',
        { seat, account_id: accountId },
        'Could not remove that seat assignment',
      );
      return `${nameFor(accountId)} was removed from ${seatLabelFor(seat)}.`;
    }, 'Could not remove that seat assignment');
  }

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] px-4 py-8 text-[var(--black)] sm:px-6">
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <header className="rounded-2xl border border-[rgba(0,0,0,0.16)] bg-white p-6 shadow-[var(--shadow-md)]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--red-primary)]">Governance</p>
              <h1 className="mt-2 font-display text-3xl font-black tracking-tight">Board Seats</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--gray-dark)]">
                Who holds each of the eight governing seats. {filledSeatCount} of {boardSeatConfigs.length} filled.
                {organizationId && (
                  <>
                    {' '}Gym: <span className="font-mono font-semibold text-[var(--black)]">{organizationId}</span>
                  </>
                )}
              </p>
            </div>
            <Link
              href="/admin"
              className="inline-flex min-h-[44px] items-center rounded-full border border-[rgba(0,0,0,0.14)] bg-white px-5 text-sm font-bold uppercase tracking-[0.1em] transition hover:bg-[var(--canvas-tan)]"
            >
              Admin Home
            </Link>
          </div>
        </header>

        {error && (
          <p role="alert" className="rounded-xl border border-[var(--red-primary)] bg-[rgba(184,59,52,0.06)] px-4 py-3 text-sm font-semibold text-[var(--red-primary)]">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-xl border border-[rgba(16,120,40,0.5)] bg-[rgba(16,120,40,0.08)] px-4 py-3 text-sm font-semibold text-[#1b5e20]">
            {notice}
          </p>
        )}

        {rosterAvailable && !canManage && (
          <p className="rounded-xl border border-[rgba(0,0,0,0.14)] bg-white px-4 py-3 text-sm leading-6 text-[var(--gray-dark)]">
            You can see the roster but not change it. Seats are assigned by a gym admin, or by the board member holding
            the President seat.
          </p>
        )}

        <section className="overflow-hidden rounded-2xl border border-[rgba(0,0,0,0.14)] bg-white shadow-[var(--shadow-sm)]">
          {loading ? (
            <p className="p-6 text-sm text-[var(--gray-dark)]">Loading the board roster...</p>
          ) : (
            <ul className="divide-y divide-[rgba(0,0,0,0.08)]">
              {seatRoster.map(({ config, primary, additional }) => (
                <li key={config.slug} className="px-4 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{config.seatLabel}</p>
                      {primary ? (
                        <p className="mt-1 text-sm">
                          <span className="font-mono">{nameFor(primary.account_id)}</span>
                          <span className="ml-2 text-xs font-bold uppercase tracking-[0.1em] text-[#1b5e20]">Holds the seat</span>
                        </p>
                      ) : (
                        <p className="mt-1 text-xs font-bold uppercase tracking-[0.1em] text-[var(--red-primary)]">
                          Unfilled
                        </p>
                      )}
                    </div>

                    {primary && canManage && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void remove(config.slug, primary.account_id)}
                        className="min-h-[44px] shrink-0 rounded-xl border-2 border-[var(--red-primary)] bg-white px-3 text-xs font-black uppercase tracking-[0.1em] text-[var(--red-primary)] disabled:opacity-50"
                      >
                        Remove
                      </button>
                    )}
                  </div>

                  {additional.length > 0 && (
                    <ul className="mt-3 space-y-2 border-l-2 border-[rgba(0,0,0,0.1)] pl-3">
                      {additional.map((holder) => (
                        <li key={holder.account_id} className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm text-[var(--gray-dark)]">
                            <span className="font-mono">{nameFor(holder.account_id)}</span>
                            <span className="ml-2 text-xs uppercase tracking-[0.1em]">Additional holder</span>
                          </p>
                          {canManage && (
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void handOver(config.slug, holder.account_id, true)}
                                className="min-h-[44px] rounded-xl border border-[rgba(0,0,0,0.16)] bg-white px-3 text-xs font-bold uppercase tracking-[0.1em] disabled:opacity-50"
                              >
                                {primary ? 'Hand Seat Over' : 'Give The Seat'}
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void remove(config.slug, holder.account_id)}
                                className="min-h-[44px] rounded-xl border border-[var(--red-primary)] bg-white px-3 text-xs font-bold uppercase tracking-[0.1em] text-[var(--red-primary)] disabled:opacity-50"
                              >
                                Remove
                              </button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {canManage && (
          <form onSubmit={assign} className="space-y-5 rounded-2xl border border-[rgba(0,0,0,0.14)] bg-white p-6 shadow-[var(--shadow-sm)]">
            <div>
              <h2 className="text-lg font-black">Assign a seat</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                A seat has one officer of record and any number of additional holders. Seats carry governance
                responsibility only — nothing here changes what a board member can see, which stays gym-wide figures.
              </p>
            </div>

            <div>
              <label htmlFor="seat" className="block text-sm font-semibold">Seat</label>
              <select
                id="seat"
                value={draftSeat}
                onChange={(event) => setDraftSeat(event.target.value as BoardSeatSlug)}
                className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus:border-[var(--red-primary)] focus:outline-none focus:ring-2 focus:ring-[rgba(184,59,52,0.2)]"
              >
                {seatRoster.map(({ config, primary }) => (
                  <option key={config.slug} value={config.slug}>
                    {config.seatLabel}{primary ? ` — held by ${nameFor(primary.account_id)}` : ' — unfilled'}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="member" className="block text-sm font-semibold">Member</label>
              {directoryAvailable ? (
                <select
                  id="member"
                  required
                  value={draftAccountId}
                  onChange={(event) => setDraftAccountId(event.target.value)}
                  className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus:border-[var(--red-primary)] focus:outline-none focus:ring-2 focus:ring-[rgba(184,59,52,0.2)]"
                >
                  <option value="">Choose a member...</option>
                  {memberOptions.map((member) => (
                    <option key={member.account_id} value={member.account_id}>
                      {member.login_email || member.account_id}
                      {member.role && member.role !== 'board' ? ` (${member.role})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <p className="mt-1 text-xs text-[var(--gray-dark)]">
                    Type the sign-in ID of the board member taking the seat.
                  </p>
                  <input
                    id="member"
                    type="text"
                    required
                    value={draftAccountId}
                    onChange={(event) => setDraftAccountId(event.target.value.trim())}
                    placeholder="dana"
                    className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 font-mono focus:border-[var(--red-primary)] focus:outline-none focus:ring-2 focus:ring-[rgba(184,59,52,0.2)]"
                  />
                </>
              )}
              <p className="mt-2 text-xs text-[var(--gray-dark)]">
                Only an active board member of this gym can be seated. Someone new to the board gets their account on
                the People page first.
              </p>
              {alreadyOnSeat && (
                <p className="mt-2 rounded-xl border border-[rgba(0,0,0,0.16)] bg-[var(--canvas-tan-light)] px-3 py-2 text-xs font-semibold">
                  {nameFor(trimmedAccountId)} is already on {seatLabelFor(draftSeat)}. Use the buttons on that seat to
                  change how they hold it.
                </p>
              )}
            </div>

            <fieldset>
              <legend className="text-sm font-semibold">How do they hold it?</legend>
              <div className="mt-2 space-y-2">
                {ASSIGNMENT_KINDS.map((option) => (
                  <label
                    key={option.value}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${
                      draftKind === option.value
                        ? 'border-[var(--red-primary)] bg-[rgba(184,59,52,0.05)]'
                        : 'border-[rgba(0,0,0,0.12)] hover:border-[rgba(0,0,0,0.3)]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="assignment-kind"
                      value={option.value}
                      checked={draftKind === option.value}
                      onChange={() => setDraftKind(option.value)}
                      className="mt-1 accent-[var(--red-primary)]"
                    />
                    <span>
                      <span className="block text-sm font-semibold">{option.label}</span>
                      <span className="mt-0.5 block text-xs text-[var(--gray-dark)]">{option.blurb}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {primaryConflict && currentPrimary && (
              <div role="alert" className="space-y-3 rounded-xl border-2 border-[var(--red-primary)] bg-[rgba(184,59,52,0.06)] p-4">
                <p className="text-sm font-semibold text-[var(--red-primary)]">
                  {seatLabelFor(draftSeat)} is held by {nameFor(currentPrimary.account_id)}. A seat has one officer of
                  record, so this cannot be a second — choose which one you meant.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handOver(draftSeat, trimmedAccountId, false)}
                    className="min-h-[44px] rounded-xl border-2 border-[var(--red-primary)] bg-[var(--red-primary)] px-4 text-xs font-black uppercase tracking-[0.1em] text-white disabled:opacity-50"
                  >
                    Hand The Seat Over
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setDraftKind('additional')}
                    className="min-h-[44px] rounded-xl border border-[rgba(0,0,0,0.16)] bg-white px-4 text-xs font-bold uppercase tracking-[0.1em] disabled:opacity-50"
                  >
                    Add As Additional Holder
                  </button>
                </div>
                <p className="text-xs leading-5 text-[var(--gray-dark)]">
                  Handing the seat over steps {nameFor(currentPrimary.account_id)} back to an additional holder in the
                  same action, so the seat is never held by two people at once.
                </p>
              </div>
            )}

            <button
              type="submit"
              disabled={busy || !canSubmit}
              className="min-h-[50px] w-full rounded-xl border-2 border-[var(--red-primary)] bg-[var(--red-primary)] px-4 text-sm font-black uppercase tracking-[0.14em] text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Saving...' : 'Assign Seat'}
            </button>
          </form>
        )}

        {/* The one thing a governance surface must not imply. */}
        <p className="rounded-2xl border border-[rgba(0,0,0,0.12)] bg-white px-5 py-4 text-xs leading-5 text-[var(--gray-dark)]">
          A board seat records an adult board member&apos;s appointment. It carries no athlete record and grants no
          access to one: the board role sees gym-wide figures, and any figure covering fewer than five athletes is
          withheld rather than shown.
        </p>

        {session.role === 'board' && (
          <div>
            <Link
              href="/board"
              className="inline-flex min-h-[44px] items-center rounded-full border border-[rgba(0,0,0,0.14)] bg-white px-5 text-sm font-bold uppercase tracking-[0.1em] transition hover:bg-[var(--canvas-tan)]"
            >
              Board Workspace
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}

export default function BoardSeatsPage() {
  return (
    <RoleSessionGate allowedRoles={['admin', 'board']}>
      <BoardSeatsConsole />
    </RoleSessionGate>
  );
}
