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
import { GYM_SAYINGS, librarySayings, pickSaying, sayingSource, sayingsFor, type GymSaying } from './gymSayings';

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
    // "Jason execute pack"), egg 11 changed by D19 (OD-2026-10-08-009), and
    // line 13 added by the owner 2026-10-17 ("1 and add it to the approved
    // list") — thirteen lines, no more, no fewer, until he adds to them again.
    expect(GYM_SAYINGS).toHaveLength(13);
  });

  it("carries the owner's 2026-10-17 line, ADAPT AND OVERCOME, for after a hard session", () => {
    expect(GYM_SAYINGS.find((s) => s.line === 'ADAPT AND OVERCOME')).toEqual({
      line: 'ADAPT AND OVERCOME',
      said_by: 'the wall',
      shown: ['after-hard-session'],
    });
  });

  it('matches the approved list after D19: Steel Town is off the wall, AMPLECTERE MISERIAM is on', () => {
    // OD-2026-10-08-009 D19, "the gym sayings match his approved list".
    const lines = GYM_SAYINGS.map((s) => s.line);
    expect(lines).not.toContain('STEEL TOWN. STEADY HANDS.');
    expect(GYM_SAYINGS.find((s) => s.line === 'AMPLECTERE MISERIAM')).toEqual({
      line: 'AMPLECTERE MISERIAM',
      said_by: 'the wall',
      shown: ['anywhere'],
    });
  });

  it('has no stock boxing quote hiding in it', () => {
    // Belt and braces for the day somebody adds lines: whatever arrives must
    // not be the usual internet furniture. This is about the LOCAL file, the
    // gym's own lines. Attributed boxing quotes are allowed on the chalkboard
    // and the TV (OD-2026-10-03-015) and arrive through the editable library
    // instead; see "the quote library" below.
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

describe('the quote library (#1462): attributed quotes, the local lines as fallback', () => {
  it('an attributed boxing quote from the library keeps its words and its speaker', () => {
    const [ali] = librarySayings([
      { quote_text: '  FLOAT LIKE A BUTTERFLY, STING LIKE A BEE. ', speaker: ' Muhammad Ali ', shown: ['anywhere'] },
    ]);
    expect(ali).toEqual({ line: 'FLOAT LIKE A BUTTERFLY, STING LIKE A BEE.', said_by: 'Muhammad Ali', shown: ['anywhere'] });
  });

  it('drops a row with no words or no moment this file knows, rather than guessing', () => {
    expect(librarySayings([
      { quote_text: '   ', speaker: 'x', shown: ['anywhere'] },
      { quote_text: 'NO MOMENT', speaker: 'x', shown: ['at-the-bell'] },
      { quote_text: 'KEEP', speaker: 'x', shown: ['at-the-bell', 'at-a-milestone'] },
    ])).toEqual([{ line: 'KEEP', said_by: 'x', shown: ['at-a-milestone'] }]);
    // No speaker, no screen: a boxing quote must never read as the gym's own words.
    expect(librarySayings([
      { quote_text: 'FLOAT LIKE A BUTTERFLY, STING LIKE A BEE.', speaker: '', shown: ['anywhere'] },
      { quote_text: 'EVERYBODY HAS A PLAN.', speaker: '   ', shown: ['anywhere'] },
    ])).toEqual([]);
    expect(librarySayings(null)).toEqual([]);
  });

  it('the library is the source when it has a line for the moment, the gym\'s own lines otherwise', () => {
    const library = [{ quote_text: 'AMPLECTERE MISERIAM', speaker: 'the wall', shown: ['anywhere'] }];
    expect(sayingSource(library, 'anywhere')).toEqual([{ line: 'AMPLECTERE MISERIAM', said_by: 'the wall', shown: ['anywhere'] }]);
    expect(sayingSource([], 'anywhere')).toBe(GYM_SAYINGS);
    expect(sayingSource(undefined, 'anywhere')).toBe(GYM_SAYINGS);
    // Nothing for this moment in the library: the local lines, not silence.
    expect(sayingSource([{ quote_text: 'ONLY MILESTONES', speaker: 'x', shown: ['at-a-milestone'] }], 'after-hard-session'))
      .toBe(GYM_SAYINGS);
  });

  it('the same seed picks the same library line every time', () => {
    const source = sayingSource([
      { quote_text: 'ONE', speaker: 'a', shown: ['anywhere'] },
      { quote_text: 'TWO', speaker: 'b', shown: ['anywhere'] },
      { quote_text: 'THREE', speaker: 'c', shown: ['anywhere'] },
    ], 'anywhere');
    const first = pickSaying('anywhere', '2026-10-13', source);
    for (let i = 0; i < 5; i += 1) expect(pickSaying('anywhere', '2026-10-13', source)).toEqual(first);
  });
});
