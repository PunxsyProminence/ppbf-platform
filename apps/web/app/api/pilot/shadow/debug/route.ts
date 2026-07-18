// GET /api/pilot/shadow/debug — Diagnose SHADOW AI connectivity
// Checks env vars (masked) and tests OpenAI connection directly
import { NextResponse, type NextRequest } from 'next/server';
import { requirePrincipal } from '@/src/server/pilot/http';
import { requireRole } from '@/src/server/pilot/access';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'platform_owner']);

    const endpoint = process.env.AZURE_AI_ENDPOINT;
    const apiKey = process.env.AZURE_AI_KEY;
    const deployment = process.env.AZURE_AI_DEPLOYMENT_NAME;
    const apiVersion = process.env.AZURE_AI_API_VERSION;
    const dbConn = process.env.AZURE_POSTGRES_CONNECTION_STRING;

    const envStatus = {
      AZURE_AI_ENDPOINT: endpoint ? `${endpoint.slice(0, 30)}...` : 'MISSING',
      AZURE_AI_KEY: apiKey ? `${apiKey.slice(0, 8)}...` : 'MISSING',
      AZURE_AI_DEPLOYMENT_NAME: deployment ?? 'MISSING',
      AZURE_AI_API_VERSION: apiVersion ?? 'MISSING',
      AZURE_POSTGRES_CONNECTION_STRING: dbConn ? `${dbConn.slice(0, 20)}...` : 'MISSING',
      NODE_VERSION: process.version,
    };

    // Test OpenAI if env vars present
    let aiTest: { ok: boolean; status?: number; response?: string; error?: string } = { ok: false };
    if (endpoint && apiKey && deployment) {
      try {
        const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion ?? '2024-12-01-preview'}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
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
      aiTest = { ok: false, error: 'Missing env vars' };
    }

    return NextResponse.json({ env: envStatus, aiTest, principal: { role: principal.role, org: principal.organizationId } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
