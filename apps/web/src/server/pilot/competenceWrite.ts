import { randomUUID } from 'node:crypto';

import { type ActorIdentity, assertActorCanAccessAthlete, isOrganizationAdminRole } from './access';
import { writePilotAuditEvent } from './audit';
import { COMPETENCE_DOMAINS, type CompetenceDomain, gymToday } from './competenceCohorts';
import { withTransaction } from './db';
import { ForbiddenError, ValidationError } from './errors';

// The one writer of pilot.athlete_competence (OD-2026-10-03-002 section 6: "a
// coach sets it by hand"). competenceCohorts.ts stays the read side; cohort
// placement reads whatever this records, so an athlete changes rooms the moment
// a coach changes a level, with no membership list to update.
//
// WHO. A coach assigned to the athlete or covering them, or an organization
// admin -- exactly what assertActorCanAccessAthlete admits for those two roles.
// The role check comes first and is not optional: the same guard also admits an
// athlete to their own record and a parent to a linked child's, and neither
// may set a level.
//
// HISTORY, NOT OVERWRITE. The current row is marked superseded_by the new one
// and a new row is inserted, so every level an athlete has held stays readable.
// Saving the level the athlete already holds writes nothing.
//
// FIXED BY RULING (overwatch, 2026-10-05, on this lane's step 0): basis is
// always coach_observation, assessed_on is the gym's today and cannot be
// back-dated, and there is no action that removes a level.

export const EVIDENCE_NOTE_MAX_LENGTH = 500;

export interface SetAthleteCompetenceInput {
  athleteId: string;
  domain: CompetenceDomain;
  levelKey: string;
  evidenceNote: string;
}

export interface SetAthleteCompetenceResult {
  /** False when the athlete already held this level: nothing was written. */
  changed: boolean;
  competence_id: string;
  domain: CompetenceDomain;
  level_key: string;
  previous_level_key: string | null;
}

const DOMAIN_SET: ReadonlySet<string> = new Set(COMPETENCE_DOMAINS);

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`Missing ${field}.`);
  }
  return value.trim();
}

/** Validates a request body. The organization never comes from here. */
export function parseSetAthleteCompetenceBody(body: unknown): SetAthleteCompetenceInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object.');
  }
  const raw = body as Record<string, unknown>;

  const athleteId = requiredText(raw.athlete_id, 'athlete_id');
  const domain = requiredText(raw.domain, 'domain');
  if (!DOMAIN_SET.has(domain)) {
    throw new ValidationError('Unsupported domain.');
  }
  const levelKey = requiredText(raw.level_key, 'level_key');

  let evidenceNote = '';
  if (raw.evidence_note !== undefined && raw.evidence_note !== null) {
    if (typeof raw.evidence_note !== 'string') {
      throw new ValidationError('evidence_note must be text.');
    }
    evidenceNote = raw.evidence_note.trim();
    if (evidenceNote.length > EVIDENCE_NOTE_MAX_LENGTH) {
      throw new ValidationError(`evidence_note must be ${EVIDENCE_NOTE_MAX_LENGTH} characters or fewer.`);
    }
  }

  return { athleteId, domain: domain as CompetenceDomain, levelKey, evidenceNote };
}

export async function setAthleteCompetence(
  actor: ActorIdentity,
  input: SetAthleteCompetenceInput,
  options: { now?: Date } = {},
): Promise<SetAthleteCompetenceResult> {
  if (actor.role !== 'coach' && !isOrganizationAdminRole(actor.role)) {
    throw new ForbiddenError('Only a coach or an organization admin can set a competence level.');
  }
  if (!DOMAIN_SET.has(input.domain)) {
    throw new ValidationError('Unsupported domain.');
  }

  // Assigned or covering coach, or an admin of the athlete's own gym; a deleted
  // athlete fails here. Throws plain Forbidden errors, which jsonError maps to 403.
  await assertActorCanAccessAthlete(actor, input.athleteId);

  const organizationId = actor.organizationId;

  // The same refusal the guard gives this role, so losing a race to a delete
  // or a reassignment does not disclose which one happened.
  const refusal = actor.role === 'coach'
    ? 'Forbidden: coach not assigned to athlete'
    : 'Forbidden: athlete does not belong to organization';

  return withTransaction(async (client) => {
    // One lock does three jobs. It serializes level writes for this athlete,
    // so two saves cannot both find "no current row" and collide on the
    // one-current-row index; and it blocks a concurrent delete or coach
    // reassignment (both UPDATEs of this row) until this commits. Re-checking
    // under the lock closes the gap between the guard above and the write.
    const athlete = await client.query<{ coach_id: string; deleted_at: string | null }>(
      `select coach_id, deleted_at from pilot.athletes
       where organization_id = $1 and athlete_id = $2
       for no key update`,
      [organizationId, input.athleteId],
    );
    if (athlete.rows.length === 0 || athlete.rows[0].deleted_at !== null) {
      throw new Error(refusal);
    }
    if (actor.role === 'coach' && athlete.rows[0].coach_id !== actor.accountId) {
      // A covering coach: the grant must still be live, and `for share` holds
      // it against a revocation until this commits.
      const coverage = await client.query(
        `select 1 from pilot.coach_coverage
         where organization_id = $1 and athlete_id = $2 and covering_coach_id = $3
           and starts_at <= now() and expires_at > now()
         limit 1
         for share`,
        [organizationId, input.athleteId, actor.accountId],
      );
      if (coverage.rows.length === 0) {
        throw new Error(refusal);
      }
    }

    const level = await client.query<{ level_key: string }>(
      `select level_key from pilot.competence_levels
       where organization_id = $1 and level_key = $2`,
      [organizationId, input.levelKey],
    );
    if (level.rows.length === 0) {
      throw new ValidationError('Unsupported level_key: not on this gym\'s ladder.');
    }

    const current = await client.query<{ competence_id: string; level_key: string }>(
      `select competence_id, level_key from pilot.athlete_competence
       where organization_id = $1 and athlete_id = $2 and domain = $3
         and superseded_by is null`,
      [organizationId, input.athleteId, input.domain],
    );
    const previous = current.rows[0] ?? null;

    if (previous && previous.level_key === input.levelKey) {
      return {
        changed: false,
        competence_id: previous.competence_id,
        domain: input.domain,
        level_key: previous.level_key,
        previous_level_key: previous.level_key,
      };
    }

    const competenceId = `comp_${randomUUID()}`;

    // Supersede before inserting: the partial unique index allows one row per
    // (athlete, domain) with superseded_by null, and the new row is that row.
    if (previous) {
      await client.query(
        `update pilot.athlete_competence set superseded_by = $3
         where organization_id = $1 and competence_id = $2`,
        [organizationId, previous.competence_id, competenceId],
      );
    }

    await client.query(
      `insert into pilot.athlete_competence
         (organization_id, competence_id, athlete_id, domain, level_key, basis,
          assessed_by_account_id, assessed_on, evidence_note)
       values ($1,$2,$3,$4,$5,'coach_observation',$6,$7::date,$8)`,
      [
        organizationId,
        competenceId,
        input.athleteId,
        input.domain,
        input.levelKey,
        actor.accountId,
        gymToday(options.now),
        input.evidenceNote,
      ],
    );

    // On the same client, so the record of the change commits or rolls back
    // with it. The note itself stays out: details are mirrored to the shadow
    // event stream, and a free-text note about a child belongs in its own row.
    await writePilotAuditEvent({
      event_type: previous ? 'update' : 'create',
      actor_account_id: actor.accountId,
      actor_role: actor.role,
      organization_id: organizationId,
      entity_type: 'athlete_competence',
      entity_id: competenceId,
      details: {
        athlete_id: input.athleteId,
        domain: input.domain,
        level_key: input.levelKey,
        previous_level_key: previous?.level_key ?? null,
        previous_competence_id: previous?.competence_id ?? null,
        basis: 'coach_observation',
        has_evidence_note: input.evidenceNote !== '',
      },
    }, client);

    return {
      changed: true,
      competence_id: competenceId,
      domain: input.domain,
      level_key: input.levelKey,
      previous_level_key: previous?.level_key ?? null,
    };
  });
}
