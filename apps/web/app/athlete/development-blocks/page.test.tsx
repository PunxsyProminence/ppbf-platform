/**
 * @jest-environment jsdom
 */

/*
 * The athlete reading their own plan, and the guardian reading the same one.
 *
 * Both pages render DevelopmentBlockPlanView, so its behaviour is asserted
 * once here and the parent page's own file covers only what is different
 * about it (the child picker and the stale-answer guard).
 *
 * Three properties are worth a test and the rest is the route's job:
 *
 *   1. the coach's words arrive verbatim -- owner decision 2026-08-28. No
 *      truncation, no reflow, no softening, and the body-composition domain
 *      rendered like any other.
 *   2. nothing is computed. No count of completed objectives, no proportion,
 *      no progress element, no grading language. Shown to a child, a count is
 *      a score about that child produced by arithmetic rather than by a coach.
 *   3. a failed read is never rendered as "there is no plan". A family who
 *      reads that concludes the gym is not planning for their child.
 */

import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import AthleteDevelopmentBlocksPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function objective(overrides: Record<string, unknown> = {}) {
  return {
    objective_id: 'obj-1',
    domain: 'technical',
    objective: 'Jab off the back foot under pressure, not just off the front.',
    status: 'draft',
    ...overrides,
  };
}

function planBlock(overrides: Record<string, unknown> = {}) {
  return {
    block_id: 'blk-1',
    title: 'Winter technical block',
    training_emphasis: 'Guard recovery off the jab.',
    starts_on: '2026-09-01',
    ends_on: '2026-10-13',
    status: 'draft',
    objectives: [objective()],
    ...overrides,
  };
}

interface Stubs {
  ok?: boolean;
  blocks?: Array<Record<string, unknown>>;
}

function installFetch(stubs: Stubs = {}): jest.Mock {
  const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/pilot/athlete/development-blocks')) {
      return {
        ok: stubs.ok ?? true,
        status: stubs.ok === false ? 503 : 200,
        json: async () => ({ ok: true, blocks: stubs.blocks ?? [planBlock()] }),
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderPage(stubs: Stubs = {}) {
  const fetchMock = installFetch(stubs);
  await act(async () => {
    render(<AthleteDevelopmentBlocksPage />);
  });
  return fetchMock;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('reading your own plan', () => {
  test('the read names no athlete: the subject comes from the session', async () => {
    /* An athlete_id in this request would be a value the client controls
       over whose record is read. The route ignores it for an athlete caller,
       and this page never sends one -- belt and braces, with both real. */
    const fetchMock = await renderPage();

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('/api/pilot/athlete/development-blocks'))).toBe(true);
    expect(urls.some((url) => url.includes('athlete_id'))).toBe(false);
  });

  test('the coach\'s words are shown exactly as written', async () => {
    await renderPage({
      blocks: [planBlock({ training_emphasis: '  Stop backing straight up  under pressure.  ' })],
    });

    /* textContent rather than getByText, which normalizes runs of whitespace
       and so cannot express "exactly". The coach typed it; the screen does
       not tidy it. */
    const paragraphs = Array.from(document.querySelectorAll('p')).map((n) => n.textContent ?? '');
    expect(paragraphs).toContain('  Stop backing straight up  under pressure.  ');
  });

  test('a body-composition objective is rendered like any other', async () => {
    /* Owner decision 2026-08-28: everything, verbatim, including this domain.
       Asserted so that a later change which quietly filters it fails here
       rather than silently narrowing what a family is told. */
    await renderPage({
      blocks: [planBlock({
        objectives: [
          objective({ objective_id: 'obj-1', domain: 'technical' }),
          objective({
            objective_id: 'obj-2',
            domain: 'nutrition_body_composition',
            objective: 'Eat a real breakfast before morning conditioning.',
          }),
        ],
      })],
    });

    expect(screen.getByText('Nutrition & body composition')).toBeTruthy();
    expect(screen.getByText('Eat a real breakfast before morning conditioning.')).toBeTruthy();
    // And no apparatus the domain does not have: no weight, no target, no chart.
    const body = (document.body.textContent ?? '').toLowerCase();
    for (const forbidden of ['kg', 'lbs', 'body fat', 'bmi', 'target weight', 'weight class']) {
      expect(body).not.toContain(forbidden);
    }
  });

  test('the page computes nothing about the athlete', async () => {
    await renderPage({
      blocks: [planBlock({
        objectives: [
          objective({ objective_id: 'obj-1', status: 'completed' }),
          objective({ objective_id: 'obj-2', status: 'completed' }),
          objective({ objective_id: 'obj-3', status: 'draft' }),
        ],
      })],
    });

    /* SCOPED TO THE PLAN LIST, not the document. The page header tells the
       athlete in so many words that this is "the plan, not a score" -- its
       own promise not to do this -- so a body-wide check fails on the
       reassurance rather than on a defect. The claim under test is about
       what the plan itself renders. */
    const list = screen.getByText('Winter technical block').closest('ul') as HTMLElement;
    const text = (list.textContent ?? '').toLowerCase();

    expect(text).not.toMatch(/\b2\s*(of|\/|out of)\s*3\b/);
    expect(text).not.toMatch(/\d+\s*%/);
    for (const forbidden of ['score', 'rating', 'grade', 'adherence', 'compliance', 'on track']) {
      expect(text).not.toContain(forbidden);
    }
    expect(list.querySelector('progress')).toBeNull();
    expect(list.querySelector('[role="progressbar"]')).toBeNull();
    expect(list.querySelector('meter')).toBeNull();
  });

  test('the page offers no control that could change anything', async () => {
    /* Reading is not writing. There is no status select, no edit button and
       no form: an athlete deciding their own block was completed is the coach
       judgment this table refuses to compute, and the route behind this page
       has no write verb to call even if one appeared here. */
    await renderPage();

    expect(document.querySelectorAll('select')).toHaveLength(0);
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
    expect(document.querySelectorAll('input')).toHaveLength(0);
    expect(document.querySelectorAll('form')).toHaveLength(0);
    expect(document.querySelectorAll('button')).toHaveLength(0);
  });

  test('no staff account identifier is printed to the athlete', async () => {
    // created_by_account_id is an id, not a name. Printing it to a family is
    // a leak dressed as attribution; the coach's WORDS are what is owed.
    await renderPage();

    expect(document.body.textContent ?? '').not.toContain('acct-');
  });

  test('a failed read is not rendered as "you have no plan"', async () => {
    await renderPage({ ok: false });

    expect(screen.getByText(/could not be loaded just now/i)).toBeTruthy();
    expect(screen.queryByText(/has not written a development block/i)).toBeNull();
  });

  test('an athlete with genuinely none is told that, distinctly', async () => {
    await renderPage({ blocks: [] });

    expect(screen.getByText(/has not written a development block/i)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded just now/i)).toBeNull();
  });

  test('a block with no objectives says so rather than rendering an empty rule', async () => {
    await renderPage({ blocks: [planBlock({ objectives: [] })] });

    expect(screen.getByText(/No per-area objectives written/i)).toBeTruthy();
    // The block itself is still fully shown.
    expect(screen.getByText('Winter technical block')).toBeTruthy();
  });
});
