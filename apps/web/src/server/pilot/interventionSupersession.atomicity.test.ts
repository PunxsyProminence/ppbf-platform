/**
 * SUPERSESSION IS THREE STATEMENTS. THEY HAVE TO BE ONE ACT.
 *
 * Three sibling modules replace a record the same way: insert the successor
 * born 'superseded' (so the one-current-row partial unique index is never
 * contended), stamp the predecessor, then raise the successor.
 *
 *   interventionProtocols.reviseProtocol   -- the stated plan for a child
 *   interventionExecutions.correctExecution -- what the child was put through
 *   interventionEvidence.reviewOutcome      -- the human verdict on it
 *
 * Run on autocommit with an unguarded stamp, each had the same two holes, and
 * each carried a comment claiming an invariant it did not hold:
 *
 *   FAILURE AFTER THE STAMP leaves BOTH rows superseded -- not "the old head
 *   still stands", which is what the comments said, but NO current row at
 *   all. listExecutions filters superseded out, getActiveReview returns null,
 *   and every path that acts on a protocol requires an active one, so the
 *   record is gone from the product and nothing can bring it back.
 *
 *   TWO WRITERS AT ONCE both read the predecessor as current, both insert
 *   (legal -- both successors are born superseded), and both stamp, because
 *   the stamp named no state. One raise wins the unique index; the other
 *   raises a 23505 the caller sees as a 500, and its successor is stranded in
 *   the table as a version nothing can raise or remove.
 *
 * These tests run the REAL functions against the store below, which models
 * the two things that decide both outcomes: a transaction that discards its
 * writes when the callback throws, and the partial unique index. Nothing here
 * asserts "withTransaction was called" -- what is asserted is the state the
 * table is left in.
 */

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));

import { query, queryOne, withTransaction } from './db';
import { listExecutions, correctExecution } from './interventionExecutions';
import { getActiveReview, reviewOutcome } from './interventionEvidence';
import { reviseProtocol } from './interventionProtocols';

/* ------------------------------------------------------------- THE STORE -- */

interface StoredRow { [column: string]: unknown }

interface Store {
  intervention_protocols: StoredRow[];
  intervention_executions: StoredRow[];
  intervention_outcome_reviews: StoredRow[];
}

let store: Store;
/** Throws when a statement matching this lands -- a lost connection, a
 * constraint, a process dying: anything that ends the request mid-sequence. */
let faultOn: RegExp | null = null;
/** Serves the NEXT matching read from a stale snapshot instead of the store,
 * which is how a second writer reaches its stamp believing the predecessor is
 * still current. */
let staleRead: { pattern: RegExp; rows: StoredRow[] } | null = null;

function emptyStore(): Store {
  return { intervention_protocols: [], intervention_executions: [], intervention_outcome_reviews: [] };
}

function snapshot(): Store {
  return {
    intervention_protocols: store.intervention_protocols.map((r) => ({ ...r })),
    intervention_executions: store.intervention_executions.map((r) => ({ ...r })),
    intervention_outcome_reviews: store.intervention_outcome_reviews.map((r) => ({ ...r })),
  };
}

/**
 * The three partial unique indexes, checked BEFORE a mutation is applied --
 * Postgres aborts the offending statement rather than letting the duplicate
 * land, and the difference matters here: it is what turns a raced raise into
 * a 23505 the caller sees rather than two current rows.
 */
function assertUniqueIndexes(candidate: Store): void {
  const violated = (rows: StoredRow[], key: (row: StoredRow) => string, live: (row: StoredRow) => boolean) => {
    const seen = new Set<string>();
    for (const row of rows.filter(live)) {
      const k = key(row);
      if (seen.has(k)) return true;
      seen.add(k);
    }
    return false;
  };

  const duplicate =
    violated(candidate.intervention_protocols, (r) => `${r.organization_id}|${r.lineage_id}`, (r) => r.status !== 'superseded')
    || violated(candidate.intervention_executions, (r) => `${r.organization_id}|${r.lineage_id}`, (r) => r.status !== 'superseded')
    || violated(candidate.intervention_outcome_reviews, (r) => `${r.organization_id}|${r.execution_id}`, (r) => r.status === 'active');

  if (duplicate) {
    const error = new Error('duplicate key value violates a one-current-row unique index');
    (error as { code?: string }).code = '23505';
    throw error;
  }
}

/** Applies `mutate` to a copy, refuses it if it would break an index, and only
 * then commits it to the store. */
function applyChecked(mutate: (candidate: Store) => void): void {
  const candidate = snapshot();
  mutate(candidate);
  assertUniqueIndexes(candidate);
  store = candidate;
}

function execute(sql: string, params: unknown[] = []): StoredRow[] {
  if (faultOn?.test(sql)) {
    throw new Error('connection terminated unexpectedly');
  }
  if (staleRead && staleRead.pattern.test(sql)) {
    const rows = staleRead.rows;
    staleRead = null;
    return rows.map((r) => ({ ...r }));
  }

  /* ---- protocols ---- */
  if (/from pilot\.intervention_protocols p/.test(sql)) {
    return store.intervention_protocols
      .filter((r) => r.organization_id === params[0] && r.protocol_id === params[1])
      .map((r) => ({ ...r, athlete_name: null }));
  }
  if (/insert into pilot\.intervention_protocols/.test(sql)) {
    const source = store.intervention_protocols
      .find((r) => r.organization_id === params[0] && r.protocol_id === params[1]);
    if (!source) return [];
    applyChecked((candidate) => {
      candidate.intervention_protocols.push({
        ...source,
        protocol_id: params[2],
        lineage_id: source.lineage_id,
        version: (source.version as number) + 1,
        supersedes_protocol_id: source.protocol_id,
        title: params[3],
        status: 'superseded',
      });
    });
    return [{ protocol_id: params[2] }];
  }
  if (/update pilot\.intervention_protocols set status = 'superseded'/.test(sql)) {
    return updateStatus(sql, params, 'intervention_protocols', 'protocol_id', 'superseded');
  }
  if (/update pilot\.intervention_protocols set status = 'active'/.test(sql)) {
    return updateStatus(sql, params, 'intervention_protocols', 'protocol_id', 'active');
  }

  /* ---- executions ---- */
  if (/from pilot\.intervention_executions e/.test(sql)) {
    const rows = store.intervention_executions.filter((r) => {
      if (r.organization_id !== params[0]) return false;
      if (/e\.execution_id = \$2/.test(sql)) return r.execution_id === params[1];
      if (/e\.status <> 'superseded'/.test(sql) && r.status === 'superseded') return false;
      if (/e\.athlete_id = \$2/.test(sql)) return r.athlete_id === params[1];
      return true;
    });
    return rows.map((r) => ({ ...r, athlete_name: null, protocol_title: null }));
  }
  if (/insert into pilot\.intervention_executions/.test(sql)) {
    const source = store.intervention_executions
      .find((r) => r.organization_id === params[0] && r.execution_id === params[1]);
    if (!source) return [];
    applyChecked((candidate) => {
      candidate.intervention_executions.push({
        ...source,
        execution_id: params[2],
        version: (source.version as number) + 1,
        supersedes_execution_id: source.execution_id,
        correction_reason: params[15],
        status: 'superseded',
      });
    });
    return [{ execution_id: params[2] }];
  }
  if (/update pilot\.intervention_executions set status = 'superseded'/.test(sql)) {
    return updateStatus(sql, params, 'intervention_executions', 'execution_id', 'superseded');
  }
  if (/update pilot\.intervention_executions set status = \$3/.test(sql)) {
    return updateStatus(sql, params, 'intervention_executions', 'execution_id', params[2] as string);
  }

  /* ---- outcome reviews ---- */
  if (/select review_id from pilot\.intervention_outcome_reviews/.test(sql)) {
    return store.intervention_outcome_reviews
      .filter((r) => r.organization_id === params[0] && r.execution_id === params[1] && r.status === 'active')
      .map((r) => ({ review_id: r.review_id }));
  }
  if (/select \* from pilot\.intervention_outcome_reviews/.test(sql)) {
    return store.intervention_outcome_reviews
      .filter((r) => {
        if (r.organization_id !== params[0]) return false;
        if (/review_id = \$2/.test(sql)) return r.review_id === params[1];
        return r.execution_id === params[1] && r.status === 'active';
      })
      .map((r) => ({ ...r }));
  }
  if (/insert into pilot\.intervention_outcome_reviews/.test(sql)) {
    applyChecked((candidate) => {
      candidate.intervention_outcome_reviews.push({
        organization_id: params[0],
        review_id: params[1],
        execution_id: params[2],
        supersedes_review_id: params[3],
        performance_result: params[4],
        performance_notes: params[5],
        hypothesis_result: params[6],
        learning_signal: params[7],
        learning_notes: params[8],
        status: 'superseded',
        reviewed_by_account_id: params[9],
      });
    });
    return [{ review_id: params[1] }];
  }
  if (/update pilot\.intervention_outcome_reviews set status = 'superseded'/.test(sql)) {
    return updateStatus(sql, params, 'intervention_outcome_reviews', 'review_id', 'superseded');
  }
  if (/update pilot\.intervention_outcome_reviews set status = 'active'/.test(sql)) {
    return updateStatus(sql, params, 'intervention_outcome_reviews', 'review_id', 'active');
  }

  throw new Error(`Unhandled SQL in this harness: ${sql}`);
}

/**
 * The state predicate is read OUT OF the SQL rather than assumed. A stamp that
 * carries no `and status ...` clause matches unconditionally, exactly as
 * Postgres would -- so dropping the guard makes these tests fail rather than
 * quietly pass on a guard the harness supplied for the code.
 */
function updateStatus(
  sql: string,
  params: unknown[],
  table: keyof Store,
  idColumn: string,
  nextStatus: string,
): StoredRow[] {
  const equals = /and status = '([a-z_]+)'/.exec(sql);
  const notEquals = /and status <> '([a-z_]+)'/.exec(sql);
  const matched: StoredRow[] = [];

  applyChecked((candidate) => {
    for (const row of candidate[table]) {
      if (row.organization_id !== params[0] || row[idColumn] !== params[1]) continue;
      if (equals && row.status !== equals[1]) continue;
      if (notEquals && row.status === notEquals[1]) continue;
      row.status = nextStatus;
      matched.push({ [idColumn]: row[idColumn] });
    }
  });

  return matched;
}

beforeEach(() => {
  jest.clearAllMocks();
  store = emptyStore();
  faultOn = null;
  staleRead = null;

  (query as jest.Mock).mockImplementation(async (sql: string, params: unknown[] = []) => execute(sql, params));
  (queryOne as jest.Mock).mockImplementation(async (sql: string, params: unknown[] = []) => execute(sql, params)[0] ?? null);
  (withTransaction as jest.Mock).mockImplementation(async (callback: (client: unknown) => Promise<unknown>) => {
    const before = snapshot();
    try {
      return await callback({
        query: async (sql: string, params: unknown[] = []) => ({ rows: execute(sql, params) }),
      });
    } catch (error) {
      store = before; // ROLLBACK
      throw error;
    }
  });
});

/* ------------------------------------------------------------- FIXTURES -- */

const ORG = 'org-a';

function seedProtocol(overrides: StoredRow = {}): void {
  store.intervention_protocols.push({
    organization_id: ORG,
    protocol_id: 'proto-1',
    lineage_id: 'proto-1',
    version: 1,
    supersedes_protocol_id: null,
    athlete_id: 'ath-1',
    title: 'Front-hand return under fatigue',
    status: 'active',
    ...overrides,
  });
}

function seedExecution(overrides: StoredRow = {}): void {
  store.intervention_executions.push({
    organization_id: ORG,
    execution_id: 'exec-1',
    lineage_id: 'exec-1',
    version: 1,
    supersedes_execution_id: null,
    athlete_id: 'ath-1',
    protocol_id: 'proto-1',
    status: 'completed',
    correction_reason: '',
    created_at: '2026-08-20T10:00:00.000Z',
    ...overrides,
  });
}

function seedReview(overrides: StoredRow = {}): void {
  store.intervention_outcome_reviews.push({
    organization_id: ORG,
    review_id: 'review-0',
    execution_id: 'exec-1',
    supersedes_review_id: null,
    performance_result: 'improved',
    performance_notes: 'Held the return through round four.',
    hypothesis_result: 'supported',
    learning_signal: 'prior_belief_strengthened',
    learning_notes: '',
    status: 'active',
    reviewed_by_account_id: 'acct-coach',
    ...overrides,
  });
}

const revision = {
  organizationId: ORG,
  protocolId: 'proto-1',
  revisedByAccountId: 'acct-coach',
  title: 'Front-hand return under fatigue, v2',
  targetProblem: 'Hand drops after round three.',
  hypothesis: 'Constrained rounds hold the guard.',
  interventionDescription: 'Three constrained rounds, cue on the exhale.',
  expectedOutcome: 'Guard holds into round four.',
};

const correction = {
  organizationId: ORG,
  executionId: 'exec-1',
  correctionReason: 'Rounds were miscounted on the card.',
  correctedByAccountId: 'acct-coach',
};

const verdict = {
  organizationId: ORG,
  executionId: 'exec-1',
  performanceResult: 'improved' as const,
  performanceNotes: 'Guard held into round four.',
  hypothesisResult: 'supported' as const,
  learningSignal: 'prior_belief_strengthened' as const,
  reviewedByAccountId: 'acct-coach-2',
};

function liveProtocols() {
  return store.intervention_protocols.filter((r) => r.status !== 'superseded');
}
function liveExecutions() {
  return store.intervention_executions.filter((r) => r.status !== 'superseded');
}
function activeReviews() {
  return store.intervention_outcome_reviews.filter((r) => r.status === 'active');
}

/* ---------------------------------------------------------------- TESTS -- */

describe('reviseProtocol', () => {
  test('an uncontested revision leaves exactly one active head -- the new version', async () => {
    seedProtocol();

    const revised = await reviseProtocol(revision);

    expect(revised?.version).toBe(2);
    expect(liveProtocols()).toHaveLength(1);
    expect(liveProtocols()[0].version).toBe(2);
    expect(store.intervention_protocols).toHaveLength(2);
  });

  test('a failure while raising the new version leaves the OLD head still active, not a headless lineage', async () => {
    seedProtocol();
    faultOn = /update pilot\.intervention_protocols set status = 'active'/;

    await expect(reviseProtocol(revision)).rejects.toThrow(/connection terminated/);

    // Without the transaction the stamp had already committed, so BOTH rows
    // read 'superseded': the lineage has no active head, startExecution
    // refuses it, and reviseProtocol/retireProtocol both require an active
    // row -- there is no path that can ever bring it back.
    expect(liveProtocols()).toHaveLength(1);
    expect(liveProtocols()[0].protocol_id).toBe('proto-1');
    expect(liveProtocols()[0].status).toBe('active');
    // The successor rolled back with it rather than being left stranded.
    expect(store.intervention_protocols).toHaveLength(1);
  });

  test('a second revision that read the same head loses cleanly: null, and nothing stranded', async () => {
    seedProtocol();
    const headAsBothWritersReadIt = { ...store.intervention_protocols[0] };

    const first = await reviseProtocol(revision);
    expect(first?.version).toBe(2);

    // The second writer's read happened before the first committed, so it
    // still believes proto-1 is the active head.
    staleRead = { pattern: /from pilot\.intervention_protocols p/, rows: [headAsBothWritersReadIt] };

    const second = await reviseProtocol({ ...revision, title: 'A different second opinion' });

    // Unguarded, the second stamp matched anyway and the second raise hit the
    // one-active-head index: an opaque 23505 for the caller, and a successor
    // row left behind that nothing could raise or remove.
    expect(second).toBeNull();
    expect(liveProtocols()).toHaveLength(1);
    expect(liveProtocols()[0].title).toBe('Front-hand return under fatigue, v2');
    expect(store.intervention_protocols).toHaveLength(2);
  });
});

describe('correctExecution', () => {
  test('an uncontested correction leaves exactly one current record -- the correction', async () => {
    seedExecution();

    const corrected = await correctExecution(correction);

    expect(corrected?.version).toBe(2);
    expect(liveExecutions()).toHaveLength(1);
    expect(await listExecutions(ORG, 'ath-1')).toHaveLength(1);
  });

  test('a failure while raising the correction does not make the execution disappear from every current view', async () => {
    seedExecution();
    faultOn = /update pilot\.intervention_executions set status = \$3/;

    await expect(correctExecution(correction)).rejects.toThrow(/connection terminated/);

    // The record of what a child was actually put through. Without the
    // transaction both rows read 'superseded', and listExecutions -- which
    // filters exactly that -- returned nothing at all for this athlete.
    const listed = await listExecutions(ORG, 'ath-1');
    expect(listed).toHaveLength(1);
    expect(listed[0].execution_id).toBe('exec-1');
    expect(listed[0].status).toBe('completed');
    expect(store.intervention_executions).toHaveLength(1);
  });

  test('a second correction that read the same record loses cleanly: null, and nothing stranded', async () => {
    seedExecution();
    const recordAsBothWritersReadIt = { ...store.intervention_executions[0] };

    const first = await correctExecution(correction);
    expect(first?.version).toBe(2);

    staleRead = { pattern: /from pilot\.intervention_executions e/, rows: [recordAsBothWritersReadIt] };

    const second = await correctExecution({ ...correction, correctionReason: 'A different correction.' });

    expect(second).toBeNull();
    expect(liveExecutions()).toHaveLength(1);
    expect(store.intervention_executions).toHaveLength(2);
  });
});

describe('reviewOutcome', () => {
  test('an uncontested re-review leaves exactly one active verdict -- the new one', async () => {
    seedExecution();
    seedReview();

    const recorded = await reviewOutcome(verdict);

    expect(recorded?.review_id).toBe(activeReviews()[0].review_id);
    expect(activeReviews()).toHaveLength(1);
    expect(store.intervention_outcome_reviews).toHaveLength(2);
  });

  test('a failure while raising the new verdict leaves the previous one standing, not no verdict at all', async () => {
    seedExecution();
    seedReview();
    faultOn = /update pilot\.intervention_outcome_reviews set status = 'active'/;

    await expect(reviewOutcome(verdict)).rejects.toThrow(/connection terminated/);

    // Without the transaction the stamp had committed and the raise had not,
    // so getActiveReview answered null: the human verdict on what an
    // intervention did to a child read as never having happened.
    const active = await getActiveReview(ORG, 'exec-1');
    expect(active?.review_id).toBe('review-0');
    expect(activeReviews()).toHaveLength(1);
    expect(store.intervention_outcome_reviews).toHaveLength(1);
  });

  test('a second reviewer who read the same verdict loses cleanly: null, and nothing stranded', async () => {
    seedExecution();
    seedReview();

    const first = await reviewOutcome(verdict);
    expect(first).not.toBeNull();

    // The second reviewer's "which verdict is current" read happened before
    // the first committed.
    staleRead = { pattern: /select review_id from pilot\.intervention_outcome_reviews/, rows: [{ review_id: 'review-0' }] };

    const second = await reviewOutcome({ ...verdict, reviewedByAccountId: 'acct-coach-3' });

    expect(second).toBeNull();
    expect(activeReviews()).toHaveLength(1);
    expect(activeReviews()[0].reviewed_by_account_id).toBe('acct-coach-2');
    expect(store.intervention_outcome_reviews).toHaveLength(2);
  });
});
