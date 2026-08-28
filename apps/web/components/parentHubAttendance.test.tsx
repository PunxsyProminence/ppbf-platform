/**
 * @jest-environment jsdom
 */

/**
 * The Attendance tab, against the shared scheduler.
 *
 * This tab spent its life behind a "PLANNED | NOT YET IMPLEMENTED" notice over
 * two permanently empty arrays, while GET /api/pilot/scheduler had a parent
 * branch answering exactly this question all along. These tests pin the three
 * things that were easy to get wrong in wiring it up:
 *
 *   the child on screen is the child whose attendance is shown, not the
 *   family's;
 *
 *   a failed read, an empty record and a zero are three different statements
 *   and none of them may be rendered as another;
 *
 *   no percentage is computed, because nothing defines the denominator.
 */

import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import ParentHub from './ParentHub';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const CLASSES = [
  {
    class_id: 'cls_past',
    title: 'Tuesday Fundamentals',
    start_at: '2020-01-07T23:00:00.000Z',
    location: 'Main Floor',
    status: 'open',
  },
  {
    class_id: 'cls_future',
    title: 'Saturday Sparring',
    start_at: '2099-06-05T15:00:00.000Z',
    location: 'Ring Two',
    status: 'open',
  },
  {
    class_id: 'cls_full',
    title: 'Strength Block',
    start_at: '2099-06-07T15:00:00.000Z',
    location: 'Weight Room',
    status: 'full',
  },
];

function installFetch(scheduler: () => Promise<Response>): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/pilot/auth/session')) {
      return jsonResponse({ authenticated: true, account_id: 'acct_parent_1', role: 'parent' });
    }
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({
        items: [
          { athlete_id: 'ath_1', full_name: 'First Child' },
          { athlete_id: 'ath_2', full_name: 'Second Child' },
        ],
      });
    }
    if (url.includes('/api/pilot/scheduler')) {
      return scheduler();
    }
    // Everything else the hub reads is irrelevant here and answers empty
    // rather than throwing, so a failure in this file is a failure of the
    // attendance tab and not of some neighbouring panel.
    return jsonResponse({ ok: true, items: [], announcements: [], card: null });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function openAttendanceTab(): Promise<void> {
  await waitFor(() => expect(screen.getByRole('button', { name: 'First Child' })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Attendance' }));
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the Attendance tab reads the real schedule', () => {
  it('shows the selected child’s attendance and never the sibling’s', async () => {
    installFetch(async () =>
      jsonResponse({
        ok: true,
        classes: CLASSES,
        registrations: [],
        attendance: [
          {
            attendance_id: 'att_1',
            class_id: 'cls_past',
            athlete_id: 'ath_1',
            status: 'present',
            checked_in_at: '2020-01-07T23:05:00.000Z',
          },
          {
            attendance_id: 'att_2',
            class_id: 'cls_past',
            athlete_id: 'ath_2',
            status: 'absent',
            checked_in_at: '2020-01-07T23:06:00.000Z',
          },
        ],
      }),
    );
    const { container } = render(<ParentHub />);
    await openAttendanceTab();

    await waitFor(() => expect(screen.getByText(/Tuesday Fundamentals/)).toBeInTheDocument());
    // Asserted on the rendered text rather than by node, because the status
    // reads `<span aria-hidden>✓</span> Present` -- split across two nodes,
    // and uppercased by CSS rather than in the DOM.
    expect(container.textContent ?? '').toContain('Present');
    // The sibling's row is in the same payload and belongs to the other child.
    // Rendering it here is the sibling-leak this tab could most easily have
    // shipped.
    expect(container.textContent ?? '').not.toContain('Absent');
  });

  it('says Unavailable when the read fails, and does not call that an empty record', async () => {
    installFetch(async () => jsonResponse({ error: 'boom' }, false));
    render(<ParentHub />);
    await openAttendanceTab();

    // Both the history and the Upcoming panel say unavailable, which is right,
    // so this matches the sentence only the attendance side carries.
    await waitFor(() =>
      expect(screen.getByText(/This is not an empty attendance record/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/No attendance recorded/i)).not.toBeInTheDocument();
  });

  it('says no records when the read succeeds and is empty, and does not call that Unavailable', async () => {
    installFetch(async () => jsonResponse({ ok: true, classes: [], registrations: [], attendance: [] }));
    render(<ParentHub />);
    await openAttendanceTab();

    await waitFor(() => expect(screen.getByText(/No attendance recorded/i)).toBeInTheDocument());
    expect(screen.queryByText(/could not be read/i)).not.toBeInTheDocument();
  });

  it('never renders an attendance percentage', async () => {
    installFetch(async () =>
      jsonResponse({
        ok: true,
        classes: CLASSES,
        registrations: [],
        attendance: [
          {
            attendance_id: 'att_1',
            class_id: 'cls_past',
            athlete_id: 'ath_1',
            status: 'present',
            checked_in_at: '2020-01-07T23:05:00.000Z',
          },
          {
            attendance_id: 'att_2',
            class_id: 'cls_past',
            athlete_id: 'ath_1',
            status: 'absent',
            checked_in_at: '2020-01-06T23:05:00.000Z',
          },
        ],
      }),
    );
    const { container } = render(<ParentHub />);
    await openAttendanceTab();

    await waitFor(() => expect(container.textContent ?? '').toContain('Present'));
    // One present of two events is exactly the shape that invites a "50%".
    // Nothing defines which sessions this child was expected at, so no rate
    // may appear anywhere on the surface.
    expect(container.textContent ?? '').not.toMatch(/\d+\s*%/);
  });

  it('shows a waitlisted place as waitlisted rather than as a registration', async () => {
    installFetch(async () =>
      jsonResponse({
        ok: true,
        classes: CLASSES,
        registrations: [
          { registration_id: 'reg_1', class_id: 'cls_future', athlete_id: 'ath_1', status: 'waitlisted' },
        ],
        attendance: [],
      }),
    );
    render(<ParentHub />);
    await openAttendanceTab();

    await waitFor(() => expect(screen.getByText(/Saturday Sparring/)).toBeInTheDocument());
    // A guardian who reads "Registered" and drives their kid to a class they
    // never had a place in has been misled by this panel.
    expect(screen.getByText(/Waitlisted/)).toBeInTheDocument();
  });

  it('leaves a finished class and a cancelled registration out of Upcoming', async () => {
    installFetch(async () =>
      jsonResponse({
        ok: true,
        classes: CLASSES,
        registrations: [
          { registration_id: 'reg_past', class_id: 'cls_past', athlete_id: 'ath_1', status: 'registered' },
          { registration_id: 'reg_cancelled', class_id: 'cls_future', athlete_id: 'ath_1', status: 'cancelled' },
          { registration_id: 'reg_ok', class_id: 'cls_full', athlete_id: 'ath_1', status: 'registered' },
        ],
        attendance: [],
      }),
    );
    render(<ParentHub />);
    await openAttendanceTab();

    await waitFor(() => expect(screen.getByText(/Strength Block/)).toBeInTheDocument());
    // A class that already happened is not upcoming, and a registration the
    // family cancelled is not a place they still hold.
    expect(screen.queryByText(/Saturday Sparring/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tuesday Fundamentals/)).not.toBeInTheDocument();
  });
});
