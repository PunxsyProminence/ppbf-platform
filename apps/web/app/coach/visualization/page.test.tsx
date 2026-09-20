/**
 * @jest-environment jsdom
 */

import fs from 'node:fs';
import path from 'node:path';

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

import CoachVisualizationPage from './page';
import { MANUAL_DELIVERY_RULES, PF001_RING_CUTTER } from '@/src/lib/visualization/pf001Scenario';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: React.ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

/** The prompt the coach is on now. */
function prompt() {
  return screen.getByRole('heading', { level: 2 }).textContent ?? '';
}

function position() {
  return screen.getByText(/^Step \d+ of \d+$/).textContent ?? '';
}

/** The page's single live region. */
function liveRegion() {
  return screen.getByRole('status');
}

function clickNext() {
  fireEvent.click(screen.getByRole('button', { name: 'Next prompt' }));
}

/** Start the one exposure this surface delivers. */
function start() {
  fireEvent.click(screen.getByRole('button', { name: 'Start the guided session' }));
}

/** Walks the rest of the exposure and returns every prompt in the order shown. */
function walkEverything() {
  const seen = [prompt()];
  for (let step = 0; step < 40; step += 1) {
    const next = screen.queryByRole('button', { name: 'Next prompt' });
    if (!next) break;
    fireEvent.click(next);
    seen.push(prompt());
  }
  return seen;
}

beforeEach(() => {
  global.fetch = jest.fn(() => {
    throw new Error('this page must not call the network');
  }) as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

/**
 * VIZ-1 delivers ONE exposure, the manual's Level 1 Guided. There is no mode
 * chooser, and these tests hold that boundary: an earlier head offered all three
 * modes as runnable buttons, which promised a Decision mode and a timed, scored
 * Adaptive mode that this slice does not implement.
 */
describe('the surface offers one guided exposure and no choice of mode', () => {
  test('it opens on the rules and a single start control, with no prompt running yet', () => {
    render(<CoachVisualizationPage />);

    expect(prompt()).toBe('Before you start');
    for (const rule of MANUAL_DELIVERY_RULES.visualizationRules) {
      expect(screen.getByText(rule)).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Start the guided session' })).toBeInTheDocument();
    expect(screen.queryByText(/^Step \d+ of \d+$/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next prompt' })).toBeNull();

    // Scenario identity and its source are on screen from the start.
    expect(screen.getByText(/PF-001 · The Ring-Cutter · Pressure Fighter · Foundation · 1 OF 17/)).toBeInTheDocument();
    expect(
      screen.getByText(/Adaptive_Amateur_Boxing_Visualization_Curriculum_100_Scenarios\.docx.*Content V4\.1.*2026-09-15/),
    ).toBeInTheDocument();
  });

  test('no control runs a mode this slice does not implement', () => {
    render(<CoachVisualizationPage />);

    // Before starting and after starting: no Level 2 or Level 3 run control
    // exists anywhere, and the delivery-level table is not presented as a menu
    // of things the coach can pick.
    for (const phase of ['before', 'after'] as const) {
      if (phase === 'after') start();

      expect(screen.queryByRole('button', { name: /Run at Level/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /Level 2/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /Level 3/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /Decision/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /Adaptive/i })).toBeNull();

      for (const row of MANUAL_DELIVERY_RULES.deliveryLevels) {
        expect(screen.queryByText(row.level)).toBeNull();
        expect(screen.queryByText(row.purpose)).toBeNull();
        // The field that carries "Timed when ready. ... 3 x 3-minute rounds
        // with 1-minute breaks." This slice has no clock, so the coach is never
        // shown a mode that promises one.
        expect(screen.queryByText(row.coachGivesTiming)).toBeNull();
      }
      expect(screen.queryByText(MANUAL_DELIVERY_RULES.level3Note)).toBeNull();
    }
  });

  test('the Level 2 and Level 3 source wording never reaches the screen', () => {
    render(<CoachVisualizationPage />);
    start();

    const everything: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      const reveal = screen.queryByRole('button', { name: 'Offer the response options' });
      if (reveal) fireEvent.click(reveal);
      // Normalized, because the needles below are. The authored cue lines pad
      // their bullets with double spaces and textContent keeps them, so a
      // single-spaced needle could never match a raw haystack -- the assertion
      // would pass whatever the page rendered. Found by review.
      everything.push((document.body.textContent ?? '').replace(/\s+/g, ' '));
      const next = screen.queryByRole('button', { name: 'Next prompt' });
      if (!next) break;
      fireEvent.click(next);
    }
    const read = everything.join(' ');

    for (const round of PF001_RING_CUTTER.rounds) {
      expect(read).not.toContain(round.level2Cues.replace(/\s+/g, ' '));
      expect(read).not.toContain(round.level3Cues.replace(/\s+/g, ' '));
    }
    expect(read).not.toContain('Reduced Cues');
    expect(read).not.toContain('Cue-Only');
  });

  test('nothing on any screen is timed or keeps a tally', () => {
    render(<CoachVisualizationPage />);
    start();

    for (let step = 0; step < 40; step += 1) {
      const reveal = screen.queryByRole('button', { name: 'Offer the response options' });
      if (reveal) fireEvent.click(reveal);

      // No clock and no tally: not as a word search over authored prose, but as
      // the absence of anything that would measure or count.
      expect(document.querySelectorAll('time, progress, meter, [role="progressbar"], [role="timer"]')).toHaveLength(0);
      for (const name of [/start timer/i, /stop timer/i, /^timer/i, /stopwatch/i, /scorecard/i, /next round/i]) {
        expect(screen.queryByRole('button', { name })).toBeNull();
      }

      const next = screen.queryByRole('button', { name: 'Next prompt' });
      if (!next) break;
      fireEvent.click(next);
    }
  });

  test('it reads the network not at all', () => {
    render(<CoachVisualizationPage />);
    start();
    walkEverything();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('the phase is named beside the position, without a mode to name', () => {
    render(<CoachVisualizationPage />);
    start();
    expect(screen.getByText('Before the bell')).toBeInTheDocument();
    expect(screen.queryByText(/· Level \d/)).toBeNull();
    expect(position()).toBe('Step 1 of 22');
  });
});

describe('Level 1 — Guided: the authored order, and options only on request', () => {
  test('every prompt appears once, in the source sequence, ending at session complete', () => {
    render(<CoachVisualizationPage />);
    start();

    expect(walkEverything()).toEqual([
      'Before the Bell — Build the Opponent',
      'Key visual cues',
      'Common athlete mistakes',
      'What am I fighting?',
      'The opponent acts',
      'Ask the athlete',
      'Coach guidance',
      'Continue the fight',
      'Corner note',
      'How can I use what I discovered?',
      'The opponent acts',
      'Ask the athlete',
      'Coach guidance',
      'Continue the fight',
      'Corner note',
      'Can I solve an opponent who is now trying to solve me?',
      'The opponent acts',
      'Ask the athlete',
      'Coach guidance',
      'Continue the fight',
      'Post-Fight Debrief',
      'Session complete',
    ]);
  });

  test('the opponent acts before the question is asked, with the beat rule shown', () => {
    render(<CoachVisualizationPage />);
    start();
    clickNext();
    clickNext();
    clickNext();
    clickNext();

    expect(prompt()).toBe('The opponent acts');
    expect(screen.getByText(PF001_RING_CUTTER.rounds[0].level1.opponentAction)).toBeInTheDocument();
    expect(
      screen.getByText(/See the cue before the answer: allow a brief beat/),
    ).toBeInTheDocument();
    // The question is not on this screen, and neither is any answer.
    expect(screen.queryByText(PF001_RING_CUTTER.rounds[0].level1.coachAsks)).toBeNull();
    for (const option of PF001_RING_CUTTER.rounds[0].level1.options) {
      expect(screen.queryByText(option)).toBeNull();
    }
  });

  test('the options are not read aloud by default: the rule is shown and the coach must ask', () => {
    render(<CoachVisualizationPage />);
    start();
    for (let step = 0; step < 5; step += 1) clickNext();

    expect(prompt()).toBe('Ask the athlete');
    expect(screen.getByText(PF001_RING_CUTTER.rounds[0].level1.coachAsks)).toBeInTheDocument();
    expect(screen.getByText(MANUAL_DELIVERY_RULES.level1OptionsRule)).toBeInTheDocument();
    for (const option of PF001_RING_CUTTER.rounds[0].level1.options) {
      expect(screen.queryByText(option)).toBeNull();
    }

    fireEvent.click(screen.getByRole('button', { name: 'Offer the response options' }));

    for (const option of PF001_RING_CUTTER.rounds[0].level1.options) {
      expect(screen.getByText(option)).toBeInTheDocument();
    }
    // The button that was pressed is gone, so the change is said out loud --
    // and it says where the coach now is, because focus moved there.
    expect(liveRegion()).toHaveTextContent('Response options offered. Moved to the coach resource.');
  });

  test('asking for the options in one round does not reveal them in the next', () => {
    render(<CoachVisualizationPage />);
    start();
    for (let step = 0; step < 5; step += 1) clickNext();
    fireEvent.click(screen.getByRole('button', { name: 'Offer the response options' }));
    expect(screen.getByText(PF001_RING_CUTTER.rounds[0].level1.options[0])).toBeInTheDocument();

    while (prompt() !== 'How can I use what I discovered?') clickNext();
    clickNext();
    clickNext();
    expect(prompt()).toBe('Ask the athlete');
    for (const option of PF001_RING_CUTTER.rounds[1].level1.options) {
      expect(screen.queryByText(option)).toBeNull();
    }
    expect(screen.getByRole('button', { name: 'Offer the response options' })).toBeInTheDocument();
  });
});



describe('the controls a coach needs on the floor', () => {
  test('repeating a prompt keeps the place', () => {
    render(<CoachVisualizationPage />);
    start();
    clickNext();
    const before = position();

    fireEvent.click(screen.getByRole('button', { name: 'Repeat this prompt' }));

    expect(position()).toBe(before);
    expect(prompt()).toBe('Key visual cues');
  });

  test('rebuilding the picture returns to the opponent, then back to the same prompt', () => {
    render(<CoachVisualizationPage />);
    start();
    for (let step = 0; step < 4; step += 1) clickNext();
    const wasAt = position();

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild the picture' }));
    expect(prompt()).toBe('Before the Bell — Build the Opponent');

    fireEvent.click(screen.getByRole('button', { name: 'Back to Round 1 of 3 — DISCOVER' }));
    expect(position()).toBe(wasAt);
    expect(prompt()).toBe('The opponent acts');
  });

  test('the rebuild bookmark survives moving around inside the rebuild', () => {
    render(<CoachVisualizationPage />);
    start();
    for (let step = 0; step < 4; step += 1) clickNext();
    const wasAt = position();
    expect(prompt()).toBe('The opponent acts');

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild the picture' }));
    expect(prompt()).toBe('Before the Bell — Build the Opponent');

    // Re-establishing the picture can take more than one prompt; the way back
    // must still be there afterwards.
    clickNext();
    expect(prompt()).toBe('Key visual cues');
    const back = screen.getByRole('button', { name: 'Back to Round 1 of 3 — DISCOVER' });
    expect(back).toBeInTheDocument();

    fireEvent.click(back);
    expect(position()).toBe(wasAt);
    expect(prompt()).toBe('The opponent acts');
  });

  test('walking past the bookmarked point drops the bookmark, rather than offering a move backwards', () => {
    render(<CoachVisualizationPage />);
    start();
    clickNext();
    const wasAt = position();

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild the picture' }));
    expect(screen.getByRole('button', { name: /^Back to / })).toBeInTheDocument();

    clickNext();
    clickNext();
    expect(position()).not.toBe(wasAt);
    expect(screen.queryByRole('button', { name: /^Back to / })).toBeNull();
    expect(screen.getByRole('button', { name: 'Rebuild the picture' })).toBeInTheDocument();
  });

  test('pause holds the fight where it is until resume', () => {
    render(<CoachVisualizationPage />);
    start();
    clickNext();
    const held = prompt();

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByRole('status')).toHaveTextContent('Paused');
    expect(screen.getByRole('button', { name: 'Next prompt' })).toBeDisabled();
    clickNext();
    expect(prompt()).toBe(held);

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(screen.getByRole('button', { name: 'Next prompt' })).toBeEnabled();
    clickNext();
    expect(prompt()).not.toBe(held);
  });

  test('one live region carries every state change, and it is the same region throughout', () => {
    render(<CoachVisualizationPage />);
    const region = liveRegion();
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('');

    start();
    expect(liveRegion()).toBe(region);
    expect(region).toHaveTextContent('Before the Bell — Build the Opponent');
    expect(region).toHaveTextContent('Step 1 of 22');

    clickNext();
    expect(region).toHaveTextContent('Key visual cues');
    expect(region).toHaveTextContent('Step 2 of 22');

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(region).toHaveTextContent('Paused.');
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(region).toHaveTextContent('Resumed.');

    // Rebuild and the way back both say what happened.
    clickNext();
    clickNext();
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild the picture' }));
    expect(region).toHaveTextContent('Rebuilding the picture.');
    fireEvent.click(screen.getByRole('button', { name: /^Back to / }));
    expect(region).toHaveTextContent('Back in the fight.');

    // One region, one message: nothing else on the page claims that role.
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  test('reaching the debrief and the end is announced by name, without a step count', () => {
    render(<CoachVisualizationPage />);
    start();
    while (prompt() !== 'Post-Fight Debrief') clickNext();
    expect(liveRegion()).toHaveTextContent('Post-Fight Debrief');
    expect(liveRegion().textContent).not.toMatch(/Step \d+ of/);

    clickNext();
    expect(liveRegion()).toHaveTextContent('Session complete');
  });

  test('focus moves to the prompt, so a keyboard coach lands on what to say', () => {
    const frames: FrameRequestCallback[] = [];
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });

    render(<CoachVisualizationPage />);
    start();
    clickNext();
    act(() => {
      frames.splice(0).forEach((frame) => frame(0));
    });

    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 }));
  });
});

describe('the debrief, and what the session refuses to claim', () => {
  function walkToDebrief() {
    render(<CoachVisualizationPage />);
    start();
    while (prompt() !== 'Post-Fight Debrief') clickNext();
  }

  test('the authored questions are asked, self-report and observation kept apart', () => {
    walkToDebrief();

    for (const question of PF001_RING_CUTTER.debriefQuestions) {
      expect(screen.getByText(question)).toBeInTheDocument();
    }
    expect(screen.getByLabelText(PF001_RING_CUTTER.debriefQuestions[0])).toBeInTheDocument();
    expect(screen.getByLabelText('Coach observation — what you saw, in your words')).toBeInTheDocument();
    expect(screen.getByText(/None of this is saved\./)).toBeInTheDocument();
  });

  test('what is typed lives only in this exposure: a fresh mount has nothing', () => {
    const first = render(<CoachVisualizationPage />);
    start();
    while (prompt() !== 'Post-Fight Debrief') clickNext();
    const field = screen.getByLabelText(PF001_RING_CUTTER.debriefQuestions[0]);
    fireEvent.change(field, { target: { value: 'He cut me off at the lead foot.' } });
    expect(field).toHaveValue('He cut me off at the lead foot.');

    // A refresh is a new unsaved exposure: nothing was stored where a second
    // mount could read it.
    first.unmount();
    render(<CoachVisualizationPage />);
    expect(prompt()).toBe('Before you start');
    start();
    while (prompt() !== 'Post-Fight Debrief') clickNext();
    expect(screen.getByLabelText(PF001_RING_CUTTER.debriefQuestions[0])).toHaveValue('');
  });

  test('session complete claims the debrief was reached and nothing more', () => {
    walkToDebrief();
    clickNext();

    expect(prompt()).toBe('Session complete');
    expect(screen.getByText(/You reached the authored debrief/)).toBeInTheDocument();
    expect(screen.getByText(/does not say the athlete has learned to/)).toBeInTheDocument();
    expect(screen.getByText(/nothing here was recorded, so it is not\s+evidence of the session/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next prompt' })).not.toBeInTheDocument();
  });

  test('from session complete the debrief is still reachable, with what was typed', () => {
    walkToDebrief();
    fireEvent.change(screen.getByLabelText(PF001_RING_CUTTER.debriefQuestions[0]), {
      target: { value: 'He cut the lane before he punched.' },
    });
    clickNext();
    expect(prompt()).toBe('Session complete');

    // The end is not a trap: the debrief is one deliberate step away, and it
    // still holds the words that were typed into it.
    expect(screen.queryByRole('button', { name: 'Rebuild the picture' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the debrief' }));

    expect(prompt()).toBe('Post-Fight Debrief');
    expect(liveRegion()).toHaveTextContent('Back to the debrief.');
    expect(screen.getByLabelText(PF001_RING_CUTTER.debriefQuestions[0])).toHaveValue(
      'He cut the lane before he punched.',
    );

    // And forward again is the same single step, not a restart.
    clickNext();
    expect(prompt()).toBe('Session complete');
  });

  test('starting a new exposure leaves nothing on screen claiming the old one', () => {
    walkToDebrief();
    clickNext();
    expect(prompt()).toBe('Session complete');
    expect(liveRegion()).toHaveTextContent('Session complete');

    fireEvent.click(screen.getByRole('button', { name: 'Start a new exposure' }));

    // The region is read on the start screen too, so the state it reports must be
    // the state that exists: no session is running.
    expect(prompt()).toBe('Before you start');
    expect(liveRegion().textContent).not.toMatch(/Session complete/);
    expect(liveRegion()).toHaveTextContent('New exposure. Nothing from the last one was kept.');
    expect(document.body.textContent).not.toMatch(/Session complete/);
  });

  test('a new exposure starts from the beginning, clean', () => {
    walkToDebrief();
    fireEvent.change(screen.getByLabelText(PF001_RING_CUTTER.debriefQuestions[0]), {
      target: { value: 'notes' },
    });
    clickNext();

    fireEvent.click(screen.getByRole('button', { name: 'Start a new exposure' }));
    expect(prompt()).toBe('Before you start');

    start();
    while (prompt() !== 'Post-Fight Debrief') clickNext();
    expect(screen.getByLabelText(PF001_RING_CUTTER.debriefQuestions[0])).toHaveValue('');
  });

  test('no screen scores, grades, promotes or offers to save', () => {
    const screensRead: string[] = [];
    {
      const mounted = render(<CoachVisualizationPage />);
      screensRead.push(document.body.textContent ?? '');
      start();
      for (let step = 0; step < 40; step += 1) {
        // Every screen in full, including any help the coach can reveal.
        const reveal = screen.queryByRole('button', { name: 'Offer the response options' });
        if (reveal) fireEvent.click(reveal);
        screensRead.push(document.body.textContent ?? '');
        // Nothing measures anything: no progress bar, meter or gauge anywhere.
        expect(document.querySelectorAll('[role="progressbar"], progress, meter')).toHaveLength(0);
        for (const name of [/save/i, /submit/i, /^log/i, /score/i, /rate/i, /grade/i, /assign/i, /issue/i, /complete session/i]) {
          expect(screen.queryByRole('button', { name })).toBeNull();
        }
        const next = screen.queryByRole('button', { name: 'Next prompt' });
        if (!next) break;
        fireEvent.click(next);
      }
      mounted.unmount();
    }

    const everything = screensRead.join(' ');
    // The judgement check runs on the page's OWN words: authored text is
    // removed first. The manual really does name a level "Adaptive / Scored"
    // and really does say "after scoring, defend or exit" — quoting the source
    // is not the app scoring anyone.
    const authored: string[] = [];
    const collect = (value: unknown) => {
      if (typeof value === 'string') return authored.push(value);
      if (Array.isArray(value)) return value.forEach(collect);
      if (value && typeof value === 'object') return Object.values(value).forEach(collect);
      return undefined;
    };
    collect(PF001_RING_CUTTER);
    collect(MANUAL_DELIVERY_RULES);
    const pageWords = authored
      .sort((left, right) => right.length - left.length)
      .reduce((text, authoredString) => text.split(authoredString).join(' '), everything);

    // The one sentence that mentions readiness is the disclaimer refusing that
    // claim, so the claim itself is asserted below instead.
    for (const word of [/\bscore/i, /mastery/i, /\bpassed\b/i, /\bfailed\b/i, /\bpromote/i, /\bgrade\b/i, /vividness/i, /\brating\b/i]) {
      expect(pageWords).not.toMatch(word);
    }
    expect(everything).toContain('does not say the athlete has learned to');
    // The evidence really was every screen of the exposure, not one page.
    expect(screensRead.length).toBeGreaterThan(20);
  });
});

describe('every step of the exposure renders a prompt', () => {
  test('no step ever shows an empty or unknown state', () => {
    const mounted = render(<CoachVisualizationPage />);
    start();
    for (let step = 0; step < 40; step += 1) {
      expect(prompt().length).toBeGreaterThan(0);
      expect(document.body.textContent).not.toContain('No scenario to run');
      const next = screen.queryByRole('button', { name: 'Next prompt' });
      if (!next) break;
      fireEvent.click(next);
    }
    expect(prompt()).toBe('Session complete');
    mounted.unmount();
  });
});

describe('the page stays in its lane', () => {
  const source = fs.readFileSync(path.join(__dirname, 'page.tsx'), 'utf8');

  test('it imports only its own content, the session order and the access gate', () => {
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual([
      '@/components/RoleSessionGate',
      '@/src/lib/visualization/guidedSession',
      '@/src/lib/visualization/pf001Scenario',
      'next/link',
      'react',
    ]);
  });

  test('it has no write path, no storage and no drill, goal, video or SHADOW call', () => {
    expect(source).not.toMatch(/method:\s*'(POST|PATCH|PUT|DELETE)'/);
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    expect(source).not.toMatch(/api\/pilot\/(drills|drill-library|progression|goals|video|calibration|shadow)/);
  });
});

/**
 * The manual prints two things behind "Offer the response options": the options
 * themselves, and five instructions for HOW a coach uses them. Both are
 * authored, and both are the coach's, not the athlete's.
 *
 * WHY THIS SUITE EXISTS. `guidedSession` carried `onRequest.ruleBullets` and the
 * library test asserted it carried them -- while the page rendered only the
 * rule and the options. Five authored instructions, including explaining why an
 * option fits rather than naming a punch and continuing after mistakes, reached
 * the model and stopped there. A test that pins the data and never asks what
 * rendered cannot see that, so these tests ask the screen.
 */
describe('the authored option guidance reaches the coach, not just the model', () => {
  const ROUNDS = PF001_RING_CUTTER.rounds.map((round, index) => ({
    ordinal: index + 1,
    label: round.label,
    round,
  }));

  /** Stand on the decision prompt of one round, at Level 1. */
  function askAt(ordinal: number) {
    const mounted = render(<CoachVisualizationPage />);
    start();
    let asked = 0;
    for (let step = 0; step < 40; step += 1) {
      if (prompt() === 'Ask the athlete') {
        asked += 1;
        if (asked === ordinal) return mounted;
      }
      clickNext();
    }
    throw new Error(`never reached decision prompt ${ordinal}`);
  }

  function resource() {
    return screen.getByRole('region', { name: /^Coach resource/ });
  }

  /** The authored text of one labelled list inside the resource, in order. */
  function listUnder(labelText: string) {
    const label = screen.getByText(labelText);
    const list = label.nextElementSibling;
    expect(list?.tagName).toBe('UL');
    expect(list?.getAttribute('aria-labelledby')).toBe(label.id);
    return Array.from(list!.querySelectorAll('li')).map((item) => item.textContent);
  }

  const RULES_LABEL = 'How the manual says to use them — for you, not lines to read out';
  const OPTIONS_LABEL = 'The authored response options';

  test.each(ROUNDS)(
    'Round $ordinal, before the coach asks: the question and the governing rule, and nothing else',
    ({ ordinal, round }) => {
      askAt(ordinal);

      expect(screen.getByText(round.level1.coachAsks)).toBeInTheDocument();
      expect(screen.getByText(MANUAL_DELIVERY_RULES.level1OptionsRule)).toBeInTheDocument();

      // No answer, and no instruction about answers: the bullets are not on
      // screen at all, so nothing can be mistaken for the athlete's prompt.
      for (const option of round.level1.options) {
        expect(screen.queryByText(option)).toBeNull();
      }
      for (const bullet of MANUAL_DELIVERY_RULES.level1OptionsBullets) {
        expect(screen.queryByText(bullet)).toBeNull();
      }
      expect(prompt()).toBe('Ask the athlete');
      expect(screen.queryByRole('region', { name: /^Coach resource/ })).toBeNull();
    },
  );

  test.each(ROUNDS)(
    'Round $ordinal, after the coach asks: every authored instruction and option, once, in source order',
    ({ ordinal, round }) => {
      askAt(ordinal);
      fireEvent.click(screen.getByRole('button', { name: 'Offer the response options' }));

      // Exactly once each. Rendering the bullets twice would be as wrong as
      // rendering them never: the coach would not know which list is which.
      for (const text of [
        MANUAL_DELIVERY_RULES.level1OptionsRule,
        ...MANUAL_DELIVERY_RULES.level1OptionsBullets,
        ...round.level1.options,
      ]) {
        expect(screen.getAllByText(text)).toHaveLength(1);
      }

      // THE GOVERNING RULE STAYS. It used to be swapped out for the options,
      // which removed the one authored sentence saying the lettered answers are
      // not the only right ones -- "If the athlete proposes a different
      // technically sound response ... accept it." -- at the exact moment the
      // alternatives appeared. It is inside the coach region, above the bullets.
      const ruleOnScreen = screen.getByText(MANUAL_DELIVERY_RULES.level1OptionsRule);
      expect(resource()).toContainElement(ruleOnScreen);
      expect(ruleOnScreen.textContent).toContain(
        'If the athlete proposes a different technically sound response',
      );
      expect(
        ruleOnScreen.compareDocumentPosition(screen.getByText(RULES_LABEL))
        & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      // Source order, and the two lists kept apart.
      expect(listUnder(RULES_LABEL)).toEqual([...MANUAL_DELIVERY_RULES.level1OptionsBullets]);
      expect(listUnder(OPTIONS_LABEL)).toEqual([...round.level1.options]);

      // Semantically distinct: both authored lists are inside the labelled
      // coach region, and the athlete-facing question is not.
      const region = resource();
      for (const text of [...MANUAL_DELIVERY_RULES.level1OptionsBullets, ...round.level1.options]) {
        expect(region).toContainElement(screen.getByText(text));
      }
      expect(region).not.toContainElement(screen.getByText(round.level1.coachAsks));
      expect(region).not.toContainElement(screen.getByRole('heading', { level: 2 }));
    },
  );

  test('every authored option instruction in the manual is reachable through the rendered session', () => {
    const rendered = new Set<string>();

    for (const { ordinal } of ROUNDS) {
      const mounted = askAt(ordinal);
      fireEvent.click(screen.getByRole('button', { name: 'Offer the response options' }));
      for (const item of listUnder(RULES_LABEL)) {
        if (item) rendered.add(item);
      }
      mounted.unmount();
    }

    // Source fidelity, stated as a set relation rather than a count: no
    // authored instruction may exist in the model without reaching a screen.
    for (const bullet of MANUAL_DELIVERY_RULES.level1OptionsBullets) {
      expect(rendered).toContain(bullet);
    }
    // Counted on the SCREEN, not in the module. `level1OptionsBullets.length`
    // would have passed with the render deleted, which is the shape of the
    // defect this suite exists to catch.
    expect(rendered.size).toBe(5);
  });
});

/**
 * Revealing replaces the button that was pressed. Without moving focus, a coach
 * on a keyboard or a screen reader asks for the options and is dropped on
 * `document.body` -- the content they requested is on screen and they are
 * nowhere near it. The live region naming the button they just pressed does not
 * fix that; only going there does.
 */
describe('asking for the options takes the coach to them', () => {
  function flushing() {
    const frames: FrameRequestCallback[] = [];
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    return () => act(() => {
      frames.splice(0).forEach((frame) => frame(0));
    });
  }

  function atDecisionPrompt() {
    render(<CoachVisualizationPage />);
    start();
    for (let step = 0; step < 5; step += 1) clickNext();
    expect(prompt()).toBe('Ask the athlete');
  }

  test('focus lands on the labelled coach resource, not the body', () => {
    const flush = flushing();
    atDecisionPrompt();

    const button = screen.getByRole('button', { name: 'Offer the response options' });
    button.focus();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    flush();

    // The pressed control is gone by design, so focus had to go somewhere.
    expect(screen.queryByRole('button', { name: 'Offer the response options' })).toBeNull();

    const region = screen.getByRole('region', { name: 'Coach resource — Offer the response options' });
    expect(document.activeElement).toBe(region);
    expect(document.activeElement).not.toBe(document.body);
  });

  test('what it lands on is the requested content, and the page still has one live region', () => {
    const flush = flushing();
    atDecisionPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Offer the response options' }));
    flush();

    const region = screen.getByRole('region', { name: /^Coach resource/ });
    expect(region).toContainElement(
      screen.getByText(MANUAL_DELIVERY_RULES.level1OptionsBullets[0]),
    );
    expect(region).toContainElement(
      screen.getByText(PF001_RING_CUTTER.rounds[0].level1.options[0]),
    );

    // Concise on purpose: the focused region reads itself, so the region does
    // not recite five instructions over the top of it.
    expect(liveRegion()).toHaveTextContent('Response options offered. Moved to the coach resource.');
    expect(liveRegion().textContent).not.toContain(
      MANUAL_DELIVERY_RULES.level1OptionsBullets[0],
    );
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });
});
