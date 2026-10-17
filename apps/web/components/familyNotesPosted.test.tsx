/**
 * @jest-environment jsdom
 */

// The coach's read-back of what the gym posted to a family (#1542, FC-01):
// each note, who posted it, when in gym time, its due date, and the family's
// done / still-to-do state. A failed read says so, never "nothing posted".

import '@testing-library/jest-dom';
import { act, render, screen, within } from '@testing-library/react';

import FamilyNotesPosted, { type FamilyNoteRow } from './FamilyNotesPosted';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const DONE: FamilyNoteRow = {
  note_id: 'n2',
  note_text: 'Medical form by Friday, please.',
  // 7:02 PM Eastern on 2026-10-13 is 23:02 UTC.
  posted_at: '2026-10-13T22:40:00.000Z',
  posted_by_name: 'Coach Pat',
  task: { due_date: '2026-10-16', completed_at: '2026-10-13T23:02:00.000Z' },
};
const OPEN: FamilyNoteRow = {
  note_id: 'n1',
  note_text: 'Bring gloves Thursday.',
  posted_at: '2026-10-12T21:00:00.000Z',
  posted_by_name: 'Coach Sam',
  task: { due_date: '2026-10-15', completed_at: null },
};
const UNDATED: FamilyNoteRow = {
  note_id: 'n0',
  note_text: 'Great week.',
  posted_at: '2026-10-11T21:00:00.000Z',
  posted_by_name: 'Coach Sam',
  task: null,
};

afterEach(() => {
  jest.restoreAllMocks();
});

// The panel reads the notes and, alongside them, the family's replies (FC-03).
// Each answers its own URL.
function byUrl(
  notes: () => Response,
  replies: () => Response = () => jsonResponse({ items: [] }),
  opened: () => Response = () => jsonResponse({ items: [] }),
  // This staff member's own seen replies (FC-09b); POSTs answer ok.
  seen: () => Response = () => jsonResponse({ items: [] }),
): jest.Mock {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/family-reply-reads')) return init?.method === 'POST' ? jsonResponse({ ok: true }) : seen();
    if (url.includes('/family-message-replies')) return replies();
    // Whether the family opened each note (FC-05).
    if (url.includes('/family-message-reads')) return opened();
    return notes();
  });
}

test('each note reads with its author, gym time, due date and the family state, in the order the server gives', async () => {
  const fetchMock = byUrl(() => jsonResponse({ items: [DONE, OPEN, UNDATED] }));
  global.fetch = fetchMock as unknown as typeof fetch;

  await act(async () => {
    render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
  });

  const items = screen.getAllByRole('listitem');
  expect(items.map((item) => item.querySelector('.t-body')?.textContent)).toEqual([
    'Medical form by Friday, please.',
    'Bring gloves Thursday.',
    'Great week.',
  ]);
  expect(items[0]!.textContent).toContain('Coach Pat');
  expect(items[0]!.textContent).toMatch(/Done .*7:02/);
  expect(items[0]!.textContent).toContain('Due ');
  expect(items[1]!.textContent).toContain('Still to do');
  // No due date and never ticked: no state is invented for it.
  expect(items[2]!.textContent).not.toMatch(/Still to do|Done/);
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/api/pilot/coach/family-notes?athlete_id=ath-1'),
    expect.anything(),
  );
});

test('a failed read says so, and never that nothing was posted', async () => {
  global.fetch = jest.fn(async () => jsonResponse({ error: 'boom' }, false)) as unknown as typeof fetch;

  await act(async () => {
    render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
  });

  expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
  expect(screen.queryByText(/Nothing has been posted/)).toBeNull();
});

test('an empty read says nothing has been posted yet', async () => {
  global.fetch = jest.fn(async () => jsonResponse({ items: [] })) as unknown as typeof fetch;

  await act(async () => {
    render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
  });

  expect(screen.getByText('Nothing has been posted to this family yet.')).toBeInTheDocument();
});

test('a new refreshKey re-reads, so a note just posted appears', async () => {
  let notesReads = 0;
  const fetchMock = byUrl(() => jsonResponse({ items: (notesReads += 1) === 1 ? [] : [OPEN] }));
  global.fetch = fetchMock as unknown as typeof fetch;

  // render() wraps itself in act; the second act lets the first read settle.
  const view = render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
  await act(async () => {});
  await act(async () => {
    view.rerender(<FamilyNotesPosted athleteId="ath-1" refreshKey={1} />);
  });

  expect(notesReads).toBe(2);
  expect(screen.getByText('Bring gloves Thursday.')).toBeInTheDocument();
});

test("the render right after a switch shows loading, not the last athlete's notes", async () => {
  let finishSecond: ((value: Response) => void) | null = null;
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    if (String(input).includes('athlete_id=ath-2')) {
      return new Promise<Response>((resolve) => { finishSecond = resolve; });
    }
    return Promise.resolve(jsonResponse({ items: [OPEN] }));
  }) as unknown as typeof fetch;

  // render() wraps itself in act; the second act lets the first read settle.
  const view = render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
  await act(async () => {});
  expect(screen.getByText('Bring gloves Thursday.')).toBeInTheDocument();

  view.rerender(<FamilyNotesPosted athleteId="ath-2" refreshKey={0} />);
  expect(screen.queryByText('Bring gloves Thursday.')).toBeNull();
  expect(screen.getByText('Loading what was posted…')).toBeInTheDocument();

  await act(async () => {
    finishSecond?.(jsonResponse({ items: [] }));
  });
});

test("a slow read for the athlete just left never shows under the next athlete's name", async () => {
  let finishFirst: ((value: Response) => void) | null = null;
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    if (String(input).includes('athlete_id=ath-1')) {
      return new Promise<Response>((resolve) => { finishFirst = resolve; });
    }
    return Promise.resolve(jsonResponse({ items: [] }));
  }) as unknown as typeof fetch;

  // render() wraps itself in act; the second act lets the first read settle.
  const view = render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
  await act(async () => {});
  await act(async () => {
    view.rerender(<FamilyNotesPosted athleteId="ath-2" refreshKey={0} />);
  });
  await act(async () => {
    finishFirst?.(jsonResponse({ items: [OPEN] }));
  });

  expect(screen.queryByText('Bring gloves Thursday.')).toBeNull();
  expect(screen.getByText('Nothing has been posted to this family yet.')).toBeInTheDocument();
});

/*
 * FAMILY REPLIES (FC-03): under each note, what the family wrote back, oldest
 * first, with the guardian's name and the time in gym time. Replies sit under
 * the note they answer, not another. A failed replies read says so and the
 * notes still show.
 */
describe('family replies under each note (FC-03)', () => {
  const REPLIES = [
    { reply_id: 'r1', note_id: 'n1', reply_text: 'Will do, thanks.', created_at: '2026-10-12T23:30:00.000Z', author_name: 'Alex Parent' },
    { reply_id: 'r2', note_id: 'n1', reply_text: 'Gloves are packed.', created_at: '2026-10-13T00:15:00.000Z', author_name: 'Jordan Parent' },
    { reply_id: 'r3', note_id: 'n2', reply_text: 'Form dropped off.', created_at: '2026-10-13T23:30:00.000Z', author_name: 'A guardian' },
  ];

  test('each note lists its own replies, in order, with who and when', async () => {
    const fetchMock = byUrl(() => jsonResponse({ items: [DONE, OPEN] }), () => jsonResponse({ items: REPLIES }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => {
      render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
    });

    const lists = screen.getAllByRole('list', { name: 'Family replies' });
    expect(lists).toHaveLength(2);
    // DONE (n2) is first on the page; OPEN (n1) second.
    expect(lists[0]!.textContent).toContain('A guardian replied');
    expect(lists[0]!.textContent).toContain('Form dropped off.');
    expect(lists[0]!.textContent).not.toContain('Gloves are packed.');
    const second = Array.from(lists[1]!.querySelectorAll('li')).map((item) => item.textContent ?? '');
    expect(second[0]).toMatch(/^Alex Parent replied · .*7:30.*Will do, thanks\.$/);
    expect(second[1]).toMatch(/^Jordan Parent replied · .*8:15.*Gloves are packed\.$/);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/pilot/coach/family-message-replies?athlete_id=ath-1'),
      expect.anything(),
    );
  });

  test('the notes show while the replies are still loading, and the replies fill in when they answer', async () => {
    let finishReplies: ((value: Response) => void) | null = null;
    global.fetch = jest.fn((input: RequestInfo | URL) =>
      (String(input).includes('/family-message-replies')
        ? new Promise<Response>((resolve) => { finishReplies = resolve; })
        : Promise.resolve(jsonResponse({ items: [OPEN] })))) as unknown as typeof fetch;

    await act(async () => {
      render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
    });

    expect(screen.getByText('Bring gloves Thursday.')).toBeInTheDocument();
    expect(screen.getByText("Loading the family's replies…")).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Family replies' })).toBeNull();

    await act(async () => {
      finishReplies?.(jsonResponse({ items: [REPLIES[0]] }));
    });

    expect(screen.queryByText(/Loading the family/)).toBeNull();
    expect(screen.getByRole('list', { name: 'Family replies' }).textContent).toContain('Will do, thanks.');
  });

  test("a replies answer for the athlete just left never lands under the next athlete's notes", async () => {
    let finishFirstReplies: ((value: Response) => void) | null = null;
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/family-message-replies') && url.includes('athlete_id=ath-1')) {
        return new Promise<Response>((resolve) => { finishFirstReplies = resolve; });
      }
      if (url.includes('/family-message-replies')) return Promise.resolve(jsonResponse({ items: [] }));
      return Promise.resolve(jsonResponse({ items: [OPEN] }));
    }) as unknown as typeof fetch;

    const view = render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
    await act(async () => {});
    await act(async () => {
      view.rerender(<FamilyNotesPosted athleteId="ath-2" refreshKey={0} />);
    });
    await act(async () => {
      finishFirstReplies?.(jsonResponse({ items: [REPLIES[0]] }));
    });

    expect(screen.queryByText('Will do, thanks.')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Family replies' })).toBeNull();
  });

  test('a failed replies read says so, and the notes still show', async () => {
    global.fetch = byUrl(() => jsonResponse({ items: [OPEN] }), () => jsonResponse({ error: 'boom' }, false)) as unknown as typeof fetch;

    await act(async () => {
      render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
    });

    expect(screen.getByRole('alert').textContent).toContain('replies could not be loaded');
    expect(screen.getByText('Bring gloves Thursday.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Family replies' })).toBeNull();
  });
});

/*
 * OPENED BY THE FAMILY (FC-05): under each note, "Opened by the family" and
 * when, or "Not opened by the family yet" -- never which guardian; a failed
 * read says so once and the notes stay.
 */
describe('opened by the family (FC-05)', () => {
  test('each note says whether the family opened it, and when, in gym time', async () => {
    const fetchMock = byUrl(
      () => jsonResponse({ items: [DONE, OPEN] }),
      () => jsonResponse({ items: [] }),
      // 23:10 UTC on Oct 13 is 7:10 PM in the gym.
      () => jsonResponse({ items: [{ note_id: 'n2', first_read_at: '2026-10-13T23:10:00.000Z' }] }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => {
      render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
    });

    const items = screen.getAllByRole('listitem');
    expect(items[0]!.textContent).toMatch(/Opened by the family · .*7:10/);
    expect(items[1]!.textContent).toContain('No open recorded on the Messages tab yet');
    expect(screen.getByText(/An open is recorded when a message is shown on the family's Messages tab/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/pilot/coach/family-message-reads?athlete_id=ath-1'),
      expect.anything(),
    );
  });

  test('a failed read says so once, claims nothing about any note, and the notes stay', async () => {
    global.fetch = byUrl(
      () => jsonResponse({ items: [DONE, OPEN] }),
      () => jsonResponse({ items: [] }),
      () => jsonResponse({ error: 'boom' }, false),
    ) as unknown as typeof fetch;

    await act(async () => {
      render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
    });

    expect(screen.getByRole('alert').textContent).toContain('Whether the family opened these could not be loaded');
    expect(screen.queryByText('No open recorded on the Messages tab yet')).toBeNull();
    expect(screen.queryByText(/Opened by the family/)).toBeNull();
    expect(screen.getByText('Bring gloves Thursday.')).toBeInTheDocument();
  });

  test("an opened answer for the athlete just left never lands under the next athlete's notes", async () => {
    let finishFirst: ((value: Response) => void) | null = null;
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/family-message-reads') && url.includes('athlete_id=ath-1')) {
        return new Promise<Response>((resolve) => { finishFirst = resolve; });
      }
      if (url.includes('/family-message-reads') || url.includes('/family-message-replies')) {
        return Promise.resolve(jsonResponse({ items: [] }));
      }
      return Promise.resolve(jsonResponse({ items: [OPEN] }));
    }) as unknown as typeof fetch;

    const view = render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
    await act(async () => {});
    await act(async () => {
      view.rerender(<FamilyNotesPosted athleteId="ath-2" refreshKey={0} />);
    });
    await act(async () => {
      finishFirst?.(jsonResponse({ items: [{ note_id: 'n1', first_read_at: '2026-10-13T23:10:00.000Z' }] }));
    });

    expect(screen.queryByText(/Opened by the family/)).toBeNull();
    expect(screen.getByText('No open recorded on the Messages tab yet')).toBeInTheDocument();
  });
});

/*
 * NEW TO ME (FC-09b): a reply this staff member had not seen when the panel
 * loaded carries "New" for the visit; a reply is recorded as seen when at
 * least half of it is on screen, never on load; a failed seen read draws no
 * New and says, in one muted line, that it could not be loaded.
 */
describe('new replies for this staff member (FC-09b)', () => {
  const REPLY_A = { reply_id: 'r1', note_id: 'n1', reply_text: 'Will do, thanks.', created_at: '2026-10-12T23:30:00.000Z', author_name: 'Alex Parent' };
  const REPLY_B = { reply_id: 'r2', note_id: 'n1', reply_text: 'Gloves are packed.', created_at: '2026-10-13T00:15:00.000Z', author_name: 'Jordan Parent' };

  /* A stand-in for the browser's IntersectionObserver: the test says which
     reply is on screen, and how much of it. */
  class FakeObserver {
    static instances: FakeObserver[] = [];
    observed = new Set<Element>();
    disconnects = 0;
    constructor(private readonly callback: IntersectionObserverCallback) {
      FakeObserver.instances.push(this);
    }
    observe(element: Element) { this.observed.add(element); }
    unobserve(element: Element) { this.observed.delete(element); }
    disconnect() { this.disconnects += 1; this.observed.clear(); }
    show(replyId: string, ratio: number, visibleHeight: number, screenHeight: number) {
      const target = [...this.observed].find((element) => (element as HTMLElement).dataset.readReply === replyId);
      if (!target) return;
      this.callback(
        [{
          target,
          isIntersecting: ratio > 0,
          intersectionRatio: ratio,
          intersectionRect: { height: visibleHeight },
          rootBounds: { height: screenHeight },
        } as unknown as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    }
  }

  function showReply(replyId: string, ratio = 1, visibleHeight = 0, screenHeight = 800) {
    for (const observer of FakeObserver.instances) observer.show(replyId, ratio, visibleHeight, screenHeight);
  }

  function readPosts(fetchMock: jest.Mock): string[] {
    return fetchMock.mock.calls
      .filter((call) => String(call[0]).includes('/family-reply-reads') && (call[1] as RequestInit | undefined)?.method === 'POST')
      .map((call) => (JSON.parse(String((call[1] as RequestInit).body)) as { reply_id: string }).reply_id);
  }

  function replyItem(text: string): HTMLElement {
    return screen.getByText(text).closest('li') as HTMLElement;
  }

  beforeEach(() => {
    FakeObserver.instances = [];
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeObserver;
  });

  afterEach(() => {
    delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  });

  test('a reply not seen before shows New; one already seen does not', async () => {
    const fetchMock = byUrl(
      () => jsonResponse({ items: [OPEN] }),
      () => jsonResponse({ items: [REPLY_A, REPLY_B] }),
      undefined,
      () => jsonResponse({ items: [{ reply_id: 'r1' }] }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => {
      render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
    });

    expect(within(replyItem('Gloves are packed.')).getByText('New')).toBeInTheDocument();
    expect(within(replyItem('Will do, thanks.')).queryByText('New')).toBeNull();
    // A seen read that answered says nothing about failing.
    expect(screen.queryByText(/Which replies are new to you could not be loaded/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/pilot/coach/family-reply-reads?athlete_id=ath-1'),
      expect.anything(),
    );
  });

  test('the New badge carries its glyph, hidden from screen readers', async () => {
    global.fetch = byUrl(() => jsonResponse({ items: [OPEN] }), () => jsonResponse({ items: [REPLY_B] })) as unknown as typeof fetch;

    await act(async () => {
      render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
    });

    const badge = within(replyItem('Gloves are packed.')).getByText('New').closest('.badge') as HTMLElement;
    const glyph = badge.querySelector('[aria-hidden="true"]');
    expect(glyph?.textContent).toBe('◉');
  });

  test('a failed seen read draws no New and says once that it could not be loaded', async () => {
    global.fetch = byUrl(
      () => jsonResponse({ items: [OPEN] }),
      () => jsonResponse({ items: [REPLY_A, REPLY_B] }),
      undefined,
      () => jsonResponse({ error: 'boom' }, false),
    ) as unknown as typeof fetch;

    await act(async () => {
      render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
    });

    expect(screen.getByText('Gloves are packed.')).toBeInTheDocument();
    expect(screen.queryByText('New')).toBeNull();
    expect(screen.getAllByText(
      'Which replies are new to you could not be loaded. This is not a statement that there are none.',
    )).toHaveLength(1);
  });

  test('a failed seen read still records a reply seen on screen', async () => {
    const fetchMock = byUrl(
      () => jsonResponse({ items: [OPEN] }),
      () => jsonResponse({ items: [REPLY_A] }),
      undefined,
      () => jsonResponse({ error: 'boom' }, false),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => {
      render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
    });
    await act(async () => { showReply('r1', 1); });
    expect(readPosts(fetchMock)).toEqual(['r1']);
  });

  test('leaving the panel stops watching: nothing is recorded after unmount', async () => {
    const fetchMock = byUrl(() => jsonResponse({ items: [OPEN] }), () => jsonResponse({ items: [REPLY_A] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
    });
    expect(FakeObserver.instances.length).toBeGreaterThan(0);
    view!.unmount();

    expect(FakeObserver.instances.every((observer) => observer.disconnects > 0)).toBe(true);
    await act(async () => { showReply('r1', 1); });
    expect(readPosts(fetchMock)).toEqual([]);
  });

  test('loading the panel records nothing; half of a reply on screen records it once', async () => {
    const fetchMock = byUrl(() => jsonResponse({ items: [OPEN] }), () => jsonResponse({ items: [REPLY_A, REPLY_B] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => {
      render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
    });
    expect(readPosts(fetchMock)).toEqual([]);

    await act(async () => { showReply('r2', 0.49); });
    expect(readPosts(fetchMock)).toEqual([]);

    await act(async () => { showReply('r2', 0.5); });
    await act(async () => { showReply('r2', 1); });
    expect(readPosts(fetchMock)).toEqual(['r2']);
    // New stays for the visit.
    expect(within(replyItem('Gloves are packed.')).getByText('New')).toBeInTheDocument();
  });

  test('a reply recorded on this visit is not sent again when the panel redraws', async () => {
    let finishOpened: ((value: Response) => void) | null = null;
    const base = byUrl(() => jsonResponse({ items: [OPEN] }), () => jsonResponse({ items: [REPLY_A] }));
    const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) =>
      (String(input).includes('/family-message-reads')
        ? new Promise<Response>((resolve) => { finishOpened = resolve; })
        : base(input, init)));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
    await act(async () => {});
    await act(async () => { showReply('r1', 1); });
    // The opened read answering late redraws the panel and watches it afresh.
    await act(async () => {
      finishOpened?.(jsonResponse({ items: [] }));
    });
    await act(async () => { showReply('r1', 1); });
    expect(readPosts(fetchMock)).toEqual(['r1']);
  });

  test('a reply taller than the screen counts once it fills half the screen', async () => {
    const fetchMock = byUrl(() => jsonResponse({ items: [OPEN] }), () => jsonResponse({ items: [REPLY_A] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => {
      render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
    });
    await act(async () => { showReply('r1', 0.2, 399, 800); });
    expect(readPosts(fetchMock)).toEqual([]);
    await act(async () => { showReply('r1', 0.25, 400, 800); });
    expect(readPosts(fetchMock)).toEqual(['r1']);
  });

  test('a reply already seen is not sent again', async () => {
    const fetchMock = byUrl(
      () => jsonResponse({ items: [OPEN] }),
      () => jsonResponse({ items: [REPLY_A] }),
      undefined,
      () => jsonResponse({ items: [{ reply_id: 'r1' }] }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => {
      render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
    });
    await act(async () => { showReply('r1', 1); });
    expect(readPosts(fetchMock)).toEqual([]);
  });

  test('a failed write is not shown, and is sent again when the panel reloads', async () => {
    let posts = 0;
    const base = byUrl(() => jsonResponse({ items: [OPEN] }), () => jsonResponse({ items: [REPLY_A] }));
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/family-reply-reads') && init?.method === 'POST') {
        posts += 1;
        return jsonResponse({ error: 'boom' }, posts > 1);
      }
      return base(input, init);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const view = render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
    await act(async () => {});
    await act(async () => { showReply('r1', 1); });
    expect(readPosts(fetchMock)).toEqual(['r1']);
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => {
      view.rerender(<FamilyNotesPosted athleteId="ath-1" refreshKey={1} />);
    });
    await act(async () => { showReply('r1', 1); });
    expect(readPosts(fetchMock)).toEqual(['r1', 'r1']);
  });

  test('a reload after a post keeps New on a reply seen on this visit', async () => {
    let seenReads = 0;
    const fetchMock = byUrl(
      () => jsonResponse({ items: [OPEN] }),
      () => jsonResponse({ items: [REPLY_A] }),
      undefined,
      // The second read already holds the read written on this visit.
      () => jsonResponse({ items: (seenReads += 1) === 1 ? [] : [{ reply_id: 'r1' }] }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const view = render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
    await act(async () => {});
    await act(async () => { showReply('r1', 1); });
    await act(async () => {
      view.rerender(<FamilyNotesPosted athleteId="ath-1" refreshKey={1} />);
    });

    expect(seenReads).toBe(2);
    expect(within(replyItem('Will do, thanks.')).getByText('New')).toBeInTheDocument();
  });

  test('an athlete switch starts over, and a late seen answer for the last athlete is ignored', async () => {
    let finishFirstSeen: ((value: Response) => void) | null = null;
    let secondSeenReads = 0;
    const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/family-reply-reads') && init?.method === 'POST') return Promise.resolve(jsonResponse({ ok: true }));
      if (url.includes('/family-reply-reads') && url.includes('athlete_id=ath-1')) {
        return new Promise<Response>((resolve) => { finishFirstSeen = resolve; });
      }
      // ath-2: nothing seen at first; the reload after a post holds the read written on this visit.
      if (url.includes('/family-reply-reads')) {
        return Promise.resolve(jsonResponse({ items: (secondSeenReads += 1) === 1 ? [] : [{ reply_id: 'r2' }] }));
      }
      if (url.includes('/family-message-replies')) {
        return Promise.resolve(jsonResponse({ items: url.includes('ath-1') ? [REPLY_A] : [REPLY_B] }));
      }
      if (url.includes('/family-message-reads')) return Promise.resolve(jsonResponse({ items: [] }));
      return Promise.resolve(jsonResponse({ items: [OPEN] }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const view = render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
    await act(async () => {});
    // Not watched until this staff member's earlier reads have answered.
    await act(async () => { showReply('r1', 1); });
    expect(readPosts(fetchMock)).toEqual([]);
    expect(screen.queryByText('New')).toBeNull();

    await act(async () => {
      view.rerender(<FamilyNotesPosted athleteId="ath-2" refreshKey={0} />);
    });
    await act(async () => {
      finishFirstSeen?.(jsonResponse({ items: [{ reply_id: 'r2' }] }));
    });

    // ath-2's own read (nothing seen) decides, not ath-1's late answer.
    expect(within(replyItem('Gloves are packed.')).getByText('New')).toBeInTheDocument();
    await act(async () => { showReply('r2', 1); });
    expect(readPosts(fetchMock)).toEqual(['r2']);

    // A reload after a post on ath-2: the visit is still ath-2's, so New stays
    // on the reply seen this visit and nothing is sent again. ath-1's late
    // answer must not have taken over the visit.
    await act(async () => {
      view.rerender(<FamilyNotesPosted athleteId="ath-2" refreshKey={1} />);
    });
    expect(secondSeenReads).toBe(2);
    expect(within(replyItem('Gloves are packed.')).getByText('New')).toBeInTheDocument();
    await act(async () => { showReply('r2', 1); });
    expect(readPosts(fetchMock)).toEqual(['r2']);
  });
});
