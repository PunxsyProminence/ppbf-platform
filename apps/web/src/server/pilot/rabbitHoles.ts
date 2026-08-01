import { randomUUID } from 'node:crypto';

import { boardSeatConfigs } from '@/app/board/boardWorkspaceConfig';

import { isOrganizationAdminRole } from './access';
import type { PilotRole } from './contracts';
import { query, queryOne } from './db';
import { FORMULA_IDS } from './formulas/types';
import type { ProgressionGap } from './progression';
import type { ShadowEvidenceTier } from './shadowEvidenceTier';

/**
 * Rabbit holes: authored deep-dive lessons, read from inside the thing they
 * explain.
 *
 * A lesson is CONCEPT + HOMEWORK -- explain why something works, then give the
 * reader something to do with it. It is GYM COACHING, written by a person. It
 * is never SHADOW evidence, so nothing here derives, stores or returns an
 * evidence tier: PROVEN / EMERGING / EXPERIMENTAL / RESEARCH_NEEDED grade how
 * much retrieved and cited material backed a generated answer, and a
 * hand-written claim cannot borrow that authority. What a lesson may carry
 * instead is a pointer into the SHADOW Library, resolved at read time against
 * the approval predicate rather than trusted -- see CITATION_JOIN.
 *
 * pilot.rabbit_holes is owned by
 * infra/azure/pilot_slice_postgres_rabbit_holes_migration.sql and applied
 * through the apply-migrations workflow. Nothing here may issue DDL.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT TOUCH: no athlete_id, no subject_id,
 * no assignment. A rabbit hole is teaching about a vocabulary term, never an
 * observation about a person -- which is what makes audience 'all' and audience
 * 'board' safe, and leaves the board's aggregate-only rule untouched.
 */

// ANCHOR KEY VALIDITY IS OWNED HERE.
//
// anchor_key holds values drawn from eight separate vocabularies, so no CHECK
// in SQL could be correct: a constraint listing every value of all eight would
// accept 'technique' under anchor_type 'formula_id'. The migration says so
// outright and records the obligation as a test. This is where the obligation
// is met, and each vocabulary below is SOURCED from its own authority rather
// than retyped, because a lesson anchored to a key nothing renders is a lesson
// nobody will ever see.
//
// The element types are what fails the build if a source union grows: the two
// progression vocabularies are typed by pilot.progression_gaps' own unions, and
// evidence tiers by ShadowEvidenceTier. rabbitHoles.test.ts closes the loop in
// the other direction -- it reads the CHECK constraints and the registries and
// asserts nothing has been left out of a list here.
const CLOSED_ANCHOR_KEYS = {
  gap_type: ['technique', 'strength', 'endurance', 'skill', 'mental', 'tactical'],
  severity: ['critical', 'high', 'medium', 'low'],
  formula_id: FORMULA_IDS,
  board_seat: boardSeatConfigs.map((seat) => seat.slug),
  evidence_tier: ['PROVEN', 'EMERGING', 'EXPERIMENTAL', 'RESEARCH_NEEDED'],
  // The one vocabulary with no runtime array to import: the union is frozen in
  // the workspace components, so the three bands are written out here.
  readiness_band: ['GREEN', 'YELLOW', 'RED'],
} satisfies {
  gap_type: readonly ProgressionGap['gap_type'][];
  severity: readonly ProgressionGap['severity'][];
  formula_id: readonly string[];
  board_seat: readonly string[];
  evidence_tier: readonly ShadowEvidenceTier[];
  readiness_band: readonly string[];
};

export type ClosedAnchorType = keyof typeof CLOSED_ANCHOR_KEYS;

// The two vocabularies whose values are rows rather than constants. A
// compliance rule slug and a drill id exist only for the organization that
// created them, so validity is a lookup against that organization's own rows --
// the same guarantee the closed lists give, obtained the only way it can be.
export const ORGANIZATION_SCOPED_ANCHOR_TYPES = ['compliance_rule', 'drill'] as const;

export type OrganizationScopedAnchorType = (typeof ORGANIZATION_SCOPED_ANCHOR_TYPES)[number];

export type RabbitHoleAnchorType = ClosedAnchorType | OrganizationScopedAnchorType;

// Derived from the two declarations above rather than written a third time, so
// the anchor vocabulary exists in exactly one place on this side.
export const RABBIT_HOLE_ANCHOR_TYPES: readonly RabbitHoleAnchorType[] = [
  ...(Object.keys(CLOSED_ANCHOR_KEYS) as ClosedAnchorType[]),
  ...ORGANIZATION_SCOPED_ANCHOR_TYPES,
];

export const RABBIT_HOLE_CLOSED_ANCHOR_KEYS: Readonly<Record<ClosedAnchorType, readonly string[]>> =
  CLOSED_ANCHOR_KEYS;

// The account role vocabulary plus 'all' for a lesson addressed to the whole
// gym, mirroring the audience CHECK. Naming a role no account can hold produces
// a lesson nobody can be shown.
export const RABBIT_HOLE_AUDIENCES: readonly (PilotRole | 'all')[] = [
  'all',
  'platform_owner',
  'organization_admin',
  'admin',
  'coach',
  'athlete',
  'parent',
  'board',
  'volunteer',
  'staff',
];

export type RabbitHoleAudience = (typeof RABBIT_HOLE_AUDIENCES)[number];

// Published or retired. Coaches publish directly -- there is no review state,
// because there is no reviewer. Retiring is how a lesson leaves the surface;
// nothing is deleted, so homework a reader is part-way through stays on record.
export const RABBIT_HOLE_STATUSES = ['published', 'retired'] as const;

export type RabbitHoleStatus = (typeof RABBIT_HOLE_STATUSES)[number];

const MAX_ANCHOR_KEY_LENGTH = 120;
const MAX_TITLE_LENGTH = 160;
const MAX_CONCEPT_LENGTH = 6000;
const MAX_HOMEWORK_LENGTH = 2000;
const MAX_AUTHOR_NAME_LENGTH = 120;
const MAX_DOCUMENT_ID_LENGTH = 200;
const MAX_AUTHORING_LIMIT = 200;

export interface RabbitHoleCitation {
  document_id: string;
  document_name: string;
}

/**
 * One lesson as a reader receives it.
 *
 * No author_account_id, no status, and no unresolved library_document_id: a
 * reference that did not resolve is not a citation, and returning the raw id
 * would put an unapproved document's identifier on the surface. `citation` is
 * present only when the pointer resolved under the full approval predicate.
 */
export interface RabbitHoleLesson {
  rabbit_hole_id: string;
  anchor_type: RabbitHoleAnchorType;
  anchor_key: string;
  audience: RabbitHoleAudience;
  title: string;
  concept: string;
  homework: string | null;
  author_display_name: string;
  citation: RabbitHoleCitation | null;
  created_at: string;
  updated_at: string;
}

// What the coach who wrote it needs in order to manage it, which a reader
// does not get.
export interface AuthoredRabbitHole extends RabbitHoleLesson {
  status: RabbitHoleStatus;
  author_account_id: string | null;
  library_document_id: string | null;
}

interface RabbitHoleRow {
  rabbit_hole_id: string;
  anchor_type: RabbitHoleAnchorType;
  anchor_key: string;
  audience: RabbitHoleAudience;
  title: string;
  concept: string;
  homework: string | null;
  author_display_name: string;
  status: RabbitHoleStatus;
  author_account_id: string | null;
  library_document_id: string | null;
  created_at: string;
  updated_at: string;
  cited_document_id: string | null;
  cited_document_name: string | null;
}

const LESSON_COLUMNS = `
    r.rabbit_hole_id,
    r.anchor_type,
    r.anchor_key,
    r.audience,
    r.title,
    r.concept,
    r.homework,
    r.author_display_name,
    r.status,
    r.author_account_id,
    r.library_document_id,
    r.created_at,
    r.updated_at,
    d.document_id as cited_document_id,
    d.document_name as cited_document_name`;

// The citation is RESOLVED, never trusted. library_document_id carries no
// foreign key because existence is not the property that matters: a document is
// citable only while it is indexed, approved and verified, hanging off an
// active, approved, verified source, and in the SAME organization -- seven
// mutable columns across two tables, and approval is revocable. Without a
// foreign key, organization scoping of the citation is this join's
// responsibility. A left join, so a reference that does not resolve leaves the
// lesson standing and the citation simply absent.
const CITATION_JOIN = `
  left join pilot.shadow_library_documents d
    on d.organization_id = r.organization_id
   and d.document_id = r.library_document_id
   and d.ingest_state = 'indexed'
   and d.index_completed_at is not null
   and d.approval_state = 'approved'
   and d.verification_state = 'verified'
   and exists (
     select 1
     from pilot.shadow_library_sources s
     where s.source_id = d.source_id
       and s.organization_id = d.organization_id
       and s.status = 'active'
       and s.approval_state = 'approved'
       and s.verification_state = 'verified'
   )`;

function toLesson(row: RabbitHoleRow): RabbitHoleLesson {
  return {
    rabbit_hole_id: row.rabbit_hole_id,
    anchor_type: row.anchor_type,
    anchor_key: row.anchor_key,
    audience: row.audience,
    title: row.title,
    concept: row.concept,
    homework: row.homework,
    author_display_name: row.author_display_name,
    citation: row.cited_document_id && row.cited_document_name
      ? { document_id: row.cited_document_id, document_name: row.cited_document_name }
      : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toAuthored(row: RabbitHoleRow): AuthoredRabbitHole {
  return {
    ...toLesson(row),
    status: row.status,
    author_account_id: row.author_account_id,
    library_document_id: row.library_document_id,
  };
}

export function isRabbitHoleAnchorType(value: unknown): value is RabbitHoleAnchorType {
  return RABBIT_HOLE_ANCHOR_TYPES.includes(value as RabbitHoleAnchorType);
}

export function isRabbitHoleAudience(value: unknown): value is RabbitHoleAudience {
  return RABBIT_HOLE_AUDIENCES.includes(value as RabbitHoleAudience);
}

export function isRabbitHoleStatus(value: unknown): value is RabbitHoleStatus {
  return RABBIT_HOLE_STATUSES.includes(value as RabbitHoleStatus);
}

export function assertRabbitHoleAnchorType(value: unknown): asserts value is RabbitHoleAnchorType {
  if (!isRabbitHoleAnchorType(value)) {
    throw new Error('Unsupported anchor_type: not one of the anchor vocabularies');
  }
}

function assertText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing ${field}`);
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`Unsupported ${field}: longer than ${maxLength} characters`);
  }

  return trimmed;
}

function assertOptionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }

  return assertText(value, field, maxLength);
}

/**
 * The key belongs to the vocabulary its anchor_type names.
 *
 * Nothing in the schema catches this failing, which is why it is asserted on
 * every write path here rather than left to whichever surface happens to call
 * one.
 */
export async function assertRabbitHoleAnchor(params: {
  organizationId: string;
  anchorType: unknown;
  anchorKey: unknown;
}): Promise<{ anchorType: RabbitHoleAnchorType; anchorKey: string }> {
  assertRabbitHoleAnchorType(params.anchorType);
  const anchorType = params.anchorType;
  const anchorKey = assertText(params.anchorKey, 'anchor_key', MAX_ANCHOR_KEY_LENGTH);

  const closed = (CLOSED_ANCHOR_KEYS as Record<string, readonly string[]>)[anchorType];
  if (closed) {
    if (!closed.includes(anchorKey)) {
      throw new Error(`Unsupported anchor_key: not a value of the ${anchorType} vocabulary`);
    }
    return { anchorType, anchorKey };
  }

  if (anchorType === 'drill') {
    const drill = await queryOne<{ drill_id: string }>(
      'select drill_id from pilot.drills where organization_id = $1 and drill_id = $2',
      [params.organizationId, anchorKey],
    );
    if (!drill) {
      throw new Error('Unsupported anchor_key: no drill in this organization carries that id');
    }
    return { anchorType, anchorKey };
  }

  // rule_id is deterministic ('rule_<category>_<organization_id>_<slug>'), so
  // the slug a lesson anchors to is the suffix after the organization id.
  const rule = await queryOne<{ rule_id: string }>(
    `select rule_id
     from pilot.compliance_rules
     where organization_id = $1
       and split_part(rule_id, '_' || organization_id || '_', 2) = $2`,
    [params.organizationId, anchorKey],
  );
  if (!rule) {
    throw new Error('Unsupported anchor_key: no compliance rule in this organization carries that slug');
  }

  return { anchorType, anchorKey };
}

/**
 * Which audience values one role may be shown.
 *
 * 'all' plus the caller's own role -- and, for an administrator, both spellings
 * of the administrator role. 'admin' rows predate 'organization_admin' and the
 * platform treats the two as the same person, so a lesson addressed to one must
 * not be invisible to the other.
 */
export function audiencesVisibleTo(role: PilotRole): string[] {
  const audiences = new Set<string>(['all', role]);
  if (isOrganizationAdminRole(role)) {
    audiences.add('admin');
    audiences.add('organization_admin');
  }
  return [...audiences];
}

/**
 * Every published lesson for one organization, one anchor and one reader.
 *
 * Organization-scoped in the where clause and in the citation join: a lesson
 * never crosses gyms, and neither does the document it cites.
 */
export async function listPublishedRabbitHoles(params: {
  organizationId: string;
  anchorType: RabbitHoleAnchorType;
  anchorKey: string;
  role: PilotRole;
}): Promise<RabbitHoleLesson[]> {
  assertRabbitHoleAnchorType(params.anchorType);
  const anchorKey = assertText(params.anchorKey, 'anchor_key', MAX_ANCHOR_KEY_LENGTH);

  const rows = await query<RabbitHoleRow>(
    `select ${LESSON_COLUMNS}
     from pilot.rabbit_holes r
     ${CITATION_JOIN}
     where r.organization_id = $1
       and r.anchor_type = $2
       and r.anchor_key = $3
       and r.audience = any($4::text[])
       and r.status = 'published'
     order by r.created_at, r.title`,
    [params.organizationId, params.anchorType, anchorKey, audiencesVisibleTo(params.role)],
  );

  return rows.map(toLesson);
}

/**
 * The authoring view: everything one organization has written, retired lessons
 * included, so a coach can see what they took down and put it back.
 *
 * Restricted by its callers to the roles that may author -- a retired lesson is
 * one the gym decided to stop showing, and a reader must not reach it here.
 */
export async function listAuthoredRabbitHoles(params: {
  organizationId: string;
  anchorType?: RabbitHoleAnchorType;
  anchorKey?: string;
  limit?: number;
}): Promise<AuthoredRabbitHole[]> {
  const conditions = ['r.organization_id = $1'];
  const values: unknown[] = [params.organizationId];

  if (params.anchorType !== undefined) {
    assertRabbitHoleAnchorType(params.anchorType);
    values.push(params.anchorType);
    conditions.push(`r.anchor_type = $${values.length}`);
  }

  if (params.anchorKey !== undefined) {
    values.push(assertText(params.anchorKey, 'anchor_key', MAX_ANCHOR_KEY_LENGTH));
    conditions.push(`r.anchor_key = $${values.length}`);
  }

  const limit = Number.isFinite(params.limit)
    ? Math.max(1, Math.min(params.limit as number, MAX_AUTHORING_LIMIT))
    : 50;

  const rows = await query<RabbitHoleRow>(
    `select ${LESSON_COLUMNS}
     from pilot.rabbit_holes r
     ${CITATION_JOIN}
     where ${conditions.join(' and ')}
     order by r.updated_at desc, r.title
     limit ${limit}`,
    values,
  );

  return rows.map(toAuthored);
}

/**
 * Who may write a lesson.
 *
 * Coaches write AND publish directly: there is no review step, because there is
 * no reviewer. Administrators may write as well, since they already carry every
 * coaching permission. Nobody else may -- a lesson speaks to the gym in the
 * gym's voice.
 */
export function assertCanAuthorRabbitHoles(actor: { role: PilotRole }): void {
  if (actor.role === 'coach' || isOrganizationAdminRole(actor.role)) {
    return;
  }

  throw new Error('Forbidden: only a coach or an organization administrator may write a rabbit hole');
}

/**
 * Who may change one that already exists.
 *
 * The coach who wrote it, or an administrator of the same organization. A coach
 * editing another coach's lesson would be rewriting somebody else's teaching
 * under their name; an administrator can still take anything down, including a
 * lesson whose author account has been removed.
 */
export function assertCanManageRabbitHole(
  actor: { accountId: string; role: PilotRole },
  lesson: { author_account_id: string | null },
): void {
  assertCanAuthorRabbitHoles(actor);

  if (isOrganizationAdminRole(actor.role)) {
    return;
  }

  if (lesson.author_account_id !== null && lesson.author_account_id === actor.accountId) {
    return;
  }

  throw new Error('Forbidden: only the coach who wrote this rabbit hole or an organization administrator may change it');
}

// Returns null when this organization has no such lesson, so a caller reports
// "nothing changed" rather than a silent success -- and so a lesson in another
// gym is never reachable.
export async function getRabbitHole(
  organizationId: string,
  rabbitHoleId: string,
): Promise<AuthoredRabbitHole | null> {
  const rows = await query<RabbitHoleRow>(
    `select ${LESSON_COLUMNS}
     from pilot.rabbit_holes r
     ${CITATION_JOIN}
     where r.organization_id = $1 and r.rabbit_hole_id = $2`,
    [organizationId, rabbitHoleId],
  );

  return rows[0] ? toAuthored(rows[0]) : null;
}

/**
 * Writes a lesson, published.
 *
 * author_display_name is stored alongside the account id because the lesson
 * outlives the coach who wrote it: the account clears on removal and the
 * attribution survives it.
 */
export async function createRabbitHole(params: {
  organizationId: string;
  anchorType: unknown;
  anchorKey: unknown;
  audience?: unknown;
  title: unknown;
  concept: unknown;
  homework?: unknown;
  libraryDocumentId?: unknown;
  authorAccountId: string;
  authorDisplayName: unknown;
}): Promise<AuthoredRabbitHole> {
  const { anchorType, anchorKey } = await assertRabbitHoleAnchor({
    organizationId: params.organizationId,
    anchorType: params.anchorType,
    anchorKey: params.anchorKey,
  });

  const audience = params.audience === undefined || params.audience === null ? 'all' : params.audience;
  if (!isRabbitHoleAudience(audience)) {
    throw new Error('Unsupported audience: not a role any account can hold');
  }

  const title = assertText(params.title, 'title', MAX_TITLE_LENGTH);
  const concept = assertText(params.concept, 'concept', MAX_CONCEPT_LENGTH);
  const homework = assertOptionalText(params.homework, 'homework', MAX_HOMEWORK_LENGTH);
  const libraryDocumentId = assertOptionalText(
    params.libraryDocumentId,
    'library_document_id',
    MAX_DOCUMENT_ID_LENGTH,
  );
  const authorDisplayName = assertText(
    params.authorDisplayName,
    'author_display_name',
    MAX_AUTHOR_NAME_LENGTH,
  );

  const rabbitHoleId = randomUUID();
  await query(
    `insert into pilot.rabbit_holes
       (organization_id, rabbit_hole_id, anchor_type, anchor_key, audience,
        title, concept, homework, library_document_id,
        author_account_id, author_display_name, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'published')`,
    [
      params.organizationId,
      rabbitHoleId,
      anchorType,
      anchorKey,
      audience,
      title,
      concept,
      homework,
      libraryDocumentId,
      params.authorAccountId,
      authorDisplayName,
    ],
  );

  const written = await getRabbitHole(params.organizationId, rabbitHoleId);
  if (!written) {
    throw new Error('Rabbit hole write verification failed');
  }

  return written;
}

/**
 * Edits a lesson in place.
 *
 * Every field is optional and an omitted one is left alone. The anchor moves
 * only as a pair -- a new anchor_type with the old anchor_key would file the
 * lesson under a vocabulary the key does not belong to, which is exactly the
 * failure no CHECK can catch.
 */
export async function updateRabbitHole(params: {
  organizationId: string;
  rabbitHoleId: string;
  anchorType?: unknown;
  anchorKey?: unknown;
  audience?: unknown;
  title?: unknown;
  concept?: unknown;
  homework?: unknown;
  libraryDocumentId?: unknown;
}): Promise<AuthoredRabbitHole | null> {
  const assignments: string[] = [];
  const values: unknown[] = [params.organizationId, params.rabbitHoleId];

  const push = (column: string, value: unknown) => {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  };

  const anchorTypeGiven = params.anchorType !== undefined;
  const anchorKeyGiven = params.anchorKey !== undefined;
  if (anchorTypeGiven !== anchorKeyGiven) {
    throw new Error('Unsupported anchor: anchor_type and anchor_key move together or not at all');
  }

  if (anchorTypeGiven && anchorKeyGiven) {
    const anchor = await assertRabbitHoleAnchor({
      organizationId: params.organizationId,
      anchorType: params.anchorType,
      anchorKey: params.anchorKey,
    });
    push('anchor_type', anchor.anchorType);
    push('anchor_key', anchor.anchorKey);
  }

  if (params.audience !== undefined) {
    if (!isRabbitHoleAudience(params.audience)) {
      throw new Error('Unsupported audience: not a role any account can hold');
    }
    push('audience', params.audience);
  }

  if (params.title !== undefined) {
    push('title', assertText(params.title, 'title', MAX_TITLE_LENGTH));
  }

  if (params.concept !== undefined) {
    push('concept', assertText(params.concept, 'concept', MAX_CONCEPT_LENGTH));
  }

  // Clearing homework is a real edit -- not every lesson keeps something to go
  // and do -- so an explicit empty value blanks the column rather than reading
  // as "leave it".
  if (params.homework !== undefined) {
    push('homework', assertOptionalText(params.homework, 'homework', MAX_HOMEWORK_LENGTH));
  }

  if (params.libraryDocumentId !== undefined) {
    push(
      'library_document_id',
      assertOptionalText(params.libraryDocumentId, 'library_document_id', MAX_DOCUMENT_ID_LENGTH),
    );
  }

  if (assignments.length === 0) {
    throw new Error('Missing changes: an edit must change at least one field');
  }

  const updated = await query<{ rabbit_hole_id: string }>(
    `update pilot.rabbit_holes
     set ${assignments.join(', ')}, updated_at = now()
     where organization_id = $1 and rabbit_hole_id = $2
     returning rabbit_hole_id`,
    values,
  );

  if (!updated[0]) {
    return null;
  }

  return getRabbitHole(params.organizationId, params.rabbitHoleId);
}

/**
 * Takes a lesson off the surface, or puts it back.
 *
 * Retiring is not deleting: the row, its homework and its attribution stay on
 * record, so a reader part-way through an assignment does not lose it when the
 * gym stops showing the lesson.
 */
export async function setRabbitHoleStatus(params: {
  organizationId: string;
  rabbitHoleId: string;
  status: unknown;
}): Promise<AuthoredRabbitHole | null> {
  if (!isRabbitHoleStatus(params.status)) {
    throw new Error('Unsupported status: a rabbit hole is published or retired');
  }

  const updated = await query<{ rabbit_hole_id: string }>(
    `update pilot.rabbit_holes
     set status = $3, updated_at = now()
     where organization_id = $1 and rabbit_hole_id = $2
     returning rabbit_hole_id`,
    [params.organizationId, params.rabbitHoleId, params.status],
  );

  if (!updated[0]) {
    return null;
  }

  return getRabbitHole(params.organizationId, params.rabbitHoleId);
}
