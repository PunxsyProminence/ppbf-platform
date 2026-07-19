export interface AzureAiRuntimeConfig {
  endpoint: string;
  apiKey: string;
  deploymentName: string;
  apiVersion: string;
}

export interface AzureAiRuntimeCheck {
  ok: boolean;
  missing: Array<'AZURE_AI_ENDPOINT' | 'AZURE_AI_KEY' | 'AZURE_AI_DEPLOYMENT_NAME'>;
  config?: AzureAiRuntimeConfig;
}

const DEFAULT_API_VERSION = '2024-12-01-preview';

export function getAzureAiRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): AzureAiRuntimeCheck {
  const endpoint = env.AZURE_AI_ENDPOINT?.trim() ?? '';
  const apiKey = env.AZURE_AI_KEY?.trim() ?? '';
  const deploymentName = env.AZURE_AI_DEPLOYMENT_NAME?.trim() ?? '';
  const apiVersion = env.AZURE_AI_API_VERSION?.trim() || DEFAULT_API_VERSION;

  const missing: AzureAiRuntimeCheck['missing'] = [];
  if (!endpoint) missing.push('AZURE_AI_ENDPOINT');
  if (!apiKey) missing.push('AZURE_AI_KEY');
  if (!deploymentName) missing.push('AZURE_AI_DEPLOYMENT_NAME');

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    missing: [],
    config: {
      endpoint,
      apiKey,
      deploymentName,
      apiVersion,
    },
  };
}

export function buildAzureAiChatCompletionsUrl(config: AzureAiRuntimeConfig): string {
  return `${config.endpoint.replace(/\/$/, '')}/openai/deployments/${config.deploymentName}/chat/completions?api-version=${config.apiVersion}`;
}
