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
        className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-1 text-[11px] font-mono text-[var(--black)] transition hover:bg-[var(--olive-dark)] hover:text-[var(--white)]"
      >
        Tell Us
      </button>

      {isOpen ? (
        <div
          id={panelId}
          className="absolute right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] p-4 shadow-[var(--shadow-md)]"
        >
          <h2 className="font-display text-lg tracking-tight text-[var(--black)]">Tell us anything</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--gray-dark)]">
            What is broken, what is annoying, what you wish this did, or anything else on your mind.
          </p>

          {acknowledgement ? (
            <div className="mt-4 space-y-3">
              <p className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-3 text-sm leading-6 text-[var(--black)]">
                {acknowledgement}
              </p>
              <button
                type="button"
                onClick={() => setAcknowledgement('')}
                className="min-h-[44px] w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[var(--black)]"
              >
                Say something else
              </button>
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
                This is about
                <select
                  value={kind}
                  onChange={(event) => setKind(event.target.value)}
                  className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 text-sm normal-case tracking-normal text-[var(--black)]"
                >
                  {FEEDBACK_KINDS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
                In your own words
                <textarea
                  value={text}
                  maxLength={BODY_MAX_LENGTH}
                  onChange={(event) => setText(event.target.value)}
                  placeholder="Type it however it comes out."
                  className="mt-1 h-32 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2 text-sm normal-case tracking-normal text-[var(--black)]"
                />
              </label>

              {errorMessage ? (
                <p className="text-sm font-semibold text-[var(--red-primary)]">{errorMessage}</p>
              ) : null}

              <button
                type="button"
                disabled={isSending || !text.trim()}
                onClick={() => void send()}
                className="min-h-[44px] w-full border-2 border-[var(--black)] bg-[var(--red-primary)] px-4 text-sm font-black uppercase tracking-[0.12em] text-[var(--white)] disabled:cursor-not-allowed disabled:opacity-50"
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
