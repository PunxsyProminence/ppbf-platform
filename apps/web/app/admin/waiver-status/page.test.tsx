/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';

import WaiverComplianceAuditPage from './page';

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

const INCOMPLETE = [
  {
    athlete_id: 'ath-1',
    athlete_name: 'Jordan T.',
    active_flag: true,
    waivers: { general: 'signed', medical_release: 'missing', photo_media: 'signed', travel: 'missing' },
  },
];

const COMPLETE = [
  {
    athlete_id: 'ath-2',
    athlete_name: 'Sam R.',
    active_flag: true,
    waivers: { general: 'signed', medical_release: 'signed', photo_media: 'signed', travel: 'signed' },
  },
];

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

test('the default view shows athletes with a missing waiver', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: INCOMPLETE })) as unknown as typeof fetch;

  render(<WaiverComplianceAuditPage />);

  await screen.findByText('Jordan T.');
  expect(screen.getAllByText('Missing').length).toBeGreaterThan(0);
});

test('an athlete with every tracked waiver signed is excluded from the default (incomplete) filter', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: COMPLETE })) as unknown as typeof fetch;

  render(<WaiverComplianceAuditPage />);

  await screen.findByText('Nothing in this view');
  expect(screen.queryByText('Sam R.')).not.toBeInTheDocument();
});

test('switching to "All signed" shows the fully-compliant athlete', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: COMPLETE })) as unknown as typeof fetch;

  render(<WaiverComplianceAuditPage />);
  await screen.findByText('Nothing in this view');

  fireEvent.click(screen.getByRole('button', { name: 'All signed' }));

  await screen.findByText('Sam R.');
});

test('switching to "All athletes" shows both complete and incomplete rows together', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: [...INCOMPLETE, ...COMPLETE] })) as unknown as typeof fetch;

  render(<WaiverComplianceAuditPage />);
  await screen.findByText('Jordan T.');

  fireEvent.click(screen.getByRole('button', { name: 'All athletes' }));

  await screen.findByText('Sam R.');
  expect(screen.getByText('Jordan T.')).toBeInTheDocument();
});

test('unchecking "Active athletes only" includes an inactive athlete', async () => {
  const inactive = [{ ...INCOMPLETE[0], athlete_id: 'ath-3', athlete_name: 'Retired R.', active_flag: false }];
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: inactive })) as unknown as typeof fetch;

  render(<WaiverComplianceAuditPage />);
  await screen.findByText('Nothing in this view');

  fireEvent.click(screen.getByRole('checkbox', { name: /Active athletes only/ }));

  await screen.findByText('Retired R.');
});

test('a declined waiver renders distinctly from a missing one', async () => {
  const declined = [{ ...INCOMPLETE[0], waivers: { ...INCOMPLETE[0].waivers, medical_release: 'declined' } }];
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: declined })) as unknown as typeof fetch;

  render(<WaiverComplianceAuditPage />);

  await screen.findByText('Declined');
});

test('no athletes at all renders the empty state', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: [] })) as unknown as typeof fetch;

  render(<WaiverComplianceAuditPage />);

  await screen.findByText('Nothing in this view');
});

test('a failed load shows the error state, never a false empty state', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'Database unavailable' }, false)) as unknown as typeof fetch;

  render(<WaiverComplianceAuditPage />);

  await screen.findByText('Database unavailable');
  expect(screen.queryByText('Nothing in this view')).not.toBeInTheDocument();
});


test('a failed read is not stamped as a medical emergency', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'Database unavailable' }, false)) as unknown as typeof fetch;

  render(<WaiverComplianceAuditPage />);

  // Room DNA: --locked red is what this room says when a clinician or a
  // safeguarding decision has stopped something. A read that failed is a
  // network fact. Law 3 keeps the glyph and the uppercase label doing the
  // work colour must never do alone.
  const alert = await screen.findByRole('alert');
  expect(alert.className).toContain('alert--warning');
  expect(alert.className).not.toContain('alert--critical');
  expect(within(alert).getByText('Attention')).toBeTruthy();
});

// LANE N4-01, OD-2026-10-08-006 A-Q19 ("Build one answer"): one cleared-tonight
// answer per athlete. "Why" lists what the answer rests on (the hold and the
// medical clearance); "Also on file" lists what never changes it.
function tonight(overrides: Record<string, unknown> = {}) {
  return {
    answer: 'cleared',
    hold: null,
    medical: { status: 'cleared', current: true, expires_at: null },
    waivers: [
      { type: 'general', status: 'signed', recorded_on: '2026-09-02' },
      { type: 'medical_release', status: 'missing', recorded_on: null },
      { type: 'travel', status: 'declined', recorded_on: '2026-09-05' },
    ],
    media_consent: { basis: 'guardian', status: 'signed' },
    open_violations: 0,
    ...overrides,
  };
}

async function renderRow(row: Record<string, unknown>) {
  global.fetch = jest.fn().mockResolvedValue(
    jsonResponse({ ok: true, items: [{ ...INCOMPLETE[0], ...row }] }),
  ) as unknown as typeof fetch;
  render(<WaiverComplianceAuditPage />);
  const name = await screen.findByText('Jordan T.');
  return name.closest('tr') as HTMLElement;
}

function answerBadge(row: HTMLElement, label: string): HTMLElement {
  const badge = within(row).getAllByText(label).find((node) => node.className.includes('badge'));
  expect(badge).toBeTruthy();
  return badge as HTMLElement;
}

/** The statements in one of the two groups under the disclosure. */
function linesUnder(row: HTMLElement, group: 'Why' | 'Also on file'): Array<string | null> {
  const list = within(row).getByRole('list', { name: group });
  return within(list).getAllByRole('listitem').map((item) => item.textContent);
}

test('each athlete shows one cleared-tonight answer, with glyph and label', async () => {
  const row = await renderRow({ tonight: tonight() });

  expect(screen.getByRole('columnheader', { name: 'Tonight' })).toBeInTheDocument();
  const badge = answerBadge(row, 'Cleared');
  expect(badge.className).toContain('badge--cleared');
  expect(badge.textContent).toContain('✓');
});

test.each([
  ['cleared_to_train', 'Cleared to train', 'badge--cleared'],
  ['cleared_no_contact', 'Cleared, no contact', 'badge--monitor'],
  ['not_cleared', 'Not cleared', 'badge--locked'],
  // Not "Unavailable": under a column headed Tonight that reads as the athlete
  // being away. The label says what happened to the read.
  ['unavailable', 'Could not be read', 'badge--restricted'],
])('the answer %s reads "%s"', async (answer, label, rung) => {
  const row = await renderRow({ tonight: tonight({ answer }) });

  expect(answerBadge(row, label).className).toContain(rung);
  // Exactly one answer per athlete.
  expect(row.querySelectorAll('td:nth-child(2) .badge')).toHaveLength(1);
});

// REVIEW FINDING (PR #1457): one list under "Why" put a missing paper and the
// open violations beside the hold, so they read as part of why an athlete was
// not cleared. By ruling they never are. Two groups, and each record in one.
test('Why lists only what the answer rests on; papers, consent and violations sit apart under Also on file', async () => {
  const row = await renderRow({
    tonight: tonight({
      answer: 'not_cleared',
      hold: { scope: 'all_training', athlete_explanation: 'Rest this week.', lift_condition_text: 'A note from your doctor.', expires_at: null },
      open_violations: 2,
    }),
  });

  expect(linesUnder(row, 'Why')).toEqual([
    'Training hold: all training paused. Rest this week. What earns the lift: A note from your doctor.',
    'Medical clearance: cleared.',
  ]);
  expect(linesUnder(row, 'Also on file')).toEqual([
    'General waiver: signed Sep 2, 2026.',
    'Medical release: none on file.',
    'Travel waiver: declined Sep 5, 2026.',
    'Photo and media consent: signed by every guardian.',
    'Open compliance violations: 2.',
  ]);
  // The heading that separates them is on the screen, inside the disclosure.
  const heading = within(row).getByText('Also on file');
  expect(heading.closest('details')).not.toBeNull();
});

// Owner rule (Jason, 2026-10-11: "Blocking and flagging stuff can cause more
// damage then knowledge"): a paper that is not on file is stated, not alarmed.
test('a paper that is not on file is a plain statement: no badge, no alert, no glyph', async () => {
  const row = await renderRow({ tonight: tonight() });

  const disclosure = within(row).getByText('Why').closest('details') as HTMLElement;
  expect(disclosure.querySelector('.badge')).toBeNull();
  expect(disclosure.querySelector('.alert')).toBeNull();
  expect(disclosure.querySelector('[role="alert"]')).toBeNull();
  expect(disclosure.textContent).not.toMatch(/[▲✕⚠]/);
  expect(linesUnder(row, 'Also on file')).toContain('Medical release: none on file.');
  // ...and it does not move the answer.
  expect(answerBadge(row, 'Cleared')).toBeTruthy();
});

test('with nothing open, the violation line says none', async () => {
  const row = await renderRow({ tonight: tonight() });

  expect(linesUnder(row, 'Also on file')).toContain('Open compliance violations: none.');
  expect(linesUnder(row, 'Why')).toEqual(['Training hold: none active.', 'Medical clearance: cleared.']);
});

test('a hold with an end date states the day', async () => {
  const row = await renderRow({
    tonight: tonight({
      answer: 'cleared_no_contact',
      hold: { scope: 'contact_only', athlete_explanation: 'No sparring.', lift_condition_text: '', expires_at: '2026-10-20T16:00:00.000Z' },
    }),
  });

  expect(linesUnder(row, 'Why')[0]).toBe('Training hold: no contact, until Oct 20, 2026. No sparring.');
});

// The one scope nothing in the app enforces (trainingHolds.ts). The answer is
// Cleared, so the line beneath it has to say why a hold is on record there.
test('a conditioning-only hold says the app does not act on that scope', async () => {
  const row = await renderRow({
    tonight: tonight({
      hold: { scope: 'conditioning_only', athlete_explanation: 'Light work only.', lift_condition_text: '', expires_at: null },
    }),
  });

  expect(linesUnder(row, 'Why')[0]).toBe(
    'Training hold: conditioning only, recorded; the app does not act on this scope. Light work only.',
  );
});

// Overwatch's ruling for an athlete with no clearance in force and no hold:
// nobody decided "no contact" about them, so the screen does not say it. The
// answer is "Cleared to train", at the weight of plain "Cleared", with the
// contact clearance stated beside it as what is on file.
test.each([
  ['no_record', null, 'Contact clearance: none on file.'],
  ['pending', null, 'Contact clearance: pending.'],
  ['cleared_expired', '2026-09-30T16:00:00.000Z', 'Contact clearance: expired Sep 30, 2026.'],
])('cleared to train with a %s medical record states the contact clearance as a fact', async (status, expiresAt, line) => {
  const row = await renderRow({
    tonight: tonight({ answer: 'cleared_to_train', medical: { status, current: false, expires_at: expiresAt } }),
  });

  const badge = answerBadge(row, 'Cleared to train');
  // Same visual weight as plain "Cleared": no alarm rung, no alarm glyph.
  expect(badge.className).toContain('badge--cleared');
  expect(badge.textContent).toContain('✓');
  // Stated beside the answer, not hidden in the disclosure, and as plain text.
  const fact = within(row).getByText(line);
  expect(fact.closest('details')).toBeNull();
  expect(fact.className).not.toContain('badge');
  expect(fact.closest('[role="alert"]')).toBeNull();
  expect(row.textContent).not.toMatch(/no contact/i);
});

test('only "Cleared to train" carries the contact clearance line', async () => {
  const row = await renderRow({
    tonight: tonight({ answer: 'cleared_no_contact', medical: { status: 'restricted', current: false, expires_at: null } }),
  });

  expect(within(row).queryByText(/^Contact clearance:/)).toBeNull();
  // The record's own word, under Why.
  expect(linesUnder(row, 'Why')).toContain('Medical clearance: restricted.');
});

test('a clearance in force is stated with the day it runs to', async () => {
  const row = await renderRow({
    tonight: tonight({ medical: { status: 'cleared', current: true, expires_at: '2026-12-01T17:00:00.000Z' } }),
  });

  expect(linesUnder(row, 'Why')).toContain('Medical clearance: cleared until Dec 1, 2026.');
});

// The consent check behind this line asks every linked guardian and does not
// ask whether video is covered. So it is "media", never "video", and each word
// says whose answer it is: "none on file" would be false when one of two
// guardians has signed.
test.each([
  ['signed', 'Photo and media consent: signed by every guardian.'],
  ['missing', 'Photo and media consent: not on file from every guardian.'],
  ['withdrawn', 'Photo and media consent: withdrawn by a guardian.'],
  ['declined', 'Photo and media consent: declined by a guardian.'],
])('guardian media consent that reads %s is stated as whose answer it is', async (status, line) => {
  const row = await renderRow({ tonight: tonight({ media_consent: { basis: 'guardian', status } }) });

  expect(linesUnder(row, 'Also on file')).toContain(line);
  expect(row.textContent).not.toMatch(/video consent/i);
});

test('an adult athlete: the media line says whose consent it is, not a guardian’s status', async () => {
  const row = await renderRow({ tonight: tonight({ media_consent: { basis: 'adult_own_consent' } }) });

  const media = linesUnder(row, 'Also on file').find((line) => (line ?? '').startsWith('Photo and media consent:'));
  expect(media).toMatch(/the athlete is 18 or over/);
  expect(media).not.toMatch(/signed by every guardian/);
});

test('a source that could not be read says so in its own line', async () => {
  const row = await renderRow({
    tonight: tonight({ answer: 'unavailable', hold: 'unavailable', medical: 'unavailable', open_violations: 'unavailable' }),
  });

  expect(answerBadge(row, 'Could not be read')).toBeTruthy();
  expect(linesUnder(row, 'Why')).toEqual(['Training hold: could not be read.', 'Medical clearance: could not be read.']);
  expect(linesUnder(row, 'Also on file')).toContain('Open compliance violations: could not be read.');
});

// A row that arrives with no answer at all must not read as cleared.
test('a row sent without an answer is not shown as cleared', async () => {
  const row = await renderRow({});

  expect(answerBadge(row, 'Could not be read')).toBeTruthy();
  expect(within(row).queryByText('Cleared')).toBeNull();
  expect(within(row).queryByText('Why')).toBeNull();
});

test('the waiver columns are unchanged by the answer beside them', async () => {
  const row = await renderRow({ tonight: tonight({ answer: 'not_cleared' }) });

  // general signed, medical_release missing, photo_media signed, travel missing
  const cells = Array.from(row.querySelectorAll('td')).slice(2).map((cell) => cell.textContent);
  expect(cells).toEqual(['✓Signed', '▲Missing', '✓Signed', '▲Missing']);
});

// REVIEW FINDING (PR #1457): the compliance centre's "Cleared tonight" link
// landed on the worklist's default, "Missing a waiver". An athlete on a hold
// whose papers are all signed was not in that view, and with every paper in
// the gym signed the screen read "Nothing in this view".
describe('opened from the compliance centre (?view=all)', () => {
  const HELD = {
    ...COMPLETE[0],
    athlete_name: 'Held Kid',
    tonight: tonight({
      answer: 'not_cleared',
      hold: { scope: 'all_training', athlete_explanation: 'Rest.', lift_condition_text: '', expires_at: null },
    }),
  };

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  test('every athlete is shown, so a held athlete with every paper signed is on the screen', async () => {
    window.history.replaceState(null, '', '/admin/waiver-status?view=all');
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: [HELD] })) as unknown as typeof fetch;

    render(<WaiverComplianceAuditPage />);

    const row = (await screen.findByText('Held Kid')).closest('tr') as HTMLElement;
    expect(answerBadge(row, 'Not cleared')).toBeTruthy();
    expect(screen.queryByText('Nothing in this view')).not.toBeInTheDocument();
  });

  test('without it the worklist still opens on its own default', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: [HELD] })) as unknown as typeof fetch;

    render(<WaiverComplianceAuditPage />);

    await screen.findByText('Nothing in this view');
    expect(screen.queryByText('Held Kid')).not.toBeInTheDocument();
  });
});
