/**
 * THE SAMPLE-DATA NOTICE — what a page says when its numbers are invented.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * Six capability consoles render today with zero fetch calls between them:
 * macro-analytics, board/dashboard, communications, curriculum,
 * coach/operations, retro-lab. Every figure on all six is a hardcoded array.
 * That was a known, deliberate staging decision -- the shells shipped ahead of
 * the data -- and it is not a problem by itself.
 *
 * It became a problem because nothing on the page said so. BoardViewportSwitcher
 * renders budget lines (allocatedUsd 125000, spentUsd 84220), a grant pipeline
 * with named funds and projected dollars, and policy risk scores.
 * MacroCommandCenter renders SafeSport and background-check statuses
 * ("Cleared - 2026 cycle"). A board member reading a budget figure, or an
 * administrator reading a clearance status, had nothing telling them the number
 * was invented -- on a page whose whole visual grammar says "this is your
 * organization's data."
 *
 * The platform's own standard elsewhere is to render NOTHING rather than fake
 * content: the gym wall shows an empty frame until a real photograph lands, and
 * gymSayings ships an empty array so the sign stays blank until a coach
 * actually says something. These six consoles are the exception, and while they
 * remain the exception they have to say what they are.
 *
 * ---------------------------------------------------------------------------
 * WHY A STAMP
 * ---------------------------------------------------------------------------
 *
 * Law 7: a refusal is a stamp, not an error toast. This is not a refusal, but
 * it is governance speaking, and it uses the same voice for the same reason --
 * a stamp is a thing pressed onto a document by a person with the authority to
 * press it, and it does not look dismissible. .stamp--brass --flat is the
 * family the prototype consoles already use for "Planned — Not Yet
 * Implemented"; this stays in it rather than inventing a warning treatment.
 *
 * Deliberately NOT saturated colour. Law 2 spends red and amber on a
 * participant's safety state. A page admitting its own figures are samples is
 * not a safety event, and dressing it as one would spend the ladder that has to
 * still mean something when a child is actually at risk.
 *
 * `realHref`/`realLabel` are optional and exist because "these numbers are
 * invented" and "your real numbers are here" should read as one message rather
 * than two stacked warnings -- an admin who has just been told to distrust the
 * page needs somewhere to go, in the same breath. Set only where a real
 * counterpart actually ships today; a link to a surface that does not exist is
 * the same failure this component was written to fix.
 */

import Link from 'next/link';

interface SampleDataNoticeProps {
  /** What this specific page fabricates, in the gym's plain voice. One line. */
  readonly what: string;
  /** Route to the real records, when a real counterpart actually ships today. */
  readonly realHref?: string;
  /** How the real surface is named to a reader. Required with realHref. */
  readonly realLabel?: string;
}

export default function SampleDataNotice({ what, realHref, realLabel }: SampleDataNoticeProps) {
  return (
    <div
      // A note, not an alert: assistive tech should read it in document order
      // with the rest of the page, not interrupt to announce it. Nothing here
      // is time-critical -- it is a standing property of the screen.
      role="note"
      className="mx-auto mb-[var(--s4)] max-w-6xl space-y-[var(--s2)] px-[var(--s4)] pt-[var(--s4)]"
    >
      <p>
        <span className="stamp stamp--brass stamp--flat">Planned — Not Yet Implemented</span>
      </p>
      <p className="t-body max-w-4xl">
        Every figure below is fabricated sample data. {what}
        {realHref && realLabel ? (
          <>
            {' '}
            The organization&rsquo;s real records are at{' '}
            <Link className="underline" href={realHref}>
              {realLabel}
            </Link>
            .
          </>
        ) : null}
      </p>
    </div>
  );
}
