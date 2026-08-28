/**
 * The five disciplines every gym starts with.
 *
 * These exist twice on purpose, and the duplication is guarded rather than
 * tolerated -- the same arrangement complianceRuleSeeds.ts uses, for the same
 * reason, with one difference worth stating because it changes where the guard
 * has to point.
 *
 * For compliance rules the second copy is a migration. For disciplines there is
 * no seeding migration at all: `apps/web/seed-data/multidiscipline/seed_disciplines.csv`
 * is loaded by `npm run seed:disciplines`, an operator step that seeds ONE
 * organization per run (seed-disciplines.mjs reads a single PPBF_SEED_ORG_ID).
 * So this module seeds a gym created after that step, at the moment it is
 * created, and `disciplineSeedsOwnership.test.ts` parses the CSV and fails if
 * the two ever disagree.
 *
 * WHY THIS BECAME LOAD-BEARING. `pilot.session_scripts`, `pilot.drill_library`
 * and `pilot.cohort_definitions` each carry a composite foreign key to
 * `pilot.disciplines(organization_id, discipline)`, and each defaults its
 * `discipline` column to 'boxing'. A gym created through createOrganization
 * with an empty registry therefore cannot hold a session script, a drill or a
 * cohort AT ALL -- including rows that never mention a discipline, because the
 * default is itself an unregistered reference. The failure is a bare 23503 at
 * the first write, far from its cause.
 *
 * auth.ts already records this exact bug class for the other two registries:
 * "The seed migrations only reach organizations that existed when an operator
 * ran them, so a gym created afterwards through this route started with an
 * empty rule set". This is that gap, one registry over, closed the same way.
 *
 * ACTIVE FLAGS ARE THE CSV'S, NOT A NEW JUDGEMENT. Boxing and physical
 * preparation seed active; wrestling, BJJ and combatives seed inactive --
 * present so the tables above can reference them, not yet lanes with
 * curriculum. Which disciplines a gym runs is the gym's decision to make later
 * by flipping `active`, and nothing here decides it for them.
 */
import type { PoolClient } from 'pg';

import { withTransaction } from './db';

export type DisciplineSeed = {
  readonly discipline: string;
  readonly displayName: string;
  readonly lane: string;
  readonly exposureModel: string;
  readonly governingBody: string;
  readonly agePolicySource: string;
  readonly youthPermitted: boolean;
  readonly adultPermitted: boolean;
  readonly mixedAgePermitted: boolean;
  readonly evidenceNote: string;
  readonly active: boolean;
};

export const DEFAULT_DISCIPLINES: readonly DisciplineSeed[] = [
  {
    discipline: "boxing",
    displayName: "Boxing",
    lane: "striking",
    exposureModel: "head_impact",
    governingBody: "USA Boxing",
    agePolicySource: "USA Boxing rulebook; PA state athletic commission for professional",
    youthPermitted: true,
    adultPermitted: true,
    mixedAgePermitted: false,
    evidenceNote: "1,193-claim registry; 376 boxing-specific claims. Head impact exposure documented (A2-076, A3-033).",
    active: true,
  },
  {
    discipline: "wrestling",
    displayName: "Wrestling",
    lane: "grappling",
    exposureModel: "positional_grappling",
    governingBody: "PIAA / NFHS (scholastic)",
    agePolicySource: "PIAA and NFHS rules; PPBF is an assistant-coaching relationship, not the sanctioning body",
    youthPermitted: true,
    adultPermitted: true,
    mixedAgePermitted: false,
    evidenceNote: "CB-002 youth injury trend; CB-003 cervical spine surveillance; CB-007 weight-cutting. No PPBF wrestling curriculum yet.",
    active: false,
  },
  {
    discipline: "bjj",
    displayName: "Brazilian Jiu-Jitsu",
    lane: "grappling",
    exposureModel: "positional_grappling",
    governingBody: "Event-dependent; PA state rules for youth competition",
    agePolicySource: "Pennsylvania state regulations for youth BJJ competition — external authority, human-entered",
    youthPermitted: true,
    adultPermitted: true,
    mixedAgePermitted: false,
    evidenceNote: "CB-004 competition incidence 9.2/1000 exposures; CB-005 training prevalence. Youth eligibility is state-determined.",
    active: false,
  },
  {
    discipline: "combatives",
    displayName: "Combatives",
    lane: "mixed",
    exposureModel: "mixed_contact",
    governingBody: "None — civilian adaptation, no sanctioning body",
    agePolicySource: "PPBF policy; youth participation follows the BJJ/state pathway where grappling is involved",
    youthPermitted: true,
    adultPermitted: true,
    mixedAgePermitted: true,
    evidenceNote: "CB-001 military concussion incidence (NOT transferable as a rate). CB-008: NO instructional or curriculum evidence exists. Content is coaching craft.",
    active: false,
  },
  {
    discipline: "conditioning",
    displayName: "Physical Preparation",
    lane: "non_contact",
    exposureModel: "none",
    governingBody: "None",
    agePolicySource: "PPBF policy",
    youthPermitted: true,
    adultPermitted: true,
    mixedAgePermitted: true,
    evidenceNote: "Physical test battery with sensitivity-derived retest intervals; 20 tests.",
    active: true,
  },
];

/**
 * Registers the platform's five disciplines for one organization.
 *
 * `on conflict do nothing` on the registry's own primary key, so a gym that
 * already has a discipline keeps it exactly as it is -- including one it has
 * deactivated, renamed, or had seeded by the operator CSV path. Re-running
 * cannot overturn a gym's own decision about what it runs.
 *
 * Takes an optional client so createOrganization can seed inside the same
 * transaction that creates the organization: a gym that half-exists, with rows
 * in pilot.organizations and none in pilot.disciplines, is the state this
 * exists to prevent.
 */
export async function seedDefaultDisciplines(
  organizationId: string,
  client?: PoolClient,
): Promise<void> {
  const run = async (execute: (text: string, values: unknown[]) => Promise<unknown>) => {
    for (const seed of DEFAULT_DISCIPLINES) {
      await execute(
        `insert into pilot.disciplines (
           organization_id, discipline, display_name, lane, exposure_model, governing_body,
           age_policy_source, youth_permitted, adult_permitted, mixed_age_permitted,
           evidence_note, active
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         on conflict (organization_id, discipline) do nothing`,
        [
          organizationId,
          seed.discipline,
          seed.displayName,
          seed.lane,
          seed.exposureModel,
          seed.governingBody,
          seed.agePolicySource,
          seed.youthPermitted,
          seed.adultPermitted,
          seed.mixedAgePermitted,
          seed.evidenceNote,
          seed.active,
        ],
      );
    }
  };

  if (client) {
    await run((text, values) => client.query(text, values));
    return;
  }

  await withTransaction(async (transactionClient) => {
    await run((text, values) => transactionClient.query(text, values));
  });
}
