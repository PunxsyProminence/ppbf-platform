import { NextResponse, type NextRequest } from 'next/server';

import type { PilotPrincipal } from './auth';
import type { PilotRole } from './contracts';
import { resolvePrincipal } from './auth';

export async function requirePrincipal(request: NextRequest): Promise<PilotPrincipal> {
  const principal = await resolvePrincipal(request);
  if (!principal) {
    throw new Error('Unauthorized');
  }
  return principal;
}

export function requireRole(principal: PilotPrincipal, allowedRoles: PilotRole[]): void {
  if (!allowedRoles.includes(principal.role)) {
    throw new Error('Forbidden');
  }
}

export function jsonError(error: unknown, fallbackStatus = 500): NextResponse {
  const message = error instanceof Error ? error.message : 'Unknown server error';

  if (message.startsWith('Unauthorized')) {
    return NextResponse.json({ error: message }, { status: 401 });
  }
  if (message.startsWith('Forbidden')) {
    return NextResponse.json({ error: message }, { status: 403 });
  }
  if (message.startsWith('Missing') || message.startsWith('Request body') || message.startsWith('Unsupported') || message.startsWith('PIN')) {
    return NextResponse.json({ error: message }, { status: 400 });
  }

  return NextResponse.json({ error: message }, { status: fallbackStatus });
}
