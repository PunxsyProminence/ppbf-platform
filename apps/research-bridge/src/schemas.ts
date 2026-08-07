import { z } from 'zod';

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
  research_needs: z.array(sanitizedResearchNeedSchema).max(500),
  approved_evidence: z.array(sanitizedEvidenceSchema).max(2_000),
});

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
