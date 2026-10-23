import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import {
  createShadowLibrarySource,
  listShadowLibrarySources,
  ShadowLibraryPublicationTakenError,
  updateShadowLibrarySourceClassification,
} from '@/src/server/pilot/shadowLibrary';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

import { findLibrarySourceByUrl } from '@/src/server/pilot/libraryIntakeRecovery';

jest.mock('@/src/server/pilot/libraryIntakeRecovery', () => ({
  ...jest.requireActual('@/src/server/pilot/libraryIntakeRecovery'),
  findLibrarySourceByUrl: jest.fn(),
}));
const mockFindByUrl = jest.mocked(findLibrarySourceByUrl);

jest.mock('@/src/server/pilot/shadowLibrary', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowLibrary');
  return {
    createShadowLibrarySource: jest.fn(),
    listShadowLibrarySources: jest.fn(),
    updateShadowLibrarySourceClassification: jest.fn(),
    // #345 D2: the route answers this error by its type.
    SHADOW_LIBRARY_PUBLICATION_TAKEN_CODE: actual.SHADOW_LIBRARY_PUBLICATION_TAKEN_CODE,
    ShadowLibraryPublicationTakenError: actual.ShadowLibraryPublicationTakenError,
  };
});

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockCreate = createShadowLibrarySource as jest.MockedFunction<typeof createShadowLibrarySource>;
const mockList = listShadowLibrarySources as jest.MockedFunction<typeof listShadowLibrarySources>;
const mockReclassify = updateShadowLibrarySourceClassification as jest.MockedFunction<typeof updateShadowLibrarySourceClassification>;

function principal(role: PilotPrincipal['role'] = 'organization_admin'): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-real',
    athleteId: role === 'athlete' ? 'ath-1' : null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/shadow/library/sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getRequest(search = '') {
  return new NextRequest(`http://localhost/api/pilot/shadow/library/sources${search}`, { method: 'GET' });
}

const validBody = {
  title: 'SHADOW Canonical Authority Model',
  publisher: 'Punxsy Prominence',
  source_type: 'internal_policy',
  authority_tier: 1,
  status: 'active',
  publication_date: '2026-07-15',
  metadata: { canonical: true },
};

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks keeps a mockResolvedValue; reset it so no test inherits a
  // principal from the one before.
  mockRequirePrincipal.mockReset();
  mockCreate.mockResolvedValue({ source_id: 'source_1' } as never);
  mockList.mockResolvedValue([]);
  mockFindByUrl.mockResolvedValue(null);
});

describe('POST /api/pilot/shadow/library/sources', () => {
  test('rejects an unauthenticated caller', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(401);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test.each(['coach', 'athlete', 'parent', 'board', 'volunteer', 'staff'] as const)(
    'refuses %s, which may read the Library but not curate it',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));

      const response = await POST(postRequest(validBody));

      expect(response.status).toBe(403);
      expect(mockCreate).not.toHaveBeenCalled();
    },
  );

  test.each(['organization_admin', 'admin'] as const)(
    'admits %s',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));

      const response = await POST(postRequest(validBody));

      expect(response.status).toBe(201);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    },
  );

  // OD-2026-10-02-015 D3: platform material on the platform shelf, gym
  // material on the gym shelf. The platform owner no longer writes a gym's.
  test('refuses platform_owner on the gym shelf, with or without naming it', async () => {
    for (const body of [validBody, { ...validBody, shelf: 'gym' }]) {
      mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));
      const response = await POST(postRequest(body));
      expect(response.status).toBe(403);
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('returns the source under the key the seed script reads', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockCreate.mockResolvedValueOnce({ source_id: 'source_abc' } as never);

    const response = await POST(postRequest(validBody));
    const payload = await response.json();

    // seed-shadow-library.mjs does `payload.source.source_id` and passes it
    // straight to the documents route, so this shape is a contract.
    expect(payload.source.source_id).toBe('source_abc');
  });

  test('takes the organization from the session, never from the body', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    await POST(postRequest({ ...validBody, organization_id: 'org-attacker' }));

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-real' }),
    );
  });

  test('does not pre-approve its own write', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    await POST(postRequest({ ...validBody, approval_state: 'approved', verification_state: 'verified' }));

    // Approval belongs to PATCH /shadow/evidence/review. If this route could
    // carry it, any curator could make a source citable without review.
    const call = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('approvalState');
    expect(call).not.toHaveProperty('verificationState');
  });

  test.each([
    ['an unknown source_type', { source_type: 'blog_post' }],
    ['a missing title', { title: '   ' }],
    ['an out-of-range authority_tier', { authority_tier: 9 }],
    ['a non-integer authority_tier', { authority_tier: 1.5 }],
    ['a malformed publication_date', { publication_date: 'July 15 2026' }],
    ['an unknown status', { status: 'live' }],
    ['array metadata', { metadata: ['canonical'] }],
  ])('rejects %s', async (_label, override) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(postRequest({ ...validBody, ...override }));

    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // Importer-only provenance. A curator's source claiming to be the importer's
  // copy of a PPBF seed source was raised to ppbf_owned by the source-rights
  // migration's old metadata backfill (#1238); the route now refuses the claim.
  test.each(['copied_from_source_id', 'copied_from_document_id', 'copied_for_scope'])(
    'refuses metadata.%s',
    async (key) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());

      const response = await POST(postRequest({ ...validBody, metadata: { canonical: true, [key]: 'src_6563c68e39047128' } }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(`metadata.${key} is set only by the research importer`);
      expect(mockCreate).not.toHaveBeenCalled();
    },
  );

  // Issue #345 provenance (researchProvenance.ts). Stored on the source row's
  // metadata.provenance, checked for shape, never a chunk's metadata.
  describe('metadata.provenance', () => {
    const provenance = {
      doi_or_pmid: '10.1000/xyz123',
      provider: 'Penn State library',
      institutional_source_id: 'PSU-ILL-004417',
      authors: ['Smith J', 'Ortega M'],
      year: 2019,
      population: 'Amateur boxers, club level',
      age_range: '18-35',
      sex: 'male',
      study_design: 'Cross-sectional laboratory study',
      boxing_specificity: 'boxing_specific',
      transfer_status: 'Not transferred: studied in boxers',
      protected_domains: { contact: true, sparring: false },
    };

    test('a full record is stored on the source, with journal and date in their own columns', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());

      const response = await POST(postRequest({
        ...validBody,
        publisher: 'Journal of Boxing Science',
        publication_date: '2019-03-01',
        metadata: { general_research: true, provenance },
      }));

      expect(response.status).toBe(201);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
        publisher: 'Journal of Boxing Science',
        publicationDate: '2019-03-01',
        metadata: { general_research: true, provenance },
      }));
    });

    test('a partial record, an empty one, and none at all are all accepted', async () => {
      for (const metadata of [{ provenance: { year: 2026 } }, { provenance: {} }, { general_research: true }]) {
        mockRequirePrincipal.mockResolvedValueOnce(principal());
        expect((await POST(postRequest({ ...validBody, metadata }))).status).toBe(201);
      }
      expect(mockCreate).toHaveBeenCalledTimes(3);
    });

    test('the keys the General Research form sends today still register', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());
      const sent = { doi_or_pmid: '31234567', provider: 'Penn State library', original_filename: 'a.pdf' };

      const response = await POST(postRequest({ ...validBody, metadata: { general_research: true, provenance: sent } }));

      expect(response.status).toBe(201);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ metadata: { general_research: true, provenance: sent } }));
    });

    test('what is stored is the cleaned copy: trimmed, blanks left out', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());

      await POST(postRequest({ ...validBody, metadata: { provenance: { population: ' adult boxers ', sex: '', year: null } } }));

      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ metadata: { provenance: { population: 'adult boxers' } } }));
    });

    test.each([
      ['an unknown key', { journal_impact: 4 }, 'metadata.provenance.journal_impact is not a provenance field'],
      ['a boxing_specificity outside the importer set', { boxing_specificity: 'boxing' }, 'metadata.provenance.boxing_specificity must be one of boxing_specific, partly_boxing_specific, ppbf_specific, transferred'],
      ['a year that is not plausible', { year: 3019 }, expect.stringMatching(/^metadata\.provenance\.year must be a whole year/)],
      ['a text field over its bound', { population: 'x'.repeat(301) }, 'metadata.provenance.population must be 300 characters or fewer'],
      ['a protected-domain flag that is not a boolean', { protected_domains: { contact: 'yes' } }, 'metadata.provenance.protected_domains.contact must be true or false'],
    ])('refuses %s with a 400 that says why, and writes nothing', async (_label, bad, message) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());

      const response = await POST(postRequest({ ...validBody, metadata: { provenance: bad } }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toEqual(message);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test('a null provenance is absence: the source registers without one', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());

      const response = await POST(postRequest({ ...validBody, metadata: { general_research: true, provenance: null } }));

      expect(response.status).toBe(201);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ metadata: { general_research: true } }));
    });

    test.each([['a list', []], ['text', 'Smith 2019']])('refuses provenance given as %s', async (_label, value) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());

      const response = await POST(postRequest({ ...validBody, metadata: { provenance: value } }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('metadata.provenance must be an object');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    // An online date in December and an issue year of the next January are both
    // true of one paper, so the two are not cross-checked.
    test('year and publication_date are independent: a year different from the date registers', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());

      const response = await POST(postRequest({ ...validBody, publication_date: '2019-12-20', metadata: { provenance: { year: 2020 } } }));

      expect(response.status).toBe(201);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
        publicationDate: '2019-12-20',
        metadata: { provenance: { year: 2020 } },
      }));
    });

    // boxing_specificity on a chunk is the evidence tier rule's input; here it
    // is a description of the source and sits only under metadata.provenance.
    test('provenance is stored under metadata.provenance only: no study field leaks to the top level of the metadata', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());

      await POST(postRequest({ ...validBody, publication_date: '2019-03-01', metadata: { provenance } }));

      const stored = (mockCreate.mock.calls[0][0] as { metadata: Record<string, unknown> }).metadata;
      expect(Object.keys(stored)).toEqual(['provenance']);
      for (const key of Object.keys(provenance)) expect(stored).not.toHaveProperty(key);
    });

    test('the classification taxonomy is still enforced beside a valid provenance', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());

      const response = await POST(postRequest({
        ...validBody,
        metadata: { classification_domain: 'astrology', provenance: { year: 2019 } },
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('Unsupported classification_domain');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test('the reserved importer keys are still refused beside a valid provenance', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());

      const response = await POST(postRequest({
        ...validBody,
        metadata: { copied_from_source_id: 'src_6563c68e39047128', provenance: { year: 2026 } },
      }));

      expect(response.status).toBe(400);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  test('reports a repeated url as a conflict rather than a server fault', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockCreate.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "shadow_library_sources_organization_id_url_key"'),
    );

    const response = await POST(postRequest({ ...validBody, url: 'https://example.org/a' }));

    expect(response.status).toBe(409);
  });

  // L54 (audit 2026-10-17 item 3).
  test('a URL held by another registration is a conflict that names that source', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockCreate.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "shadow_library_sources_organization_id_url_key"'),
    );
    mockFindByUrl.mockResolvedValueOnce({ source_id: 'source_held', title: 'The Paper Already Here' });

    const response = await POST(postRequest({ ...validBody, url: ' https://example.org/a ', request_id: 'req-1234-abcd' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({
      code: 'SHADOW_LIBRARY_SOURCE_URL_TAKEN',
      existing_source: { source_id: 'source_held', title: 'The Paper Already Here' },
    }));
    expect(mockFindByUrl).toHaveBeenCalledWith('org-real', 'https://example.org/a');
  });

  // #345 D2 (Q2): a paper whose DOI or PMID is already on the shelf.
  test('a paper already on the shelf is a 409 that names the held source', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockCreate.mockRejectedValueOnce(
      new ShadowLibraryPublicationTakenError({ source_id: 'source_held', title: 'The Paper Already Here' }),
    );

    const response = await POST(postRequest({
      ...validBody,
      metadata: { general_research: true, provenance: { doi_or_pmid: '10.1000/held' } },
    }));

    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      ok: false,
      code: 'SHADOW_LIBRARY_PUBLICATION_TAKEN',
      existing_source: { source_id: 'source_held', title: 'The Paper Already Here' },
      error: expect.stringContaining('"The Paper Already Here" (source_held)'),
    });
    expect(body.error).toContain('same DOI or PMID');
    expect(mockFindByUrl).not.toHaveBeenCalled();
  });

  test('a retry of a registration already saved answers 200 recovered', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockCreate.mockResolvedValueOnce({ source_id: 'source_first', recovered: true } as never);

    const response = await POST(postRequest({ ...validBody, request_id: 'req-1234-abcd' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, recovered: true, source: { source_id: 'source_first' } });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-1234-abcd' }));
  });

  test('refuses a malformed request_id before writing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(postRequest({ ...validBody, request_id: 'no' }));

    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('GET /api/pilot/shadow/library/sources', () => {
  // OD-2026-10-08-005 A-Q13: a coach reads the list to pick a source to
  // attach to a research requirement. Registering one stays curator-only (above).
  test('a coach reads the gym shelf list', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockList.mockResolvedValueOnce([{ source_id: 'source_1' }] as never);

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-real' }));
  });

  test.each(['athlete', 'parent', 'board', 'volunteer', 'staff'] as const)('a %s cannot read the list', async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal(role));

    expect((await GET(getRequest())).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  // Issue #345 provenance. It sits in the source's metadata, which the list
  // returns whole (select s.*) to the roles that may read the list: curators
  // and coaches. Athlete, parent, board, volunteer and staff-tier readers are
  // refused by the role check, and the family research answers are built from
  // named fields (researchFamilyView.ts).
  test('staff read a source with its provenance as stored', async () => {
    const provenance = { year: 2019, boxing_specificity: 'transferred', protected_domains: { contact: true } };
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockList.mockResolvedValueOnce([{ source_id: 'source_1', metadata: { provenance } }] as never);

    const payload = await (await GET(getRequest())).json();

    expect(payload.items[0].metadata.provenance).toEqual(provenance);
  });

  test.each(['athlete', 'parent', 'board', 'volunteer', 'staff'] as const)(
    'a %s is refused the list, so no provenance reaches a family reader',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));

      const response = await GET(getRequest());

      expect(response.status).toBe(403);
      expect(mockList).not.toHaveBeenCalled();
      expect(JSON.stringify(await response.json())).not.toContain('provenance');
    },
  );

  test('returns items under the key the seed script reads', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockList.mockResolvedValueOnce([{ source_id: 'source_1' }] as never);

    const response = await GET(getRequest('?source_type=internal_policy&status=active&limit=200'));
    const payload = await response.json();

    // findCanonicalSource reads `response.items` and treats a non-array as
    // empty, which would silently re-register the doctrine source on every run.
    expect(Array.isArray(payload.items)).toBe(true);
    expect(payload.items[0].source_id).toBe('source_1');
  });

  test('passes the seed script filters through', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    await GET(getRequest('?source_type=internal_policy&status=active&limit=200'));

    expect(mockList).toHaveBeenCalledWith({
      organizationId: 'org-real',
      sourceType: 'internal_policy',
      status: 'active',
      limit: 200,
      offset: 0,
    });
  });

  test.each([
    ['a limit above the cap', '?limit=201'],
    ['a zero limit', '?limit=0'],
    ['a non-numeric limit', '?limit=all'],
    ['a negative offset', '?offset=-1'],
    ['an unknown source_type', '?source_type=blog_post'],
  ])('rejects %s', async (_label, search) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await GET(getRequest(search));

    expect(response.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('scopes the listing to the session organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    await GET(getRequest('?organization_id=org-attacker'));

    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-real' }),
    );
  });
});

// Classification correction (issue #345 workflow 3): curator-gated, taxonomy-
// validated, and narrower than every other write on this route.
describe('PATCH /api/pilot/shadow/library/sources', () => {
  function patchRequest(body: Record<string, unknown>) {
    return new NextRequest('http://localhost/api/pilot/shadow/library/sources', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('a coach cannot reclassify', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));

    const response = await PATCH(patchRequest({ source_id: 'src-1', classification_domain: 'ai_ml_data_science' }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockReclassify).not.toHaveBeenCalled();
  });

  test('a label outside the shared taxonomy is refused', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await PATCH(patchRequest({ source_id: 'src-1', classification_domain: 'astrology' }));

    expect(response.status).toBe(400);
    expect(mockReclassify).not.toHaveBeenCalled();
  });

  test('a valid correction is org-scoped, and a missing source hides as not-found', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockReclassify.mockResolvedValueOnce({ source_id: 'src-1' } as never);

    const ok = await PATCH(patchRequest({ source_id: 'src-1', classification_domain: 'youth_development_safeguarding' }));
    expect(ok.status).toBe(200);
    expect(mockReclassify).toHaveBeenCalledWith('org-real', 'src-1', 'youth_development_safeguarding');

    mockReclassify.mockResolvedValueOnce(null);
    const missing = await PATCH(patchRequest({ source_id: 'src-x', classification_domain: 'youth_development_safeguarding' }));
    expect(missing.status).toBe(404);
  });
});

// RINT-05a. OD-2026-10-02-013 answer 1B: the platform owner writes the
// platform shelf in the app. The shelf is a name in the request, resolved to an
// organization id on the server; no organization id is read from the request.
describe('the platform shelf on /api/pilot/shadow/library/sources', () => {
  const NON_OWNERS = ['organization_admin', 'admin', 'coach', 'athlete', 'parent', 'board', 'volunteer', 'staff'] as const;

  function patchRequest(body: Record<string, unknown>) {
    return new NextRequest('http://localhost/api/pilot/shadow/library/sources', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('platform_owner registers on the platform shelf, not its own organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await POST(postRequest({ ...validBody, shelf: 'platform', organization_id: 'org-attacker' }));

    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ organizationId: '__platform__' }));
  });

  test.each(NON_OWNERS)('%s gets 403 for shelf: platform on every method', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));

    const post = await POST(postRequest({ ...validBody, shelf: 'platform' }));
    const get = await GET(getRequest('?shelf=platform'));
    const patch = await PATCH(patchRequest({ source_id: 'src-1', classification_domain: 'ai_ml_data_science', shelf: 'platform' }));

    expect([post.status, get.status, patch.status]).toEqual([403, 403, 403]);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
    expect(mockReclassify).not.toHaveBeenCalled();
  });

  test('platform_owner lists and reclassifies on the platform shelf', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('platform_owner'));
    mockReclassify.mockResolvedValueOnce({ source_id: 'src-1' } as never);

    expect((await GET(getRequest('?shelf=platform&organization_id=org-attacker'))).status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ organizationId: '__platform__' }));

    const patch = await PATCH(patchRequest({ source_id: 'src-1', classification_domain: 'ai_ml_data_science', shelf: 'platform' }));
    expect(patch.status).toBe(200);
    expect(mockReclassify).toHaveBeenCalledWith('__platform__', 'src-1', 'ai_ml_data_science');
  });

  // D3 bars the platform owner's gym-shelf WRITES only; reading a gym's
  // Library is unchanged.
  test('platform_owner still reads its gym shelf when no shelf is named', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    expect((await GET(getRequest())).status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-real' }));
  });

  test('platform_owner cannot reclassify a gym-shelf source', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await PATCH(patchRequest({ source_id: 'src-1', classification_domain: 'ai_ml_data_science' }));

    expect(response.status).toBe(403);
    expect(mockReclassify).not.toHaveBeenCalled();
  });

  test.each([['an organization id', 'org-real'], ['the reserved id', '__platform__'], ['a number', 1]])(
    'refuses %s as a shelf',
    async (_label, shelf) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

      const response = await POST(postRequest({ ...validBody, shelf }));

      expect(response.status).toBe(400);
      expect(mockCreate).not.toHaveBeenCalled();
    },
  );

  test('a gym admin naming the gym shelf is the same as naming none', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(postRequest({ ...validBody, shelf: 'gym' }));

    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-real' }));
  });
});
