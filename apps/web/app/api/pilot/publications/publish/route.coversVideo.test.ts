import { NextRequest } from 'next/server';

import { POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { query } from '@/src/server/pilot/db';
import { getPublicationForPublish, publishToResearchLibrary } from '@/src/server/pilot/publication';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/*
 * A PUBLICATION IS VIDEO, SO PUBLISHING NEEDS CONSENT THAT COVERS VIDEO.
 *
 * route.test.ts mocks the consent helpers; this file does not. It drives the
 * REAL guardianConsent.ts and videoPlaybackConsent.ts readers against a fake
 * pilot.guardian_links / pilot.waivers, so a guardian who signed photo-only
 * (covers_video = false) is refused by the same code that refuses playback,
 * both at the pre-check and inside the claim's own transaction.
 */

/* The consent-set advisory lock is its own statement; these tests script
   client.query call by call, so it is stubbed here and proven against real
   Postgres in consentSetPhantom.pg.test.ts. */
jest.mock('@/src/server/pilot/consentSetLock', () => ({ lockConsentSet: jest.fn(), lockConsentSets: jest.fn() }));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => {
  const actual = jest.requireActual('@/src/server/pilot/db');
  return { ...actual, query: jest.fn() };
});

jest.mock('@/src/server/pilot/publication', () => ({
  getPublicationForPublish: jest.fn(),
  publishToResearchLibrary: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

jest.mock('@/src/server/pilot/videoClipTags', () => ({
  assertVideoHasNoLiveClipTags: jest.fn().mockResolvedValue(undefined),
}));

// Attribution is route.test.ts's subject; here the video is ath-1's.
jest.mock('@/src/server/pilot/videoSessions', () => ({
  getVideoSessionById: jest.fn().mockResolvedValue({ video_session_id: 'vid-1', athlete_id: 'ath-1', status: 'ready' }),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockGetPublication = getPublicationForPublish as jest.Mock;
const mockPublish = publishToResearchLibrary as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

interface ConsentRow {
  parent_id: string;
  status: string;
  covers_video: boolean;
  public_use_allowed: boolean;
  created_at: string;
}

type State = (sql: string, params?: unknown[]) => unknown[];

const isLinkRead = (sql: string) => /^\s*select parent_id from pilot\.guardian_links\b/.test(sql);

// One athlete's consent state as the two tables hold it. Rows answer only for
// org-1 / ath-1 / photo_media, and the waivers read returns the latest row per
// guardian, as the real DISTINCT ON (parent_id) ... created_at desc does.
function consentState(rows: ConsentRow[], links = [...new Set(rows.map((row) => row.parent_id))]): State {
  return (sql, params = []) => {
    const ours = params[0] === 'org-1' && params[1] === 'ath-1';
    // No purged guardian's choice is retained in these states.
    if (sql.includes('retained_media_consent_restrictions')) return [];
    // The claim's own read of the video row (audit CL-B10): released Film
    // Study media unless a test says otherwise.
    if (sql.includes('from pilot.video_sessions')) return [{ status: 'ready', capture_take_id: null }];
    if (sql.includes('from pilot.guardian_links')) {
      return ours ? [...links].sort().map((parent_id) => ({ parent_id })) : [];
    }
    if (sql.includes('from pilot.waivers')) {
      if (!ours || params[2] !== 'photo_media') return [];
      const latest = new Map<string, ConsentRow>();
      for (const row of rows) {
        const seen = latest.get(row.parent_id);
        if (!seen || row.created_at > seen.created_at) latest.set(row.parent_id, row);
      }
      return [...latest.values()];
    }
    throw new Error(`unexpected statement: ${sql}`);
  };
}

const signed = (overrides: Partial<ConsentRow> = {}): ConsentRow => ({
  parent_id: 'par-1',
  status: 'signed',
  covers_video: true,
  public_use_allowed: false,
  created_at: '2026-10-01T00:00:00Z',
  ...overrides,
});

// The claim's transaction client: records every statement it was asked. The
// Nth guardian_links read answers from states[N] (the last one repeats), so a
// test can commit a link between two reads inside the claim.
function claimClient(...states: State[]) {
  const statements: string[] = [];
  let linkReads = 0;
  let current = states[0];
  return {
    statements,
    async query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
      statements.push(text);
      // A read OF the links (the lock helper's), not a statement that only
      // joins them, such as the retained-restriction read.
      if (isLinkRead(text)) {
        current = states[Math.min(linkReads, states.length - 1)];
        linkReads += 1;
      }
      return { rows: current(text, params) as T[] };
    },
  };
}

const principal: PilotPrincipal = {
  accountId: 'coach-1',
  role: 'coach',
  organizationId: 'org-1',
  athleteId: null,
  sessionToken: 'token',
  authProvider: 'ppbf_local',
};

const publicationRow = {
  publication_id: 'pub-1',
  video_session_id: 'vid-1',
  athlete_id: 'ath-1',
  submitted_by_account_id: 'coach-1',
  title: 'Jab mechanics',
  description: 'Session review',
  tags: ['jab'],
  status: 'approved',
  compliance_check_status: 'passed',
};

function postRequest() {
  return new NextRequest('http://localhost/api/pilot/publications/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publication_id: 'pub-1', video_session_id: 'vid-1' }),
  });
}

// pooled = what the pre-check reads; claim = what the transaction reads.
// pooledInClaim counts pooled reads made while the claim ran: every consent
// read inside it must be on the claim's client, never beside it.
function arrange(pooled: State, ...claim: State[]) {
  mockRequirePrincipal.mockResolvedValueOnce(principal);
  mockGetPublication.mockResolvedValueOnce(publicationRow);
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => pooled(sql, params));
  const client = claimClient(...(claim.length > 0 ? claim : [pooled]));
  const result = { client, pooledInClaim: 0 };
  mockPublish.mockImplementation(async (args) => {
    const before = mockQuery.mock.calls.length;
    try {
      await args.verifyBeforeCommit(client);
    } finally {
      result.pooledInClaim = mockQuery.mock.calls.length - before;
    }
    return 'lib-1';
  });
  return result;
}

function auditedReasons(): unknown[] {
  return mockAudit.mock.calls
    .map(([event]) => event.details)
    .filter((details) => details?.action === 'publication_publish_blocked_by_consent')
    .map((details) => details.reason);
}

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { code?: string }).code;
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('publish refuses video a guardian has not consented to', () => {
  test('consent that covers video publishes', async () => {
    arrange(consentState([signed()]));

    const res = await POST(postRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, library_id: 'lib-1' });
  });

  test('a photo-only consent refuses the publish with that reason, and the attempt is audited', async () => {
    arrange(consentState([signed({ covers_video: false })]));

    const res = await POST(postRequest());

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe('GUARDIAN_CONSENT_EXCLUDES_VIDEO');
    expect(body.error).toMatch(/photo-only/);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(auditedReasons()).toEqual(['GUARDIAN_CONSENT_EXCLUDES_VIDEO']);
  });

  test('one photo-only guardian among two blocks the publish', async () => {
    arrange(consentState([signed(), signed({ parent_id: 'par-2', covers_video: false })]));

    const res = await POST(postRequest());

    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('GUARDIAN_CONSENT_EXCLUDES_VIDEO');
  });

  test('a withdrawn consent refuses with the withdrawal named, not as missing paperwork', async () => {
    arrange(consentState([signed({ status: 'withdrawn', covers_video: false })]));

    const res = await POST(postRequest());

    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('GUARDIAN_CONSENT_WITHDRAWN');
    expect(mockPublish).not.toHaveBeenCalled();
    expect(auditedReasons()).toEqual(['GUARDIAN_CONSENT_WITHDRAWN']);
  });

  test('a status the platform cannot read is refused, not taken as consent', async () => {
    // Written before pilot_waivers_status_check existed, or by a future writer.
    arrange(consentState([signed({ status: 'approved' })]));

    const res = await POST(postRequest());

    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('GUARDIAN_CONSENT_UNREADABLE');
    expect(auditedReasons()).toEqual(['GUARDIAN_CONSENT_UNREADABLE']);
  });

  test("only the guardian's LATEST consent counts: video signed after photo-only publishes", async () => {
    arrange(consentState([
      signed({ covers_video: false, created_at: '2026-09-01T00:00:00Z' }),
      signed({ covers_video: true, created_at: '2026-10-01T00:00:00Z' }),
    ]));

    const res = await POST(postRequest());

    expect(res.status).toBe(200);
  });

  test("only the guardian's LATEST consent counts: photo-only signed after video refuses", async () => {
    arrange(consentState([
      signed({ covers_video: true, created_at: '2026-09-01T00:00:00Z' }),
      signed({ covers_video: false, created_at: '2026-10-01T00:00:00Z' }),
    ]));

    const res = await POST(postRequest());

    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('GUARDIAN_CONSENT_EXCLUDES_VIDEO');
  });

  test('a downgrade to photo-only that lands after the pre-check is caught inside the claim, under the guardian lock', async () => {
    const arranged = arrange(
      consentState([signed()]),
      consentState([signed(), signed({ covers_video: false, created_at: '2026-10-02T00:00:00Z' })]),
    );

    const res = await POST(postRequest());

    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('GUARDIAN_CONSENT_EXCLUDES_VIDEO');
    // Every consent read inside the claim ran on the claim's client, through
    // the shared lock helper (FOR SHARE) -- none as a pooled read beside it.
    expect(arranged.pooledInClaim).toBe(0);
    const linkLocks = arranged.client.statements.filter(isLinkRead);
    expect(linkLocks).toHaveLength(2);
    expect(linkLocks.every((sql) => sql.includes('for share'))).toBe(true);
    expect(auditedReasons()).toEqual(['GUARDIAN_CONSENT_EXCLUDES_VIDEO']);
  });

  test("a photo-only guardian linked between the claim's two consent reads is still refused", async () => {
    // Review finding: the two in-claim checks each read the guardian links.
    // A guardian linked (and recorded photo-only) between them must be seen
    // by the check that refuses photo-only, so that check reads second.
    const before = consentState([signed()]);
    const after = consentState([signed(), signed({ parent_id: 'par-2', covers_video: false })]);
    arrange(before, before, after);

    const res = await POST(postRequest());

    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('GUARDIAN_CONSENT_EXCLUDES_VIDEO');
  });

  test("consent on file for another athlete is not this athlete's consent", async () => {
    // The fake answers only for org-1 / ath-1, so a publication naming ath-2
    // finds no guardians and is refused as missing.
    mockRequirePrincipal.mockResolvedValueOnce(principal);
    mockGetPublication.mockResolvedValueOnce({ ...publicationRow, athlete_id: 'ath-2' });
    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => consentState([signed()])(sql, params));

    const res = await POST(postRequest());

    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('GUARDIAN_CONSENT_MISSING');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  test('no consent row at all is still refused as missing (the existing rule is unchanged)', async () => {
    arrange(consentState([], ['par-1']));

    const res = await POST(postRequest());

    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('GUARDIAN_CONSENT_MISSING');
  });
});
