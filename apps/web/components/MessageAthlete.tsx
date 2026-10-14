'use client';

import { useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymDateTimeShort } from '@/src/lib/gymTime';

/**
 * MESSAGE THE ATHLETE (#1542, FC-06).
 *
 * On /coach/decision-loop, in its own section after the family's page: a note the
 * selected athlete reads under "From your coach" on their Dashboard. It goes
 * through the existing coach-note write (intake/domain-upsert) with
 * note_type 'athlete_message'; that route admits coach and organization admin
 * and gates the athlete to the caller's own gym. Guardians do not read it
 * (FC-06 Q-2 default A). One send per press; a refused or failed send keeps
 * the words and says why. Rendered with key={athleteId}, so switching athletes
 * starts a fresh form and an answer for the athlete just left lands nowhere.
 *
 * SENT TO THIS ATHLETE: under the form, what the gym's staff have written to
 * this athlete, newest first (GET /api/pilot/coach/athlete-messages), read
 * when the form opens and again after each send -- so a coach whose
 * confirmation was lost (a switch mid-send) sees the message landed instead of
 * sending it twice, and the gym can see what was written to a child.
 */
interface SentMessage {
  note_id: string;
  note_text: string;
  created_at: string;
  from_name: string;
}

type SentState = { state: 'loading' } | { state: 'failed' } | { state: 'loaded'; items: SentMessage[] };

const PAGE_SIZE = 10;
export default function MessageAthlete({ athleteId }: Readonly<{ athleteId: string }>) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'sent' | 'failed'; text: string } | null>(null);
  const sendingRef = useRef(false);
  const [sent, setSent] = useState<SentState>({ state: 'loading' });
  const [sentReads, setSentReads] = useState(0);
  const [shownCount, setShownCount] = useState(PAGE_SIZE);

  useEffect(() => {
    if (!athleteId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `${apiBase()}/api/pilot/coach/athlete-messages?athlete_id=${encodeURIComponent(athleteId)}`,
          { credentials: 'include', signal: controller.signal },
        );
        const payload = (await response.json().catch(() => ({}))) as { items?: unknown };
        if (controller.signal.aborted) return;
        setSent(response.ok && Array.isArray(payload.items)
          ? { state: 'loaded', items: payload.items as SentMessage[] }
          : { state: 'failed' });
      } catch {
        if (!controller.signal.aborted) setSent({ state: 'failed' });
      }
    })();
    return () => controller.abort();
  }, [athleteId, sentReads]);

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
      setSentReads((count) => count + 1);
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
    <form onSubmit={(event) => void send(event)} className="space-y-[var(--s3)]">
      <h2 className="t-command text-[length:var(--t-lg)]">Message the Athlete</h2>
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

      <h4 className="t-label">Sent to this athlete</h4>
      {sent.state === 'loading' ? (
        <p className="t-muted">Loading what was sent…</p>
      ) : sent.state === 'failed' ? (
        <p role="alert" className="t-body">
          What was sent to this athlete could not be loaded. This is not a statement that nothing was sent.
        </p>
      ) : sent.items.length === 0 ? (
        <p className="t-muted">Nothing has been sent to this athlete yet.</p>
      ) : (
        <>
        <ul aria-label="Sent to this athlete" className="space-y-[var(--s2)]">
          {sent.items.slice(0, shownCount).map((message) => (
            <li key={message.note_id} className="rounded-[var(--r-md)] mat-leather--raised p-[var(--s3)]">
              <p className="t-body whitespace-pre-wrap break-words">{message.note_text}</p>
              <p className="t-muted mt-[var(--s1)]">
                {message.from_name} · {formatGymDateTimeShort(message.created_at) ?? message.created_at}
              </p>
            </li>
          ))}
        </ul>
        {sent.items.length > shownCount ? (
          <button type="button" className="btn btn--ghost" onClick={() => setShownCount((count) => count + PAGE_SIZE)}>
            Show {Math.min(PAGE_SIZE, sent.items.length - shownCount)} more ({sent.items.length - shownCount} older)
          </button>
        ) : null}
        </>
      )}
    </form>
  );
}
