/**
 * @jest-environment jsdom
 */

// Lane W4-3, FN-2: the parent's and the athlete's "on the floor now" line.
// Jason's words (FN0-Q2 A, OD-2026-11-25-002) and App Overwatch's failed and
// loading words (QA A, #2192), asserted as literal text. It reads once when the
// page opens, keeps nothing on the device, shows a parent nothing for a child who
// does not count (FN-0 F4), and a failed or unfinished read never reads as "not
// on the floor" (F15).

import { act, render, screen } from '@testing-library/react';

import OnTheFloorFamilyLine, { ON_THE_FLOOR_FAMILY_WORDS } from './OnTheFloorFamilyLine';

const originalFetch = global.fetch;
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
  // Nothing from the line is kept on the device, on any path (FN-0 F10).
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
  expect(document.cookie).toBe('');
});

function respond(status: number, body: unknown) {
  global.fetch = jest.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response) as unknown as typeof fetch;
}

const CHILDREN = [
  { id: 'a-1', name: 'Ada' },
  { id: 'a-2', name: 'Ben' },
  { id: 'a-3', name: 'Cal' },
];

const parentLine = () => <OnTheFloorFamilyLine reader="parent" childList={CHILDREN} />;

test('the words are Jason\'s and QA A\'s, exactly', () => {
  expect(ON_THE_FLOOR_FAMILY_WORDS.childOn('Ada')).toBe('Ada is on the floor now.');
  expect(ON_THE_FLOOR_FAMILY_WORDS.childChecking('Ada')).toBe('Checking whether Ada is on the floor...');
  expect(ON_THE_FLOOR_FAMILY_WORDS.childFailed('Ada')).toBe('Whether Ada is on the floor could not be checked just now.');
  expect(ON_THE_FLOOR_FAMILY_WORDS.youOn).toBe("You're on the floor now.");
  expect(ON_THE_FLOOR_FAMILY_WORDS.youNot).toBe("You're not counted on the floor right now.");
  expect(ON_THE_FLOOR_FAMILY_WORDS.youChecking).toBe("Checking whether you're on the floor...");
  expect(ON_THE_FLOOR_FAMILY_WORDS.youFailed).toBe("Whether you're on the floor could not be checked just now.");
});

describe('a parent', () => {
  test('sees a line for each own child who counts, by the hub\'s name, and nothing for one who does not', async () => {
    respond(200, { ok: true, on_the_floor: ['a-3', 'a-1', 'a-9'] });
    const { container } = render(parentLine());
    expect(await screen.findByText('Ada is on the floor now.')).toBeTruthy();
    expect(screen.getByText('Cal is on the floor now.')).toBeTruthy();
    // Ben has no mark: no line at all, never "not here" (F4). An id the hub does not hold names nobody.
    expect(container.textContent).not.toMatch(/Ben|not|absent|a-9/i);
    expect(container.innerHTML).not.toMatch(/a-1|a-2|a-3|a-9/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/pilot/on-the-floor'),
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    );
  });

  test('with no child counted, nothing is shown at all', async () => {
    respond(200, { ok: true, on_the_floor: [] });
    const { container } = render(parentLine());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/Checking/)).toBeNull();
    expect(container.innerHTML).toBe('');
  });

  test('while the read is in progress, it says it is checking each child, never that they are not there', () => {
    global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(parentLine());
    for (const name of ['Ada', 'Ben', 'Cal']) {
      expect(screen.getByText(`Checking whether ${name} is on the floor...`)).toBeTruthy();
    }
    expect(screen.getByRole('region', { name: 'On the floor' }).getAttribute('aria-busy')).toBe('true');
  });

  test.each([
    ['a server error', () => respond(500, { error: 'Not available' })],
    ['a refusal', () => respond(403, { error: 'Not available' })],
    ['an error status whose body still says ok with an empty list', () => respond(500, { ok: true, on_the_floor: [] })],
    ['an error status whose body still carries ids', () => respond(503, { ok: true, on_the_floor: ['a-1'] })],
    ['a network failure', () => { global.fetch = jest.fn(async () => { throw new TypeError('network'); }) as unknown as typeof fetch; }],
    ['a body that is not JSON', () => {
      global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }) as unknown as Response) as unknown as typeof fetch;
    }],
    ['an empty body', () => respond(200, null)],
    ['an answer not marked ok', () => respond(200, { ok: false, on_the_floor: [] })],
    ['an answer with no list', () => respond(200, { ok: true })],
    ['an athlete\'s yes or no instead of a list', () => respond(200, { ok: true, on_the_floor: true })],
    ['a list with an entry that is not an id', () => respond(200, { ok: true, on_the_floor: ['a-1', 7] })],
  ])('%s says, for each child, that it could not be checked; never nothing, never a yes', async (_label, arrange) => {
    arrange();
    render(parentLine());
    for (const name of ['Ada', 'Ben', 'Cal']) {
      expect(await screen.findByText(`Whether ${name} is on the floor could not be checked just now.`)).toBeTruthy();
    }
    expect(screen.queryByText(/is on the floor now\./)).toBeNull();
  });
});

describe('an athlete', () => {
  const athleteLine = (visible?: boolean) => <OnTheFloorFamilyLine reader="athlete" visible={visible} />;

  test.each([
    [true, "You're on the floor now."],
    [false, "You're not counted on the floor right now."],
  ])('on_the_floor %s reads "%s"', async (onTheFloor, words) => {
    respond(200, { ok: true, on_the_floor: onTheFloor });
    render(athleteLine());
    expect(await screen.findByText(words)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'On the floor' }).getAttribute('aria-busy')).toBe('false');
  });

  test('while the read is in progress it says it is checking, never "not counted"', () => {
    global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(athleteLine());
    expect(screen.getByText("Checking whether you're on the floor...")).toBeTruthy();
    expect(screen.queryByText(/not counted/)).toBeNull();
  });

  test.each([
    ['a server error', () => respond(500, { error: 'Not available' })],
    ['a refusal', () => respond(403, { error: 'Not available' })],
    ['an error status whose body still says no', () => respond(500, { ok: true, on_the_floor: false })],
    ['an error status whose body still says yes', () => respond(503, { ok: true, on_the_floor: true })],
    ['a network failure', () => { global.fetch = jest.fn(async () => { throw new TypeError('network'); }) as unknown as typeof fetch; }],
    ['an empty body', () => respond(200, null)],
    ['an answer not marked ok', () => respond(200, { ok: false, on_the_floor: false })],
    ['a parent\'s list instead of a yes or no', () => respond(200, { ok: true, on_the_floor: [] })],
    ['a yes or no written as text', () => respond(200, { ok: true, on_the_floor: 'false' })],
  ])('%s says it could not be checked, never "not counted"', async (_label, arrange) => {
    arrange();
    render(athleteLine());
    expect(await screen.findByText("Whether you're on the floor could not be checked just now.")).toBeTruthy();
    expect(screen.queryByText(/not counted|on the floor now\./)).toBeNull();
  });

  test('off Today it shows nothing, and coming back to Today does not read it again', async () => {
    respond(200, { ok: true, on_the_floor: true });
    const { rerender, container } = render(athleteLine(false));
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.innerHTML).toBe('');
    rerender(athleteLine(true));
    expect(await screen.findByText("You're on the floor now.")).toBeTruthy();
    rerender(athleteLine(false));
    rerender(athleteLine(true));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

test('leaving the page while the read is in progress cancels it', () => {
  let signal: AbortSignal | undefined;
  global.fetch = jest.fn((_url: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise(() => {});
  }) as unknown as typeof fetch;
  const { unmount } = render(parentLine());
  expect(signal?.aborted).toBe(false);
  unmount();
  expect(signal?.aborted).toBe(true);
});

test('it reads once when the page opens: no timer, focus, visibility, page-show or network change reads it again', async () => {
  jest.useFakeTimers();
  respond(200, { ok: true, on_the_floor: true });
  render(<OnTheFloorFamilyLine reader="athlete" />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    jest.advanceTimersByTime(25 * 60 * 60 * 1000);
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('pageshow'));
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('one neutral line per child at the floor size: no warning, hold or medical colour (FN-0 F12)', async () => {
  respond(200, { ok: true, on_the_floor: ['a-1'] });
  const { container } = render(parentLine());
  const line = await screen.findByText('Ada is on the floor now.');
  expect(line.className).toBe('t-body');
  expect(line.style.fontSize).toBe('var(--t-md)');
  expect(line.style.color).toBe('');
  expect(screen.getByRole('region', { name: 'On the floor' }).className).toBe('rounded-[var(--r-lg)] p-[var(--s4)]');
  expect(container.innerHTML).not.toMatch(/restricted|locked|warn|danger|alert|monitor|red-highlight|rust|blood/i);
});
