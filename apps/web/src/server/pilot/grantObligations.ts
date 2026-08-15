import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';

// Internal grant-obligation ledger (owner decision 2026-08-15: "build the
// internal half now"). Deadlines, deliverables, renewals, filings -- the
// organization's commitments to funders, as admin records.
//
// The boundary this module inherits from its migration and must keep: no
// athlete data, ever. No athlete ids, no counts, no aggregates, no join into
// any table holding a child's information. The external-disclosure question
// is parked (BACKLOG-grant-packet) and stays parked because nothing here can
// answer it even by accident.

export type GrantObligationType = 'report' | 'deliverable' | 'renewal' | 'filing' | 'acknowledgment' | 'other';
export type GrantObligationStatus = 'open' | 'in_progress' | 'submitted' | 'complete' | 'waived';

export const GRANT_OBLIGATION_TYPES: readonly GrantObligationType[] = [
  'report', 'deliverable', 'renewal', 'filing', 'acknowledgment', 'other',
];

export const GRANT_OBLIGATION_STATUSES: readonly GrantObligationStatus[] = [
  'open', 'in_progress', 'submitted', 'complete', 'waived',
];

// Which statuses may follow which. Forward progress plus reopening a
// submitted/settled row (a funder can bounce a report); no transition
// invents history.
const ALLOWED_TRANSITIONS: Record<GrantObligationStatus, readonly GrantObligationStatus[]> = {
  open: ['in_progress', 'submitted', 'complete', 'waived'],
  in_progress: ['open', 'submitted', 'complete', 'waived'],
  submitted: ['open', 'in_progress', 'complete', 'waived'],
  complete: ['open'],
  waived: ['open'],
};

export interface GrantObligationRow {
  organization_id: string;
  obligation_id: string;
  grant_name: string;
  funder_name: string;
  obligation_type: GrantObligationType;
  description: string;
  due_date: string;
  status: GrantObligationStatus;
  completed_at: string | null;
  notes: string;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
}

const FIELDS = `organization_id, obligation_id, grant_name, funder_name, obligation_type,
  description, due_date::text as due_date, status, completed_at, notes,
  created_by_account_id, created_at, updated_at`;

export function isGrantObligationType(value: unknown): value is GrantObligationType {
  return typeof value === 'string' && (GRANT_OBLIGATION_TYPES as readonly string[]).includes(value);
}

export function isGrantObligationStatus(value: unknown): value is GrantObligationStatus {
  return typeof value === 'string' && (GRANT_OBLIGATION_STATUSES as readonly string[]).includes(value);
}

export async function createGrantObligation(input: {
  organizationId: string;
  grantName: string;
  funderName?: string;
  obligationType: GrantObligationType;
  description: string;
  dueDate: string;
  notes?: string;
  createdByAccountId: string;
}): Promise<GrantObligationRow> {
  const row = await queryOne<GrantObligationRow>(
    `insert into pilot.grant_obligations
       (organization_id, obligation_id, grant_name, funder_name, obligation_type,
        description, due_date, notes, created_by_account_id)
     values ($1, $2, $3, $4, $5, $6, $7::date, $8, $9)
     returning ${FIELDS}`,
    [
      input.organizationId,
      randomUUID(),
      input.grantName,
      input.funderName ?? '',
      input.obligationType,
      input.description,
      input.dueDate,
      input.notes ?? '',
      input.createdByAccountId,
    ],
  );
  if (!row) throw new Error('Unable to create the grant obligation.');
  return row;
}

/** Soonest due first; settled rows sink below open work regardless of date. */
export async function listGrantObligations(
  organizationId: string,
  filter: { status?: GrantObligationStatus } = {},
): Promise<GrantObligationRow[]> {
  return query<GrantObligationRow>(
    `select ${FIELDS}
     from pilot.grant_obligations
     where organization_id = $1
       and ($2::text is null or status = $2)
     order by (status in ('complete', 'waived')) asc, due_date asc, created_at asc`,
    [organizationId, filter.status ?? null],
  );
}

export async function updateGrantObligationStatus(input: {
  organizationId: string;
  obligationId: string;
  status: GrantObligationStatus;
  notes?: string;
}): Promise<GrantObligationRow | null> {
  const current = await queryOne<GrantObligationRow>(
    `select ${FIELDS} from pilot.grant_obligations
     where organization_id = $1 and obligation_id = $2`,
    [input.organizationId, input.obligationId],
  );
  if (!current) return null;

  if (current.status !== input.status && !ALLOWED_TRANSITIONS[current.status].includes(input.status)) {
    throw new Error(`Invalid status transition: ${current.status} -> ${input.status}`);
  }

  const settled = input.status === 'complete' || input.status === 'waived' || input.status === 'submitted';
  const row = await queryOne<GrantObligationRow>(
    `update pilot.grant_obligations
     set status = $3,
         completed_at = case when $4::boolean then coalesce(completed_at, now()) else null end,
         notes = coalesce($5, notes),
         updated_at = now()
     where organization_id = $1 and obligation_id = $2
     returning ${FIELDS}`,
    [input.organizationId, input.obligationId, input.status, settled, input.notes ?? null],
  );
  return row;
}
