/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import CoachDrillLibraryPage from './page';

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

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

const authored = {
  drill_id: 'authored-1',
  name: 'Corner exit',
  category: 'Footwork',
  focus: 'Leave the ropes safely.',
  difficulty: 'beginner',
  cues: ['Turn first'],
};

const reference = {
  drill_id: 'reference-1',
  name: 'Seeded jab return',
  discipline: 'boxing',
  category: 'striking',
  difficulty: 'fundamentals',
  purpose: 'Return the hand to guard.',
  standard_setup: 'Partners at technical distance.',
  requires_coach_authorization: true,
};

beforeEach(() => {
  jest.clearAllMocks();
});

it('shows seeded reference drills separately from assignable gym-authored drills', async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => String(input).endsWith('/drill-library')
    ? jsonResponse({ drills: [reference] })
    : jsonResponse({ items: [authored] })) as unknown as typeof fetch;

  render(<CoachDrillLibraryPage />);

  expect(await screen.findByText('Seeded jab return')).toBeInTheDocument();
  expect(screen.getByText('Corner exit')).toBeInTheDocument();
  // The reference SOURCE is read-only; a coach may still promote a copy of it
  // into the gym's own drills (OD-2026-09-16-001). This assertion tracked the
  // earlier copy, which said reference drills were read-only full stop.
  expect(screen.getByText(/reference source stays read-only/i)).toBeInTheDocument();
  expect(screen.getByText(/does not assign the drill to any athlete/i)).toBeInTheDocument();
  expect(screen.getByText('Coach authorization required')).toBeInTheDocument();
});

it('keeps drill creation on the assignable gym-authored endpoint', async () => {
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') return jsonResponse({ item: authored }, true, 201);
    return url.endsWith('/drill-library')
      ? jsonResponse({ drills: [reference] })
      : jsonResponse({ items: [authored] });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<CoachDrillLibraryPage />);
  await screen.findByText('Seeded jab return');

  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Slip line' } });
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Defense' } });
  fireEvent.change(screen.getByLabelText('What it is for'), { target: { value: 'Head movement' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add drill' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/pilot/drills', expect.objectContaining({ method: 'POST' })));
  expect(fetchMock).not.toHaveBeenCalledWith('/api/pilot/drill-library', expect.objectContaining({ method: 'POST' }));
});

it('reports a malformed successful response instead of calling it empty', async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => String(input).endsWith('/drill-library')
    ? jsonResponse({ items: [] })
    : jsonResponse({ items: [] })) as unknown as typeof fetch;

  render(<CoachDrillLibraryPage />);

  expect(await screen.findByText(/reference drill library returned an invalid response/i)).toBeInTheDocument();
  expect(screen.getByText(/not an empty reference library/i)).toBeInTheDocument();
});

it('lets the gym-authored library load even when the reference endpoint fails', async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => String(input).endsWith('/drill-library')
    ? jsonResponse({}, false, 500)
    : jsonResponse({ items: [authored] })) as unknown as typeof fetch;

  render(<CoachDrillLibraryPage />);

  expect(await screen.findByText('Corner exit')).toBeInTheDocument();
  expect(screen.getByText(/reference drill library could not be loaded/i)).toBeInTheDocument();
});

// Promotion, per OD-2026-09-16-001. The reference library stays read-only AT
// SOURCE: promoting writes a new operational drill and never writes to
// /api/pilot/drill-library. Promoted state is read from the operational drills'
// reference_drill_id, never inferred from a matching name -- two drills can
// share a name for reasons that have nothing to do with promotion.
const promoted = {
  drill_id: 'authored-2',
  reference_drill_id: 'reference-1',
  name: 'Seeded jab return',
  category: 'striking',
  focus: 'Return the hand to guard.',
  difficulty: 'intermediate',
  cues: ['Hand home first'],
};

function libraryRoutes(operational: unknown[]) {
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/drills/promote')) {
      return jsonResponse({ ok: true, drill: promoted }, true, 201);
    }
    if (url.endsWith('/drill-library')) {
      return jsonResponse({ drills: [reference] });
    }
    return jsonResponse({ items: operational });
  };
}

it('offers Promote on a reference drill this gym has not promoted', async () => {
  global.fetch = jest.fn(libraryRoutes([authored])) as unknown as typeof fetch;

  render(<CoachDrillLibraryPage />);

  expect(await screen.findByText('Seeded jab return')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Promote' })).toBeEnabled();
  expect(screen.queryByText('Already promoted')).not.toBeInTheDocument();
});

it('promotes through the promote endpoint with the reference id and never writes to the reference library', async () => {
  let operational: unknown[] = [authored];
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // Only a POST promotes. A GET to this path would be a different bug, and the
    // stub should not quietly satisfy it.
    if (url.endsWith('/drills/promote') && init?.method === 'POST') {
      operational = [authored, promoted];
      return jsonResponse({ ok: true, drill: promoted }, true, 201);
    }
    if (url.endsWith('/drill-library')) return jsonResponse({ drills: [reference] });
    return jsonResponse({ items: operational });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<CoachDrillLibraryPage />);
  await screen.findByText('Seeded jab return');

  fireEvent.click(screen.getByRole('button', { name: 'Promote' }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pilot/drills/promote',
      expect.objectContaining({ method: 'POST' }),
    ),
  );

  const promoteCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/drills/promote'));
  expect(JSON.parse(String((promoteCall?.[1] as RequestInit).body))).toEqual({
    reference_drill_id: 'reference-1',
  });
  expect(fetchMock).not.toHaveBeenCalledWith(
    '/api/pilot/drill-library',
    expect.objectContaining({ method: 'POST' }),
  );

  // The authoritative server state is what turns the control off, not local
  // optimism: the reload is where "Already promoted" comes from.
  expect(await screen.findByText('Already promoted')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Promote' })).not.toBeInTheDocument();
});

it('shows a reference drill as already promoted when an operational drill points at it', async () => {
  global.fetch = jest.fn(libraryRoutes([authored, promoted])) as unknown as typeof fetch;

  render(<CoachDrillLibraryPage />);

  // The promoted operational drill keeps the reference drill's name, so the name
  // appears in both sections. What distinguishes them is the pointer, which is
  // what this case is about.
  expect(await screen.findAllByText('Seeded jab return')).toHaveLength(2);
  expect(screen.getByText('Already promoted')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Promote' })).not.toBeInTheDocument();
});

it('shows a retired promotion as already promoted, because the reference is still reserved', async () => {
  // A retired promoted drill is omitted from the ordinary active read, but
  // pilot_drills_one_reference_per_org still holds its reference: offering
  // Promote there would guarantee a 409. Promotion state therefore comes from a
  // read that includes retired rows.
  const retired = { ...promoted, drill_id: 'authored-retired', active: false };
  const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/drill-library')) return jsonResponse({ drills: [reference] });
    if (url.includes('include_retired=true')) return jsonResponse({ items: [authored, retired] });
    return jsonResponse({ items: [authored] });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<CoachDrillLibraryPage />);

  expect(await screen.findByText('Already promoted')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Promote' })).not.toBeInTheDocument();

  // And the retired drill must not have been smuggled into the active list to
  // get that answer: the gym-authored section still shows only the active drill.
  expect(screen.getByText('Corner exit')).toBeInTheDocument();
  expect(screen.queryAllByText('Seeded jab return')).toHaveLength(1);
});

it('does not treat a same-named gym-authored drill as a promotion', async () => {
  // Name equality is not provenance. Without the pointer this drill is just a
  // gym drill that happens to share a name, and the reference is unpromoted.
  const sameName = { ...authored, drill_id: 'authored-3', name: 'Seeded jab return' };
  global.fetch = jest.fn(libraryRoutes([sameName])) as unknown as typeof fetch;

  render(<CoachDrillLibraryPage />);

  await screen.findByRole('button', { name: 'Promote' });
  expect(screen.queryByText('Already promoted')).not.toBeInTheDocument();
});

it('reports a failed promotion as a promotion failure, not as an empty library', async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/drills/promote')) {
      return jsonResponse({ error: 'This reference drill has already been promoted.' }, false, 409);
    }
    if (url.endsWith('/drill-library')) return jsonResponse({ drills: [reference] });
    return jsonResponse({ items: [authored] });
  }) as unknown as typeof fetch;

  render(<CoachDrillLibraryPage />);
  await screen.findByText('Seeded jab return');

  fireEvent.click(screen.getByRole('button', { name: 'Promote' }));

  expect(await screen.findByText(/already been promoted/i)).toBeInTheDocument();
  expect(screen.getByText('Seeded jab return')).toBeInTheDocument();
  expect(screen.queryByText('No reference drills are available.')).not.toBeInTheDocument();
});
