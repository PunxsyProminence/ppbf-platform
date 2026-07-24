import { NextRequest, NextResponse } from 'next/server';

import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  exportOwnShadowData,
  requestOwnShadowDataDeletion,
} from '@/src/server/pilot/shadowConversations';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const data = await exportOwnShadowData(principal);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const requestId = await requestOwnShadowDataDeletion(principal);
    return NextResponse.json({
      success: true,
      requestId,
      status: 'pending',
      fulfillment: 'manual_review_required',
    }, { status: 202 });
  } catch (error) {
    return jsonError(error);
  }
}
