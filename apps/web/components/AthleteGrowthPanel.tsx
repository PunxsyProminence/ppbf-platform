'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiBase } from '@/lib/apiBase';
import { refusalWords } from '@/src/lib/serverRefusalWords';
import { formatGymDateNumeric, gymDayIso } from '@/src/lib/gymTime';

// Standing height for one athlete, entered by a coach, and the growth rate it
// gives (OD-2026-10-17-026 (b)). Shown in the coach's wellness view beside
// body mass. Coach-only: the route refuses everyone but staff of the gym, and
// no athlete or family screen mounts this.
//
// GROWTH RATE ONLY. A rate in cm per year between two readings at least
// growth_min_days apart, said as arithmetic. No predicted height, maturity,
// stage or label, and no "drift" mark: that waits for a researched cut-off
// (Overwatch Q1 to L60). All wording here is PROPOSED.
//
// ONE SAVE, ONE READING. A request key is made for each save and reused only
// when the same save is pressed again after an unknown outcome (a lost reply,
// a server error), so a retry lands on the first attempt instead of adding a
// second reading; an edited value is a new save. A correction is a new
// reading naming the one it replaces; the original stays on record.

export interface HeightReadingView {
  height_id: string;
  measured_on: string;
  height_cm: number;
  supersedes_height_id: string | null;
  superseded: boolean;
}

export interface GrowthView {
  from_measured_on: string;
  to_measured_on: string;
  days: number;
  change_cm: number;
  cm_per_year: number;
}

interface Loaded {
  readings: HeightReadingView[];
  latest: HeightReadingView | null;
  growth: GrowthView | null;
  growthMinDays: number;
  cmMin: number;
  cmMax: number;
}

type Reading = { state: 'loading' } | { state: 'unavailable' } | ({ state: 'loaded' } & Loaded);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function isReading(value: unknown): value is HeightReadingView {
  const row = value as Record<string, unknown> | null;
  return !!row && typeof row.height_id === 'string' && typeof row.measured_on === 'string'
    && DAY.test(row.measured_on) && typeof row.height_cm === 'number' && Number.isFinite(row.height_cm)
    && (row.supersedes_height_id === null || typeof row.supersedes_height_id === 'string')
    && typeof row.superseded === 'boolean';
}

function isGrowth(value: unknown): value is GrowthView {
  const row = value as Record<string, unknown> | null;
  return !!row && typeof row.from_measured_on === 'string' && typeof row.to_measured_on === 'string'
    && [row.days, row.change_cm, row.cm_per_year].every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** The route's answer, or null when it is not the shape this panel shows. */
export function parseHeightPayload(payload: unknown): Loaded | null {
  const body = payload as Record<string, unknown> | null;
  if (!body || body.ok !== true || !Array.isArray(body.readings) || !body.readings.every(isReading)) return null;
  if (!(body.latest === null || isReading(body.latest))) return null;
  if (!(body.growth === null || isGrowth(body.growth))) return null;
  if (![body.growth_min_days, body.height_cm_min, body.height_cm_max].every((n) => typeof n === 'number')) return null;
  return {
    readings: body.readings,
    latest: body.latest as HeightReadingView | null,
    growth: body.growth as GrowthView | null,
    growthMinDays: body.growth_min_days as number,
    cmMin: body.height_cm_min as number,
    cmMax: body.height_cm_max as number,
  };
}

function day(iso: string): string {
  return formatGymDateNumeric(`${iso}T12:00:00Z`) ?? iso;
}

/** "+3.2 cm since 7/15/2026 (93 days): about 12.6 cm a year." PROPOSED. */
export function growthSentence(growth: GrowthView): string {
  const sign = growth.change_cm > 0 ? '+' : '';
  return `${sign}${growth.change_cm.toFixed(1)} cm since ${day(growth.from_measured_on)} (${growth.days} days): `
    + `about ${growth.cm_per_year.toFixed(1)} cm a year.`;
}

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `height-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function AthleteGrowthPanel({ athleteId }: { athleteId: string }) {
  const [reading, setReading] = useState<Reading>({ state: 'loading' });
  const [cm, setCm] = useState('');
  const [measuredOn, setMeasuredOn] = useState(() => gymDayIso() ?? '');
  const [correcting, setCorrecting] = useState<HeightReadingView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'saved' | 'refused'; text: string } | null>(null);
  // The last save sent whose outcome is unknown: its key is reused only for
  // the SAME save (same number, date and correction target), so a retry lands
  // on the first attempt and an edited value is a new save, never a key reuse.
  const pending = useRef<{ key: string; body: string } | null>(null);
  const live = useRef(true);
  // Each read gets a number; only the newest may land, so a slow reply for an
  // earlier athlete (or an earlier read) never draws under the current one.
  const latestRead = useRef(0);

  const load = useCallback(async () => {
    const ticket = latestRead.current + 1;
    latestRead.current = ticket;
    const landed = () => live.current && latestRead.current === ticket;
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/coach/athlete-height?athlete_id=${encodeURIComponent(athleteId)}`,
        { method: 'GET', credentials: 'include' },
      );
      const parsed = response.ok ? parseHeightPayload(await response.json().catch(() => null)) : null;
      if (!landed()) return;
      // Unknown is never shown as "no height recorded".
      setReading(parsed ? { state: 'loaded', ...parsed } : { state: 'unavailable' });
    } catch {
      if (landed()) setReading({ state: 'unavailable' });
    }
  }, [athleteId]);

  useEffect(() => {
    live.current = true;
    setReading({ state: 'loading' });
    void load();
    return () => {
      live.current = false;
    };
  }, [load]);

  const resetForm = () => {
    setCm('');
    setCorrecting(null);
    setMeasuredOn(gymDayIso() ?? '');
  };

  const save = async () => {
    if (busy) return;
    setMessage(null);
    const typed = cm.trim();
    if (!/^\d{2,3}(\.\d)?$/.test(typed)) {
      setMessage({ kind: 'refused', text: 'Enter the height in centimetres, like 151.4.' });
      return;
    }
    const fields = { height_cm: Number(typed), measured_on: measuredOn, supersedes_height_id: correcting?.height_id ?? null };
    const body = JSON.stringify(fields);
    const key = pending.current?.body === body ? pending.current.key : newKey();
    pending.current = { key, body };
    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/athlete-height`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ athlete_id: athleteId, ...fields, request_key: key }),
      });
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const parsed = response.ok ? parseHeightPayload(payload) : null;
      if (!live.current) return;
      if (!parsed) {
        const refused = response.status >= 400 && response.status < 500;
        // A 4xx wrote nothing, so the next press is a new save. A 5xx or an
        // unreadable answer may have saved: keep the key, say so, and re-read.
        if (refused) pending.current = null;
        setMessage({
          kind: 'refused',
          text: refusalWords(
            { error: payload?.error, status: response.status },
            {},
            refused ? 'The height was not saved. Try again.' : undefined,
          ),
        });
        // "Already corrected" (or a reused key): start over with an empty form
        // for today, so a second press cannot record the typed value as a
        // new reading on the old reading's date.
        if (response.status === 409) resetForm();
        if (!refused || response.status === 409) void load();
        return;
      }
      pending.current = null;
      // A re-read still in flight is older than this answer; it must not land.
      latestRead.current += 1;
      setReading({ state: 'loaded', ...parsed });
      setMessage({
        kind: 'saved',
        text: correcting
          ? `Correction saved: ${fields.height_cm.toFixed(1)} cm. The old reading stays on record.`
          : `Height saved: ${fields.height_cm.toFixed(1)} cm.`,
      });
      resetForm();
    } catch {
      if (live.current) {
        setMessage({ kind: 'refused', text: 'That did not go through. Check the readings below before trying again.' });
        void load();
      }
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const shown = reading.state === 'loaded' ? reading : null;

  return (
    <section className="space-y-[var(--s2)]" data-testid="coach-athlete-growth" aria-labelledby="coach-athlete-growth-title">
      <h4 className="t-label" id="coach-athlete-growth-title">Standing height (coaches only)</h4>
      {reading.state === 'loading' && <p className="t-muted">Reading heights…</p>}
      {reading.state === 'unavailable' && (
        <div className="space-y-[var(--s1)]">
          <p className="t-muted" data-testid="coach-athlete-growth-unavailable">
            Heights could not be read just now. That is not the same as none recorded.
          </p>
          <button type="button" className="btn btn--ghost" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {shown && (
        <>
          <p className="t-body">
            {shown.latest
              ? `Height: ${shown.latest.height_cm.toFixed(1)} cm, measured ${day(shown.latest.measured_on)}.`
              : 'No height recorded yet.'}
          </p>
          <p className="t-body" data-testid="coach-athlete-growth-rate">
            {shown.growth
              ? `Growth: ${growthSentence(shown.growth)}`
              : `A growth rate needs two readings at least ${shown.growthMinDays} days apart.`}
          </p>
          {shown.readings.length > 0 && (
            <ul className="space-y-[var(--s1)]">
              {shown.readings.map((row) => (
                <li key={row.height_id} className="t-body flex flex-wrap items-center gap-[var(--s2)]">
                  <span className={row.superseded ? 'line-through text-[color:var(--bone-400)]' : ''}>
                    {day(row.measured_on)}: {row.height_cm.toFixed(1)} cm
                  </span>
                  {row.superseded && <span className="t-muted">(corrected)</span>}
                  {!row.superseded && (
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={busy}
                      aria-label={`Correct the ${row.height_cm.toFixed(1)} cm reading of ${day(row.measured_on)}`}
                      onClick={() => {
                        setCorrecting(row);
                        setCm(row.height_cm.toFixed(1));
                        setMeasuredOn(row.measured_on);
                        setMessage(null);
                      }}
                    >
                      Correct
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="t-muted">Centimetres, {shown.cmMin} to {shown.cmMax}, one decimal.</p>
          <div className="flex flex-wrap items-end gap-[var(--s2)]">
            <label className="space-y-[var(--s1)]">
              <span className="t-label block">
                {correcting
                  ? `Correct the ${correcting.height_cm.toFixed(1)} cm reading of ${day(correcting.measured_on)} (cm)`
                  : 'Height in centimetres'}
              </span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={cm}
                disabled={busy}
                onChange={(event) => setCm(event.target.value)}
                className="input w-[8rem]"
              />
            </label>
            <label className="space-y-[var(--s1)]">
              <span className="t-label block">Measured on</span>
              <input
                type="date"
                value={measuredOn}
                max={gymDayIso() ?? undefined}
                disabled={busy}
                onChange={(event) => setMeasuredOn(event.target.value)}
                className="input"
              />
            </label>
            <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : correcting ? 'Save correction' : 'Save height'}
            </button>
            {correcting && (
              <button
                type="button"
                className="btn btn--ghost"
                disabled={busy}
                onClick={resetForm}
              >
                Cancel correction
              </button>
            )}
          </div>
          {message && (
            <p className="t-body" role={message.kind === 'refused' ? 'alert' : 'status'}>
              {message.text}
            </p>
          )}
        </>
      )}
    </section>
  );
}
