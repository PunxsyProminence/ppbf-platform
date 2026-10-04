'use client';

import { useCallback, useState } from 'react';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric } from '@/src/lib/gymTime';
import { ADULT_PATHWAY_STAGES } from '@/src/shared/adultPathwayStages';

// One athlete's place on the adult pathway (map item 17, B2b), rendered closed
// inside each roster row of /coach/adult-pathway; it reads nothing until a
// coach opens it.
//
// COACH-SET, NEVER APP-MADE (OD-2026-10-04-002). The stage is what a coach
// picks; ticking every goal of a stage moves nobody. Minors and athletes with
// no date of birth need the allowance, with a reason (OD-2026-10-04-010);
// switching it off ends their stage (OD-2026-10-04-018); a placed athlete who
// stops being eligible is flagged and frozen (Jason 2026-10-04, "A) Flag and
// freeze"). Every rule is enforced by the server -- this panel sends what the
// coach chose and shows what the server answers, including its refusals.
//
// Wording approved by Jason 2026-10-04 ("Approve (Recommended)").

interface Placement {
  placement_id: string;
  stage_key: string;
  set_by_name: string | null;
  set_at: string;
}
interface Checkpoint {
  stage_key: string;
  goal_key: string;
  confirmed_by_name: string | null;
  confirmed_at: string;
}
interface Allowance {
  reason: string;
  granted_by_name: string | null;
  granted_at: string;
}
interface PathwayReading {
  eligibility: { eligible: boolean; basis: string };
  allowance: Allowance | null;
  current: Placement | null;
  checkpoints: Checkpoint[];
}

type Reading =
  | { state: 'closed' }
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'loaded'; data: PathwayReading };

export const NOT_ELIGIBLE_FLAG =
  'Placed, but not eligible: this athlete is under 18 (or has no date of birth on file) and the adult-pathway '
  + 'allowance is off. Nothing new can be set or ticked until a coach switches it on.';
export const SWITCH_OFF_WARNING =
  "Switching off ends this athlete's current stage. Their history and ticked goals are kept.";

const ENDPOINT = '/api/pilot/coach/adult-pathway';

export default function AdultPathwayPanel({ athleteId, athleteName }: { athleteId: string; athleteName: string }) {
  const [reading, setReading] = useState<Reading>({ state: 'closed' });
  const [stage, setStage] = useState('');
  const [reason, setReason] = useState('');
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // `quiet` re-reads after a save without dropping back to "Reading…", so the
  // panel (and the control the coach just pressed) stays on screen.
  const read = useCallback(async (quiet = false) => {
    if (!quiet) setReading({ state: 'loading' });
    try {
      const res = await fetch(`${apiBase()}${ENDPOINT}?athlete_id=${encodeURIComponent(athleteId)}`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('read');
      const data = (await res.json()) as PathwayReading;
      setReading({ state: 'loaded', data });
      setStage(data.current?.stage_key ?? '');
    } catch {
      if (!quiet) setReading({ state: 'unavailable' });
    }
  }, [athleteId]);

  const send = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError('');
      try {
        const res = await fetch(`${apiBase()}${ENDPOINT}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ athlete_id: athleteId, ...body }),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(payload?.error ?? 'That was not saved. Try again.');
        } else {
          setConfirmingOff(false);
          setReason('');
        }
        // Re-read either way: a refusal often means someone else changed
        // this athlete (e.g. switched the allowance off) since the last read.
        await read(true);
      } catch {
        setError('That was not saved. Try again.');
      } finally {
        setBusy(false);
      }
    },
    [athleteId, read],
  );

  const open = reading.state !== 'closed';
  const panelId = `adult-pathway-${athleteId}`;

  return (
    <div className="mt-[var(--s3)]">
      <button
        type="button"
        className="btn btn--ghost"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          if (open) {
            setReading({ state: 'closed' });
            setError('');
            setConfirmingOff(false);
            setReason('');
          } else {
            void read();
          }
        }}
      >
        {open ? 'Hide pathway' : 'Pathway'}
      </button>

      {open ? (
        <div id={panelId} className="mat-paper mt-[var(--s3)] rounded-[var(--r-md)] p-[var(--s3)]">
          <p className="t-eyebrow">Adult pathway — {athleteName}</p>

          {reading.state === 'loading' ? <p className="t-body mt-[var(--s2)]" role="status">Reading…</p> : null}

          {reading.state === 'unavailable' ? (
            <div className="mt-[var(--s2)]" role="alert">
              <p className="t-body">This athlete’s pathway could not be read just now.</p>
              <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={() => void read()}>
                Check again
              </button>
            </div>
          ) : null}

          {reading.state === 'loaded' ? (
            <PathwayBody
              data={reading.data}
              panelId={panelId}
              stage={stage}
              setStage={setStage}
              reason={reason}
              setReason={setReason}
              confirmingOff={confirmingOff}
              setConfirmingOff={setConfirmingOff}
              busy={busy}
              send={send}
            />
          ) : null}

          {error ? (
            <p className="t-body mt-[var(--s3)] text-[var(--locked-ink)]" role="alert">{error}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PathwayBody(props: {
  data: PathwayReading;
  panelId: string;
  stage: string;
  setStage: (value: string) => void;
  reason: string;
  setReason: (value: string) => void;
  confirmingOff: boolean;
  setConfirmingOff: (value: boolean) => void;
  busy: boolean;
  send: (body: Record<string, unknown>) => Promise<void>;
}) {
  const { data, panelId, busy, send } = props;
  const frozen = !data.eligibility.eligible;
  const needsAllowance = data.eligibility.basis !== 'adult';
  const ticks = new Map(data.checkpoints.map((c) => [c.goal_key, c]));

  return (
    <>
      {frozen && data.current ? (
        <div className="alert alert--warning mt-[var(--s2)]" role="alert" data-pathway-flag="not-eligible">
          <span className="alert-icon" aria-hidden="true">▲</span>
          <div className="alert-body">
            <p className="alert-msg">{NOT_ELIGIBLE_FLAG}</p>
          </div>
        </div>
      ) : null}

      {needsAllowance ? (
        <section className="mt-[var(--s3)]" aria-labelledby={`${panelId}-allowance`}>
          <h3 id={`${panelId}-allowance`} className="t-label">
            Allowed on the adult pathway (under 18 or no date of birth)
          </h3>
          {data.allowance ? (
            <>
              <p className="t-body mt-[var(--s1)]">{data.allowance.reason}</p>
              <p className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                {data.allowance.granted_by_name ?? 'A coach'} on {formatGymDateNumeric(data.allowance.granted_at)}
              </p>
              {props.confirmingOff ? (
                <div className="mt-[var(--s2)]">
                  <p className="t-body">{SWITCH_OFF_WARNING}</p>
                  <button type="button" className="btn mt-[var(--s2)]" disabled={busy}
                    onClick={() => void send({ action: 'withdraw_allowance' })}>
                    Switch off
                  </button>
                </div>
              ) : (
                <button type="button" className="btn btn--ghost mt-[var(--s2)]" disabled={busy}
                  onClick={() => props.setConfirmingOff(true)}>
                  Switch off
                </button>
              )}
            </>
          ) : (
            <div className="field mt-[var(--s2)]">
              <label className="t-label" htmlFor={`${panelId}-reason`}>
                Why is this athlete on the adult pathway? Required, kept on record.
              </label>
              <textarea id={`${panelId}-reason`} className="textarea" value={props.reason}
                onChange={(event) => props.setReason(event.target.value)} />
              <button type="button" className="btn mt-[var(--s2)]" disabled={busy || !props.reason.trim()}
                onClick={() => void send({ action: 'grant_allowance', reason: props.reason })}>
                Switch on
              </button>
            </div>
          )}
        </section>
      ) : null}

      <div className="field mt-[var(--s3)]">
        <label className="t-label" htmlFor={`${panelId}-stage`}>Set stage</label>
        <select id={`${panelId}-stage`} className="select" value={props.stage} disabled={frozen || busy}
          onChange={(event) => props.setStage(event.target.value)}>
          <option value="">—</option>
          {ADULT_PATHWAY_STAGES.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
        </select>
        <button type="button" className="btn mt-[var(--s2)]"
          disabled={frozen || busy || !props.stage || props.stage === data.current?.stage_key}
          onClick={() => void send({ action: 'place', stage_key: props.stage })}>
          Set stage
        </button>
      </div>

      {ADULT_PATHWAY_STAGES.map((s) => (
        <section key={s.key} className="mt-[var(--s3)]" aria-label={s.name}>
          <h3 className="t-label">{s.name}</h3>
          <ul className="mt-[var(--s1)] space-y-[var(--s1)]">
            {s.goals.map((g) => {
              const tick = ticks.get(g.key);
              return (
                <li key={g.key} className="flex flex-wrap items-center gap-[var(--s2)]">
                  <span className="t-body">{g.text}</span>
                  {tick ? (
                    <>
                      <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                        Confirmed by {tick.confirmed_by_name ?? 'a coach'} on {formatGymDateNumeric(tick.confirmed_at)}
                      </span>
                      <button type="button" className="btn btn--ghost" disabled={busy}
                        onClick={() => void send({ action: 'withdraw_checkpoint', goal_key: g.key })}>
                        Untick
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn btn--ghost" disabled={frozen || busy}
                      aria-label={`Tick: ${g.text}`}
                      onClick={() => void send({ action: 'confirm', stage_key: s.key, goal_key: g.key })}>
                      Tick
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}
