// shadowEmbeddings.ts — Azure OpenAI embeddings for semantic Library search.
//
// OFF by default, per the deploy rules: the feature exists only when
// AZURE_AI_EMBEDDING_DEPLOYMENT_NAME names a real embedding deployment (e.g.
// text-embedding-3-small) alongside the AZURE_AI_ENDPOINT / AZURE_AI_KEY the
// chat models already use. Until the operator creates that deployment and a
// workflow PR sets the variable (staging first), every caller sees null and
// the Library keeps its keyword search unchanged.
//
// Failures also return null rather than throwing: an embedding outage must
// degrade search to keywords, never break it.

const EMBEDDING_TIMEOUT_MS = 10_000;
const MAX_EMBEDDING_INPUT_CHARS = 8_000;

export function getEmbeddingDeploymentName(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.AZURE_AI_EMBEDDING_DEPLOYMENT_NAME?.trim() ?? '';
}

export function isSemanticLibrarySearchEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(
    getEmbeddingDeploymentName(env)
    && env.AZURE_AI_ENDPOINT?.trim()
    && env.AZURE_AI_KEY?.trim(),
  );
}

export async function embedText(
  text: string,
  env: Record<string, string | undefined> = process.env,
): Promise<number[] | null> {
  if (!isSemanticLibrarySearchEnabled(env)) return null;
  const input = text.trim().slice(0, MAX_EMBEDDING_INPUT_CHARS);
  if (!input) return null;

  const endpoint = env.AZURE_AI_ENDPOINT!.trim().replace(/\/+$/, '');
  const deployment = getEmbeddingDeploymentName(env);
  const apiVersion = env.AZURE_AI_EMBEDDING_API_VERSION?.trim()
    || env.AZURE_AI_API_VERSION?.trim()
    || '2024-10-21';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/embeddings?api-version=${encodeURIComponent(apiVersion)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': env.AZURE_AI_KEY!.trim(),
        },
        body: JSON.stringify({ input: [input] }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      console.error('SHADOW embedding request failed', { status: response.status });
      return null;
    }
    const payload = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
    const embedding = payload.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((v) => typeof v === 'number')) {
      console.error('SHADOW embedding response malformed');
      return null;
    }
    return embedding;
  } catch (error) {
    // Timeouts land here as AbortError; log class only, never content.
    console.error('SHADOW embedding request errored', {
      errorClass: error instanceof Error ? error.name : typeof error,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
