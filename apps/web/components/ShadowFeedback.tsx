'use client';

import { useId, useState } from 'react';

/**
 * Progressive feedback for one SHADOW answer.
 *
 * The old form was a required-reason textarea plus two rating buttons rendered
 * under every SHADOW bubble -- including the welcome, where it could only ever
 * be disabled. This component renders NOTHING unless the message is eligible
 * (a server-persisted assistant answer), and collects the signal in the shape
 * the mission specifies:
 *
 *   initial   ->  "Did this help?"  [Yes]  [Not yet]
 *   positive  ->  one action, submitted immediately, no comment required
 *                 (the feedback endpoint has always accepted a bare
 *                 {helpful, message_id} -- the reason requirement was
 *                 client-side only)
 *   negative  ->  a required reason from a fixed set, an optional detail
 *                 field, then Submit
 *
 * The reason code travels inside `comment` as a stable machine-readable
 * prefix ("[reason:incorrect] ...") because pilot.shadow_feedback has no
 * reason column yet; the additive `reason_code` column is documented as the
 * follow-on contract change. The code deliberately never rides
 * `outcome_signal` -- the human review queue's SQL allowlist would make such
 * rows permanently unapprovable.
 *
 * "Show more detail" is not represented here at all: asking for a deeper
 * answer is a conversation action, not negative feedback.
 */

export const SHADOW_FEEDBACK_REASONS = [
  { code: 'incorrect', label: 'Incorrect' },
  { code: 'unclear', label: 'Unclear' },
  { code: 'missing_information', label: 'Missing information' },
  { code: 'not_my_situation', label: 'Does not fit my situation' },
  { code: 'evidence_problem', label: 'Evidence problem' },
  { code: 'safety_concern', label: 'Safety concern' },
] as const;

export type ShadowFeedbackReasonCode = (typeof SHADOW_FEEDBACK_REASONS)[number]['code'];

/** How the reason code is serialized into the comment field, pinned for tests
 * and for whoever adds the real column later. */
export function encodeFeedbackComment(reasonCode: ShadowFeedbackReasonCode, detail: string): string {
  const trimmed = detail.trim();
  return trimmed ? `[reason:${reasonCode}] ${trimmed}` : `[reason:${reasonCode}]`;
}

interface ShadowFeedbackProps {
  readonly messageId: string;
  /** Server-persisted, rateable answer. Anything else renders nothing. */
  readonly eligible: boolean;
  readonly sent: boolean;
  readonly submitting: boolean;
  /**
   * A failure for THIS rating, shown at this rating. The page used to route
   * these to the session notice at the top of the surface -- above the saved
   * sessions, several hundred pixels from the button that had just failed --
   * so the visible result of a failed click was nothing at all.
   */
  readonly error?: string;
  readonly onSubmit: (helpful: boolean, comment?: string) => void;
}

export default function ShadowFeedback({ messageId, eligible, sent, submitting, error, onSubmit }: ShadowFeedbackProps) {
  const [phase, setPhase] = useState<'initial' | 'reason'>('initial');
  const [reasonCode, setReasonCode] = useState<ShadowFeedbackReasonCode | null>(null);
  const detailId = useId();
  const [detail, setDetail] = useState('');

  if (!eligible) {
    return null;
  }

  if (sent) {
    return (
      <p role="status" className="t-muted mt-[var(--s3)] border-t pt-[var(--s3)]">
        Feedback recorded.
      </p>
    );
  }

  if (phase === 'initial') {
    return (
      <div className="mt-[var(--s3)] flex flex-wrap items-center gap-[var(--s3)] border-t pt-[var(--s3)]">
        {/* A question put to a person, so it is set as a sentence. `.t-label`
            is the room's 11px uppercase field voice -- right above a text
            field, wrong for the one question this whole block exists to
            ask. */}
        <span className="t-body" id={`feedback-question-${messageId}`}>Did this help?</span>
        <button
          type="button"
          onClick={() => onSubmit(true)}
          disabled={submitting}
          aria-describedby={`feedback-question-${messageId}`}
          className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
        >
          Yes
        </button>
        <button
          type="button"
          onClick={() => setPhase('reason')}
          disabled={submitting}
          aria-describedby={`feedback-question-${messageId}`}
          className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
        >
          Not yet
        </button>
        {error ? <p role="alert" className="t-muted w-full text-[color:var(--restricted)]">{error}</p> : null}
      </div>
    );
  }

  return (
    <form
      className="mt-[var(--s3)] border-t pt-[var(--s3)]"
      onSubmit={(event) => {
        event.preventDefault();
        if (!reasonCode || submitting) return;
        onSubmit(false, encodeFeedbackComment(reasonCode, detail));
      }}
    >
      <fieldset>
        <legend className="t-body">What was wrong? Pick one.</legend>
        <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
          {SHADOW_FEEDBACK_REASONS.map((reason) => (
            <button
              key={reason.code}
              type="button"
              onClick={() => setReasonCode(reason.code)}
              aria-pressed={reasonCode === reason.code}
              disabled={submitting}
              className={`btn disabled:cursor-not-allowed disabled:opacity-60 ${reasonCode === reason.code ? '' : 'btn--ghost'}`}
            >
              {reason.label}
            </button>
          ))}
        </div>
      </fieldset>
      <label htmlFor={detailId} className="t-label mt-[var(--s3)] block">
        Anything else? Optional.
      </label>
      <textarea
        id={detailId}
        value={detail}
        onChange={(event) => setDetail(event.target.value)}
        disabled={submitting}
        rows={2}
        maxLength={1800}
        className="textarea mt-[var(--s1)] disabled:opacity-60"
      />
      <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
        <button
          type="submit"
          disabled={!reasonCode || submitting}
          className="btn disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Sending…' : 'Send feedback'}
        </button>
        <button
          type="button"
          onClick={() => {
            setPhase('initial');
            setReasonCode(null);
          }}
          disabled={submitting}
          className="btn btn--ghost disabled:opacity-60"
        >
          Back
        </button>
      </div>
      {error ? <p role="alert" className="t-muted mt-[var(--s3)] text-[color:var(--restricted)]">{error}</p> : null}
    </form>
  );
}
