/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { AnnouncementItem } from './AnnouncementBanner';
import ParentHub from './ParentHub';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
  } as unknown as Response;
}

function announcement(overrides: Partial<AnnouncementItem> = {}): AnnouncementItem {
  return {
    announcement_id: 'ann_1',
    message: 'Gym closed Monday for the holiday.',
    author_name: 'Coach J.',
    author_role: 'coach',
    created_at: '2026-07-30T12:00:00.000Z',
    placement: 'everywhere',
    kind: 'notice',
    active: true,
    starts_at: null,
    ends_at: null,
    ...overrides,
  };
}

function installFetch(
  announcements: () => Promise<Response> = async () => jsonResponse({ ok: true, announcements: [] }),
  safety: () => Promise<Response> = async () => jsonResponse({ ok: true, items: [] }),
  barrierReport: (init?: RequestInit) => Promise<Response> = async () => jsonResponse({ ok: true, note_id: 'note-1' }),
  messages: () => Promise<Response> = async () => jsonResponse({ ok: true, items: [] }),
): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('/api/pilot/auth/session')) {
      return jsonResponse({ authenticated: true, account_id: 'acct_parent_1' });
    }
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({
        items: [
          { athlete_id: 'ath_1', full_name: 'First Child' },
          { athlete_id: 'ath_2', full_name: 'Second Child' },
        ],
      });
    }
    if (url.includes('/api/pilot/announcements/get')) {
      return announcements();
    }
    if (url.includes('/api/pilot/parent/safety')) {
      return safety();
    }
    if (url.includes('/api/pilot/parent/barrier-report')) {
      return barrierReport(init);
    }
    if (url.includes('/api/pilot/parent/messages')) {
      return messages();
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });

  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('parent hub child selector', () => {
  test('switching child does not refetch the roster or re-show the loading spinner', async () => {
    const fetchMock = installFetch();
    await act(async () => {
      render(<ParentHub />);
    });

    const rosterCalls = () =>
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('/api/pilot/athletes/list')).length;
    expect(rosterCalls()).toBe(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });

    // The roster is the same list either way; refetching it made every child
    // switch flash the spinner and blank the selector.
    expect(rosterCalls()).toBe(1);
    expect(screen.queryByText(/Loading your children/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'First Child' })).not.toBeNull();
  });

  test('the first child is selected by default and switching moves the overview to the other child', async () => {
    installFetch();
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.queryByText('First Child', { selector: 'p' })).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });

    expect(screen.queryByText('Second Child', { selector: 'p' })).not.toBeNull();
    expect(screen.queryByText('First Child', { selector: 'p' })).toBeNull();
  });
});

// REQUEST ORDERING ON THE FIGHT CARD.
//
// The card is the one object on this hub that carries a named child's identity
// -- their face, the ring name they wrote themselves, and the coach who is
// with them -- and it is refetched per selection while the child's NAME beside
// it comes from the roster and changes the instant the guardian taps. So when
// the two card reads race, the loser can land last and print one child's
// identity under their sibling's name. Not a stale field: the wrong child.
describe('request ordering when the guardian switches child', () => {
  function card(overrides: Record<string, unknown> = {}) {
    return {
      accountId: 'acct_child_1',
      displayName: 'First Child',
      initials: 'FC',
      ringName: 'Thunder',
      corner: 'red',
      cornerLabel: 'Red Corner',
      program: 'youth_mentorship',
      programLabel: 'Youth Mentorship',
      coachName: 'Coach Danielle',
      coachAccountId: 'acct_coach_1',
      coachPhotoAvailable: false,
      coachInitials: 'CD',
      timeAtGym: '1 year',
      photoAvailable: false,
      ...overrides,
    };
  }

  const SECOND_CARD = card({
    accountId: 'acct_child_2',
    displayName: 'Second Child',
    initials: 'SC',
    ringName: 'Lightning',
    corner: 'blue',
    cornerLabel: 'Blue Corner',
  });

  // The roster load reads every child's card once for the selector plate, so
  // the read this test holds open is the SECOND one for the first child --
  // the per-selection read that fills the card panel.
  function installCardFetch(firstChildCardAnswered: Promise<void>): jest.Mock {
    let firstChildCardReads = 0;
    const fetchMock = jest.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/pilot/athletes/list')) {
        return jsonResponse({
          items: [
            { athlete_id: 'ath_1', full_name: 'First Child' },
            { athlete_id: 'ath_2', full_name: 'Second Child' },
          ],
        });
      }
      if (url.includes('/api/pilot/profile/card')) {
        if (url.includes('ath_1')) {
          firstChildCardReads += 1;
          if (firstChildCardReads > 1) await firstChildCardAnswered;
          return jsonResponse({ card: card() });
        }
        return jsonResponse({ card: SECOND_CARD });
      }
      if (url.includes('/api/pilot/announcements/get')) return jsonResponse({ ok: true, announcements: [] });
      if (url.includes('/api/pilot/parent/safety')) return jsonResponse({ ok: true, items: [] });
      if (url.includes('/api/pilot/parent/messages')) return jsonResponse({ ok: true, items: [] });
      return jsonResponse({ ok: true, items: [] });
    });

    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  test("a slow card read for the child left behind never renders under the selected child's name", async () => {
    let releaseFirstChildCard: () => void = () => {};
    const firstChildCardAnswered = new Promise<void>((resolve) => {
      releaseFirstChildCard = resolve;
    });
    installCardFetch(firstChildCardAnswered);

    await act(async () => {
      render(<ParentHub />);
    });

    // The first child is selected by default and their card read is still open.
    expect(screen.queryByLabelText('Fight card for First Child')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });

    expect(screen.getByLabelText('Fight card for Second Child')).toBeTruthy();

    // The first child's card finally arrives -- last, and for a child the
    // guardian is no longer looking at.
    await act(async () => {
      releaseFirstChildCard();
    });

    expect(screen.queryByLabelText('Fight card for First Child')).toBeNull();
    expect(screen.queryByText('“Thunder”')).toBeNull();
    expect(screen.getByLabelText('Fight card for Second Child')).toBeTruthy();
    expect(screen.getByText('“Lightning”')).toBeTruthy();
  });

  test("the previous child's card does not hang over the new name while the new read is open", async () => {
    // The mirror image: the first child's card has already landed, and the
    // SECOND child's read is the slow one. A card left on screen through the
    // switch would be the same wrong-child claim, just reached the other way,
    // so the card is matched against the current selection at render.
    let releaseSecondChildCard: () => void = () => {};
    const secondChildCardAnswered = new Promise<void>((resolve) => {
      releaseSecondChildCard = resolve;
    });
    let secondChildCardReads = 0;
    global.fetch = jest.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/pilot/athletes/list')) {
        return jsonResponse({
          items: [
            { athlete_id: 'ath_1', full_name: 'First Child' },
            { athlete_id: 'ath_2', full_name: 'Second Child' },
          ],
        });
      }
      if (url.includes('/api/pilot/profile/card')) {
        if (url.includes('ath_2')) {
          secondChildCardReads += 1;
          if (secondChildCardReads > 1) await secondChildCardAnswered;
          return jsonResponse({ card: SECOND_CARD });
        }
        return jsonResponse({ card: card() });
      }
      return jsonResponse({ ok: true, items: [] });
    }) as unknown as typeof fetch;

    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.getByLabelText('Fight card for First Child')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });

    // Nothing claimed about the newly selected child yet: no card at all is
    // the honest state, and it is what a failed card read already looks like.
    expect(screen.queryByLabelText('Fight card for First Child')).toBeNull();
    expect(screen.queryByText('“Thunder”')).toBeNull();

    await act(async () => {
      releaseSecondChildCard();
    });

    expect(screen.getByLabelText('Fight card for Second Child')).toBeTruthy();
  });
});

// The hub asks for its own surface. 'parent_hub' is the placement an author
// chooses to reach guardians specifically, and the server's read includes
// 'everywhere' with any placement, so gym-wide items still arrive.
describe('authored announcements on the parent hub', () => {
  function announcementRequests(fetchMock: jest.Mock): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
      .filter((call) => String(call[0]).includes('/api/pilot/announcements/get'))
      .map((call) => JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? '{}')) as Record<string, unknown>);
  }

  test('the hub asks for the parent surface', async () => {
    const fetchMock = installFetch();
    await act(async () => {
      render(<ParentHub />);
    });

    const requests = announcementRequests(fetchMock);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.placement).toBe('parent_hub');
    }
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'notice' }),
        expect.objectContaining({ kind: 'motivation' }),
      ]),
    );
  });

  test('a live gym-wide notice reaches the parent', async () => {
    installFetch(async () => jsonResponse({ ok: true, announcements: [announcement()] }));
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.queryByText('Gym closed Monday for the holiday.')).not.toBeNull();
  });

  test('nothing live leaves no heading and no empty box behind', async () => {
    installFetch();
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.queryByText('Gym Notices')).toBeNull();
    expect(screen.queryByText('From the Gym')).toBeNull();
  });

  test('a failed announcements read leaves the rest of the hub working', async () => {
    installFetch(async () => {
      throw new Error('announcements offline');
    });
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.queryByText('Gym Notices')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Second Child' })).not.toBeNull();
  });
});

// Capabilities #93/#167: the hub previously never linked to /parent/safety
// or /parent/consent (both already built, #84/T-008) even though those
// pages link back to it -- a pure aggregation gap, no new schema.
describe('Safety & Consent card on the parent hub', () => {
  test('links to both surfaces are always present', async () => {
    installFetch();
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.getByRole('link', { name: 'View Safety Status' })).toHaveAttribute('href', '/parent/safety');
    expect(screen.getByRole('link', { name: 'Manage Consent' })).toHaveAttribute('href', '/parent/consent');
  });

  test('nothing to flag reads as a plain, non-alarming prompt', async () => {
    installFetch(undefined, async () => jsonResponse({ ok: true, items: [{ athlete_id: 'ath_1', hold: null, gates: [] }] }));
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.getByText(/Check your child.s active training-hold and safety-gate status/)).toBeDefined();
    expect(screen.queryByText(/active training hold/)).toBeNull();
  });

  test('an active hold and a flagged gate are summarized without staff detail', async () => {
    installFetch(
      undefined,
      async () =>
        jsonResponse({
          ok: true,
          items: [
            {
              athlete_id: 'ath_1',
              hold: { scope: 'full', athlete_explanation: 'Taking a short break.', lift_condition_text: '', placed_at: '2026-08-01T00:00:00Z', expires_at: null },
              gates: [{ gate_key: 'contact_medical_clearance', name: 'Contact Requires Medical Clearance', category: 'medical', outcome: 'flagged', evaluated_at: '2026-08-01T00:00:00Z' }],
            },
          ],
        }),
    );
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.getByText(/1 active training hold\(s\) and 1 gate\(s\) awaiting clearance/)).toBeDefined();
    expect(screen.getByText(/This is not a punishment/)).toBeDefined();
    // Never staff detail -- reason_text/reason_category never leave the server.
    expect(screen.queryByText('Taking a short break.')).toBeNull();
  });

  test('a failed safety read leaves the rest of the hub working, card falls back to plain links', async () => {
    installFetch(undefined, async () => {
      throw new Error('safety summary offline');
    });
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.getByRole('link', { name: 'View Safety Status' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Second Child' })).not.toBeNull();
  });
});

// Capabilities #95/#96: no parent-facing write path existed for a
// guardian-reported home or transportation barrier -- this is the new one,
// on the Parent Floor tab.
describe('Report a Barrier (#95/#96)', () => {
  async function openParentFloor() {
    await act(async () => {
      render(<ParentHub />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Parent Floor' }));
    });
  }

  test('defaults to Home and posts athleteId/barrierType/description', async () => {
    const fetchMock = installFetch();
    await openParentFloor();

    fireEvent.change(screen.getByLabelText("What's going on"), { target: { value: 'No ride most weeknights.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Coach' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pilot/parent/barrier-report'));
      expect(call).toBeDefined();
    });

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pilot/parent/barrier-report'));
    const body = JSON.parse(String((call?.[1] as RequestInit).body));
    expect(body).toEqual({ athleteId: 'ath_1', barrierType: 'home', description: 'No ride most weeknights.' });

    await screen.findByText("Sent to your child's coach.");
  });

  test('switching to Transportation changes the posted barrierType', async () => {
    const fetchMock = installFetch();
    await openParentFloor();

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'transportation' } });
    fireEvent.change(screen.getByLabelText("What's going on"), { target: { value: 'Car broke down.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Coach' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pilot/parent/barrier-report'));
      expect(call).toBeDefined();
    });

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pilot/parent/barrier-report'));
    const body = JSON.parse(String((call?.[1] as RequestInit).body));
    expect(body.barrierType).toBe('transportation');
  });

  test('the description clears after a successful send', async () => {
    installFetch();
    await openParentFloor();

    const textarea = screen.getByLabelText("What's going on") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Something.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Coach' }));

    await waitFor(() => expect(textarea.value).toBe(''));
  });

  test('an empty description does not submit', async () => {
    const fetchMock = installFetch();
    await openParentFloor();

    fireEvent.click(screen.getByRole('button', { name: 'Send to Coach' }));

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/pilot/parent/barrier-report'))).toBe(false);
  });

  test('a failed send shows the error, not a false success message', async () => {
    installFetch(undefined, undefined, async () => jsonResponse({ error: 'Forbidden' }, false));
    await openParentFloor();

    fireEvent.change(screen.getByLabelText("What's going on"), { target: { value: 'Something.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Coach' }));

    await screen.findByText('Forbidden');
    expect(screen.queryByText("Sent to your child's coach.")).toBeNull();
  });
});

// Capability #90, read side: the Messages tab previously showed hardcoded
// mock data behind a permanent "PLANNED | NOT YET IMPLEMENTED" notice --
// this is the real feed from GET /api/pilot/parent/messages.
describe('Messages tab (#90)', () => {
  async function openMessages() {
    await act(async () => {
      render(<ParentHub />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Messages' }));
    });
  }

  test('no messages reads as a plain empty state, not fabricated content', async () => {
    installFetch();
    await openMessages();

    // The default mock ANSWERS with zero messages, so this empty state is a
    // real observation. Its counterpart -- the read that never answered -- is
    // the test three below, and the two must not print the same sentence.
    expect(screen.getByText('No messages yet.')).toBeDefined();
  });

  test('a real message renders with the sending role and the child it concerns', async () => {
    installFetch(undefined, undefined, undefined, async () =>
      jsonResponse({
        ok: true,
        items: [
          {
            note_id: 'note-1',
            athlete_id: 'ath_1',
            athlete_name: 'First Child',
            sender_role: 'coach',
            note_text: 'Great effort at practice this week!',
            created_at: '2026-08-01T23:15:00.000Z',
          },
        ],
      }),
    );
    await openMessages();

    expect(await screen.findByText('Great effort at practice this week!')).toBeDefined();
    expect(screen.getByText('First Child', { selector: 'h4' })).toBeDefined();
    expect(screen.getByText('From Coach')).toBeDefined();
  });

  test('a failed messages read leaves the rest of the hub working', async () => {
    installFetch(undefined, undefined, undefined, async () => {
      throw new Error('messages offline');
    });
    await openMessages();

    expect(screen.getByText(/your messages have not loaded/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Second Child' })).not.toBeNull();
  });

  // A FAILED READ IS NOT AN EMPTY INBOX, AND THE TAB USED TO SAY IT WAS.
  //
  // `messagesLoaded` stays false when GET /api/pilot/parent/messages does not
  // answer -- the effect swallows the failure so the rest of the hub keeps
  // working -- and this tab rendered that as "No messages yet.", which tells a
  // guardian the gym has written nothing to them, as a fact, when nobody
  // knows. The summary tile above already drew this distinction; the tab did
  // not, and it is the surface a guardian actually reads for messages.
  //
  // WATCHED TO FAIL, 2026-08-25: drop the `!messagesLoaded` branch and this
  // goes red on the sentence, both halves of it.
  test('a failed read never renders as "No messages yet."', async () => {
    installFetch(undefined, undefined, undefined, async () => {
      throw new Error('messages offline');
    });
    await openMessages();

    expect(screen.queryByText('No messages yet.')).toBeNull();
    expect(screen.getByText(/This is not an empty inbox\./i)).toBeDefined();
  });

  // A refusal is a failed read too: the effect returns early on !response.ok
  // without setting messagesLoaded, so the tab must not call that empty
  // either.
  test('a refused messages read is not an empty inbox either', async () => {
    installFetch(undefined, undefined, undefined, async () => jsonResponse({ error: 'nope' }, false));
    await openMessages();

    expect(screen.queryByText('No messages yet.')).toBeNull();
    expect(screen.getByText(/your messages have not loaded/i)).toBeDefined();
  });

  test('replying stays disabled -- one-directional only', async () => {
    installFetch();
    await openMessages();

    expect(screen.getByRole('button', { name: 'Send Message (unavailable)' })).toBeDisabled();
  });
});

// The summary tiles' honesty rule: null means "no feed answered", and it must
// never render as a number. The distinction matters most at zero -- "0 tasks
// due" tells a parent nothing is expected of them, which is a claim, not a
// default.
describe('summary tile honesty', () => {
  function tileValue(label: string): string {
    // 'Messages' is also a tab button; the tile's label is the <p>.
    const labelElement = screen.getAllByText(label).find((element) => element.tagName === 'P');
    const tile = labelElement?.parentElement;
    return tile?.textContent?.replace(label, '').trim() ?? '';
  }

  test('Home Tasks and Upcoming say Unavailable -- they have no backend feed to count from', async () => {
    installFetch();
    await act(async () => {
      render(<ParentHub />);
    });

    expect(tileValue('Home Tasks')).toBe('Unavailable');
    expect(tileValue('Upcoming')).toBe('Unavailable');
  });

  test('a failed messages read renders the Messages tile as Unavailable, not as 0', async () => {
    installFetch(undefined, undefined, undefined, async () => {
      throw new Error('messages offline');
    });
    await act(async () => {
      render(<ParentHub />);
    });

    expect(tileValue('Messages')).toBe('Unavailable');
  });

  test('a messages read that answered keeps its real count -- including a real zero', async () => {
    installFetch();
    await act(async () => {
      render(<ParentHub />);
    });

    // The default mock answers with zero messages; that zero is an
    // observation, not a fabrication, and stays a number.
    expect(tileValue('Messages')).toBe('0');
  });

  test('a message that arrived is counted on the tile', async () => {
    installFetch(undefined, undefined, undefined, async () =>
      jsonResponse({
        ok: true,
        items: [
          { note_id: 'n1', note_text: 'Great week.', created_at: '2026-08-10T12:00:00.000Z', reporter_role: 'coach', athlete_name: 'First Child' },
          { note_id: 'n2', note_text: 'See you Friday.', created_at: '2026-08-11T12:00:00.000Z', reporter_role: 'coach', athlete_name: 'First Child' },
        ],
      }));
    await act(async () => {
      render(<ParentHub />);
    });

    expect(tileValue('Messages')).toBe('2');
  });
});
