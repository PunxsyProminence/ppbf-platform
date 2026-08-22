// POST /api/pilot/intake/document-link — short-lived read link for one
// intake document, so the reviewer can open what they are attesting about.
//
// A security review that cannot see the document is a rubber stamp; this is
// the seeing half of document-review. The link is a 15-minute read-only SAS
// URL, issued only to the roles that can review, and every issuance is
// audited -- these are quarantined files containing youth athletes' intake
// paperwork, and who looked at what must be answerable.
import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPilotShadowSasUrl } from '@/src/server/pilot/blob';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertActorCanAccessIntakeCase, getIntakeDocumentById } from '@/src/server/pilot/intake';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';

export const runtime = 'nodejs';

const LINK_EXPIRY_MINUTES = 15;

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);
    await assertShadowRuntimeReadiness({ requiredTables: ['intake_documents'] });

    const body = await request.json().catch(() => ({}));
    const intakeDocumentId = typeof body.intake_document_id === 'string' ? body.intake_document_id.trim() : '';
    if (!intakeDocumentId) {
      throw new Error('Missing intake_document_id');
    }

    const document = await getIntakeDocumentById(principal.organizationId, intakeDocumentId);
    if (!document) {
      throw new Error('Not found: intake document');
    }

    // The role gate above says WHAT KIND of account may mint a link. It never
    // said WHOSE paperwork, so any coach in the organization could mint a
    // 15-minute read URL to any child's medical form or signed waiver -- the
    // last step of a chain that starts at intake/review-queue (admits coach,
    // returns every case in the organization) and passes through
    // intake/cases/get. Same authority as that route, resolved from the case
    // this document belongs to, and applied before the SAS URL exists.
    //
    // A document whose case cannot be resolved is refused as unknown rather
    // than allowed: the FK makes that state unreachable today, and if it ever
    // becomes reachable the closed side is the right one.
    const authority = await assertActorCanAccessIntakeCase(
      principal,
      principal.organizationId,
      document.intake_case_id,
    );
    if (!authority.found) {
      throw new Error('Not found: intake document');
    }

    const url = getPilotShadowSasUrl(document.blob_path, LINK_EXPIRY_MINUTES);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'intake_document',
      entity_id: intakeDocumentId,
      details: {
        action: 'document_link_issued',
        intake_case_id: document.intake_case_id,
        file_name: document.file_name,
        expires_in_minutes: LINK_EXPIRY_MINUTES,
      },
      shadow_mirror: false,
    });

    // Every issuance is audited above, which only means something if each
    // audited issuance is the only way the link reaches a reader. The SAS URL
    // is a bearer credential -- 15 minutes of read access to a youth athlete's
    // intake paperwork for whoever holds the string -- so a copy left in the
    // browser's cache or in an intermediary hands it to a holder no audit row
    // names. Same header value the portrait routes use
    // (docs/capabilities/GATES.md §5), for the same reason.
    return NextResponse.json({
      ok: true,
      intake_document_id: intakeDocumentId,
      file_name: document.file_name,
      url,
      expires_in_minutes: LINK_EXPIRY_MINUTES,
    }, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
  } catch (error) {
    return jsonError(error);
  }
}
