jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));
jest.mock('./access', () => ({
  assertActorCanAccessAthlete: jest.fn(),
}));
jest.mock('./shadowEvents', () => ({ emitShadowEvent: jest.fn() }));
jest.mock('./shadowTelemetry', () => ({ writeShadowTelemetryEvent: jest.fn() }));
jest.mock('./shadowResearch', () => ({
  createShadowResearchRequirement: jest.fn(),
  listShadowResearchRequirements: jest.fn(),
}));

import { assertActorCanAccessAthlete } from './access';
import { query } from './db';
import { normalizeSearchScope, searchShadowLibrary } from './shadowLibrary';

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockAssertActorCanAccessAthlete = jest.mocked(assertActorCanAccessAthlete);

describe('SHADOW library search scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue([]);
    mockAssertActorCanAccessAthlete.mockResolvedValue(undefined);
  });
  it('forces an athlete to their own subject scope', () => {
    expect(normalizeSearchScope({
      actorRole: 'athlete',
      athleteId: 'athlete-a',
      scope: 'scoped',
    })).toEqual({
      scope: 'subject',
      effectiveSubjectId: 'athlete-a',
    });
  });

  it('rejects an athlete-supplied subject override', () => {
    expect(() => normalizeSearchScope({
      actorRole: 'athlete',
      athleteId: 'athlete-a',
      subjectId: 'athlete-b',
      scope: 'subject',
    })).toThrow('Forbidden: athlete cannot search another subject');
  });

  it('fails closed when an athlete principal has no athlete identity', () => {
    expect(() => normalizeSearchScope({
      actorRole: 'athlete',
      athleteId: null,
    })).toThrow('Forbidden: athlete SHADOW library access requires an athlete identity');
  });

  it('reserves master scope for organization administrators', () => {
    expect(() => normalizeSearchScope({
      actorRole: 'coach',
      scope: 'master',
    })).toThrow('Forbidden: master SHADOW library scope requires an organization administrator');

    expect(normalizeSearchScope({
      actorRole: 'organization_admin',
      scope: 'master',
    })).toEqual({
      scope: 'master',
      effectiveSubjectId: null,
    });
  });

  it('requires a subject ID for explicit subject scope', () => {
    expect(() => normalizeSearchScope({
      actorRole: 'coach',
      scope: 'subject',
    })).toThrow('Missing SHADOW library subject');
  });

  it('limits scoped searches without a subject to organization-global chunks', async () => {
    await searchShadowLibrary({
      organizationId: 'org-1',
      actorAccountId: 'coach-1',
      actorRole: 'coach',
      scope: 'scoped',
      queryText: 'footwork',
    });

    expect(String(mockQuery.mock.calls[0][0])).toContain(
      "$2::text = 'scoped' and c.subject_id is null",
    );
    expect(mockQuery.mock.calls[0][1]?.slice(0, 3)).toEqual(['org-1', 'scoped', null]);
    expect(mockAssertActorCanAccessAthlete).not.toHaveBeenCalled();
  });

  it('canonically authorizes an exact subject before searching global plus subject chunks', async () => {
    await searchShadowLibrary({
      organizationId: 'org-1',
      actorAccountId: 'coach-1',
      actorRole: 'coach',
      scope: 'subject',
      subjectId: 'athlete-a',
      queryText: 'footwork',
    });

    expect(mockAssertActorCanAccessAthlete).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'coach-1',
        organizationId: 'org-1',
        role: 'coach',
      }),
      'athlete-a',
    );
    expect(mockQuery.mock.calls[0][1]?.slice(0, 3))
      .toEqual(['org-1', 'subject', 'athlete-a']);
  });
});
