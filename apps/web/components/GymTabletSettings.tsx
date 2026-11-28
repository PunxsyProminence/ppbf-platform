'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

import { apiBase } from '@/lib/apiBase';
import { isGymTabletMarked, setGymTabletMark, subscribeGymTabletMark } from '@/src/lib/gymTabletMark';
import {
  isTabletIdleMinutes,
  TABLET_IDLE_MINUTES,
  tabletIdleLabel,
  type TabletIdleMinutes,
} from '@/src/shared/tabletIdle';

import { turnOffPushInThisBrowser } from './PushAlertSwitch';

/**
 * Gym tablet sign-out, on Customize the Gym (lane U1, AS2-b; Jason's ruling
 * OW25-53 A: the gym admin sets the time in gym settings; Overwatch Q1 = A,
 * the device mark; Q2, this page; Q3, the fixed list).
 *
 * Two controls:
 *  1. The time, for the whole gym: GET/PUT /api/pilot/gym-tablet/idle. The
 *     server refuses anyone but the gym admin; this page is the gym admin's.
 *  2. The mark, for THIS device only: kept in this browser
 *     (src/lib/gymTabletMark.ts), so it is set on the tablet itself. Marking
 *     also turns web push off in this browser (OW27-17 B: no pop-ups on a
 *     gym tablet), in case it was turned on there before (W5-WP, WP-3).
 */

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'error' }
  | { readonly state: 'loaded'; readonly saved: TabletIdleMinutes; readonly isDefault: boolean };

export default function GymTabletSettings() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [choice, setChoice] = useState<TabletIdleMinutes | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveLine, setSaveLine] = useState<{ readonly tone: 'ok' | 'error'; readonly text: string } | null>(null);
  const marked = useSyncExternalStore(subscribeGymTabletMark, isGymTabletMarked, () => false);
  const [markLine, setMarkLine] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/gym-tablet/idle`, { credentials: 'include', cache: 'no-store' });
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { idle_minutes?: unknown; is_default?: unknown };
        if (!isTabletIdleMinutes(body.idle_minutes)) throw new Error('shape');
        if (cancelled) return;
        setLoad({ state: 'loaded', saved: body.idle_minutes, isDefault: body.is_default === true });
        setChoice(body.idle_minutes);
      } catch {
        if (!cancelled) setLoad({ state: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    if (load.state !== 'loaded' || choice === null) return;
    setSaving(true);
    setSaveLine(null);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/gym-tablet/idle`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idle_minutes: choice }),
      });
      const body = (await response.json().catch(() => ({}))) as { idle_minutes?: unknown; error?: string };
      if (!response.ok || !isTabletIdleMinutes(body.idle_minutes)) {
        setSaveLine({ tone: 'error', text: `Not saved.${body.error ? ` ${body.error}` : ''}` });
        return;
      }
      setLoad({ state: 'loaded', saved: body.idle_minutes, isDefault: false });
      setSaveLine({ tone: 'ok', text: `Saved: ${tabletIdleLabel(body.idle_minutes)}.` });
    } catch {
      setSaveLine({ tone: 'error', text: 'Not saved: the connection dropped. Try again.' });
    } finally {
      setSaving(false);
    }
  };

  const mark = (next: boolean) => {
    const kept = setGymTabletMark(next);
    setMarkLine(kept ? '' : 'This browser would not save the change (private mode or blocked storage). Nothing changed.');
    if (kept && next) void turnOffPushInThisBrowser();
  };

  return (
    <div className="flex flex-col gap-[var(--s5)]">
      <div>
        {load.state === 'loading' ? <p className="t-muted">Reading the setting…</p> : null}
        {load.state === 'error' ? (
          <p role="alert" className="t-body">The setting could not be read. Reload to try again.</p>
        ) : null}
        {load.state === 'loaded' && choice !== null ? (
          <>
            <label htmlFor="gym-tablet-idle" className="t-label block">Sign out after</label>
            <div className="mt-[var(--s2)] flex flex-wrap items-center gap-[var(--s3)]">
              <select
                id="gym-tablet-idle"
                className="input"
                value={choice}
                disabled={saving}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (isTabletIdleMinutes(next)) setChoice(next);
                  setSaveLine(null);
                }}
              >
                {TABLET_IDLE_MINUTES.map((minutes) => (
                  <option key={minutes} value={minutes}>{tabletIdleLabel(minutes)}</option>
                ))}
              </select>
              <button type="button" className="btn" disabled={saving || choice === load.saved} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
            {load.isDefault ? (
              <p className="t-muted mt-[var(--s2)]">Not set yet: the default, 1 hour, applies.</p>
            ) : null}
            {saveLine ? (
              <p role={saveLine.tone === 'error' ? 'alert' : 'status'} className="t-body mt-[var(--s2)]">{saveLine.text}</p>
            ) : null}
          </>
        ) : null}
      </div>

      <div>
        <p className="t-body text-[color:var(--bone-100)]">
          {marked ? 'This device is marked as a gym tablet.' : 'This device is not marked as a gym tablet.'}
        </p>
        <p className="t-muted mt-[var(--s2)] max-w-[68ch]">
          The mark is kept in this device&apos;s browser, so set it on the gym tablet itself. While someone is
          signed in, a marked device shows &quot;Gym tablet&quot; in the bar at the top. If the browser&apos;s data is
          cleared, the mark is lost and that device stops signing itself out.
        </p>
        <button type="button" className="btn btn--ghost mt-[var(--s3)]" onClick={() => mark(!marked)}>
          {marked ? 'Unmark this device' : 'Mark this device as a gym tablet'}
        </button>
        {markLine ? <p role="alert" className="t-body mt-[var(--s2)]">{markLine}</p> : null}
      </div>
    </div>
  );
}
