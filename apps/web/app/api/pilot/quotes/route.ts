import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  QUOTE_SHOWN,
  QUOTE_SOURCE_MAX,
  QUOTE_SPEAKER_MAX,
  QUOTE_TEXT_MAX,
  QUOTE_TYPES,
  createQuote,
  isQuoteShown,
  isQuoteType,
  listQuotes,
  updateQuote,
  type QuotePatch,
  type QuoteShown,
} from '@/src/server/pilot/orgQuotes';

export const runtime = 'nodejs';

// The quotes library. Staff read; the organization admin writes (an open owner
// question is whether coaches may also add quotes -- until it is answered the
// write door is the organization admin only). Every call is scoped to the
// signed-in principal's organization; an organization id in the request is
// never read.

const QUOTE_READ_ROLES = ['coach', 'organization_admin', 'admin'] as const;
const QUOTE_WRITE_ROLES = ['organization_admin', 'admin'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

// Postgres cannot store a NUL or an unpaired surrogate (an encoding error, not a
// check violation), so refuse them here as input errors rather than as a 500.
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text.`);
  const trimmed = value.trim();
  if (UNSTORABLE.test(trimmed)) throw new ValidationError(`${field} contains characters that cannot be stored.`);
  // Postgres length() counts characters, so count them the same way (not UTF-16 units).
  if ([...trimmed].length > max) throw new ValidationError(`${field} is too long (${max} characters at most).`);
  return trimmed;
}

function requiredText(value: unknown, field: string, max: number): string {
  const text = optionalText(value, field, max);
  if (!text) throw new ValidationError(`Missing ${field}.`);
  return text;
}

function optionalShown(value: unknown): QuoteShown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || !value.every(isQuoteShown)) {
    throw new ValidationError(`shown must be a non-empty list of: ${QUOTE_SHOWN.join(', ')}.`);
  }
  return [...new Set(value as QuoteShown[])];
}

function optionalType(value: unknown) {
  if (value === undefined) return undefined;
  if (!isQuoteType(value)) throw new ValidationError(`quote_type must be one of: ${QUOTE_TYPES.join(', ')}.`);
  return value;
}

function optionalActive(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ValidationError('active must be true or false.');
  return value;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...QUOTE_READ_ROLES]);

    const quotes = await listQuotes(principal.organizationId);
    return NextResponse.json({ ok: true, organization_id: principal.organizationId, quotes });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...QUOTE_WRITE_ROLES]);

    const body = await readBody(request);
    const quoteType = optionalType(body.quote_type);
    if (!quoteType) throw new ValidationError('Missing quote_type.');

    const quote = await createQuote({
      organizationId: principal.organizationId,
      quoteText: requiredText(body.quote_text, 'quote_text', QUOTE_TEXT_MAX),
      speaker: optionalText(body.speaker, 'speaker', QUOTE_SPEAKER_MAX) ?? '',
      quoteType,
      source: optionalText(body.source, 'source', QUOTE_SOURCE_MAX) ?? '',
      shown: optionalShown(body.shown) ?? ['anywhere'],
      active: optionalActive(body.active) ?? true,
    });

    await audit(principal, 'create', quote.quote_id, { quote_type: quote.quote_type, active: quote.active });
    return NextResponse.json({ ok: true, quote });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...QUOTE_WRITE_ROLES]);

    const body = await readBody(request);
    const quoteId = typeof body.quote_id === 'string' ? body.quote_id.trim() : '';
    if (!quoteId) throw new ValidationError('Missing quote_id.');
    if (!UUID.test(quoteId)) throw new ValidationError('quote_id is not valid.');

    const patch: QuotePatch = {
      quoteText: body.quote_text === undefined ? undefined : requiredText(body.quote_text, 'quote_text', QUOTE_TEXT_MAX),
      speaker: optionalText(body.speaker, 'speaker', QUOTE_SPEAKER_MAX),
      quoteType: optionalType(body.quote_type),
      source: optionalText(body.source, 'source', QUOTE_SOURCE_MAX),
      shown: optionalShown(body.shown),
      active: optionalActive(body.active),
    };
    if (Object.values(patch).every((value) => value === undefined)) {
      throw new ValidationError('Nothing to change.');
    }

    const quote = await updateQuote(principal.organizationId, quoteId, patch);
    if (!quote) return hiddenNotFound();

    await audit(principal, 'update', quote.quote_id, {
      changed: Object.entries(patch).filter(([, value]) => value !== undefined).map(([key]) => key),
      active: quote.active,
    });
    return NextResponse.json({ ok: true, quote });
  } catch (error) {
    return jsonError(error);
  }
}

async function audit(
  principal: PilotPrincipal,
  eventType: 'create' | 'update',
  quoteId: string,
  details: Record<string, unknown>,
) {
  await writePilotAuditEvent({
    event_type: eventType,
    actor_account_id: principal.accountId,
    actor_role: principal.role,
    organization_id: principal.organizationId,
    entity_type: 'org_quote',
    entity_id: quoteId,
    details,
  });
}
