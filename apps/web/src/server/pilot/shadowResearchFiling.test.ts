import { createShadowResearchRequirement, getShadowResearchRequirementById } from './shadowResearch';
import {
  fileUnansweredShadowQuestion,
  mayFileUnansweredQuestion,
  unansweredQuestionKey,
  type UnansweredFilingFacts,
} from './shadowResearchFiling';

jest.mock('./shadowResearch', () => ({
  ...jest.requireActual('./shadowResearch'),
  createShadowResearchRequirement: jest.fn(),
  getShadowResearchRequirementById: jest.fn(),
}));

const create = jest.mocked(createShadowResearchRequirement);
const read = jest.mocked(getShadowResearchRequirementById);
const base = { organizationId: 'org-1', accountId: 'acct-1', question: '  What   should I EAT? ' };

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue(7);
  read.mockReset();
  read.mockResolvedValue({ status: 'open' } as never);
});

test('an athlete files a subject-less row keyed on the normalized question', async () => {
  const ok = await fileUnansweredShadowQuestion({ ...base, role: 'athlete', athleteId: 'ath-9' });
  expect(ok).toBe(true);
  const input = create.mock.calls[0][0];
  expect(input.subjectId).toBeNull();
  expect(input.sourceEntityId).toMatch(/^acct:acct-1:[0-9a-f]{64}$/);
  expect(input.sourceEntityId).not.toContain('eat');
  expect(input.sourceEntityType).toBe('shadow_asker_question');
  expect(input.sourceEventName).toBe('shadow_unanswered_question');
});

test('a parent never names a child as the subject', async () => {
  await fileUnansweredShadowQuestion({ ...base, role: 'parent', athleteId: 'ath-9' });
  expect(create.mock.calls[0][0].subjectId).toBeNull();
});

test('a coach asking about an athlete files with the same key the research button uses', async () => {
  await fileUnansweredShadowQuestion({ ...base, role: 'coach', athleteId: 'ath-9' });
  const input = create.mock.calls[0][0];
  expect(input.subjectId).toBe('ath-9');
  expect(input.sourceEntityId).toBe(unansweredQuestionKey(base.question, 'ath-9'));
});

test('a blank question files nothing', async () => {
  expect(await fileUnansweredShadowQuestion({ ...base, role: 'athlete', question: '   ' })).toBe(false);
  expect(create).not.toHaveBeenCalled();
});

test('a failed write reads as not filed and does not throw', async () => {
  create.mockRejectedValueOnce(new Error('db down'));
  const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await fileUnansweredShadowQuestion({ ...base, role: 'athlete' })).toBe(false);
  spy.mockRestore();
});

test('a question whose stored row is already closed is not reported as passed on', async () => {
  read.mockResolvedValueOnce({ status: 'resolved' } as never);
  expect(await fileUnansweredShadowQuestion({ ...base, role: 'athlete' })).toBe(false);
});

test('a non-staff question cannot land on a key a coach can file', async () => {
  await fileUnansweredShadowQuestion({ ...base, role: 'athlete', question: 'athlete:ath-9:what should i eat?' });
  const input = create.mock.calls[0][0];
  // Its own entity type, which the create route refuses to a caller, and a
  // hashed key: staff text cannot reproduce either.
  expect(input.sourceEntityType).toBe('shadow_asker_question');
  expect(input.sourceEntityId.startsWith('acct:acct-1:')).toBe(true);
});

test('a coach filing keeps the staff entity type and the plain key', async () => {
  await fileUnansweredShadowQuestion({ ...base, role: 'coach' });
  const input = create.mock.calls[0][0];
  expect(input.sourceEntityType).toBe('shadow_question');
  expect(input.sourceEntityId).toBe('what should i eat?');
});

test('two long questions sharing a 500 character prefix do not collapse', async () => {
  const prefix = 'x'.repeat(600);
  await fileUnansweredShadowQuestion({ ...base, role: 'athlete', question: `${prefix} one` });
  await fileUnansweredShadowQuestion({ ...base, role: 'athlete', question: `${prefix} two` });
  expect(create.mock.calls[0][0].sourceEntityId).not.toBe(create.mock.calls[1][0].sourceEntityId);
});

describe('mayFileUnansweredQuestion: a flagged exchange is never copied to the research feed', () => {
  const served: UnansweredFilingFacts = {
    state: 'ok',
    requiresHumanReview: false,
    hasHandoff: false,
    responseFiltered: false,
    responseRequiresHumanReview: false,
    responseReasonCount: 0,
    responseAltered: false,
    requestHighRisk: false,
    requestFlagged: false,
    requestRiskOwed: false,
  };

  test('a normally served, unflagged answer may be filed', () => {
    expect(mayFileUnansweredQuestion(served)).toBe(true);
  });

  test.each([
    ['state is not ok', { state: 'filtered' }],
    ['state is degraded', { state: 'degraded' }],
    ['a human review is required', { requiresHumanReview: true }],
    ['a handoff is attached', { hasHandoff: true }],
    ['the response filter filtered it', { responseFiltered: true }],
    ['the response asked for human review', { responseRequiresHumanReview: true }],
    ['a response rule fired', { responseReasonCount: 1 }],
    ['the shown text was rewritten', { responseAltered: true }],
    ['the request was high risk', { requestHighRisk: true }],
    ['the request carried a classification or topic', { requestFlagged: true }],
    ['a request-risk review is owed', { requestRiskOwed: true }],
  ] as Array<[string, Partial<UnansweredFilingFacts>]>)('is refused when %s', (_label, change) => {
    expect(mayFileUnansweredQuestion({ ...served, ...change })).toBe(false);
  });
});

test.each(['staff', 'volunteer', 'platform_owner', 'board'] as const)('a %s is not auto-filed for and is never told one was', async (role) => {
  expect(await fileUnansweredShadowQuestion({ ...base, role: role as never })).toBe(false);
  expect(create).not.toHaveBeenCalled();
});

test.each(['athlete', 'parent', 'coach', 'admin', 'organization_admin'] as const)('a %s is filed for', async (role) => {
  expect(await fileUnansweredShadowQuestion({ ...base, role })).toBe(true);
  expect(create).toHaveBeenCalledTimes(1);
});

test('the whole question up to the chat store limit is stored and hashed', async () => {
  const long = 'a'.repeat(11_000);
  await fileUnansweredShadowQuestion({ ...base, role: 'athlete', question: `${long} one` });
  await fileUnansweredShadowQuestion({ ...base, role: 'athlete', question: `${long} two` });
  expect(create.mock.calls[0][0].researchRequirement.length).toBe(11_004);
  expect(create.mock.calls[0][0].sourceEntityId).not.toBe(create.mock.calls[1][0].sourceEntityId);
});

test('a question over the chat store limit is cut at it, as the conversation store does', async () => {
  await fileUnansweredShadowQuestion({ ...base, role: 'athlete', question: 'b'.repeat(13_000) });
  expect(create.mock.calls[0][0].researchRequirement.length).toBe(12_000);
});

test('two staff questions sharing their first 500 characters make two rows, not one', async () => {
  const prefix = 'c'.repeat(600);
  await fileUnansweredShadowQuestion({ ...base, role: 'coach', question: `${prefix} one` });
  await fileUnansweredShadowQuestion({ ...base, role: 'coach', question: `${prefix} two` });
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[0][0].sourceEntityId).not.toBe(create.mock.calls[1][0].sourceEntityId);
});

test('the staff key is the one the page button computes (one shared function)', async () => {
  const { researchQuestionKey } = jest.requireActual('@/src/shared/researchQuestionKey');
  await fileUnansweredShadowQuestion({ ...base, role: 'coach', question: 'How long should a round be?', athleteId: 'ath-9' });
  expect(create.mock.calls[0][0].sourceEntityId).toBe(researchQuestionKey('How long should a round be?', 'ath-9'));
});
