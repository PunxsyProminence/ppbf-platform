/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';

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
      { gate_key: 'mouthguard_on_file', name: 'Mouthguard On File', category: 'equipment', outcome: 'flagged' as const, evaluated_at: '2026-08-01T00:00:00.000Z' },
    ],
  },
];

const CLEAR_ATHLETE = [
  {
    athlete_id: 'ath-2',
    athlete_name: 'Sam R.',
    hold: null,
    gates: [
      { gate_key: 'mouthguard_on_file', name: 'Mouthguard On File', category: 'equipment', outcome: 'passed' as const, evaluated_at: '2026-08-01T00:00:00.000Z' },
    ],
  },
];

const originalFetch = global.fetch;

/** The badge on the Safety checks row named `name`. */
function badgeIn(name: string): HTMLElement {
  const row = screen.getByText(name).parentElement;
  const badge = row?.querySelector('.badge');
  if (!(badge instanceof HTMLElement)) throw new Error(`no badge on the ${name} row`);
  return badge;
}

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

  await screen.findByText('Mouthguard On File');
  expect(badgeIn('Mouthguard On File')).toHaveTextContent('✓Clear');
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

/* ---------------------------------------------------------- safety checks --
   #1537: with a hold shown at the top of the page, the list under it read
   "Active Training Hold: NOT YET CHECKED" and "Contact Requires Medical
   Clearance: NOT YET CHECKED". A gate's last evaluation is an event (a class
   registration, a logged contact), not the child's state. */

const NEVER_EVALUATED_GATES = [
  { gate_key: 'contact_medical_clearance', name: 'Contact Requires Medical Clearance', category: 'medical', outcome: 'not_evaluated' as const, evaluated_at: null },
  { gate_key: 'training_hold', name: 'Active Training Hold', category: 'training_level', outcome: 'not_evaluated' as const, evaluated_at: null },
];


test('an active hold reads Paused on the hold row, and nothing reads Not yet checked', async () => {
  global.fetch = jest.fn().mockResolvedValue(
    jsonResponse({ ok: true, items: [{ ...HELD_ATHLETE[0], gates: NEVER_EVALUATED_GATES }] }),
  ) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('Training is paused right now');
  expect(badgeIn('Active Training Hold')).toHaveTextContent('▲Paused');
  expect(badgeIn('Active Training Hold')).toHaveClass('badge--restricted');
  expect(screen.queryByText('Not yet checked')).not.toBeInTheDocument();
});

test('no hold reads No pause on the hold row, whatever the gate last recorded', async () => {
  global.fetch = jest.fn().mockResolvedValue(
    jsonResponse({
      ok: true,
      items: [{
        ...CLEAR_ATHLETE[0],
        gates: [{ gate_key: 'training_hold', name: 'Active Training Hold', category: 'training_level', outcome: 'blocked' as const, evaluated_at: '2026-08-01T00:00:00.000Z' }],
      }],
    }),
  ) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('No training pause on file right now.');
  expect(badgeIn('Active Training Hold')).toHaveTextContent('✓No pause');
  expect(badgeIn('Active Training Hold')).toHaveClass('badge--cleared');
  expect(screen.queryByText('Not clear')).not.toBeInTheDocument();
});

test('a clearance gate never evaluated is left out, since a guardian is not sent medical clearance', async () => {
  global.fetch = jest.fn().mockResolvedValue(
    jsonResponse({ ok: true, items: [{ ...CLEAR_ATHLETE[0], gates: NEVER_EVALUATED_GATES }] }),
  ) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('Active Training Hold');
  expect(screen.queryByText('Contact Requires Medical Clearance')).not.toBeInTheDocument();
});

test('a clearance gate is left out even when evaluated: its last outcome is not clearance on file now', async () => {
  global.fetch = jest.fn().mockResolvedValue(
    jsonResponse({
      ok: true,
      items: [{
        ...CLEAR_ATHLETE[0],
        gates: [
          { gate_key: 'contact_medical_clearance', name: 'Contact Requires Medical Clearance', category: 'medical', outcome: 'passed' as const, evaluated_at: '2026-08-01T00:00:00.000Z' },
          NEVER_EVALUATED_GATES[1],
        ],
      }],
    }),
  ) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('Active Training Hold');
  expect(screen.queryByText('Contact Requires Medical Clearance')).not.toBeInTheDocument();
  expect(screen.queryByText(/Clear$/)).not.toBeInTheDocument();
});

test('a scoped hold names its scope on the hold row, as the heading above does', async () => {
  for (const [scope, label, heading] of [
    ['contact_only', 'Contact paused', 'Contact work is paused right now'],
    ['conditioning_only', 'Conditioning paused', 'Conditioning is paused right now'],
  ] as const) {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({ ok: true, items: [{ ...HELD_ATHLETE[0], hold: { ...HELD_ATHLETE[0].hold, scope }, gates: NEVER_EVALUATED_GATES }] }),
    ) as unknown as typeof fetch;

    const { unmount } = render(<GuardianSafetyPage />);

    await screen.findByText(heading);
    expect(badgeIn('Active Training Hold')).toHaveTextContent(`▲${label}`);
    unmount();
  }
});

test('an evaluated gate the page can answer stays listed beside the hold row', async () => {
  global.fetch = jest.fn().mockResolvedValue(
    jsonResponse({ ok: true, items: [{ ...HELD_ATHLETE[0], gates: [...HELD_ATHLETE[0].gates, NEVER_EVALUATED_GATES[1]] }] }),
  ) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('Training is paused right now');
  expect(badgeIn('Active Training Hold')).toHaveTextContent('▲Paused');
  expect(badgeIn('Mouthguard On File')).toHaveTextContent('▲Needs a look');
});

test('any other gate never evaluated is left out rather than read as Not yet checked', async () => {
  global.fetch = jest.fn().mockResolvedValue(
    jsonResponse({
      ok: true,
      items: [{
        ...CLEAR_ATHLETE[0],
        gates: [
          { gate_key: 'mouthguard_on_file', name: 'Mouthguard On File', category: 'equipment', outcome: 'not_evaluated' as const, evaluated_at: null },
          NEVER_EVALUATED_GATES[1],
        ],
      }],
    }),
  ) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('Active Training Hold');
  expect(screen.queryByText('Mouthguard On File')).not.toBeInTheDocument();
});

test('the hold row is shown even when the response sends no training-hold gate', async () => {
  global.fetch = jest.fn().mockResolvedValue(
    jsonResponse({ ok: true, items: [{ ...HELD_ATHLETE[0], gates: [] }] }),
  ) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('Training is paused right now');
  expect(badgeIn('Active Training Hold')).toHaveTextContent('▲Paused');
});

/* ---------------------------------------------------------------- waivers --
 * Owner decision 2026-09-29 (Q4 A): show the guardian the waiver statuses the
 * route has returned since #799. Only the guardian can sign the travel waiver
 * the competition gate reads, so a status that reads wrong here is worse than
 * none: missing must read Not on file, with what to do about it (F-065), and
 * anything the page does not recognise must read Unknown -- never Signed. */

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
  expect(within(travel).getByText('Not on file')).toBeInTheDocument();
});

test('photo_only reads Photos only as a restricted badge, never Signed', async () => {
  // audit CL-B11: the route reports photo_only when every guardian signed
  // and one limited it to photos; the video gates refuse, so it must not
  // show as cleared.
  const article = await renderCard(
    athleteWith({ general: 'signed', medical_release: 'signed', photo_media: 'photo_only', travel: 'signed' }),
  );

  const photo = waiverRow(article, 'photo_media');
  expect(within(photo).getByText('Photos only')).toBeInTheDocument();
  expect(within(photo).getByText('▲')).toBeInTheDocument();
  expect(within(photo).getByText('Photos only').closest('.badge')).toHaveClass('badge--restricted');
  expect(within(photo).queryByText('Signed')).not.toBeInTheDocument();
});

test('a missing waiver reads Not on file, never Signed, with no warning mark (F-065)', async () => {
  const article = await renderCard(
    athleteWith({ general: 'signed', medical_release: 'signed', photo_media: 'signed', travel: 'missing' }),
  );

  const travel = waiverRow(article, 'travel');
  expect(within(travel).getByText('Not on file')).toBeInTheDocument();
  expect(within(travel).queryByText('▲')).not.toBeInTheDocument();
  expect(within(travel).getByText('◌')).toBeInTheDocument();
  expect(within(travel).queryByText('Signed')).not.toBeInTheDocument();
  expect(within(travel).queryByText('✓')).not.toBeInTheDocument();
  const badge = within(travel).getByText('Not on file').closest('.badge');
  expect(badge).not.toHaveClass('badge--cleared');
  expect(badge).not.toHaveClass('badge--restricted');
});

test('a missing waiver says what the family can do about it (F-065)', async () => {
  const article = await renderCard(
    athleteWith({ general: 'missing', medical_release: 'missing', photo_media: 'missing', travel: 'missing' }),
  );

  for (const type of ['general', 'medical_release', 'travel']) {
    expect(
      within(waiverRow(article, type)).getByText('Hand the signed paper form to the gym office, and they record it.'),
    ).toBeInTheDocument();
  }
  expect(
    within(waiverRow(article, 'photo_media')).getByText('Sign it on the Photo & Video Consent page below.'),
  ).toBeInTheDocument();
});

test('a signed or unknown waiver carries no what-to-do line', async () => {
  const article = await renderCard(athleteWith({ general: 'signed', medical_release: 'pending' }));

  expect(within(article).queryByText(/gym office/)).not.toBeInTheDocument();
  expect(within(article).queryByText(/Photo & Video Consent page below/)).not.toBeInTheDocument();
});

test('an unrecognised status reads Unknown, never Signed or Not on file', async () => {
  const article = await renderCard(
    athleteWith({ general: 'pending', medical_release: 'SIGNED', photo_media: 42, travel: null }),
  );

  for (const type of ['general', 'medical_release', 'photo_media', 'travel']) {
    const row = waiverRow(article, type);
    expect(within(row).getByText('Unknown')).toBeInTheDocument();
    expect(within(row).getByText('◌')).toBeInTheDocument();
    expect(within(row).queryByText('Signed')).not.toBeInTheDocument();
    expect(within(row).queryByText('Not on file')).not.toBeInTheDocument();
  }
});

test('a tracked type the response leaves out still gets a row, reading Unknown', async () => {
  const article = await renderCard(athleteWith({ general: 'signed' }));

  expect(within(waiverRow(article, 'general')).getByText('Signed')).toBeInTheDocument();
  for (const type of ['medical_release', 'photo_media', 'travel']) {
    expect(within(waiverRow(article, type)).getByText('Unknown')).toBeInTheDocument();
  }
});

test('no waivers field at all reads Unknown for every tracked type, not Not on file or Signed', async () => {
  const article = await renderCard(athleteWith(undefined));

  for (const type of ['general', 'medical_release', 'photo_media', 'travel']) {
    const row = waiverRow(article, type);
    expect(within(row).getByText('Unknown')).toBeInTheDocument();
  }
  expect(within(article).queryByText('Not on file')).not.toBeInTheDocument();
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
  expect(within(waiverRow(casey, 'travel')).getByText('Not on file')).toBeInTheDocument();
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
  // Jason 2026-09-29 (P3 A): every child reads missing until the gym records
  // these waiver types, so the page says what that means (shown as Not on
  // file since F-065).
  expect(copy).toContain('Not on file means the gym has no signed waiver of that kind yet, and the row says what to do.');
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
  expect(badgeIn('Mouthguard On File')).toHaveTextContent('▲Needs a look');
});

test('a failed load shows the error state, never a false empty state', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'Database unavailable' }, false)) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('Database unavailable');
  expect(screen.queryByText('No linked children found')).not.toBeInTheDocument();
});

// UXB-12: a missing name says so; the athlete id is never shown to a family.
test('a missing name reads "Your child (name not loaded)", never the athlete id', async () => {
  const unnamed = [{ ...CLEAR_ATHLETE[0], athlete_name: null }];
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: unnamed })) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('Your child (name not loaded)');
  expect(screen.queryByText(/ath-2/)).toBeNull();
});

// UXB-13: a failed read offers Check again, which re-reads; while it does,
// the page reads Loading, not the failure.
test('a failed load offers Check again, which reads Loading and then the answer', async () => {
  let answer: (value: Response) => void = () => undefined;
  const fetchMock = jest
    .fn()
    .mockResolvedValueOnce(jsonResponse({ error: 'Database unavailable' }, false))
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }))
    .mockResolvedValue(jsonResponse({ ok: true, items: [] }));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<GuardianSafetyPage />);
  await screen.findByText('Safety status could not be loaded');

  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

  expect(await screen.findByText('Loading…')).toBeInTheDocument();
  expect(screen.queryByText('Safety status could not be loaded')).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);

  answer(jsonResponse({ ok: true, items: CLEAR_ATHLETE }));
  expect(await screen.findByText('Sam R.')).toBeInTheDocument();
  expect(screen.queryByText('Database unavailable')).toBeNull();
});
