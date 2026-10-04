'use client';

import { useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric } from '@/src/lib/gymTime';

// Correcting a mistyped weight (Jason 2026-10-04, "Athlete or their coach").
// Shared by the athlete's check-in (their own entries) and the coach's body
// mass panel (their athlete's). Each entry the server lists as correctable
// gets its own "Correct"; the server validates the value and decides who may
// correct. The corrected-away entry stays on record and is not shown again.

export interface BodyMassEntryView {
  readonly observation_id: string;
  readonly pounds: number;
  readonly observed_at: string;
}

export interface CorrectionOutcome {
  readonly ok: boolean;
  readonly message: string;
}

/** Reads the summary's correctable_entries, dropping anything malformed. */
export function parseBodyMassEntries(value: unknown): BodyMassEntryView[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is BodyMassEntryView => !!entry
    && typeof entry.observation_id === 'string'
    && typeof entry.pounds === 'number'
    && Number.isFinite(entry.pounds)
    && typeof entry.observed_at === 'string');
}

/** POSTs one correction. `fields` carries the route's own keys. `payload` is
 *  the server's answer on success, null otherwise. */
export async function postBodyMassCorrection(
  path: string,
  fields: Record<string, string>,
  value: number,
  unit: 'lb' | 'kg',
): Promise<CorrectionOutcome & { payload: Record<string, unknown> | null }> {
  try {
    const response = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...fields, body_mass: value, body_mass_unit: unit }),
    });
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      return {
        ok: false,
        message: typeof payload?.error === 'string' ? payload.error : 'The correction was not saved. Try again.',
        payload: null,
      };
    }
    if (!payload) {
      return { ok: true, message: `Corrected to ${value} ${unit}. Reload to see it.`, payload: null };
    }
    return { ok: true, message: `Corrected to ${value} ${unit}. The earlier entry stays on record.`, payload };
  } catch {
    return { ok: false, message: 'The correction was not saved. Try again.', payload: null };
  }
}

function CorrectForm({ entry, onCorrect }: {
  entry: BodyMassEntryView;
  onCorrect: (entry: BodyMassEntryView, value: number, unit: 'lb' | 'kg') => Promise<CorrectionOutcome>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState<'lb' | 'kg'>('lb');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const when = formatGymDateNumeric(entry.observed_at) ?? entry.observed_at;
  const inputId = `body-mass-correction-${entry.observation_id}`;

  async function save() {
    const parsed = Number(value.trim());
    if (value.trim() === '' || !Number.isFinite(parsed)) {
      setMessage('Enter the correct weight as a number.');
      return;
    }
    setSaving(true);
    try {
      const outcome = await onCorrect(entry, parsed, unit);
      // Success is said by the list: the corrected entry is replaced by its
      // correction, so this row goes away. A refusal keeps the form and what
      // was typed, so "Try again" is one tap.
      if (outcome.ok) {
        setOpen(false);
        setValue('');
      } else {
        setMessage(outcome.message);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="space-y-[var(--s2)]">
      <div className="flex items-center gap-[var(--s2)]">
        <span className="t-data" style={{ fontSize: 'var(--t-sm)' }}>{entry.pounds} lb, logged {when}</span>
        {!open && (
          <button
            type="button"
            className="btn btn--kiosk btn--ghost"
            aria-label={`Correct the ${entry.pounds} lb entry from ${when}`}
            onClick={() => { setOpen(true); setMessage(''); }}
          >
            Correct
          </button>
        )}
      </div>
      {open && (
        <>
          <label className="t-label block" htmlFor={inputId}>Correct weight</label>
          <div className="flex gap-[var(--s2)]">
            <input
              id={inputId}
              type="number"
              inputMode="decimal"
              step="0.1"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="input input--kiosk"
            />
            <select
              aria-label="Correct weight unit"
              value={unit}
              onChange={(event) => setUnit(event.target.value === 'kg' ? 'kg' : 'lb')}
              className="input input--kiosk"
              style={{ width: 'auto' }}
            >
              <option value="lb">lb</option>
              <option value="kg">kg</option>
            </select>
          </div>
          <div className="flex gap-[var(--s2)]">
            <button type="button" className="btn btn--kiosk" disabled={saving} onClick={() => { void save(); }}>
              Save correction
            </button>
            <button type="button" className="btn btn--kiosk btn--ghost" disabled={saving} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
      {message !== '' && <p className="t-data" style={{ fontSize: 'var(--t-sm)' }} role="status">{message}</p>}
    </li>
  );
}

/** The correctable entries, newest first, each with its own "Correct". */
export function BodyMassEntryList({ entries, onCorrect }: {
  entries: readonly BodyMassEntryView[];
  onCorrect: (entry: BodyMassEntryView, value: number, unit: 'lb' | 'kg') => Promise<CorrectionOutcome>;
}) {
  const [notice, setNotice] = useState('');
  const correct = async (entry: BodyMassEntryView, value: number, unit: 'lb' | 'kg') => {
    const outcome = await onCorrect(entry, value, unit);
    setNotice(outcome.ok ? outcome.message : '');
    return outcome;
  };
  if (entries.length === 0 && notice === '') return null;
  return (
    <div className="space-y-[var(--s2)]" data-testid="body-mass-entries">
      {entries.length > 0 && <p className="t-label">Weigh-ins that can be corrected (last 8 days)</p>}
      <ul className="space-y-[var(--s2)]">
        {entries.map((entry) => <CorrectForm key={entry.observation_id} entry={entry} onCorrect={correct} />)}
      </ul>
      {notice !== '' && <p className="t-data" style={{ fontSize: 'var(--t-sm)' }} role="status">{notice}</p>}
    </div>
  );
}
