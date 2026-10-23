/**
 * @jest-environment jsdom
 */

// Issue #345, PR "F": Answer a Gap can register a new source and file its PDF
// without a curator stitching the steps across tabs. What these pin:
//   - a curator is offered the two doors under a Needs Evidence requirement and
//     a coach, who only attaches (OD-2026-10-08-005 A-Q13), is not;
//   - registering through the door runs the General Research form and chooses
//     the new source in Answer a Gap -- and nothing else: the link call (Submit
//     source) is still the only thing that creates a submission, and nothing
//     here resolves a requirement;
//   - a refusal naming a source already in the Library (a taken URL, or the
//     paper's DOI/PMID) is shown and offers that source as the choice;
//   - "File its PDF" opens the Add Source Text / archive filing panel with the
//     source chosen above already picked.

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import ResearchIntakePage from './page';
import LibraryTextIntakePanel from './LibraryTextIntakePanel';

jest.mock('@/components/RoleStandaloneView', () => {
  const React = jest.requireActual('react');
  return {
    __esModule: true,
    default: (props: { readonly children: ReactNode }) => React.createElement('div', null, props.children),
  };
});

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn() }),
}));

const REQUIREMENT = {
  research_requirement_id: 7,
  source_event_name: 'question',
  source_entity_type: 'athlete',
  source_entity_id: 'ath-1',
  research_requirement: 'Is RPE reliable at age 12?',
  knowledge_gap: 'adolescent RPE reliability',
  evidence_label: null,
  source_status: 'active',
  source_confidence_tier: 'tier_2',
  source_verification_state: 'unverified',
  status: 'open',
  created_at: '2026-08-10T12:00:00.000Z',
};
const SECOND_REQUIREMENT = { ...REQUIREMENT, research_requirement_id: 8, research_requirement: 'Does footwork drill order matter?' };

const HELD = { source_id: 'src-1', title: 'RPE reliability in adolescents', source_type: 'peer_reviewed' };
const REGISTER_DOOR = 'Register a new source for this gap';

interface Capture {
  sourcePosts: Array<Record<string, unknown>>;
  submissions: Array<Record<string, unknown>>;
  requirementPosts: Array<Record<string, unknown>>;
  /** Reads of the sources list so far. */
  sourceReads: number;
}

function mockLibrary(options: {
  role?: 'organization_admin' | 'coach';
  sources?: Array<Record<string, unknown>>;
  requirements?: Array<Record<string, unknown>>;
  /** Answers to the sources POST, in order; the default registers the title sent. */
  answers?: Array<{ status: number; json: unknown }>;
  /** Holds the sources POST's answer until released. */
  hold?: Promise<void>;
  capture: Capture;
}) {
  const sources = [...(options.sources ?? [HELD])];
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/pilot/auth/session')) {
      return { ok: true, json: async () => ({ authenticated: true, role: options.role ?? 'organization_admin', auth_provider: 'microsoft' }) } as Response;
    }
    if (url.includes('/research-submissions') && init?.method === 'POST') {
      options.capture.submissions.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    if (url.includes('research_requirement_ids=')) {
      return { ok: true, json: async () => ({ answer_states: {} }) } as Response;
    }
    if (url.includes('/library/sources') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      options.capture.sourcePosts.push(body);
      if (options.hold) await options.hold;
      const answer = options.answers?.shift();
      if (answer) return { ok: answer.status < 300, status: answer.status, json: async () => answer.json } as Response;
      const saved = { source_id: 'src-new', title: body.title, source_type: body.source_type };
      sources.unshift(saved);
      return { ok: true, status: 201, json: async () => ({ ok: true, source: saved }) } as Response;
    }
    if (url.includes('/library/sources')) {
      options.capture.sourceReads += 1;
      return { ok: true, json: async () => ({ sources }) } as Response;
    }
    if (url.includes('/research-requirements') && init?.method === 'POST') {
      options.capture.requirementPosts.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({}) } as Response;
    }
    if (url.includes('/research-requirements')) {
      return { ok: true, json: async () => ({ items: options.requirements ?? [REQUIREMENT] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

function newCapture(): Capture {
  return { sourcePosts: [], submissions: [], requirementPosts: [], sourceReads: 0 };
}

async function openAnswerPanel(fetchMock: typeof fetch, which = 0) {
  global.fetch = fetchMock;
  await act(async () => {
    render(<ResearchIntakePage />);
  });
  const buttons = await screen.findAllByRole('button', { name: 'Answer this gap' });
  await act(async () => {
    fireEvent.click(buttons[which]);
  });
}

async function openRegisterDoor() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: REGISTER_DOOR }));
  });
  return screen.getByRole('region', { name: REGISTER_DOOR });
}

async function fillAndRegister(door: HTMLElement, title: string, extra: { url?: string; doi?: string } = {}) {
  await act(async () => {
    fireEvent.change(within(door).getByLabelText('Title'), { target: { value: title } });
    fireEvent.change(within(door).getByLabelText('Classification domain'), { target: { value: 'youth_development_safeguarding' } });
    if (extra.url) fireEvent.change(within(door).getByLabelText('URL (optional)'), { target: { value: extra.url } });
    if (extra.doi) fireEvent.change(within(door).getByLabelText('DOI / PMID'), { target: { value: extra.doi } });
  });
  await act(async () => {
    fireEvent.click(within(door).getByRole('button', { name: 'Register general research' }));
  });
}

const chosenSource = () => (screen.getByLabelText('Library source') as HTMLSelectElement).value;

afterEach(() => {
  window.localStorage.clear();
  jest.restoreAllMocks();
});

describe('who is offered the doors', () => {
  test('a curator sees the register door, and the PDF door once a source is chosen', async () => {
    await openAnswerPanel(mockLibrary({ capture: newCapture() }));
    expect(screen.getByRole('button', { name: REGISTER_DOOR })).toBeTruthy();
    // File its PDF is "from the selected source": it waits for one.
    expect(screen.queryByRole('button', { name: 'File its PDF' })).toBeNull();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Library source'), { target: { value: 'src-1' } });
    });
    expect(screen.getByRole('button', { name: 'File its PDF' })).toBeTruthy();
  });

  test('a coach gets the attach path and no door', async () => {
    await openAnswerPanel(mockLibrary({ role: 'coach', capture: newCapture() }));
    expect(screen.getByLabelText('Library source')).toBeTruthy();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Library source'), { target: { value: 'src-1' } });
    });
    expect(screen.queryByRole('button', { name: REGISTER_DOOR })).toBeNull();
    expect(screen.queryByRole('button', { name: 'File its PDF' })).toBeNull();
  });

  test('a curator whose shelf is empty is still offered the door', async () => {
    await openAnswerPanel(mockLibrary({ sources: [], capture: newCapture() }));
    expect(screen.getByRole('button', { name: REGISTER_DOOR })).toBeTruthy();
  });

  test('a coach with an empty shelf has no Answer this gap panel, as before', async () => {
    global.fetch = mockLibrary({ role: 'coach', sources: [], capture: newCapture() });
    await act(async () => {
      render(<ResearchIntakePage />);
    });
    await screen.findByText('Is RPE reliable at age 12?');
    expect(screen.queryByRole('button', { name: 'Answer this gap' })).toBeNull();
  });
});

describe('registering a new source from the requirement', () => {
  test('the new source is registered through the General Research form and chosen above, and nothing is linked or resolved', async () => {
    const capture = newCapture();
    await openAnswerPanel(mockLibrary({ capture }));
    const door = await openRegisterDoor();

    await fillAndRegister(door, 'Youth RPE validity study', { doi: '10.1000/new' });

    // The same registration the General Research tab sends.
    expect(capture.sourcePosts).toHaveLength(1);
    const posted = capture.sourcePosts[0] as { title: string; metadata: Record<string, unknown>; request_id: unknown };
    expect(posted.title).toBe('Youth RPE validity study');
    expect(posted.metadata.general_research).toBe(true);
    expect(posted.metadata.classification_domain).toBe('youth_development_safeguarding');
    expect(typeof posted.request_id).toBe('string');

    // Chosen in Answer a Gap; the door closes behind it.
    await waitFor(() => expect(chosenSource()).toBe('src-new'));
    expect(screen.queryByRole('region', { name: REGISTER_DOOR })).toBeNull();
    expect(screen.getByText(/"Youth RPE validity study" is chosen above/)).toBeTruthy();

    // Registering linked nothing and closed nothing.
    expect(capture.submissions).toHaveLength(0);
    expect(capture.requirementPosts).toHaveLength(0);
    expect(screen.getByText('Open')).toBeTruthy();

    // Submit source is still the one thing that attaches it.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit source' }));
    });
    expect(capture.submissions).toHaveLength(1);
    expect(capture.submissions[0]).toMatchObject({ research_requirement_id: 7, source_id: 'src-new' });
    expect(capture.requirementPosts).toHaveLength(0);
  });

  test('a new source the list read did not return is still chosen', async () => {
    const capture = newCapture();
    const fetchMock = mockLibrary({ capture });
    // The answer names the source, but the re-read of the list does not carry it.
    const real = fetchMock as unknown as jest.Mock;
    real.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/library/sources') && init?.method === 'POST') {
        capture.sourcePosts.push(JSON.parse(String(init.body)));
        return { ok: true, status: 201, json: async () => ({ ok: true, source: { source_id: 'src-unlisted', title: 'Unlisted', source_type: 'peer_reviewed' } }) } as Response;
      }
      if (url.includes('/api/pilot/auth/session')) {
        return { ok: true, json: async () => ({ authenticated: true, role: 'organization_admin', auth_provider: 'microsoft' }) } as Response;
      }
      if (url.includes('research_requirement_ids=')) return { ok: true, json: async () => ({ answer_states: {} }) } as Response;
      if (url.includes('/library/sources')) return { ok: true, json: async () => ({ sources: [HELD] }) } as Response;
      if (url.includes('/research-requirements')) return { ok: true, json: async () => ({ items: [REQUIREMENT] }) } as Response;
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    });
    await openAnswerPanel(fetchMock);
    const door = await openRegisterDoor();

    await fillAndRegister(door, 'Unlisted');

    await waitFor(() => expect(chosenSource()).toBe('src-unlisted'));
  });

  test('a retry that found the saved source chooses it and says no second one was added', async () => {
    const capture = newCapture();
    await openAnswerPanel(mockLibrary({
      capture,
      answers: [{ status: 200, json: { ok: true, recovered: true, source: { source_id: 'src-first', title: 'Saved first time', source_type: 'peer_reviewed' } } }],
    }));
    const door = await openRegisterDoor();

    await fillAndRegister(door, 'Saved first time');

    await waitFor(() => expect(chosenSource()).toBe('src-first'));
    expect(screen.getByText(/is chosen above.*the retry found the saved source instead of adding a second one/)).toBeTruthy();
  });

  test('a registration finished after the curator moved to another gap does not choose a source there', async () => {
    const capture = newCapture();
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    await openAnswerPanel(mockLibrary({ capture, hold, requirements: [REQUIREMENT, SECOND_REQUIREMENT] }));
    const door = await openRegisterDoor();

    await fillAndRegister(door, 'Slow registration');
    // Meanwhile the curator opens the other gap.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Answer this gap' }));
    });

    // The registration runs to its end -- the list is read again -- before anything is asserted.
    await waitFor(() => expect(capture.sourcePosts).toHaveLength(1));
    const readsBefore = capture.sourceReads;
    await act(async () => {
      release();
    });
    await waitFor(() => expect(capture.sourceReads).toBeGreaterThanOrEqual(readsBefore + 2));
    await act(async () => undefined);
    expect(chosenSource()).toBe('');
    expect(screen.queryByText(/is chosen above/)).toBeNull();
  });

  test('a registration finished while the File panel is open leaves that panel as it is', async () => {
    const capture = newCapture();
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    await openAnswerPanel(mockLibrary({ capture, hold }));
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Library source'), { target: { value: 'src-1' } });
    });
    const door = await openRegisterDoor();
    await fillAndRegister(door, 'Slow registration');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'File its PDF' }));
    });
    const panel = screen.getByRole('region', { name: 'Add source text to the Library' });

    const readsBefore = capture.sourceReads;
    await act(async () => {
      release();
    });
    await waitFor(() => expect(capture.sourceReads).toBeGreaterThanOrEqual(readsBefore + 2));
    await act(async () => undefined);

    // The new source is chosen above; the panel in use is not closed or switched under the curator.
    expect(chosenSource()).toBe('src-new');
    expect(screen.getByRole('region', { name: 'Add source text to the Library' })).toBe(panel);
    expect((within(panel).getByLabelText('Registered source') as HTMLSelectElement).value).toBe('src-1');
  });
});

describe('a refusal that names a source already in the Library', () => {
  test.each([
    ['a URL already registered', 'SHADOW_LIBRARY_SOURCE_URL_TAKEN', /This URL is already registered as "RPE reliability in adolescents"/],
    ['a paper whose DOI or PMID is already on the shelf', 'SHADOW_LIBRARY_PUBLICATION_TAKEN', /This paper is already registered as "RPE reliability in adolescents"/],
  ])('%s is shown and offers that source instead', async (_label, code, message) => {
    const capture = newCapture();
    await openAnswerPanel(mockLibrary({
      capture,
      answers: [{
        status: 409,
        json: { ok: false, error: 'taken', code, existing_source: { source_id: 'src-1', title: 'RPE reliability in adolescents' } },
      }],
    }));
    const door = await openRegisterDoor();

    await fillAndRegister(door, 'Same paper again', { doi: '10.1000/x' });

    expect(within(door).getByText(message)).toBeTruthy();
    expect(chosenSource()).toBe('');
    await act(async () => {
      fireEvent.click(within(door).getByRole('button', { name: 'Choose that source instead' }));
    });

    expect(chosenSource()).toBe('src-1');
    expect(screen.queryByRole('region', { name: REGISTER_DOOR })).toBeNull();
    // Choosing is not linking.
    expect(capture.submissions).toHaveLength(0);
    expect(capture.requirementPosts).toHaveLength(0);
  });

  test('a refusal that names no source offers no choice', async () => {
    const capture = newCapture();
    await openAnswerPanel(mockLibrary({
      capture,
      answers: [{ status: 409, json: { ok: false, error: 'taken', code: 'SHADOW_LIBRARY_SOURCE_URL_TAKEN', existing_source: null } }],
    }));
    const door = await openRegisterDoor();

    await fillAndRegister(door, 'Same paper again');

    expect(within(door).queryByRole('button', { name: 'Choose that source instead' })).toBeNull();
  });
});

describe('filing its PDF from the requirement', () => {
  test('File its PDF opens the Add Source Text panel with the chosen source picked', async () => {
    await openAnswerPanel(mockLibrary({ sources: [{ source_id: 'src-0', title: 'Another paper', source_type: 'textbook' }, HELD], capture: newCapture() }));
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Library source'), { target: { value: 'src-1' } });
    });
    expect(screen.queryAllByRole('region', { name: 'Add source text to the Library' })).toHaveLength(0);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'File its PDF' }));
    });

    const panel = screen.getByRole('region', { name: 'Add source text to the Library' });
    expect((within(panel).getByLabelText('Registered source') as HTMLSelectElement).value).toBe('src-1');
    expect(within(panel).getByLabelText('Choose the PDF')).toBeTruthy();
  });

  test('a source registered through the door can be filed straight away, and the door pressed again closes', async () => {
    const capture = newCapture();
    await openAnswerPanel(mockLibrary({ capture }));
    const door = await openRegisterDoor();
    await fillAndRegister(door, 'Brand new paper');
    await waitFor(() => expect(chosenSource()).toBe('src-new'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'File its PDF' }));
    });
    const panel = screen.getByRole('region', { name: 'Add source text to the Library' });
    expect((within(panel).getByLabelText('Registered source') as HTMLSelectElement).value).toBe('src-new');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'File its PDF' }));
    });
    expect(screen.queryAllByRole('region', { name: 'Add source text to the Library' })).toHaveLength(0);
    // Filing links nothing and closes nothing.
    expect(capture.submissions).toHaveLength(0);
    expect(capture.requirementPosts).toHaveLength(0);
  });
});

describe('the Add Source Text panel takes a starting source', () => {
  const SOURCES = [
    { source_id: 'a', title: 'First' },
    { source_id: 'b', title: 'Second' },
  ];

  test('without the prop it starts with nothing chosen, as before', () => {
    render(<LibraryTextIntakePanel sources={SOURCES} />);
    expect((screen.getByLabelText('Registered source') as HTMLSelectElement).value).toBe('');
  });

  test('with the prop it starts on that source, and the picker still changes it', () => {
    render(<LibraryTextIntakePanel sources={SOURCES} initialSourceId="b" />);
    const select = screen.getByLabelText('Registered source') as HTMLSelectElement;
    expect(select.value).toBe('b');
    fireEvent.change(select, { target: { value: 'a' } });
    expect(select.value).toBe('a');
  });
});
