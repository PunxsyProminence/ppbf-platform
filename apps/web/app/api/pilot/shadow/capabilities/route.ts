import { NextRequest, NextResponse } from 'next/server';

import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getShadowChatCapabilities } from '@/src/server/pilot/shadowChatCapabilities';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    return NextResponse.json({
      success: true,
      capabilities: getShadowChatCapabilities(principal.role),
    });
  } catch (error) {
    return jsonError(error);
  }
}
