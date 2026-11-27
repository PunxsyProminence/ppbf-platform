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
const COULD_NOT_READ = 'The setting could not be read. Reload to try again.';
const READ_AGAIN = 'It is not known whether that change was saved. The setting shown has been read again.';
const NOT_READ_AGAIN = 'It is not known whether the change was saved, and the setting could not be read again. Reload to see it.';
const REFUSED_403 = 'Not saved: only the gym admin can change this.';
const REFUSED_4XX = 'Not saved: the server refused the change, so nothing was changed.';

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

/** GETs are answered in order, the last one again after that; 'hold' leaves a PUT unanswered until release(). */
let release: (answer: Reply) => void = () => {};
function respond(get: Reply | readonly Reply[], put?: Reply | 'throw' | 'hold') {
  const gets = Array.isArray(get) ? get : [get];
  let read = 0;
  global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      if (put === 'throw') throw new TypeError('Failed to fetch');
      if (put === 'hold') return new Promise<Response>((resolve) => {
        release = (answer) => resolve(reply(answer));
      });
      return reply(put ?? { status: 500 });
    }
    return reply(gets[Math.min(read++, gets.length - 1)]);
  }) as unknown as typeof fetch;
}

const loaded = (gap_days: number, is_default: boolean, choices: unknown = CHOICES): Reply =>
  ({ status: 200, body: { ok: true, gap_days, is_default, choices } });

async function mount() {
  await act(async () => {
    render(<StoppedComingSettings />);
  });
}

const calls = () => (global.fetch as jest.Mock).mock.calls as [unknown, RequestInit | undefined][];
const putCalls = () => calls().filter(([, init]) => init?.method === 'PUT');
const getCalls = () => calls().filter(([, init]) => init?.method !== 'PUT');

const select = () => screen.getByLabelText('Listed after not coming for') as HTMLSelectElement;
const saveButton = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
const defaultButton = () => screen.getByRole('button', { name: 'Use the default' }) as HTMLButtonElement;
const ariaDisabled = (button: HTMLElement) => button.getAttribute('aria-disabled') === 'true';

async function press(button: HTMLElement) {
  await act(async () => {
    fireEvent.click(button);
  });
}

async function saveThree() {
  fireEvent.change(select(), { target: { value: '21' } });
  await press(saveButton());
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
  const [url, init] = calls()[0];
  expect(String(url)).toMatch(/\/api\/pilot\/stopped-coming\/gap$/);
  expect(String(url)).not.toContain('?');
  expect(init).toEqual({ credentials: 'include', cache: 'no-store' });
});

test('"Not set yet" names the default while it applies, and "Use the default" is not offered then', async () => {
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
  expect(defaultButton()).toBeTruthy();
});

test('the status line is mounted, empty, before any save', async () => {
  respond(loaded(14, true));
  await mount();
  expect(screen.getByRole('status').textContent).toBe('');
});

test('Save is aria-disabled, and sends nothing, until the choice changes', async () => {
  respond(loaded(21, false));
  await mount();
  expect(ariaDisabled(saveButton())).toBe(true);
  // aria-disabled only: neither button is natively disabled.
  expect(saveButton().disabled).toBe(false);
  expect(defaultButton().disabled).toBe(false);
  await press(saveButton());
  expect(putCalls()).toHaveLength(0);
  fireEvent.change(select(), { target: { value: '28' } });
  expect(ariaDisabled(saveButton())).toBe(false);
  fireEvent.change(select(), { target: { value: '21' } });
  expect(ariaDisabled(saveButton())).toBe(true);
});

test('Save sends exactly this PUT, and confirms what the server stored', async () => {
  respond(loaded(14, true), { status: 200, body: { ok: true, gap_days: 21, is_default: false, choices: CHOICES } });
  await mount();
  await saveThree();
  const [url, init] = putCalls()[0];
  expect(String(url)).toMatch(/\/api\/pilot\/stopped-coming\/gap$/);
  expect(init).toEqual({
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gap_days: 21 }),
  });
  expect(screen.getByRole('status').textContent).toBe('Saved: 3 weeks.');
  expect(screen.queryByText(/Not set yet/)).toBeNull();
  expect(ariaDisabled(saveButton())).toBe(true);
  expect(defaultButton()).toBeTruthy();
});

test('"Use the default" sends exactly this PUT, and confirms the default applies again', async () => {
  respond(loaded(21, false), { status: 200, body: { ok: true, gap_days: 14, is_default: true, choices: CHOICES } });
  await mount();
  await press(defaultButton());
  const [, init] = putCalls()[0];
  expect(init).toEqual({
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gap_days: null }),
  });
  expect(screen.getByRole('status').textContent).toBe('The default, 2 weeks, applies again.');
  expect(screen.getByText('Not set yet: the default, 2 weeks, applies.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Use the default' })).toBeNull();
  expect(select().value).toBe('14');
});

test('"Use the default" is worded from the default the server returns', async () => {
  respond(loaded(28, false), { status: 200, body: { ok: true, gap_days: 21, is_default: true } });
  await mount();
  await press(defaultButton());
  expect(screen.getByRole('status').textContent).toBe('The default, 3 weeks, applies again.');
  expect(screen.getByText('Not set yet: the default, 3 weeks, applies.')).toBeTruthy();
  expect(select().value).toBe('21');
});

describe('a read that fails, or is not the setting\'s shape, shows the alert and no select', () => {
  test.each<[string, Reply]>([
    ['a non-2xx', { status: 500, body: { ok: false, error: SERVER_ERROR } }],
    ['a non-2xx whose body is a valid setting', { ...loaded(14, true), status: 500 }],
    ['gap_days not one of the choices', loaded(30, false)],
    ['empty choices', loaded(14, true, [])],
    ['a choice that is not a whole number', loaded(14, true, [7, 14, 10.5])],
    ['a choice that is not positive', loaded(14, true, [0, 14])],
    ['a duplicate choice', loaded(14, true, [7, 14, 14])],
    ['a missing is_default', { status: 200, body: { ok: true, gap_days: 14, choices: CHOICES } }],
    ['a body that is not JSON', { status: 200 }],
  ])('%s', async (_name, get) => {
    respond(get);
    await mount();
    expect(screen.getByRole('alert').textContent).toBe(COULD_NOT_READ);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(SERVER_ERROR)).toBeNull();
    // A first read that fails leaves focus to the page.
    expect(screen.getByRole('alert').hasAttribute('tabindex')).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  test('a thrown fetch', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await mount();
    expect(screen.getByRole('alert').textContent).toBe(COULD_NOT_READ);
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

test.each([
  [401, 'Your sign-in has expired. Sign in again to read this setting.'],
  [403, 'Only the gym admin can read this setting.'],
])('a read refused with %i says so, with no select', async (status, words) => {
  respond({ status, body: { ok: false, error: SERVER_ERROR } });
  await mount();
  expect(screen.getByRole('alert').textContent).toBe(words);
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByText(SERVER_ERROR)).toBeNull();
});

describe('a refused PUT says so, is not read again, and leaves the setting as it was', () => {
  test.each<[string, Reply, string]>([
    ['401', { status: 401, body: { error: 'Unauthorized' } }, 'Not saved: your sign-in has expired. Sign in again, then try again.'],
    ['403', { status: 403, body: { error: SERVER_ERROR } }, REFUSED_403],
    ['400', { status: 400, body: { error: 'Unsupported gap_days: choose one of 7, 14' } }, REFUSED_4XX],
    ['404', { status: 404, body: { error: 'Not found' } }, REFUSED_4XX],
    ['409', { status: 409, body: { error: 'Conflict' } }, REFUSED_4XX],
  ])('%s', async (_name, put, words) => {
    respond(loaded(14, true), put);
    await mount();
    await saveThree();
    expect(putCalls()).toHaveLength(1);
    expect(getCalls()).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe(words);
    // The saved value and the default line are as they were; the choice is still the admin's, so Save can be pressed again.
    expect(screen.getByText('Not set yet: the default, 2 weeks, applies.')).toBeTruthy();
    expect(select().value).toBe('21');
    expect(ariaDisabled(saveButton())).toBe(false);
    expect(screen.queryByRole('button', { name: 'Use the default' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Saved:|Forbidden|Unauthorized|Unsupported|Not found|Conflict/);
  });
});

describe('a PUT whose outcome is not known reads the setting again and shows what it read', () => {
  test.each<[string, Reply | 'throw']>([
    ['a 503 whose body is a valid setting', { status: 503, body: { ok: true, gap_days: 21, is_default: false } }],
    ['a thrown fetch', 'throw'],
    ['a 204', { status: 204 }],
    ['a 2xx body that is not JSON', { status: 200 }],
    ['a 2xx that fails the check', { status: 200, body: { ok: true, gap_days: 30, is_default: false } }],
    ['a Save answered with is_default: true', { status: 200, body: { ok: true, gap_days: 21, is_default: true } }],
    ['a Save of 21 answered with 56', { status: 200, body: { ok: true, gap_days: 56, is_default: false } }],
  ])('%s', async (_name, put) => {
    // The re-read finds the gym's own 21 days.
    respond([loaded(14, true), loaded(21, false)], put);
    await mount();
    await saveThree();
    expect(putCalls()).toHaveLength(1);
    expect(getCalls()).toHaveLength(2);
    expect(getCalls()[1][1]).toEqual({ credentials: 'include', cache: 'no-store' });
    expect(screen.getByRole('status').textContent).toBe(READ_AGAIN);
    expect(screen.queryByText(/Not set yet/)).toBeNull();
    expect(defaultButton()).toBeTruthy();
    expect(select().value).toBe('21');
    expect(document.body.textContent).not.toMatch(/Saved:/);
  });

  test('"Use the default" answered with is_default: false is not a confirmation', async () => {
    respond([loaded(21, false), loaded(28, false)], { status: 200, body: { ok: true, gap_days: 14, is_default: false } });
    await mount();
    await press(defaultButton());
    expect(getCalls()).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toBe(READ_AGAIN);
    expect(screen.queryByText(/Not set yet/)).toBeNull();
    expect(select().value).toBe('28');
  });

  test('a re-read that fails shows its own alert, and no select', async () => {
    respond([loaded(14, true), { status: 500, body: loaded(21, false).body }], { status: 503 });
    await mount();
    await saveThree();
    expect(getCalls()).toHaveLength(2);
    expect(screen.getByRole('alert').textContent).toBe(NOT_READ_AGAIN);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    // The drawer it replaced had focus, so focus is sent to the alert.
    expect(document.activeElement).toBe(screen.getByRole('alert'));
  });
});

test('while a PUT runs, both buttons are aria-disabled and send nothing; only the pressed one says "Saving…"', async () => {
  respond(loaded(21, false), 'hold');
  await mount();
  fireEvent.change(select(), { target: { value: '28' } });
  const save = saveButton();
  const useDefault = defaultButton();
  await press(save);
  expect(save.textContent).toBe('Saving…');
  expect(useDefault.textContent).toBe('Use the default');
  expect(ariaDisabled(save)).toBe(true);
  expect(ariaDisabled(useDefault)).toBe(true);
  expect(save.disabled).toBe(false);
  expect(useDefault.disabled).toBe(false);
  expect(select().disabled).toBe(true);
  await press(save);
  await press(useDefault);
  expect(putCalls()).toHaveLength(1);
  await act(async () => {
    release({ status: 200, body: { ok: true, gap_days: 28, is_default: false } });
  });
  expect(screen.getByRole('status').textContent).toBe('Saved: 4 weeks.');
  expect(ariaDisabled(useDefault)).toBe(false);
});

test('while a "Use the default" PUT runs, that button says "Saving…" and Save still says "Save"', async () => {
  respond(loaded(21, false), 'hold');
  await mount();
  const save = saveButton();
  const useDefault = defaultButton();
  await press(useDefault);
  expect(useDefault.textContent).toBe('Saving…');
  expect(save.textContent).toBe('Save');
  expect(ariaDisabled(save)).toBe(true);
  expect(ariaDisabled(useDefault)).toBe(true);
  await act(async () => {
    release({ status: 200, body: { ok: true, gap_days: 14, is_default: true } });
  });
  expect(screen.getByRole('status').textContent).toBe('The default, 2 weeks, applies again.');
});

describe('focus after a press', () => {
  test('after a confirmed "Use the default", whose button goes, focus is on the select', async () => {
    respond(loaded(21, false), { status: 200, body: { ok: true, gap_days: 14, is_default: true } });
    await mount();
    const useDefault = defaultButton();
    useDefault.focus();
    await press(useDefault);
    expect(useDefault.isConnected).toBe(false);
    expect(document.activeElement).toBe(select());
  });

  test('focus moved elsewhere while the PUT runs is left there', async () => {
    respond(loaded(21, false), 'hold');
    await mount();
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    try {
      const useDefault = defaultButton();
      useDefault.focus();
      await press(useDefault);
      elsewhere.focus();
      await act(async () => {
        release({ status: 200, body: { ok: true, gap_days: 14, is_default: true } });
      });
      expect(useDefault.isConnected).toBe(false);
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });

  test('after a Save, focus is still on the Save button', async () => {
    respond(loaded(14, true), { status: 200, body: { ok: true, gap_days: 21, is_default: false } });
    await mount();
    fireEvent.change(select(), { target: { value: '21' } });
    const save = saveButton();
    save.focus();
    await press(save);
    expect(screen.getByRole('status').textContent).toBe('Saved: 3 weeks.');
    expect(document.activeElement).toBe(save);
  });
});

test('a refusal stays on screen an hour later (Law 7: no timer), and the next press clears it first', async () => {
  jest.useFakeTimers();
  try {
    respond(loaded(14, true), { status: 403, body: { error: SERVER_ERROR } });
    await mount();
    const status = screen.getByRole('status');
    await saveThree();
    expect(status.textContent).toBe(REFUSED_403);
    act(() => {
      jest.advanceTimersByTime(60 * 60 * 1000);
    });
    expect(status.textContent).toBe(REFUSED_403);
    // Changing the select does not clear it either.
    fireEvent.change(select(), { target: { value: '28' } });
    expect(status.textContent).toBe(REFUSED_403);

    respond(loaded(14, true), 'hold');
    const save = saveButton();
    await press(save);
    expect(status.textContent).toBe('');
    expect(save.textContent).toBe('Saving…');
    await act(async () => {
      release({ status: 200, body: { ok: true, gap_days: 28, is_default: false } });
    });
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toBe('Saved: 4 weeks.');
  } finally {
    jest.useRealTimers();
  }
});

test('a double click in the same task sends one PUT', async () => {
  respond(loaded(14, true), { status: 200, body: { ok: true, gap_days: 21, is_default: false } });
  await mount();
  fireEvent.change(select(), { target: { value: '21' } });
  // Both clicks land before React re-renders the button as aria-disabled.
  await act(async () => {
    const button = saveButton();
    button.click();
    button.click();
  });
  expect(putCalls()).toHaveLength(1);
  expect(screen.getByRole('status').textContent).toBe('Saved: 3 weeks.');
});
