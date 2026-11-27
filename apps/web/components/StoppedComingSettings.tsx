'use client';

import { useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';

/**
 * Stopped coming, on Customize the Gym (lane W4-6, the plan's SC-0b; Jason's
 * ruling OW27-30 A: a gym setting the gym admin can change, first value
 * 2 weeks; Overwatch W4-6 Q1 A, a fixed list, and Q6 A, the gym admin only;
 * App Overwatch's order ruling on #2163, comment 7207478242: SC-0b first,
 * EM-6 second). Words PROPOSED.
 *
 * One control, for the whole gym: how long without coming puts an athlete on
 * the Stopped Coming list. GET/PUT /api/pilot/stopped-coming/gap. The server
 * refuses anyone but the gym admin; this page is the gym admin's.
 *
 * The choices come only from the GET's `choices`. The list lives in
 * src/server/pilot/stoppedComingPolicy.ts, which loads pg, so the browser
 * never imports it and no shared file copies it.
 *
 * Every PUT outcome is said by one status line, worded only from what came
 * back, never with the server's error text. It is always mounted once the
 * setting is read: a live region inserted already filled is often not
 * announced. The next press clears it first; no timer does.
 */

const NOT_KNOWN = 'It is not known whether the change was saved. Reload to see the setting.';

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'error' }
  | {
      readonly state: 'loaded';
      readonly choices: readonly number[];
      readonly saved: number;
      readonly isDefault: boolean;
    };

/** 7 -> "1 week", 14 -> "2 weeks"; a number that is not whole weeks reads in days. */
function gapLabel(days: number): string {
  if (days % 7 === 0) return days === 7 ? '1 week' : `${days / 7} weeks`;
  return days === 1 ? '1 day' : `${days} days`;
}

/** Distinct positive whole numbers, at least one. */
function isChoices(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.length > 0
    && value.every((days) => Number.isInteger(days) && days > 0)
    && new Set(value).size === value.length;
}

/** gap_days one of `choices` and is_default true or false, or null. */
function readSetting(body: unknown, choices: readonly number[]): { gapDays: number; isDefault: boolean } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { gap_days: gapDays, is_default: isDefault } = body as { gap_days?: unknown; is_default?: unknown };
  if (typeof gapDays !== 'number' || !choices.includes(gapDays) || typeof isDefault !== 'boolean') return null;
  return { gapDays, isDefault };
}

export default function StoppedComingSettings() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [choice, setChoice] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [line, setLine] = useState('');
  // Set before the first await, so a second click before React re-renders sends nothing.
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/stopped-coming/gap`, { credentials: 'include', cache: 'no-store' });
        if (!response.ok) throw new Error(String(response.status));
        const body: unknown = await response.json();
        const choices = (body as { choices?: unknown } | null)?.choices;
        if (!isChoices(choices)) throw new Error('shape');
        const setting = readSetting(body, choices);
        if (!setting) throw new Error('shape');
        if (cancelled) return;
        setLoad({ state: 'loaded', choices, saved: setting.gapDays, isDefault: setting.isDefault });
        setChoice(setting.gapDays);
      } catch {
        if (!cancelled) setLoad({ state: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** A number of days for "Save", or null for "Use the default". */
  const put = async (gapDays: number | null) => {
    if (load.state !== 'loaded' || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setLine('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/stopped-coming/gap`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gap_days: gapDays }),
      });
      if (response.status === 401) {
        setLine('Not saved: your sign-in has expired. Sign in again, then try again.');
        return;
      }
      if (response.status === 403) {
        setLine('Not saved: only the gym admin can change this.');
        return;
      }
      if (response.status >= 400 && response.status < 500) {
        setLine('Not saved: the server refused the change, so nothing was changed.');
        return;
      }
      // A 204's empty body, or one that is not JSON, reads as null.
      const setting = response.ok ? readSetting(await response.json().catch(() => null), load.choices) : null;
      // A Save is confirmed only as the gym's own setting; "Use the default" only as the default.
      if (!setting || setting.isDefault !== (gapDays === null)) {
        setLine(NOT_KNOWN);
        return;
      }
      setLoad({ state: 'loaded', choices: load.choices, saved: setting.gapDays, isDefault: setting.isDefault });
      setChoice(setting.gapDays);
      const label = gapLabel(setting.gapDays);
      setLine(setting.isDefault ? `The default, ${label}, applies again.` : `Saved: ${label}.`);
    } catch {
      setLine(NOT_KNOWN);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  if (load.state === 'loading') return <p className="t-muted">Reading the setting…</p>;
  if (load.state === 'error') {
    return <p role="alert" className="t-body">The setting could not be read. Reload to try again.</p>;
  }

  // The select's value: what the admin picked, else what is saved.
  const current = choice ?? load.saved;
  return (
    <div>
      <label htmlFor="stopped-coming-gap" className="t-label block">Listed after not coming for</label>
      <div className="mt-[var(--s2)] flex flex-wrap items-center gap-[var(--s3)]">
        <select
          id="stopped-coming-gap"
          className="input"
          value={current}
          disabled={saving}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (load.choices.includes(next)) setChoice(next);
          }}
        >
          {load.choices.map((days) => (
            <option key={days} value={days}>{gapLabel(days)}</option>
          ))}
        </select>
        <button type="button" className="btn" disabled={saving || current === load.saved} onClick={() => void put(current)}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {load.isDefault ? null : (
          <button type="button" className="btn btn--ghost" disabled={saving} onClick={() => void put(null)}>
            Use the default
          </button>
        )}
      </div>
      {load.isDefault ? (
        <p className="t-muted mt-[var(--s2)]">{`Not set yet: the default, ${gapLabel(load.saved)}, applies.`}</p>
      ) : null}
      <p role="status" className="t-body mt-[var(--s2)]">{line}</p>
    </div>
  );
}
