/**
 * @jest-environment jsdom
 */

/**
 * "Pop-ups on this device" on /profile (lane W5-WP, WP-3; plan, answers and
 * GO on #2228).
 *
 * What must hold:
 *   - it is shown only to those the route offers push to; anyone else, or a
 *     first read that fails, sees nothing at all (L1 rule);
 *   - no control that does nothing (QE A): one plain line, and no On or Off,
 *     on a gym tablet (OW27-17 B), in a Home Screen app window (QJ A, fail
 *     closed), where the browser has no push, and where pop-ups are blocked;
 *   - On asks permission on the tap, registers /sw.js and saves exactly
 *     { endpoint, keys: { p256dh, auth } }; Off removes the row and
 *     unsubscribes the browser, even when the server cannot be reached;
 *   - what it shows is the server's answer for this browser, never the aim.
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { EmailAlertSwitchStyles } from './EmailAlertSwitch';
import PushAlertSwitch, { PUSH_LINES, turnOffPushInThisBrowser } from './PushAlertSwitch';
import ProfileSettings from './ProfileSettings';

jest.mock('next/navigation', () => ({ usePathname: () => '/profile', useRouter: () => ({ replace: jest.fn() }) }));
jest.mock('./roleSession', () => ({ clearRoleSession: jest.fn() }));
jest.mock('./FightCard', () => ({ __esModule: true, default: () => null }));
// A separate API origin, so a request that skips apiBase() is caught.
const API = 'https://api.example.test';
jest.mock('@/lib/apiBase', () => ({ apiBase: () => 'https://api.example.test' }));

const ROUTE = `${API}/api/pilot/push/subscription`;
const STYLES: EmailAlertSwitchStyles = {
  panel: 'panel', heading: 'heading', help: 'help', choiceBase: 'choice', choiceOn: 'choice-on', choiceOff: 'choice-off',
};
const KEY_BYTES = Uint8Array.from({ length: 65 }, (_, index) => index + 4);
const PUBLIC_KEY = Buffer.from(KEY_BYTES).toString('base64url');
const HEADING = 'Pop-ups on this device';

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type Sub = PushSubscription & { unsubscribe: jest.Mock };
function subscription(endpoint: string, key: Uint8Array = KEY_BYTES): Sub {
  const sub = {
    endpoint,
    options: { applicationServerKey: key.slice().buffer, userVisibleOnly: true },
    toJSON: () => ({ endpoint, keys: { p256dh: 'BP256dh-key', auth: 'auth-key' } }),
    unsubscribe: jest.fn(async () => {
      if ((browser.held as unknown) === sub) browser.held = null;
      return true;
    }),
  };
  return sub as unknown as Sub;
}

/** One browser's push state: what is held now, and every call made to it. */
const browser = {
  held: null as Sub | null,
  permission: 'default' as NotificationPermission,
  prompt: 'granted' as NotificationPermission,
  appWindow: false,
  calls: [] as string[],
};
const registration = {
  pushManager: {
    getSubscription: jest.fn(async () => browser.held),
    subscribe: jest.fn(async (options: PushSubscriptionOptionsInit) => {
      browser.calls.push('subscribe');
      browser.held = subscription('https://push.example.test/send/new');
      return { ...browser.held, options } as unknown as Sub;
    }),
  },
  unregister: jest.fn(async () => true),
};

function installBrowser({ supported = true } = {}) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: query === '(display-mode: browser)' ? !browser.appWindow : false }),
  });
  if (!supported) return;
  Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} });
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: {
      get permission() { return browser.permission; },
      requestPermission: jest.fn(async () => {
        browser.calls.push('permission');
        browser.permission = browser.prompt;
        return browser.prompt;
      }),
    },
  });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: jest.fn(async () => registration),
      getRegistrations: jest.fn(async () => [registration]),
      register: jest.fn(async (...args: unknown[]) => {
        browser.calls.push(`register ${JSON.stringify(args)}`);
        return registration;
      }),
      ready: Promise.resolve(registration),
    },
  });
}

type Handler = (body: Record<string, unknown> | null) => Response;
function mockRoute(handlers: Partial<Record<'GET' | 'POST' | 'PUT' | 'DELETE', Handler>>): jest.Mock {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (String(url) !== ROUTE) return response({}, 404);
    const method = (init?.method ?? 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    browser.calls.push(`${method} ${init?.body ?? ''}`.trim());
    return (handlers[method] ?? (() => response({}, 500)))(body);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const OFFERED: Handler = () => response({ ok: true, offered: true, public_key: PUBLIC_KEY });
/** The server's own record: on for this browser only after a PUT of it. */
function server(start: string | null = null) {
  let on = start;
  return {
    GET: OFFERED,
    POST: (body: Record<string, unknown> | null) => response({ ok: true, on: body?.endpoint === on }),
    PUT: (body: Record<string, unknown> | null) => { on = String(body?.endpoint); return response({ ok: true, on: true }); },
    DELETE: (body: Record<string, unknown> | null) => { if (body?.endpoint === on) on = null; return response({ ok: true, on: false }); },
  };
}

async function mount() {
  await act(async () => {
    render(<PushAlertSwitch styles={STYLES} />);
  });
}

const originalFetch = global.fetch;
beforeEach(() => {
  Object.assign(browser, { held: null, permission: 'default', prompt: 'granted', appWindow: false, calls: [] });
  window.localStorage.clear();
  installBrowser();
});
afterEach(() => {
  global.fetch = originalFetch;
  for (const name of ['PushManager', 'Notification', 'matchMedia'] as const) delete (window as unknown as Record<string, unknown>)[name];
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  delete (navigator as unknown as Record<string, unknown>).standalone;
  jest.clearAllMocks();
});

describe('who sees it', () => {
  test.each([
    ['not offered', () => response({ ok: true, offered: false })],
    ['not offered, though a key comes with it', () => response({ ok: true, offered: false, public_key: PUBLIC_KEY })],
    ['refused (403)', () => response({ error: 'Forbidden' }, 403)],
    ['signed out (401)', () => response({ error: 'Unauthorized' }, 401)],
    ['a failed read (500)', () => response({}, 500)],
    ['an answer with no key', () => response({ ok: true, offered: true })],
  ])('%s: nothing at all, and nothing more is asked', async (_label, get) => {
    const fetchMock = mockRoute({ GET: get });
    await mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(browser.calls).toEqual(['GET']);
  });

  test('offered, in a browser tab with push: the control, Off, in words', async () => {
    mockRoute(server());
    await mount();
    expect(await screen.findByText(HEADING)).toBeInTheDocument();
    expect(screen.getByText('A pop-up says only “Open the app”.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Pop-ups are off.')).toBeInTheDocument();
  });

  test('a browser on for someone else here shows Off for this person, and nothing is saved by loading', async () => {
    browser.held = subscription('https://push.example.test/send/theirs');
    mockRoute(server('https://push.example.test/send/someone-else'));
    await mount();
    expect(await screen.findByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
    expect(browser.calls).toEqual(['GET', 'POST {"endpoint":"https://push.example.test/send/theirs"}']);
  });
});

describe('one plain line instead of a control that does nothing (QE A)', () => {
  test('a device marked as a gym tablet: the line, and push is turned off in this browser', async () => {
    window.localStorage.setItem('ppbf.device.gymTablet', '1');
    const held = subscription('https://push.example.test/send/tablet');
    browser.held = held;
    mockRoute(server('https://push.example.test/send/tablet'));
    await mount();
    expect(await screen.findByText(PUSH_LINES.gymTablet)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    await waitFor(() => expect(registration.unregister).toHaveBeenCalled());
    expect(held.unsubscribe).toHaveBeenCalled();
    expect(browser.calls).toContain('DELETE {"endpoint":"https://push.example.test/send/tablet"}');
  });

  test.each([
    ['opened from the Home Screen', () => { browser.appWindow = true; }],
    ["iOS's own standalone flag", () => { Object.defineProperty(navigator, 'standalone', { configurable: true, value: true }); }],
    ['a browser that cannot say which window it is (fail closed)', () => {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => { throw new Error('no'); } });
    }],
  ])('an app window (QJ A), %s: the line, no control, and nothing asked of the browser', async (_label, arrange) => {
    arrange();
    mockRoute(server());
    await mount();
    expect(await screen.findByText(PUSH_LINES.appWindow)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(browser.calls).toEqual(['GET']);
  });

  test('a browser with no push: the line, which says how an iPhone or iPad gets it', async () => {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    mockRoute(server());
    await mount();
    expect(await screen.findByText(PUSH_LINES.unsupported)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  test("pop-ups blocked in this browser's settings: the line", async () => {
    browser.permission = 'denied';
    mockRoute(server());
    await mount();
    expect(await screen.findByText(PUSH_LINES.blocked)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('On', () => {
  test('the tap asks permission, registers /sw.js, subscribes with the public key, saves exactly { endpoint, keys }, and shows the answer', async () => {
    const fetchMock = mockRoute(server());
    await mount();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'On' }));
    });
    expect(await screen.findByText('Pop-ups are on.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true');
    expect(browser.calls).toEqual([
      'GET',
      'permission',
      'register ["/sw.js",{"updateViaCache":"none"}]',
      'subscribe',
      'PUT {"endpoint":"https://push.example.test/send/new","keys":{"p256dh":"BP256dh-key","auth":"auth-key"}}',
      'POST {"endpoint":"https://push.example.test/send/new"}',
    ]);
    const options = registration.pushManager.subscribe.mock.calls[0][0];
    expect(options.userVisibleOnly).toBe(true);
    expect(Array.from(options.applicationServerKey as Uint8Array)).toEqual(Array.from(KEY_BYTES));
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(ROUTE);
      expect((init as RequestInit).credentials).toBe('include');
    }
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a subscription made with another key is dropped and made again with this one', async () => {
    const old = subscription('https://push.example.test/send/old', Uint8Array.from({ length: 65 }, () => 9));
    browser.held = old;
    mockRoute(server());
    await mount();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'On' }));
    });
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(browser.calls).toContain('PUT {"endpoint":"https://push.example.test/send/new","keys":{"p256dh":"BP256dh-key","auth":"auth-key"}}');
  });

  test('a subscription already made with this key is saved as it is', async () => {
    browser.held = subscription('https://push.example.test/send/kept');
    mockRoute(server());
    await mount();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'On' }));
    });
    expect(browser.calls).not.toContain('subscribe');
    expect(await screen.findByText('Pop-ups are on.')).toBeInTheDocument();
  });

  test('the permission prompt dismissed: nothing registered or saved, and "not saved"', async () => {
    browser.prompt = 'default';
    mockRoute(server());
    await mount();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'On' }));
    });
    expect(browser.calls).toEqual(['GET', 'permission']);
    expect(screen.getByRole('alert')).toHaveTextContent('That change was not saved.');
    expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('pop-ups refused at the prompt: nothing saved, and the blocked line replaces the control', async () => {
    browser.prompt = 'denied';
    mockRoute(server());
    await mount();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'On' }));
    });
    expect(browser.calls).toEqual(['GET', 'permission']);
    expect(screen.getByText(PUSH_LINES.blocked)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('a save refused (403): the panel goes, and nothing more is said', async () => {
    mockRoute({ ...server(), PUT: () => response({ error: 'Forbidden' }, 403) });
    await mount();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'On' }));
    });
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(browser.calls.filter((call) => call.startsWith('POST'))).toEqual([]);
  });

  test('a save signed out (401): says so, and the choices then send nothing', async () => {
    mockRoute({ ...server(), PUT: () => response({ error: 'Unauthorized' }, 401), POST: () => response({}, 401) });
    await mount();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'On' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('You are signed out. Sign in again to see or change this.');
    const before = browser.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'On' }));
    });
    expect(browser.calls).toHaveLength(before);
  });

  test('a save that fails (500): what the server holds is shown, and "not saved"', async () => {
    mockRoute({ ...server(), PUT: () => response({}, 500) });
    await mount();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'On' }));
    });
    expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('That change was not saved.');
  });

  test('a save that landed though its answer was lost: shown as on, with no error', async () => {
    const record = server();
    mockRoute({ ...record, PUT: (body) => { record.PUT(body); return response(null); } });
    await mount();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'On' }));
    });
    expect(screen.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Off', () => {
  test('removes this browser\'s row, then unsubscribes the browser, and shows Off', async () => {
    const held = subscription('https://push.example.test/send/mine');
    browser.held = held;
    mockRoute(server('https://push.example.test/send/mine'));
    await mount();
    expect(await screen.findByText('Pop-ups are on.')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    });
    expect(browser.calls.slice(2)).toEqual(['DELETE {"endpoint":"https://push.example.test/send/mine"}']);
    expect(held.unsubscribe).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test.each([
    ['answers 500', () => response({}, 500)],
    ['cannot be reached', () => { throw new TypeError('offline'); }],
  ])('when the server %s, the browser is still unsubscribed and shows Off', async (_label, fail) => {
    const held = subscription('https://push.example.test/send/mine');
    browser.held = held;
    mockRoute({ ...server('https://push.example.test/send/mine'), DELETE: fail });
    await mount();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Off' }));
    });
    expect(held.unsubscribe).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('turnOffPushInThisBrowser (marking a gym tablet)', () => {
  test('removes the caller\'s row, unsubscribes and unregisters; a browser with none just unregisters', async () => {
    const held = subscription('https://push.example.test/send/tablet');
    browser.held = held;
    mockRoute(server('https://push.example.test/send/tablet'));
    await turnOffPushInThisBrowser();
    expect(browser.calls).toEqual(['DELETE {"endpoint":"https://push.example.test/send/tablet"}']);
    expect(held.unsubscribe).toHaveBeenCalled();
    expect(registration.unregister).toHaveBeenCalledTimes(1);
    await turnOffPushInThisBrowser();
    expect(browser.calls).toHaveLength(1);
    expect(registration.unregister).toHaveBeenCalledTimes(2);
  });

  test('never throws, with no service worker at all or one that fails', async () => {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    await expect(turnOffPushInThisBrowser()).resolves.toBeUndefined();
    installBrowser();
    (navigator.serviceWorker.getRegistrations as jest.Mock).mockRejectedValueOnce(new Error('no'));
    await expect(turnOffPushInThisBrowser()).resolves.toBeUndefined();
  });
});

test('/profile mounts it, beside the email alerts', async () => {
  global.fetch = jest.fn(async (url: string) => {
    if (String(url) === ROUTE) return OFFERED(null);
    if (String(url).includes('/api/pilot/profile/me')) {
      return response({ settings: { nickname: null, nickname_locked: false, corner: 'red', program: 'fitness', has_photo: false, photo_review_state: 'none' }, card: null });
    }
    return response({}, 404);
  }) as unknown as typeof fetch;
  await act(async () => {
    render(<ProfileSettings />);
  });
  expect(await screen.findByText(HEADING)).toBeInTheDocument();
});
