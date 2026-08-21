/**
 * @jest-environment jsdom
 */

// The workout-template catalog: the first UI consumer of the read-only
// GET /api/pilot/workout-templates route. What these pin: the page sits
// behind the coach gate; the list renders from `templates`, the key the
// route actually sends; opening a template shows its ordered items; an
// empty catalog is honest about being empty; a failed read admits templates
// may exist; and nothing on the page ever issues a write.

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';

import CoachWorkoutTemplatesPage from './page';
import type { ClubRole } from '@/components/roleRoutes';

const capturedRoles: ClubRole[][] = [];

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ allowedRoles, children }: { readonly allowedRoles: ClubRole[]; readonly children: ReactNode }) => {
    capturedRoles.push(allowedRoles);
    return children;
  },
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const BOXING_FUNDAMENTALS = {
  organization_id: 'org-1',
  template_id: 'wt-1',
  lineage_id: 'lin-1',
  version: 1,
  supersedes_template_id: null,
  superseded_at: null,
  name: 'Boxing Fundamentals 60',
  session_type: 'group_class',
  difficulty: 'beginner',
  age_band: '11-14',
  duration_minutes: 60,
  intent: 'Stance, guard, and the first two punches.',
  coach_notes: 'Keep the room moving between blocks.',
  requires_coach_authorization: false,
  active: true,
  created_by_account_id: null,
  created_by_role: null,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
};

const CONDITIONING_ADV = {
  ...BOXING_FUNDAMENTALS,
  template_id: 'wt-2',
  lineage_id: 'lin-2',
  name: 'Conditioning Circuit 45',
  session_type: 'conditioning',
  difficulty: 'advanced',
  duration_minutes: 45,
  intent: 'Engine work under fatigue.',
};

function item(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    item_id: 'wti-1',
    template_id: 'wt-1',
    ordinal: 1,
    block: 'warmup',
    drill_id: null,
    free_text_drill: 'Rope intervals',
    scale_level: 'B',
    duration_minutes: 10,
    rep_count: null,
    contact_level: 'none',
    coach_note: 'Feet quiet, breathing loud.',
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  capturedRoles.length = 0;
  jest.clearAllMocks();
});

describe('coach workout templates page', () => {
  it('sits behind the coach gate, matching the session-scripts page', async () => {
    mockFetch(() => jsonResponse({ templates: [] }));

    render(<CoachWorkoutTemplatesPage />);
    await screen.findByText(/No workout templates are loaded/i);

    expect(capturedRoles[0]).toEqual(['coach', 'admin']);
  });

  it('lists the templates returned by the route', async () => {
    mockFetch(() => jsonResponse({ templates: [BOXING_FUNDAMENTALS, CONDITIONING_ADV] }));

    render(<CoachWorkoutTemplatesPage />);

    expect(await screen.findByText('Boxing Fundamentals 60')).toBeInTheDocument();
    expect(screen.getByText('Conditioning Circuit 45')).toBeInTheDocument();
    expect(screen.getByText(/Engine work under fatigue/)).toBeInTheDocument();
  });

  it('reads the list from `templates`, the key the route actually sends', async () => {
    // The drill library shipped broken for exactly this reason: the page read
    // a key the route never sent, so it rendered empty while tests passed.
    mockFetch(() => jsonResponse({ items: [BOXING_FUNDAMENTALS] }));

    render(<CoachWorkoutTemplatesPage />);

    expect(await screen.findByText(/No workout templates are loaded/i)).toBeInTheDocument();
  });

  it('opening a template shows its items from the detail read', async () => {
    mockFetch((url) => (url.includes('template_id')
      ? jsonResponse({ template: BOXING_FUNDAMENTALS, items: [item()] })
      : jsonResponse({ templates: [BOXING_FUNDAMENTALS] })));

    render(<CoachWorkoutTemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open template/i }));

    expect(await screen.findByText('Rope intervals')).toBeInTheDocument();
    expect(screen.getByText('warmup')).toBeInTheDocument();
    expect(screen.getByText('10 min')).toBeInTheDocument();
    expect(screen.getByText('Scale B')).toBeInTheDocument();
    expect(screen.getByText(/Feet quiet, breathing loud/)).toBeInTheDocument();
    expect(screen.getByText(/Keep the room moving between blocks/)).toBeInTheDocument();
  });

  it('an empty catalog says so honestly', async () => {
    mockFetch(() => jsonResponse({ templates: [] }));

    render(<CoachWorkoutTemplatesPage />);

    expect(await screen.findByText('No workout templates are loaded in this environment yet.')).toBeInTheDocument();
  });

  it('distinguishes a failed load from an empty catalog', async () => {
    mockFetch(() => jsonResponse({}, false));

    render(<CoachWorkoutTemplatesPage />);

    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByText(/not an empty catalog/i)).toBeInTheDocument();
    expect(screen.queryByText(/No workout templates are loaded/i)).not.toBeInTheDocument();
  });

  it('a failed detail read is its own alert, not silently empty items', async () => {
    mockFetch((url) => (url.includes('template_id')
      ? jsonResponse({}, false)
      : jsonResponse({ templates: [BOXING_FUNDAMENTALS] })));

    render(<CoachWorkoutTemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open template/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be opened/i);
  });

  it('never issues a write -- the route is read-only by design and so is the page', async () => {
    const fetchMock = mockFetch((url) => (url.includes('template_id')
      ? jsonResponse({ template: BOXING_FUNDAMENTALS, items: [item()] })
      : jsonResponse({ templates: [BOXING_FUNDAMENTALS] })));

    render(<CoachWorkoutTemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open template/i }));
    await screen.findByText('Rope intervals');

    const writes = fetchMock.mock.calls.filter((call) => {
      const method = ((call[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
      return method !== 'GET';
    });
    expect(writes).toHaveLength(0);
  });
});
