/**
 * @jest-environment jsdom
 */

// The card is a record, not a score, so these tests mostly pin honesty: the
// count matches the rows, an incomplete session is not counted as training, and
// nothing anywhere implements a streak.

import { render, screen } from '@testing-library/react';

import { resetCeremonyMemory } from './milestoneCeremony';
import TrainingCard, { MILESTONES, type TrainingSession } from './TrainingCard';

function session(over: Partial<TrainingSession> & { session_id: string }): TrainingSession {
  return { date: '2026-07-01', rpe: 6, completed_flag: true, ...over };
}

// The milestone ceremony writes down which seals it has already pressed, and
// that record outlives a render. Every case below is a different athlete's
// card, so each one starts from a card nobody has seen before — which is also
// why none of them stages a crossing. The ceremony itself is pinned in
// trainingCardCeremony.test.tsx.
afterEach(() => {
  window.localStorage.clear();
  resetCeremonyMemory();
});

describe('TrainingCard', () => {
  it('says so plainly when the card is empty, and promises it never resets', () => {
    render(<TrainingCard sessions={[]} />);
    expect(screen.getByText(/no sessions on the card yet/i)).toBeTruthy();
    expect(screen.getByText(/never resets/i)).toBeTruthy();
  });

  it('counts completed sessions, not booked ones', () => {
    render(
      <TrainingCard
        sessions={[
          session({ session_id: 'a' }),
          session({ session_id: 'b' }),
          session({ session_id: 'c', completed_flag: false }),
        ]}
      />,
    );
    // Three rows on the card, two of them logged.
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText(/sessions logged/i)).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('uses the singular for one session', () => {
    render(<TrainingCard sessions={[session({ session_id: 'a' })]} />);
    expect(screen.getByText('session logged')).toBeTruthy();
  });

  it('renders oldest first, because a card reads left to right', () => {
    // The API hands back date desc; the card must not.
    render(
      <TrainingCard
        sessions={[
          session({ session_id: 'newer', date: '2026-07-20' }),
          session({ session_id: 'older', date: '2026-07-01' }),
        ]}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0].getAttribute('title')).toMatch(/Jul 1 2026/);
    expect(items[1].getAttribute('title')).toMatch(/Jul 20 2026/);
  });

  it('dates the card from the earliest session', () => {
    render(
      <TrainingCard
        sessions={[
          session({ session_id: 'a', date: '2026-07-20' }),
          session({ session_id: 'b', date: '2026-02-03' }),
        ]}
      />,
    );
    expect(screen.getByText(/since Feb 3 2026/)).toBeTruthy();
  });

  // Law 3: a stamp must not be colour-only. Every one carries its own text.
  it('gives every stamp a readable date and effort, not just a shade', () => {
    render(
      <TrainingCard sessions={[session({ session_id: 'a', date: '2026-07-04', rpe: 8 })]} />,
    );
    expect(screen.getByText('Session Jul 4 2026, effort 8 of 10')).toBeTruthy();
  });

  it('labels a booked session as not completed rather than implying training', () => {
    render(
      <TrainingCard
        sessions={[session({ session_id: 'a', date: '2026-07-04', completed_flag: false })]}
      />,
    );
    // The phrase also appears in the legend, so assert on the stamp itself.
    expect(screen.getByRole('listitem').getAttribute('title'))
      .toBe('Session Jul 4 2026, booked, not completed');
    expect(screen.getByText('Session Jul 4 2026, booked, not completed')).toBeTruthy();
  });

  // Law 2: effort is ink density, never hue. A red stamp would read as a safety
  // state sitting next to the safety ladder.
  it('encodes effort as ink density and never as a status colour', () => {
    const { container } = render(
      <TrainingCard
        sessions={[
          session({ session_id: 'light', rpe: 2 }),
          session({ session_id: 'heavy', rpe: 10 }),
        ]}
      />,
    );
    const stamps = container.querySelectorAll('.tcard-stamp--done');
    const inks = [...stamps].map((s) => (s as HTMLElement).style.getPropertyValue('--ink'));
    expect(inks).toEqual(['0.2', '1']);
    // No safety-ladder token anywhere in the card. Matched as a var() reference
    // so a class name that merely contains the word cannot pass or fail this by
    // accident -- which is also why the unearned-milestone class is not called
    // "--locked": in this platform that word is the Layer 11 safety state.
    const html = container.innerHTML;
    for (const token of ['cleared', 'monitor', 'restricted', 'locked']) {
      expect(html).not.toContain(`var(--${token})`);
    }
    expect(html).not.toContain('--locked');
  });

  it('clamps a nonsense RPE rather than blowing out the card', () => {
    const { container } = render(
      <TrainingCard
        sessions={[
          session({ session_id: 'over', rpe: 99 }),
          session({ session_id: 'under', rpe: -4 }),
        ]}
      />,
    );
    const inks = [...container.querySelectorAll('.tcard-stamp--done')]
      .map((s) => (s as HTMLElement).style.getPropertyValue('--ink'));
    expect(inks).toEqual(['1', '0']);
  });

  it('shows every milestone, earned or not, so the next one is visible', () => {
    render(<TrainingCard sessions={[session({ session_id: 'a' })]} />);
    for (const m of MILESTONES) {
      expect(screen.getByLabelText(new RegExp(`${m} session milestone`))).toBeTruthy();
    }
  });

  it('marks a milestone earned once the count reaches it', () => {
    const five = Array.from({ length: 5 }, (_, i) =>
      session({ session_id: `s${i}`, date: `2026-07-0${i + 1}` }));
    render(<TrainingCard sessions={five} />);
    expect(screen.getByLabelText('5 session milestone, earned')).toBeTruthy();
    expect(screen.getByLabelText('13 session milestone, not yet earned')).toBeTruthy();
  });

  it('says how many remain to the next milestone', () => {
    render(<TrainingCard sessions={[session({ session_id: 'a' })]} />);
    expect(screen.getByText(/4 more to 5/)).toBeTruthy();
  });

  it('caps the impressions drawn but never the count', () => {
    const many = Array.from({ length: 70 }, (_, i) =>
      session({ session_id: `s${i}`, date: `2026-0${(i % 9) + 1}-01` }));
    render(<TrainingCard sessions={many} maxStamps={10} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText('70')).toBeTruthy();          // count is honest
    expect(screen.getByText(/60 earlier sessions are still counted/i)).toBeTruthy();
  });

  it('does not mutate the array it was handed', () => {
    const input: TrainingSession[] = [
      session({ session_id: 'b', date: '2026-07-20' }),
      session({ session_id: 'a', date: '2026-07-01' }),
    ];
    const before = input.map((s) => s.session_id);
    render(<TrainingCard sessions={input} />);
    expect(input.map((s) => s.session_id)).toEqual(before);
  });

  it('renders an unparseable date as given rather than inventing one', () => {
    render(<TrainingCard sessions={[session({ session_id: 'a', date: 'unknown' })]} />);
    expect(screen.getByText(/Session unknown, effort/)).toBeTruthy();
  });

  // The reason this card has no streak: a Layer 11 medical lock would break it,
  // punishing an athlete for being protected. Guard against it creeping in.
  it('implements no streak anywhere in its output', () => {
    const { container } = render(
      <TrainingCard sessions={[session({ session_id: 'a' })]} />,
    );
    expect(container.innerHTML.toLowerCase()).not.toMatch(/streak|consecutive|in a row|don't break/);
  });

  it('puts milestones on the Fibonacci series, like the rest of the system', () => {
    expect([...MILESTONES]).toEqual([5, 13, 34, 89, 233]);
  });
});

// pilot.sessions.rpe is nullable as of
// pilot_slice_postgres_session_rpe_semantics_migration.sql, so this card now
// receives rows with no effort reading at all: every open check-in, and every
// completed session nobody rated. The card draws effort as ink density, and
// `(s.rpe || 0)` used to stand in that expression -- which drew an unrated
// session in exactly the ink of a session the athlete rated 0, and announced it
// as "effort 0 of 10". That is a self-report the athlete never gave.
describe('a session nobody rated is not a session rated zero', () => {
  function stamps() {
    return screen.getAllByRole('listitem');
  }

  test('an unrated completed session says so, and never says zero', () => {
    render(<TrainingCard sessions={[session({ session_id: 'a', rpe: null })]} />);

    const [stamp] = stamps();
    expect(stamp.getAttribute('title')).toBe('Session Jul 1 2026, completed, effort not recorded');
    expect(stamp.getAttribute('title')).not.toMatch(/effort 0/);
    // The same words reach a screen reader, not just the tooltip.
    expect(screen.getByText('Session Jul 1 2026, completed, effort not recorded')).toBeTruthy();
  });

  test('an unrated session is given no ink value at all, rather than a zero one', () => {
    render(<TrainingCard sessions={[session({ session_id: 'a', rpe: null })]} />);
    // No --ink written means no number was invented. The card says nothing in
    // the ink channel, because the ink channel cannot say "not recorded".
    expect(stamps()[0].getAttribute('style') ?? '').not.toContain('--ink');
  });

  test('a genuine RPE of 0 is kept, drawn and announced as 0', () => {
    render(<TrainingCard sessions={[session({ session_id: 'a', rpe: 0 })]} />);

    const [stamp] = stamps();
    expect(stamp.getAttribute('title')).toBe('Session Jul 1 2026, effort 0 of 10');
    expect(stamp.getAttribute('style') ?? '').toContain('--ink');
  });

  // The whole point of the pair above: these two rows are different facts and
  // the card has to render them differently. If either the label or the ink
  // ever collapses them, an athlete who was never asked reads as an athlete who
  // said the session took nothing out of them.
  test('rated 0 and not rated are told apart', () => {
    render(
      <TrainingCard
        sessions={[
          session({ session_id: 'rated', date: '2026-07-01', rpe: 0 }),
          session({ session_id: 'unrated', date: '2026-07-02', rpe: null }),
        ]}
      />,
    );

    const [rated, unrated] = stamps();
    expect(rated.getAttribute('title')).not.toBe(unrated.getAttribute('title'));
    expect(rated.getAttribute('title')).toMatch(/effort 0 of 10/);
    expect(unrated.getAttribute('title')).toMatch(/effort not recorded/);
  });

  // "Completed but unrated" and "booked and never done" are different facts
  // too. The number is missing from both, so the class has to carry the
  // difference.
  test('an unrated completed session is still a completed one, not a booked one', () => {
    render(
      <TrainingCard
        sessions={[
          session({ session_id: 'done', date: '2026-07-01', rpe: null }),
          session({ session_id: 'booked', date: '2026-07-02', rpe: null, completed_flag: false }),
        ]}
      />,
    );

    const [done, booked] = stamps();
    expect(done.className).toContain('tcard-stamp--done');
    expect(done.className).not.toContain('tcard-stamp--open');
    expect(booked.className).toContain('tcard-stamp--open');
    expect(booked.getAttribute('title')).toBe('Session Jul 2 2026, booked, not completed');
  });

  test('unrated sessions still count as sessions logged', () => {
    // The count is about attendance, not effort. Losing an unrated session from
    // the tally would take a session off a child's card for not rating it.
    render(
      <TrainingCard
        sessions={[
          session({ session_id: 'a', rpe: null }),
          session({ session_id: 'b', rpe: null }),
          session({ session_id: 'c', rpe: 7 }),
        ]}
      />,
    );
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText(/sessions logged/i)).toBeTruthy();
  });
});
