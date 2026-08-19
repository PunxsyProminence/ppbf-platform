import type { ReactNode } from 'react';

/**
 * The seven-stamp refusal/status family (Jason-approved design doc
 * `02-Refusal-Stamps-TEETH.md`, "Ready for implement" as of 2026-08-19). One
 * shared component so every refusal, role-gate denial, and status surface in
 * the app draws from the same seven marks instead of each page inventing its
 * own error chrome -- exactly the failure mode Law 7 exists to prevent.
 *
 * HARD RULE (Jason's locked 2026-08-19 art policy -- do not deviate):
 * MEDICALLY_NOT_ALLOWED is the only kind that may use the red / --locked
 * treatment. Every other kind -- WAIT, GET_PERMISSION, WRONG_DOOR,
 * SIGNED_OUT, CANNOT_BE_DONE, and TRAINING_HOLD itself -- renders brass/bone,
 * even though Law 2 would technically allow --locked more broadly for a
 * refusal. This family is deliberately tighter than the general rule: a
 * coach who is not scoped to an athlete and a same-day medical hold must
 * never wear the same colour of "no".
 *
 * This component only draws the mark and its copy. It does not fetch, does
 * not decide whether a refusal applies, and is not wired into any page yet --
 * callers (login, /shadow, role gates, TrainingHoldBanner's own future
 * refactor) own that decision.
 */

export type RefusalStampKind =
  | 'wait'
  | 'get_permission'
  | 'medically_not_allowed'
  | 'wrong_door'
  | 'signed_out'
  | 'cannot_be_done'
  | 'training_hold';

interface SimpleStampCopy {
  readonly label: string;
  readonly glyph: string;
  readonly body: (detail?: string) => string;
}

/**
 * Six of the seven stamps are a fixed uppercase label plus one line of body
 * copy. `detail` (e.g. WAIT's "[time]", WRONG_DOOR's destination) is always
 * appended to the standard sentence rather than replacing it, so a caller
 * that forgets to pass it still gets a complete, correct refusal instead of
 * a dangling clause.
 *
 * Glyphs are chosen so the shape alone -- with no colour at all -- still
 * tells the six non-medical stamps apart from each other and, above all,
 * from MEDICALLY_NOT_ALLOWED's cross. Law 3: colour is never the only
 * channel, so the glyph plus the uppercase label both have to carry the
 * meaning on their own.
 */
export const REFUSAL_STAMP_COPY: Record<Exclude<RefusalStampKind, 'training_hold'>, SimpleStampCopy> = {
  wait: {
    label: 'WAIT',
    glyph: '◷', // ◷ -- a clock quadrant, time passing
    body: (detail) => (detail ? `Too soon — try again in ${detail}.` : 'Too soon — try again shortly.'),
  },
  get_permission: {
    label: 'GET PERMISSION',
    glyph: '◈', // ◈ -- a request handed to someone else, not yet resolved
    body: (detail) =>
      detail ? `Someone else must act first — ${detail}.` : 'Someone else must act first.',
  },
  medically_not_allowed: {
    label: 'MEDICALLY NOT ALLOWED',
    glyph: '✕', // ✕ -- matches the existing rejected/locked glyph elsewhere in the app
    body: (detail) =>
      detail
        ? `Not allowed for safety or medical reasons — ${detail}.`
        : 'Not allowed for safety or medical reasons.',
  },
  wrong_door: {
    label: 'WRONG DOOR',
    glyph: '⌂', // ⌂ -- a house/door glyph, literally "wrong door"
    body: (detail) =>
      detail
        ? `Not available for this role — ${detail}.`
        : 'Not available for this role. Return to your workspace.',
  },
  signed_out: {
    label: 'SIGNED OUT',
    glyph: '◻', // ◻ -- an empty frame, nothing left open
    body: (detail) => (detail ? `Your session ended — ${detail}.` : 'Your session ended.'),
  },
  cannot_be_done: {
    label: 'CANNOT BE DONE',
    glyph: '▲', // ▲ -- the caution triangle Law 3's own example already uses for a hard no
    body: (detail) =>
      detail ? `This action cannot be approved — ${detail}.` : 'This action cannot be approved.',
  },
};

export const TRAINING_HOLD_LABEL = 'TRAINING HOLD';
export const TRAINING_HOLD_GLYPH = '‖'; // ‖ -- pause bars: literally "on hold"

interface SimpleRefusalStampProps {
  readonly kind: Exclude<RefusalStampKind, 'training_hold'>;
  /** Optional context appended to the stamp's standard sentence -- WAIT's retry
   *  window, WRONG_DOOR's destination, and so on. Omit for the plain sentence. */
  readonly detail?: string;
  readonly className?: string;
}

interface TrainingHoldStampProps {
  readonly kind: 'training_hold';
  /** The coach's explanation, written for the athlete. Real data only -- see the throw below. */
  readonly coachExplanation: string;
  /** The actual name of whoever placed the hold. Real data only -- never a placeholder like "Coach". */
  readonly coachName: string;
  /** What has to happen for the hold to lift. Real data only. */
  readonly endsWhen: string;
  readonly className?: string;
}

export type RefusalStampProps = SimpleRefusalStampProps | TrainingHoldStampProps;

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * Renders one of the seven stamps. `kind: 'training_hold'` requires
 * `coachExplanation`, `coachName`, and `endsWhen`; every other kind takes an
 * optional `detail` string. See the module header for the colour rule.
 */
export default function RefusalStamp(props: RefusalStampProps): ReactNode {
  if (props.kind === 'training_hold') {
    return <TrainingHoldStamp {...props} />;
  }
  return <SimpleRefusalStampMark {...props} />;
}

function SimpleRefusalStampMark({ kind, detail, className }: SimpleRefusalStampProps) {
  const copy = REFUSAL_STAMP_COPY[kind];
  // The one and only red mark in the family (see the header comment). Every
  // other kind, including training_hold, stays brass -- `stamp` alone
  // already renders in --stamp-red, so medically_not_allowed is the sole
  // kind that takes the bare class.
  const stampClass = kind === 'medically_not_allowed'
    ? 'stamp stamp--kiosk'
    : 'stamp stamp--brass stamp--kiosk';

  return (
    <div
      role={kind === 'medically_not_allowed' ? 'alert' : 'status'}
      className={className}
      data-refusal-stamp={kind}
    >
      <span className={stampClass}>
        <i aria-hidden="true">{copy.glyph}</i>
        <span>{copy.label}</span>
      </span>
      {/* Law 5 kiosk minimum for the explanation, not just the mark itself --
          this may be the only text on a gym-floor tablet screen. */}
      <p className="text-[length:var(--t-md)] leading-relaxed mt-[var(--s3)]">{copy.body(detail)}</p>
    </div>
  );
}

/**
 * TRAINING HOLD is deliberately not shaped like the other six. It is a
 * filled record -- a coach's real explanation, their real name, and the real
 * condition that lifts it -- never a blank form standing in for one. Handed
 * an empty required field, it throws rather than silently rendering a mark
 * that LOOKS like a real hold but says nothing: a hold that reads as blank
 * tells an athlete "something is wrong and nobody will say what", which is
 * the opposite of the non-punitive, path-back intent TrainingHoldBanner
 * already established (see that component's own header comment).
 *
 * Deliberately brass and .stamp--flat, never tilted or red: this is not a
 * refusal being slammed down onto the page, it is a coach's note.
 */
function TrainingHoldStamp({ coachExplanation, coachName, endsWhen, className }: TrainingHoldStampProps) {
  if (isBlank(coachExplanation) || isBlank(coachName) || isBlank(endsWhen)) {
    throw new Error(
      'RefusalStamp kind="training_hold" requires real coachExplanation, coachName, and endsWhen -- ' +
        'it renders a filled record, never a blank form.',
    );
  }

  return (
    <div role="status" className={className} data-refusal-stamp="training_hold">
      <span className="stamp stamp--brass stamp--flat stamp--kiosk">
        <i aria-hidden="true">{TRAINING_HOLD_GLYPH}</i>
        <span>{TRAINING_HOLD_LABEL}</span>
      </span>
      <div className="mat-paper rounded-[var(--r-md)] border-2 border-[color:var(--brass-700)] p-[var(--s5)] mt-[var(--s3)] space-y-[var(--s3)]">
        <p className="t-eyebrow">A note from your coaches</p>
        <p className="text-[length:var(--t-md)] leading-relaxed">{coachExplanation}</p>
        <p className="text-[length:var(--t-md)] leading-relaxed">
          <span className="font-bold">Coach: </span>
          {coachName}
        </p>
        <p className="text-[length:var(--t-md)] leading-relaxed">
          <span className="font-bold">Ends when: </span>
          {endsWhen}
        </p>
        <p className="text-[length:var(--t-md)] leading-relaxed opacity-80">
          This is not a punishment — it is your coaches looking out for you. Talk to your coach or the
          gym admin if anything about it is unclear.
        </p>
      </div>
    </div>
  );
}
