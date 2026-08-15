/**
 * @jest-environment jsdom
 */

// A coach reading a gap is the person most likely to want the theory behind it,
// and the one who can write it. These pin that the gap card asks for the two
// vocabulary terms it already names, that the lesson arrives labelled as the
// gym's own coaching rather than as evidence, and that a term nobody has
// written about adds nothing to the surface at all.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import type { RabbitHoleLessonItem } from '@/components/RabbitHole';
import CoachProgressionIntelligencePage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const GAP = {
  gap_id: 'gap-1',
  athlete_id: 'athlete-001',
  gap_type: 'technique',
  gap_description: 'Rear foot stays flat through the cross.',
  severity: 'high',
  status: 'identified',
  created_at: '2026-07-30T12:00:00.000Z',
};

const LESSON: RabbitHoleLessonItem = {
  rabbit_hole_id: 'rh-1',
  title: 'Why the elbow finishes down',
  concept: 'Rotation ends before impact, not at it.',
  homework: null,
  author_display_name: 'Coach Danielle',
  citation: null,
};

let anchorsAsked: string[] = [];

function mockFetch(
  byAnchor: Record<string, RabbitHoleLessonItem[]>,
  gaps = [GAP],
  holds: Array<Record<string, unknown>> = [],
) {
  anchorsAsked = [];
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/progression/gaps')) {
      return { ok: true, json: async () => ({ items: gaps }) } as Response;
    }
    if (url.includes('/progression/assignments')) {
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }
    if (url.includes('/api/pilot/training-holds')) {
      return { ok: true, json: async () => ({ ok: true, holds }) } as Response;
    }
    if (url.includes('/rabbit-holes/get')) {
      const body = JSON.parse(String(init?.body)) as { anchor_type: string; anchor_key: string };
      const anchor = `${body.anchor_type}:${body.anchor_key}`;
      anchorsAsked.push(anchor);
      return { ok: true, json: async () => ({ ok: true, rabbit_holes: byAnchor[anchor] ?? [] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  });
}

async function renderWithAthlete(fetchMock: jest.Mock) {
  global.fetch = fetchMock as unknown as typeof fetch;
  await act(async () => {
    render(<CoachProgressionIntelligencePage />);
  });
  await act(async () => {
    fireEvent.change(screen.getByPlaceholderText(/Enter athlete ID/), {
      target: { value: 'athlete-001' },
    });
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('the gap card asks for the gap type and the severity it names', async () => {
  await renderWithAthlete(mockFetch({}));

  await waitFor(() => expect(anchorsAsked).toContain('gap_type:technique'));
  expect(anchorsAsked).toContain('severity:high');
});

test('a published lesson reads as the gym coaching it is, and carries no evidence tier', async () => {
  await renderWithAthlete(mockFetch({ 'severity:high': [LESSON] }));

  const opener = await screen.findByRole('button', { name: /GO DEEPER \(1 LESSON\)/ });
  fireEvent.click(opener);

  expect(screen.getByText('Why the elbow finishes down')).toBeTruthy();
  expect(screen.getByText(/Rotation ends before impact/)).toBeTruthy();
  expect(screen.getByText(/Gym coaching/)).toBeTruthy();
  expect(screen.getByText(/Written by Coach Danielle/)).toBeTruthy();

  // Not every lesson has something to go and do, and an absent one renders
  // nothing rather than an empty homework box.
  expect(screen.queryByText(/Homework:/)).toBeNull();

  for (const tier of ['PROVEN', 'EMERGING', 'EXPERIMENTAL', 'RESEARCH_NEEDED']) {
    expect(screen.queryByText(tier)).toBeNull();
  }
});

test('a term nobody has written about leaves no expander behind', async () => {
  await renderWithAthlete(mockFetch({}));

  await waitFor(() => expect(anchorsAsked.length).toBeGreaterThan(0));
  expect(screen.queryByText(/GO DEEPER/)).toBeNull();
  expect(screen.getByText('Rear foot stays flat through the cross.')).toBeTruthy();
});

test('the coach can reach the surface where a rabbit hole is written', async () => {
  await renderWithAthlete(mockFetch({}));

  const link = screen.getByRole('link', { name: 'Write a Rabbit Hole' }) as HTMLAnchorElement;
  expect(link.getAttribute('href')).toBe('/rabbit-holes');
});

// Capability #5: an active hold must be visible here, not just on the
// safety pages, so a coach assigning progression work sees the context.
describe('active training hold visibility (#5)', () => {
  test('an athlete under an active hold shows the hold banner with scope and explanation', async () => {
    await renderWithAthlete(mockFetch({}, [GAP], [
      { scope: 'contact_only', reason_category: 'medical', athlete_explanation: 'Waiting on a doctor note before contact resumes.' },
    ]));

    await screen.findByText('Active Training Hold');
    expect(screen.getByText(/CONTACT WORK is currently paused/)).toBeTruthy();
    expect(screen.getByText('Waiting on a doctor note before contact resumes.')).toBeTruthy();
  });

  test('an athlete with no active hold shows no banner', async () => {
    await renderWithAthlete(mockFetch({}, [GAP], []));

    await screen.findByText('Rear foot stays flat through the cross.');
    expect(screen.queryByText('Active Training Hold')).toBeNull();
  });

  test('progression tools remain usable and are not blocked by an active hold -- visibility only', async () => {
    await renderWithAthlete(mockFetch({}, [GAP], [
      { scope: 'all_training', reason_category: 'behavioral', athlete_explanation: 'explanation' },
    ]));

    await screen.findByText('Active Training Hold');
    // The gap the athlete already has is still rendered underneath the banner.
    expect(screen.getByText('Rear foot stays flat through the cross.')).toBeTruthy();
  });

  test('a failed hold fetch shows no banner rather than breaking the page', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/pilot/training-holds')) {
        return { ok: false, json: async () => ({ error: 'Forbidden' }) } as Response;
      }
      if (url.includes('/progression/gaps')) {
        return { ok: true, json: async () => ({ items: [GAP] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    });

    await renderWithAthlete(fetchMock);

    await screen.findByText('Rear foot stays flat through the cross.');
    expect(screen.queryByText('Active Training Hold')).toBeNull();
  });
});

// Deterministic gap suggestions (owner decision 2026-08-15). A suggestion is
// a machine's unconfirmed observation: it must render on the coach's board,
// become a real gap only through the coach's confirm (filed with the rule
// recorded as its detection source), and vanish for the visit on dismiss.
// No suggestions means no section at all -- not an empty frame.
describe('deterministic gap suggestions', () => {
  const SUGGESTION = {
    athlete_id: 'athlete-001',
    full_name: 'Jordan Doe',
    rule: 'readiness_falling',
    gap_type: 'endurance',
    suggested_description: 'Readiness check-ins fell from an average of 7.0 to 5.5 across the recent window.',
    evidence: { readiness_early_avg: 7, readiness_late_avg: 5.5 },
  };

  function mockFetchWithSuggestions(items: Array<Record<string, unknown>>, capture: { gapPosts: unknown[] }) {
    return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/progression/suggestions')) {
        return { ok: true, json: async () => ({ items }) } as Response;
      }
      if (url.includes('/progression/gaps') && init?.method === 'POST') {
        capture.gapPosts.push(JSON.parse(String(init.body)));
        return { ok: true, json: async () => ({ item: {} }) } as Response;
      }
      if (url.includes('/progression/gaps')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    });
  }

  test('a suggestion renders with its rule and confirm files it as a real gap with the rule recorded', async () => {
    const capture = { gapPosts: [] as unknown[] };
    global.fetch = mockFetchWithSuggestions([SUGGESTION], capture) as unknown as typeof fetch;

    await act(async () => {
      render(<CoachProgressionIntelligencePage />);
    });

    await screen.findByText('Suggested Gaps');
    expect(screen.getByText('Readiness falling')).toBeTruthy();
    expect(screen.getByText(/fell from an average of 7.0 to 5.5/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm as gap' }));
    });

    expect(capture.gapPosts).toHaveLength(1);
    const posted = capture.gapPosts[0] as Record<string, unknown>;
    expect(posted.athlete_id).toBe('athlete-001');
    expect(posted.gap_type).toBe('endurance');
    expect(posted.detected_from).toBe('deterministic_rule:readiness_falling');
    expect(posted.detection_data).toEqual({ readiness_early_avg: 7, readiness_late_avg: 5.5 });

    // Confirmed, so it leaves the suggestion board.
    expect(screen.queryByText('Suggested Gaps')).toBeNull();
  });

  test('dismiss hides the suggestion for this visit without filing anything', async () => {
    const capture = { gapPosts: [] as unknown[] };
    global.fetch = mockFetchWithSuggestions([SUGGESTION], capture) as unknown as typeof fetch;

    await act(async () => {
      render(<CoachProgressionIntelligencePage />);
    });

    await screen.findByText('Suggested Gaps');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    });

    expect(screen.queryByText('Suggested Gaps')).toBeNull();
    expect(capture.gapPosts).toHaveLength(0);
  });

  test('no suggestions means no section, not an empty frame', async () => {
    const capture = { gapPosts: [] as unknown[] };
    global.fetch = mockFetchWithSuggestions([], capture) as unknown as typeof fetch;

    await act(async () => {
      render(<CoachProgressionIntelligencePage />);
    });

    await screen.findByText(/Progression Gaps → Drills → Verification/);
    expect(screen.queryByText('Suggested Gaps')).toBeNull();
  });
});
