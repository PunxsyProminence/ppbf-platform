/**
 * @jest-environment jsdom
 */

/**
 * The adult athlete's part of the email alert panel on /profile (lane W4-1,
 * EM-2b-3). EmailAlertSwitch.test.tsx keeps EM-2's staff and parent tests.
 *
 * What must hold:
 *   - OW27-38 B: an adult athlete types an address, gets a code emailed to it,
 *     and enters it; only then is On offered (GO condition 3), and confirming
 *     never switches on (default 10);
 *   - a minor, or any answer offered: false, sees nothing at all, and a 403 at
 *     any step takes the panel away and says nothing (OW27-02 C, L1);
 *   - every refusal is said in fixed words, the limit's naming no limit
 *     (default 4), and nothing is said when the re-read shows the step landed;
 *     signed out, nothing sends; focus never drops to the page;
 *   - the bodies are exactly { address } and { code }, with the session
 *     cookie, to the API origin's own-account route;
 *   - no address is ever shown back (default 9), only what the athlete types.
 */

import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import EmailAlertSwitch, { type EmailAlertSwitchStyles } from './EmailAlertSwitch';

// A separate API origin, so a request that skips apiBase() is caught.
jest.mock('@/lib/apiBase', () => ({ apiBase: () => 'https://api.example.test' }));

const ME = 'https://api.example.test/api/pilot/email-alerts/me';
const ADDRESS_ROUTE = `${ME}/address`;
const TYPED = 'adult.person@example.test';

const STYLES: EmailAlertSwitchStyles = {
  panel: 'panel', heading: 'heading', help: 'help', choiceBase: 'choice', choiceOn: 'choice-on', choiceOff: 'choice-off',
};

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type Handler = (init?: RequestInit) => Response | Promise<Response>;
const answer = (body: unknown, status = 200): Handler => () => response(body, status);
const refuse = (status: number, code?: string): Handler =>
  answer({ error: 'The server’s own words', ...(code ? { code } : {}) }, status);
const unexpected: Handler = () => response({ error: 'unexpected' }, 500);

interface Routes {
  readonly gets: Handler[];
  readonly sendCode?: Handler;
  readonly enterCode?: Handler;
  readonly saveSwitch?: Handler;
}

/** Each route by its exact URL and method; GETs answered in turn, the last repeating. */
function mockRoutes({ gets, sendCode = unexpected, enterCode = unexpected, saveSwitch = unexpected }: Routes): jest.Mock {
  let read = 0;
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === ADDRESS_ROUTE && method === 'POST') return sendCode(init);
    if (url === ADDRESS_ROUTE && method === 'PUT') return enterCode(init);
    if (url === ME && method === 'PUT') return saveSwitch(init);
    if (url === ME && method === 'GET') return gets[Math.min(read++, gets.length - 1)](init);
    return response({}, 404);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const athlete = ({ on = false, confirmed = false, pending = false } = {}) =>
  ({ ok: true, offered: true, user_type: 'adult_athlete', switched_on: on, address_confirmed: confirmed, code_pending: pending });

function calls(fetchMock: jest.Mock, url: string, method: string): RequestInit[] {
  return fetchMock.mock.calls
    .filter(([callUrl, init]) => callUrl === url && ((init as RequestInit | undefined)?.method ?? 'GET') === method)
    .map(([, init]) => init as RequestInit);
}
const sent = (fetchMock: jest.Mock) => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const addressField = () => screen.getByLabelText('Email address for alerts');
const codeField = () => screen.getByLabelText('Six-digit code from the email');
const status = () => document.querySelector('[aria-live="polite"]');
const formOf = (field: HTMLElement) => field.closest('form') as HTMLFormElement;
const unreadable = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }) as unknown as Response;

function press(name: string) {
  const button = screen.getByRole('button', { name });
  button.focus();
  fireEvent.click(button);
  return button;
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

test('an adult athlete with no address confirmed and no code waiting sees the address field and Send code, and no On or Off', async () => {
  mockRoutes({ gets: [answer(athlete())] });
  render(<EmailAlertSwitch styles={STYLES} />);

  expect(await screen.findByRole('heading', { name: 'Email alerts' })).toBeInTheDocument();
  expect(addressField()).toHaveAttribute('type', 'email');
  expect(addressField()).toHaveAttribute('autocomplete', 'email');
  expect(addressField()).toHaveValue('');
  // The server judges the address: no browser check stops the form first.
  expect(formOf(addressField())).toHaveAttribute('novalidate');
  expect(screen.getByRole('button', { name: 'Send code' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'On' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Off' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Six-digit code from the email')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Change address' })).not.toBeInTheDocument();
  // Their words: alerts go to the address they confirm, not the one they sign in with.
  expect(screen.getByText(/an email can go to the address you confirm here when certain new things arrive/)).toBeInTheDocument();
  expect(screen.queryByText(/the address you sign in with/)).not.toBeInTheDocument();
  expect(screen.getByText(/It says only “open the app”, with the gym’s name\. It never says what happened or who it is about\./)).toBeInTheDocument();
  expect(screen.getByText(/The address is used only after you enter that code here\.$/)).toBeInTheDocument();
  expect(screen.queryByText(/Until then/)).not.toBeInTheDocument();
  expect(status()).toHaveTextContent(/^Email alerts are off\. No address is confirmed yet\.$/);
});

test('Enter sends a code and focus goes to the code field; confirm shows On and Off, still off; the bodies are exact', async () => {
  const fetchMock = mockRoutes({
    gets: [answer(athlete())],
    sendCode: answer(athlete({ pending: true })),
    enterCode: answer(athlete({ confirmed: true })),
  });
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByRole('button', { name: 'Send code' });

  fireEvent.change(addressField(), { target: { value: TYPED } });
  const sendButton = screen.getByRole('button', { name: 'Send code' });
  addressField().focus();
  // Enter in the field: the form submits, and its default (a page load) is prevented.
  expect(fireEvent.submit(formOf(addressField()))).toBe(false);

  expect(await screen.findByLabelText('Six-digit code from the email')).toHaveAttribute('inputmode', 'numeric');
  expect(codeField()).toHaveAttribute('autocomplete', 'one-time-code');
  expect(screen.getByRole('button', { name: 'Send a new code' })).toBe(sendButton);
  await waitFor(() => expect(document.activeElement).toBe(codeField()));
  expect(addressField()).toHaveValue(TYPED);
  expect(screen.queryByText(/Until then/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'On' })).not.toBeInTheDocument();
  expect(status()).toHaveTextContent(/^Email alerts are off\. A code was sent\. Enter it to confirm your address\.$/);

  fireEvent.change(codeField(), { target: { value: '012345' } });
  press('Confirm');

  expect(await screen.findByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
  expect(status()).toHaveTextContent(/^Email alerts are off\. Your address is confirmed\.$/);
  // Confirming never switches on (default 10): no save was sent, and focus is not on On.
  expect(calls(fetchMock, ME, 'PUT')).toHaveLength(0);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change address' }));
  expect(screen.queryByLabelText('Email address for alerts')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();

  const [post] = calls(fetchMock, ADDRESS_ROUTE, 'POST');
  const [put] = calls(fetchMock, ADDRESS_ROUTE, 'PUT');
  expect(JSON.parse(String(post.body))).toEqual({ address: TYPED });
  expect(JSON.parse(String(put.body))).toEqual({ code: '012345' });
  for (const init of [post, put]) {
    expect(init.credentials).toBe('include');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  }
  expect(calls(fetchMock, ME, 'GET')[0].credentials).toBe('include');
  expect(sent(fetchMock)).toHaveLength(2);
});

test('a confirmed adult athlete has On and Off as staff do, and On sends exactly { switched_on: true }', async () => {
  const fetchMock = mockRoutes({ gets: [answer(athlete({ confirmed: true }))], saveSwitch: answer(athlete({ on: true, confirmed: true })) });
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByRole('button', { name: 'On' });
  expect(screen.queryByLabelText('Email address for alerts')).not.toBeInTheDocument();

  press('On');

  await waitFor(() => expect(status()).toHaveTextContent(/^Email alerts are on\. Your address is confirmed\.$/));
  expect(screen.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true');
  expect(JSON.parse(String(calls(fetchMock, ME, 'PUT')[0].body))).toEqual({ switched_on: true });
  expect(sent(fetchMock)).toHaveLength(1);
});

test('reloaded with a code waiting, the athlete sees the code field, Confirm and Send a new code, an empty address field, and no On', async () => {
  mockRoutes({ gets: [answer(athlete({ pending: true }))] });
  render(<EmailAlertSwitch styles={STYLES} />);

  expect(await screen.findByLabelText('Six-digit code from the email')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send a new code' })).toBeInTheDocument();
  expect(addressField()).toHaveValue('');
  expect(screen.queryByRole('button', { name: 'On' })).not.toBeInTheDocument();
  expect(status()).toHaveTextContent(/^Email alerts are off\. A code was sent\. Enter it to confirm your address\.$/);
});

test('reloaded with an address confirmed and a code waiting for a new one, the athlete sees On and Off and the code form, not Change address', async () => {
  mockRoutes({ gets: [answer(athlete({ on: true, confirmed: true, pending: true }))] });
  render(<EmailAlertSwitch styles={STYLES} />);

  expect(await screen.findByLabelText('Six-digit code from the email')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send a new code' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText(/Until then, the address you confirmed before stays in use\./)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Change address' })).not.toBeInTheDocument();
});

test('changing a confirmed address keeps On and Off and says the confirmed one stays in use until the new one is (default 5)', async () => {
  const fetchMock = mockRoutes({
    gets: [answer(athlete({ on: true, confirmed: true }))],
    sendCode: answer(athlete({ on: true, confirmed: true, pending: true })),
  });
  render(<EmailAlertSwitch styles={STYLES} />);
  const change = await screen.findByRole('button', { name: 'Change address' });
  expect(change).toHaveAttribute('aria-expanded', 'false');

  press('Change address');
  expect(change).toHaveAttribute('aria-expanded', 'true');
  expect(document.activeElement).toBe(change);
  expect(document.getElementById(String(change.getAttribute('aria-controls')))).toContainElement(addressField());
  fireEvent.change(addressField(), { target: { value: TYPED } });
  press('Send code');

  await waitFor(() => expect(document.activeElement).toBe(codeField()));
  expect(screen.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText(/Until then, the address you confirmed before stays in use\./)).toBeInTheDocument();
  expect(status()).toHaveTextContent(/^Email alerts are on\. Your address is confirmed\. A code for a new address is waiting\.$/);
  // With a code waiting, the form stays: no toggle that could only fail to hide it.
  expect(screen.queryByRole('button', { name: 'Change address' })).not.toBeInTheDocument();
  expect(JSON.parse(String(calls(fetchMock, ADDRESS_ROUTE, 'POST')[0].body))).toEqual({ address: TYPED });
});

describe('each refusal is said in fixed words, never the server\'s', () => {
  test.each([
    ['a wrong code', 'code', refuse(409, 'EMAIL_ALERT_CODE_WRONG'), athlete({ pending: true }),
      'That code is not right. Check the email and try again.'],
    ['a wrong code on the last try (default 3)', 'code', refuse(409, 'EMAIL_ALERT_CODE_WRONG'), athlete(),
      'That code has had too many tries. Ask for a new one.'],
    ['an expired code (default 11)', 'code', refuse(409, 'EMAIL_ALERT_CODE_EXPIRED'), athlete(),
      'That code has expired. Ask for a new one.'],
    ['a code with its tries used', 'code', refuse(409, 'EMAIL_ALERT_CODE_TRIES_USED'), athlete(),
      'That code has had too many tries. Ask for a new one.'],
    ['a malformed code', 'code', refuse(400), athlete({ pending: true }), 'Enter the six-digit code from the email.'],
    ['any limit (default 4)', 'address', refuse(429, 'EMAIL_ALERT_CODE_LIMIT'), athlete({ pending: true }),
      'Too many codes asked for. Try again later.'],
    ['a code email not sent', 'address', refuse(503, 'EMAIL_ALERT_CODE_NOT_SENT'), athlete(),
      'The code email could not be sent. Try again.'],
    ['a malformed address', 'address', refuse(400), athlete({ pending: true }), 'Enter a valid email address.'],
    ['a server error, a code still waiting from before', 'address', refuse(500), athlete({ pending: true }),
      'That may not have gone through. If no new email comes, send a new code.'],
    ['a dropped connection, no code waiting now', 'address', () => Promise.reject(new Error('offline')), athlete(),
      'The code email could not be sent. Try again.'],
    ['a dropped connection, the code still waiting', 'code', () => Promise.reject(new Error('offline')), athlete({ pending: true }),
      'That code was not accepted. Try again.'],
    ['a dropped connection, the code gone', 'code', () => Promise.reject(new Error('offline')), athlete(),
      'That code was not accepted. Ask for a new one.'],
  ] as const)('%s', async (_label, step, refusal, reread, words) => {
    const fetchMock = mockRoutes({
      gets: [answer(athlete({ pending: true })), answer(reread)],
      ...(step === 'code' ? { enterCode: refusal } : { sendCode: refusal }),
    });
    render(<EmailAlertSwitch styles={STYLES} />);
    await screen.findByLabelText('Six-digit code from the email');

    fireEvent.change(codeField(), { target: { value: '012345' } });
    fireEvent.change(addressField(), { target: { value: TYPED } });
    const pressed = press(step === 'code' ? 'Confirm' : 'Send a new code');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(`▲ ${words}`);
    expect(screen.queryByText(/server’s own words/)).not.toBeInTheDocument();
    // The panel shows what the server holds now: a code field only while a code can be entered.
    await waitFor(() => expect(calls(fetchMock, ME, 'GET')).toHaveLength(2));
    expect(Boolean(screen.queryByLabelText('Six-digit code from the email'))).toBe(reread.code_pending);
    expect(screen.queryByRole('button', { name: 'On' })).not.toBeInTheDocument();
    // A refusal is not taken as landed: what was typed stays, and focus stays on
    // the control pressed, or, if the answer took it away, goes to the address field.
    expect(addressField()).toHaveValue(TYPED);
    if (reread.code_pending) expect(codeField()).toHaveValue('012345');
    await waitFor(() => expect(document.activeElement).toBe(pressed.isConnected ? pressed : addressField()));
  });
});

describe('the re-read decides when an answer is lost, unreadable or overtaken', () => {
  test('a confirm that landed but whose answer was lost says nothing, and focus goes to Change address', async () => {
    mockRoutes({ gets: [answer(athlete({ pending: true })), answer(athlete({ confirmed: true }))], enterCode: () => Promise.reject(new Error('offline')) });
    render(<EmailAlertSwitch styles={STYLES} />);
    fireEvent.change(await screen.findByLabelText('Six-digit code from the email'), { target: { value: '012345' } });
    fireEvent.change(addressField(), { target: { value: TYPED } });
    press('Confirm');

    await screen.findByRole('button', { name: 'On' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change address' })));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    press('Change address');
    expect(addressField()).toHaveValue('');
  });

  test('a code sent with none waiting before, whose answer could not be read, says nothing, and focus goes to the code field', async () => {
    mockRoutes({ gets: [answer(athlete()), answer(athlete({ pending: true }))], sendCode: unreadable });
    render(<EmailAlertSwitch styles={STYLES} />);
    fireEvent.change(await screen.findByLabelText('Email address for alerts'), { target: { value: TYPED } });
    press('Send code');

    await waitFor(() => expect(document.activeElement).toBe(codeField()));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(status()).toHaveTextContent(/A code was sent\. Enter it to confirm your address\.$/);
  });

  test('an expired answer after another tab confirmed the address says nothing', async () => {
    mockRoutes({ gets: [answer(athlete({ pending: true })), answer(athlete({ confirmed: true }))], enterCode: refuse(409, 'EMAIL_ALERT_CODE_EXPIRED') });
    render(<EmailAlertSwitch styles={STYLES} />);
    fireEvent.change(await screen.findByLabelText('Six-digit code from the email'), { target: { value: '012345' } });
    press('Confirm');

    await screen.findByRole('button', { name: 'On' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('a lost answer for a new address, now with no code waiting, says it may not be confirmed', async () => {
    mockRoutes({
      gets: [answer(athlete({ confirmed: true, pending: true })), answer(athlete({ confirmed: true }))],
      enterCode: () => Promise.reject(new Error('offline')),
    });
    render(<EmailAlertSwitch styles={STYLES} />);
    fireEvent.change(await screen.findByLabelText('Six-digit code from the email'), { target: { value: '012345' } });
    press('Confirm');

    expect(await screen.findByRole('alert')).toHaveTextContent('Your new address may not have been confirmed. To be sure, change it again.');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change address' })));
  });

  test('an address step whose request and re-read both fail keeps the panel, with the setting unknown', async () => {
    mockRoutes({ gets: [answer(athlete()), () => Promise.reject(new Error('offline'))], sendCode: () => Promise.reject(new Error('offline')) });
    render(<EmailAlertSwitch styles={STYLES} />);
    fireEvent.change(await screen.findByLabelText('Email address for alerts'), { target: { value: TYPED } });
    const pressed = press('Send code');

    expect(await screen.findByRole('alert')).toHaveTextContent('That may not have gone through, and your setting could not be read. Try again.');
    expect(status()).toHaveTextContent(/^Your setting could not be read\.$/);
    expect(addressField()).toHaveValue(TYPED);
    expect(document.activeElement).toBe(pressed);
  });
});

describe('a send the server refused is never taken as landed, though the re-read shows a code waiting', () => {
  test.each([
    ['any limit', refuse(429, 'EMAIL_ALERT_CODE_LIMIT'), 'Too many codes asked for. Try again later.'],
    ['a code email not sent', refuse(503, 'EMAIL_ALERT_CODE_NOT_SENT'), 'The code email could not be sent. Try again.'],
  ])('%s', async (_label, refusal, words) => {
    mockRoutes({ gets: [answer(athlete()), answer(athlete({ pending: true }))], sendCode: refusal });
    render(<EmailAlertSwitch styles={STYLES} />);
    fireEvent.change(await screen.findByLabelText('Email address for alerts'), { target: { value: TYPED } });
    const pressed = press('Send code');

    expect(await screen.findByRole('alert')).toHaveTextContent(`▲ ${words}`);
    expect(addressField()).toHaveValue(TYPED);
    expect(document.activeElement).toBe(pressed);
  });
});

test('a failed send whose answer folds the form hands focus to Change address', async () => {
  mockRoutes({
    gets: [answer(athlete({ confirmed: true, pending: true })), answer(athlete({ confirmed: true }))],
    sendCode: refuse(503, 'EMAIL_ALERT_CODE_NOT_SENT'),
  });
  render(<EmailAlertSwitch styles={STYLES} />);
  fireEvent.change(await screen.findByLabelText('Email address for alerts'), { target: { value: TYPED } });
  press('Send a new code');

  expect(await screen.findByRole('alert')).toHaveTextContent('The code email could not be sent. Try again.');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change address' })));
});

test('when Confirm is taken away but the form stays open, focus goes to the address field, not Change address', async () => {
  mockRoutes({
    gets: [answer(athlete({ confirmed: true })), answer(athlete({ confirmed: true }))],
    sendCode: answer(athlete({ confirmed: true, pending: true })),
    enterCode: refuse(409, 'EMAIL_ALERT_CODE_EXPIRED'),
  });
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByRole('button', { name: 'Change address' });
  press('Change address');
  fireEvent.change(addressField(), { target: { value: TYPED } });
  press('Send code');
  fireEvent.change(await screen.findByLabelText('Six-digit code from the email'), { target: { value: '012345' } });
  press('Confirm');

  expect(await screen.findByRole('alert')).toHaveTextContent('That code has expired. Ask for a new one.');
  expect(screen.getByRole('button', { name: 'Change address' })).toHaveAttribute('aria-expanded', 'true');
  await waitFor(() => expect(document.activeElement).toBe(addressField()));
});

describe('a click that leaves focus nowhere (as Safari\'s does) hands it to the code field when one is drawn', () => {
  test('a wrong code with tries left', async () => {
    mockRoutes({ gets: [answer(athlete({ pending: true }))], enterCode: refuse(409, 'EMAIL_ALERT_CODE_WRONG') });
    render(<EmailAlertSwitch styles={STYLES} />);
    fireEvent.change(await screen.findByLabelText('Six-digit code from the email'), { target: { value: '012345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await screen.findByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(codeField()));
  });

  test('On saved while a code waits', async () => {
    mockRoutes({
      gets: [answer(athlete({ confirmed: true, pending: true }))],
      saveSwitch: answer(athlete({ on: true, confirmed: true, pending: true })),
    });
    render(<EmailAlertSwitch styles={STYLES} />);
    fireEvent.click(await screen.findByRole('button', { name: 'On' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => expect(document.activeElement).toBe(codeField()));
  });
});

test('the typed code is emptied when a new code is sent (the old one is void)', async () => {
  mockRoutes({ gets: [answer(athlete({ pending: true }))], sendCode: answer(athlete({ pending: true })) });
  render(<EmailAlertSwitch styles={STYLES} />);
  fireEvent.change(await screen.findByLabelText('Six-digit code from the email'), { target: { value: '111111' } });
  fireEvent.change(addressField(), { target: { value: TYPED } });

  press('Send a new code');

  await waitFor(() => expect(codeField()).toHaveValue(''));
  expect(document.activeElement).toBe(codeField());
});

test('a switch save whose answer takes On and Off away (no address confirmed now) hands focus to the address field', async () => {
  mockRoutes({ gets: [answer(athlete({ confirmed: true })), answer(athlete())], saveSwitch: refuse(409) });
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByRole('button', { name: 'On' });

  press('On');

  expect(await screen.findByRole('alert')).toHaveTextContent('That change was not saved.');
  expect(screen.queryByRole('button', { name: 'On' })).not.toBeInTheDocument();
  await waitFor(() => expect(document.activeElement).toBe(addressField()));
});

test('an athlete somehow on without a confirmed address can still turn it off', async () => {
  mockRoutes({ gets: [answer(athlete({ on: true }))] });
  render(<EmailAlertSwitch styles={STYLES} />);

  expect(await screen.findByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true');
});

test('signed out, Change address does not open the form', async () => {
  mockRoutes({ gets: [answer(athlete({ confirmed: true }))], saveSwitch: refuse(401) });
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByRole('button', { name: 'On' });
  press('On');
  await screen.findByRole('alert');

  expect(press('Change address')).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByLabelText('Email address for alerts')).not.toBeInTheDocument();
});

test.each([
  ['sending a code is refused (403)', 'address', refuse(403), [answer(athlete())]],
  ['entering a code is refused (403)', 'code', refuse(403), [answer(athlete({ pending: true }))]],
  ['a code email not sent, then the read refused (403)', 'address', refuse(503, 'EMAIL_ALERT_CODE_NOT_SENT'),
    [answer(athlete()), refuse(403)]],
  ['a wrong code, then the read answering offered: false (now under 18)', 'code', refuse(409, 'EMAIL_ALERT_CODE_WRONG'),
    [answer(athlete({ pending: true })), answer({ ok: true, offered: false })]],
] as const)('%s: the panel goes, and nothing is said', async (_label, step, refusal, gets) => {
  const fetchMock = mockRoutes({
    gets: [...gets],
    ...(step === 'code' ? { enterCode: refusal } : { sendCode: refusal }),
  });
  const { container } = render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByRole('heading', { name: 'Email alerts' });

  if (step === 'code') {
    fireEvent.change(codeField(), { target: { value: '012345' } });
    press('Confirm');
  } else {
    fireEvent.change(addressField(), { target: { value: TYPED } });
    press(screen.queryByRole('button', { name: 'Send code' }) ? 'Send code' : 'Send a new code');
  }

  await waitFor(() => expect(container).toBeEmptyDOMElement());
  // A refusal of the request itself is not read again: whoever is signed in now has no panel.
  if (gets.length === 1) expect(calls(fetchMock, ME, 'GET')).toHaveLength(1);
});

test('a confirmed athlete\'s switch save refused (403) takes the panel away too', async () => {
  mockRoutes({ gets: [answer(athlete({ confirmed: true }))], saveSwitch: refuse(403) });
  const { container } = render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByRole('button', { name: 'On' });

  press('On');

  await waitFor(() => expect(container).toBeEmptyDOMElement());
});

test('signed out (401), it says so, every control is marked unavailable, and nothing more is sent', async () => {
  const fetchMock = mockRoutes({ gets: [answer(athlete({ pending: true }))], enterCode: refuse(401) });
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByLabelText('Six-digit code from the email');

  fireEvent.change(codeField(), { target: { value: '012345' } });
  press('Confirm');

  expect(await screen.findByRole('alert')).toHaveTextContent('You are signed out. Sign in again to see or change this.');
  expect(status()).toHaveTextContent(/^Your setting could not be read\.$/);
  for (const name of ['Confirm', 'Send a new code']) {
    expect(screen.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
  }
  fireEvent.change(addressField(), { target: { value: TYPED } });
  press('Confirm');
  press('Send a new code');
  await settle();
  expect(sent(fetchMock)).toHaveLength(1);
  expect(calls(fetchMock, ME, 'GET')).toHaveLength(1);
});

test('while a code is being sent the panel says so, marks itself busy, and a second press sends nothing', async () => {
  let finish: (value: Response) => void = () => {};
  const fetchMock = mockRoutes({
    gets: [answer(athlete())],
    sendCode: () => new Promise<Response>((resolve) => { finish = resolve; }),
  });
  render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByRole('button', { name: 'Send code' });
  fireEvent.change(addressField(), { target: { value: TYPED } });

  const sendButton = press('Send code');

  expect(status()).toHaveTextContent(/^Sending a code… Email alerts are off\. No address is confirmed yet\.$/);
  expect(screen.getByRole('group', { name: 'Alert address' })).toHaveAttribute('aria-busy', 'true');
  expect(sendButton).toHaveAttribute('aria-disabled', 'true');
  press('Send code');
  expect(sent(fetchMock)).toHaveLength(1);

  finish(response(athlete({ pending: true })));
  await screen.findByLabelText('Six-digit code from the email');
  expect(screen.getByRole('group', { name: 'Alert address' })).toHaveAttribute('aria-busy', 'false');
});

test.each([
  ['an athlete under 18 (offered: false)', { ok: true, offered: false }],
  ['offered: false with address fields', { ok: true, offered: false, user_type: 'adult_athlete', switched_on: false, address_confirmed: true, code_pending: true }],
  ['an adult athlete answer missing code_pending', { ok: true, offered: true, user_type: 'adult_athlete', switched_on: false, address_confirmed: true }],
  ['an adult athlete answer missing address_confirmed', { ok: true, offered: true, user_type: 'adult_athlete', switched_on: false, code_pending: true }],
])('%s sees nothing at all: no panel, no field, no message', async (_label, body) => {
  const fetchMock = mockRoutes({ gets: [answer(body)] });
  const { container } = render(<EmailAlertSwitch styles={STYLES} />);

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await settle();
  expect(container).toBeEmptyDOMElement();
  expect(screen.queryByText(/email|code|address/i)).not.toBeInTheDocument();
});

test('no address is ever shown back, even one an answer carried; the field holds only what is typed, and is empty after a confirm', async () => {
  const stray = { address: 'stray@example.test', confirmed_address: 'stray@example.test', pending_address: 'stray@example.test' };
  mockRoutes({
    gets: [answer({ ...athlete({ confirmed: true }), ...stray })],
    sendCode: answer({ ...athlete({ confirmed: true, pending: true }), ...stray }),
    enterCode: answer({ ...athlete({ confirmed: true }), ...stray }),
  });
  const { container } = render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByRole('button', { name: 'Change address' });
  const inputValues = () => [...container.querySelectorAll('input')].map((input) => input.value);

  expect(container.textContent).not.toContain('@');
  press('Change address');
  expect(inputValues()).toEqual(['']);
  fireEvent.change(addressField(), { target: { value: TYPED } });
  press('Send code');
  await screen.findByLabelText('Six-digit code from the email');
  expect(container.textContent).not.toContain('@');
  expect(inputValues()).toEqual([TYPED, '']);

  fireEvent.change(codeField(), { target: { value: '012345' } });
  press('Confirm');
  await waitFor(() => expect(screen.queryByLabelText('Six-digit code from the email')).not.toBeInTheDocument());
  press('Change address');
  expect(inputValues()).toEqual(['']);
  expect(container.textContent).not.toContain('@');
});

test.each(['staff', 'parent'])('a %s keeps EM-2\'s words and gets no address part', async (userType) => {
  mockRoutes({ gets: [answer({ ok: true, offered: true, user_type: userType, switched_on: false })] });
  const { container } = render(<EmailAlertSwitch styles={STYLES} />);
  await screen.findByRole('button', { name: 'On' });

  expect(container.querySelector('p.help')).toHaveTextContent(
    /^Off unless you turn it on\. When it is on, an email can go to the address you sign in with when certain new things arrive for you in the app\. It says only “open the app”, with the gym’s name\. It never says what happened or who it is about\.$/,
  );
  expect(status()).toHaveTextContent(/^Email alerts are off\.$/);
  expect(container.querySelector('input')).toBeNull();
  expect(screen.queryByRole('group', { name: 'Alert address' })).not.toBeInTheDocument();
});
