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
 * announced. The next press clears it first; no timer does. The one
 * exception: when the outcome is not known and the re-read fails, an alert
 * replaces the drawer, and focus is sent to it. A Save is
 * confirmed only by the number sent coming back as the gym's own setting.
 * When the outcome is not known, the setting is read again, so the old one is
 * not left on screen as fact; a refusal (401, 403, other 4xx) changed nothing
 * and is not read again (reviewers P and Q, round 2).
 */

const COULD_NOT_READ = 'The setting could not be read. Reload to try again.';

type Load =
  | { readonly state: 'loading' }
  /** A refused or failed read: the alert's words, and no select. */
  /** readAgain: the re-read after a PUT failed; focus is sent to the alert then, never on a first read. */
  | { readonly state: 'error'; readonly words: string; readonly readAgain?: true }
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

/** The GET with its shape check: the setting as loaded, or the alert's words for a refused or failed read. */
async function readGap(): Promise<Load> {
  try {
    const response = await fetch(`${apiBase()}/api/pilot/stopped-coming/gap`, { credentials: 'include', cache: 'no-store' });
    if (response.status === 401) return { state: 'error', words: 'Your sign-in has expired. Sign in again to read this setting.' };
    if (response.status === 403) return { state: 'error', words: 'Only the gym admin can read this setting.' };
    if (!response.ok) throw new Error(String(response.status));
    const body: unknown = await response.json();
    const choices = (body as { choices?: unknown } | null)?.choices;
    if (!isChoices(choices)) throw new Error('shape');
    const setting = readSetting(body, choices);
    if (!setting) throw new Error('shape');
    return { state: 'loaded', choices, saved: setting.gapDays, isDefault: setting.isDefault };
  } catch {
    return { state: 'error', words: COULD_NOT_READ };
  }
}

export default function StoppedComingSettings() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [choice, setChoice] = useState<number | null>(null);
  // Which button's request is running: only that one says "Saving…".
  const [saving, setSaving] = useState<'save' | 'default' | null>(null);
  const [line, setLine] = useState('');
  // Set before the first await, so a second click before React re-renders sends nothing.
  const inFlight = useRef(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  // Counts presses that have settled; the focus check below runs on each.
  const [settled, setSettled] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const read = await readGap();
      if (cancelled) return;
      setLoad(read);
      if (read.state === 'loaded') setChoice(read.saved);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // After a press, focus is left alone unless nothing or the body has focus. A button that
  // unmounted while focused ("Use the default" after it worked, or the whole drawer after a failed
  // re-read) leaves it on the body. Then it goes to the alert that replaced the drawer, if there is
  // one, else to the select.
  useEffect(() => {
    if (settled === 0) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    (alertRef.current ?? selectRef.current)?.focus();
  }, [settled]);

  /** A number of days for "Save", or null for "Use the default". */
  const put = async (gapDays: number | null) => {
    if (load.state !== 'loaded' || inFlight.current) return;
    inFlight.current = true;
    setSaving(gapDays === null ? 'default' : 'save');
    setLine('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/stopped-coming/gap`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gap_days: gapDays }),
      }).catch(() => null);
      // Refused: nothing was changed, so the setting shown stands and is not read again.
      if (response?.status === 401) {
        setLine('Not saved: your sign-in has expired. Sign in again, then try again.');
        return;
      }
      if (response?.status === 403) {
        setLine('Not saved: only the gym admin can change this.');
        return;
      }
      if (response && response.status >= 400 && response.status < 500) {
        setLine('Not saved: the server refused the change, so nothing was changed.');
        return;
      }
      // A 204's empty body, or one that is not JSON, reads as null.
      const setting = response?.ok ? readSetting(await response.json().catch(() => null), load.choices) : null;
      // A Save is confirmed only as the gym's own setting of the number sent; "Use the default" only as the default.
      if (setting && (gapDays === null ? setting.isDefault : !setting.isDefault && setting.gapDays === gapDays)) {
        setLoad({ state: 'loaded', choices: load.choices, saved: setting.gapDays, isDefault: setting.isDefault });
        setChoice(setting.gapDays);
        const label = gapLabel(setting.gapDays);
        setLine(setting.isDefault ? `The default, ${label}, applies again.` : `Saved: ${label}.`);
        return;
      }
      // Not known (a 5xx, no answer, or a 2xx that does not confirm): the old setting is not shown as fact.
      const read = await readGap();
      if (read.state !== 'loaded') {
        setLoad({
          state: 'error',
          readAgain: true,
          words: 'It is not known whether the change was saved, and the setting could not be read again. Reload to see it.',
        });
        return;
      }
      setLoad(read);
      setChoice(read.saved);
      setLine('It is not known whether that change was saved. The setting shown has been read again.');
    } finally {
      inFlight.current = false;
      setSaving(null);
      setSettled((count) => count + 1);
    }
  };

  if (load.state === 'loading') return <p className="t-muted">Reading the setting…</p>;
  if (load.state === 'error') {
    return (
      <p ref={load.readAgain ? alertRef : undefined} tabIndex={load.readAgain ? -1 : undefined} role="alert" className="t-body">
        {load.words}
      </p>
    );
  }

  // The select's value: what the admin picked, else what is saved.
  const current = choice ?? load.saved;
  const nothingToSave = current === load.saved;
  // aria-disabled, not disabled, so focus stays on a pressed button; the handlers do nothing then.
  return (
    <div>
      <label htmlFor="stopped-coming-gap" className="t-label block">Listed after not coming for</label>
      <div className="mt-[var(--s2)] flex flex-wrap items-center gap-[var(--s3)]">
        <select
          ref={selectRef}
          id="stopped-coming-gap"
          className="input"
          value={current}
          disabled={saving !== null}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (load.choices.includes(next)) setChoice(next);
          }}
        >
          {load.choices.map((days) => (
            <option key={days} value={days}>{gapLabel(days)}</option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          aria-disabled={saving !== null || nothingToSave}
          onClick={() => {
            if (saving === null && !nothingToSave) void put(current);
          }}
        >
          {saving === 'save' ? 'Saving…' : 'Save'}
        </button>
        {load.isDefault ? null : (
          <button
            type="button"
            className="btn btn--ghost"
            aria-disabled={saving !== null}
            onClick={() => {
              if (saving === null) void put(null);
            }}
          >
            {saving === 'default' ? 'Saving…' : 'Use the default'}
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
