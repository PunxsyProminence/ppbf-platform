import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  assertCanAuthorRabbitHoles,
  assertRabbitHoleAnchorType,
  listAuthoredRabbitHoles,
  listPublishedRabbitHoles,
} from '@/src/server/pilot/rabbitHoles';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const body = (await request.json().catch(() => ({}))) as {
      anchor_type?: string;
      anchor_key?: string;
      view?: string;
      limit?: number;
    };

    // The authoring view is the only read that returns retired lessons -- ones
    // the gym decided to stop showing. It is restricted to the roles that may
    // author, so a reader cannot reach a lesson that was taken down.
    if (body.view === 'authoring') {
      assertCanAuthorRabbitHoles(principal);

      const anchorType = body.anchor_type;
      if (anchorType !== undefined) {
        assertRabbitHoleAnchorType(anchorType);
      }

      const rabbit_holes = await listAuthoredRabbitHoles({
        organizationId: principal.organizationId,
        anchorType,
        anchorKey: body.anchor_key,
        limit: body.limit,
      });

      return NextResponse.json({
        ok: true,
        organization_id: principal.organizationId,
        rabbit_holes,
      });
    }

    const anchorType = body.anchor_type;
    assertRabbitHoleAnchorType(anchorType);

    if (typeof body.anchor_key !== 'string' || body.anchor_key.trim() === '') {
      throw new Error('Missing anchor_key');
    }

    // The anchor key is NOT checked against its vocabulary here. A read for a
    // key nothing was ever written against returns nothing, which is the same
    // answer either way; refusing it would turn a surface whose anchor drifted
    // into an error banner sitting on top of the page's real work.
    const rabbit_holes = await listPublishedRabbitHoles({
      organizationId: principal.organizationId,
      anchorType,
      anchorKey: body.anchor_key.trim(),
      role: principal.role,
    });

    return NextResponse.json({
      ok: true,
      organization_id: principal.organizationId,
      rabbit_holes,
    });
  } catch (error) {
    return jsonError(error);
  }
}
