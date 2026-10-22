jest.mock('./db', () => ({
  withTransaction: jest.fn(),
}));
jest.mock('./shadowLibrary', () => ({
  // The real constant: PASSAGE_DISPLAY_RIGHTS is read from it.
  RESEARCH_BRIDGE_EXPORTABLE_RIGHTS: jest.requireActual('./shadowLibrary').RESEARCH_BRIDGE_EXPORTABLE_RIGHTS,
  // Real: the excerpt window is chosen with the search's own word rule.
  tokenizeQuery: jest.requireActual('./shadowLibrary').tokenizeQuery,
  searchShadowLibrary: jest.fn(),
}));

import { createHash } from 'node:crypto';

import { withTransaction } from './db';
import {
  excerptWindowStarts,
  MAX_BUNDLE_CHARS,
  MAX_EVIDENCE_ITEMS,
  MAX_EXCERPT_CHARS,
  PASSAGE_DISPLAY_RIGHTS,
  publicEvidenceCitations,
  replayCitedPassage,
  retrieveShadowEvidenceBundle,
  selectExcerpt,
} from './shadowEvidence';
import { searchShadowLibrary, tokenizeQuery } from './shadowLibrary';
import { indicatesInsufficientContext, LIBRARY_HAS_NOTHING_YET } from './shadowNoAnswer';

const mockWithTransaction = jest.mocked(withTransaction);
const mockSearchShadowLibrary = jest.mocked(searchShadowLibrary);
const actor = {
  accountId: 'account-a',
  organizationId: 'org-a',
  athleteId: null,
  role: 'coach' as const,
};

describe('SHADOW evidence bundles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates bounded server-owned citations from the authenticated organization and subject', async () => {
    const privateQuery = 'Compare the private athlete training note';
    const privateExcerpt = 'Private athlete note: worked only approved defensive drills.';
    mockSearchShadowLibrary.mockResolvedValue([{
      chunk_id: 'chunk-a',
      document_id: 'doc-a',
      source_id: 'source-a',
      subject_id: 'athlete-a',
      ordinal: 0,
      document_name: 'Approved training record',
      source_title: 'Approved coaching source',
      source_publisher: null,
      source_type: 'coach_observation',
      authority_tier: 2,
      source_status: 'active',
      publication_date: null,
      text_content: privateExcerpt,
      evidence_class: 'VERIFIED EVIDENCE',
      boxing_specificity: 'boxing_specific',
      score: 50,
    }]);
    const clientQuery = jest.fn(async (sql: string, params: unknown[]) => ({
      rows: sql.includes('returning evidence_id') ? [{ evidence_id: params[0] }] : [],
    }));
    mockWithTransaction.mockImplementation(async (callback) => callback({
      query: clientQuery,
    } as never));

    const bundle = await retrieveShadowEvidenceBundle({
      actor,
      subjectId: 'athlete-a',
      queryText: privateQuery,
    });

    expect(mockSearchShadowLibrary).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-a',
      actorAccountId: 'account-a',
      scope: 'subject',
      subjectId: 'athlete-a',
      limit: 4,
    }));
    expect(bundle.bundleId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bundle.items).toHaveLength(1);
    expect(bundle.items[0].evidenceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bundle.context).toContain(bundle.items[0].token);
    expect(bundle.context).toContain(privateExcerpt);

    const persistedParameters = JSON.stringify(clientQuery.mock.calls.map((call) => call[1]));
    expect(persistedParameters).not.toContain(privateQuery);
    expect(persistedParameters).not.toContain(privateExcerpt);
    // The chunk lookup admits the caller's organization OR the platform evidence
    // baseline, while the row it writes still records $3 -- the caller -- as the
    // bundle's owner. Those are two different questions, and they used to share
    // one column: citing a baseline chunk needed organization_id to be the gym
    // (for the bundle foreign key) and the baseline (for the library foreign
    // keys) at the same time, so the insert died after the model had answered.
    const persistSql = String(clientQuery.mock.calls[1][0]);
    expect(persistSql).toContain('c.organization_id = any($11::text[])');
    expect(persistSql).toContain('library_organization_id');
    // Written from the CHUNK's owner, never from a parameter: a literal here
    // would record the citing gym as the owner of a baseline row.
    expect(persistSql).toContain('$8, $9, c.organization_id');
    expect(clientQuery.mock.calls[1][1]).toEqual(expect.arrayContaining([
      'org-a',
      'account-a',
      'source-a',
      'doc-a',
      'chunk-a',
      'athlete-a',
      ['org-a', '__platform__'],
    ]));
  });

  // F-161 (d): with excerpts in hand the model was told how to cite them, never
  // what to do when none answers. The words it is given are the ones the chat
  // route reads back as a no-answer.
  it('tells the model to say the Library has nothing and cite none when no excerpt answers', async () => {
    mockSearchShadowLibrary.mockResolvedValue([{
      chunk_id: 'chunk-hr',
      document_id: 'doc-hr',
      source_id: 'source-hr',
      subject_id: null,
      ordinal: 0,
      document_name: 'Bout heart rate',
      source_title: 'Bout heart rate study',
      source_publisher: null,
      source_type: 'study',
      authority_tier: 2,
      source_status: 'active',
      publication_date: null,
      text_content: 'Heart rate during amateur bouts.',
      evidence_class: 'VERIFIED EVIDENCE',
      boxing_specificity: 'boxing_specific',
      score: 50,
    }]);
    mockWithTransaction.mockImplementation(async (callback) => callback({
      query: jest.fn(async (sql: string, params: unknown[]) => ({
        rows: sql.includes('returning evidence_id') ? [{ evidence_id: params[0] }] : [],
      })),
    } as never));

    const bundle = await retrieveShadowEvidenceBundle({ actor, queryText: 'resting heart rate' });

    expect(bundle.availability).toBe('available');
    expect(bundle.context).toContain(
      `When no excerpt answers the question, say so in plain words ("${LIBRARY_HAS_NOTHING_YET}") and cite none of them.`,
    );
    const quoted = [...bundle.context.matchAll(/\("([^"]*\blibrary\b[^"]*)"\)/gi)].map((match) => match[1]);
    expect(quoted).toEqual([LIBRARY_HAS_NOTHING_YET]);
    expect(indicatesInsufficientContext(quoted[0])).toBe(true);
  });

  it('persists an explicit unavailable bundle when no qualified evidence exists', async () => {
    mockSearchShadowLibrary.mockResolvedValue([]);
    const clientQuery = jest.fn().mockResolvedValue({ rows: [] });
    mockWithTransaction.mockImplementation(async (callback) => callback({
      query: clientQuery,
    } as never));

    const bundle = await retrieveShadowEvidenceBundle({
      actor,
      queryText: 'What evidence is available?',
    });

    expect(bundle.availability).toBe('unavailable');
    expect(bundle.bundleId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bundle.allowedEvidenceIds).toEqual([]);
    expect(bundle.context).toContain('EVIDENCE UNAVAILABLE');
    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(clientQuery.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'org-a',
      'account-a',
      'unavailable',
      0,
    ]));
  });

  it('fails closed if evidence loses approval between search and bundle persistence', async () => {
    mockSearchShadowLibrary.mockResolvedValue([{
      chunk_id: 'chunk-a',
      document_id: 'doc-a',
      source_id: 'source-a',
      subject_id: null,
      ordinal: 0,
      document_name: 'Document',
      source_title: 'Source',
      source_publisher: null,
      source_type: 'internal_policy',
      authority_tier: 1,
      source_status: 'active',
      publication_date: null,
      text_content: 'Approved text at search time.',
      evidence_class: 'VERIFIED EVIDENCE',
      boxing_specificity: 'boxing_specific',
      score: 50,
    }]);
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockWithTransaction.mockImplementation(async (callback) => callback({
      query: clientQuery,
    } as never));

    await expect(retrieveShadowEvidenceBundle({
      actor,
      queryText: 'Find approved policy',
    })).rejects.toThrow('SHADOW_EVIDENCE_QUALIFICATION_CHANGED');
  });
});

// OD-2026-10-08-005 A-Q11, ruling 4: the passage under each source, within the
// rights rule. The store reports which passages are within it; only those
// carry their text out. Real rows: shadowPassageDisplay.pg.test.ts.
describe('the cited passage goes out only within the rights rule', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function searchRow(chunkId: string, text: string) {
    return {
      chunk_id: chunkId,
      document_id: `doc-${chunkId}`,
      source_id: `source-${chunkId}`,
      subject_id: null,
      ordinal: 0,
      document_name: `Document ${chunkId}`,
      source_title: `Source ${chunkId}`,
      source_publisher: null,
      source_type: 'peer_reviewed',
      authority_tier: 1,
      source_status: 'active',
      publication_date: null,
      text_content: text,
      evidence_class: null,
      boxing_specificity: null,
      score: 10,
    };
  }

  it('is PPBF-owned and open-licence, the research bridge rule', () => {
    expect([...PASSAGE_DISPLAY_RIGHTS].sort()).toEqual(['open_licence', 'ppbf_owned']);
  });

  it('sends the excerpt of a passage the store marks displayable, and no excerpt key for one it does not', async () => {
    mockSearchShadowLibrary.mockResolvedValue([
      searchRow('chunk-owned', 'Owned passage text.'),
      searchRow('chunk-licensed', 'Licensed passage text.'),
    ] as never);
    const clientQuery = jest.fn(async (sql: string, params: unknown[]) => ({
      rows: sql.includes('returning evidence_id')
        ? [{ evidence_id: params[0], passage_displayable: params[6] === 'chunk-owned' }]
        : [],
    }));
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    const bundle = await retrieveShadowEvidenceBundle({ actor, queryText: 'pivot' });
    const insert = clientQuery.mock.calls.find(([sql]) => sql.includes('returning evidence_id'));
    expect(insert?.[1][11]).toEqual(PASSAGE_DISPLAY_RIGHTS);

    const citations = publicEvidenceCitations(bundle, bundle.items.map((item) => item.evidenceId));
    const owned = citations.find((citation) => citation.sourceTitle === 'Source chunk-owned');
    const licensed = citations.find((citation) => citation.sourceTitle === 'Source chunk-licensed');
    expect(owned?.excerpt).toBe('Owned passage text.');
    expect(licensed).toBeDefined();
    expect(licensed).not.toHaveProperty('excerpt');
  });

  it('a citation not asked for is not sent, passage or not', async () => {
    mockSearchShadowLibrary.mockResolvedValue([searchRow('chunk-owned', 'Owned passage text.')] as never);
    mockWithTransaction.mockImplementation(async (callback) => callback({
      query: jest.fn(async (sql: string, params: unknown[]) => ({
        rows: sql.includes('returning evidence_id') ? [{ evidence_id: params[0], passage_displayable: true }] : [],
      })),
    } as never));

    const bundle = await retrieveShadowEvidenceBundle({ actor, queryText: 'pivot' });
    expect(publicEvidenceCitations(bundle, [])).toEqual([]);
  });
});

// Item 4 of the 2026-10-17 non-video ML audit: the model was given the first
// 900 characters of a passage, so an answer later in a long one -- and the
// qualification after it -- never reached it.
describe('the excerpt is the part of the passage that answers the question', () => {
  const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  const filler = (sentences: number) => 'Wrap both hands before the bell and check the tape at the wrist. '.repeat(sentences);
  const ANSWER = 'Novices should spar two-minute rounds at first.';
  const QUALIFIER = 'Only after six weeks of supervised work should those rounds reach three minutes.';
  // About 2,100 characters; the answer begins past character 900.
  const deepPassage = `${filler(15)}${ANSWER} ${QUALIFIER} ${filler(15)}`.trim();
  const QUESTION = 'How long should novice sparring rounds be?';
  const terms = tokenizeQuery(QUESTION);

  function row(chunkId: string, text: string) {
    return {
      chunk_id: chunkId,
      document_id: `doc-${chunkId}`,
      source_id: `source-${chunkId}`,
      subject_id: null,
      ordinal: 0,
      document_name: `Document ${chunkId}`,
      source_title: `Source ${chunkId}`,
      source_publisher: null,
      source_type: 'peer_reviewed',
      authority_tier: 1,
      source_status: 'active',
      publication_date: null,
      text_content: text,
      evidence_class: null,
      boxing_specificity: null,
      score: 1,
    };
  }

  // The store reads the chunk's locator in the statement that saves the item.
  function storeAccepting(locator: string | null = null) {
    mockWithTransaction.mockImplementation(async (callback) => callback({
      query: jest.fn(async (sql: string, params: unknown[]) => ({
        rows: sql.includes('returning evidence_id')
          ? [{ evidence_id: params[0], passage_displayable: true, excerpt_locator: locator }]
          : [],
      })),
    } as never));
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('carries an answer past character 900 to the model, with the qualification after it', async () => {
    expect(deepPassage.indexOf(ANSWER)).toBeGreaterThan(MAX_EXCERPT_CHARS);
    mockSearchShadowLibrary.mockResolvedValue([row('chunk-deep', deepPassage)] as never);
    storeAccepting('p. 12');

    const bundle = await retrieveShadowEvidenceBundle({ actor, queryText: QUESTION });

    expect(bundle.context).toContain(ANSWER);
    expect(bundle.context).toContain(QUALIFIER);
    expect(bundle.items[0].excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    // Where it sits in the source, and that text was left out on both sides.
    expect(bundle.context).toContain('Location: p. 12; Excerpt: … ');
    expect(bundle.context).toMatch(/ …$/);
  });

  it('begins the window one sentence before the answer and ends it at a sentence end', () => {
    const excerpt = selectExcerpt(deepPassage, terms);
    expect(excerpt.startsWith('Wrap both hands')).toBe(true);
    expect(excerpt.indexOf(ANSWER)).toBe(filler(1).length);
    expect(excerpt.endsWith('.')).toBe(true);
    expect(deepPassage).toContain(excerpt);
  });

  it('marks no cut on a window that is the whole passage, even in repetitive text', async () => {
    const repeated = filler(5).trim();
    mockSearchShadowLibrary.mockResolvedValue([row('chunk-whole', repeated)] as never);
    storeAccepting();

    const bundle = await retrieveShadowEvidenceBundle({ actor, queryText: 'tape wrist' });

    expect(bundle.context).toContain(`Excerpt: ${repeated}`);
    expect(bundle.context).not.toContain('…');
  });

  it('matches the question\'s words whatever their case', () => {
    const shouted = deepPassage.replace(ANSWER, ANSWER.toUpperCase());
    expect(selectExcerpt(shouted, terms)).toContain(ANSWER.toUpperCase());
  });

  it('gives a passage that fits whole, and one sharing no word with the question from its start, as before', () => {
    expect(selectExcerpt('  Short   passage.  ', terms)).toBe('Short passage.');
    expect(selectExcerpt(deepPassage, tokenizeQuery('uppercut'))).toBe(deepPassage.slice(0, MAX_EXCERPT_CHARS));
  });

  it('reaches into a long sentence with no sentence end before the match', () => {
    const runOn = `${'the hands stay high and the chin stays tucked '.repeat(40)}then novices spar two-minute rounds ${'and the feet keep moving '.repeat(20)}`.trim();
    const excerpt = selectExcerpt(runOn, terms);
    expect(excerpt).toContain('novices spar two-minute rounds');
    expect(excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(replayCitedPassage(runOn, sha256(excerpt))).toBe(excerpt);
  });

  it('near the end of a passage, reaches back rather than running short', () => {
    const tail = `${filler(30)}${ANSWER} ${QUALIFIER}`;
    const excerpt = selectExcerpt(tail, terms);
    expect(excerpt.endsWith(QUALIFIER)).toBe(true);
    expect(excerpt.length).toBeGreaterThan(MAX_EXCERPT_CHARS - filler(1).length);
  });

  it('replays a window from inside the passage, and the prefixes earlier bundles stored', () => {
    const excerpt = selectExcerpt(deepPassage, terms);
    expect(deepPassage.startsWith(excerpt)).toBe(false);
    expect(replayCitedPassage(deepPassage, sha256(excerpt))).toBe(excerpt);
    // The old shape: a prefix, sometimes cut short by the old 3,200 budget.
    expect(replayCitedPassage(deepPassage, sha256(deepPassage.slice(0, 500)))).toBe(deepPassage.slice(0, 500));
    // Text that has changed replays nothing.
    expect(replayCitedPassage(deepPassage.replace('six weeks', 'two weeks'), sha256(excerpt))).toBeUndefined();
  });

  it('only ever begins a window where replay looks', () => {
    for (const question of [QUESTION, 'tape wrist', 'three minutes supervised']) {
      const excerpt = selectExcerpt(deepPassage, tokenizeQuery(question));
      expect(excerptWindowStarts(deepPassage)).toContain(deepPassage.indexOf(excerpt));
    }
  });

  it('replays the last window of a 20,000-character passage quickly', () => {
    const longest = `${filler(320)}${ANSWER} ${QUALIFIER}`.slice(-20_000);
    expect(longest.length).toBe(20_000);
    const excerpt = selectExcerpt(longest, terms);
    const hitStartedAt = process.hrtime.bigint();
    expect(replayCitedPassage(longest, sha256(excerpt))).toBe(excerpt);
    const hitMs = Number(process.hrtime.bigint() - hitStartedAt) / 1e6;
    // A miss walks every candidate: the most a changed passage can cost.
    const missStartedAt = process.hrtime.bigint();
    expect(replayCitedPassage(longest, sha256('not in the passage'))).toBeUndefined();
    const missMs = Number(process.hrtime.bigint() - missStartedAt) / 1e6;
    console.info(`replay of a 20,000-character passage: hit ${hitMs.toFixed(1)} ms, miss ${missMs.toFixed(1)} ms`);
    expect(missMs).toBeLessThan(250);
  });

  it("holds every item's full excerpt in the bundle budget, so none is cut short", async () => {
    expect(MAX_EVIDENCE_ITEMS * MAX_EXCERPT_CHARS).toBeLessThanOrEqual(MAX_BUNDLE_CHARS);
    const unanswered = 'x'.repeat(2_000);
    mockSearchShadowLibrary.mockResolvedValue([1, 2, 3, 4].map((index) => row(`chunk-${index}`, unanswered)) as never);
    storeAccepting();

    const bundle = await retrieveShadowEvidenceBundle({ actor, queryText: 'novice sparring rounds' });

    expect(bundle.items.map((item) => item.excerpt.length)).toEqual([900, 900, 900, 900]);
  });
});
