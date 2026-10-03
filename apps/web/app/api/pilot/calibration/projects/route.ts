import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import {
  ANNOTATABLE_ONTOLOGY_VERSIONS,
  PROJECT_CREATION_ONTOLOGY_VERSION,
} from '@/src/server/pilot/calibration/ontology';
import {
  createCalibrationProject,
  listCalibrationProjects,
} from '@/src/server/pilot/calibration/projects';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

import { requireAnnotator, writeCalibrationAuditEvent } from '../annotatorGate';

export const runtime = 'nodejs';

/**
 * A study-name collision, and ONLY that.
 *
 * The named constraint is checked, not merely the 23505 code, for the reason
 * boardSeats.ts checks its own: any other unique violation on this insert --
 * a primary-key clash from a colliding UUID, say -- is a different fault
 * entirely, and reporting it as "that name is taken" would send a coach off
 * renaming a study over a problem that has nothing to do with the name.
 */
function isStudyNameTaken(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const { code, constraint, message } = error as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
  };
  if (code !== '23505') {
    return false;
  }
  const name = 'pilot_calibration_projects_name_uq';
  return constraint === name || (typeof message === 'string' && message.includes(name));
}

/**
 * The calibration studies this gym is running.
 *
 * Org-scoped from the session -- never from the caller.
 *
 * THIS FILE USED TO SAY creating a study was "an operator act" and that the
 * route "deliberately offers no way to create" one. That was true and it was
 * the defect: the only way to start a study was a hand-run script with a
 * production connection string, so the loop the Teach Shadow page describes --
 * film it, label it, measure, go again -- could not be walked by a coach at
 * all. POST is that missing door. It advances nothing and renames nothing;
 * those stay out until somebody needs them.
 *
 * `ontology_version` is returned verbatim on every row rather than assumed.
 * The annotation forms are built from the versions this build can label
 * (`annotatable_ontology_versions`), so a project stamped with any other
 * version is one this UI
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
      supported_ontology_version: PROJECT_CREATION_ONTOLOGY_VERSION,
      annotatable_ontology_versions: ANNOTATABLE_ONTOLOGY_VERSIONS,
      projects,
    });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Start a calibration study.
 *
 * THE ONTOLOGY VERSION IS NOT A PARAMETER. It is stamped from
 * PROJECT_CREATION_ONTOLOGY_VERSION, the vocabulary new studies are created
 * under, which is always one the annotation forms are generated from. A caller-supplied version would
 * let somebody open a study this UI cannot honestly label, which the GET
 * above already has to warn about for rows that predate the check.
 *
 * STATUS IS NOT A PARAMETER EITHER. createCalibrationProject opens every study
 * 'draft' -- "the study began unsettled" is the claim that module makes, and a
 * route that let a caller open one straight into 'adjudicating' would make it
 * false.
 *
 * THE NAME IS UNIQUE PER ORGANIZATION in the schema
 * (pilot_calibration_projects_name_uq), so a repeat is refused by the database
 * rather than quietly becoming a second study that looks like the first. That
 * collision arrives as a 23505 and is translated below, because "duplicate key
 * value violates unique constraint" is not a sentence to put in front of a
 * coach who has just typed a name.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);

    const body = await request.json().catch(() => ({}));
    const name = typeof body?.name === 'string' ? body.name.trim() : '';

    if (!name) {
      throw new Error('Missing name: a study needs a name people can find it by');
    }

    let project;
    try {
      project = await createCalibrationProject({
        organizationId: principal.organizationId,
        calibrationProjectId: randomUUID(),
        name,
        ontologyVersion: PROJECT_CREATION_ONTOLOGY_VERSION,
        createdByAccountId: principal.accountId,
      });
    } catch (error) {
      if (isStudyNameTaken(error)) {
        return NextResponse.json(
          {
            error: `A study called "${name}" already exists in this gym. Use it, or pick another name.`,
            reason: 'CALIBRATION_PROJECT_NAME_TAKEN',
          },
          { status: 409 },
        );
      }
      throw error;
    }

    /*
     * A FAILED AUDIT WRITE IS NOT SWALLOWED, for the reason bootstrap.ts gives
     * at length: the point of OD-2026-08-28-007's second half is that the act
     * is recorded, and reporting success while the record failed would be
     * worse than today because somebody would then believe a trail exists.
     *
     * Nothing can be rolled back from here -- createCalibrationProject takes
     * its own pooled connection and accepts no client -- so the refusal names
     * what was left behind instead.
     */
    try {
      await writeCalibrationAuditEvent({
        eventType: 'create',
        principal,
        entityType: 'calibration_project',
        entityId: project.calibration_project_id,
        details: {
          name: project.name,
          ontology_version: project.ontology_version,
          status: project.status,
        },
      });
    } catch (error) {
      /*
       * RETURNED, NOT THROWN. jsonError maps status by message PREFIX and
       * replaces anything it does not recognise with "Internal server error",
       * so a throw would swallow exactly the sentence that stops somebody
       * starting a second study with a different name to get past the error.
       * The clips route learned this the same way: from its own test.
       */
      const reason = error instanceof Error ? error.message : String(error);
      return NextResponse.json(
        {
          error: `${reason} -- the study "${project.name}" (${project.calibration_project_id}) was `
            + 'created before its audit record could be written and still exists, unaudited and '
            + 'with no clips. Use that study, or start another with a different name.',
          reason: 'CALIBRATION_PROJECT_AUDIT_FAILED',
          calibration_project_id: project.calibration_project_id,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, project }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
