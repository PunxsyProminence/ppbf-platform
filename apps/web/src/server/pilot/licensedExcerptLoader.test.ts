import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CONFIRM_PHRASE,
  MAX_LOCATOR_LENGTH,
  MAX_TEXT_LENGTH,
  canonicalContentSha256,
  isInvalid,
  parseExcerptFile,
  planFingerprint,
  readExcerptFolder,
  runExcerptLoad,
} from './licensedExcerptLoader';

// The pure parts of the loader: file validation, the content hash, the plan
// fingerprint and the refusals that come before any database call. The real
// database behaviour is licensedExcerptLoader.pg.test.ts.

jest.mock('./db', () => ({
  query: jest.fn(() => {
    throw new Error('no database in this suite');
  }),
  withPoolClient: jest.fn(() => {
    throw new Error('no database in this suite');
  }),
}));
jest.mock('./shadowLibrary', () => ({
  createShadowLibraryChunk: jest.fn(),
  createShadowLibraryDocument: jest.fn(),
  HELD_EXCERPT_BUDGET_SQL: 'select 1',
  isExcerptBudgeted: jest.fn(() => true),
  MAX_EXCERPT_CHUNKS_PER_NON_OWNED_SOURCE: 20,
  MAX_EXCERPT_CHARACTERS_PER_NON_OWNED_SOURCE: 30_000,
}));

const VALID = {
  format: 'ppbf-licensed-excerpts/1',
  source_id: 'src_1',
  document_name: 'Chapter 4',
  citation: 'Author (2024). Title. Publisher.',
  excerpts: [{ locator: 'p. 41', text: 'Some licensed text.' }],
};

function parse(body: unknown) {
  return parseExcerptFile('f.json', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
}

function problemsOf(body: unknown): string[] {
  const result = parse(body);
  return isInvalid(result) ? result.problems : [];
}

describe('parseExcerptFile', () => {
  test('accepts a valid file and trims its fields', () => {
    const result = parse({ ...VALID, citation: '  Author (2024). Title. Publisher.  ' });
    expect(isInvalid(result)).toBe(false);
    if (!isInvalid(result)) expect(result.content.citation).toBe('Author (2024). Title. Publisher.');
  });

  test.each([
    ['citation missing', { ...VALID, citation: undefined }, /citation is required/],
    ['citation blank', { ...VALID, citation: '   ' }, /citation is required/],
    ['locator missing', { ...VALID, excerpts: [{ text: 'x' }] }, /locator is required/],
    ['locator blank', { ...VALID, excerpts: [{ locator: ' ', text: 'x' }] }, /locator is required/],
    ['locator too long', { ...VALID, excerpts: [{ locator: 'p'.repeat(MAX_LOCATOR_LENGTH + 1), text: 'x' }] }, /locator is longer/],
    ['text too long', { ...VALID, excerpts: [{ locator: 'p. 1', text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }] }, /the limit is 20000/],
    ['text blank', { ...VALID, excerpts: [{ locator: 'p. 1', text: '' }] }, /text is required/],
    ['no excerpts', { ...VALID, excerpts: [] }, /non-empty array/],
    ['wrong format', { ...VALID, format: 'v0' }, /format must be/],
    ['unknown field', { ...VALID, organization_id: 'x' }, /unexpected field 'organization_id'/],
    ['unknown excerpt field', { ...VALID, excerpts: [{ locator: 'p', text: 't', page: 3 }] }, /unexpected field 'page'/],
    ['source missing', { ...VALID, source_id: '' }, /source_id is required/],
  ])('refuses: %s', (_label, body, pattern) => {
    expect(problemsOf(body).join('\n')).toMatch(pattern);
  });

  test('accepts text exactly at the limit (the chunks route allows it)', () => {
    expect(problemsOf({ ...VALID, excerpts: [{ locator: 'p. 1', text: 'x'.repeat(MAX_TEXT_LENGTH) }] })).toEqual([]);
  });

  test('refuses a NUL character, which the database would refuse part way through an apply', () => {
    expect(problemsOf({ ...VALID, excerpts: [{ locator: 'p. 1', text: 'a\u0000b' }] }).join(' ')).toMatch(/NUL character/);
    expect(problemsOf({ ...VALID, citation: 'x\u0000' }).join(' ')).toMatch(/NUL character/);
  });

  test('accepts a file saved with a byte-order mark', () => {
    expect(isInvalid(parse(`\uFEFF${JSON.stringify(VALID)}`))).toBe(false);
  });

  test('refuses bad JSON and non-objects', () => {
    expect(problemsOf('{nope')).toEqual(['not valid JSON']);
    expect(problemsOf('[]')).toEqual(['top level must be a JSON object']);
  });

  test('a problem never quotes the excerpt text', () => {
    const secret = 'SECRET-LICENSED-WORDS';
    const problems = problemsOf({ ...VALID, excerpts: [{ locator: '', text: `${secret}${'x'.repeat(MAX_TEXT_LENGTH)}` }] });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).not.toContain(secret);
  });
});

describe('canonicalContentSha256', () => {
  const base = parse(VALID);
  if (isInvalid(base)) throw new Error('fixture invalid');

  test('ignores key order and surrounding whitespace', () => {
    const reordered = parse(`{"excerpts":[{"text":" Some licensed text. ","locator":"p. 41"}],"citation":"Author (2024). Title. Publisher.","document_name":"Chapter 4","source_id":"src_1","format":"ppbf-licensed-excerpts/1"}`);
    if (isInvalid(reordered)) throw new Error('fixture invalid');
    expect(reordered.contentSha256).toBe(base.contentSha256);
  });

  test.each([
    ['text', { excerpts: [{ locator: 'p. 41', text: 'Other text.' }] }],
    ['locator', { excerpts: [{ locator: 'p. 42', text: 'Some licensed text.' }] }],
    ['citation', { citation: 'Someone else.' }],
    ['document name', { document_name: 'Chapter 5' }],
    ['source', { source_id: 'src_2' }],
  ])('changes when the %s changes', (_label, change) => {
    const changed = parse({ ...VALID, ...change });
    if (isInvalid(changed)) throw new Error('fixture invalid');
    expect(changed.contentSha256).not.toBe(base.contentSha256);
    expect(canonicalContentSha256(changed.content)).toBe(changed.contentSha256);
  });
});

describe('planFingerprint', () => {
  const file = {
    name: 'a.json',
    status: 'new' as const,
    contentSha256: 'a'.repeat(64),
    sourceId: 'src_1',
    sourceRights: 'unknown',
    documentId: null,
    excerptCount: 2,
    createOrdinals: [0, 1],
    problems: [],
    citation: 'c',
    excerpts: [],
  };
  const plan = { target: 'host/db', organizationId: 'org', actorAccountId: 'acct', files: [file], blocked: false };

  test('is stable and names what the apply would do', () => {
    expect(planFingerprint(plan)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(planFingerprint(plan)).toBe(planFingerprint({ ...plan }));
    for (const changed of [
      { ...plan, target: 'other-host/db' },
      { ...plan, organizationId: 'other' },
      { ...plan, actorAccountId: 'other' },
      { ...plan, files: [{ ...file, createOrdinals: [1] }] },
      { ...plan, files: [{ ...file, contentSha256: 'b'.repeat(64) }] },
      { ...plan, files: [{ ...file, name: 'b.json' }] },
      { ...plan, files: [{ ...file, status: 'resume' as const }] },
    ]) {
      expect(planFingerprint(changed)).not.toBe(planFingerprint(plan));
    }
  });
});

describe('readExcerptFolder', () => {
  test('reads nested files by blob name and reports anything that is not .json', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ppbf-excerpt-unit-'));
    try {
      await fs.mkdir(path.join(dir, 'books'), { recursive: true });
      await fs.writeFile(path.join(dir, 'books', 'one.json'), JSON.stringify(VALID));
      await fs.writeFile(path.join(dir, 'whole-book.pdf'), 'pdf bytes');
      const files = await readExcerptFolder(dir);
      expect(files.map((f) => [f.name, isInvalid(f) ? f.problems : 'ok'])).toEqual([
        ['books/one.json', 'ok'],
        ['whole-book.pdf', ['not a .json excerpt file']],
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runExcerptLoad refuses before touching the database', () => {
  const base = { target: 'host/db', organizationId: 'org', actorAccountId: 'acct', dir: '.', log: () => undefined };

  test.each([
    ['no organization', { ...base, organizationId: ' ', apply: false }, /^MISSING_ORGANIZATION_ID/],
    ['no actor', { ...base, actorAccountId: '', apply: false }, /^MISSING_ACTOR_ACCOUNT_ID/],
    ['apply without phrase', { ...base, apply: true, expectedFingerprint: `sha256:${'0'.repeat(64)}` }, /^CONFIRM_PHRASE_MISMATCH/],
    ['apply with a near-miss phrase', { ...base, apply: true, confirm: 'load excerpts', expectedFingerprint: `sha256:${'0'.repeat(64)}` }, /^CONFIRM_PHRASE_MISMATCH/],
    ['apply without fingerprint', { ...base, apply: true, confirm: CONFIRM_PHRASE }, /^MISSING_EXPECTED_FINGERPRINT/],
    ['apply with a malformed fingerprint', { ...base, apply: true, confirm: CONFIRM_PHRASE, expectedFingerprint: 'abc' }, /^MISSING_EXPECTED_FINGERPRINT/],
  ])('%s', async (_label, options, pattern) => {
    await expect(runExcerptLoad(options)).rejects.toThrow(pattern);
  });
});

// The downloaded folder holds licensed text (overwatch, 2026-10-05): it is
// removed in an always() step and never uploaded as an artifact.
describe('load-licensed-excerpts.yml keeps the licensed text on the runner only', () => {
  const workflow = readFileSync(path.resolve(__dirname, '../../../../../.github/workflows/load-licensed-excerpts.yml'), 'utf8')
    .replace(/\r\n/g, '\n');

  test('a step that always runs removes the downloaded folder', () => {
    expect(workflow).toMatch(/- name: Remove Downloaded Excerpts\n\s+if: always\(\)\n\s+run: rm -rf "\$RUNNER_TEMP\/licensed-excerpts"/);
    expect(workflow).toContain('DIR="$RUNNER_TEMP/licensed-excerpts"');
  });

  test('nothing is uploaded as an artifact or cached', () => {
    expect(workflow).not.toMatch(/upload-artifact|actions\/cache/);
  });

  test('blob reads use Entra sign-in, never an account key', () => {
    expect(workflow).not.toMatch(/azure-storage-connection-string|AZURE_STORAGE_CONNECTION_STRING|--account-key|keys list/);
    const storageCalls = workflow.match(/az storage [^\n]+/g) ?? [];
    expect(storageCalls.length).toBe(2);
    for (const call of storageCalls) {
      const block = workflow.slice(workflow.indexOf(call), workflow.indexOf(call) + 400);
      expect(block).toContain('--auth-mode login');
    }
  });
});
