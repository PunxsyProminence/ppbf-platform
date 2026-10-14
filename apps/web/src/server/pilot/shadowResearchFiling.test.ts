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
  expect(input.sourceEntityId).toBe('acct:acct-1:what should i eat?');
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

test('a non-staff question cannot pre-claim a coach athlete-scoped key', async () => {
  await fileUnansweredShadowQuestion({ ...base, role: 'athlete', question: 'athlete:ath-9:what should i eat?' });
  expect(create.mock.calls[0][0].sourceEntityId.startsWith('acct:acct-1:')).toBe(true);
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
