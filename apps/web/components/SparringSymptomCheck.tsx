'use client';

import { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import {
  SPARRING_SYMPTOMS,
  SPARRING_SYMPTOM_MESSAGE,
  SPARRING_SYMPTOM_NONE,
  SPARRING_SYMPTOM_QUESTION,
  SPARRING_SYMPTOM_SENT,
  sparringSymptomLabel,
  type SparringSymptom,
  type SparringSymptomContext,
} from '@/src/shared/sparringSymptoms';

// The sparring symptom flag on the athlete's own screens (Jason 2026-10-18).
// 'after_sparring' shows at check-out of a session tagged Sparring;
// 'next_day' shows on "How I feel today" only when the server says the
// athlete sparred the previous gym day. A FLAG ONLY: the athlete taps what
// they have, any tick sends their coach a flag, and the athlete sees one fixed
// message (plus the gym's own protocol words when it has some). Nothing is
// scored, counted or explained here. Copy PROPOSED.

interface ReportView {
  symptoms: SparringSymptom[];
}

interface TodayView {
  after_sparring: ReportView | null;
  next_day: ReportView | null;
  next_day_due: boolean;
  protocol_text: string;
}

export default function SparringSymptomCheck({ context }: { context: SparringSymptomContext }) {
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
      if (!response?.ok || cancelled) return;
      setToday((await response.json()) as TodayView);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!today) return null;
  if (context === 'next_day' && !today.next_day_due) return null;

  const saved = context === 'after_sparring' ? today.after_sparring : today.next_day;
  const question = SPARRING_SYMPTOM_QUESTION[context];
  const alreadyTicked = saved?.symptoms ?? [];

  const toggle = (symptom: SparringSymptom) => {
    setNone(false);
    setPicked((current) => (current.includes(symptom) ? current.filter((key) => key !== symptom) : [...current, symptom]));
  };

  // A failed send of a tick still owes the athlete the fixed message: their coach was not told.
  const failedMessage = none ? 'That was not saved. Try again.' : `That was not sent. ${SPARRING_SYMPTOM_MESSAGE}`;

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
      const payload = (await response.json()) as { item: ReportView; protocol_text: string };
      setToday((current) => {
        if (!current) return current;
        const protocolText = payload.protocol_text || current.protocol_text;
        return context === 'after_sparring'
          ? { ...current, protocol_text: protocolText, after_sparring: payload.item }
          : { ...current, protocol_text: protocolText, next_day: payload.item };
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
    <section className="space-y-[var(--s3)]" aria-label={question}>
      <h3 className="t-label">{question}</h3>

      {saved && alreadyTicked.length > 0 && (
        <div role="status" className="space-y-[var(--s2)]">
          <p className="t-data">You said: {alreadyTicked.map(sparringSymptomLabel).join(', ')}.</p>
          <p className="t-data">{SPARRING_SYMPTOM_MESSAGE}</p>
          {today.protocol_text.trim() !== '' && <p className="t-data">{today.protocol_text}</p>}
          <p style={{ fontSize: 'var(--t-sm)', color: 'var(--bone-400)' }}>{SPARRING_SYMPTOM_SENT}</p>
        </div>
      )}
      {saved && alreadyTicked.length === 0 && !adding && (
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
            {alreadyTicked.length === 0 && (
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
          <button
            type="button"
            onClick={() => void send()}
            disabled={saving || (!none && picked.length === 0)}
            className="btn btn--kiosk disabled:opacity-50 disabled:grayscale"
          >
            {saving ? 'Sending…' : 'Send'}
          </button>
        </>
      ) : (
        <button type="button" className="btn btn--ghost" onClick={() => setAdding(true)}>
          Something else now?
        </button>
      )}

      {error !== '' && <p className="t-data" role="alert">{error}</p>}
    </section>
  );
}
