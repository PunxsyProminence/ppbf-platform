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

function clickNext() {
  fireEvent.click(screen.getByRole('button', { name: 'Next prompt' }));
}

function runAt(level: 1 | 2 | 3) {
  fireEvent.click(screen.getByRole('button', { name: `Run at Level ${level}` }));
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

describe('the coach chooses how to deliver it before anything runs', () => {
  test("the manual's three levels are offered, with its rules, and no prompt is showing yet", () => {
    render(<CoachVisualizationPage />);

    expect(prompt()).toBe('Choose how you will deliver it');
    for (const row of MANUAL_DELIVERY_RULES.deliveryLevels) {
      expect(screen.getByText(row.level)).toBeInTheDocument();
      expect(screen.getByText(row.coachGivesTiming)).toBeInTheDocument();
      expect(screen.getByText(row.purpose)).toBeInTheDocument();
    }
    for (const rule of MANUAL_DELIVERY_RULES.visualizationRules) {
      expect(screen.getByText(rule)).toBeInTheDocument();
    }
    expect(screen.getByText(MANUAL_DELIVERY_RULES.level3Note)).toBeInTheDocument();
    expect(screen.queryByText(/^Step \d+ of \d+$/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next prompt' })).toBeNull();

    // Scenario identity and its source are on screen from the start.
    expect(screen.getByText(/PF-001 · The Ring-Cutter · Pressure Fighter · Foundation · 1 OF 17/)).toBeInTheDocument();
    expect(
      screen.getByText(/Adaptive_Amateur_Boxing_Visualization_Curriculum_100_Scenarios\.docx.*Content V4\.1.*2026-09-15/),
    ).toBeInTheDocument();
  });

  test('it reads the network not at all, at any level', () => {
    render(<CoachVisualizationPage />);
    runAt(1);
    walkEverything();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('the level chosen is named beside the position', () => {
    render(<CoachVisualizationPage />);
    runAt(2);
    expect(screen.getByText('Before the bell · Level 2')).toBeInTheDocument();
    expect(position()).toBe('Step 1 of 13');
  });
});

describe('Level 1 — Guided: the authored order, and options only on request', () => {
  test('every prompt appears once, in the source sequence, ending at session complete', () => {
    render(<CoachVisualizationPage />);
    runAt(1);

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
    runAt(1);
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
    runAt(1);
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
  });

  test('asking for the options in one round does not reveal them in the next', () => {
    render(<CoachVisualizationPage />);
    runAt(1);
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

describe('Level 2 and Level 3 deliver their own way', () => {
  test('Level 2 gives reduced cues and never a fed answer', () => {
    render(<CoachVisualizationPage />);
    runAt(2);

    const delivered = walkEverything();
    expect(delivered).toEqual([
      'Before the Bell — Build the Opponent',
      'Key visual cues',
      'Common athlete mistakes',
      'What am I fighting?',
      'Level 2 — Reduced Cues',
      'Corner note',
      'How can I use what I discovered?',
      'Level 2 — Reduced Cues',
      'Corner note',
      'Can I solve an opponent who is now trying to solve me?',
      'Level 2 — Reduced Cues',
      'Post-Fight Debrief',
      'Session complete',
    ]);
    expect(screen.queryByRole('button', { name: 'Offer the response options' })).toBeNull();
  });

  test('Level 3 gives cues only, and says a cue is not an instruction', () => {
    render(<CoachVisualizationPage />);
    runAt(3);
    clickNext();
    clickNext();
    clickNext();
    clickNext();

    expect(prompt()).toBe('Level 3 — Cue-Only Version');
    // The authored cue line pads its bullets with double spaces; the DOM query
    // normalizes whitespace, so the expectation is normalized the same way
    // rather than the content being tidied.
    expect(screen.getByText(PF001_RING_CUTTER.rounds[0].level3Cues.replace(/\s+/g, ' '))).toBeInTheDocument();
    expect(screen.getByText(MANUAL_DELIVERY_RULES.level3Note)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Offer the response options' })).toBeNull();
  });
});

describe('the controls a coach needs on the floor', () => {
  test('repeating a prompt keeps the place', () => {
    render(<CoachVisualizationPage />);
    runAt(1);
    clickNext();
    const before = position();

    fireEvent.click(screen.getByRole('button', { name: 'Repeat this prompt' }));

    expect(position()).toBe(before);
    expect(prompt()).toBe('Key visual cues');
  });

  test('rebuilding the picture returns to the opponent, then back to the same prompt', () => {
    render(<CoachVisualizationPage />);
    runAt(1);
    for (let step = 0; step < 4; step += 1) clickNext();
    const wasAt = position();

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild the picture' }));
    expect(prompt()).toBe('Before the Bell — Build the Opponent');

    fireEvent.click(screen.getByRole('button', { name: 'Back to Round 1 of 3 — DISCOVER' }));
    expect(position()).toBe(wasAt);
    expect(prompt()).toBe('The opponent acts');
  });

  test('pause holds the fight where it is until resume', () => {
    render(<CoachVisualizationPage />);
    runAt(1);
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

  test('focus moves to the prompt, so a keyboard coach lands on what to say', () => {
    const frames: FrameRequestCallback[] = [];
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });

    render(<CoachVisualizationPage />);
    runAt(1);
    clickNext();
    act(() => {
      frames.splice(0).forEach((frame) => frame(0));
    });

    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 }));
  });
});

describe('the debrief, and what the session refuses to claim', () => {
  function walkToDebrief(level: 1 | 2 | 3 = 1) {
    render(<CoachVisualizationPage />);
    runAt(level);
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
    runAt(1);
    while (prompt() !== 'Post-Fight Debrief') clickNext();
    const field = screen.getByLabelText(PF001_RING_CUTTER.debriefQuestions[0]);
    fireEvent.change(field, { target: { value: 'He cut me off at the lead foot.' } });
    expect(field).toHaveValue('He cut me off at the lead foot.');

    // A refresh is a new unsaved exposure: nothing was stored where a second
    // mount could read it.
    first.unmount();
    render(<CoachVisualizationPage />);
    expect(prompt()).toBe('Choose how you will deliver it');
    runAt(1);
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

  test('a new exposure starts from the level choice, clean', () => {
    walkToDebrief();
    fireEvent.change(screen.getByLabelText(PF001_RING_CUTTER.debriefQuestions[0]), {
      target: { value: 'notes' },
    });
    clickNext();

    fireEvent.click(screen.getByRole('button', { name: 'Start a new exposure' }));
    expect(prompt()).toBe('Choose how you will deliver it');

    runAt(1);
    while (prompt() !== 'Post-Fight Debrief') clickNext();
    expect(screen.getByLabelText(PF001_RING_CUTTER.debriefQuestions[0])).toHaveValue('');
  });

  test('nothing on the surface scores, grades or promotes', () => {
    render(<CoachVisualizationPage />);
    runAt(1);
    const everything = walkEverything().join(' ') + document.body.textContent;
    // No judgement anywhere. The one sentence that mentions readiness is the
    // disclaimer refusing that claim, so the claim itself is asserted instead.
    for (const word of [/\bscore/i, /mastery/i, /\bpassed\b/i, /\bfailed\b/i, /\bpromote/i, /\bgrade\b/i, /vividness/i]) {
      expect(everything).not.toMatch(word);
    }
    expect(everything).toContain('does not say the athlete has learned to');
    for (const name of [/save/i, /submit/i, /log /i, /complete session/i, /assign/i, /issue/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
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
