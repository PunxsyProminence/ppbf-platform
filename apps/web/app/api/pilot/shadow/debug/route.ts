// GET /api/pilot/shadow/debug — Diagnose SHADOW AI connectivity
// Checks env vars (masked) and tests OpenAI connection directly
import { NextResponse, type NextRequest } from 'next/server';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { requireRole } from '@/src/server/pilot/access';
import { buildAzureAiChatCompletionsUrl, getAzureAiRuntimeConfig } from '@/src/server/pilot/azureAiRuntime';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'platform_owner']);

    const runtime = getAzureAiRuntimeConfig();
    const dbConn = process.env.AZURE_POSTGRES_CONNECTION_STRING;

    const envStatus = {
      AZURE_AI_ENDPOINT: runtime.config?.endpoint ? `${runtime.config.endpoint.slice(0, 30)}...` : 'MISSING',
      AZURE_AI_KEY: runtime.config?.apiKey ? `${runtime.config.apiKey.slice(0, 8)}...` : 'MISSING',
      AZURE_AI_DEPLOYMENT_NAME: runtime.config?.deploymentName ?? 'MISSING',
      AZURE_AI_API_VERSION: runtime.config?.apiVersion ?? process.env.AZURE_AI_API_VERSION ?? 'MISSING',
      AZURE_POSTGRES_CONNECTION_STRING: dbConn ? `${dbConn.slice(0, 20)}...` : 'MISSING',
      NODE_VERSION: process.version,
      AZURE_AI_MISSING: runtime.missing,
    };

    // Test OpenAI if env vars present
    let aiTest: { ok: boolean; status?: number; response?: string; error?: string } = { ok: false };
    if (runtime.ok && runtime.config) {
      try {
        const url = buildAzureAiChatCompletionsUrl(runtime.config);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-key': runtime.config.apiKey },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'Say OK' }], max_completion_tokens: 50 }),
        });
        const status = res.status;
        if (res.ok) {
          const data = await res.json();
          aiTest = { ok: true, status, response: data.choices?.[0]?.message?.content ?? 'empty' };
        } else {
          const errText = await res.text();
          aiTest = { ok: false, status, error: errText.slice(0, 200) };
        }
      } catch (e) {
        aiTest = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    } else {
      aiTest = { ok: false, error: `Missing env vars: ${runtime.missing.join(', ')}` };
    }

    return NextResponse.json({ env: envStatus, aiTest, principal: { role: principal.role, org: principal.organizationId } });
  } catch (error) {
    return jsonError(error);
  }
}
