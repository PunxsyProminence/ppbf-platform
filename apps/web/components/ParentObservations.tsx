'use client';

import React, { useEffect, useState } from 'react';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateTimeShort } from '@/src/lib/gymTime';
import {
  OBSERVATION_CATEGORIES,
  type ObservationCategory,
  type ParentObservationItem,
} from '@/src/shared/parentObservations';

/* THE GUARDIAN'S OBSERVATIONS TAB (WO-PH-04). A form to tell the coach what
   the family notices at home -- a category, an optional 1-10 rating, and the
   notes -- and the history of what this guardian has written about this
   child, from /api/pilot/parent/observations. The rating is optional by
   design (Q1 = B): "no rating" is the default and a real answer.

   The list is this guardian's own entries for the selected child, read per
   child, keyed and aborted on switch like every other per-child read on the
   hub. A read that did not answer is Unavailable, never "nothing written".
   A saved entry is shown from the server's answer, not from the form. */

type Loaded =
  | { athleteId: string; state: 'loaded'; items: ParentObservationItem[] }
  | { athleteId: string; state: 'failed' };

const CATEGORY_KEYS = Object.keys(OBSERVATION_CATEGORIES) as ObservationCategory[];

function isItem(value: unknown): value is ParentObservationItem {
  const row = value as Partial<ParentObservationItem> | null;
  return row !== null && typeof row === 'object'
    && typeof row.note_id === 'string'
    && typeof row.category === 'string' && row.category in OBSERVATION_CATEGORIES
    && (row.rating === null || (typeof row.rating === 'number' && Number.isInteger(row.rating)))
    && typeof row.notes === 'string'
    && typeof row.created_at === 'string';
}

export default function ParentObservations({ athleteId }: { readonly athleteId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [category, setCategory] = useState<ObservationCategory>('energy');
  const [rating, setRating] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<{ athleteId: string; tone: 'saved' | 'failed'; text: string } | null>(null);

  useEffect(() => {
    if (!athleteId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `${apiBase()}/api/pilot/parent/observations?athlete_id=${encodeURIComponent(athleteId)}`,
          { method: 'GET', credentials: 'include', signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const payload = response.ok
          ? (await response.json().catch(() => null)) as { items?: unknown } | null
          : null;
        if (controller.signal.aborted) return;
        if (!payload || !Array.isArray(payload.items) || !payload.items.every(isItem)) {
          setLoaded({ athleteId, state: 'failed' });
          return;
        }
        setLoaded({ athleteId, state: 'loaded', items: payload.items });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setLoaded({ athleteId, state: 'failed' });
      }
    })();
    return () => controller.abort();
  }, [athleteId]);

  const shown = loaded?.athleteId === athleteId ? loaded : null;
  const shownMessage = message?.athleteId === athleteId ? message : null;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (sending || !notes.trim()) return;
    // The child the form was filled in for, fixed now: a switch while the
    // write is out must not file it, or show it, under the sibling.
    const forAthlete = athleteId;
    setSending(true);
    setMessage(null);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/parent/observations`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athlete_id: forAthlete,
          category,
          rating: rating === '' ? null : Number(rating),
          notes: notes.trim(),
        }),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; item?: unknown } | null;
      if (!response.ok || payload?.ok !== true) {
        throw new Error(typeof payload?.error === 'string' && payload.error ? payload.error : 'It did not save.');
      }
      const item = isItem(payload.item) ? payload.item : null;
      setNotes('');
      setRating('');
      setMessage({ athleteId: forAthlete, tone: 'saved', text: 'Sent to the coach.' });
      if (item) {
        setLoaded((held) => (held && held.athleteId === forAthlete && held.state === 'loaded'
          ? { ...held, items: [item, ...held.items] }
          : held));
      }
    } catch (error) {
      setMessage({
        athleteId: forAthlete,
        tone: 'failed',
        text: `That did not save -- ${error instanceof Error ? error.message : 'the gym could not be reached'}. What you wrote is still in the box.`,
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-[var(--s5)]">
      <form onSubmit={handleSubmit} className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s3)]">
        <h3 className="t-label">Tell the coach what you notice</h3>
        <label className="field block">
          <span className="t-label">What it is about</span>
          <select
            className="select"
            value={category}
            onChange={(event) => setCategory(event.target.value as ObservationCategory)}
          >
            {CATEGORY_KEYS.map((key) => (
              <option key={key} value={key}>{OBSERVATION_CATEGORIES[key]}</option>
            ))}
          </select>
        </label>
        <label className="field block">
          <span className="t-label">Rating, if you want to give one (1 is low, 10 is high)</span>
          <select className="select" value={rating} onChange={(event) => setRating(event.target.value)}>
            <option value="">No rating</option>
            {Array.from({ length: 10 }, (_, index) => String(index + 1)).map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="field block">
          <span className="t-label">What you noticed</span>
          <textarea
            className="textarea min-h-[56px]"
            value={notes}
            maxLength={4000}
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        {shownMessage && (
          <p
            role={shownMessage.tone === 'failed' ? 'alert' : 'status'}
            className={shownMessage.tone === 'failed' ? 't-body font-bold text-[var(--restricted-ink)]' : 't-body'}
          >
            {shownMessage.text}
          </p>
        )}
        <button type="submit" className="btn w-full" disabled={sending || !notes.trim()}>
          {sending ? 'Sending…' : 'Send to Coach'}
        </button>
      </form>

      <section aria-labelledby="parent-observations-history" className="space-y-[var(--s3)]">
        <h3 id="parent-observations-history" className="t-label">What you have written</h3>
        {shown === null ? (
          <p className="working">Reading what you have written...</p>
        ) : shown.state === 'failed' ? (
          <p className="t-muted">Unavailable - your observations could not be read. This is not an empty list.</p>
        ) : shown.items.length === 0 ? (
          <p className="t-body">Nothing written about this child yet.</p>
        ) : (
          <ul className="space-y-[var(--s3)]">
            {shown.items.map((item) => (
              <li key={item.note_id} className="mat-paper rounded-[var(--r-md)] p-[var(--s4)] space-y-[var(--s2)]">
                <p className="t-body font-semibold">
                  {OBSERVATION_CATEGORIES[item.category]}
                  {item.rating !== null ? ` · ${item.rating} out of 10` : ''}
                </p>
                <p className="t-body whitespace-pre-line">{item.notes}</p>
                <p className="t-muted">{formatGymDateTimeShort(item.created_at) ?? item.created_at}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
