import { fetchAllResearchRequirements } from './researchRequirementsList';

afterEach(() => {
  jest.restoreAllMocks();
});

function pages(responses: Array<{ ok?: boolean; items?: unknown[]; next_cursor?: string | null }>) {
  const urls: string[] = [];
  let call = 0;
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const answer = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { ok: answer.ok ?? true, json: async () => ({ items: answer.items, next_cursor: answer.next_cursor }) } as Response;
  }) as unknown as typeof fetch;
  return urls;
}

test('follows next_cursor until the server says there is no more, keeping every page in order', async () => {
  const urls = pages([
    { items: [{ id: 3 }, { id: 2 }], next_cursor: 'c/1+' },
    { items: [{ id: 1 }], next_cursor: null },
  ]);

  await expect(fetchAllResearchRequirements<{ id: number }>()).resolves.toEqual([{ id: 3 }, { id: 2 }, { id: 1 }]);
  expect(urls).toHaveLength(2);
  expect(urls[0]).toContain('/api/pilot/shadow/research-requirements?limit=200');
  expect(urls[0]).not.toContain('cursor=');
  expect(urls[1]).toContain(`&cursor=${encodeURIComponent('c/1+')}`);
});

test('a refused page fails the whole read rather than returning part of the list', async () => {
  pages([
    { items: [{ id: 3 }], next_cursor: 'c1' },
    { ok: false },
  ]);

  await expect(fetchAllResearchRequirements()).rejects.toThrow('Unable to load research requirements.');
});

test('a server that never stops sending a cursor ends in an error, not a hang', async () => {
  const urls = pages([{ items: [], next_cursor: 'again' }]);

  await expect(fetchAllResearchRequirements()).rejects.toThrow('Unable to load research requirements.');
  expect(urls).toHaveLength(500);
});
