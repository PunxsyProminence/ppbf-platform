/**
 * @jest-environment jsdom
 */

// A coach reading a gap is the person most likely to want the theory behind it,
// and the one who can write it. These pin that the gap card asks for the two
// vocabulary terms it already names, that the lesson arrives labelled as the
// gym's own coaching rather than as evidence, and that a term nobody has
// written about adds nothing to the surface at all.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import type { RabbitHoleLessonItem } from '@/components/RabbitHole';
import type { AssignmentInstructionResponse } from '@/components/drills/drillInstructionRead';
import type { CoachRosterAthlete } from '@/src/server/pilot/contracts';
import type { DrillWithDetail } from '@/src/server/pilot/drillLibraryV3';
import type { PilotDrill } from '@/src/server/pilot/drills';
import type { DrillAssignment } from '@/src/server/pilot/progression';
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

  // Renamed: this used to be called "shows no banner rather than breaking the
  // page", which read as though silence on a failed read were the intent. It
  // was not -- silence is what a child with NO hold looks like. What this
  // test actually holds is the narrower thing its assertion says: a read that
  // failed is not evidence of a hold and is never dressed as one. The banner
  // such a read DOES owe the coach is pinned in the last describe of this file.
  test('a failed hold fetch is never shown as an active hold, and does not break the page', async () => {
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

// REQUEST ORDERING WHEN THE COACH CHANGES ATHLETE.
//
// Every read on this page is keyed to the selected athlete, and none of them
// were cancelled when that selection changed: two athletes' reads ran at once
// and whichever answered last wrote the screen. The hold banner is the one
// that hurts most -- an athlete with no hold answering after an athlete who
// has one leaves a coach assigning contact work to a child their own gym has
// paused.
describe('request ordering when the coach changes athlete', () => {
  const CONTACT_HOLD = {
    scope: 'contact_only',
    reason_category: 'medical',
    athlete_explanation: 'Waiting on a doctor note before contact resumes.',
  };

  const SECOND_GAP = {
    ...GAP,
    gap_id: 'gap-2',
    athlete_id: 'athlete-002',
    gap_description: 'Guard drops after the third round.',
  };

  async function selectAthlete(id: string) {
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/Enter athlete ID/), { target: { value: id } });
    });
  }

  test("a slow no-hold answer for the previous athlete cannot clear the selected athlete's hold banner", async () => {
    let releaseFirstHoldRead: () => void = () => {};
    const firstHoldAnswered = new Promise<void>((resolve) => {
      releaseFirstHoldRead = resolve;
    });

    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/pilot/training-holds')) {
        if (url.includes('athlete_id=athlete-001')) {
          await firstHoldAnswered;
          return { ok: true, json: async () => ({ ok: true, holds: [] }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: true, holds: [CONTACT_HOLD] }) } as Response;
      }
      if (url.includes('/progression/gaps')) {
        return { ok: true, json: async () => ({ items: [GAP] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    await act(async () => {
      render(<CoachProgressionIntelligencePage />);
    });
    await selectAthlete('athlete-001');
    await selectAthlete('athlete-002');

    await screen.findByText('Active Training Hold');

    // The first athlete's "no active hold" finally arrives, last.
    await act(async () => {
      releaseFirstHoldRead();
    });

    expect(screen.getByText('Active Training Hold')).toBeTruthy();
    expect(screen.getByText(/CONTACT WORK is currently paused/)).toBeTruthy();
  });

  test("the previous athlete's hold banner does not stand over the newly selected athlete", async () => {
    // The mirror image, and the reason the hold is stored with the athlete it
    // was read for: a banner left up through a switch tells a coach that THIS
    // athlete is paused when the claim was about somebody else.
    let releaseSecondHoldRead: () => void = () => {};
    const secondHoldAnswered = new Promise<void>((resolve) => {
      releaseSecondHoldRead = resolve;
    });

    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/pilot/training-holds')) {
        if (url.includes('athlete_id=athlete-002')) {
          await secondHoldAnswered;
          return { ok: true, json: async () => ({ ok: true, holds: [] }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: true, holds: [CONTACT_HOLD] }) } as Response;
      }
      if (url.includes('/progression/gaps')) {
        return { ok: true, json: async () => ({ items: [GAP] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    await act(async () => {
      render(<CoachProgressionIntelligencePage />);
    });
    await selectAthlete('athlete-001');
    await screen.findByText('Active Training Hold');

    await selectAthlete('athlete-002');

    expect(screen.queryByText('Active Training Hold')).toBeNull();

    await act(async () => {
      releaseSecondHoldRead();
    });

    expect(screen.queryByText('Active Training Hold')).toBeNull();
  });

  test("a slow gaps answer for the previous athlete never lands under the selected athlete", async () => {
    let releaseFirstGapsRead: () => void = () => {};
    const firstGapsAnswered = new Promise<void>((resolve) => {
      releaseFirstGapsRead = resolve;
    });

    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/progression/gaps')) {
        if (url.includes('athlete_id=athlete-001')) {
          await firstGapsAnswered;
          return { ok: true, json: async () => ({ items: [GAP] }) } as Response;
        }
        return { ok: true, json: async () => ({ items: [SECOND_GAP] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    await act(async () => {
      render(<CoachProgressionIntelligencePage />);
    });
    await selectAthlete('athlete-001');
    await selectAthlete('athlete-002');

    await screen.findByText('Guard drops after the third round.');

    await act(async () => {
      releaseFirstGapsRead();
    });

    expect(screen.queryByText('Rear foot stays flat through the cross.')).toBeNull();
    expect(screen.getByText('Guard drops after the third round.')).toBeTruthy();
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

// The roster picker had no test, which is how it shipped listing raw athlete
// ids to every coach: it read `display_name`, a key /api/pilot/athletes/list
// has never sent, so `display_name || athlete_id` fell through silently.
//
// The type now comes from the producer (CoachRosterAthlete), so a recurrence
// fails to compile. That matters more than this test does, and /coach/cards
// records why: a hand-written mock inventing the same key kept its suite green
// while production showed ids. The fixture below is therefore typed against
// the contract -- a mock free to invent a field is a mock that can agree with
// a bug.
describe('the roster picker', () => {
  const ROSTER: Pick<CoachRosterAthlete, 'athlete_id' | 'full_name'>[] = [
    { athlete_id: 'ath-0f3c9a21', full_name: 'Rosa Delgado' },
  ];

  test('offers athletes by name, never by raw id', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/pilot/athletes/list')) {
        return { ok: true, json: async () => ({ items: ROSTER }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    render(<CoachProgressionIntelligencePage />);

    expect(await screen.findByRole('option', { name: 'Rosa Delgado' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('option', { name: 'ath-0f3c9a21' })).toBeNull();
    });
  });
});

// ON THIS PAGE THE ABSENCE OF A BANNER IS ITSELF A CLAIM.
//
// Every other unreadable state in this app has a sentence a coach can read.
// This one did not: a hold read that failed wrote `hold: null`, `null` renders
// nothing, and nothing is exactly what a child with no hold looks like. So the
// failure mode was silent and it pointed the wrong way -- a coach who cannot
// see the hold their own gym placed sends a child who is not cleared back into
// contact work, which is the harm the hold read's own comment names.
//
// Three states now, not two: held, not held, and nobody could look.
describe('a hold read nobody could complete is not the absence of a hold', () => {
  async function selectAthlete(id: string) {
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/Enter athlete ID/), { target: { value: id } });
    });
  }

  test('a refused hold read says the hold is UNKNOWN, and does not stand silent as a child with no hold does', async () => {
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

    // The claim is made out loud, in the word that matters.
    expect(await screen.findByText('Training hold: could not be read')).toBeTruthy();
    expect(screen.getByText(/Whether this athlete is under a training hold is UNKNOWN/)).toBeTruthy();

    // Note what the absence assertion has to be here: on this page the old
    // false claim was not a sentence, it was SILENCE, so what is pinned is
    // that the failure is no longer indistinguishable from a clean read --
    // the test below holds the other half of that pair. What must still be
    // absent is the overshoot: a read that failed is not evidence of a hold
    // either, and must not be dressed as one.
    expect(screen.queryByText('Active Training Hold')).toBeNull();

    // And the page still works underneath it. This banner is context, not a
    // gate; the repair must not cost the coach the board they came for.
    expect(screen.getByText('Rear foot stays flat through the cross.')).toBeTruthy();
  });

  test('a hold read that throws is treated the same as one the server refused', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/pilot/training-holds')) {
        throw new Error('Network request failed');
      }
      if (url.includes('/progression/gaps')) {
        return { ok: true, json: async () => ({ items: [GAP] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    });

    await renderWithAthlete(fetchMock);

    expect(await screen.findByText('Training hold: could not be read')).toBeTruthy();
    expect(screen.queryByText('Active Training Hold')).toBeNull();
  });

  test('an athlete the platform looked at and found no hold for gets no banner at all', async () => {
    // The other half of the pair, and the one that gives the test above its
    // meaning. Without it, a page that shouted UNKNOWN over every athlete on
    // every load would pass -- and a banner a coach sees on every child is a
    // banner a coach stops seeing, which puts them back where they started on
    // the day it is true.
    await renderWithAthlete(mockFetch({}, [GAP], []));

    await screen.findByText('Rear foot stays flat through the cross.');
    expect(screen.queryByText('Training hold: could not be read')).toBeNull();
    expect(screen.queryByText('Active Training Hold')).toBeNull();
  });

  test('a hold read the coach superseded never lands as UNKNOWN on the athlete they came back to', async () => {
    /* The abort is not a failure and must write nothing. The scenario is a
       coach flicking between two children and returning to the first: read #1
       for athlete-001 is superseded, athlete-002 answers, then the coach comes
       back to athlete-001 whose read #2 is still in flight -- and only THEN
       does the abandoned read #1 fail. Its athlete is selected again, so
       nothing downstream would filter it: if a superseded read were allowed to
       write, UNKNOWN would appear over a child whose real answer nobody has
       yet, from a request that was cancelled. */
    const holdReads: Record<string, number> = {};
    let failSupersededRead: () => void = () => {};
    const supersededRead = new Promise<Response>((resolve) => {
      failSupersededRead = () => resolve({ ok: false, json: async () => ({ error: 'Forbidden' }) } as Response);
    });

    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/pilot/training-holds')) {
        if (url.includes('athlete_id=athlete-001')) {
          holdReads['athlete-001'] = (holdReads['athlete-001'] ?? 0) + 1;
          // The first read is the one the coach abandons. The second is the
          // live one, and it deliberately never answers within this test --
          // so anything on screen about a hold came from the abandoned read.
          return holdReads['athlete-001'] === 1 ? supersededRead : new Promise<Response>(() => {});
        }
        return { ok: true, json: async () => ({ ok: true, holds: [] }) } as Response;
      }
      if (url.includes('/progression/gaps')) {
        return { ok: true, json: async () => ({ items: [GAP] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    await act(async () => {
      render(<CoachProgressionIntelligencePage />);
    });
    await selectAthlete('athlete-001');
    await selectAthlete('athlete-002');
    await selectAthlete('athlete-001');

    await act(async () => {
      failSupersededRead();
    });

    expect(screen.queryByText('Training hold: could not be read')).toBeNull();
    expect(screen.queryByText('Active Training Hold')).toBeNull();
  });
});

// W-D3, OD-2026-09-18-001. An assignment is built from a drill in the gym's
// own library; there is no longer a typed-out drill name or description.
describe('assigning a drill requires an operational drill', () => {
  const DRILL = {
    drill_id: 'drill-pivot',
    name: 'Rear-foot pivot',
    focus: 'Heel up before the cross lands.',
    difficulty: 'beginner',
    active: true,
  };

  /** The page's own reads, with the drill library answering as `drills` (false: 503). */
  function assignFetch(drills: unknown[] | false, posts: Array<Record<string, unknown>>) {
    return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/pilot/drills')) {
        return drills === false
          ? ({ ok: false, status: 503, json: async () => ({ error: 'unavailable' }) } as Response)
          : ({ ok: true, json: async () => ({ items: drills }) } as Response);
      }
      if (url.includes('/progression/assignments') && init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      if (url.includes('/progression/gaps')) {
        return { ok: true, json: async () => ({ items: [GAP] }) } as Response;
      }
      if (url.includes('/api/pilot/training-holds')) {
        return { ok: true, json: async () => ({ ok: true, holds: [] }) } as Response;
      }
      if (url.includes('/rabbit-holes/get')) {
        return { ok: true, json: async () => ({ ok: true, rabbit_holes: [] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    });
  }

  async function openAssignForm(drills: unknown[] | false, posts: Array<Record<string, unknown>> = []) {
    await renderWithAthlete(assignFetch(drills, posts));
    await screen.findByText('Rear foot stays flat through the cross.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Assign drill' }));
    });
    return posts;
  }

  test('the drill picker is required and the typed name/description inputs are gone', async () => {
    await openAssignForm([DRILL]);

    const picker = screen.getByLabelText('Drill') as HTMLSelectElement;
    expect(picker.required).toBe(true);
    expect(screen.queryByText(/Free-text or pick/)).toBeNull();
    expect(screen.queryByLabelText('Drill name')).toBeNull();
    expect(screen.queryByLabelText('Description / cues')).toBeNull();
  });

  test('assigning without picking a drill is stopped on the client, and nothing is posted', async () => {
    const posts = await openAssignForm([DRILL]);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Assign drill' }));
    });

    expect(screen.getByText("Select a gap and a drill from this gym's library")).toBeTruthy();
    expect(posts).toHaveLength(0);
  });

  test("the request carries the picked drill_id and none of the drill's wording", async () => {
    const posts = await openAssignForm([DRILL]);

    fireEvent.change(screen.getByLabelText('Drill'), { target: { value: 'drill-pivot' } });
    // The drill's own wording is shown, read-only, as what the athlete will see.
    expect(screen.getByText('What the athlete will see')).toBeTruthy();
    expect(screen.getByText('Heel up before the cross lands.')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Assign drill' }));
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ gap_id: 'gap-1', athlete_id: 'athlete-001', drill_id: 'drill-pivot' });
    expect(posts[0]).not.toHaveProperty('drill_name');
    expect(posts[0]).not.toHaveProperty('drill_description');
  });

  test('a gym with no drills gets a truthful empty state, not a form that can never submit', async () => {
    await openAssignForm([]);

    expect(screen.getByText(/This gym has no drills to assign yet/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the Drill Library' }).getAttribute('href')).toBe('/coach/drills');
    expect(screen.queryByLabelText('Drill')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Assign drill' })).toBeNull();
  });

  test('a drill list that failed to load says so, rather than claiming the gym has none', async () => {
    await openAssignForm(false);

    expect(screen.getByText(/did not load, so a drill cannot be assigned right now/)).toBeTruthy();
    expect(screen.queryByText(/This gym has no drills to assign yet/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Assign drill' })).toBeNull();
  });

  // W-D3 review N1. Before the drill read lands, the page holds the same empty
  // array it would hold for a gym with no drills. A coach can still reach the
  // Assign form in that window -- the free-text athlete id and the gaps read do
  // not wait on the drill list -- so the form must not read "not answered yet"
  // as "none".
  test('while the drill list has not answered, the form claims nothing; an answer of none then says so', async () => {
    let answerDrills: (items: unknown[]) => void = () => {};
    const drillsAnswer = new Promise<Response>((resolve) => {
      answerDrills = (items) => resolve({ ok: true, json: async () => ({ items }) } as Response);
    });
    const everythingElse = assignFetch([DRILL], []);
    const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/api/pilot/drills') ? drillsAnswer : everythingElse(input, init),
    );

    await renderWithAthlete(fetchMock);
    await screen.findByText('Rear foot stays flat through the cross.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Assign drill' }));
    });

    expect(screen.getByText(/Loading the gym's drills/)).toBeTruthy();
    expect(screen.queryByText(/This gym has no drills to assign yet/)).toBeNull();
    expect(screen.queryByText(/did not load, so a drill cannot be assigned right now/)).toBeNull();
    expect(screen.queryByLabelText('Drill')).toBeNull();

    await act(async () => {
      answerDrills([]);
    });

    expect(await screen.findByText(/This gym has no drills to assign yet/)).toBeTruthy();
    expect(screen.queryByText(/Loading the gym's drills/)).toBeNull();
  });
});

// W-D4B, OD-2026-09-19-001. A coach can now READ the whole drill -- safety
// first -- both before issuing it (from the assign form) and after (from each
// assigned drill). Reading is all these controls do: every request behind them
// is a GET, so opening a drill can never assign, complete or move anything.
//
// Every describe above answers the assignments read with an empty list, so the
// Assigned Drills list had never rendered a row under test. The list here
// carries one assignment anchored to a drill and one legacy row written before
// drills had identity, because the control exists for the first and must not
// exist for the second.
describe('W-D4B: the coach reads the drill before and after assigning it', () => {
  // Typed against the producers, for the reason the roster picker's fixture
  // is: a hand-written mock free to invent a key is a mock that can agree
  // with a bug.
  type LibraryDrill = Pick<
    PilotDrill,
    'drill_id' | 'name' | 'category' | 'focus' | 'difficulty' | 'active' | 'reference_drill_id'
  >;

  // Adopted from the reference library. It names the exact reference VERSION
  // it adopted, and that id -- never its own id, never a name -- is what the
  // preview asks for.
  const ADOPTED: LibraryDrill = {
    drill_id: 'drill-jab-return',
    name: 'Jab return',
    category: 'striking',
    focus: 'Hand home before the next beat.',
    difficulty: 'intermediate',
    active: true,
    reference_drill_id: 'reference-jab-v1',
  };

  // Written by this gym: no pointer, so there is no reference to open.
  const GYM_WRITTEN: LibraryDrill = {
    drill_id: 'drill-pivot',
    name: 'Rear-foot pivot',
    category: 'footwork',
    focus: 'Heel up before the cross lands.',
    difficulty: 'beginner',
    active: true,
    reference_drill_id: null,
  };

  // Named differently from the operational drill on purpose, so the heading
  // on screen proves which row was rendered.
  const REFERENCE: DrillWithDetail = {
    organization_id: 'org-1',
    drill_id: 'reference-jab-v1',
    lineage_id: 'reference-jab',
    version: 1,
    supersedes_drill_id: null,
    superseded_at: null,
    name: 'Seeded jab return',
    discipline: 'boxing',
    category: 'striking',
    difficulty: 'fundamentals',
    skill_id: 'SK-JAB-01',
    target_behavior: 'Return the hand to guard.',
    purpose: 'Return the hand to guard.',
    standard_setup: 'Partners at technical distance.',
    execution: 'Jab at the mitt.\n\nReturn the hand to the chin.',
    what_good_looks_like: 'Hand back before the next beat',
    what_bad_looks_like: 'Hand drops on the way back',
    common_errors: 'Pawing the jab',
    corrections: '',
    transfer: '',
    contact_level: 'light_technical',
    equipment_needed: 'focus mitts',
    requires_coach_authorization: true,
    content_class: 'COACHING CRAFT - PPBF source manual v3',
    source_ref: null,
    grounding_claim_ids: [],
    field_provenance: 'PPBF source manual v3',
    active: true,
    created_by_account_id: null,
    created_by_role: null,
    created_at: '2026-09-16T00:00:00.000Z',
    updated_at: '2026-09-16T00:00:00.000Z',
    scale_levels: [],
    stop_rules: [
      {
        organization_id: 'org-1',
        stop_rule_id: 'st-1',
        drill_id: 'reference-jab-v1',
        ordinal: 1,
        condition_text: 'Stop when the hand stops coming home.',
        scope: 'drill_specific',
        rule_kind: 'technique_degradation',
      },
    ],
    cues: [],
    secondary_skills: [],
  };

  // A second adopted drill, pointing at a DIFFERENT reference version. A test
  // that swaps one open drill for another needs both to be drills that CAN
  // render: swapping to one the gym wrote itself leaves a stale answer nowhere
  // to land, so the test cannot fail (W-D4B review B).
  const ADOPTED_HOOK: LibraryDrill = {
    drill_id: 'drill-lead-hook',
    name: 'Lead hook check',
    category: 'striking',
    focus: 'Elbow level with the fist.',
    difficulty: 'intermediate',
    active: true,
    reference_drill_id: 'reference-hook-v1',
  };

  const REFERENCE_HOOK: DrillWithDetail = {
    ...REFERENCE,
    drill_id: 'reference-hook-v1',
    lineage_id: 'reference-hook',
    name: 'Seeded lead hook',
    skill_id: 'SK-HOOK-01',
    target_behavior: 'Turn the hook over the lead foot.',
    purpose: 'Turn the hook over the lead foot.',
    execution: 'Hook at the mitt.\n\nTurn the hip with it.',
    stop_rules: [
      {
        organization_id: 'org-1',
        stop_rule_id: 'st-2',
        drill_id: 'reference-hook-v1',
        ordinal: 1,
        condition_text: 'Stop when the elbow drops below the fist.',
        scope: 'drill_specific',
        rule_kind: 'technique_degradation',
      },
    ],
  };

  const ASSIGNMENT_BASE: Omit<
    DrillAssignment,
    'assignment_id' | 'drill_id' | 'drill_name' | 'drill_description' | 'drill_display_name' | 'drill_display_description'
  > = {
    gap_id: 'gap-1',
    athlete_id: 'athlete-001',
    drill_category: null,
    drill_cues: null,
    drill_difficulty: 'intermediate',
    rep_count: null,
    duration_minutes: null,
    frequency_per_week: 3,
    due_date: null,
    status: 'assigned',
    completion_percentage: 0,
    assigned_by_account_id: 'acct-coach-1',
    assigned_at: '2026-09-18T12:00:00.000Z',
    created_at: '2026-09-18T12:00:00.000Z',
  };

  const LINKED: DrillAssignment = {
    ...ASSIGNMENT_BASE,
    assignment_id: 'assign-linked',
    drill_id: ADOPTED.drill_id,
    drill_name: 'Jab return',
    drill_description: 'Hand home before the next beat.',
    drill_display_name: 'Jab return',
    drill_display_description: 'Hand home before the next beat.',
    drill_category: 'striking',
  };

  // Written before drills had identity: typed text and nothing behind it.
  const LEGACY: DrillAssignment = {
    ...ASSIGNMENT_BASE,
    assignment_id: 'assign-legacy',
    drill_id: null,
    drill_name: 'Shadowbox the cross',
    drill_description: 'Three rounds, cross only.',
    drill_display_name: 'Shadowbox the cross',
    drill_display_description: 'Three rounds, cross only.',
  };

  const LINKED_HOOK: DrillAssignment = {
    ...ASSIGNMENT_BASE,
    assignment_id: 'assign-hook',
    drill_id: ADOPTED_HOOK.drill_id,
    drill_name: 'Lead hook check',
    drill_description: 'Elbow level with the fist.',
    drill_display_name: 'Lead hook check',
    drill_display_description: 'Elbow level with the fist.',
    drill_category: 'striking',
  };

  // 'current': the operational drill the work was issued against is still the
  // one the gym runs, and any of the athlete's work opens the same instruction
  // (athlete_access 'all_work', the Learn rule), so the panel owes the coach no
  // note of any kind.
  const LINKED_INSTRUCTION: AssignmentInstructionResponse = {
    assignment_id: LINKED.assignment_id,
    assigned_by: 'Coach Danielle',
    state: 'available',
    audience: 'coach',
    drill: REFERENCE,
    operational_lifecycle: 'current',
    athlete_access: 'all_work',
  };

  const HOOK_INSTRUCTION: AssignmentInstructionResponse = {
    assignment_id: LINKED_HOOK.assignment_id,
    assigned_by: 'Coach Danielle',
    state: 'available',
    audience: 'coach',
    drill: REFERENCE_HOOK,
    operational_lifecycle: 'current',
    athlete_access: 'all_work',
  };

  // The panel's notes about where the work's drill stands now, and which of an
  // athlete's work opens it, word for word as the coach reads them.
  const CHANGED_NOTE =
    'This gym has changed this drill since the work was issued, and another version of it is in use now. These are the reference instructions this work was issued against.';
  const RETIRED_NOTE =
    'This gym has retired this drill since the work was issued. These are the reference instructions it was issued against.';
  // athlete_access 'open_work_only' (OD-2026-09-19-002): the gym retired the
  // drill, so open work keeps it and closed work does not.
  const ATHLETE_OPEN_WORK_ONLY_NOTE =
    'Athletes can still open these instructions from work that is assigned or in progress, but not from completed, cancelled or incomplete work.';
  // athlete_access 'none': the reference itself was withdrawn.
  const ATHLETE_WITHDRAWN_NOTE =
    'Athletes cannot open these instructions from any work, because the reference drill has been withdrawn.';

  /**
   * Any athlete note the panel can write. The negative checks use it beside
   * the two exact texts, so "no athlete note" cannot pass because a note was
   * reworded. A test below holds the pattern to both texts, so it cannot drift
   * into matching nothing.
   */
  const ANY_ATHLETE_NOTE = /^Athletes (can still|cannot) open these instructions from /;
  const RESTRICTED_INK = 'text-[color:var(--restricted-ink)]';

  /** No note about which of an athlete's work opens the drill, by pattern and by each exact text. */
  function expectNoAthleteNote() {
    expect(screen.queryAllByText(ANY_ATHLETE_NOTE)).toEqual([]);
    expect(screen.queryByText(ATHLETE_OPEN_WORK_ONLY_NOTE)).toBeNull();
    expect(screen.queryByText(ATHLETE_WITHDRAWN_NOTE)).toBeNull();
  }

  interface Sent {
    path: string;
    method: string;
    body: unknown;
  }

  type RosterRow = Pick<CoachRosterAthlete, 'athlete_id' | 'full_name'>;

  // The request's init rides along so a test can hold on to the signal a read
  // was sent with, and see whether the page cancelled it.
  type Answer = (path: string, init?: RequestInit) => Response | Promise<Response>;

  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
  const refused = (status: number) =>
    ({ ok: false, status, json: async () => ({ error: 'unavailable' }) }) as Response;

  /**
   * Every request the page makes, recorded with its verb. The two instruction
   * reads answer explicitly -- by the exact id they carry -- and anything
   * else asked of them is a 404, so a read by the wrong id cannot render.
   *
   * Assignments are answered per athlete, as the server answers them: every
   * fixture assignment is athlete-001's, so another athlete's list is empty.
   * The roster is empty unless a test supplies one, which leaves the page on
   * its free-text athlete input.
   */
  function journeyFetch(
    sent: Sent[],
    answers: {
      reference?: Answer;
      instruction?: Answer;
      assignments?: DrillAssignment[];
      drills?: LibraryDrill[];
      roster?: RosterRow[];
    } = {},
  ) {
    const references = [REFERENCE, REFERENCE_HOOK];
    const reference: Answer =
      answers.reference ??
      ((path) => {
        const drill = references.find((candidate) => path.endsWith(`?drill_id=${candidate.drill_id}`));
        return drill ? ok({ drill }) : refused(404);
      });
    const instructions = [LINKED_INSTRUCTION, HOOK_INSTRUCTION];
    const instruction: Answer =
      answers.instruction ??
      ((path) => {
        const found = instructions.find((candidate) => path.endsWith(`?assignment_id=${candidate.assignment_id}`));
        return found ? ok(found) : refused(404);
      });
    const assignments = answers.assignments ?? [LINKED, LEGACY];
    const drills = answers.drills ?? [ADOPTED, GYM_WRITTEN];

    return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.slice(url.indexOf('/api/'));
      const method = (init?.method ?? 'GET').toUpperCase();
      sent.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

      if (path.startsWith('/api/pilot/drill-library?drill_id=')) return reference(path, init);
      if (path.startsWith('/api/pilot/progression/drill-instruction?assignment_id=')) return instruction(path, init);
      if (path.endsWith('/api/pilot/athletes/list')) return ok({ items: answers.roster ?? [] });
      if (path.endsWith('/api/pilot/drills')) return ok({ items: drills });
      if (path.includes('/progression/assignments') && method === 'POST') return ok({ ok: true });
      if (path.includes('/progression/assignments')) {
        return ok({ items: assignments.filter((assignment) => path.endsWith(`?athlete_id=${assignment.athlete_id}`)) });
      }
      if (path.includes('/progression/gaps')) return ok({ items: [GAP] });
      if (path.includes('/api/pilot/training-holds')) return ok({ ok: true, holds: [] });
      if (path.includes('/rabbit-holes/get')) return ok({ ok: true, rabbit_holes: [] });
      return ok({ items: [] });
    });
  }

  async function openBoard(sent: Sent[], answers: Parameters<typeof journeyFetch>[1] = {}) {
    await renderWithAthlete(journeyFetch(sent, answers));
    await screen.findByText('Rear foot stays flat through the cross.');
    await screen.findByRole('heading', { name: `Assigned Drills (${(answers.assignments ?? [LINKED, LEGACY]).length})` });
  }

  async function click(element: HTMLElement) {
    await act(async () => {
      fireEvent.click(element);
    });
  }

  async function openAssignForm() {
    await click(screen.getByRole('button', { name: 'Assign drill' }));
  }

  async function pick(drillId: string) {
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Drill'), { target: { value: drillId } });
    });
  }

  // By id: with the assign form open, the picked drill's control and the
  // matching assignment's control carry the same label, because they name the
  // same drill. The id says which one is meant.
  function toggle(id: string): HTMLButtonElement {
    const element = document.getElementById(id);
    if (!(element instanceof HTMLButtonElement)) throw new Error(`no button #${id}`);
    return element;
  }

  const writes = (sent: Sent[]) => sent.filter((request) => request.method !== 'GET');

  /** The polite live region a line of the panel sits in, or null when it sits in none. */
  const liveRegionOf = (element: HTMLElement) => element.closest('[role="status"][aria-live="polite"]');

  /**
   * A note about where the work's drill stands, found where the panel is meant
   * to put it: inside the opened drill's own header, after the heading focus
   * lands on and the content-status line it qualifies, and before the Safety
   * section -- so reading forward from the heading reaches it before the
   * instruction. Not in the live region, which says only what the toggle
   * produced.
   */
  function headerNote(article: HTMLElement, text: string): HTMLElement {
    const note = within(article).getByText(text);
    expect(note.closest('header')?.parentElement).toBe(article);

    const follows = (earlier: Node, later: Node) =>
      Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
    const heading = within(article).getByRole('heading', { level: 2 });
    const contentStatus = within(article).getByText(/^Content: /);
    const safety = within(article).getByRole('region', { name: 'Safety' });
    expect(follows(heading, note)).toBe(true);
    expect(follows(contentStatus, note)).toBe(true);
    expect(follows(note, safety)).toBe(true);

    expect(liveRegionOf(note)).toBeNull();
    return note;
  }

  /** The panel's live region says what the toggle produced, and nothing else. */
  function expectLiveRegionSaysOnlyOpened(name: string) {
    const announcement = screen.getByText(`${name}: instructions open below.`);
    expect(liveRegionOf(announcement)?.textContent).toBe(`${name}: instructions open below.`);
  }

  /**
   * An answer the test releases when it chooses. It ignores the abort signal
   * on purpose: a response already on its way when the page cancels is the
   * case the page's own ordering has to survive.
   */
  function heldAnswer(body: unknown) {
    let release: () => void = () => {};
    const answer = new Promise<Response>((resolve) => {
      release = () => resolve(ok(body));
    });
    return { answer, release: () => act(async () => release()) };
  }

  /**
   * Whether `text` is put on screen at any point from now until the returned
   * check is called -- not only whether it is there at the end. A stale answer
   * that lands and is then replaced would pass a query made afterwards.
   */
  function watchScreenFor(text: string) {
    let seen = document.body.textContent?.includes(text) ?? false;
    const inspect = (records: MutationRecord[]) => {
      for (const record of records) {
        if (record.type === 'characterData' && record.target.textContent?.includes(text)) seen = true;
        for (const node of Array.from(record.addedNodes)) {
          if (node.textContent?.includes(text)) seen = true;
        }
      }
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    return () => {
      inspect(observer.takeRecords());
      observer.disconnect();
      return seen || (document.body.textContent?.includes(text) ?? false);
    };
  }

  /** One animation frame: when a close that hands focus back would move it. */
  const nextFrame = () =>
    act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

  describe('before assigning: the drill the coach picked', () => {
    test('offers its instructions only when the gym adopted it from the reference library', async () => {
      await openBoard([]);
      await openAssignForm();

      await pick(GYM_WRITTEN.drill_id);
      expect(screen.getByText('Written by this gym, so there are no reference instructions to open.')).toBeTruthy();
      expect(document.getElementById('assign-picked-instructions')).toBeNull();

      await pick(ADOPTED.drill_id);
      const opener = toggle('assign-picked-instructions');
      expect(opener.getAttribute('aria-label')).toBe('View instructions: Jab return');
      expect(opener.getAttribute('aria-expanded')).toBe('false');
      expect(opener.textContent).toBe('View instructions');
      expect(screen.queryByText(/Written by this gym, so there are no reference instructions/)).toBeNull();
    });

    test('opens by GETting the exact reference version it adopted, and renders the full drill', async () => {
      const sent: Sent[] = [];
      await openBoard(sent);
      await openAssignForm();
      await pick(ADOPTED.drill_id);

      const before = sent.length;
      await click(toggle('assign-picked-instructions'));

      const article = await screen.findByRole('article', { name: 'Seeded jab return' });
      // Safety is the first section and always open: the stop rule reads
      // without another click.
      expect(within(article).getByRole('region', { name: 'Safety' }).textContent).toContain(
        'Stop when the hand stops coming home.',
      );

      // One read, by the pointer the operational drill carries -- not by the
      // operational id, and not by the drill's name.
      expect(sent.slice(before).map((request) => [request.method, request.path])).toEqual([
        ['GET', '/api/pilot/drill-library?drill_id=reference-jab-v1'],
      ]);

      const opener = toggle('assign-picked-instructions');
      expect(opener.getAttribute('aria-expanded')).toBe('true');
      expect(opener.getAttribute('aria-label')).toBe('Hide instructions: Jab return');

      // What the toggle produced is also said, in the panel's polite live
      // region, so a screen-reader user hears it as well as a sighted one
      // sees it.
      expect(liveRegionOf(screen.getByText('Seeded jab return: instructions open below.'))).not.toBeNull();

      // A preview is not assigned work: there is no work for the athlete to
      // open it from, and no issued version for the gym to have moved away
      // from. The read does not say, and the panel must not read "does not
      // say" as either "only open work" or "no work".
      expectNoAthleteNote();
      expect(screen.queryByText(/This gym has (changed|retired) this drill/)).toBeNull();
    });

    test('changing the pick closes the preview of the drill that is no longer being assigned', async () => {
      await openBoard([]);
      await openAssignForm();
      await pick(ADOPTED.drill_id);
      await click(toggle('assign-picked-instructions'));
      await screen.findByRole('article', { name: 'Seeded jab return' });

      await pick(GYM_WRITTEN.drill_id);

      expect(screen.queryByRole('article', { name: 'Seeded jab return' })).toBeNull();
      expect(screen.getByText('Written by this gym, so there are no reference instructions to open.')).toBeTruthy();

      // Picking it again does not reopen it: the pick chooses, it does not read.
      await pick(ADOPTED.drill_id);
      expect(toggle('assign-picked-instructions').getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByRole('article', { name: 'Seeded jab return' })).toBeNull();
    });

    // W-D4B review B. This test used to move the pick to a drill the gym wrote
    // itself: that drill has no preview to render into, and the pick change
    // had already closed the only one there was, so a stale answer had nowhere
    // to land and the test could not fail. The second pick is now another
    // ADOPTED drill, its preview open and showing, when the first read answers.
    test('a slow answer for the previous pick never lands under the new one', async () => {
      const jab = heldAnswer({ drill: REFERENCE });
      await openBoard([], {
        drills: [ADOPTED, ADOPTED_HOOK, GYM_WRITTEN],
        reference: (path) => {
          if (path.endsWith(`?drill_id=${REFERENCE.drill_id}`)) return jab.answer;
          return path.endsWith(`?drill_id=${REFERENCE_HOOK.drill_id}`) ? ok({ drill: REFERENCE_HOOK }) : refused(404);
        },
      });
      await openAssignForm();
      await pick(ADOPTED.drill_id);
      const jabShown = watchScreenFor('Seeded jab return');
      await click(toggle('assign-picked-instructions'));
      expect(liveRegionOf(screen.getByText('Loading the drill…'))).not.toBeNull();

      await pick(ADOPTED_HOOK.drill_id);
      await click(toggle('assign-picked-instructions'));
      await screen.findByRole('article', { name: 'Seeded lead hook' });

      // The first pick's answer finally arrives, last.
      await jab.release();

      const hook = screen.getByRole('article', { name: 'Seeded lead hook' });
      expect(within(hook).getByRole('region', { name: 'Safety' }).textContent).toContain(
        'Stop when the elbow drops below the fist.',
      );
      expect(toggle('assign-picked-instructions').getAttribute('aria-label')).toBe('Hide instructions: Lead hook check');
      expect(screen.getAllByRole('article')).toHaveLength(1);
      expect(jabShown()).toBe(false);
    });

    // A close that is a side effect of something else the coach is doing does
    // not move them: they are in the picker, choosing, and the toggle they
    // would be thrown to is one they did not press.
    test('changing the pick leaves focus on the drill picker', async () => {
      await openBoard([], { drills: [ADOPTED, ADOPTED_HOOK, GYM_WRITTEN] });
      await openAssignForm();
      await pick(ADOPTED.drill_id);
      await click(toggle('assign-picked-instructions'));
      await screen.findByRole('article', { name: 'Seeded jab return' });

      const picker = document.getElementById('library-pick');
      if (!(picker instanceof HTMLSelectElement)) throw new Error('no select#library-pick');
      picker.focus();
      // To another adopted drill, so a toggle with the preview's id is on
      // screen for a focus hand-back to land on.
      await pick(ADOPTED_HOOK.drill_id);
      await nextFrame();
      await nextFrame();

      expect(screen.queryByRole('article', { name: 'Seeded jab return' })).toBeNull();
      expect(toggle('assign-picked-instructions').getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(picker);
    });

    test('collapsing the assign form takes the open preview with it', async () => {
      await openBoard([]);
      await openAssignForm();
      await pick(ADOPTED.drill_id);
      await click(toggle('assign-picked-instructions'));
      await screen.findByRole('article', { name: 'Seeded jab return' });

      await click(screen.getByRole('button', { name: 'Cancel assign' }));
      expect(screen.queryByRole('article', { name: 'Seeded jab return' })).toBeNull();

      // The pick survives the collapse; the preview does not. Reopened, the
      // form still has the drill chosen and its instructions closed -- not
      // expanded again, unasked.
      await openAssignForm();
      expect((screen.getByLabelText('Drill') as HTMLSelectElement).value).toBe(ADOPTED.drill_id);
      expect(toggle('assign-picked-instructions').getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByRole('article', { name: 'Seeded jab return' })).toBeNull();
      expect(screen.queryByText('Loading the drill…')).toBeNull();
    });

    test('assigning while the preview is still loading cancels its read', async () => {
      let signal: AbortSignal | null | undefined;
      const jab = heldAnswer({ drill: REFERENCE });
      await openBoard([], {
        reference: (_path, init) => {
          signal = init?.signal;
          return jab.answer;
        },
      });
      await openAssignForm();
      await pick(ADOPTED.drill_id);
      await click(toggle('assign-picked-instructions'));
      expect(screen.getByText('Loading the drill…')).toBeTruthy();
      expect(signal?.aborted).toBe(false);

      await click(screen.getByRole('button', { name: 'Assign drill' }));

      expect(signal?.aborted).toBe(true);
      expect(screen.queryByText('Loading the drill…')).toBeNull();
    });

    test('previewing leaves the assign request exactly as it was', async () => {
      const sent: Sent[] = [];
      await openBoard(sent);
      await openAssignForm();
      await pick(ADOPTED.drill_id);

      const before = sent.length;
      await click(toggle('assign-picked-instructions'));
      await screen.findByRole('article', { name: 'Seeded jab return' });
      await click(screen.getByRole('button', { name: 'Assign drill' }));

      // The one write since the preview opened is the assignment the coach
      // asked for, and its body is the W-D3 body to the key: toEqual, so no
      // drill wording and no reference pointer rode along with it.
      const sinceOpened = writes(sent.slice(before));
      expect(sinceOpened.map((request) => [request.method, request.path])).toEqual([
        ['POST', '/api/pilot/progression/assignments'],
      ]);
      expect(sinceOpened[0].body).toEqual({
        gap_id: 'gap-1',
        athlete_id: 'athlete-001',
        drill_id: 'drill-jab-return',
        drill_difficulty: 'intermediate',
      });

      // The preview belonged to the form, and goes with it.
      expect(screen.queryByRole('article', { name: 'Seeded jab return' })).toBeNull();
    });
  });

  describe('after assigning: each assigned drill', () => {
    test('with a drill behind it opens the instruction its assignment links to, read by the assignment id', async () => {
      const sent: Sent[] = [];
      await openBoard(sent);

      const before = sent.length;
      await click(screen.getByRole('button', { name: 'View instructions: Jab return' }));

      const article = await screen.findByRole('article', { name: 'Seeded jab return' });
      expect(within(article).getByRole('region', { name: 'Safety' }).textContent).toContain(
        'Stop when the hand stops coming home.',
      );

      // The page asks by the assignment and nothing else. It does not resolve
      // the drill's pointer itself: which version the work was issued against
      // is the server's answer, so there is no client lookup that could land
      // on a newer version instead.
      expect(sent.slice(before).map((request) => [request.method, request.path])).toEqual([
        ['GET', '/api/pilot/progression/drill-instruction?assignment_id=assign-linked'],
      ]);

      const opener = toggle('assignment-instructions-assign-linked');
      expect(opener.getAttribute('aria-expanded')).toBe('true');
      expect(opener.getAttribute('aria-label')).toBe('Hide instructions: Jab return');

      // Still the drill the gym runs, and any of the athlete's work opens it
      // too: no note of any kind, in the drill's header or anywhere else.
      expect(screen.queryByText(/This gym has changed this drill/)).toBeNull();
      expect(screen.queryByText(/This gym has retired this drill/)).toBeNull();
      expectNoAthleteNote();
      expectLiveRegionSaysOnlyOpened('Seeded jab return');
    });

    test('with no drill behind it -- a legacy row -- offers nothing to open', async () => {
      await openBoard([]);

      expect(screen.getByText('Shadowbox the cross')).toBeTruthy();
      expect(document.getElementById('assignment-instructions-assign-legacy')).toBeNull();
      expect(screen.queryByRole('button', { name: /instructions: Shadowbox the cross/ })).toBeNull();

      // The list's only instruction control is the linked assignment's.
      expect(screen.getAllByRole('button', { name: /^View instructions: / }).map((button) => button.id)).toEqual([
        'assignment-instructions-assign-linked',
      ]);
    });

    test('the same control hides it again, asks nothing more, and hands focus back', async () => {
      const sent: Sent[] = [];
      await openBoard(sent);
      await click(screen.getByRole('button', { name: 'View instructions: Jab return' }));
      await screen.findByRole('article', { name: 'Seeded jab return' });

      const before = sent.length;
      await click(screen.getByRole('button', { name: 'Hide instructions: Jab return' }));

      expect(screen.queryByRole('article', { name: 'Seeded jab return' })).toBeNull();
      const opener = screen.getByRole('button', { name: 'View instructions: Jab return' });
      expect(opener.getAttribute('aria-expanded')).toBe('false');
      expect(sent.slice(before)).toEqual([]);
      await waitFor(() => expect(document.activeElement).toBe(opener));
    });

    // "Changed" and "retired" are different facts, and the panel must not
    // collapse them: adopting a refinement deactivates the version it replaces,
    // so an inactive operational row alone does not mean the gym stopped
    // running the drill. The server says which (operational_lifecycle); the
    // panel says it in words, in the drill's own header.
    //
    // Retired with no active successor is also the case where the athlete's
    // Learn read (promoted-and-live) no longer finds the reference, but the
    // open-work read still does (OD-2026-09-19-002), so the fixture carries
    // the answer the server gives for it: athlete_access 'open_work_only'.
    test('work issued against a drill the gym has since retired opens at the version it was issued against, and says so', async () => {
      const RETIRED: AssignmentInstructionResponse = {
        assignment_id: LINKED.assignment_id,
        assigned_by: 'Coach Danielle',
        state: 'available',
        audience: 'coach',
        drill: { ...REFERENCE, superseded_at: '2026-09-18T00:00:00.000Z' },
        operational_lifecycle: 'retired',
        athlete_access: 'open_work_only',
      };
      await openBoard([], { instruction: () => ok(RETIRED) });

      await click(screen.getByRole('button', { name: 'View instructions: Jab return' }));

      const article = await screen.findByRole('article', { name: 'Seeded jab return' });
      const retired = headerNote(article, RETIRED_NOTE);
      const athlete = headerNote(article, ATHLETE_OPEN_WORK_ONLY_NOTE);
      // Where the drill stands first, then which of the athlete's work still
      // opens it.
      expect(retired.compareDocumentPosition(athlete) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // One athlete note, and it is the open-work one: a retired drill is not a
      // withdrawn reference, and the coach must not be told no work opens it.
      expect(screen.getAllByText(ANY_ATHLETE_NOTE)).toEqual([athlete]);
      expect(screen.queryByText(ATHLETE_WITHDRAWN_NOTE)).toBeNull();
      // Open work keeps the drill, so the athlete line is information, not a
      // restriction: it is not in the restricted ink the retirement is.
      expect(retired.className).toContain(RESTRICTED_INK);
      expect(athlete.className).not.toContain(RESTRICTED_INK);
      expect(screen.queryByText(/This gym has changed this drill/)).toBeNull();
      // The version shown is the one the server named, labelled as superseded
      // -- not quietly swapped for whatever is current.
      expect(within(article).getByText(/Superseded by a newer version\./)).toBeTruthy();
      expectLiveRegionSaysOnlyOpened('Seeded jab return');
    });

    // A refinement carries the reference pointer forward to an active
    // successor, so the athlete's Learn read still finds it and any work opens
    // it: nothing to say about the athlete.
    test('work issued against a drill the gym has since changed says it changed, not that it was retired', async () => {
      const CHANGED: AssignmentInstructionResponse = {
        assignment_id: LINKED.assignment_id,
        assigned_by: 'Coach Danielle',
        state: 'available',
        audience: 'coach',
        drill: REFERENCE,
        operational_lifecycle: 'changed',
        athlete_access: 'all_work',
      };
      await openBoard([], { instruction: () => ok(CHANGED) });

      await click(screen.getByRole('button', { name: 'View instructions: Jab return' }));

      const article = await screen.findByRole('article', { name: 'Seeded jab return' });
      headerNote(article, CHANGED_NOTE);
      expect(screen.queryByText(/This gym has retired this drill/)).toBeNull();
      expectNoAthleteNote();
      expectLiveRegionSaysOnlyOpened('Seeded jab return');
    });

    // The coach read has no active filter, so a coach can still read a
    // reference the library has withdrawn -- and the athlete cannot, from any
    // work: both athlete reads keep the active term, and OD-2026-09-19-002's
    // open-work exception does not reach a withdrawn reference. The operational
    // drill is still the one the gym runs, so this note is the only one: a
    // coach reading it should not send the athlete to go and read it.
    test('work whose instructions the athlete can no longer open from any work says so, even while the drill is still current', async () => {
      const WITHDRAWN: AssignmentInstructionResponse = {
        ...LINKED_INSTRUCTION,
        drill: { ...REFERENCE, active: false },
        operational_lifecycle: 'current',
        athlete_access: 'none',
      };
      await openBoard([], { instruction: () => ok(WITHDRAWN) });

      await click(screen.getByRole('button', { name: 'View instructions: Jab return' }));

      const article = await screen.findByRole('article', { name: 'Seeded jab return' });
      const note = headerNote(article, ATHLETE_WITHDRAWN_NOTE);
      // Plain text in the header, not a second alert channel -- but in the
      // restricted ink: no work of the athlete's opens it.
      expect(note.getAttribute('role')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(note.className).toContain(RESTRICTED_INK);
      // One athlete note, and it is not the open-work one: a withdrawn
      // reference is withheld from open work too.
      expect(screen.getAllByText(ANY_ATHLETE_NOTE)).toEqual([note]);
      expect(screen.queryByText(ATHLETE_OPEN_WORK_ONLY_NOTE)).toBeNull();
      expect(screen.queryByText(/This gym has (changed|retired) this drill/)).toBeNull();
      expect(within(article).getByText(/Retracted\./)).toBeTruthy();
      // The full drill still opens for the coach: the note qualifies it, it
      // does not replace it.
      expect(within(article).getByRole('region', { name: 'Safety' }).textContent).toContain(
        'Stop when the hand stops coming home.',
      );
      expectLiveRegionSaysOnlyOpened('Seeded jab return');
    });

    // Retired AND withdrawn: the withdrawal is the stronger fact for the
    // athlete, so the server answers 'none' and the open-work exception is not
    // offered. Both notes are said, the drill's standing first.
    test('work on a retired drill whose reference was also withdrawn says both, and that no work opens it', async () => {
      const RETIRED_AND_WITHDRAWN: AssignmentInstructionResponse = {
        ...LINKED_INSTRUCTION,
        drill: { ...REFERENCE, active: false },
        operational_lifecycle: 'retired',
        athlete_access: 'none',
      };
      await openBoard([], { instruction: () => ok(RETIRED_AND_WITHDRAWN) });

      await click(screen.getByRole('button', { name: 'View instructions: Jab return' }));

      const article = await screen.findByRole('article', { name: 'Seeded jab return' });
      const retired = headerNote(article, RETIRED_NOTE);
      const athlete = headerNote(article, ATHLETE_WITHDRAWN_NOTE);
      expect(retired.compareDocumentPosition(athlete) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getAllByText(ANY_ATHLETE_NOTE)).toEqual([athlete]);
      expect(screen.queryByText(ATHLETE_OPEN_WORK_ONLY_NOTE)).toBeNull();
      expectLiveRegionSaysOnlyOpened('Seeded jab return');
    });

    // The negative checks above lean on ANY_ATHLETE_NOTE. Held to both texts
    // here, so a check that finds no athlete note is finding neither of them.
    test('the any-athlete-note pattern matches both athlete notes the panel can write', () => {
      expect(ATHLETE_OPEN_WORK_ONLY_NOTE).toMatch(ANY_ATHLETE_NOTE);
      expect(ATHLETE_WITHDRAWN_NOTE).toMatch(ANY_ATHLETE_NOTE);
    });

    // The assigned-list twin of the slow-pick test: two drills that can both
    // render, the first read held, the second answering first.
    test('a slow answer for one assigned drill never lands under another opened after it', async () => {
      const jab = heldAnswer(LINKED_INSTRUCTION);
      await openBoard([], {
        assignments: [LINKED, LINKED_HOOK],
        instruction: (path) => {
          if (path.endsWith(`?assignment_id=${LINKED.assignment_id}`)) return jab.answer;
          return path.endsWith(`?assignment_id=${LINKED_HOOK.assignment_id}`) ? ok(HOOK_INSTRUCTION) : refused(404);
        },
      });
      const jabShown = watchScreenFor('Seeded jab return');

      await click(screen.getByRole('button', { name: 'View instructions: Jab return' }));
      expect(screen.getByText('Loading the drill…')).toBeTruthy();

      await click(screen.getByRole('button', { name: 'View instructions: Lead hook check' }));
      await screen.findByRole('article', { name: 'Seeded lead hook' });

      await jab.release();

      const hook = screen.getByRole('article', { name: 'Seeded lead hook' });
      expect(within(hook).getByRole('region', { name: 'Safety' }).textContent).toContain(
        'Stop when the elbow drops below the fist.',
      );
      expect(screen.getAllByRole('article')).toHaveLength(1);
      expect(toggle('assignment-instructions-assign-linked').getAttribute('aria-expanded')).toBe('false');
      expect(toggle('assignment-instructions-assign-hook').getAttribute('aria-expanded')).toBe('true');
      expect(jabShown()).toBe(false);
    });

    test("an assigned drill the gym wrote itself opens to the gym's-own-wording note, not an empty panel", async () => {
      const GYM_ASSIGNMENT: DrillAssignment = {
        ...ASSIGNMENT_BASE,
        assignment_id: 'assign-gym',
        drill_id: GYM_WRITTEN.drill_id,
        drill_name: 'Rear-foot pivot',
        drill_description: 'Heel up before the cross lands.',
        drill_display_name: 'Rear-foot pivot',
        drill_display_description: 'Heel up before the cross lands.',
      };
      const GYM_WRITTEN_INSTRUCTION: AssignmentInstructionResponse = {
        assignment_id: GYM_ASSIGNMENT.assignment_id,
        assigned_by: 'Coach Danielle',
        state: 'gym_written',
      };
      await openBoard([], {
        assignments: [GYM_ASSIGNMENT],
        instruction: (path) =>
          path.endsWith('?assignment_id=assign-gym') ? ok(GYM_WRITTEN_INSTRUCTION) : refused(404),
      });

      await click(screen.getByRole('button', { name: 'View instructions: Rear-foot pivot' }));

      const note = await screen.findByText(/This drill was written by this gym, so there are no reference instructions/);
      expect(liveRegionOf(note)).not.toBeNull();
      expect(screen.queryByRole('article')).toBeNull();
    });
  });

  // A drill opened for one athlete's work belongs to that athlete's screen.
  // Moving to another athlete closes it -- and cancels its read if it is still
  // in flight -- so it cannot come back expanded, unasked, when the coach
  // returns, nor land late over a list it no longer belongs to. The page has
  // two ways to move: the roster select, and the free-text id it falls back to
  // when there is no roster. Both go through the same handler, and both are
  // held here.
  describe('moving to another athlete', () => {
    const ROSTER: RosterRow[] = [
      { athlete_id: 'athlete-001', full_name: 'Rosa Delgado' },
      { athlete_id: 'athlete-002', full_name: 'Tomas Reyes' },
    ];

    // The same label names the select and the free-text input.
    async function chooseAthlete(athleteId: string) {
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Select Athlete'), { target: { value: athleteId } });
      });
    }

    async function awayAndBackWithAReadInFlight(roster: RosterRow[]) {
      let signal: AbortSignal | null | undefined;
      const jab = heldAnswer(LINKED_INSTRUCTION);
      global.fetch = journeyFetch([], {
        roster,
        instruction: (_path, init) => {
          signal = init?.signal;
          return jab.answer;
        },
      }) as unknown as typeof fetch;

      await act(async () => {
        render(<CoachProgressionIntelligencePage />);
      });
      const athleteControl = screen.getByLabelText('Select Athlete');
      expect(athleteControl.tagName).toBe(roster.length > 0 ? 'SELECT' : 'INPUT');

      await chooseAthlete('athlete-001');
      await screen.findByRole('heading', { name: 'Assigned Drills (2)' });
      const jabShown = watchScreenFor('Seeded jab return');
      await click(toggle('assignment-instructions-assign-linked'));
      expect(screen.getByText('Loading the drill…')).toBeTruthy();
      expect(signal?.aborted).toBe(false);

      await chooseAthlete('athlete-002');
      await screen.findByRole('heading', { name: 'Assigned Drills (0)' });
      expect(signal?.aborted).toBe(true);

      await chooseAthlete('athlete-001');
      await screen.findByRole('heading', { name: 'Assigned Drills (2)' });
      const opener = toggle('assignment-instructions-assign-linked');
      expect(opener.getAttribute('aria-expanded')).toBe('false');
      expect(opener.getAttribute('aria-label')).toBe('View instructions: Jab return');
      expect(screen.queryByText('Loading the drill…')).toBeNull();

      // The abandoned read answers now, and has nowhere to land.
      await jab.release();
      expect(toggle('assignment-instructions-assign-linked').getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByRole('article')).toBeNull();
      expect(jabShown()).toBe(false);
    }

    test('by the roster select closes an open drill and cancels its read', async () => {
      await awayAndBackWithAReadInFlight(ROSTER);
    });

    test('by the free-text athlete id closes an open drill and cancels its read', async () => {
      await awayAndBackWithAReadInFlight([]);
    });
  });

  describe('a read that fails', () => {
    test('from an assigned drill says the instructions did not load, not that there are none', async () => {
      const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
      await openBoard([], { instruction: () => refused(503) });

      await click(screen.getByRole('button', { name: 'View instructions: Jab return' }));

      const failure = await screen.findByText(
        /The drill's instructions did not load\. This is a failure to load, not a missing drill/,
      );
      // Said in the panel's one polite live region, and with no role of its
      // own: a second live region would announce it twice, and this is not the
      // failed write the page's alert channel is kept for.
      expect(liveRegionOf(failure)).not.toBeNull();
      expect(failure.getAttribute('role')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('article', { name: 'Seeded jab return' })).toBeNull();
      expect(screen.queryByText(/not in this gym's library/)).toBeNull();
      expect(screen.queryByText(/written by this gym/)).toBeNull();
      // Logged for whoever debugs it; the status code is not what the coach reads.
      expect(logged).toHaveBeenCalledWith(expect.objectContaining({ event: 'drill-instruction-load-failed' }));
      expect(document.body.textContent).not.toMatch(/\b503\b/);
    });

    test('from the picked drill says the same thing', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      await openBoard([], { reference: () => refused(503) });
      await openAssignForm();
      await pick(ADOPTED.drill_id);

      await click(toggle('assign-picked-instructions'));

      const failure = await screen.findByText(/The drill's instructions did not load/);
      expect(liveRegionOf(failure)).not.toBeNull();
      expect(failure.getAttribute('role')).toBeNull();
      expect(screen.queryByRole('article', { name: 'Seeded jab return' })).toBeNull();
    });

    test('is told apart from a reference the library does not hold', async () => {
      await openBoard([], { reference: () => refused(404) });
      await openAssignForm();
      await pick(ADOPTED.drill_id);

      await click(toggle('assign-picked-instructions'));

      const note = await screen.findByText("This drill's reference instructions are not in this gym's library.");
      expect(liveRegionOf(note)).not.toBeNull();
      expect(screen.queryByText(/did not load/)).toBeNull();
    });
  });

  test('no preview action, in either place, sends anything but a GET', async () => {
    const sent: Sent[] = [];
    await openBoard(sent);
    const before = sent.length;

    // Every instruction control, opened and closed, and one open handed
    // straight to the other.
    await click(screen.getByRole('button', { name: 'View instructions: Jab return' }));
    await screen.findByRole('article', { name: 'Seeded jab return' });
    await click(screen.getByRole('button', { name: 'Hide instructions: Jab return' }));

    await openAssignForm();
    await pick(GYM_WRITTEN.drill_id);
    await pick(ADOPTED.drill_id);
    await click(toggle('assign-picked-instructions'));
    await screen.findByRole('article', { name: 'Seeded jab return' });
    await click(toggle('assignment-instructions-assign-linked'));
    await screen.findByRole('article', { name: 'Seeded jab return' });
    // One drill open at a time: opening the assignment's closed the preview.
    expect(toggle('assignment-instructions-assign-linked').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('assign-picked-instructions').getAttribute('aria-expanded')).toBe('false');
    await click(toggle('assignment-instructions-assign-linked'));

    const previewed = sent.slice(before);
    expect(writes(previewed)).toEqual([]);
    // And what was sent was the instruction reads and nothing else.
    expect(previewed.map((request) => [request.method, request.path])).toEqual([
      ['GET', '/api/pilot/progression/drill-instruction?assignment_id=assign-linked'],
      ['GET', '/api/pilot/drill-library?drill_id=reference-jab-v1'],
      ['GET', '/api/pilot/progression/drill-instruction?assignment_id=assign-linked'],
    ]);
  });
});
