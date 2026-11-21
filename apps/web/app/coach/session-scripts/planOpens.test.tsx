/**
 * @jest-environment jsdom
 */

// Lane 6C7, U2-6c (app scrub CF-08: "Scroll to (or open beside) the opened plan; repeat the class
// choice by the start button"). On Session Plans the class choice is at the top, the opened plan is
// drawn below the whole plans grid, and "Open plan" used to change only its own words.
//
// Pinned here on the rendered DOM (jsdom): opening a plan moves focus to the plan's heading and
// asks the browser to scroll it into view; the line beside "Start live delivery" names the class
// chosen at the top, in the picker's own words, or says to choose one. jsdom lays nothing out, so
// where the heading lands on a tablet has not been checked.

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import CoachSessionScriptsPage from './page';
import { classTimes } from '@/components/SessionClassPicker';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));
jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));
// ONE router object for the whole file (AGENT_KERNEL.md: a fresh object per render can loop).
const mockRouter = { push: jest.fn(), replace: jest.fn() };
jest.mock('next/navigation', () => ({ ...jest.requireActual('next/navigation'), useRouter: () => mockRouter }));
jest.mock('@/components/FinishedSessions', () => ({ __esModule: true, default: () => null }));

const FRIDAY = {
  script_id: 'scr-friday',
  name: 'Friday sparring',
  discipline: 'boxing',
  theme: '',
  phase: 'sharpening',
  day_of_week: 'friday',
  total_minutes: 60,
  contact_structure: 'non_contact',
  authoring_state: 'in_use',
};
const TUESDAY = { ...FRIDAY, script_id: 'scr-tuesday', name: 'Tuesday technical', day_of_week: 'tuesday' };

const BLOCK = {
  block_id: 'blk-1',
  block_order: 1,
  start_offset_min: 0,
  end_offset_min: 10,
  block_label: 'Arrival and wraps',
  what_to_say: 'Wraps on, eyes up.',
  what_to_explain: 'Why we wrap.',
  what_to_watch: 'Loose wraps.',
  what_to_fix: 'Rewrap.',
  block_kind: 'arrival',
  drill_id: null,
  scale_level: null,
  contact_level: 'none',
};

function detailOf(script: typeof FRIDAY, blocks: unknown[] = [BLOCK]) {
  return { ...script, reset_protocol: '', coach_priorities: '', blocks, renderings: [] };
}

const MINUTE = 60 * 1000;
function classRow(id: string, title: string, startOffsetMin: number) {
  return {
    class_id: id,
    title,
    start_at: new Date(Date.now() + startOffsetMin * MINUTE).toISOString(),
    end_at: new Date(Date.now() + (startOffsetMin + 60) * MINUTE).toISOString(),
    held_by_other_session: false,
  };
}

function json(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

function serve(classes: unknown[], blocks: unknown[] = [BLOCK]) {
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== 'GET') throw new Error(`this suite starts nothing: ${init.method} ${url}`);
    if (url.includes('/api/pilot/session-scripts/runs')) {
      if (url.includes('classes=today')) return json({ classes });
      if (url.includes('script_id=')) return json({ runs: [] });
      return json({ run: null });
    }
    if (url.includes('script_id=scr-tuesday')) return json({ script: detailOf(TUESDAY, blocks) });
    if (url.includes('script_id=')) return json({ script: detailOf(FRIDAY, blocks) });
    if (url.includes('/api/pilot/session-scripts')) return json({ scripts: [FRIDAY, TUESDAY] });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

let scrolled: Array<{ element: Element; options: unknown }>;

beforeEach(() => {
  jest.clearAllMocks();
  scrolled = [];
  // jsdom has no layout and no scrollIntoView; the page asks for it, and this records the ask.
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element, options?: unknown) {
    scrolled.push({ element: this, options });
  } as typeof Element.prototype.scrollIntoView;
  window.history.replaceState({}, '', '/coach/session-scripts');
});

async function renderPage() {
  await act(async () => {
    render(<CoachSessionScriptsPage />);
  });
  await screen.findByRole('heading', { level: 3, name: 'Friday sparring' });
}

async function openPlan(name: string) {
  const card = screen.getByRole('heading', { level: 3, name }).closest('article') as HTMLElement;
  await act(async () => {
    fireEvent.click(within(card).getByRole('button', { name: /Open plan|Showing plan/ }));
  });
  return screen.findByRole('heading', { level: 2, name });
}

describe('the opened plan is brought into view (CF-08)', () => {
  test("opening a plan moves focus to the plan's heading and scrolls it into view", async () => {
    serve([]);
    await renderPage();
    expect(scrolled).toEqual([]);

    const heading = await openPlan('Friday sparring');
    expect(document.activeElement).toBe(heading);
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(scrolled).toEqual([{ element: heading, options: { block: 'center' } }]);
  });

  test('opening another plan goes there again', async () => {
    serve([]);
    await renderPage();
    await openPlan('Friday sparring');
    // The coach scrolls back up and taps a different card: focus is on that button until the plan opens.
    const heading = await openPlan('Tuesday technical');
    expect(document.activeElement).toBe(heading);
    expect(scrolled).toHaveLength(2);
    expect(scrolled[1]).toEqual({ element: heading, options: { block: 'center' } });
  });

  test('a plan opened from the address (?script=) is brought into view too', async () => {
    window.history.replaceState({}, '', '/coach/session-scripts?script=scr-tuesday');
    serve([]);
    await renderPage();
    const heading = await screen.findByRole('heading', { level: 2, name: 'Tuesday technical' });
    expect(document.activeElement).toBe(heading);
    expect(scrolled).toEqual([{ element: heading, options: { block: 'center' } }]);
  });

  test('nothing is scrolled or focused until a plan is opened', async () => {
    serve([]);
    await renderPage();
    expect(scrolled).toEqual([]);
    expect(screen.queryByRole('heading', { level: 2, name: 'Session plan' })).toBeNull();
  });
});

describe('the class chosen at the top is named by the start button (CF-08)', () => {
  test('one class under way: the start line names it, in the picker\'s words', async () => {
    const evening = classRow('class-1', 'Evening Fundamentals', -10);
    serve([evening]);
    await renderPage();
    await openPlan('Friday sparring');

    expect(screen.getByRole('button', { name: 'Start live delivery' })).toBeEnabled();
    expect(screen.getByText(
      `This session is for: Evening Fundamentals, ${classTimes(evening)}. To change it, choose the class at the top of the page.`,
    )).toBeInTheDocument();
    expect(screen.queryByText('Choose the class at the top of the page to start.')).toBeNull();
  });

  test('no class today: the start line says open gym', async () => {
    serve([]);
    await renderPage();
    await openPlan('Friday sparring');
    expect(screen.getByText(
      'This session is for: No class (open gym). To change it, choose the class at the top of the page.',
    )).toBeInTheDocument();
  });

  test('nothing chosen yet: it says to choose, names no class, and names the class once the coach picks', async () => {
    const early = classRow('class-1', 'Evening Fundamentals', -10);
    const late = classRow('class-2', 'Evening Sparring', -5);
    serve([early, late]);
    await renderPage();
    await openPlan('Friday sparring');

    expect(screen.getByRole('button', { name: 'Start live delivery' })).toBeDisabled();
    expect(screen.getByText('Choose the class at the top of the page to start.')).toBeInTheDocument();
    expect(screen.queryByText(/^This session is for:/)).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: new RegExp('^Evening Sparring') }));
    expect(screen.getByText(
      `This session is for: Evening Sparring, ${classTimes(late)}. To change it, choose the class at the top of the page.`,
    )).toBeInTheDocument();
    expect(screen.queryByText('Choose the class at the top of the page to start.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Start live delivery' })).toBeEnabled();
  });

  test('Start sends the class the line names', async () => {
    const early = classRow('class-1', 'Evening Fundamentals', -10);
    const late = classRow('class-2', 'Evening Sparring', -5);
    serve([early, late]);
    const readOnly = global.fetch as jest.Mock;
    const starts: unknown[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST' && String(input).endsWith('/api/pilot/session-scripts/runs')) {
        starts.push(JSON.parse(String(init.body)));
        return json({ run: { run_id: 'run-1', class_id: 'class-2' } });
      }
      return readOnly(input, init);
    }) as unknown as typeof fetch;
    await renderPage();
    await openPlan('Friday sparring');

    fireEvent.click(screen.getByRole('radio', { name: new RegExp('^Evening Sparring') }));
    expect(screen.getByText(/^This session is for: Evening Sparring, /)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start live delivery' }));
    });
    expect(starts).toEqual([{ script_id: 'scr-friday', class_id: 'class-2' }]);
  });

  test('a plan with no blocks has no start, so no class line either', async () => {
    serve([classRow('class-1', 'Evening Fundamentals', -10)], []);
    await renderPage();
    await openPlan('Friday sparring');
    expect(screen.queryByRole('button', { name: 'Start live delivery' })).toBeNull();
    expect(screen.queryByText(/^This session is for:/)).toBeNull();
    expect(screen.queryByText('Choose the class at the top of the page to start.')).toBeNull();
  });
});
