/**
 * @jest-environment jsdom
 */

/**
 * The email alert switch on /profile (lane W4-1, EM-2).
 *
 * What must hold:
 *   - it is shown only to those the route offers a switch to; an athlete
 *     under 18, a refused role or a failed first read see nothing at all (L1
 *     rule: no new message, warning or gate). The adult athlete's part
 *     (EM-2b-3) is EmailAlertAddress.test.tsx;
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
// A separate API origin, so a request that skips apiBase() is caught.
const API = 'https://api.example.test';
jest.mock('@/lib/apiBase', () => ({ apiBase: () => 'https://api.example.test' }));
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
  // The words promise no particular event: which events email whom changes by
  // user type and by the gym's choice (EM-5), and some are not wired yet.
  expect(screen.getByText(/certain new things arrive for you in the app\. It says only “open the app”, with the gym’s name\./)).toBeInTheDocument();
  expect(screen.queryByText(/something new/)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'On' }));

  await screen.findByText('Email alerts are on.');
  expect(screen.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true');
  const [put] = puts(fetchMock);
  expect(put.credentials).toBe('include');
  expect(JSON.parse(String(put.body))).toEqual({ switched_on: true });
  // Self-scoped: both calls go to the API origin's own-account route, with the
  // session cookie, and carry no account and no query.
  const [getUrl, getInit] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(getUrl).toBe(`${API}${URL_PART}`);
  expect(getInit.credentials).toBe('include');
  const putUrl = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')![0];
  expect(putUrl).toBe(`${API}${URL_PART}`);
  // The state is said in words, in a polite live region.
  expect(screen.getByText('Email alerts are on.')).toHaveAttribute('aria-live', 'polite');
});

test('while a save is in flight the panel says so, marks itself busy, and a second press sends nothing', async () => {
  let finish: (value: Response) => void = () => {};
  const fetchMock = mockRoute([offered('parent', false)], () => new Promise<Response>((resolve) => { finish = resolve; }));
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByText('Email alerts are off.');

  fireEvent.click(screen.getByRole('button', { name: 'On' }));

  // The choice in force is said in words while saving, not by colour alone.
  expect(await screen.findByText('Saving… Email alerts are off.')).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Email alerts' })).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('button', { name: 'On' })).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'On' }));
  fireEvent.click(screen.getByRole('button', { name: 'Off' }));
  expect(puts(fetchMock)).toHaveLength(1);

  finish(response({ ok: true, offered: true, user_type: 'parent', switched_on: true }));
  await screen.findByText('Email alerts are on.');
  expect(screen.getByRole('group', { name: 'Email alerts' })).toHaveAttribute('aria-busy', 'false');
});

test('a save shows what the server answered, not what was asked', async () => {
  mockRoute([offered('staff', false)], () => response({ ok: true, offered: true, user_type: 'staff', switched_on: false }));
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByText('Email alerts are off.');

  fireEvent.click(screen.getByRole('button', { name: 'On' }));

  await waitFor(() => expect(screen.getByText('Email alerts are off.')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
});

test('an error from one save is cleared by the next save that works', async () => {
  let putCount = 0;
  mockRoute([offered('staff', false), offered('staff', false)], () => {
    putCount += 1;
    return putCount === 1
      ? response({ ok: false, error: 'boom' }, 500)
      : response({ ok: true, offered: true, user_type: 'staff', switched_on: true });
  });
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByText('Email alerts are off.');

  fireEvent.click(screen.getByRole('button', { name: 'On' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('That change was not saved.');

  fireEvent.click(screen.getByRole('button', { name: 'On' }));
  await screen.findByText('Email alerts are on.');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a save that failed for another reason, whose re-read is then refused (403), takes the panel away, not "could not be read"', async () => {
  const { container } = (mockRoute([offered('staff', false), () => response({ ok: false, error: 'Forbidden' }, 403)], () =>
    response({ ok: false }, 500)), render(<EmailAlertSwitch styles={STYLES} />));
  await screen.findByText('Email alerts are off.');

  fireEvent.click(screen.getByRole('button', { name: 'On' }));

  await waitFor(() => expect(container).toBeEmptyDOMElement());
});

test('a failed save whose re-read fails with a server error shows the setting as unknown, not gone', async () => {
  mockRoute([offered('staff', false), () => response({ ok: false }, 500)], () => response({ ok: false }, 502));
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByText('Email alerts are off.');

  fireEvent.click(screen.getByRole('button', { name: 'On' }));

  expect(await screen.findByText('Your setting could not be read.')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('may not have been saved');
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
  // EM-2b-3: an adult athlete is shown the panel (EmailAlertAddress.test.tsx), but only with both address fields.
  ['an adult athlete answer without address_confirmed and code_pending', offered('adult_athlete', false)],
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

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('That change was not saved.');
  // Never colour alone: the alert carries its glyph and its words.
  expect(alert).toHaveTextContent('▲');
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

test('a save that landed but whose answer was lost shows the new state and no error', async () => {
  mockRoute([offered('staff', false), offered('staff', true)], () => Promise.reject(new Error('connection dropped')));
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByText('Email alerts are off.');

  fireEvent.click(screen.getByRole('button', { name: 'On' }));

  await screen.findByText('Email alerts are on.');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a refused save (403) takes the panel away at once, without reading again, so nothing new reaches whoever is signed in now', async () => {
  // As on a parent's page left open after a minor signed in on the same
  // device: the save is refused, and a read now might fail too.
  const fetchMock = mockRoute([offered('parent', false), () => Promise.reject(new Error('offline'))], () =>
    response({ ok: false, error: 'Forbidden' }, 403));
  const { container } = render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByText('Email alerts are off.');

  fireEvent.click(screen.getByRole('button', { name: 'On' }));

  await waitFor(() => expect(container).toBeEmptyDOMElement());
  const gets = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== 'PUT');
  expect(gets).toHaveLength(1);
});

test('a save refused for want of a session says so, and does not show a setting it cannot read', async () => {
  mockRoute([offered('staff', true)], () => response({ ok: false, error: 'Unauthorized' }, 401));
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByText('Email alerts are on.');

  fireEvent.click(screen.getByRole('button', { name: 'Off' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('You are signed out. Sign in again to see or change this.');
  expect(screen.getByText('Your setting could not be read.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'false');
});

test('signed out, the choices are marked unavailable and a press sends nothing more (reviewers A and B, re-read)', async () => {
  const fetchMock = mockRoute([offered('staff', true)], () => response({ ok: false, error: 'Unauthorized' }, 401));
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByText('Email alerts are on.');

  fireEvent.click(screen.getByRole('button', { name: 'Off' }));
  await screen.findByRole('alert');
  for (const name of ['On', 'Off']) expect(screen.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');

  fireEvent.click(screen.getByRole('button', { name: 'On' }));
  fireEvent.click(screen.getByRole('button', { name: 'Off' }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(puts(fetchMock)).toHaveLength(1);
});

test('a save that fails, then a read that finds the session gone, says signed out rather than taking the panel away (reviewers A and B, re-read)', async () => {
  mockRoute([offered('parent', false), () => response({ ok: false, error: 'Unauthorized' }, 401)], () =>
    response({ ok: false, error: 'Server error' }, 503));
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByText('Email alerts are off.');

  fireEvent.click(screen.getByRole('button', { name: 'On' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('You are signed out. Sign in again to see or change this.');
  expect(screen.getByText('Your setting could not be read.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'On' })).toHaveAttribute('aria-disabled', 'true');
});

test('a save whose success cannot be read (a lost body, a captive portal page) reads the setting again and shows it, with no error (reviewers A and B, re-read)', async () => {
  const unreadable = { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } } as unknown as Response;
  const fetchMock = mockRoute([offered('staff', false), offered('staff', true)], () => unreadable);
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByText('Email alerts are off.');

  fireEvent.click(screen.getByRole('button', { name: 'On' }));

  await screen.findByText('Email alerts are on.');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  const gets = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== 'PUT');
  expect(gets).toHaveLength(2);
});

test('a save answered with a state this panel cannot show (an adult athlete with no code_pending) takes the panel away at once, without reading again', async () => {
  const fetchMock = mockRoute([offered('parent', false), () => Promise.reject(new Error('offline'))], () =>
    response({ ok: true, offered: true, user_type: 'adult_athlete', switched_on: false, address_confirmed: false }));
  const { container } = render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByText('Email alerts are off.');

  fireEvent.click(screen.getByRole('button', { name: 'On' }));

  await waitFor(() => expect(container).toBeEmptyDOMElement());
  const gets = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== 'PUT');
  expect(gets).toHaveLength(1);
});

test('a save refused with a 409 is not a refusal of the switch: it reads again and says "not saved" when the setting did not change (reviewer B)', async () => {
  mockRoute([offered('staff', false), offered('staff', false)], () =>
    response({ ok: false, error: 'Conflict' }, 409));
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByText('Email alerts are off.');

  fireEvent.click(screen.getByRole('button', { name: 'On' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('That change was not saved.');
  expect(screen.getByText('Email alerts are off.')).toBeInTheDocument();
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
  // The page's own choice style: the gym-floor tap height and the focus ring.
  for (const name of ['On', 'Off']) {
    const button = screen.getByRole('button', { name });
    expect(button.className).toContain('min-h-[var(--tap)]');
    expect(button.className).toContain('focus-visible:shadow-[var(--focus)]');
  }
});
