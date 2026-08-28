'use client';

import { useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import {
  MINIMAL_CHECK_IN_KEYS,
  SLEEP_HOURS_TYPICAL_MAX,
  SLEEP_HOURS_TYPICAL_MIN,
  WELLNESS_SCALES,
  type WellnessScale,
  type WellnessScaleKey,
  wellnessAnchor,
} from '@/src/shared/wellnessScales';

// The athlete's own "I'm here, and this is how I am".
//
// Extracted from AthleteWorkspace rather than edited in place: the panel this
// replaces was ~70 lines of sliders bound to local React state that persisted
// NOTHING, inside a 3,000-line component. It was pulled from the navigation on
// 2026-08-21 for exactly that reason, with a written way back -- "each comes
// back by adding its entry here once something stores what it collects" -- and
// /api/pilot/athlete/check-in is now what stores it.
//
// TWO RULES FROM docs/design/CHECKIN_API_CONTRACT.md SHAPE THE WHOLE FILE:
//
// 1. OMITTED MEANS OMITTED. "The UI must not default a skipped slider to a
//    value, and must render stored null as 'not reported', never as 0 or 3."
//    The old panel could not honour this: an HTML range input always has a
//    position, so its sliders sat at 8, 7, 2 and 8 whether or not the child
//    touched them, and any save would have recorded four opinions nobody
//    held. The scales here are five labelled BUTTONS instead. Nothing is
//    selected until the athlete selects it, `answers` starts empty, and only
//    keys present in it are sent -- so a skipped question is absent in the
//    request, not defaulted in it.
//
// 2. SELF-REPORTS ARE NOT READINESS SCORES. Nothing here is rendered on a
//    GREEN/YELLOW/RED scale, and nothing here feeds getReadinessLevel. The
//    anchors are plain descriptions of what a number means, never verdicts on
//    the child who picked it.
//
// The anchors and the 1-5 bounds come from src/shared/wellnessScales.ts, which
// the SERVER validates against too. That is the point of it being shared: the
// words a child reads and the number stored in the column cannot drift apart.

export interface AthleteCheckInRecord {
  check_in_id: string;
  checked_in_on: string;
  energy: number | null;
  soreness: number | null;
  focus: number | null;
  sleep_hours: number | null;
  hydration: number | null;
  motivation: number | null;
  mental_clarity: number | null;
  stress: number | null;
  nutrition_compliance: number | null;
  note: string;
}

interface Props {
  /** Today's stored check-in, or null when the athlete has not checked in. */
  today: AthleteCheckInRecord | null;
  /** The athlete's own recent history, newest first. Never cross-athlete. */
  recent: AthleteCheckInRecord[];
  loading: boolean;
  /** Why the record could not be read, if it could not. */
  loadError: string | null;
  onSaved: (row: AthleteCheckInRecord) => void;
}

const MINIMAL_SCALES = WELLNESS_SCALES.filter((scale) => MINIMAL_CHECK_IN_KEYS.includes(scale.key));
const EXTENDED_SCALES = WELLNESS_SCALES.filter((scale) => !MINIMAL_CHECK_IN_KEYS.includes(scale.key));

/** One 1-5 question, rendered as five described choices. */
function ScaleQuestion({
  scale,
  value,
  onPick,
}: {
  scale: WellnessScale;
  value: number | undefined;
  onPick: (value: number) => void;
}) {
  return (
    <fieldset className="space-y-[var(--s2)]">
      <legend className="t-label mb-[var(--s2)]">{scale.question}</legend>
      <div className="grid grid-cols-1 sm:grid-cols-5 gap-[var(--s2)]">
        {scale.anchors.map((anchor, index) => {
          const choice = index + 1;
          const selected = value === choice;
          return (
            <button
              key={anchor}
              type="button"
              // The anchor is the accessible name, not the bare number: a
              // screen reader announcing "3" tells a child nothing, which is
              // the whole defect the owner asked to fix.
              aria-label={`${scale.question} ${choice}: ${anchor}`}
              aria-pressed={selected}
              onClick={() => onPick(choice)}
              className={`btn btn--kiosk ${selected ? '' : 'btn--ghost'} text-left`}
            >
              <span className="t-data block" style={{ fontSize: 'var(--t-sm)' }}>{choice}</span>
              <span className="block" style={{ fontSize: 'var(--t-sm)' }}>{anchor}</span>
            </button>
          );
        })}
      </div>
      {value === undefined && (
        // Said out loud rather than implied by an unselected row: skipping is
        // legal, and a child should not think they have failed to do something.
        <p style={{ fontSize: 'var(--t-sm)', color: 'var(--bone-400)' }}>
          Not answered — you can skip this.
        </p>
      )}
    </fieldset>
  );
}

/** What the athlete already told us today, in the words they picked. */
function StoredAnswers({ record }: { record: AthleteCheckInRecord }) {
  const reported = WELLNESS_SCALES
    .map((scale) => ({ scale, anchor: wellnessAnchor(scale.key, record[scale.key]) }))
    .filter((entry) => entry.anchor !== null);

  return (
    <div className="space-y-[var(--s3)]">
      {record.sleep_hours !== null && (
        <p className="t-data" style={{ fontSize: 'var(--t-sm)' }}>
          Sleep: {record.sleep_hours} hours
        </p>
      )}
      {reported.map(({ scale, anchor }) => (
        <p key={scale.key} className="t-data" style={{ fontSize: 'var(--t-sm)' }}>
          {scale.question} {anchor}
        </p>
      ))}
      {reported.length === 0 && record.sleep_hours === null && (
        // A bare check-in is a real check-in. "I'm here" on its own is the
        // whole point of every field being optional.
        <p style={{ fontSize: 'var(--t-sm)', color: 'var(--bone-400)' }}>
          You checked in without answering the questions — that counts.
        </p>
      )}
      {record.note.trim() !== '' && (
        <p className="t-data" style={{ fontSize: 'var(--t-sm)' }}>Note: {record.note}</p>
      )}
    </div>
  );
}

export default function AthleteCheckInPanel({ today, recent, loading, loadError, onSaved }: Props) {
  // Starts EMPTY. A key appears only when the athlete picks a value, and only
  // the keys present here are sent -- this object IS rule 1 above.
  const [answers, setAnswers] = useState<Partial<Record<WellnessScaleKey, number>>>({});
  const [sleepHours, setSleepHours] = useState('');
  const [note, setNote] = useState('');
  const [showExtended, setShowExtended] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const pick = (key: WellnessScaleKey) => (value: number) =>
    setAnswers((current) => ({ ...current, [key]: value }));

  const handleSubmit = async () => {
    setSaving(true);
    setSaveError('');
    try {
      const body: Record<string, number | string> = { ...answers };
      const trimmedSleep = sleepHours.trim();
      if (trimmedSleep !== '') {
        const parsed = Number(trimmedSleep);
        if (!Number.isFinite(parsed)) {
          setSaveError('Sleep must be a number of hours, or left blank.');
          return;
        }
        body.sleep_hours = parsed;
      }
      const trimmedNote = note.trim();
      if (trimmedNote !== '') body.note = trimmedNote;

      const response = await fetch(`${apiBase()}/api/pilot/athlete/check-in`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        // NOTHING IS SHOWN AS SAVED UNTIL THE SERVER SAYS SO. The pain card
        // above this one carries the same rule for the same reason: an
        // optimistic "you checked in" that did not reach anyone is worse than
        // a visible failure, because the child stops trying.
        const payload = await response.json().catch(() => ({}));
        setSaveError(
          typeof payload?.error === 'string'
            ? payload.error
            : 'Check-in was not saved. Try again, and tell a coach you are here.',
        );
        return;
      }

      const payload = await response.json();
      onSaved(payload.item as AthleteCheckInRecord);
    } catch {
      setSaveError('Check-in was not saved. Try again, and tell a coach you are here.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="t-data">Loading your check-in…</p>;
  }

  if (loadError) {
    // Honest absence, never an empty form that would silently double-write.
    return (
      <div className={`${PANEL_RAISED_CLASS} space-y-[var(--s3)]`}>
        <h3 className="t-label">Check-In</h3>
        <p className="t-data">{loadError}</p>
      </div>
    );
  }

  if (today) {
    return (
      <div className="space-y-6 panel-settle">
        <div className={`${PANEL_RAISED_CLASS} space-y-[var(--s4)]`}>
          <h3 className="t-label">Already checked in today</h3>
          <p className="t-data" style={{ fontSize: 'var(--t-sm)' }}>
            You checked in on {today.checked_in_on}. Your workout and tasks are open.
          </p>
          <StoredAnswers record={today} />
        </div>

        {recent.length > 1 && (
          <div className={`${PANEL_RAISED_CLASS} space-y-[var(--s3)]`}>
            <h3 className="t-label">Your recent check-ins</h3>
            {/* The athlete's OWN history. Never comparable across athletes,
                and deliberately no streak counter or shame framing -- the
                contract's engagement rules apply to anything built on this. */}
            {recent.slice(0, 14).map((record) => (
              <p key={record.check_in_id} className="t-data" style={{ fontSize: 'var(--t-sm)' }}>
                {record.checked_in_on}
              </p>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6 panel-settle">
      <div className={`${PANEL_RAISED_CLASS} space-y-[var(--s5)]`}>
        <h3 className="t-label">Check in</h3>
        <p style={{ fontSize: 'var(--t-sm)', color: 'var(--bone-300)' }}>
          Tell us you are here. Every question is optional — you can check in without
          answering any of them.
        </p>

        {MINIMAL_SCALES.map((scale) => (
          <ScaleQuestion
            key={scale.key}
            scale={scale}
            value={answers[scale.key]}
            onPick={pick(scale.key)}
          />
        ))}

        <div className="space-y-[var(--s2)]">
          <label className="t-label block" htmlFor="check-in-sleep">
            How many hours did you sleep?
          </label>
          {/* Hours are a QUANTITY, so this is a number and not a 1-5 rating:
              giving sleep anchor text would turn something measured into
              something judged. Blank means not answered. */}
          <input
            id="check-in-sleep"
            type="number"
            inputMode="decimal"
            step="0.5"
            min={SLEEP_HOURS_TYPICAL_MIN}
            max={SLEEP_HOURS_TYPICAL_MAX}
            value={sleepHours}
            placeholder="Leave blank to skip"
            onChange={(event) => setSleepHours(event.target.value)}
            className="input input--kiosk"
          />
        </div>

        <button
          type="button"
          onClick={() => setShowExtended((current) => !current)}
          className="btn btn--kiosk btn--ghost"
          aria-expanded={showExtended}
        >
          {showExtended ? '− Fewer questions' : '+ Add more detail'}
        </button>

        {showExtended && (
          <div className="space-y-[var(--s5)] pt-[var(--s4)] border-t-2 border-[color:var(--brass-700)]">
            {EXTENDED_SCALES.map((scale) => (
              <ScaleQuestion
                key={scale.key}
                scale={scale}
                value={answers[scale.key]}
                onPick={pick(scale.key)}
              />
            ))}

            <div className="space-y-[var(--s2)]">
              <label className="t-label block" htmlFor="check-in-note">
                Anything else you want your coach to know?
              </label>
              <textarea
                id="check-in-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                className="input input--kiosk"
              />
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={saving}
          className="btn btn--kiosk disabled:opacity-50 disabled:grayscale"
        >
          {saving ? 'Checking in…' : 'Check in'}
        </button>

        {saveError !== '' && <p className="t-data">{saveError}</p>}

        <p style={{ fontSize: 'var(--t-sm)', color: 'var(--bone-400)' }}>
          {/* Said plainly, because the contract forbids presenting this as
              attendance and a child should know what it is and is not. */}
          This is not your attendance record — a coach still marks you in.
        </p>
      </div>
    </div>
  );
}

// Kept local rather than imported: AthleteWorkspace declares the same string
// as a module-private constant, and exporting it from a 3,000-line component
// to share four words would couple this file to that one's internals.
const PANEL_RAISED_CLASS = 'mat-leather--raised rounded-[var(--r-lg)] p-[var(--s5)]';
