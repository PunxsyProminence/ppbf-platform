import {
  askLibrary,
  claimStatusLabel,
  LibraryResearchError,
} from './libraryResearch';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const claim = {
  answer: 'Library-backed answer from current SHADOW evidence: authority boundaries constrain claims.',
  status: 'weak',
  confidence: 40,
  evidence: [
    {
      source_title: 'SHADOW Canonical Authority Model',
      document_name: 'Authority Model',
      authority_tier: 1,
      text_content: 'Authority boundaries constrain what SHADOW may assert.',
    },
  ],
  researchRequirementId: null,
};

describe('askLibrary', () => {
  test('sends the question with credentials and returns the parsed claim', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(200, { ok: true, claim }));

    const result = await askLibrary('', 'what constrains claims?', fetchImpl as unknown as typeof fetch);

    // credentials: 'include' is the exact omission that made /admin/shadow
    // return 401 on every call in the deployed configuration (#39). A page
    // that quietly drops it reproduces that defect here.
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/pilot/shadow/library/claims',
      expect.objectContaining({ credentials: 'include', method: 'POST' }),
    );
    expect(result.status).toBe('weak');
    expect(result.answer).toContain('Library-backed answer');
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].sourceTitle).toBe('SHADOW Canonical Authority Model');
  });

  test('long snippets are truncated for display, not dumped whole', async () => {
    const longClaim = {
      ...claim,
      evidence: [{ ...claim.evidence[0], text_content: 'x'.repeat(500) }],
    };
    const fetchImpl = jest.fn(async () => jsonResponse(200, { ok: true, claim: longClaim }));

    const result = await askLibrary('', 'q', fetchImpl as unknown as typeof fetch);

    expect(result.evidence[0].snippet.length).toBeLessThanOrEqual(281);
    expect(result.evidence[0].snippet.endsWith('…')).toBe(true);
  });

  test.each([
    [401, 'Sign in to search the Library.'],
    [403, 'Your role does not have Library access.'],
    [429, expect.stringContaining('rate limited')],
  ])('maps %s to a message the reader can act on', async (status, expected) => {
    const fetchImpl = jest.fn(async () => jsonResponse(status as number, { error: 'x' }));

    await expect(askLibrary('', 'q', fetchImpl as unknown as typeof fetch))
      .rejects.toMatchObject({ status, safeMessage: expected });
  });

  test('a malformed payload is refused rather than rendered', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(200, { ok: true, claim: { status: 'certain', answer: 42 } }));

    await expect(askLibrary('', 'q', fetchImpl as unknown as typeof fetch))
      .rejects.toBeInstanceOf(LibraryResearchError);
  });

  test('a network failure reads as unreachable, not as an empty library', async () => {
    const fetchImpl = jest.fn(async () => { throw new TypeError('fetch failed'); });

    await expect(askLibrary('', 'q', fetchImpl as unknown as typeof fetch))
      .rejects.toMatchObject({ status: 0, safeMessage: expect.stringContaining('could not be reached') });
  });
});

describe('claimStatusLabel', () => {
  test('unsupported admits the gap and says it was logged', () => {
    // The old page invented an answer for every question. The replacement's
    // defining property is that "we don't know" is stated, with the true fact
    // that the gap enters the research queue.
    expect(claimStatusLabel('unsupported')).toMatch(/No approved evidence/);
    expect(claimStatusLabel('unsupported')).toMatch(/research need/);
  });

  test('weak does not overclaim', () => {
    expect(claimStatusLabel('weak')).toMatch(/Limited/);
  });

  test('supported names the Library as the backing', () => {
    expect(claimStatusLabel('supported')).toMatch(/approved Library evidence/);
  });
});
