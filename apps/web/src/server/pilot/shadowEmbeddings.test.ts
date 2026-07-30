import { cosineSimilarity, embedText, isSemanticLibrarySearchEnabled } from './shadowEmbeddings';

const ENABLED_ENV = {
  AZURE_AI_ENDPOINT: 'https://example.openai.azure.com/',
  AZURE_AI_KEY: 'key-123',
  AZURE_AI_EMBEDDING_DEPLOYMENT_NAME: 'text-embedding-3-small',
  AZURE_AI_API_VERSION: '2024-10-21',
};

describe('semantic search enablement', () => {
  test('OFF by default: any missing variable disables the feature', () => {
    expect(isSemanticLibrarySearchEnabled({})).toBe(false);
    expect(isSemanticLibrarySearchEnabled({ ...ENABLED_ENV, AZURE_AI_EMBEDDING_DEPLOYMENT_NAME: undefined })).toBe(false);
    expect(isSemanticLibrarySearchEnabled({ ...ENABLED_ENV, AZURE_AI_ENDPOINT: '  ' })).toBe(false);
    expect(isSemanticLibrarySearchEnabled({ ...ENABLED_ENV, AZURE_AI_KEY: undefined })).toBe(false);
    expect(isSemanticLibrarySearchEnabled(ENABLED_ENV)).toBe(true);
  });
});

describe('embedText', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('returns null without calling the network when disabled', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as never;
    await expect(embedText('warm up drills', {})).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('calls the deployment endpoint and returns the vector', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    });
    global.fetch = fetchSpy as never;

    const vector = await embedText('warm up drills', ENABLED_ENV);
    expect(vector).toEqual([0.1, 0.2, 0.3]);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      'https://example.openai.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-10-21',
    );
    expect(options.headers['api-key']).toBe('key-123');
    expect(JSON.parse(options.body)).toEqual({ input: ['warm up drills'] });
  });

  test.each([
    ['HTTP error', { ok: false, status: 429, json: async () => ({}) }],
    ['malformed payload', { ok: true, json: async () => ({ data: [{}] }) }],
    ['non-numeric vector', { ok: true, json: async () => ({ data: [{ embedding: ['x'] }] }) }],
  ])('degrades to null on %s, never throws', async (_label, response) => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = jest.fn().mockResolvedValue(response) as never;
    await expect(embedText('question', ENABLED_ENV)).resolves.toBeNull();
  });

  test('degrades to null when the request rejects (timeout/abort path)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = jest.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })) as never;
    await expect(embedText('question', ENABLED_ENV)).resolves.toBeNull();
  });
});

describe('cosineSimilarity', () => {
  test('identical direction is 1, orthogonal is 0, opposite is -1', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 5])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-3, 0])).toBeCloseTo(-1);
  });

  test('mismatched or zero vectors score 0 instead of NaN', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});
