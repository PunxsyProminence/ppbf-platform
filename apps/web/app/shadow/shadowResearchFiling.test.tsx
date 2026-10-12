/**
 * @jest-environment jsdom
 */

/**
 * ISSUE #1466 (N6-01): a SHADOW reply with no verified Library evidence files
 * no research by itself. The line under it says what was actually read --
 * filed (with the stored status), not filed, or could not be checked -- and a
 * coach or org admin can file it through the existing research-requirements
 * create. Anyone else sees no line: a member cannot read a coach-filed row, so
 * "not filed" would be a guess.
 */

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import ShadowChatPage from './page';
import { listOwnedShadowSessions } from '@/client/shadowSessions';

const router = { replace: jest.fn(), push: jest.fn() };
const searchParams = { get: () => null };

jest.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => searchParams,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

let mockRole = 'coach';
jest.mock('@/components/roleSession', () => ({
  readRoleSession: () => ({ role: mockRole, expiresAt: 8.64e15 }),
  clearRoleSession: jest.fn(),
}));

jest.mock('@/client/shadowSessions', () => {
  const actual = jest.requireActual('@/client/shadowSessions');
  return { ...actual, listOwnedShadowSessions: jest.fn() };
});

const mockListSessions = listOwnedShadowSessions as jest.MockedFunction<typeof listOwnedShadowSessions>;
const originalFetch = global.fetch;

const QUESTION = 'How long should a  13-year-old rest between sparring rounds?';
const KEY = 'how long should a 13-year-old rest between sparring rounds?';

interface Requirement {
  research_requirement_id: number;
  source_event_name: string;
  source_entity_type: string;
  source_entity_id: string;
  status: 'open' | 'resolved';
}

function filedRow(overrides: Partial<Requirement> = {}): Requirement {
  return {
    research_requirement_id: 41,
    source_event_name: 'shadow_unanswered_question',
    source_entity_type: 'shadow_question',
    source_entity_id: KEY,
    status: 'open',
    ...overrides,
  };
}

interface ServerOptions {
  role?: string;
  evidenceNotice?: string;
  requirements?: Requirement[] | 'fail';
  afterCreate?: Requirement[];
  createResponse?: { status: number; body: Record<string, unknown> };
}

function mockServer(options: ServerOptions = {}) {
  const posts: Record<string, unknown>[] = [];
  let created = false;
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/api/pilot/auth/session')) {
      return { ok: true, json: async () => ({ authenticated: true, role: options.role ?? 'coach' }) };
    }
    if (target.includes('/api/pilot/shadow/capabilities')) {
      return {
        ok: true,
        json: async () => ({ success: true, capabilities: { allowedSessionTypes: ['quick_round'], mode: 'scoped' } }),
      };
    }
    if (target.includes('/api/pilot/shadow/chat')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          state: 'ok',
          response: 'Rest guidance varies; nothing in the Library covers this.',
          evidenceTier: 'RESEARCH_NEEDED',
          evidenceNotice: options.evidenceNotice ?? 'NO_VERIFIED_EVIDENCE',
          messageId: 'msg-1',
        }),
      };
    }
    if (target.includes('/api/pilot/shadow/research-requirements')) {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        const response = options.createResponse ?? { status: 200, body: { ok: true, research_requirement_id: 41 } };
        if (response.status === 200) created = true;
        return { ok: response.status === 200, status: response.status, json: async () => response.body };
      }
      const rows = created && options.afterCreate ? options.afterCreate : options.requirements ?? [];
      if (rows === 'fail') return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ok: true, items: rows }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, posts };
}

async function askUnansweredQuestion() {
  await act(async () => {
    render(<ShadowChatPage />);
  });
  fireEvent.change(await screen.findByLabelText('Your question'), { target: { value: QUESTION } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Ask SHADOW' }));
  });
  await screen.findByText(/No verified Library evidence matched this question/);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = 'coach';
  mockListSessions.mockResolvedValue([]);
  Element.prototype.scrollIntoView = jest.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

test('a coach is told it is not filed yet, files it once, and then sees the stored status', async () => {
  const { posts } = mockServer({ requirements: [], afterCreate: [filedRow()] });
  await askUnansweredQuestion();

  expect(await screen.findByText('Not filed as research yet.')).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'File as research' }));
  });

  expect(posts).toEqual([expect.objectContaining({
    action: 'create',
    source_event_name: 'shadow_unanswered_question',
    source_entity_type: 'shadow_question',
    source_entity_id: KEY,
    research_requirement: QUESTION.trim(),
  })]);
  expect(await screen.findByText(/Filed as research: open\./)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open research' }).getAttribute('href')).toBe('/research');
  expect(screen.queryByRole('button', { name: 'File as research' })).toBeNull();
});

test('a question already filed shows its stored status and offers no second filing', async () => {
  const { posts } = mockServer({ requirements: [filedRow({ status: 'resolved' })] });
  await askUnansweredQuestion();

  expect(await screen.findByText(/Filed as research: resolved\./)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'File as research' })).toBeNull();
  expect(screen.queryByText('Not filed as research yet.')).toBeNull();
  expect(posts).toHaveLength(0);
});

test('a requirement from another source with the same text is not taken for a filing', async () => {
  mockServer({ requirements: [filedRow({ source_event_name: 'shadow_learning_negative_outcome' })] });
  await askUnansweredQuestion();

  expect(await screen.findByText('Not filed as research yet.')).toBeTruthy();
});

test('a refused filing never reads as filed', async () => {
  mockServer({
    requirements: [],
    createResponse: { status: 403, body: { ok: false, error: 'Forbidden: only coaches and organization admins file research requirements' } },
  });
  await askUnansweredQuestion();

  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'File as research' }));
  });

  expect(screen.getByText('Forbidden: only coaches and organization admins file research requirements')).toBeTruthy();
  expect(screen.queryByText(/Filed as research/)).toBeNull();
  expect(screen.getByText('Not filed as research yet.')).toBeTruthy();
});

test('a list that could not be read is said, never taken as "not filed"', async () => {
  mockServer({ requirements: 'fail' });
  await askUnansweredQuestion();

  expect(await screen.findByText('Could not check whether this was filed as research.')).toBeTruthy();
  expect(screen.queryByText('Not filed as research yet.')).toBeNull();
});

test.each(['athlete', 'parent', 'staff', 'volunteer', 'platform_owner'])(
  'a %s sees no filing line and the page never reads the research list for one',
  async (role) => {
    mockRole = role;
    const { fetchMock } = mockServer({ role, requirements: [filedRow()] });
    await askUnansweredQuestion();

    expect(screen.queryByTestId('research-filing')).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('research-requirements'))).toEqual([]);
  },
);

test('an organization admin gets the line too', async () => {
  mockRole = 'admin';
  mockServer({ role: 'organization_admin', requirements: [] });
  await askUnansweredQuestion();

  expect(await screen.findByText('Not filed as research yet.')).toBeTruthy();
});

test('a reply with evidence carries no filing line and reads nothing', async () => {
  const { fetchMock } = mockServer({ evidenceNotice: '' });
  await act(async () => {
    render(<ShadowChatPage />);
  });
  fireEvent.change(await screen.findByLabelText('Your question'), { target: { value: QUESTION } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Ask SHADOW' }));
  });
  await screen.findByText(/Rest guidance varies/);

  expect(screen.queryByTestId('research-filing')).toBeNull();
  expect(fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('research-requirements'))).toEqual([]);
});
