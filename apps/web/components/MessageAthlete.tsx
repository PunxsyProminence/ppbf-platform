'use client';

import { useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';

/**
 * MESSAGE THE ATHLETE (#1542, FC-06).
 *
 * On /coach/decision-loop, beside "Post to the Family's Page": a note the
 * selected athlete reads under "From your coach" on their Dashboard. It goes
 * through the existing coach-note write (intake/domain-upsert) with
 * note_type 'athlete_message'; that route admits coach and organization admin
 * and gates the athlete to the caller's own gym. Guardians do not read it
 * (FC-06 Q-2 default A). One send per press; a refused or failed send keeps
 * the words and says why. Rendered with key={athleteId}, so switching athletes
 * starts a fresh form and an answer for the athlete just left lands nowhere.
 */
export default function MessageAthlete({ athleteId }: Readonly<{ athleteId: string }>) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'sent' | 'failed'; text: string } | null>(null);
  const sendingRef = useRef(false);

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const words = text.trim();
    if (!athleteId || !words || sendingRef.current) return;
    sendingRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/intake/domain-upsert`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_type: 'coach_note',
          athlete_id: athleteId,
          payload: { note_type: 'athlete_message', note_text: words },
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        { ok?: boolean; error?: string; entity_type?: string; entity_id?: string; athlete_id?: string } | null;
      // Confirmed only when the answer names this note and this athlete.
      if (
        !response.ok
        || payload?.ok !== true
        || payload.entity_type !== 'coach_note'
        || !payload.entity_id
        || payload.athlete_id !== athleteId.trim()
      ) {
        throw new Error(typeof payload?.error === 'string' && payload.error ? payload.error : 'The message did not send.');
      }
      setText('');
      setNotice({ tone: 'sent', text: "Sent. It is on the athlete's Dashboard under From your coach." });
    } catch (error) {
      setNotice({
        tone: 'failed',
        text: `That message did not send -- ${(error instanceof Error && error.message ? error.message : 'the gym could not be reached').replace(/\.$/, '')}. Your words are still in the box.`,
      });
    } finally {
      sendingRef.current = false;
      setBusy(false);
    }
  }

  if (!athleteId) return null;

  return (
    <form onSubmit={(event) => void send(event)} className="mt-[var(--s4)] space-y-[var(--s3)]">
      <h3 className="t-label">Message the athlete</h3>
      <p className="t-muted">The athlete reads it on their Dashboard. Their family does not see it.</p>
      <label className="field">
        <span className="t-label">Message to the athlete</span>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          className="textarea h-20 resize-y"
          disabled={busy}
        />
      </label>
      {notice ? (
        <p role={notice.tone === 'failed' ? 'alert' : 'status'} className="t-body">{notice.text}</p>
      ) : null}
      <button type="submit" className="btn btn--ghost" disabled={busy || !text.trim()}>
        {busy ? 'Sending…' : 'Send to athlete'}
      </button>
    </form>
  );
}
