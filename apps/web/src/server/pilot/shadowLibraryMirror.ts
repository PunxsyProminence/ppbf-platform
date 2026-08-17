import { uploadToSharePoint, type SharePointConfig } from '@/src/server/document-intake/sharepoint';
import type { SharePointWriteResult } from '@/src/server/document-intake/types';
import {
  researchClassificationLabel,
  researchClassificationLayerLabel,
} from '@/src/shared/researchClassification';

import type { ShadowLibraryMirrorDocument, ShadowLibrarySourceRow } from './shadowLibrary';

// SharePoint is the single Microsoft-only home for this org's files; the
// mirror is a one-way backup copy of what's already citable in the app, not
// a second source of truth. It lives under its own root, distinct from the
// hand-curated Library Intake tree, so an automated export can never
// misfile into a curator's manual numbering scheme.
const MIRROR_ROOT = 'SHADOW Library Mirror';

function metadataString(source: ShadowLibrarySourceRow, key: string): string | undefined {
  const value = source.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function classificationSegment(source: ShadowLibrarySourceRow): { domainSegment: string; layerSegment: string } {
  const domain = metadataString(source, 'classification_domain');
  const layer = metadataString(source, 'classification_layer');
  return {
    domainSegment: domain ?? 'unclassified',
    layerSegment: layer ?? 'unclassified',
  };
}

/**
 * The path (including subfolders) passed as uploadToSharePoint's fileName --
 * Graph creates intermediate folders on PUT, so this alone is what keeps the
 * mirror organized by domain/layer without a separate folder-create step.
 */
export function shadowLibraryMirrorPath(source: ShadowLibrarySourceRow): string {
  const { domainSegment, layerSegment } = classificationSegment(source);
  return `${MIRROR_ROOT}/${domainSegment}/${layerSegment}/${source.source_id}.md`;
}

export function buildShadowLibraryMirrorMarkdown(
  source: ShadowLibrarySourceRow,
  documents: ShadowLibraryMirrorDocument[],
  mirroredAt: string,
): string {
  const domain = metadataString(source, 'classification_domain');
  const layer = metadataString(source, 'classification_layer');

  const header = [
    `# ${source.title}`,
    '',
    `- Source type: ${source.source_type}`,
    `- Publisher: ${source.publisher ?? '(none recorded)'}`,
    `- Authority tier: ${source.authority_tier}`,
    `- Classification domain: ${domain ? researchClassificationLabel(domain) : '(unclassified)'}`,
    `- Classification layer: ${layer ? researchClassificationLayerLabel(layer) : '(unclassified)'}`,
    `- URL: ${source.url ?? '(none recorded)'}`,
    `- Publication date: ${source.publication_date ?? '(unknown)'}`,
    `- Approval state: ${source.approval_state} / Verification state: ${source.verification_state}`,
    `- Mirrored from PPBF SHADOW Library on: ${mirroredAt}`,
    '',
    'This is a one-way backup copy. The app is the source of truth; edits made',
    'here are not read back.',
  ].join('\n');

  const body = documents
    .map((document) => `## ${document.document_name}\n\n${document.content || '(no extracted text)'}`)
    .join('\n\n---\n\n');

  return documents.length > 0 ? `${header}\n\n---\n\n${body}\n` : `${header}\n`;
}

export async function mirrorShadowLibrarySourceToSharePoint(
  config: SharePointConfig,
  source: ShadowLibrarySourceRow,
  documents: ShadowLibraryMirrorDocument[],
  mirroredAt: string,
): Promise<SharePointWriteResult> {
  const markdown = buildShadowLibraryMirrorMarkdown(source, documents, mirroredAt);
  return uploadToSharePoint(config, shadowLibraryMirrorPath(source), Buffer.from(markdown, 'utf8'), 'text/markdown');
}
