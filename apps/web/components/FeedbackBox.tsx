"use client";

import { useId, useRef, useState } from 'react';
import { apiBase } from '@/lib/apiBase';

/**
 * The comment box, mounted in the global header so it is reachable from
 * wherever a signed-in person already is.
 *
 * IT LOOKS THE SAME FOR EVERYONE. There is no athlete variant, no warning, no
 * hint that some words are read more carefully than others. The only thing that
 * ever differs is the confirmation sentence, and that sentence is composed on
 * the server and rendered here verbatim -- this component is never told where a
 * submission went and has nothing to branch on.
 */

const FEEDBACK_KINDS = [
  { value: 'bug', label: 'Something is broken' },
  { value: 'frustration', label: 'Something is frustrating' },
  { value: 'idea', label: 'I have an idea' },
  { value: 'other', label: 'Something else' },
] as const;

const BODY_MAX_LENGTH = 4000;

export default function FeedbackBox() {
  const panelId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [kind, setKind] = useState<string>('bug');
  const [text, setText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [acknowledgement, setAcknowledgement] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const sendingRef = useRef(false);

  async function send() {
    // The insert has no natural key, so a second click while the first request
    // is still open files the same words twice.
    if (sendingRef.current) {
      return;
    }

    const body = text.trim();
    if (!body) {
      return;
    }

    sendingRef.current = true;
    setIsSending(true);
    setErrorMessage('');

    try {
      const response = await fetch(`${apiBase()}/api/pilot/feedback/submit`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, body }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        acknowledgement?: string;
      };

      if (!response.ok || !payload.acknowledgement) {
        // The typed words stay in the box. Losing what someone just worked up
        // the nerve to write is the one failure this must never add.
        throw new Error(payload.error || 'That did not send. Your words are still here, so you can try again.');
      }

      setAcknowledgement(payload.acknowledgement);
      setText('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'That did not send. Your words are still here, so you can try again.');
    } finally {
      sendingRef.current = false;
      setIsSending(false);
    }
  }

  function toggle() {
    setIsOpen((open) => {
      if (open) {
        return false;
      }
      setAcknowledgement('');
      setErrorMessage('');
      return true;
    });
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        aria-controls={panelId}
        /*
          Same geometry as every other control on this bar -- min-h-[var(--tap)]
          is 55px -- because this is the control a child taps to say someone
          hurt them, and it was the smallest thing in the header at 28.5px.

          The WCAG sweep that raised "every interactive target" edited this very
          file: it took the two buttons INSIDE the opened panel from 40px and
          42px to 44px, and never touched the one that opens it. So the two
          controls behind the door met the floor and the door did not.

          Not min-h-[44px], and not .btn--ghost (44px): its four siblings on
          this bar (Triage, Operations, the notification bell, Logout --
          GlobalRoleHeader) are all --tap in this exact style, and a 44px
          control beside four 55px ones is both harder to hit and visibly the
          odd one out.
        */
        className="inline-flex min-h-[var(--tap)] items-center rounded-[var(--r-sm)] border border-[color:rgba(212,175,74,.32)] bg-[rgba(0,0,0,.26)] px-[var(--s4)] font-mono text-[length:var(--t-xs)] uppercase tracking-[0.14em] text-[color:var(--bone-200)] transition hover:border-[color:var(--brass-400)] hover:text-[color:var(--bone-100)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
      >
        Tell Us
      </button>

      {isOpen ? (
        <div
          id={panelId}
          className="absolute right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] border border-[color:rgba(212,175,74,.28)] mat-leather p-4 shadow-[var(--shadow-md)]"
        >
          <h2 className="font-display text-lg tracking-tight">Tell us anything</h2>
          <p className="mt-1 text-xs leading-5 opacity-80">
            What is broken, what is annoying, what you wish this did, or anything else on your mind.
          </p>

          {acknowledgement ? (
            <div className="mt-4 space-y-3">
              <p className="border border-[color:rgba(212,175,74,.28)] mat-leather p-3 text-sm leading-6">
                {acknowledgement}
              </p>
              <button
                type="button"
                onClick={() => setAcknowledgement('')}
                className="min-h-[44px] w-full border border-[color:rgba(212,175,74,.28)] mat-leather px-3 text-xs font-bold uppercase tracking-[0.08em]"
              >
                Say something else
              </button>
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              <label className="block text-[11px] font-mono uppercase tracking-[0.14em] opacity-80">
                This is about
                <select
                  value={kind}
                  onChange={(event) => setKind(event.target.value)}
                  className="mt-1 h-11 w-full border border-[color:rgba(212,175,74,.28)] mat-leather px-2 text-sm normal-case tracking-normal"
                >
                  {FEEDBACK_KINDS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-[11px] font-mono uppercase tracking-[0.14em] opacity-80">
                In your own words
                <textarea
                  value={text}
                  maxLength={BODY_MAX_LENGTH}
                  onChange={(event) => setText(event.target.value)}
                  placeholder="Type it however it comes out."
                  className="mt-1 h-32 w-full border border-[color:rgba(212,175,74,.28)] mat-leather px-3 py-2 text-sm normal-case tracking-normal"
                />
              </label>

              {errorMessage ? (
                <p className="text-sm font-semibold text-[color:var(--brass-600)]">{errorMessage}</p>
              ) : null}

              <button
                type="button"
                disabled={isSending || !text.trim()}
                onClick={() => void send()}
                className="min-h-[44px] w-full border border-[color:rgba(212,175,74,.28)] btn px-4 text-sm font-black uppercase tracking-[0.12em] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSending ? 'Sending...' : 'Send'}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
