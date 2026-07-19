import { buildAzureAiChatCompletionsUrl, getAzureAiRuntimeConfig } from './azureAiRuntime';

describe('azureAiRuntime', () => {
  test('reports missing required Azure AI variables', () => {
    const result = getAzureAiRuntimeConfig({
      AZURE_AI_ENDPOINT: '',
      AZURE_AI_KEY: undefined,
      AZURE_AI_DEPLOYMENT_NAME: '',
      AZURE_AI_API_VERSION: undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([
      'AZURE_AI_ENDPOINT',
      'AZURE_AI_KEY',
      'AZURE_AI_DEPLOYMENT_NAME',
    ]);
  });

  test('returns normalized config when all required vars exist', () => {
    const result = getAzureAiRuntimeConfig({
      AZURE_AI_ENDPOINT: 'https://shadow-ai.openai.azure.com/',
      AZURE_AI_KEY: 'abc123',
      AZURE_AI_DEPLOYMENT_NAME: 'gpt-5-mini-shadow',
      AZURE_AI_API_VERSION: '2024-12-01-preview',
    });

    expect(result.ok).toBe(true);
    expect(result.config).toEqual({
      endpoint: 'https://shadow-ai.openai.azure.com/',
      apiKey: 'abc123',
      deploymentName: 'gpt-5-mini-shadow',
      apiVersion: '2024-12-01-preview',
    });
  });

  test('builds chat completions URL from config', () => {
    const url = buildAzureAiChatCompletionsUrl({
      endpoint: 'https://shadow-ai.openai.azure.com/',
      apiKey: 'x',
      deploymentName: 'gpt-5-mini-shadow',
      apiVersion: '2024-12-01-preview',
    });

    expect(url).toBe('https://shadow-ai.openai.azure.com/openai/deployments/gpt-5-mini-shadow/chat/completions?api-version=2024-12-01-preview');
  });
});
