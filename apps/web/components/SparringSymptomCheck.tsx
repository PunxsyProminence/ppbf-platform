'use client';

import { useEffect, useId, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import {
  SPARRING_SYMPTOMS,
  SPARRING_SYMPTOM_MESSAGE,
  SPARRING_SYMPTOM_NONE,
  SPARRING_SYMPTOM_QUESTION,
  sparringSymptomLabel,
  sparringSymptomSentLine,
  type SparringSymptom,
  type SparringSymptomContext,
} from '@/src/shared/sparringSymptoms';

// The sparring symptom flag on the athlete's own screens (OD-2026-10-17-023
// item 1, OD-2026-10-17-029). 'after_sparring' shows on the Dashboard after
// check-out of a session tagged Sparring, until it is answered (the server
// says so after a refresh too); 'next_day' shows on "How I feel today" only
// when the server says the athlete sparred recently and has not been asked
// since. A FLAG ONLY: the athlete taps what they have, any tick sends the
// flag, and the athlete sees one fixed message (plus the gym's own protocol
// words when it has some). Nothing is scored, counted or explained here.
// Copy PROPOSED.

interface ReportView {
  symptoms: SparringSymptom[];
}

interface TodayView {
  after_sparring: ReportView | null;
  next_day: ReportView | null;
  after_sparring_due: boolean;
  next_day_due: boolean;
  protocol_text: string;
  recipient_role: string;
}

/** What the after-sparring check assumes when today's status cannot be read:
 * the athlete just checked out of sparring, so the question is asked anyway
 * and the save decides what was stored. */
const UNREAD_AFTER_CHECK_OUT: TodayView = {
  after_sparring: null,
  next_day: null,
  after_sparring_due: true,
  next_day_due: false,
  protocol_text: '',
  recipient_role: 'coach',
};

export default function SparringSymptomCheck({
  context,
  justCheckedOut = false,
}: {
  context: SparringSymptomContext;
  /** Set by the check-out that just closed a session tagged Sparring. */
  justCheckedOut?: boolean;
}) {
  const headingId = useId();
  const [today, setToday] = useState<TodayView | null>(null);
  const [picked, setPicked] = useState<SparringSymptom[]>([]);
  const [none, setNone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await fetch(`${apiBase()}/api/pilot/athlete/sparring-symptoms`, { credentials: 'include' }).catch(() => null);
      if (cancelled) return;
      if (response?.ok) {
        setToday((await response.json()) as TodayView);
      } else if (context === 'after_sparring' && justCheckedOut) {
        setToday(UNREAD_AFTER_CHECK_OUT);
      }
    })();
    return () => { cancelled = true; };
  }, [context, justCheckedOut]);

  if (!today) return null;
  const saved = context === 'after_sparring' ? today.after_sparring : today.next_day;
  const due = context === 'after_sparring' ? justCheckedOut || today.after_sparring_due : today.next_day_due;
  if (!due && !saved) return null;

  const question = SPARRING_SYMPTOM_QUESTION[context];
  const alreadyTicked = saved?.symptoms ?? [];
  // A failed send of a tick still owes the athlete the fixed message: nobody was told.
  const failedMessage = none ? 'That was not saved. Try again.' : `That was not sent. ${SPARRING_SYMPTOM_MESSAGE}`;

  const toggle = (symptom: SparringSymptom) => {
    setNone(false);
    setPicked((current) => (current.includes(symptom) ? current.filter((key) => key !== symptom) : [...current, symptom]));
  };

  const send = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/athlete/sparring-symptoms`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context, symptoms: none ? [] : picked }),
      });
      if (!response.ok) {
        // Nothing is shown as sent until the server says so.
        setError(failedMessage);
        return;
      }
      const payload = (await response.json()) as { item: ReportView; protocol_text: string; recipient_role: string };
      setToday((current) => {
        if (!current) return current;
        const settings = { protocol_text: payload.protocol_text, recipient_role: payload.recipient_role };
        return context === 'after_sparring'
          ? { ...current, ...settings, after_sparring: payload.item }
          : { ...current, ...settings, next_day: payload.item };
      });
      setPicked([]);
      setNone(false);
      setAdding(false);
    } catch {
      setError(failedMessage);
    } finally {
      setSaving(false);
    }
  };

  const showList = !saved || adding;

  return (
    <section className="space-y-[var(--s3)]" aria-labelledby={headingId}>
      <h3 className="t-label" id={headingId}>{question}</h3>

      {saved && alreadyTicked.length > 0 && (
        <div role="status" className="space-y-[var(--s2)]">
          <p className="t-data">You said: {alreadyTicked.map(sparringSymptomLabel).join(', ')}.</p>
          <p className="t-data">{SPARRING_SYMPTOM_MESSAGE}</p>
          {today.protocol_text.trim() !== '' && <p className="t-data">{today.protocol_text}</p>}
          <p style={{ fontSize: 'var(--t-sm)', color: 'var(--bone-400)' }}>{sparringSymptomSentLine(today.recipient_role)}</p>
        </div>
      )}
      {saved && alreadyTicked.length === 0 && (
        <p className="t-data" role="status">Saved: none of these.</p>
      )}

      {showList ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--s2)]">
            {SPARRING_SYMPTOMS.filter((symptom) => !alreadyTicked.includes(symptom.key)).map((symptom) => (
              <button
                key={symptom.key}
                type="button"
                aria-pressed={picked.includes(symptom.key)}
                aria-label={`${question} ${symptom.label}`}
                onClick={() => toggle(symptom.key)}
                className={`btn btn--kiosk ${picked.includes(symptom.key) ? '' : 'btn--ghost'} text-left`}
              >
                {symptom.label}
              </button>
            ))}
            {!saved && (
              <button
                type="button"
                aria-pressed={none}
                aria-label={`${question} ${SPARRING_SYMPTOM_NONE}`}
                onClick={() => { setNone(true); setPicked([]); }}
                className={`btn btn--kiosk ${none ? '' : 'btn--ghost'} text-left`}
              >
                {SPARRING_SYMPTOM_NONE}
              </button>
            )}
          </div>
          <div className="flex gap-[var(--s2)]">
            <button
              type="button"
              onClick={() => void send()}
              disabled={saving || (!none && picked.length === 0)}
              className="btn btn--kiosk disabled:opacity-50 disabled:grayscale"
            >
              {saving ? 'Sending…' : 'Send'}
            </button>
            {adding && (
              <button type="button" className="btn btn--ghost" onClick={() => { setAdding(false); setPicked([]); }}>
                Back
              </button>
            )}
          </div>
          {!none && picked.length === 0 && (
            <p style={{ fontSize: 'var(--t-sm)', color: 'var(--bone-400)' }}>
              {saved ? 'Tap anything new, then Send.' : `Tap what you have, or ${SPARRING_SYMPTOM_NONE.toLowerCase()}, then Send.`}
            </p>
          )}
        </>
      ) : (
        <button type="button" className="btn btn--ghost" onClick={() => setAdding(true)}>
          {context === 'next_day' ? 'Something else today?' : 'Something else now?'}
        </button>
      )}

      {error !== '' && <p className="t-data" role="alert">{error}</p>}
    </section>
  );
}
