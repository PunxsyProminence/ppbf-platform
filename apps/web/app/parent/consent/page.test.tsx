/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import GuardianMediaConsentPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const NEEDS_CONSENT = [
  {
    athlete_id: 'ath-1',
    consent_ok: false,
    guardian_count: 1,
    missing_guardian_count: 1,
    per_guardian: [{ you: true, status: null, covers_video: null, public_use_allowed: null, signed_at: null }],
  },
];

const ALREADY_SIGNED = [
  {
    athlete_id: 'ath-1',
    consent_ok: true,
    guardian_count: 1,
    missing_guardian_count: 0,
    per_guardian: [{ you: true, status: 'signed', covers_video: true, public_use_allowed: false, signed_at: '2026-08-01T00:00:00Z' }],
  },
];

const originalFetch = global.fetch;
const originalConfirm = window.confirm;

afterEach(() => {
  global.fetch = originalFetch;
  window.confirm = originalConfirm;
  jest.clearAllMocks();
});

test('a child needing consent shows the Grant Consent button', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: NEEDS_CONSENT })) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  await screen.findByText('Consent needed');
  expect(screen.getByRole('button', { name: 'Grant Consent' })).toBeInTheDocument();
});

test('a child with consent already on file shows Withdraw Consent, not Grant', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ALREADY_SIGNED })) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  await screen.findByText('Consent on file');
  expect(screen.getByRole('button', { name: 'Withdraw Consent' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Grant Consent' })).not.toBeInTheDocument();
});

test('a multi-guardian child shows how many guardians still need to consent', async () => {
  const multiGuardian = [{ ...NEEDS_CONSENT[0], guardian_count: 2, missing_guardian_count: 1 }];
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: multiGuardian })) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  await screen.findByText(/This child has 2 guardians/);
});

test('granting posts decision=grant with the checkbox defaults (video included, not public)', async () => {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ athlete_id: 'ath-1', decision: 'grant', covers_video: true, public_use_allowed: false });
      return jsonResponse({ ok: true, athlete_id: 'ath-1', decision: 'grant' });
    }
    return jsonResponse({ ok: true, items: NEEDS_CONSENT });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);
  await screen.findByText('Consent needed');

  fireEvent.click(screen.getByRole('button', { name: 'Grant Consent' }));

  await waitFor(() => expect(screen.getByText('Consent granted.')).toBeInTheDocument());
});

/* A-Q14 "Hide until used" (OD-2026-10-08-005): the public-use choice is not
   offered on this page. The API field is still sent, always false, so the
   server contract and its default are unchanged. */
test('no "Allow public use" control is offered; the page says the consent is gym-internal', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: NEEDS_CONSENT })) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);
  await screen.findByText('Consent needed');

  expect(screen.queryByText(/Allow public use/)).not.toBeInTheDocument();
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  expect(screen.getByRole('checkbox', { name: /Include video/ })).toBeInTheDocument();
  expect(screen.getByText(/Nothing is posted publicly on this consent/)).toBeInTheDocument();
  // Who inside the gym can see it is named, not implied: the clip library is
  // gym-wide (OD-2026-10-08-004) and coaches and athletes can browse it.
  expect(screen.getByText(/clip library, which coaches and athletes signed in at this gym can browse/)).toBeInTheDocument();
});

test('withdrawing asks for confirmation first and sends nothing if declined', async () => {
  window.confirm = jest.fn().mockReturnValue(false);
  const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ALREADY_SIGNED }));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);
  await screen.findByText('Consent on file');

  fireEvent.click(screen.getByRole('button', { name: 'Withdraw Consent' }));

  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('withdrawing, once confirmed, posts decision=withdraw', async () => {
  window.confirm = jest.fn().mockReturnValue(true);
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      expect(body.decision).toBe('withdraw');
      return jsonResponse({ ok: true, athlete_id: 'ath-1', decision: 'withdraw' });
    }
    return jsonResponse({ ok: true, items: ALREADY_SIGNED });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);
  await screen.findByText('Consent on file');

  fireEvent.click(screen.getByRole('button', { name: 'Withdraw Consent' }));

  await waitFor(() => expect(screen.getByText('Consent withdrawn.')).toBeInTheDocument());
});

test('no linked children renders the empty state', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: [] })) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  await screen.findByText('No linked children found');
});

test('a failed load shows the error state, never a false empty state', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'Database unavailable' }, false)) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  await screen.findByText('Database unavailable');
  expect(screen.queryByText('No linked children found')).not.toBeInTheDocument();
});

test('a child is named, not numbered, and the withdraw confirmation names them too', async () => {
  window.confirm = jest.fn().mockReturnValue(false);
  const named = [{ ...ALREADY_SIGNED[0], athlete_name: 'Mia Cortez' }];
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: named })) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  await screen.findByText('Mia Cortez');
  expect(screen.queryByText('ath-1')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Withdraw Consent' }));

  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  const message = (window.confirm as jest.Mock).mock.calls[0][0] as string;
  expect(message).toContain('Mia Cortez');
  expect(message).toMatch(/retracted from distribution immediately/);
});

// UXB-12: a missing name says so; the athlete id is never shown to a family,
// on the card or in the withdraw confirmation.
test('a missing name reads "Your child (name not loaded)", never the athlete id', async () => {
  window.confirm = jest.fn().mockReturnValue(false);
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ALREADY_SIGNED })) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  await screen.findByText('Your child (name not loaded)');
  expect(screen.queryByText(/ath-1/)).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Withdraw Consent' }));

  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  const message = (window.confirm as jest.Mock).mock.calls[0][0] as string;
  expect(message).not.toContain('ath-1');
  expect(message).toContain('your child');
});

// UXB-22: a guardian can see what their consent covers, and since which gym
// day it has been on file. The route's signed_at is the row's created_at (when
// it was entered, possibly from a paper form later), so the page never says
// "You signed". 02:00 UTC on August 1 is still July 31 at the gym.
test('a signed consent says since when it is on file and that it covers photos and video', async () => {
  const signed = [{ ...ALREADY_SIGNED[0], per_guardian: [{ ...ALREADY_SIGNED[0].per_guardian[0], signed_at: '2026-08-01T02:00:00Z' }] }];
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: signed })) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  expect(await screen.findByText('On file since July 31, 2026: photos and video')).toBeInTheDocument();
  expect(screen.queryByText(/You signed/)).toBeNull();
  expect(screen.queryByText(/public use/)).toBeNull();
});

test('a consent on file that allows public use says so', async () => {
  const publicUse = [{ ...ALREADY_SIGNED[0], per_guardian: [{ ...ALREADY_SIGNED[0].per_guardian[0], signed_at: '2026-08-01T02:00:00Z', public_use_allowed: true }] }];
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: publicUse })) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  expect(await screen.findByText('On file since July 31, 2026: photos and video, public use allowed')).toBeInTheDocument();
});

test('a signed photos-only consent says photos only', async () => {
  const photosOnly = [{ ...ALREADY_SIGNED[0], per_guardian: [{ ...ALREADY_SIGNED[0].per_guardian[0], covers_video: false }] }];
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: photosOnly })) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  expect(await screen.findByText(/^On file since .+: photos only$/)).toBeInTheDocument();
  expect(screen.queryByText(/photos and video/)).toBeNull();
});

// UXB-23: a refused decision and a recorded one do not look the same.
test('a decision the server refuses reads as an alert, not a status line', async () => {
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? jsonResponse({ error: 'Unable to record your decision.' }, false)
      : jsonResponse({ ok: true, items: NEEDS_CONSENT }),
  );
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);
  await screen.findByText('Consent needed');

  fireEvent.click(screen.getByRole('button', { name: 'Grant Consent' }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Unable to record your decision.');
  expect(screen.queryByRole('status')).toBeNull();
});

test('a recorded decision reads as a status line, not an alert', async () => {
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST' ? jsonResponse({ ok: true }) : jsonResponse({ ok: true, items: NEEDS_CONSENT }),
  );
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);
  await screen.findByText('Consent needed');

  fireEvent.click(screen.getByRole('button', { name: 'Grant Consent' }));

  expect(await screen.findByRole('status')).toHaveTextContent('Consent granted.');
  expect(screen.queryByRole('alert')).toBeNull();
  // Let the re-read and the pending flag settle inside the test.
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Grant Consent' })).toBeEnabled());
});

// After a grant the page re-reads; the "On file since" line comes from the
// server's answer, not from the click.
test('after a successful grant the re-read shows the consent on file', async () => {
  let gets = 0;
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return jsonResponse({ ok: true });
    gets += 1;
    return jsonResponse({ ok: true, items: gets === 1 ? NEEDS_CONSENT : ALREADY_SIGNED });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);
  await screen.findByText('Consent needed');
  expect(screen.queryByText(/^On file since/)).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Grant Consent' }));

  expect(await screen.findByText(/^On file since .+: photos and video$/)).toBeInTheDocument();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(screen.getByText('Consent on file')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Withdraw Consent' })).toBeEnabled());
});

// An old "Consent granted." must not stay on screen through a retry.
test('Check again clears an earlier decision message', async () => {
  let gets = 0;
  const fetchMock = jest.fn((_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve(jsonResponse({ ok: true }));
    gets += 1;
    if (gets === 1) return Promise.resolve(jsonResponse({ ok: true, items: NEEDS_CONSENT }));
    if (gets === 2) return Promise.resolve(jsonResponse({ error: 'Database unavailable' }, false));
    return new Promise<Response>(() => undefined);
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);
  await screen.findByText('Consent needed');

  fireEvent.click(screen.getByRole('button', { name: 'Grant Consent' }));
  await screen.findByText('Consent status could not be loaded');
  expect(screen.getByText('Consent granted.')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

  expect(await screen.findByText('Loading…')).toBeInTheDocument();
  expect(screen.queryByText('Consent granted.')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});

// UXB-13: a failed read offers Check again, which re-reads; while it does,
// the page reads Loading, not the failure.
test('a failed load offers Check again, which reads Loading and then the answer', async () => {
  let answer: (value: Response) => void = () => undefined;
  const fetchMock = jest
    .fn()
    .mockResolvedValueOnce(jsonResponse({ error: 'Database unavailable' }, false))
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);
  await screen.findByText('Consent status could not be loaded');

  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

  expect(await screen.findByText('Loading…')).toBeInTheDocument();
  expect(screen.queryByText('Consent status could not be loaded')).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);

  answer(jsonResponse({ ok: true, items: NEEDS_CONSENT }));
  expect(await screen.findByText('Consent needed')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

/**
 * Owner decision, 2026-08-28: the server now treats a consent recorded as
 * ' Signed ' as a signature (guardianConsent.ts normalises before comparing,
 * matching what waiverCompliance.ts's gate has always done with this column).
 *
 * The route hands this screen the RAW stored string, so without the matching
 * normalisation here a guardian whose consent the server accepts would be told
 * on their own screen that they had not signed -- and offered the button to
 * sign again. The two readings have to agree.
 */
test('a consent stored with stray whitespace reads as signed on the guardian’s own screen', async () => {
  const UNTIDY = [
    {
      athlete_id: 'ath-1',
      consent_ok: true,
      guardian_count: 1,
      missing_guardian_count: 0,
      per_guardian: [{ you: true, status: ' Signed ', covers_video: true, public_use_allowed: false, signed_at: '2026-08-01T00:00:00Z' }],
    },
  ];
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: UNTIDY })) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  // The signed branch renders Withdraw; the unsigned branch renders Grant.
  expect(await screen.findByRole('button', { name: /withdraw/i })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /grant consent/i })).toBeNull();
});

test('a status this platform does not recognise still reads as NOT signed', async () => {
  // The blast radius. Only case and padding move; 'active' is a value
  // wallDisplay.ts treats as affirmative and this screen must not, or the
  // decision would have quietly settled a divergence it did not settle.
  const UNKNOWN = [
    {
      athlete_id: 'ath-1',
      consent_ok: false,
      guardian_count: 1,
      missing_guardian_count: 1,
      per_guardian: [{ you: true, status: 'active', covers_video: true, public_use_allowed: false, signed_at: '2026-08-01T00:00:00Z' }],
    },
  ];
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: UNKNOWN })) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  expect(await screen.findByRole('button', { name: /grant consent/i })).toBeTruthy();
});
