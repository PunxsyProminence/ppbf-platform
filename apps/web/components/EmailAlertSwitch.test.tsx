/**
 * @jest-environment jsdom
 */

/**
 * The email alert switch on /profile (lane W4-1, EM-2).
 *
 * What must hold:
 *   - it is shown only to staff and parents the route offers a switch to;
 *     an athlete 18 or over waits for EM-2b (GO on #2159, condition 3), and an
 *     athlete under 18, a refused role or a failed first read see nothing at
 *     all (L1 rule: no new message, warning or gate);
 *   - a save sends exactly { switched_on } to the self-scoped route, naming no
 *     account;
 *   - a failed save shows what the server holds, never what was asked for, and
 *     an unknown setting never looks like off.
 */

import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import EmailAlertSwitch, { type EmailAlertSwitchStyles } from './EmailAlertSwitch';
import ProfileSettings from './ProfileSettings';

jest.mock('next/navigation', () => ({
  usePathname: () => '/profile',
  useRouter: () => ROUTER,
}));
const ROUTER = { replace: jest.fn(), push: jest.fn() };

jest.mock('./roleSession', () => ({ clearRoleSession: jest.fn() }));
jest.mock('./FightCard', () => ({ __esModule: true, default: () => null }));

const STYLES: EmailAlertSwitchStyles = {
  panel: 'panel',
  heading: 'heading',
  help: 'help',
  choiceBase: 'choice',
  choiceOn: 'choice-on',
  choiceOff: 'choice-off',
};

const URL_PART = '/api/pilot/email-alerts/me';

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type Handler = (init?: RequestInit) => Response | Promise<Response>;

/** Answers the GETs in turn (the last one repeats), and every PUT with `onPut`. */
function mockRoute(gets: Handler[], onPut: Handler = () => response({}, 500)): jest.Mock {
  let read = 0;
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).includes(URL_PART)) return response({}, 404);
    if (init?.method === 'PUT') return onPut(init);
    const handler = gets[Math.min(read, gets.length - 1)];
    read += 1;
    return handler(init);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const offered = (userType: string, switchedOn: boolean) => () =>
  response({ ok: true, offered: true, user_type: userType, switched_on: switchedOn });

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

function puts(fetchMock: jest.Mock): RequestInit[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).includes(URL_PART) && (init as RequestInit | undefined)?.method === 'PUT')
    .map(([, init]) => init as RequestInit);
}

test.each([
  ['a staff member', 'staff'],
  ['a parent', 'parent'],
])('%s is shown the switch, off to begin with, and turning it on sends exactly { switched_on: true }', async (_label, userType) => {
  const fetchMock = mockRoute([offered(userType, false)], () =>
    response({ ok: true, offered: true, user_type: userType, switched_on: true }));
  render(<EmailAlertSwitch styles={STYLES} />);

  expect(await screen.findByRole('heading', { name: 'Email alerts' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByText('Email alerts are off.')).toBeInTheDocument();
  expect(screen.getByText(/says only “open the app”/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'On' }));

  await screen.findByText('Email alerts are on.');
  expect(screen.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true');
  const [put] = puts(fetchMock);
  expect(put.credentials).toBe('include');
  expect(JSON.parse(String(put.body))).toEqual({ switched_on: true });
  // Self-scoped: the URL carries no account and no query.
  const putUrl = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')![0];
  expect(String(putUrl).endsWith(URL_PART)).toBe(true);
});

test('a switch that is on can be turned off', async () => {
  const fetchMock = mockRoute([offered('staff', true)], () =>
    response({ ok: true, offered: true, user_type: 'staff', switched_on: false }));
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByText('Email alerts are on.');

  fireEvent.click(screen.getByRole('button', { name: 'Off' }));

  await screen.findByText('Email alerts are off.');
  expect(JSON.parse(String(puts(fetchMock)[0].body))).toEqual({ switched_on: false });
});

test('pressing the choice already in force sends nothing', async () => {
  const fetchMock = mockRoute([offered('parent', false)]);
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByText('Email alerts are off.');

  fireEvent.click(screen.getByRole('button', { name: 'Off' }));

  expect(puts(fetchMock)).toHaveLength(0);
});

test.each([
  ['an athlete under 18 (not offered)', () => response({ ok: true, offered: false })],
  ['offered: false, whatever else the answer carries', () => response({ ok: true, offered: false, user_type: 'staff', switched_on: false })],
  ['an athlete 18 or over (their switch comes with EM-2b)', offered('adult_athlete', false)],
  ['a role the route refuses (403)', () => response({ ok: false, error: 'Forbidden' }, 403)],
  ['a first read that fails (500)', () => response({ ok: false }, 500)],
  ['a first read that throws', () => Promise.reject(new Error('offline'))],
  ['an answer missing switched_on', () => response({ ok: true, offered: true, user_type: 'staff' })],
  ['an unknown user type', offered('volunteer', false)],
])('%s sees nothing at all: no panel, no message', async (_label, get) => {
  const fetchMock = mockRoute([get]);
  const { container } = render(<EmailAlertSwitch styles={STYLES} />);

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  // Let the read settle before asserting nothing appeared.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(container).toBeEmptyDOMElement();
  expect(screen.queryByText(/email/i)).not.toBeInTheDocument();
});

test('a refused save shows what the server holds, not what was asked for', async () => {
  mockRoute([offered('staff', false), offered('staff', false)], () => response({ ok: false, error: 'boom' }, 500));
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByText('Email alerts are off.');

  fireEvent.click(screen.getByRole('button', { name: 'On' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('That change was not saved.');
  expect(screen.getByText('Email alerts are off.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
});

test('a save refused because the switch is no longer offered takes the panel away', async () => {
  mockRoute([offered('parent', false), () => response({ ok: true, offered: false })], () =>
    response({ ok: false, error: 'Forbidden' }, 403));
  const { container } = render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByText('Email alerts are off.');

  fireEvent.click(screen.getByRole('button', { name: 'On' }));

  await waitFor(() => expect(container).toBeEmptyDOMElement());
});

test('a save refused, then a read refused (the role no longer has a switch), takes the panel away, not "could not be read"', async () => {
  mockRoute([offered('staff', false), () => response({ ok: false, error: 'Forbidden' }, 403)], () =>
    response({ ok: false, error: 'Forbidden' }, 403));
  const { container } = render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByText('Email alerts are off.');

  fireEvent.click(screen.getByRole('button', { name: 'On' }));

  await waitFor(() => expect(container).toBeEmptyDOMElement());
});

test('a save and the read after it both failing leaves the setting unknown: neither choice pressed, and it says so', async () => {
  mockRoute([offered('staff', false), () => Promise.reject(new Error('offline'))], () =>
    Promise.reject(new Error('offline')));
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByText('Email alerts are off.');

  fireEvent.click(screen.getByRole('button', { name: 'On' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('may not have been saved');
  expect(screen.getByText('Your setting could not be read.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'false');
});

test('/profile carries the panel, before "Your sign-in"', async () => {
  global.fetch = jest.fn(async (url: string) => {
    if (String(url).includes(URL_PART)) return offered('parent', false)();
    if (String(url).includes('/api/pilot/profile/me')) {
      return response({
        settings: {
          nickname: null, nickname_locked: false, corner: 'red', program: 'fitness', has_photo: false,
          photo_review_state: 'none',
        },
        card: null,
      });
    }
    return response({}, 404);
  }) as unknown as typeof fetch;
  render(<ProfileSettings />);

  const alerts = await screen.findByRole('heading', { name: 'Email alerts' });
  const signIn = screen.getByRole('heading', { name: 'Your sign-in' });
  expect(alerts.compareDocumentPosition(signIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
