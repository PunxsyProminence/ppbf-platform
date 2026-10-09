'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymDateTimeShort } from '@/src/lib/gymTime';
import type { GymTvListItem, MintedPairCode } from '@/src/server/pilot/gymTvs';

/**
 * Gym TVs -- the coach dashboard's paired-TV capability (Jason, 2026-10-06:
 * "it should be a capability in the coaches dashboard"). Pair a TV by name,
 * read the code once, see every TV the gym has paired, disconnect one, and
 * put the coach's own live session on one or take it off.
 *
 * Every rule is the server's; this panel only shows the answer. Shared gym
 * TVs: any coach may pair, disconnect or choose any TV (Jason "A"), one
 * session per TV, and a TV showing ANOTHER coach's live session refuses with
 * TV_IN_USE (O17b: coaches refuse each other; the admin take-off is the next
 * PR and lives in the module, not here).
 *
 * Reads nothing until a coach opens it: the dashboard already makes a dozen
 * reads on mount, and a TV list is a thing a coach looks for, not a thing
 * that must be in front of them. Once open, the rows stay on screen while a
 * re-read is in flight, so a refusal written under a TV is not wiped by the
 * re-read it triggers.
 *
 * data-surface="kiosk" on the root: Law 5 -- a coach uses this from a floor
 * tablet, so every control takes the 55px floor and the text sits at
 * --t-md (19.1px). Every refusal is written on screen beside a glyph, never
 * colour alone (Law 3).
 */

export interface GymTvPanelLiveRun {
  run_id: string;
  show_on_wall: boolean;
}

interface GymTvPanelProps {
  /** The coach's own live session, if any; the dashboard reads it. */
  readonly liveRun: GymTvPanelLiveRun | null;
  /**
   * False while the dashboard has not read the live run, or could not. A
   * null liveRun then means "unknown", not "none", and the panel says so
   * instead of telling the coach to start a session (CoachWorkspace's own
   * rule: a failed check must never read as "no session is running").
   */
  readonly liveRunKnown: boolean;
  /** The signed-in coach's account id, so "your session" is said honestly. Empty when unknown. */
  readonly coachAccountId: string;
  /** Called when the server says the run the dashboard holds is no longer live, so it re-reads it. */
  readonly onRunStale?: () => void | Promise<void>;
}

type ListState = 'closed' | 'loading' | 'loaded' | 'unavailable';

/** Server refusal codes this panel names in plain words. Anything else is shown as the code. */
const REFUSALS: Record<string, string> = {
  TV_IN_USE: 'This TV is in use by another coach. Ask them, or pick another TV.',
  TV_NOT_PAIRED: 'This TV is not paired yet. Type its code on the TV first.',
  TV_NOT_FOUND: 'This TV is no longer listed. Refresh the list.',
  SESSION_RUN_NOT_ON_TV: 'Switch "Show on TV" on for your session first, then send it.',
  SESSION_RUN_NOT_LIVE: 'Your session is no longer live, so it cannot go on a TV.',
  SESSION_RUN_NOT_FOUND: 'Your session could not be found. Reload the dashboard.',
  TV_NAME_REQUIRED: 'Give the TV a name first.',
  TV_NAME_LENGTH: 'The TV name must be 1 to 60 characters.',
  TV_PAIR_CODE_RATE_LIMITED: 'Too many codes in the last 10 minutes. Wait, then try again.',
};

/** The codes a refused send/take-off answers when the run the dashboard holds has gone. */
const RUN_STALE_CODES = new Set(['SESSION_RUN_NOT_LIVE', 'SESSION_RUN_NOT_FOUND']);

export function describeRefusal(code: string | undefined, status: number): string {
  if (code && REFUSALS[code]) return REFUSALS[code];
  // Sign-in and role refusals come from the shared http layer as 'Unauthorized...' / 'Forbidden',
  // not as a GymTvError code; the status is the reliable key.
  if (status === 401) return 'Your sign-in has expired. Sign in again, then retry.';
  if (status === 403) return 'Your account is not allowed to manage gym TVs.';
  if (code && code.trim() !== '') return `The server refused: ${code}`;
  return `The server refused the request (${status}).`;
}

const STATUS_LABEL: Record<GymTvListItem['status'], { glyph: string; label: string; badge: string }> = {
  paired: { glyph: '✓', label: 'PAIRED', badge: 'badge badge--cleared' },
  pending: { glyph: '◉', label: 'WAITING FOR CODE', badge: 'badge badge--monitor' },
  expired: { glyph: '▲', label: 'CODE EXPIRED', badge: 'badge badge--restricted' },
  disconnected: { glyph: '✕', label: 'DISCONNECTED', badge: 'badge badge--filed' },
};
const UNKNOWN_STATUS = { glyph: '◌', label: 'UNKNOWN STATE', badge: 'badge badge--filed' };

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as unknown;
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export default function GymTvPanel({ liveRun, liveRunKnown, coachAccountId, onRunStale }: GymTvPanelProps) {
  const [listState, setListState] = useState<ListState>('closed');
  const [refreshing, setRefreshing] = useState(false);
  const [tvs, setTvs] = useState<GymTvListItem[]>([]);

  const [tvName, setTvName] = useState('');
  const [mintBusy, setMintBusy] = useState(false);
  const [mintError, setMintError] = useState('');
  const [minted, setMinted] = useState<MintedPairCode | null>(null);

  /** The one TV an action is in flight for; every control waits on it. */
  const [busyTvId, setBusyTvId] = useState<string | null>(null);
  const [confirmDisconnectId, setConfirmDisconnectId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ tvId: string; tvName: string; text: string } | null>(null);

  // Synchronous locks beside the rendered `disabled`: two events in one tick cannot both pass.
  const mintLock = useRef(false);
  const actionLock = useRef(false);
  // Declared before the live-run effect below so this sync runs first.
  const listStateRef = useRef<ListState>('closed');
  useEffect(() => {
    listStateRef.current = listState;
  }, [listState]);

  const loadTvs = useCallback(async (): Promise<void> => {
    // The first read shows "Reading..."; later reads keep the rows on screen.
    if (listStateRef.current === 'loaded') setRefreshing(true);
    else setListState('loading');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/gym-tvs`, { credentials: 'include' });
      const payload = await readJson(response);
      if (!response.ok || !Array.isArray(payload.tvs)) {
        setTvs([]);
        setListState('unavailable');
        return;
      }
      setTvs(payload.tvs as GymTvListItem[]);
      setListState('loaded');
    } catch {
      setTvs([]);
      setListState('unavailable');
    } finally {
      setRefreshing(false);
    }
  }, []);

  // The live run changed under an open list (ended, switched off, started): the rows' "showing"
  // lines are about that run, so re-read them rather than compare stale rows with a new run.
  const liveRunKey = liveRun ? `${liveRun.run_id}:${liveRun.show_on_wall}` : liveRunKnown ? 'none' : 'unknown';
  const previousRunKey = useRef(liveRunKey);
  useEffect(() => {
    if (previousRunKey.current === liveRunKey) return;
    previousRunKey.current = liveRunKey;
    if (listStateRef.current !== 'closed') void loadTvs();
  }, [liveRunKey, loadTvs]);

  const mintCode = useCallback(async (): Promise<void> => {
    if (mintLock.current) return;
    mintLock.current = true;
    setMintBusy(true);
    setMintError('');
    try {
      let response: Response;
      try {
        response = await fetch(`${apiBase()}/api/pilot/gym-tvs`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tv_name: tvName }),
        });
      } catch {
        setMintError(
          'Network error -- could not confirm whether a code was made. Refresh the list: a TV waiting for a code means it was, and its code is lost; make a new one.',
        );
        return;
      }
      const payload = await readJson(response);
      if (!response.ok) {
        setMintError(describeRefusal(typeof payload.error === 'string' ? payload.error : undefined, response.status));
        return;
      }
      const tv = payload.tv as MintedPairCode | undefined;
      if (!tv || typeof tv.code !== 'string') {
        setMintError('The server answered without a code. Refresh the list and make a new one.');
        return;
      }
      setMinted(tv);
      setTvName('');
      await loadTvs();
    } finally {
      mintLock.current = false;
      setMintBusy(false);
    }
  }, [tvName, loadTvs]);

  /**
   * One shape for the three per-TV actions. The server's answer (the TV's
   * row) replaces the row shown; a refusal is written under that TV, and the
   * list is re-read because a refusal usually means it was stale.
   */
  const actOnTv = useCallback(
    async (tv: GymTvListItem, path: string, init: RequestInit): Promise<void> => {
      if (actionLock.current) return;
      actionLock.current = true;
      setBusyTvId(tv.tv_id);
      setActionError(null);
      try {
        let response: Response;
        try {
          response = await fetch(`${apiBase()}/api/pilot/gym-tvs/${encodeURIComponent(tv.tv_id)}${path}`, {
            credentials: 'include',
            ...init,
          });
        } catch {
          setActionError({
            tvId: tv.tv_id,
            tvName: tv.tv_name,
            text: 'Network error -- could not confirm whether it went through. The list below has been re-read; check it.',
          });
          await loadTvs();
          return;
        }
        const payload = await readJson(response);
        if (!response.ok) {
          const code = typeof payload.error === 'string' ? payload.error : undefined;
          setActionError({ tvId: tv.tv_id, tvName: tv.tv_name, text: describeRefusal(code, response.status) });
          if (code && RUN_STALE_CODES.has(code) && onRunStale) await onRunStale();
          await loadTvs();
          return;
        }
        const updated = payload.tv as GymTvListItem | undefined;
        if (updated && typeof updated.tv_id === 'string') {
          setTvs((current) => current.map((row) => (row.tv_id === updated.tv_id ? updated : row)));
        } else {
          await loadTvs();
        }
      } finally {
        actionLock.current = false;
        setBusyTvId(null);
        setConfirmDisconnectId((current) => (current === tv.tv_id ? null : current));
      }
    },
    [loadTvs, onRunStale],
  );

  const sendToTv = (tv: GymTvListItem) => {
    if (!liveRun) return;
    void actOnTv(tv, '/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: liveRun.run_id }),
    });
  };
  const takeOffTv = (tv: GymTvListItem) => void actOnTv(tv, '/session', { method: 'DELETE' });
  const disconnectTv = (tv: GymTvListItem) => void actOnTv(tv, '/disconnect', { method: 'POST' });

  /** What a paired TV is showing, said only as far as this panel can know it. */
  const sessionLine = (tv: GymTvListItem): { glyph: string; text: string; mine: boolean } => {
    if (!tv.current_run_id) return { glyph: '—', text: 'Showing nothing', mine: false };
    if (liveRun && tv.current_run_id === liveRun.run_id) return { glyph: '✓', text: 'Showing your session', mine: true };
    if (!coachAccountId) return { glyph: '◉', text: 'Showing a live session', mine: false };
    if (tv.current_run_set_by_account_id === coachAccountId) {
      return { glyph: '◉', text: 'Showing a session you sent', mine: true };
    }
    return { glyph: '◉', text: "Showing another coach's session", mine: false };
  };

  const errorIsOrphaned = actionError !== null && !tvs.some((tv) => tv.tv_id === actionError.tvId);

  return (
    <section
      data-surface="kiosk"
      aria-labelledby="gym-tvs-heading"
      className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s5)] space-y-[var(--s4)] text-[length:var(--t-md)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
        <h3 id="gym-tvs-heading" className="t-eyebrow">Gym TVs</h3>
        {listState === 'closed' ? (
          <button type="button" onClick={() => void loadTvs()} className="btn btn--ghost">
            Open Gym TVs
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void loadTvs()}
            disabled={listState === 'loading' || refreshing}
            className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
          >
            {refreshing ? 'Refreshing...' : 'Refresh the list'}
          </button>
        )}
      </div>

      {listState === 'closed' && (
        <p className="text-[color:var(--bone-300)]">
          Pair the gym&apos;s TVs, see which are connected, and put your live session on one.
        </p>
      )}

      {listState !== 'closed' && (
        <>
          {/* Pair a new TV. The code is shown ONCE, here; the server never returns it again. */}
          <div className="space-y-[var(--s3)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
            <p className="t-label block">Pair a new TV</p>
            <div className="flex flex-wrap items-end gap-[var(--s3)]">
              <label className="flex flex-col gap-[var(--s2)]">
                <span className="t-label">TV name</span>
                <input
                  type="text"
                  value={tvName}
                  maxLength={60}
                  placeholder="e.g. Ring wall TV"
                  onChange={(event) => {
                    setTvName(event.target.value);
                    setMintError('');
                  }}
                  disabled={mintBusy}
                  className="input w-[18rem] max-w-full"
                />
              </label>
              <button
                type="button"
                onClick={() => void mintCode()}
                disabled={mintBusy || tvName.trim() === ''}
                className="btn disabled:cursor-not-allowed disabled:opacity-60"
              >
                {mintBusy ? 'Making a code...' : 'Make a pairing code'}
              </button>
            </div>
            {mintError && (
              <p role="alert" className="font-semibold text-[var(--restricted-ink)]">
                <span aria-hidden="true">▲ </span>{mintError}
              </p>
            )}
            {minted && (
              <div
                role="group"
                aria-label={`Pairing code for ${minted.tv_name}: ${minted.code.split('').join(' ')}`}
                className="space-y-[var(--s2)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-400)] p-[var(--s4)]"
              >
                <p className="font-semibold">Code for {minted.tv_name}</p>
                <p className="t-data text-[length:var(--t-2xl)] tracking-[.3em]" aria-hidden="true">
                  {minted.code}
                </p>
                <p>
                  Type this code on the TV&apos;s pairing screen. It works until{' '}
                  {formatGymDateTimeShort(minted.expires_at) ?? minted.expires_at} and is shown only this once:
                  stay on this screen until the TV is paired.
                </p>
                <button type="button" onClick={() => setMinted(null)} className="btn btn--ghost">
                  Done, hide the code
                </button>
              </div>
            )}
          </div>

          {listState === 'loading' && <p className="t-muted">Reading the gym&apos;s TVs...</p>}

          {listState === 'unavailable' && (
            <div className="rounded-[var(--r-md)] border-2 border-[var(--restricted)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
              <p role="alert" className="font-semibold text-[var(--restricted-ink)]">
                <span aria-hidden="true">▲ </span>The TV list could not be read. TVs may be paired that are not shown here.
              </p>
            </div>
          )}

          {/* A refusal whose TV is no longer in the list (or the list could not be re-read) is
              still the coach's answer; it sits here rather than vanishing with its row. */}
          {actionError && errorIsOrphaned && (
            <p role="alert" className="font-semibold text-[var(--restricted-ink)]">
              <span aria-hidden="true">▲ </span>{actionError.tvName}: {actionError.text}
            </p>
          )}

          {listState === 'loaded' && tvs.length === 0 && <p className="t-muted">No TV has been paired yet.</p>}

          {listState === 'loaded' && tvs.length > 0 && (
            <ul className="space-y-[var(--s3)]" aria-label="Paired TVs">
              {tvs.map((tv) => {
                const status = STATUS_LABEL[tv.status] ?? UNKNOWN_STATUS;
                const session = sessionLine(tv);
                const busy = busyTvId === tv.tv_id;
                const anyBusy = busyTvId !== null;
                const usable = tv.status === 'paired';
                const error = actionError && actionError.tvId === tv.tv_id ? actionError.text : '';
                return (
                  <li
                    key={tv.tv_id}
                    className="space-y-[var(--s3)] rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]"
                  >
                    <div className="flex flex-wrap items-center gap-[var(--s3)]">
                      <p className="font-semibold">{tv.tv_name}</p>
                      <span className={status.badge}><i aria-hidden="true">{status.glyph}</i>{status.label}</span>
                    </div>
                    <p className="t-muted">
                      Last seen: {tv.last_seen_at ? formatGymDateTimeShort(tv.last_seen_at) ?? tv.last_seen_at : 'never'}
                    </p>
                    {usable && (
                      <p>
                        <span aria-hidden="true">{session.glyph} </span>{session.text}
                      </p>
                    )}

                    {tv.status !== 'disconnected' && (
                      <div className="flex flex-wrap items-center gap-[var(--s3)]">
                        {usable && liveRun && !session.mine && (
                          <button
                            type="button"
                            onClick={() => sendToTv(tv)}
                            disabled={anyBusy}
                            className="btn disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {busy ? 'Sending...' : `Send to TV ${tv.tv_name}`}
                          </button>
                        )}
                        {usable && session.mine && (
                          <button
                            type="button"
                            onClick={() => takeOffTv(tv)}
                            disabled={anyBusy}
                            className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {busy ? 'Taking off...' : `Take off TV ${tv.tv_name}`}
                          </button>
                        )}
                        {confirmDisconnectId !== tv.tv_id && (
                          <button
                            type="button"
                            onClick={() => {
                              setActionError(null);
                              setConfirmDisconnectId(tv.tv_id);
                            }}
                            disabled={anyBusy}
                            className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Disconnect {tv.tv_name}
                          </button>
                        )}
                      </div>
                    )}

                    {confirmDisconnectId === tv.tv_id && (
                      <div className="space-y-[var(--s2)] rounded-[var(--r-md)] border-2 border-[var(--restricted)] p-[var(--s3)]">
                        <p className="font-semibold">
                          Disconnect {tv.tv_name}? It stops showing anything now
                          {tv.current_run_id && !session.mine ? ", including the session another coach has on it," : ''}
                          {' '}and must be paired again with a new code.
                        </p>
                        <div className="flex flex-wrap gap-[var(--s3)]">
                          <button
                            type="button"
                            onClick={() => disconnectTv(tv)}
                            disabled={anyBusy}
                            className="btn disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {busy ? 'Disconnecting...' : 'Yes, disconnect it'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDisconnectId(null)}
                            disabled={anyBusy}
                            className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Keep it connected
                          </button>
                        </div>
                      </div>
                    )}

                    {error && (
                      <p role="alert" className="font-semibold text-[var(--restricted-ink)]">
                        <span aria-hidden="true">▲ </span>{error}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {listState === 'loaded' && !liveRunKnown && (
            <p className="t-muted">
              Whether you have a session in progress could not be checked, so nothing can be sent from here yet.
            </p>
          )}
          {listState === 'loaded' && liveRunKnown && !liveRun && (
            <p className="t-muted">Start a session to send it to a TV.</p>
          )}
          {listState === 'loaded' && liveRun && !liveRun.show_on_wall && (
            <p className="t-muted">
              Your session&apos;s &quot;Show on TV&quot; switch is off. Switch it on under Today&apos;s Session before sending.
            </p>
          )}
        </>
      )}
    </section>
  );
}
