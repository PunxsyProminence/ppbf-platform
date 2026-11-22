/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { GUARDIAN_MEDIA_WORDS } from '@/components/mediaConsentWords';

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

/* HF9-1 (Q3 = A on #2083): where photos and video go, in the owner's words,
   on every child's card, whether this guardian has signed, withdrawn or not
   yet decided. Before this, the one sentence on it said photos and video
   "stay inside the gym", and only a guardian who had not signed saw it. */
describe('where photos and video go', () => {
  type Row = Record<string, unknown>;
  const own = (status: string | null, coversVideo: boolean | null): Row => ({
    you: true,
    status,
    covers_video: coversVideo,
    public_use_allowed: status === null ? null : false,
    signed_at: status === null ? null : '2026-08-01T00:00:00Z',
  });
  const child = (id: string, name: string, rows: Row[], overrides: Row = {}) => {
    const signed = rows.filter((row) => row.status === 'signed' || row.status === 'granted').length;
    return {
      athlete_id: id,
      athlete_name: name,
      consent_ok: signed === rows.length,
      guardian_count: rows.length,
      missing_guardian_count: rows.length - signed,
      per_guardian: rows,
      ...overrides,
    };
  };
  const cardOf = (name: string) => screen.getByText(name).closest('article') as HTMLElement;

  test.each([
    ['not yet decided', [own(null, null)]],
    ['signed, photos and video', [own('signed', true)]],
    ['signed, photos only', [own('signed', false)]],
    ['withdrawn', [own('withdrawn', false)]],
    ['a status this page does not recognise', [own('pending', true)]],
    ['signed, while a co-guardian has not', [own('signed', true), { you: false, status: 'not_on_file' }]],
    ['missing: only a co-guardian\'s row came back', [{ you: false, status: 'granted' }]],
  ])('a guardian whose own consent is %s reads the words, whole and once, on the child\'s card', async (_label, rows) => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({ ok: true, items: [child('ath-1', 'Jamie Rivera', rows)] }),
    ) as unknown as typeof fetch;

    const view = render(<GuardianMediaConsentPage />);
    await screen.findByText('Jamie Rivera');

    expect(within(cardOf('Jamie Rivera')).getAllByText(GUARDIAN_MEDIA_WORDS)).toHaveLength(1);
    // The old sentence is gone in this state too, not only where it used to show.
    expect(view.container.textContent).not.toMatch(/stays? inside the gym/i);
  });

  test('with two children, one signed and one not, each card carries the words once', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({
      ok: true,
      items: [child('ath-1', 'Jamie Rivera', [own('signed', true)]), child('ath-2', 'Alex Rivera', [own(null, null)])],
    })) as unknown as typeof fetch;

    render(<GuardianMediaConsentPage />);
    await screen.findByText('Alex Rivera');

    for (const name of ['Jamie Rivera', 'Alex Rivera']) {
      expect(within(cardOf(name)).getAllByText(GUARDIAN_MEDIA_WORDS)).toHaveLength(1);
    }
    expect(screen.getAllByText(GUARDIAN_MEDIA_WORDS)).toHaveLength(2);
  });
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
  // A refused decision is a warning, not a safety state (critical is kept for those).
  expect(alert).toHaveClass('alert--warning');
  expect(alert).not.toHaveClass('alert--critical');
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

  expect(await screen.findByText('Loading consent status…')).toBeInTheDocument();
  expect(screen.queryByText('Consent granted.')).toBeNull();
  // The only status on the page is the loading one, not the old decision.
  expect(screen.getByRole('status')).toHaveTextContent('Loading consent status…');
});

// Parent walk 2026-10-19 item 13: a bare "Loading…" stood for 2 to 5 seconds
// and read like the empty state. It now names what is loading, says it can take
// a few seconds, and is a status region so it is announced.
test('while the read is open the page names what it is loading and says it can take a few seconds', async () => {
  global.fetch = jest.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  const status = await screen.findByRole('status');
  expect(status).toHaveTextContent('Loading consent status…');
  expect(status).toHaveTextContent('This can take a few seconds.');
  expect(screen.queryByText('No linked children found')).toBeNull();
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

  expect(await screen.findByText('Loading consent status…')).toBeInTheDocument();
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

/* "CHANGE TO PHOTOS ONLY" (app scrub FAM-19; Jason's ruling on card OW27-14,
   "B: Build it, with a confirm", OD-2026-11-20-001). A guardian whose consent
   includes video can take video out without withdrawing everything. It is the
   existing grant with covers_video false, behind a confirm that names the
   child and says what follows. */
describe('Change to photos only', () => {
  const signedRow = (overrides: Record<string, unknown> = {}) => [
    {
      athlete_id: 'ath-1',
      athlete_name: 'Jamie Rivera',
      consent_ok: true,
      guardian_count: 1,
      missing_guardian_count: 0,
      per_guardian: [{ you: true, status: 'signed', covers_video: true, public_use_allowed: false, signed_at: '2026-08-01T00:00:00Z', ...overrides }],
    },
  ];

  function installFetch(items: unknown, post?: (body: Record<string, unknown>) => Response | Promise<Response>) {
    const posts: Array<Record<string, unknown>> = [];
    const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        return post ? post(body) : jsonResponse({ ok: true, athlete_id: 'ath-1', decision: 'grant', retracted_publication_ids: [] });
      }
      return jsonResponse({ ok: true, items });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return { fetchMock, posts };
  }

  test('is offered only on the guardian’s own signed row that includes video', async () => {
    installFetch(signedRow());
    const { unmount } = render(<GuardianMediaConsentPage />);
    await screen.findByText('Consent on file');
    expect(screen.getByRole('button', { name: 'Change to photos only' })).toBeInTheDocument();
    // Withdraw keeps its place: first, and the kiosk-height primary.
    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons).toEqual(['Withdraw Consent', 'Change to photos only']);
    unmount();

    for (const items of [
      signedRow({ covers_video: false }), // already photos only
      signedRow({ covers_video: null }), // the scope did not arrive: not guessed at
      NEEDS_CONSENT, // nothing signed
      signedRow({ status: 'withdrawn', covers_video: true }), // not a signed row
    ]) {
      installFetch(items);
      const view = render(<GuardianMediaConsentPage />);
      await screen.findByText(/Consent on file|Consent needed/);
      expect(screen.queryByRole('button', { name: 'Change to photos only' })).not.toBeInTheDocument();
      view.unmount();
    }
  });

  test('a co-guardian’s row never offers it: only the caller’s own consent can be changed here', async () => {
    /* The caller has signed, photos only, so their own row has nothing to
       change; the co-guardian has granted video. Offering the control here
       would be offering to change the co-guardian's consent. The co-guardian
       comes first in the list: a page that offered the control whenever a
       co-guardian's row is there would draw it, and one that read the first
       row as the caller's would draw Grant instead of Withdraw. (The server
       answers for the caller's own guardian record only, whatever the page
       sends: route.ts resolves it from the session.) */
    const coGuardianFirst = (own: Record<string, unknown>) => [
      {
        athlete_id: 'ath-1',
        athlete_name: 'Jamie Rivera',
        consent_ok: true,
        guardian_count: 2,
        missing_guardian_count: 0,
        per_guardian: [
          { you: false, status: 'granted' },
          { you: true, status: 'signed', public_use_allowed: false, signed_at: '2026-08-01T00:00:00Z', ...own },
        ],
      },
    ];

    installFetch(coGuardianFirst({ covers_video: false }));
    const view = render(<GuardianMediaConsentPage />);
    await screen.findByText(/photos only$/);
    expect(screen.queryByRole('button', { name: 'Change to photos only' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw Consent' })).toBeInTheDocument();
    view.unmount();

    // Positive control: the same list with the caller's own row including
    // video does draw it, so the absence above is the caller's row speaking.
    installFetch(coGuardianFirst({ covers_video: true }));
    render(<GuardianMediaConsentPage />);
    await screen.findByText(/photos and video$/);
    expect(screen.getByRole('button', { name: 'Change to photos only' })).toBeInTheDocument();
  });

  test('asks first, naming the child and what follows, and sends nothing if declined', async () => {
    const confirm = jest.fn().mockReturnValue(false);
    window.confirm = confirm;
    const { fetchMock, posts } = installFetch(signedRow());
    render(<GuardianMediaConsentPage />);
    await screen.findByText('Consent on file');

    fireEvent.click(screen.getByRole('button', { name: 'Change to photos only' }));

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    const asked = String(confirm.mock.calls[0][0]);
    expect(asked).toBe(
      'Change consent for Jamie Rivera to photos only? If you do, Jamie Rivera’s published videos will be retracted from distribution immediately, and Jamie Rivera’s videos will not be published while your photos-only consent is in place.',
    );
    expect(asked).not.toContain('ath-1');
    expect(posts).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Nothing on the page says it changed.
    expect(screen.queryByText('Consent changed to photos only.')).not.toBeInTheDocument();
    expect(screen.getByText(/photos and video/)).toBeInTheDocument();
  });

  test('once confirmed, sends the existing grant with video left out and public use off, then re-reads', async () => {
    window.confirm = jest.fn().mockReturnValue(true);
    let stored = signedRow();
    const posts: Array<Record<string, unknown>> = [];
    global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        stored = signedRow({ covers_video: false });
        return jsonResponse({ ok: true, athlete_id: 'ath-1', decision: 'grant', retracted_publication_ids: ['pub-1'] });
      }
      return jsonResponse({ ok: true, items: stored });
    }) as unknown as typeof fetch;
    render(<GuardianMediaConsentPage />);
    await screen.findByText('Consent on file');

    fireEvent.click(screen.getByRole('button', { name: 'Change to photos only' }));

    const done = await screen.findByText('Consent changed to photos only.');
    expect(done).toHaveAttribute('role', 'status');
    expect(posts).toEqual([{ athlete_id: 'ath-1', decision: 'grant', covers_video: false, public_use_allowed: false }]);
    // The re-read shows what the server now holds, and the control is gone.
    await screen.findByText(/photos only$/);
    expect(screen.queryByRole('button', { name: 'Change to photos only' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw Consent' })).toBeInTheDocument();
  });

  test('when public use is on file, the confirm says it ends too; otherwise it does not mention it', async () => {
    const confirm = jest.fn().mockReturnValue(false);
    window.confirm = confirm;
    installFetch(signedRow({ public_use_allowed: true }));
    const view = render(<GuardianMediaConsentPage />);
    await screen.findByText('Consent on file');
    fireEvent.click(screen.getByRole('button', { name: 'Change to photos only' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(String(confirm.mock.calls[0][0])).toMatch(/ Public use, which is allowed now, will end too\.$/);
    view.unmount();

    confirm.mockClear();
    installFetch(signedRow());
    render(<GuardianMediaConsentPage />);
    await screen.findByText('Consent on file');
    fireEvent.click(screen.getByRole('button', { name: 'Change to photos only' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(String(confirm.mock.calls[0][0])).not.toMatch(/Public use/);
  });

  test('with two children, the control acts on and names the child whose card it is on', async () => {
    /* A wrong-sibling change would be a real downgrade of a real child's
       consent: the server only refuses a child who is not the caller's own. */
    const confirm = jest.fn().mockReturnValue(true);
    window.confirm = confirm;
    const own = { you: true, status: 'signed', covers_video: true, public_use_allowed: false, signed_at: '2026-08-01T00:00:00Z' };
    const { posts } = installFetch([
      { athlete_id: 'ath-1', athlete_name: 'Jamie Rivera', consent_ok: true, guardian_count: 1, missing_guardian_count: 0, per_guardian: [own] },
      { athlete_id: 'ath-2', athlete_name: 'Alex Rivera', consent_ok: true, guardian_count: 1, missing_guardian_count: 0, per_guardian: [own] },
    ]);
    render(<GuardianMediaConsentPage />);
    await screen.findAllByText('Consent on file');
    expect(screen.getAllByRole('button', { name: 'Change to photos only' })).toHaveLength(2);

    // Each card's own button, found inside that card, so a control bound to
    // the first child, the last child, or a re-sorted list fails one of the two.
    const cardOf = (name: string) => screen.getByText(name).closest('article') as HTMLElement;
    const expected = [
      { name: 'Jamie Rivera', other: 'Alex', athlete_id: 'ath-1' },
      { name: 'Alex Rivera', other: 'Jamie', athlete_id: 'ath-2' },
    ];
    for (const [index, child] of expected.entries()) {
      fireEvent.click(within(cardOf(child.name)).getByRole('button', { name: 'Change to photos only' }));
      await waitFor(() => expect(posts).toHaveLength(index + 1));
      const asked = String(confirm.mock.calls[index][0]);
      expect(asked).toMatch(new RegExp(`^Change consent for ${child.name} to photos only\\?`));
      expect(asked).not.toContain(child.other);
      expect(posts[index]).toEqual({ athlete_id: child.athlete_id, decision: 'grant', covers_video: false, public_use_allowed: false });
      await screen.findByText('Consent changed to photos only.');
    }
  });

  test('when public use is on file and the guardian accepts, the grant sends public use off, as the confirm said', async () => {
    /* The one case where "Public use … will end too" rests on the request:
       a grant from this page never carries public use (A-Q14,
       OD-2026-10-08-005), even when the row it replaces allowed it. */
    window.confirm = jest.fn().mockReturnValue(true);
    const { posts } = installFetch(signedRow({ public_use_allowed: true }));
    render(<GuardianMediaConsentPage />);
    await screen.findByText(/public use allowed$/);

    fireEvent.click(screen.getByRole('button', { name: 'Change to photos only' }));

    await screen.findByText('Consent changed to photos only.');
    expect(posts).toEqual([{ athlete_id: 'ath-1', decision: 'grant', covers_video: false, public_use_allowed: false }]);
  });

  test('while the change is being sent, both of the row’s buttons are disabled', async () => {
    window.confirm = jest.fn().mockReturnValue(true);
    let answer: (response: Response) => void = () => {};
    installFetch(signedRow(), () => new Promise<Response>((resolve) => { answer = resolve; }));
    render(<GuardianMediaConsentPage />);
    await screen.findByText('Consent on file');

    fireEvent.click(screen.getByRole('button', { name: 'Change to photos only' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Change to photos only' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Withdraw Consent' })).toBeDisabled();
    answer(jsonResponse({ ok: true, athlete_id: 'ath-1', decision: 'grant', retracted_publication_ids: [] }));
    await screen.findByText('Consent changed to photos only.');
  });

  test('a refusal from the server reads as an alert in the server’s words, and nothing says it changed', async () => {
    window.confirm = jest.fn().mockReturnValue(true);
    installFetch(signedRow(), () =>
      jsonResponse({ ok: false, error: 'Your consent for photos only was not recorded. Nothing was changed.' }, false));
    render(<GuardianMediaConsentPage />);
    await screen.findByText('Consent on file');

    fireEvent.click(screen.getByRole('button', { name: 'Change to photos only' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your consent for photos only was not recorded. Nothing was changed.');
    expect(screen.queryByText('Consent changed to photos only.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change to photos only' })).toBeInTheDocument();
  });

  test('withdrawing still sends decision=withdraw with no scope, as before', async () => {
    window.confirm = jest.fn().mockReturnValue(true);
    const { posts } = installFetch(signedRow());
    render(<GuardianMediaConsentPage />);
    await screen.findByText('Consent on file');
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw Consent' }));
    await screen.findByText('Consent withdrawn.');
    expect(posts).toEqual([{ athlete_id: 'ath-1', decision: 'withdraw' }]);
  });
});

/* THE FAMILY GROUND (app scrub FAM-28; AS-9 Q9 = A). The page stands on the
   canvas with paper panels, as the hub, film and progress pages do, and sets
   no colour of its own: every voice comes from the design system, which
   restates it in ink for this ground. Looked at on a local render,
   2026-11-20. */
describe('the family ground', () => {
  test('the page is on the canvas with paper panels, not the dark ground with leather', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ALREADY_SIGNED })) as unknown as typeof fetch;
    const { container } = render(<GuardianMediaConsentPage />);
    await screen.findByText('Consent on file');

    const main = container.querySelector('main') as HTMLElement;
    expect(main.className).toContain('on-canvas');
    // The hub's family dress: its focus ring is the one that shows on this
    // ground (a ghost button's ring is lost to `.on-canvas .btn--ghost`).
    expect(main).toHaveClass('ge-family');
    expect(main.className).not.toContain('hide-950');
    expect(container.querySelectorAll('.mat-paper').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('.mat-leather')).toBeNull();
    // No colour tuned for the dark ground is left anywhere on the page.
    expect(container.innerHTML).not.toMatch(/--bone-|--brass-300|--hide-9/);
  });

  test('the Include video box takes the brass rung that shows on paper', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: NEEDS_CONSENT })) as unknown as typeof fetch;
    const { container } = render(<GuardianMediaConsentPage />);
    await screen.findByText('Consent needed');
    const box = container.querySelector('input[type="checkbox"]') as HTMLElement;
    expect(box.className).toContain('accent-[var(--brass-700)]');
  });

  test('loading, failed and nobody-linked each stand on a paper panel that inks .empty', async () => {
    for (const [response, title] of [
      [new Promise<Response>(() => {}), 'Loading consent status…'],
      [Promise.resolve(jsonResponse({ error: 'down' }, false)), 'Consent status could not be loaded'],
      [Promise.resolve(jsonResponse({ ok: true, items: [] })), 'No linked children found'],
    ] as const) {
      global.fetch = jest.fn().mockReturnValue(response) as unknown as typeof fetch;
      const view = render(<GuardianMediaConsentPage />);
      const heading = await screen.findByText(title);
      expect(heading.closest('.mat-paper')).not.toBeNull();
      // .empty's inks are bone; the sheet restates them in ink only under
      // .pap ("The empty state on paper"). Without it the title measured
      // 1.36:1 to 1.12:1 on a local render (2026-11-21).
      expect(heading.closest('.pap')).not.toBeNull();
      view.unmount();
    }
  });
});
