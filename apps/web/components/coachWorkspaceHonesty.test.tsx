/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { AnnouncementItem } from './AnnouncementBanner';
import CoachWorkspace from './CoachWorkspace';

interface RouteResponses {
  floorPlans?: () => Promise<Response>;
  reviewProjection?: () => Promise<Response>;
  coachReviews?: () => Promise<Response>;
  announcements?: () => Promise<Response>;
  intakeReviewAction?: (body: { intake_case_id?: string; action?: string }) => Promise<Response>;
}

function announcement(overrides: Partial<AnnouncementItem> = {}): AnnouncementItem {
  return {
    announcement_id: 'ann_1',
    message: 'Lock the room in before the first bell.',
    author_name: 'Coach J.',
    author_role: 'coach',
    created_at: '2026-07-30T12:00:00.000Z',
    placement: 'coach_workspace',
    kind: 'motivation',
    active: true,
    starts_at: null,
    ends_at: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

function installFetch(routes: RouteResponses = {}): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('/api/pilot/auth/session')) {
      return jsonResponse({ authenticated: true, account_id: 'acct_coach_1' });
    }
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/floor-plans')) {
      return routes.floorPlans ? routes.floorPlans() : jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/shadow/review-projection')) {
      return routes.reviewProjection ? routes.reviewProjection() : jsonResponse({ queue: [] });
    }
    if (url.includes('/api/pilot/shadow/observation-projection')) {
      return jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/coach-reviews')) {
      return routes.coachReviews ? routes.coachReviews() : jsonResponse({ ok: true });
    }
    if (url.includes('/api/pilot/announcements/get')) {
      return routes.announcements ? routes.announcements() : jsonResponse({ ok: true, announcements: [] });
    }
    if (url.includes('/api/pilot/intake/review-action')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { intake_case_id?: string; action?: string };
      if (routes.intakeReviewAction) return routes.intakeReviewAction(body);
      const status = body.action === 'approve' ? 'approved' : 'rejected';
      return jsonResponse({ ok: true, intake_case_id: body.intake_case_id, status });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });

  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderWorkspace(routes: RouteResponses = {}): Promise<jest.Mock> {
  const fetchMock = installFetch(routes);
  await act(async () => {
    render(<CoachWorkspace />);
  });
  return fetchMock;
}

// A tab carrying a pending-count badge (see StatusBadge in CoachWorkspace.tsx)
// has that count in its accessible name too -- "Tasks 3 pending", not just
// "Tasks" -- so this matches on the label as a prefix rather than requiring
// an exact string that only holds when the queue happens to be empty.
function openTab(label: string): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}\\b`) }));
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('coach workspace does not fabricate the coach\'s own records', () => {
  test('Development shows no certification or expiry date, because none are stored', async () => {
    // Hardcoded credentials with expiry dates read as this coach's real
    // licensing status; an unexpired date is a safety claim, not decoration.
    await renderWorkspace();
    openTab('Development');

    expect(screen.queryByText(/Bronze Certification/i)).toBeNull();
    expect(screen.queryByText(/USA Boxing Coach License/i)).toBeNull();
    expect(screen.queryByText(/Expires:/i)).toBeNull();
    expect(screen.getAllByText(/Planned — Not Yet Implemented/i).length).toBeGreaterThan(0);
  });

  test('Development topics are a reference list, not controls that save nothing', async () => {
    await renderWorkspace();
    openTab('Development');

    expect(screen.queryByText('Injury Prevention Basics')).not.toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});

describe('floor tab presents a plan template, not a running session', () => {
  test('no session progress bar and no per-block status badges', async () => {
    await renderWorkspace();
    openTab('Floor');

    expect(screen.queryByText(/Session Workout Plan/i)).not.toBeNull();
    // The bar rendered a completion figure ("Session Progress: 40%"). Matching
    // the bare words would also match copy that says progress is NOT tracked.
    expect(screen.queryByText(/Session Progress:/i)).toBeNull();
    expect(screen.queryByText(/\d+%/)).toBeNull();
    expect(screen.queryByText('Not Started')).toBeNull();
    expect(screen.queryByText('In Progress')).toBeNull();
    expect(screen.queryByText('Completed')).toBeNull();
  });
});

describe('read failures are never rendered as an empty queue', () => {
  test('failed floor-plan fetch shows an error and Retry, not "no plans received yet"', async () => {
    const fetchMock = await renderWorkspace({
      floorPlans: async () => jsonResponse({}, { ok: false, status: 500 }),
    });
    openTab('Athlete Floor Plans');

    expect(screen.queryByText(/No athlete floor plans received yet/i)).toBeNull();
    expect(screen.queryByText(/Error loading athlete floor plans/i)).not.toBeNull();

    const planCallsBeforeRetry = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/api/pilot/floor-plans'),
    ).length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry loading athlete floor plans' }));
    });
    const planCallsAfterRetry = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/api/pilot/floor-plans'),
    ).length;
    expect(planCallsAfterRetry).toBe(planCallsBeforeRetry + 1);
  });

  test('failed review-queue fetch stops the Tasks board claiming the queue is clear', async () => {
    await renderWorkspace({
      reviewProjection: async () => jsonResponse({}, { ok: false, status: 503 }),
    });
    openTab('Tasks');

    expect(screen.queryByText(/Unable to load the SHADOW review queue/i)).not.toBeNull();
    expect(screen.queryByText(/No open tasks\. Items appear here/i)).toBeNull();
    expect(screen.queryByText(/an empty board means the queue is clear/i)).toBeNull();
  });

  test('a healthy but empty review queue still says the board is clear', async () => {
    await renderWorkspace();
    openTab('Tasks');

    expect(screen.queryByText(/Unable to load the SHADOW review queue/i)).toBeNull();
    expect(screen.queryByText(/No open tasks\. Items appear here/i)).not.toBeNull();
  });
});

describe('coach review submission', () => {
  test('a double-click persists exactly one review', async () => {
    let releaseReview: (() => void) | undefined;
    const fetchMock = await renderWorkspace({
      coachReviews: () =>
        new Promise<Response>((resolve) => {
          releaseReview = () => resolve(jsonResponse({ ok: true }));
        }),
    });

    openTab('Athlete Reviews');
    fireEvent.change(screen.getByPlaceholderText(/Session ID/i), {
      target: { value: 'session_1' },
    });

    const saveButton = screen.getByRole('button', { name: /Save Coach Review/i });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);
    fireEvent.click(screen.getByRole('button', { name: /Saving/i }));

    const reviewCalls = () =>
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('/api/pilot/coach-reviews')).length;
    expect(reviewCalls()).toBe(1);

    await act(async () => {
      releaseReview?.();
    });
    await waitFor(() => expect(screen.queryByText(/Coach review persisted/i)).not.toBeNull());
    expect(reviewCalls()).toBe(1);

    // The guard releases after the request settles, so a genuine second review
    // is still possible.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save Coach Review/i }));
    });
    expect(reviewCalls()).toBe(2);
  });
});

// The Tasks tab's own copy tells a coach to "use the SHADOW tab to act on
// review-queue items" -- these prove that action actually exists and works.
// /api/pilot/intake/review-action already authorizes 'coach' for
// approve/reject server-side; before this, nothing in the coach-facing UI
// ever called it, so the promise in the Tasks tab's copy was false.
describe('the SHADOW tab lets a coach act on review-queue items, as the Tasks tab promises', () => {
  function queueItem(overrides: Record<string, unknown> = {}) {
    return {
      intake_case_id: 'case_1',
      status: 'pending_review',
      summary: 'New athlete intake: Jordan T.',
      document_count: 2,
      updated_at: '2026-08-01T00:00:00.000Z',
      ...overrides,
    };
  }

  function reviewActionCalls(fetchMock: jest.Mock): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
      .filter((call) => String(call[0]).includes('/api/pilot/intake/review-action'))
      .map((call) => JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? '{}')) as Record<string, unknown>);
  }

  test('a pending_review item shows working Approve/Reject buttons', async () => {
    const fetchMock = await renderWorkspace({
      reviewProjection: async () => jsonResponse({ queue: [queueItem()] }),
    });
    openTab('SHADOW Intel');

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(reviewActionCalls(fetchMock)).toEqual([
      { intake_case_id: 'case_1', action: 'approve' },
    ]));
    await waitFor(() => expect(screen.queryByText('Status: approved')).not.toBeNull());
  });

  test('an already-decided item shows no action buttons', async () => {
    await renderWorkspace({
      reviewProjection: async () => jsonResponse({ queue: [queueItem({ status: 'approved' })] }),
    });
    openTab('SHADOW Intel');

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  test('a rejection outside the coach\'s assigned athletes surfaces the server\'s refusal, not a silent no-op', async () => {
    const fetchMock = await renderWorkspace({
      reviewProjection: async () => jsonResponse({ queue: [queueItem()] }),
      intakeReviewAction: async () => jsonResponse({ error: 'Forbidden: coach not assigned to athlete' }, { ok: false, status: 403 }),
    });
    openTab('SHADOW Intel');

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(screen.queryByText(/Forbidden: coach not assigned to athlete/i)).not.toBeNull());
    // The item's own local status must not be optimistically flipped on a
    // refused request -- it is still exactly what the server last said.
    expect(screen.queryByText('Status: pending_review')).not.toBeNull();
    expect(reviewActionCalls(fetchMock)).toHaveLength(1);
  });

  test('a double-click sends exactly one review-action request', async () => {
    let releaseAction: (() => void) | undefined;
    const fetchMock = await renderWorkspace({
      reviewProjection: async () => jsonResponse({ queue: [queueItem()] }),
      intakeReviewAction: (body) =>
        new Promise<Response>((resolve) => {
          releaseAction = () => resolve(jsonResponse({ ok: true, intake_case_id: body.intake_case_id, status: 'approved' }));
        }),
    });
    openTab('SHADOW Intel');

    const approveButton = screen.getByRole('button', { name: 'Approve' });
    fireEvent.click(approveButton);
    fireEvent.click(approveButton);

    expect(reviewActionCalls(fetchMock)).toHaveLength(1);

    await act(async () => {
      releaseAction?.();
    });
    await waitFor(() => expect(screen.queryByText('Status: approved')).not.toBeNull());
    expect(reviewActionCalls(fetchMock)).toHaveLength(1);
  });
});

// Authored notices and motivational copy are data, so the workspace has to ask
// for its own surface and has to survive the answer -- including no answer at
// all.
describe('authored announcements on the coach workspace', () => {
  function announcementRequests(fetchMock: jest.Mock): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
      .filter((call) => String(call[0]).includes('/api/pilot/announcements/get'))
      .map((call) => JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? '{}')) as Record<string, unknown>);
  }

  test('the workspace asks for its own placement, for both kinds', async () => {
    const fetchMock = await renderWorkspace();

    expect(announcementRequests(fetchMock)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ placement: 'coach_workspace', kind: 'notice' }),
        expect.objectContaining({ placement: 'coach_workspace', kind: 'motivation' }),
      ]),
    );
  });

  test('live motivational copy is drawn where the coach will see it', async () => {
    await renderWorkspace({
      announcements: async () => jsonResponse({ ok: true, announcements: [announcement()] }),
    });

    expect(screen.queryByText('Lock the room in before the first bell.')).not.toBeNull();
    expect(screen.queryByText('From the Gym')).not.toBeNull();
  });

  test('nothing live leaves no heading and no empty box behind', async () => {
    await renderWorkspace();

    expect(screen.queryByText('From the Gym')).toBeNull();
    expect(screen.queryByText('Gym Notices')).toBeNull();
  });

  test('a failed announcements read leaves the rest of the workspace working', async () => {
    await renderWorkspace({
      announcements: async () => {
        throw new Error('announcements offline');
      },
    });

    expect(screen.queryByText('From the Gym')).toBeNull();
    expect(screen.queryByText('Live Session Management')).not.toBeNull();

    openTab('Floor');
    expect(screen.queryByText(/Session Workout Plan/i)).not.toBeNull();
  });
});
