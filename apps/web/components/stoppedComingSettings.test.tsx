/**
 * @jest-environment jsdom
 */

/*
 * Stopped coming on Customize the Gym (lane W4-6, SC-0b; OW27-30 A, Overwatch
 * W4-6 Q1 A and Q6 A). The server refuses anyone but the gym admin
 * (app/api/pilot/stopped-coming/gap/route.test.ts); this pins what the gym
 * admin sees and sends, and that every line is worded only from what came back.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';

import StoppedComingSettings from './StoppedComingSettings';

const CHOICES = [7, 14, 21, 28, 42, 56];
const SERVER_ERROR = 'Forbidden: only the gym admin sets the stopped-coming days';
const NOT_KNOWN = 'It is not known whether the change was saved. Reload to see the setting.';

interface Reply {
  readonly status: number;
  /** Omitted: the body is not JSON (json() rejects). */
  readonly body?: unknown;
}

const originalFetch = global.fetch;

function reply(answer: Reply): Response {
  return {
    ok: answer.status >= 200 && answer.status < 300,
    status: answer.status,
    json: async () => {
      if (!('body' in answer)) throw new SyntaxError('Unexpected end of JSON input');
      return answer.body;
    },
  } as unknown as Response;
}

function respond(get: Reply, put?: Reply | 'throw') {
  global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      if (put === 'throw') throw new TypeError('Failed to fetch');
      return reply(put ?? { status: 500 });
    }
    return reply(get);
  }) as unknown as typeof fetch;
}

const loaded = (gap_days: number, is_default: boolean, choices: unknown = CHOICES): Reply =>
  ({ status: 200, body: { ok: true, gap_days, is_default, choices } });

async function mount() {
  await act(async () => {
    render(<StoppedComingSettings />);
  });
}

function putCalls(): unknown[][] {
  return (global.fetch as jest.Mock).mock.calls.filter(([, init]) => init?.method === 'PUT');
}

const select = () => screen.getByLabelText('Listed after not coming for') as HTMLSelectElement;
const saveButton = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;

async function saveThree() {
  fireEvent.change(select(), { target: { value: '21' } });
  await act(async () => {
    fireEvent.click(saveButton());
  });
}

afterEach(() => {
  global.fetch = originalFetch;
});

test('the options are exactly the GET\'s choices, in words, starting on the saved value', async () => {
  respond(loaded(14, true));
  await mount();
  expect(Array.from(select().options).map((option) => option.textContent)).toEqual(
    ['1 week', '2 weeks', '3 weeks', '4 weeks', '6 weeks', '8 weeks'],
  );
  expect(Array.from(select().options).map((option) => option.value)).toEqual(['7', '14', '21', '28', '42', '56']);
  expect(select().value).toBe('14');
});

test('the list comes from the GET: another list gives other options', async () => {
  respond(loaded(10, false, [7, 10]));
  await mount();
  expect(Array.from(select().options).map((option) => option.textContent)).toEqual(['1 week', '10 days']);
  expect(select().value).toBe('10');
});

test('the GET asks with no query, with credentials, and not from a cache', async () => {
  respond(loaded(14, true));
  await mount();
  const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
  expect(String(url)).toMatch(/\/api\/pilot\/stopped-coming\/gap$/);
  expect(String(url)).not.toContain('?');
  expect(init).toEqual({ credentials: 'include', cache: 'no-store' });
});

test('"Not set yet" names the server\'s default while it applies, and is absent otherwise', async () => {
  respond(loaded(14, true));
  await mount();
  expect(screen.getByText('Not set yet: the default, 2 weeks, applies.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Use the default' })).toBeNull();
});

test('"Not set yet" is worded from the server\'s gap_days, not a fixed "2 weeks"', async () => {
  respond(loaded(21, true));
  await mount();
  expect(screen.getByText('Not set yet: the default, 3 weeks, applies.')).toBeTruthy();
});

test('no "Not set yet" line once the gym has its own setting', async () => {
  respond(loaded(21, false));
  await mount();
  expect(screen.queryByText(/Not set yet/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Use the default' })).toBeTruthy();
});

test('the status line is mounted, empty, before any save', async () => {
  respond(loaded(14, true));
  await mount();
  expect(screen.getByRole('status').textContent).toBe('');
});

test('Save is disabled until the choice changes', async () => {
  respond(loaded(14, true));
  await mount();
  expect(saveButton().disabled).toBe(true);
  fireEvent.change(select(), { target: { value: '21' } });
  expect(saveButton().disabled).toBe(false);
  fireEvent.change(select(), { target: { value: '14' } });
  expect(saveButton().disabled).toBe(true);
});

test('Save sends exactly { gap_days: 21 } with exact headers, and confirms what the server stored', async () => {
  respond(loaded(14, true), { status: 200, body: { ok: true, gap_days: 21, is_default: false, choices: CHOICES } });
  await mount();
  await saveThree();
  const [url, init] = putCalls()[0] as [unknown, RequestInit];
  expect(String(url)).toMatch(/\/api\/pilot\/stopped-coming\/gap$/);
  expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  expect(JSON.parse(String(init.body))).toEqual({ gap_days: 21 });
  expect(screen.getByRole('status').textContent).toBe('Saved: 3 weeks.');
  expect(screen.queryByText(/Not set yet/)).toBeNull();
  expect(saveButton().disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Use the default' })).toBeTruthy();
});

test('"Use the default" sends exactly { gap_days: null } and confirms the default applies again', async () => {
  respond(loaded(21, false), { status: 200, body: { ok: true, gap_days: 14, is_default: true, choices: CHOICES } });
  await mount();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Use the default' }));
  });
  const [, init] = putCalls()[0] as [unknown, RequestInit];
  expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  expect(JSON.parse(String(init.body))).toEqual({ gap_days: null });
  expect(screen.getByRole('status').textContent).toBe('The default, 2 weeks, applies again.');
  expect(screen.getByText('Not set yet: the default, 2 weeks, applies.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Use the default' })).toBeNull();
  expect(select().value).toBe('14');
});

describe('a read that fails, or is not the setting\'s shape, shows the alert and no select', () => {
  test.each<[string, Reply]>([
    ['a non-2xx', { status: 500, body: { ok: false, error: SERVER_ERROR } }],
    ['gap_days not one of the choices', loaded(30, false)],
    ['empty choices', loaded(14, true, [])],
    ['a choice that is not a whole number', loaded(14, true, [7, 14, 10.5])],
    ['a duplicate choice', loaded(14, true, [7, 14, 14])],
    ['a missing is_default', { status: 200, body: { ok: true, gap_days: 14, choices: CHOICES } }],
    ['a body that is not JSON', { status: 200 }],
  ])('%s', async (_name, get) => {
    respond(get);
    await mount();
    expect(screen.getByRole('alert').textContent).toBe('The setting could not be read. Reload to try again.');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(SERVER_ERROR)).toBeNull();
  });

  test('a thrown fetch', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await mount();
    expect(screen.getByRole('alert').textContent).toBe('The setting could not be read. Reload to try again.');
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

describe('each PUT outcome gives its own line, and the saved state is unchanged', () => {
  test.each<[string, Reply | 'throw', string]>([
    ['401', { status: 401, body: { error: 'Unauthorized' } }, 'Not saved: your sign-in has expired. Sign in again, then try again.'],
    ['403', { status: 403, body: { error: SERVER_ERROR } }, 'Not saved: only the gym admin can change this.'],
    ['400', { status: 400, body: { error: 'Unsupported gap_days: choose one of 7, 14' } }, 'Not saved: the server refused the change, so nothing was changed.'],
    ['500', { status: 500, body: { error: 'relation does not exist' } }, NOT_KNOWN],
    ['a thrown fetch', 'throw', NOT_KNOWN],
    ['a 204', { status: 204 }, NOT_KNOWN],
    ['a 2xx body that is not JSON', { status: 200 }, NOT_KNOWN],
    ['a 2xx that fails the check', { status: 200, body: { ok: true, gap_days: 30, is_default: false } }, NOT_KNOWN],
    ['a Save answered with is_default: true', { status: 200, body: { ok: true, gap_days: 21, is_default: true } }, NOT_KNOWN],
  ])('%s', async (_name, put, words) => {
    respond(loaded(14, true), put);
    await mount();
    await saveThree();
    expect(putCalls()).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe(words);
    // The saved value and the default line are as they were; the choice is still the admin's, so Save can be pressed again.
    expect(screen.getByText('Not set yet: the default, 2 weeks, applies.')).toBeTruthy();
    expect(select().value).toBe('21');
    expect(saveButton().disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Use the default' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Saved:|Forbidden|Unauthorized|Unsupported|relation/);
  });

  test('"Use the default" answered with is_default: false is not a confirmation', async () => {
    respond(loaded(21, false), { status: 200, body: { ok: true, gap_days: 14, is_default: false } });
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use the default' }));
    });
    expect(screen.getByRole('status').textContent).toBe(NOT_KNOWN);
    expect(screen.queryByText(/Not set yet/)).toBeNull();
    expect(select().value).toBe('21');
    expect(screen.getByRole('button', { name: 'Use the default' })).toBeTruthy();
  });
});

test('the next press clears the old line first, and the same status line carries the new one', async () => {
  respond(loaded(14, true), { status: 403, body: { error: SERVER_ERROR } });
  await mount();
  const status = screen.getByRole('status');
  await saveThree();
  expect(status.textContent).toBe('Not saved: only the gym admin can change this.');

  let resolvePut: (response: Response) => void = () => {};
  global.fetch = jest.fn(() => new Promise<Response>((resolve) => {
    resolvePut = resolve;
  })) as unknown as typeof fetch;
  const button = saveButton();
  await act(async () => {
    fireEvent.click(button);
  });
  expect(status.textContent).toBe('');
  expect(button.textContent).toBe('Saving…');
  expect(button.disabled).toBe(true);
  expect(select().disabled).toBe(true);
  await act(async () => {
    resolvePut(reply({ status: 200, body: { ok: true, gap_days: 21, is_default: false } }));
  });
  expect(screen.getByRole('status')).toBe(status);
  expect(status.textContent).toBe('Saved: 3 weeks.');
});

test('a double click in the same task sends one PUT', async () => {
  respond(loaded(14, true), { status: 200, body: { ok: true, gap_days: 21, is_default: false } });
  await mount();
  fireEvent.change(select(), { target: { value: '21' } });
  // Both clicks land before React re-renders the button as disabled.
  await act(async () => {
    const button = saveButton();
    button.click();
    button.click();
  });
  expect(putCalls()).toHaveLength(1);
  expect(screen.getByRole('status').textContent).toBe('Saved: 3 weeks.');
});
