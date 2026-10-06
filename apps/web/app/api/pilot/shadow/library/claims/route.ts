import { NextResponse, type NextRequest } from 'next/server';

import type { PilotRole } from '@/src/server/pilot/contracts';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { requireRole } from '@/src/server/pilot/access';
import { createShadowLibraryClaim, type ShadowLibraryScope } from '@/src/server/pilot/shadowLibrary';
import {
  enforceShadowRateLimit,
  resolveShadowRateLimit,
  ShadowRateLimitExceeded,
  shadowRateLimitMessage,
} from '@/src/server/pilot/shadowRateLimit';
import { SHADOW_PROJECTION_READ_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

// Audit CL-C15. A Library question the Library cannot answer is stored as a
// research requirement, so its length is bounded here, before anything is
// searched or written. Questions are a sentence or two; this leaves room for a
// long one without letting a pasted document become a requirement row.
const QUESTION_MAX_CHARS = 2_000;

// Same scope restriction as library/search, and for the same reason: only
// 'scoped' | 'subject' are valid. createShadowLibraryClaim calls
// searchShadowLibrary/normalizeSearchScope internally, so this route inherits
// that enforcement rather than re-implementing it.
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_PROJECTION_READ_ROLES]);

    const body = (await request.json().catch(() => ({}))) as {
      question?: unknown;
      scope?: unknown;
      subject_id?: unknown;
      limit?: unknown;
    } | null;

    if (!body || typeof body.question !== 'string' || !body.question.trim()) {
      return NextResponse.json({ ok: false, error: 'Missing SHADOW library question' }, { status: 400 });
    }

    if (body.question.trim().length > QUESTION_MAX_CHARS) {
      return NextResponse.json(
        { ok: false, error: 'That question is too long for the Library (limit 2,000 characters). Shorten it and ask again.' },
        { status: 400 },
      );
    }

    if (body.scope !== undefined && body.scope !== 'scoped' && body.scope !== 'subject') {
      return NextResponse.json({ ok: false, error: 'scope must be "scoped" or "subject"' }, { status: 400 });
    }

    if (body.subject_id !== undefined && typeof body.subject_id !== 'string') {
      return NextResponse.json({ ok: false, error: 'subject_id must be a string' }, { status: 400 });
    }

    if (body.limit !== undefined && (typeof body.limit !== 'number' || !Number.isFinite(body.limit))) {
      return NextResponse.json({ ok: false, error: 'limit must be a number' }, { status: 400 });
    }

    await enforceShadowRateLimit({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      ...resolveShadowRateLimit('library_claim'),
    });

    const claim = await createShadowLibraryClaim({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role as PilotRole,
      athleteId: principal.athleteId,
      scope: body.scope as ShadowLibraryScope | undefined,
      subjectId: (body.subject_id as string | undefined) ?? null,
      question: body.question,
      limit: body.limit as number | undefined,
    });

    return NextResponse.json({ ok: true, claim });
  } catch (error) {
    if (error instanceof ShadowRateLimitExceeded) {
      return NextResponse.json(
        { ok: false, error: shadowRateLimitMessage(error.retryAfterSeconds, 'Library') },
        { status: 429, headers: { 'Retry-After': String(error.retryAfterSeconds) } },
      );
    }
    return jsonError(error);
  }
}
