'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { gymDayIso } from '@/src/lib/gymTime';
import { refusalWords } from '@/src/lib/serverRefusalWords';

// THE QUARTERLY TEST DAY (OD-2026-10-17-026: "A: 20-m shuttle (Rec.)", and
// (b) the coach-entered standing height; the jumps as OD-2026-10-04-020 rules
// them, CMJ height and broad jump, best of 3, either or both). One coach
// records the group's numbers for one date in one save.
//
// A BLANK BOX IS "NOT TESTED": nothing is sent for it, and an athlete with
// every box blank is left off the save. The server writes every filled box or
// none, so a refusal never leaves half a test day behind.
//
// ONE PRESS, ONCE. The save key is reused only when the same form is pressed
// again after an unknown outcome, so a retry never saves anything twice; once
// the server confirms, the boxes clear and the next press is a new save.
//
// Staff only: the route refuses everyone but a coach or admin seat of the gym,
// and this page offers only the athletes that route will record for. Heights
// go to the coach-only height record; jumps and the shuttle go to each
// athlete's own testing history. All wording here is PROPOSED.

interface RosterAthlete { athlete_id: string; full_name?: string }

const FIELDS = [
  { key: 'height_cm', label: 'Height (cm)', inputMode: 'decimal' },
  { key: 'cmj_cm', label: 'CMJ (cm)', inputMode: 'decimal' },
  { key: 'broad_cm', label: 'Broad jump (cm)', inputMode: 'decimal' },
  { key: 'shuttle_level', label: 'Shuttle level', inputMode: 'numeric' },
  { key: 'shuttle_number', label: 'Shuttle', inputMode: 'numeric' },
] as const;
type FieldKey = (typeof FIELDS)[number]['key'];
type Cells = Partial<Record<FieldKey, string>>;

const MEASURE_WORDS: Record<string, string> = {
  height: 'height',
  'ppbf-jump-cmj-height': 'CMJ',
  'ppbf-jump-broad-distance': 'broad jump',
  'ppbf-shuttle-20m': '20-m shuttle',
};

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `test-day-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function TestDayPage() {
  const [roster, setRoster] = useState<RosterAthlete[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [date, setDate] = useState(() => gymDayIso() ?? '');
  const [cells, setCells] = useState<Record<string, Cells>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'saved' | 'refused'; text: string; also?: string[] } | null>(null);
  const pending = useRef<{ key: string; body: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/pilot/athletes/list`, { method: 'GET', credentials: 'include' });
        const payload = res.ok ? ((await res.json()) as { items?: unknown } | null) : null;
        if (!payload || !Array.isArray(payload.items)) throw new Error('roster');
        const all = payload.items as RosterAthlete[];
        const allowedRes = await fetch(`${apiBase()}/api/pilot/coach/test-day`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'accessible_athletes', athlete_ids: all.map((a) => a.athlete_id) }),
        });
        const allowed = allowedRes.ok ? ((await allowedRes.json()) as { athlete_ids?: unknown } | null) : null;
        if (!allowed || !Array.isArray(allowed.athlete_ids)) throw new Error('roster');
        const ids = new Set(allowed.athlete_ids as string[]);
        setRoster(all.filter((a) => ids.has(a.athlete_id)));
      } catch {
        // A roster that could not be read is never shown as "no athletes".
        setFailed(true);
      }
    })();
  }, []);

  const nameOf = (id: string) => roster?.find((a) => a.athlete_id === id)?.full_name || id;

  const save = async () => {
    if (busy || !roster) return;
    setMessage(null);
    const rows: Array<Record<string, unknown>> = [];
    for (const athlete of roster) {
      const typed = cells[athlete.athlete_id] ?? {};
      const filled = FIELDS.filter((field) => (typed[field.key] ?? '').trim() !== '');
      if (filled.length === 0) continue;
      const row: Record<string, unknown> = { athlete_id: athlete.athlete_id };
      for (const field of filled) {
        const text = (typed[field.key] ?? '').trim();
        if (!/^\d+(\.\d+)?$/.test(text)) {
          setMessage({ kind: 'refused', text: `${nameOf(athlete.athlete_id)}: "${text}" in ${field.label} is not a number. Nothing was sent.` });
          return;
        }
        row[field.key] = Number(text);
      }
      rows.push(row);
    }
    if (rows.length === 0) {
      setMessage({ kind: 'refused', text: 'Fill in at least one box first.' });
      return;
    }
    const body = JSON.stringify({ administered_on: date, rows });
    const key = pending.current?.body === body ? pending.current.key : newKey();
    pending.current = { key, body };
    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/test-day`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ administered_on: date, request_key: key, rows }),
      });
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok || !payload || payload.ok !== true || typeof payload.written !== 'number') {
        const refused = response.status >= 400 && response.status < 500;
        if (refused) pending.current = null;
        setMessage({
          kind: 'refused',
          text: refused
            ? refusalWords({ error: payload?.error, status: response.status }, {}, 'Nothing was saved. Check the boxes and try again.')
            : 'That did not go through, and it may or may not have saved. Press Save test day again: a retry never saves anything twice.',
        });
        return;
      }
      pending.current = null;
      const already = typeof payload.already_saved === 'number' ? payload.already_saved : 0;
      const earlier = Array.isArray(payload.earlier_not_on_form) ? payload.earlier_not_on_form as Array<{ athlete_id: string; measure: string }> : [];
      setMessage({
        kind: 'saved',
        text: `Saved ${payload.written} result${payload.written === 1 ? '' : 's'}.`
          + (already > 0 ? ` ${already} were already saved from an earlier press.` : ''),
        also: earlier.map((cell) => `${nameOf(cell.athlete_id)}: ${MEASURE_WORDS[cell.measure] ?? cell.measure}`),
      });
      setCells({});
    } catch {
      setMessage({
        kind: 'refused',
        text: 'That did not go through, and it may or may not have saved. Press Save test day again: a retry never saves anything twice.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <RoleStandaloneView
      roleLabel="Coach Workspace"
      routeLabel="/coach/test-day"
      allowedRoles={['coach', 'admin']}
      room="floor"
      showShellHeader={false}
    >
      {/* data-surface="kiosk" -- Law 5: this is filled in on the floor tablet
          between runs, so every control takes the 55px tap floor. */}
      <div data-surface="kiosk" className="mx-auto max-w-5xl space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Testing</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">Test Day</h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            Record each athlete&apos;s standing height, jumps (best of 3) and 20-m shuttle for one date. Leave a box
            empty for anything not tested. Heights are seen by coaches only; jumps and the shuttle go on each
            athlete&apos;s own testing history.
          </p>
          <p className="t-body mt-[var(--s2)]">
            <Link href="/coach/assessments" className="underline">One athlete at a time: Jump Test and Skill Ratings</Link>
          </p>
        </header>

        <label className="block space-y-[var(--s1)]">
          <span className="t-label block">Test date</span>
          <input
            type="date"
            value={date}
            max={gymDayIso() ?? undefined}
            disabled={busy}
            onChange={(event) => setDate(event.target.value)}
            className="input"
          />
        </label>

        {failed ? (
          <div className="alert alert--warning" role="alert">
            <span className="alert-icon" aria-hidden="true">▲</span>
            <div className="alert-body">
              <p className="alert-title">Not loaded</p>
              <p className="alert-msg">The roster could not be loaded. Reload to try again.</p>
            </div>
          </div>
        ) : roster === null ? (
          <p className="t-body" role="status">Loading the roster…</p>
        ) : roster.length === 0 ? (
          <p className="t-body">No athletes you can record a test day for.</p>
        ) : (
          <ul className="space-y-[var(--s3)]">
            {roster.map((athlete) => {
              const name = athlete.full_name || athlete.athlete_id;
              return (
                <li key={athlete.athlete_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                  <p className="t-body font-semibold text-[color:var(--bone-100)]">{name}</p>
                  <div className="mt-[var(--s2)] grid grid-cols-2 gap-[var(--s2)] sm:grid-cols-5">
                    {FIELDS.map((field) => (
                      <label key={field.key} className="block space-y-[var(--s1)]">
                        <span className="t-label block">{field.label}</span>
                        <input
                          type="text"
                          inputMode={field.inputMode}
                          autoComplete="off"
                          aria-label={`${name}: ${field.label}`}
                          value={cells[athlete.athlete_id]?.[field.key] ?? ''}
                          disabled={busy}
                          onChange={(event) => {
                            const value = event.target.value;
                            setCells((prev) => ({ ...prev, [athlete.athlete_id]: { ...prev[athlete.athlete_id], [field.key]: value } }));
                          }}
                          className="input w-full"
                        />
                      </label>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {roster && roster.length > 0 && (
          <button type="button" className="btn btn--kiosk" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save test day'}
          </button>
        )}
        {message && (
          <div role={message.kind === 'refused' ? 'alert' : 'status'} className="t-body space-y-[var(--s1)]">
            <p>{message.text}</p>
            {message.also && message.also.length > 0 && (
              <>
                <p>Still saved from an earlier press, though not on this form:</p>
                <ul className="list-disc pl-[var(--s4)]">
                  {message.also.map((line) => <li key={line}>{line}</li>)}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </RoleStandaloneView>
  );
}
