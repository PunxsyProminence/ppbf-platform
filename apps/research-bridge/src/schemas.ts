import { z } from 'zod';

const MAX_RESEARCH_NEEDS = 500;
const MAX_APPROVED_EVIDENCE = 2_000;

export const sanitizedResearchNeedSchema = z.object({
  id: z.string().min(12).max(64),
  title: z.string().min(1).max(500),
  knowledge_gap: z.string().min(1).max(4_000),
  evidence_status: z.string().max(100),
  confidence_tier: z.string().max(100),
  verification_state: z.string().max(100),
  status: z.enum(['open', 'resolved']),
  created_at: z.string().min(1).max(100),
});

export const sanitizedEvidenceSchema = z.object({
  id: z.string().min(12).max(64),
  title: z.string().min(1).max(500),
  publisher: z.string().max(500).nullable(),
  source_type: z.enum(['peer_reviewed', 'clinical_guideline', 'governing_body', 'textbook']),
  authority_tier: z.number().int().min(1).max(5),
  url: z.string().url().max(2_000).nullable(),
  publication_date: z.string().max(100).nullable(),
  excerpt: z.string().min(1).max(4_000),
});

export const researchExportSchema = z.object({
  schema_version: z.literal('1'),
  classification: z.literal('sanitized-staging-only'),
  generated_at: z.string().min(1).max(100),
  research_needs: z.array(sanitizedResearchNeedSchema).max(MAX_RESEARCH_NEEDS),
  approved_evidence: z.array(sanitizedEvidenceSchema).max(MAX_APPROVED_EVIDENCE),
});

const researchExportEnvelopeSchema = z.object({
  schema_version: z.literal('1'),
  classification: z.literal('sanitized-staging-only'),
  generated_at: z.string().min(1).max(100),
  research_needs: z.array(z.unknown()),
  approved_evidence: z.array(z.unknown()),
});

function validItems<T>(items: unknown[], schema: z.ZodType<T>, max: number): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (parsed.success) {
      kept.push(parsed.data);
    }
  }
  const capped = kept.slice(0, max);
  return { kept: capped, dropped: items.length - capped.length };
}

/**
 * Reads an export item by item. The envelope must still be a PPBF export, or
 * the whole thing is refused; past that, an item the bridge cannot accept --
 * over a length limit, past the count cap -- is dropped alone.
 *
 * Parsing the export whole let one such item fail the sync, and a failed sync
 * never reaches its delete step, so evidence the app had withdrawn stayed in
 * the index (CL-C11). Dropping an item only ever removes it from the index; it
 * can never add anything the app did not send.
 */
export function parseResearchExport(input: unknown): { snapshot: ResearchExport; dropped: { research_needs: number; approved_evidence: number } } {
  const envelope = researchExportEnvelopeSchema.parse(input);
  const needs = validItems(envelope.research_needs, sanitizedResearchNeedSchema, MAX_RESEARCH_NEEDS);
  const evidence = validItems(envelope.approved_evidence, sanitizedEvidenceSchema, MAX_APPROVED_EVIDENCE);
  return {
    snapshot: researchExportSchema.parse({ ...envelope, research_needs: needs.kept, approved_evidence: evidence.kept }),
    dropped: { research_needs: needs.dropped, approved_evidence: evidence.dropped },
  };
}

export type SanitizedResearchNeed = z.infer<typeof sanitizedResearchNeedSchema>;
export type SanitizedEvidence = z.infer<typeof sanitizedEvidenceSchema>;
export type ResearchExport = z.infer<typeof researchExportSchema>;

export type ResearchIndexDocument = {
  id: string;
  kind: 'research_need' | 'approved_evidence';
  title: string;
  content: string;
  publisher: string | null;
  sourceType: string | null;
  authorityTier: number | null;
  url: string | null;
  publicationDate: string | null;
  status: string | null;
  syncedAt: string;
};
