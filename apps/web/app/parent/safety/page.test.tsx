/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';

import GuardianSafetyPage from './page';

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

const HELD_ATHLETE = [
  {
    athlete_id: 'ath-1',
    athlete_name: 'Jordan T.',
    hold: {
      scope: 'all_training' as const,
      athlete_explanation: 'You need a doctor note before training resumes.',
      lift_condition_text: 'Bring a signed clearance note.',
      placed_at: '2026-08-01T00:00:00.000Z',
      expires_at: null,
      // Owner decision 2026-08-19: a guardian gets a real point of contact.
      // RefusalStamp's training_hold kind THROWS on a blank coachName rather
      // than render a nameless hold, so a fixture without this renders nothing
      // at all -- which is exactly how this test caught its own omission.
      placed_by_name: 'Coach Neale',
    },
    gates: [
      { gate_key: 'contact_medical_clearance', name: 'Contact Requires Medical Clearance', category: 'medical', outcome: 'flagged' as const, evaluated_at: '2026-08-01T00:00:00.000Z' },
    ],
  },
];

const CLEAR_ATHLETE = [
  {
    athlete_id: 'ath-2',
    athlete_name: 'Sam R.',
    hold: null,
    gates: [
      { gate_key: 'contact_medical_clearance', name: 'Contact Requires Medical Clearance', category: 'medical', outcome: 'passed' as const, evaluated_at: '2026-08-01T00:00:00.000Z' },
    ],
  },
];

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

test('an athlete under an active hold shows the athlete-safe explanation and lift condition', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: HELD_ATHLETE })) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('Training is paused right now');
  expect(screen.getByText('You need a doctor note before training resumes.')).toBeInTheDocument();
  expect(screen.getByText(/Bring a signed clearance note\./)).toBeInTheDocument();
});

// Owner decision 2026-08-19: "so they have a point of contact to investigate
// why". A hold that reaches a guardian without naming who placed it is the
// state this decision reversed, so it gets its own assertion rather than
// riding along inside the test above.
test('a guardian is told who placed the hold, so they have someone to ask', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: HELD_ATHLETE })) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('Training is paused right now');
  expect(screen.getByText('Coach Neale')).toBeInTheDocument();
});

test('an athlete with no active hold shows "no training pause on file", not silence', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: CLEAR_ATHLETE })) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('No training pause on file right now.');
  expect(screen.queryByText('Training is paused right now')).not.toBeInTheDocument();
});

test('gate outcomes render with human labels, not raw enum values', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: CLEAR_ATHLETE })) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('Contact Requires Medical Clearance');
  expect(screen.getByText('Clear')).toBeInTheDocument();
  expect(screen.queryByText('passed')).not.toBeInTheDocument();
});

test('multiple linked children each render their own card', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: [...HELD_ATHLETE, ...CLEAR_ATHLETE] })) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('Jordan T.');
  expect(screen.getByText('Sam R.')).toBeInTheDocument();
});

test('links to the existing consent page rather than duplicating it', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: [] })) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('No linked children found');
  expect(screen.getByRole('link', { name: 'Photo & Video Consent' })).toHaveAttribute('href', '/parent/consent');
});

test('no linked children renders the empty state', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: [] })) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('No linked children found');
});

/* ---------------------------------------------------------------- waivers --
 * Owner decision 2026-09-29 (Q4 A): show the guardian the waiver statuses the
 * route has returned since #799. Only the guardian can sign the travel waiver
 * the competition gate reads, so a status that reads wrong here is worse than
 * none: missing must read Missing, and anything the page does not recognise
 * must read Unknown -- never Signed. */

function waiverRow(article: HTMLElement, type: string): HTMLElement {
  const row = article.querySelector<HTMLElement>(`[data-waiver-type="${type}"]`);
  if (!row) throw new Error(`no waiver row for ${type}`);
  return row;
}

function athleteWith(waivers: unknown, athleteName = 'Casey W.') {
  return [
    {
      athlete_id: 'ath-3',
      athlete_name: athleteName,
      hold: null,
      gates: [],
      waivers,
    },
  ];
}

async function renderCard(items: unknown[], athleteName = 'Casey W.'): Promise<HTMLElement> {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items })) as unknown as typeof fetch;
  render(<GuardianSafetyPage />);
  const name = await screen.findByText(athleteName);
  const article = name.closest('article');
  if (!article) throw new Error('athlete card not found');
  return article;
}

test('each tracked waiver renders with its label, status glyph and status word', async () => {
  const article = await renderCard(
    athleteWith({ general: 'signed', medical_release: 'declined', photo_media: 'withdrawn', travel: 'missing' }),
  );

  expect(within(article).getByText('Waivers')).toBeInTheDocument();

  const general = waiverRow(article, 'general');
  expect(within(general).getByText('General')).toBeInTheDocument();
  expect(within(general).getByText('Signed')).toBeInTheDocument();
  expect(within(general).getByText('✓')).toBeInTheDocument();
  expect(within(general).getByText('Signed').closest('.badge')).toHaveClass('badge--cleared');

  const medical = waiverRow(article, 'medical_release');
  expect(within(medical).getByText('Medical release')).toBeInTheDocument();
  expect(within(medical).getByText('Declined')).toBeInTheDocument();
  expect(within(medical).getByText('▲')).toBeInTheDocument();

  const photo = waiverRow(article, 'photo_media');
  expect(within(photo).getByText('Photo & media')).toBeInTheDocument();
  expect(within(photo).getByText('Withdrawn')).toBeInTheDocument();
  expect(within(photo).getByText('▲')).toBeInTheDocument();

  const travel = waiverRow(article, 'travel');
  expect(within(travel).getByText('Travel')).toBeInTheDocument();
  expect(within(travel).getByText('Missing')).toBeInTheDocument();
});

test('a missing waiver reads Missing with the warning mark, never Signed', async () => {
  const article = await renderCard(
    athleteWith({ general: 'signed', medical_release: 'signed', photo_media: 'signed', travel: 'missing' }),
  );

  const travel = waiverRow(article, 'travel');
  expect(within(travel).getByText('Missing')).toBeInTheDocument();
  expect(within(travel).getByText('▲')).toBeInTheDocument();
  expect(within(travel).queryByText('Signed')).not.toBeInTheDocument();
  expect(within(travel).queryByText('✓')).not.toBeInTheDocument();
  expect(within(travel).getByText('Missing').closest('.badge')).not.toHaveClass('badge--cleared');
});

test('an unrecognised status reads Unknown, never Signed or Missing', async () => {
  const article = await renderCard(
    athleteWith({ general: 'pending', medical_release: 'SIGNED', photo_media: 42, travel: null }),
  );

  for (const type of ['general', 'medical_release', 'photo_media', 'travel']) {
    const row = waiverRow(article, type);
    expect(within(row).getByText('Unknown')).toBeInTheDocument();
    expect(within(row).getByText('◌')).toBeInTheDocument();
    expect(within(row).queryByText('Signed')).not.toBeInTheDocument();
    expect(within(row).queryByText('Missing')).not.toBeInTheDocument();
  }
});

test('a tracked type the response leaves out still gets a row, reading Unknown', async () => {
  const article = await renderCard(athleteWith({ general: 'signed' }));

  expect(within(waiverRow(article, 'general')).getByText('Signed')).toBeInTheDocument();
  for (const type of ['medical_release', 'photo_media', 'travel']) {
    expect(within(waiverRow(article, type)).getByText('Unknown')).toBeInTheDocument();
  }
});

test('no waivers field at all reads Unknown for every tracked type, not Missing or Signed', async () => {
  const article = await renderCard(athleteWith(undefined));

  for (const type of ['general', 'medical_release', 'photo_media', 'travel']) {
    const row = waiverRow(article, type);
    expect(within(row).getByText('Unknown')).toBeInTheDocument();
  }
  expect(within(article).queryByText('Missing')).not.toBeInTheDocument();
  expect(within(article).queryByText('Signed')).not.toBeInTheDocument();
});

test('a waiver type the page does not know is still shown, not dropped', async () => {
  const article = await renderCard(
    athleteWith({ general: 'signed', medical_release: 'signed', photo_media: 'signed', travel: 'signed', program_consent: 'signed' }),
  );

  const extra = waiverRow(article, 'program_consent');
  expect(within(extra).getByText('program consent')).toBeInTheDocument();
  expect(within(extra).getByText('Signed')).toBeInTheDocument();
});

test('each child card shows its own waivers', async () => {
  global.fetch = jest.fn().mockResolvedValue(
    jsonResponse({
      ok: true,
      items: [
        { ...CLEAR_ATHLETE[0], waivers: { general: 'signed', medical_release: 'signed', photo_media: 'signed', travel: 'signed' } },
        { ...athleteWith({ general: 'signed', medical_release: 'signed', photo_media: 'signed', travel: 'missing' })[0] },
      ],
    }),
  ) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  const sam = (await screen.findByText('Sam R.')).closest('article') as HTMLElement;
  const casey = screen.getByText('Casey W.').closest('article') as HTMLElement;
  expect(within(waiverRow(sam, 'travel')).getByText('Signed')).toBeInTheDocument();
  expect(within(waiverRow(casey, 'travel')).getByText('Missing')).toBeInTheDocument();
});

test('the header names the four tracked waivers and keeps "what your child can see" to the hold and checks', async () => {
  // No athlete screen shows waivers, and the list is the four tracked types,
  // not every waiver on file -- the header may claim neither.
  await renderCard(athleteWith({ general: 'signed', medical_release: 'signed', photo_media: 'signed', travel: 'signed' }));

  const header = screen.getByRole('heading', { name: 'Safety Status' }).closest('header') as HTMLElement;
  const copy = header.textContent ?? '';
  expect(copy).toContain(
    'their standing against the gym’s safety checks -- the same information your child can see about themselves, nothing more.',
  );
  expect(copy).toContain(
    'the status of the four waivers the gym tracks: general, medical release, photo & media and travel.',
  );
  expect(copy).toContain('Photo & media reads Signed only when every guardian on file for your child has signed it');
  // Jason 2026-09-29 (P3 A): every child reads Missing until the gym records
  // these waiver types, so the page says what Missing means.
  expect(copy).toContain('Missing means the gym has not recorded that waiver yet.');
  // Owner decision 2026-10-04: guardians read their child's injury record, so the header says so.
  expect(copy).toContain(
    'Then your child’s injury record: each injury the gym recorded, where and what kind, who reported it and when they are expected back -- the same record your child sees, without staff notes.',
  );
  expect(copy).not.toContain('each of their waivers');
  // The claim sentence ends before the waivers are mentioned.
  const claimEnd = copy.indexOf('nothing more.');
  expect(claimEnd).toBeGreaterThan(-1);
  expect(copy.slice(0, claimEnd).toLowerCase()).not.toContain('waiver');
});

test('adding waivers leaves the hold and the safety checks as they were', async () => {
  global.fetch = jest.fn().mockResolvedValue(
    jsonResponse({
      ok: true,
      items: [{ ...HELD_ATHLETE[0], waivers: { general: 'signed', medical_release: 'signed', photo_media: 'signed', travel: 'missing' } }],
    }),
  ) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('Training is paused right now');
  expect(screen.getByText('You need a doctor note before training resumes.')).toBeInTheDocument();
  expect(screen.getByText('Coach Neale')).toBeInTheDocument();
  expect(screen.getByText('Safety checks')).toBeInTheDocument();
  expect(screen.getByText('Contact Requires Medical Clearance')).toBeInTheDocument();
  expect(screen.getByText('Needs a look')).toBeInTheDocument();
});

test('a failed load shows the error state, never a false empty state', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'Database unavailable' }, false)) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('Database unavailable');
  expect(screen.queryByText('No linked children found')).not.toBeInTheDocument();
});
