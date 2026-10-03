/**
 * @jest-environment jsdom
 */

// Quotes admin page. What these pin: on and off quotes both render, an empty
// quote never leaves the page, adding posts the typed fields scoped by the
// server (no organization in the body), switching off sends only active, and
// editing patches the quote by id.

import { act, fireEvent, render, screen } from '@testing-library/react';

import QuotesPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const QUOTES = [
  {
    quote_id: 'q-1', quote_text: 'HANDS UP. HEAD CLEAR.', speaker: 'the wall', quote_type: 'gym_saying',
    source: '', shown: ['after-hard-session'], active: true,
  },
  {
    quote_id: 'q-2', quote_text: 'Float like a butterfly.', speaker: 'Ali', quote_type: 'boxing_quote',
    source: 'Interview, 1964', shown: ['anywhere'], active: false,
  },
];

function mockFetch(capture: { writes: Array<{ method: string; body: Record<string, unknown> }> }) {
  return jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST' || init?.method === 'PATCH') {
      capture.writes.push({ method: init.method, body: JSON.parse(String(init.body)) });
      return { ok: true, json: async () => ({ quote: {} }) } as Response;
    }
    return { ok: true, json: async () => ({ quotes: QUOTES }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('on and off quotes both render with their type, moments and attribution', async () => {
  global.fetch = mockFetch({ writes: [] });
  await act(async () => {
    render(<QuotesPage />);
  });

  expect(await screen.findByText('HANDS UP. HEAD CLEAR.')).toBeTruthy();
  expect(screen.getByText('on')).toBeTruthy();
  expect(screen.getByText('off')).toBeTruthy();
  expect(screen.getByText(/Gym saying · After a hard session/)).toBeTruthy();
  expect(screen.getByText('Ali — Interview, 1964')).toBeTruthy();
});

test('an empty quote never leaves the page; a filled one posts its fields with no organization', async () => {
  const capture = { writes: [] as Array<{ method: string; body: Record<string, unknown> }> };
  global.fetch = mockFetch(capture);
  await act(async () => {
    render(<QuotesPage />);
  });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add quote' }));
  });
  expect(capture.writes).toHaveLength(0);
  expect(screen.getByText('A quote needs its words.')).toBeTruthy();

  await act(async () => {
    fireEvent.change(screen.getByLabelText('Quote'), { target: { value: 'No hype. Just work.' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'motivational' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add quote' }));
  });

  expect(capture.writes).toHaveLength(1);
  expect(capture.writes[0].method).toBe('POST');
  expect(capture.writes[0].body).toEqual({
    quote_text: 'No hype. Just work.', speaker: '', quote_type: 'motivational',
    source: '', shown: ['anywhere'], active: true,
  });
});

test('switching a quote off patches only its active flag', async () => {
  const capture = { writes: [] as Array<{ method: string; body: Record<string, unknown> }> };
  global.fetch = mockFetch(capture);
  await act(async () => {
    render(<QuotesPage />);
  });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Switch off:/ }));
  });
  expect(capture.writes).toEqual([{ method: 'PATCH', body: { quote_id: 'q-1', active: false } }]);
});

test('editing loads the quote into the form and saves a patch by id', async () => {
  const capture = { writes: [] as Array<{ method: string; body: Record<string, unknown> }> };
  global.fetch = mockFetch(capture);
  await act(async () => {
    render(<QuotesPage />);
  });

  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: /^Edit:/ })[1]);
  });
  expect((screen.getByLabelText('Quote') as HTMLTextAreaElement).value).toBe('Float like a butterfly.');
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Source or citation (optional)'), { target: { value: '' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  });

  expect(capture.writes).toHaveLength(1);
  expect(capture.writes[0].method).toBe('PATCH');
  expect(capture.writes[0].body).toMatchObject({ quote_id: 'q-2', source: '', quote_type: 'boxing_quote' });
  expect(capture.writes[0].body).not.toHaveProperty('active');
});

test('editing a quote stored with several moments does not rewrite them unless the person changes Shown', async () => {
  const multi = [{ ...QUOTES[0], shown: ['after-hard-session', 'at-a-milestone'] }];
  const writes: Array<Record<string, unknown>> = [];
  global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      writes.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({}) } as Response;
    }
    return { ok: true, json: async () => ({ quotes: multi }) } as Response;
  }) as unknown as typeof fetch;
  await act(async () => {
    render(<QuotesPage />);
  });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Edit:/ }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Said by (optional)'), { target: { value: 'Coach' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  });
  expect(writes[0]).not.toHaveProperty('shown');

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Edit:/ }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Shown'), { target: { value: 'anywhere' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  });
  expect(writes[1]).toMatchObject({ shown: ['anywhere'] });
});

test('a write that succeeds is never reported as failed when only the refresh fails', async () => {
  let reads = 0;
  global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return { ok: true, json: async () => ({}) } as Response;
    reads += 1;
    if (reads > 1) throw new Error('network down');
    return { ok: true, json: async () => ({ quotes: QUOTES }) } as Response;
  }) as unknown as typeof fetch;
  await act(async () => {
    render(<QuotesPage />);
  });

  await act(async () => {
    fireEvent.change(screen.getByLabelText('Quote'), { target: { value: 'New line' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add quote' }));
  });

  expect(screen.getByText(/Saved, but the list could not be refreshed/)).toBeTruthy();
  expect((screen.getByLabelText('Quote') as HTMLTextAreaElement).value).toBe('');
});

test('a failed save shows the server reason and keeps what was typed', async () => {
  global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return { ok: false, status: 400, json: async () => ({ error: 'That quote is already in the library.' }) } as Response;
    }
    return { ok: true, json: async () => ({ quotes: QUOTES }) } as Response;
  }) as unknown as typeof fetch;
  await act(async () => {
    render(<QuotesPage />);
  });

  await act(async () => {
    fireEvent.change(screen.getByLabelText('Quote'), { target: { value: 'Hands up.' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add quote' }));
  });

  expect(screen.getByText('That quote is already in the library.')).toBeTruthy();
  expect((screen.getByLabelText('Quote') as HTMLTextAreaElement).value).toBe('Hands up.');
});
