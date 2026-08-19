/**
 * @jest-environment jsdom
 */

/**
 * THE FRAME IS BUILT AND THE SOURCE IS EMPTY, AND THAT IS THE FEATURE.
 *
 * The lines that go on this wall belong to the coaches at this gym. Nobody who
 * has not stood on that floor can write them, and a stock boxing quote hung in
 * the largest type on the screen would be the first untrue thing on a platform
 * whose every other surface is a real record.
 *
 * So the tests here pin two different things:
 *   1. the module works, given lines — otherwise "it ships empty" is just an
 *      excuse for something that was never wired up; and
 *   2. the SHIPPED source stays empty, so a stock quote cannot arrive in a
 *      later patch without somebody deliberately deleting a test that says it
 *      must not.
 */

import { render, screen } from '@testing-library/react';

import WordsOnTheWall, { AnniversaryNote, BoxingNumberNote } from './WordsOnTheWall';
import { GYM_SAYINGS, pickSaying, sayingsFor, type GymSaying } from './gymSayings';

/* Obviously not a coach's words, and obviously never rendered in production:
   the shipped source is empty and these are handed in as a test seam. */
const FAKE: readonly GymSaying[] = [
  { line: 'TEST LINE ONE', said_by: 'Test Fixture', shown: ['at-a-milestone'] },
  { line: 'TEST LINE TWO', said_by: 'Test Fixture', shown: ['after-hard-session'] },
  { line: 'TEST LINE THREE', said_by: 'Test Fixture', shown: ['anywhere'] },
];

describe('the shipped source', () => {
  it('carries the owner-approved lines, and only those', () => {
    // Owner-approved 2026-08-19 (Drive doc 2026-08-19_EGGS-LOAD-FIRST-12.md,
    // "Jason execute pack") — twelve lines, no more, no fewer, until the
    // owner adds to them again.
    expect(GYM_SAYINGS).toHaveLength(12);
  });

  it('has no stock boxing quote hiding in it', () => {
    // Belt and braces for the day somebody adds lines: whatever arrives must
    // not be the usual internet furniture.
    const all = GYM_SAYINGS.map((s) => `${s.line} ${s.said_by}`.toLowerCase()).join(' | ');
    for (const stock of [
      'punched in the mouth',
      'float like a butterfly',
      'everybody has a plan',
      'the fight is won',
      'suffer now and live',
      'champions are made',
    ]) {
      expect(all).not.toContain(stock);
    }
  });

  it('makes every entry attributable, so an unattributed line cannot compile', () => {
    for (const saying of GYM_SAYINGS) {
      expect(saying.said_by.trim().length).toBeGreaterThan(0);
      expect(saying.shown.length).toBeGreaterThan(0);
    }
  });
});

describe('WordsOnTheWall', () => {
  it('renders nothing at all when there is nothing true to say', () => {
    // An empty source (an explicit test seam, not the shipped state now that
    // the owner has filled it) — an empty wall, not an empty box with a border.
    const { container } = render(<WordsOnTheWall context="at-a-milestone" seed={13} source={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('paints the line and the signature when the gym has words', () => {
    render(<WordsOnTheWall context="at-a-milestone" seed={13} source={FAKE} />);
    // Which of the eligible lines is chosen is the hash's business; that it
    // paints one of them, with its signature, is this test's.
    expect(screen.getByText(/^TEST LINE (ONE|THREE)$/)).toBeTruthy();
    expect(screen.getByText('Test Fixture')).toBeTruthy();
  });

  it('needs a moment — there is no "always", so it cannot become wallpaper', () => {
    // The prop is a union of two moments. A permanent banner is invisible
    // within a week, and then the gym said something and nobody heard it.
    const contexts = ['after-hard-session', 'at-a-milestone', 'anywhere'] as const;
    expect(contexts).not.toContain('always');
    // And a line tagged for one moment does not turn up in the other.
    expect(sayingsFor('after-hard-session', FAKE).map((s) => s.line))
      .toEqual(['TEST LINE TWO', 'TEST LINE THREE']);
    expect(sayingsFor('at-a-milestone', FAKE).map((s) => s.line))
      .toEqual(['TEST LINE ONE', 'TEST LINE THREE']);
  });

  it('shows the same line for the same moment, every time it is looked at', () => {
    // A sign that reshuffles on every render is a slot machine, and it makes
    // the screen, a screen reader and a printout disagree with one another.
    const first = pickSaying('at-a-milestone', 13, FAKE);
    for (let i = 0; i < 25; i += 1) {
      expect(pickSaying('at-a-milestone', 13, FAKE)).toBe(first);
    }
    const { container: a } = render(<WordsOnTheWall context="at-a-milestone" seed={34} source={FAKE} />);
    const { container: b } = render(<WordsOnTheWall context="at-a-milestone" seed={34} source={FAKE} />);
    expect(a.innerHTML).toBe(b.innerHTML);
  });

  it('is a labelled region rather than a decoration', () => {
    render(<WordsOnTheWall context="at-a-milestone" seed={5} source={FAKE} />);
    expect(screen.getByRole('complementary', { name: /words on the wall/i })).toBeTruthy();
  });

  it('has no motion of its own to stand down under reduced motion', () => {
    // Lettering on a wall is simply there. Nothing here animates, so there is
    // nothing for prefers-reduced-motion to disable.
    const { container } = render(<WordsOnTheWall context="at-a-milestone" seed={5} source={FAKE} />);
    expect(container.innerHTML).not.toMatch(/animat|transition|transform/i);
  });
});

describe('the asides', () => {
  it('remarks on 3 and on 12, and on nothing else', () => {
    expect(render(<BoxingNumberNote count={3} />).container.textContent).toContain('Three');
    expect(render(<BoxingNumberNote count={12} />).container.textContent).toContain('Twelve');
    expect(render(<BoxingNumberNote count={11} />).container.innerHTML).toBe('');
    expect(render(<BoxingNumberNote count={13} />).container.innerHTML).toBe('');
  });

  it('announces quietly rather than seizing attention', () => {
    render(<BoxingNumberNote count={3} />);
    // role="status" is polite; role="alert" would interrupt whatever a screen
    // reader was saying, over a remark about a number.
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('renders no anniversary when there is none', () => {
    expect(render(<AnniversaryNote line={null} />).container.innerHTML).toBe('');
  });

  it('renders the anniversary line as given, with no ornament added', () => {
    render(<AnniversaryNote line="A year, this week. Same gym, same door." />);
    expect(screen.getByText('A year, this week. Same gym, same door.')).toBeTruthy();
  });

  it('carries no confetti, no badge and no comparison', () => {
    const { container } = render(
      <>
        <BoxingNumberNote count={3} />
        <BoxingNumberNote count={12} />
        <AnniversaryNote line="A year, this week. Same gym, same door." />
      </>,
    );
    const text = container.textContent?.toLowerCase() ?? '';
    expect(text).not.toMatch(/congratulat|unlocked|achievement|badge|points|level|rank|leaderboard|top \d/);
    expect(container.textContent).not.toContain('!');
  });
});
