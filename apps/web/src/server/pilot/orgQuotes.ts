import { randomUUID } from 'node:crypto';

import { query } from './db';
import { ValidationError } from './errors';

// The quotes library: an organization's own sayings, motivational lines and
// boxing quotes. Every function takes the organization id as its first
// argument and every query is scoped to it; the routes pass the signed-in
// principal's organization, never one from the request.
//
// There is no delete: a quote that was on the wall is part of what the gym
// said, so it is switched off (active = false), not removed. A reader that
// draws quotes for display must use listLiveQuotes so an inactive one cannot
// reach a screen. The table is owned by
// infra/azure/pilot_slice_postgres_org_quotes_migration.sql.

export const QUOTE_TYPES = ['gym_saying', 'motivational', 'boxing_quote'] as const;
export type QuoteType = (typeof QUOTE_TYPES)[number];

// Mirrors gymSayings.ts SayingContext and the check constraint in the migration.
export const QUOTE_SHOWN = ['anywhere', 'after-hard-session', 'at-a-milestone'] as const;
export type QuoteShown = (typeof QUOTE_SHOWN)[number];

export const QUOTE_TEXT_MAX = 280;
export const QUOTE_SPEAKER_MAX = 120;
export const QUOTE_SOURCE_MAX = 500;

export interface OrgQuote {
  quote_id: string;
  organization_id: string;
  quote_text: string;
  speaker: string;
  quote_type: QuoteType;
  source: string;
  shown: QuoteShown[];
  active: boolean;
  created_at: string;
  updated_at: string;
}

const FIELDS =
  'quote_id, organization_id, quote_text, speaker, quote_type, source, shown, active, created_at, updated_at';

export function isQuoteType(value: unknown): value is QuoteType {
  return QUOTE_TYPES.includes(value as QuoteType);
}

export function isQuoteShown(value: unknown): value is QuoteShown {
  return QUOTE_SHOWN.includes(value as QuoteShown);
}

/** Everything the organization has, active or not, newest first. Authoring and staff reads only. */
export async function listQuotes(organizationId: string): Promise<OrgQuote[]> {
  return query<OrgQuote>(
    `select ${FIELDS} from pilot.org_quotes
     where organization_id = $1
     order by active desc, created_at desc, quote_id`,
    [organizationId],
  );
}

/** Only quotes the gym has switched on: what a screen may draw. */
export async function listLiveQuotes(organizationId: string): Promise<OrgQuote[]> {
  return query<OrgQuote>(
    `select ${FIELDS} from pilot.org_quotes
     where organization_id = $1 and active
     order by created_at desc, quote_id`,
    [organizationId],
  );
}

// 23505 = unique_violation: the same words are already in this gym's library.
function rethrowDuplicate(error: unknown): never {
  if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505') {
    throw new ValidationError('That quote is already in the library.');
  }
  throw error;
}

export async function createQuote(params: {
  organizationId: string;
  quoteText: string;
  speaker: string;
  quoteType: QuoteType;
  source: string;
  shown: QuoteShown[];
  active: boolean;
}): Promise<OrgQuote> {
  const quoteId = randomUUID();
  try {
    const rows = await query<OrgQuote>(
      `insert into pilot.org_quotes
         (organization_id, quote_id, quote_text, speaker, quote_type, source, shown, active)
       values ($1, $2, $3, $4, $5, $6, $7::text[], $8)
       returning ${FIELDS}`,
      [
        params.organizationId,
        quoteId,
        params.quoteText,
        params.speaker,
        params.quoteType,
        params.source,
        params.shown,
        params.active,
      ],
    );
    if (!rows[0]) {
      throw new Error('Quote write verification failed');
    }
    return rows[0];
  } catch (error) {
    return rethrowDuplicate(error);
  }
}

/** Fields an edit may change. Anything left undefined is kept as it is. */
export interface QuotePatch {
  quoteText?: string;
  speaker?: string;
  quoteType?: QuoteType;
  source?: string;
  shown?: QuoteShown[];
  active?: boolean;
}

/** Returns null when no quote in this organization carries that id. */
export async function updateQuote(
  organizationId: string,
  quoteId: string,
  patch: QuotePatch,
): Promise<OrgQuote | null> {
  try {
    const rows = await query<OrgQuote>(
      `update pilot.org_quotes set
         quote_text = coalesce($3, quote_text),
         speaker    = coalesce($4, speaker),
         quote_type = coalesce($5, quote_type),
         source     = coalesce($6, source),
         shown      = coalesce($7::text[], shown),
         active     = coalesce($8, active),
         updated_at = now()
       where organization_id = $1 and quote_id = $2
       returning ${FIELDS}`,
      [
        organizationId,
        quoteId,
        patch.quoteText ?? null,
        patch.speaker ?? null,
        patch.quoteType ?? null,
        patch.source ?? null,
        patch.shown ?? null,
        patch.active ?? null,
      ],
    );
    return rows[0] ?? null;
  } catch (error) {
    return rethrowDuplicate(error);
  }
}
