/**
 * @jest-environment jsdom
 */

/*
 * Gym tablet sign-out on Customize the Gym (lane U1, AS2-b; OW25-53 A,
 * Overwatch Q1-Q3). The server refuses anyone but the gym admin
 * (app/api/pilot/gym-tablet/idle/route.test.ts); this pins what the gym
 * admin sees and sends.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';

import GymTabletSettings from './GymTabletSettings';
import { isGymTabletMarked } from '@/src/lib/gymTabletMark';
import { turnOffPushInThisBrowser } from './PushAlertSwitch';

// What turning push off does in a browser is PushAlertSwitch.test.tsx's; here, only when it is asked for.
jest.mock('./PushAlertSwitch', () => ({ turnOffPushInThisBrowser: jest.fn(async () => undefined) }));

const originalFetch = global.fetch;

function respond(get: { ok: boolean; body: unknown }, put?: { ok: boolean; status?: number; body: unknown }) {
  global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      return { ok: put?.ok ?? true, status: put?.status ?? 200, json: async () => put?.body } as Response;
    }
    return { ok: get.ok, status: get.ok ? 200 : 500, json: async () => get.body } as Response;
  }) as unknown as typeof fetch;
}

async function mount() {
  await act(async () => {
    render(<GymTabletSettings />);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  jest.clearAllMocks();
});
afterEach(() => {
  global.fetch = originalFetch;
});

test('the select offers exactly the five times, in words, and says when the default applies', async () => {
  respond({ ok: true, body: { idle_minutes: 60, is_default: true } });
  await mount();
  const select = screen.getByLabelText('Sign out after') as HTMLSelectElement;
  expect(Array.from(select.options).map((option) => option.textContent)).toEqual(['15 minutes', '30 minutes', '1 hour', '2 hours', '4 hours']);
  expect(select.value).toBe('60');
  expect(screen.getByText('Not set yet: the default, 1 hour, applies.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
});

test('saving sends only idle_minutes, and confirms what the server stored', async () => {
  respond({ ok: true, body: { idle_minutes: 60, is_default: true } }, { ok: true, body: { ok: true, idle_minutes: 30, is_default: false } });
  await mount();
  fireEvent.change(screen.getByLabelText('Sign out after'), { target: { value: '30' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  });
  const put = (global.fetch as jest.Mock).mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(String(put?.[0])).toContain('/api/pilot/gym-tablet/idle');
  expect(JSON.parse(put?.[1].body)).toEqual({ idle_minutes: 30 });
  expect(screen.getByRole('status').textContent).toBe('Saved: 30 minutes.');
  expect(screen.queryByText(/Not set yet/)).toBeNull();
});

test('a refused save says "Not saved" with the server\'s words, and claims nothing', async () => {
  respond({ ok: true, body: { idle_minutes: 60, is_default: false } }, { ok: false, status: 403, body: { error: 'Forbidden: only the gym admin sets the gym tablet sign-out time' } });
  await mount();
  fireEvent.change(screen.getByLabelText('Sign out after'), { target: { value: '15' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  });
  expect(screen.getByRole('alert').textContent).toBe('Not saved. Forbidden: only the gym admin sets the gym tablet sign-out time');
  expect(screen.queryByText(/Saved:/)).toBeNull();
});

test('a failed read offers no control and says it could not be read', async () => {
  respond({ ok: false, body: {} });
  await mount();
  expect(screen.getByRole('alert').textContent).toBe('The setting could not be read. Reload to try again.');
  expect(screen.queryByLabelText('Sign out after')).toBeNull();
});

test('a browser that will not save the mark says so, and nothing changes', async () => {
  respond({ ok: true, body: { idle_minutes: 60, is_default: true } });
  await mount();
  const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('QuotaExceededError');
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Mark this device as a gym tablet' }));
  });
  spy.mockRestore();
  expect(screen.getByRole('alert').textContent).toBe('This browser would not save the change (private mode or blocked storage). Nothing changed.');
  expect(isGymTabletMarked()).toBe(false);
  expect(screen.getByText('This device is not marked as a gym tablet.')).toBeTruthy();
});

test('marking and unmarking this device change the mark this browser keeps', async () => {
  respond({ ok: true, body: { idle_minutes: 60, is_default: true } });
  await mount();
  expect(screen.getByText('This device is not marked as a gym tablet.')).toBeTruthy();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Mark this device as a gym tablet' }));
  });
  expect(isGymTabletMarked()).toBe(true);
  expect(screen.getByText('This device is marked as a gym tablet.')).toBeTruthy();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Unmark this device' }));
  });
  expect(isGymTabletMarked()).toBe(false);
});

test('marking this device also turns web push off in this browser (OW27-17 B); unmarking, or a mark the browser refused, does not', async () => {
  respond({ ok: true, body: { idle_minutes: 60, is_default: true } });
  await mount();
  const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('QuotaExceededError');
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Mark this device as a gym tablet' }));
  });
  spy.mockRestore();
  expect(turnOffPushInThisBrowser).not.toHaveBeenCalled();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Mark this device as a gym tablet' }));
  });
  expect(isGymTabletMarked()).toBe(true);
  expect(turnOffPushInThisBrowser).toHaveBeenCalledTimes(1);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Unmark this device' }));
  });
  expect(turnOffPushInThisBrowser).toHaveBeenCalledTimes(1);
});
