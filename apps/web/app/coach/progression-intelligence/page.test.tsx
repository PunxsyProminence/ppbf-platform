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

function mockFetch(byAnchor: Record<string, RabbitHoleLessonItem[]>, gaps = [GAP]) {
  anchorsAsked = [];
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/progression/gaps')) {
      return { ok: true, json: async () => ({ items: gaps }) } as Response;
    }
    if (url.includes('/progression/assignments')) {
      return { ok: true, json: async () => ({ items: [] }) } as Response;
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
