'use client';

/**
 * THE OPT-IN.
 *
 * Sound in this platform is off until somebody asks for it, and asking has to
 * happen inside a click — no browser starts audio otherwise. So the opt-in is
 * a button, and the button is the gesture.
 *
 * WHERE IT LIVES. On the session bar, beside the other quiet controls: it is
 * on every signed-in surface, so anyone who wants it can find it, and it says
 * one short thing rather than advertising itself. It is deliberately NOT on the
 * check-in screen, where a control that appears next to a reward reads as a
 * prompt to turn it on.
 *
 * IT DOES NOT LIE. Four states, not two. "Asked for" and "working" are
 * different facts: a browser that refuses to start audio gets "No audio", not
 * an on switch that does nothing, and a page that has not been touched since
 * reload says "waiting" rather than claiming to be live.
 *
 * LAW 3. Every state carries a glyph AND a word. Nothing here is legible only
 * by colour, and the pressed state is on the element for a screen reader too.
 *
 * WHAT IT COSTS TO LEAVE OFF: nothing. Every sound in this app sits beside a
 * visible change that already carries the whole message, which is what the
 * label says.
 */

import useGymSound, { type GymSoundStatus } from './useGymSound';

interface Face {
  readonly glyph: string;
  readonly label: string;
  readonly title: string;
}

const FACES: Record<GymSoundStatus, Face> = {
  off: {
    glyph: '○',
    label: 'Sound off',
    title:
      'Sound is off. Turn it on and the gym confirms a check-in and rings the bell when you cross a milestone. '
      + 'Nothing on screen needs sound to be understood, and the gym floor is loud — leaving this off costs you nothing.',
  },
  arming: {
    glyph: '◐',
    label: 'Sound waiting',
    title:
      'Sound is on, but your browser will not start audio until you touch the page. '
      + 'It goes live on your next tap or key press.',
  },
  on: {
    glyph: '◉',
    label: 'Sound on',
    title: 'Sound is on. A check-in is confirmed, and the bell rings when you cross a milestone.',
  },
  unavailable: {
    glyph: '✕',
    label: 'No audio',
    title:
      'This browser would not start audio, so sound stays off here. '
      + 'Everything the sound would have confirmed is already on the screen.',
  },
};

/* Brass chassis, matching the other controls on the session bar. The
   text-[length:...] hint is not optional in Tailwind v4 — text-[var(--x)] emits
   nothing at all, because the compiler cannot tell a size from a colour. */
const CONTROL =
  'btn btn--ghost inline-flex items-center gap-[var(--s2)] min-h-[var(--tap)] px-[var(--s4)] '
  + 'text-[length:var(--t-xs)] text-[color:var(--bone-200)]';

export default function SoundToggle() {
  const { enabled, status, setEnabled, play } = useGymSound();
  const face = FACES[status];

  async function toggle() {
    // Inside the click, which is what makes it a user gesture.
    const live = await setEnabled(!enabled);
    // The one sound that is its own confirmation: a latch engaging, so the
    // listener hears immediately that audio actually works. The label flipping
    // beside it carries the same message on its own.
    if (live) {
      play('latch');
    }
  }

  return (
    <button
      type="button"
      onClick={() => { void toggle(); }}
      aria-pressed={enabled}
      title={face.title}
      className={CONTROL}
    >
      <span aria-hidden="true">{face.glyph}</span>
      <span>{face.label}</span>
    </button>
  );
}
