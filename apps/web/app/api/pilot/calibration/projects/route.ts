import { NextResponse, type NextRequest } from 'next/server';

import { BOXING_ONTOLOGY_VERSION } from '@/src/server/pilot/calibration/ontology';
import { listCalibrationProjects } from '@/src/server/pilot/calibration/projects';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

import { requireAnnotator } from '../annotatorGate';

export const runtime = 'nodejs';

/**
 * The calibration studies this gym is running.
 *
 * READ ONLY, and org-scoped from the session -- never from the caller.
 * Creating a project and cutting its clips is an operator act performed
 * against src/server/pilot/calibration/projects.ts; this route exists so an
 * annotator can find the study they were asked to work on, and it deliberately
 * offers no way to create, rename, or advance one.
 *
 * `ontology_version` is returned verbatim on every row rather than assumed.
 * The build implements exactly one vocabulary, and the annotation forms are
 * built from it, so a project stamped with a different version is one this UI
 * cannot honestly label -- the page shows that rather than rendering 0.1's
 * dropdowns over it, and POST /annotation-set refuses to open a set on it.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);

    const projects = await listCalibrationProjects(principal.organizationId);

    // No audit row. This is a list read of study metadata -- no footage, no
    // athlete record, no annotation content crosses it -- and an audit write
    // on every page load would bury the writes that matter.
    return NextResponse.json({
      ok: true,
      supported_ontology_version: BOXING_ONTOLOGY_VERSION,
      projects,
    });
  } catch (error) {
    return jsonError(error);
  }
}
