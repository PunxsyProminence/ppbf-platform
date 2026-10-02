import { readFileSync } from 'fs';
import { join } from 'path';

import { NextRequest } from 'next/server';

import { POST, resolveShadowMaxCompletionTokens } from './route';
import { query } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { retrieveShadowContext, SHADOW_SAFE_FILTERED_RESPONSE } from '@/src/server/pilot/shadowChat';
import { getOrCreateShadowUserProfile, updateShadowUserProfile } from '@/src/server/pilot/shadowUserProfile';
import { getAzureAiRuntimeConfig, buildAzureAiChatCompletionsUrl } from '@/src/server/pilot/azureAiRuntime';
import { evaluateShadowUnlockState } from '@/src/server/pilot/shadowUnlocks';
import {
  appendConversationExchange,
  appendUserMessage,
  assertConversationAccess,
  loadConversationMessages,
  queueHumanReview,
  resolveConversation,
} from '@/src/server/pilot/shadowConversations';
import {
  consumeShadowReviewSlot,
  enforceShadowRateLimit,
  refundShadowRateLimit,
  resolveShadowReviewBucket,
  ShadowRateLimitExceeded,
  type ShadowRateLimitReceipt,
} from '@/src/server/pilot/shadowRateLimit';
import { classifyRequest } from '@/src/server/pilot/shadowClassifier';
import { executeHeavyBagAsync, executeHeavyBagSync } from '@/src/server/pilot/shadowHeavyBag';
import { isShadowWorkerEnabled } from '@/src/server/pilot/shadowJobWorker';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { hasRetrievableLibraryEvidence, retrieveShadowEvidenceBundle } from '@/src/server/pilot/shadowEvidence';
import { getBoardSummary } from '@/src/server/pilot/boardSummary';
import { getGrowthMetrics } from '@/src/server/pilot/shadowMetrics';
import {
  PLATFORM_SCOPE_UNAVAILABLE_CONTEXT,
  clearPlatformRollupCache,
  platformGymEvidenceId,
} from '@/src/server/pilot/omegaPlatformContext';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { ShadowRuntimeUnavailableError } from '@/src/server/pilot/shadowRuntimeError';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => ({
  requireRole: jest.fn(),
  assertActorCanAccessAthlete: jest.fn(),
}));

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  sanitizedSqlState: jest.fn(() => undefined),
}));

jest.mock('@/src/server/pilot/shadowReadiness', () => ({
  assertShadowRuntimeReadiness: jest.fn(),
}));

jest.mock('@/src/server/pilot/shadowChat', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowChat');
  return { ...actual, retrieveShadowContext: jest.fn() };
});

jest.mock('@/src/server/pilot/shadowUserProfile', () => ({
  getOrCreateShadowUserProfile: jest.fn(),
  updateShadowUserProfile: jest.fn(),
}));

jest.mock('@/src/server/pilot/shadowClassifier', () => ({
  classifyRequest: jest.fn(() => ({
    tier: 'quick_round',
    complexity: 0.2,
    topic: 'general',
  })),
}));

jest.mock('@/src/server/pilot/shadowContextBuilder', () => ({
  buildShadowContext: jest.fn(() => ({
    context: 'Tier context for this authenticated user.',
    metadata: {
      tier: 'quick_round',
      topicType: 'general',
      contextItemCount: 1,
      totalWeight: 1,
      includesAthleteData: false,
      includesResearchRequirements: false,
    },
  })),
}));

// The two tier<->sessionType mappings are pure and total, and the route now
// relies on them round-tripping (audit F1), so they mirror the real
// implementations rather than returning a fixed value. tierToSessionType used
// to be stubbed to 'quick_round' for every input, which meant no test could
// have caught a tier/session-type disagreement.
jest.mock('@/src/server/pilot/shadowRouter', () => ({
  describeDeployment: jest.fn((name: string) => name),
  tierToSessionType: jest.fn((tier: string) => (tier === 'heavy_bag' ? 'heavy_bag' : 'quick_round')),
  sessionTypeToTier: jest.fn((sessionType: string) => (
    sessionType === 'heavy_bag' ? 'heavy_bag' : sessionType === 'quick_round' ? 'quick_round' : null
  )),
  isAsyncSession: jest.fn(() => false),
}));

jest.mock('@/src/server/pilot/shadowProfiling', () => ({
  classifyProfileTier: jest.fn(() => ({
    tier: 'bronze',
    config: { label: 'Bronze' },
  })),
  buildPersonalizationPrompt: jest.fn(() => ''),
}));

jest.mock('@/src/server/pilot/shadowHeavyBag', () => ({
  executeHeavyBagSync: jest.fn(),
  executeHeavyBagAsync: jest.fn(),
  shouldRunAsync: jest.fn(() => false),
}));

// Default false: every pre-worker test runs against the worker-disabled
// behavior it was written for. The queued-path tests flip it explicitly.
jest.mock('@/src/server/pilot/shadowJobWorker', () => ({
  isShadowWorkerEnabled: jest.fn(() => false),
}));

jest.mock('@/src/server/pilot/shadowUnlocks', () => ({
  evaluateShadowUnlockState: jest.fn(),
  isFeatureEnabled: jest.fn(() => false),
  buildShadowUnlockHints: jest.fn(() => undefined),
}));

jest.mock('@/src/server/pilot/azureAiRuntime', () => ({
  getAzureAiRuntimeConfig: jest.fn(),
  buildAzureAiChatCompletionsUrl: jest.fn(),
}));

jest.mock('@/src/server/pilot/shadowConversations', () => ({
  resolveConversation: jest.fn(),
  appendConversationExchange: jest.fn(),
  appendUserMessage: jest.fn(),
  assertConversationAccess: jest.fn(),
  loadConversationMessages: jest.fn(),
  queueHumanReview: jest.fn(),
}));

// Only the enforcer is mocked. resolveShadowRateLimit and shadowRateLimitMessage
// are pure and stay REAL, so the limits asserted below are the limits the route
// actually applies -- a hand-written stub here would let the two drift apart.
jest.mock('@/src/server/pilot/shadowRateLimit', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowRateLimit');
  return {
    ...actual,
    enforceShadowRateLimit: jest.fn(),
    consumeShadowReviewSlot: jest.fn(),
    refundShadowRateLimit: jest.fn(),
  };
});

// The rollup's two leaf data sources. omegaPlatformContext itself is left REAL
// so these tests exercise the actual wiring -- trigger, render, evidence
// authorization -- rather than asserting that a mock was called.
jest.mock('@/src/server/pilot/boardSummary', () => ({ getBoardSummary: jest.fn() }));
jest.mock('@/src/server/pilot/shadowMetrics', () => ({ getGrowthMetrics: jest.fn() }));

jest.mock('@/src/server/pilot/shadowEvidence', () => ({
  retrieveShadowEvidenceBundle: jest.fn(),
  // Defaults to true: "the Library has evidence, this question just did not match
  // any of it". That is the ordinary case, and the case every test written before
  // the empty-Library split assumed -- an unsourced answer is served and labelled,
  // not refused. The refusal path stubs this false explicitly.
  hasRetrievableLibraryEvidence: jest.fn(async () => true),
  unavailableShadowEvidenceBundle: jest.fn(() => ({
    bundleId: null,
    availability: 'unavailable',
    items: [],
    allowedEvidenceIds: [],
    context: 'EVIDENCE UNAVAILABLE',
  })),
  publicEvidenceCitations: jest.fn((
    bundle: { items: Array<{
      evidenceId: string;
      token: string;
      sourceTitle: string;
      documentName: string;
    }> },
    citationIds: string[],
  ) => bundle.items
    .filter((item: { evidenceId: string }) => citationIds.includes(item.evidenceId))
    .map((item: {
      evidenceId: string;
      token: string;
      sourceTitle: string;
      documentName: string;
    }) => ({
      evidenceId: item.evidenceId,
      token: item.token,
      sourceTitle: item.sourceTitle,
      documentName: item.documentName,
    }))),
  citedEvidenceQuality: jest.fn((
    bundle: { items: Array<{ evidenceId: string }> },
    citationIds: string[],
  ) => bundle.items.filter((item) => citationIds.includes(item.evidenceId))),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockQuery = jest.mocked(query);
const mockRetrieveShadowContext = jest.mocked(retrieveShadowContext);
const mockGetProfile = jest.mocked(getOrCreateShadowUserProfile);
const mockUpdateProfile = jest.mocked(updateShadowUserProfile);
const mockGetRuntime = jest.mocked(getAzureAiRuntimeConfig);
const mockBuildUrl = jest.mocked(buildAzureAiChatCompletionsUrl);
const mockEvaluateUnlocks = jest.mocked(evaluateShadowUnlockState);
const mockResolveConversation = jest.mocked(resolveConversation);
const mockAppendConversationExchange = jest.mocked(appendConversationExchange);
const mockAppendUserMessage = jest.mocked(appendUserMessage);
const mockLoadConversationMessages = jest.mocked(loadConversationMessages);
const mockQueueHumanReview = jest.mocked(queueHumanReview);
const mockEnforceRateLimit = jest.mocked(enforceShadowRateLimit);
const mockConsumeReviewSlot = jest.mocked(consumeShadowReviewSlot);
const mockRefundRateLimit = jest.mocked(refundShadowRateLimit);
// The receipt the limiter hands back for a review slot in these tests.
const SAFETY_REVIEW_RECEIPT: ShadowRateLimitReceipt = {
  organizationId: 'org-session',
  accountId: 'account-1',
  endpointKey: 'safety_review',
  windowSeconds: 3_600,
  windowStartedAtEpochSeconds: 1_790_000_400,
};
const mockClassifyRequest = jest.mocked(classifyRequest);
const mockExecuteHeavyBagSync = jest.mocked(executeHeavyBagSync);
const mockExecuteHeavyBagAsync = jest.mocked(executeHeavyBagAsync);
const mockIsShadowWorkerEnabled = jest.mocked(isShadowWorkerEnabled);
const mockRetrieveEvidence = jest.mocked(retrieveShadowEvidenceBundle);
const mockHasRetrievableEvidence = jest.mocked(hasRetrievableLibraryEvidence);
const mockBoardSummary = jest.mocked(getBoardSummary);
const mockGrowthMetrics = jest.mocked(getGrowthMetrics);
const originalFetch = global.fetch;

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'account-1',
    role: 'coach',
    organizationId: 'org-session',
    athleteId: null,
    sessionToken: 'session-token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function postRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pilot/shadow/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockQuery.mockResolvedValue([]);
  mockRetrieveShadowContext.mockResolvedValue({
    authorized: true,
    context: 'Authorized role: coach. Authorized organization scope: org-session.',
  });
  mockGetProfile.mockResolvedValue({} as never);
  mockUpdateProfile.mockResolvedValue(undefined);
  mockEvaluateUnlocks.mockResolvedValue(null as never);
  mockResolveConversation.mockResolvedValue('conversation-1');
  mockAppendConversationExchange.mockResolvedValue('assistant-message-1');
  mockLoadConversationMessages.mockResolvedValue([]);
  mockQueueHumanReview.mockResolvedValue('review-1');
  mockEnforceRateLimit.mockResolvedValue(undefined);
  mockConsumeReviewSlot.mockResolvedValue(SAFETY_REVIEW_RECEIPT);
  mockRefundRateLimit.mockResolvedValue(true);
  mockHasRetrievableEvidence.mockResolvedValue(true);
  mockRetrieveEvidence.mockResolvedValue({
    bundleId: '00000000-0000-4000-8000-000000000200',
    availability: 'unavailable',
    items: [],
    allowedEvidenceIds: [],
    context: 'EVIDENCE UNAVAILABLE — no approved, verified, fully indexed evidence.',
  });
  mockGetRuntime.mockReturnValue({
    ok: true,
    missing: [],
    config: {
      endpoint: 'https://example.invalid',
      apiKey: 'test-key',
      deploymentName: 'test-deployment',
      apiVersion: '2024-12-01-preview',
    },
  });
  mockBuildUrl.mockReturnValue('https://example.invalid/chat/completions');
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Normalisation is for MATCHING ONLY
//
// normaliseForMatching folds a curly apostrophe so the safety classifier sees
// "can't" where the athlete typed "can\u2019t". What must NOT happen is the
// folded text becoming the record: the message sent to the model and the
// message written to the conversation have to stay what they typed. Those two
// are what the first test reads. (The response body is not read for the typed
// text: the route does not echo the user's message back.)
//
// THE FIRST TWO TESTS ARE TWO, NOT ONE, AND THE REASON IS THE FIX ITSELF. A curly-quote
// EMERGENCY report does not reach the model today: route.ts returns the
// safeguarding response first, which is the behaviour this hotfix restores.
// So preservation is shown on a message that DOES reach the model, and the
// second test shows, on an emergency report, that the curly spelling and the
// straight one take the route through the same nine observed outcomes.
// ---------------------------------------------------------------------------
describe('the athlete\'s own words survive normalisation', () => {
  // Contains a curly apostrophe, which the fold rewrites, AND a doubled
  // space, which it does not: an earlier version collapsed whitespace, and
  // the doubled space is kept so that a collapse coming back would show up
  // in the record. Deliberately benign: it has to reach the provider.
  const TYPED = 'I can\u2019t decide which glove size  suits me';

  test('a curly-quote message reaches the model and the conversation exactly as typed', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Twelve ounce for bag work.' } }] }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const response = await POST(postRequest({ message: TYPED }));
    expect(response.status).toBe(200);

    // 1. THE PROVIDER. The outbound request body must carry the typed string,
    //    not the folded one. Read out of the actual fetch call rather than a
    //    helper, so a change in how the body is assembled cannot hide it.
    expect(fetchSpy).toHaveBeenCalled();
    const sentBody = String((fetchSpy.mock.calls[0]?.[1] as { body?: unknown })?.body ?? '');
    expect(sentBody).toContain(JSON.stringify(TYPED).slice(1, -1));
    expect(sentBody).not.toContain("I can't decide");
    expect(sentBody).not.toContain('glove size suits me');

    // 2. THE CONVERSATION. What is persisted is the record, and it is the
    //    half a reader would most reasonably assume and least likely check.
    expect(mockAppendConversationExchange).toHaveBeenCalledWith(
      expect.objectContaining({ userMessage: TYPED }),
    );
  });

  // EQUIVALENCE, NOT TODAY'S OUTCOME.
  //
  // This asserted status 400 and that the provider was never called. Both are
  // true today and both are expected to stop being true: #1036 is to replace
  // the refusal with a real answer, so a test pinned to the refusal
  // would fail on a change that is not a regression, and someone would
  // "fix" it by deleting it.
  //
  // What this hotfix actually claims is narrower and permanent: a curly
  // apostrophe must make NO DIFFERENCE. So the two spellings are run through
  // the real route and compared to each other. Whatever the path becomes,
  // they must do the same thing -- and if they ever diverge again, this fails
  // without needing to know what the right answer is.
  test('an emergency report takes the route to the same nine outcomes with a curly apostrophe as with a straight one', async () => {
    const run = async (message: string) => {
      jest.clearAllMocks();
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as unknown as typeof fetch;

      const response = await POST(postRequest({ message }));
      const body = await response.json();

      return {
        status: response.status,
        state: body.state,
        requiresHumanReview: body.requiresHumanReview,
        highRiskTopic: body.highRiskTopic,
        filtered: body.filtered,
        providerCalled: fetchSpy.mock.calls.length > 0,
        reviewQueued: mockQueueHumanReview.mock.calls.length > 0,
        reviewSeverity: (mockQueueHumanReview.mock.calls[0]?.[0] as { severity?: string })?.severity,
        reviewCategory: (mockQueueHumanReview.mock.calls[0]?.[0] as { category?: string })?.category,
      };
    };

    const straight = await run("I can't breathe after that hit");
    const curly = await run('I can\u2019t breathe after that hit');

    expect(curly).toEqual(straight);

    // One floor, so the comparison cannot pass by both sides being nothing:
    // this message must reach the safety machinery on SOME path, whichever
    // one that turns out to be.
    expect(straight.reviewQueued).toBe(true);
  });

  // THE ROUTE'S HALF, BY VALUE.
  //
  // The equivalence test above compares the curly spelling with the straight
  // one, so anything that changes both alike gets past it: take
  // 'urgent_personal_symptom' out of the route's critical list and both
  // become 'high' and stay equal. The classifier's guard cannot see that
  // either -- its critical list is a copy. So the severity the review row is
  // actually queued at is pinned here, on the phone-typed report.
  //
  // Only the review row is asserted, not the status or whether the provider
  // was called: #1036 is to replace the refusal with an answer and keep the
  // row.
  test('a phone-typed emergency report is queued for a human at severity critical', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;

    await POST(postRequest({ message: 'I can\u{2019}t breathe after that hit' }));

    expect(mockQueueHumanReview).toHaveBeenCalledTimes(1);
    expect(mockQueueHumanReview.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      severity: 'critical',
      category: 'urgent_symptom',
      metadata: expect.objectContaining({ validationClassification: 'urgent_personal_symptom' }),
    }));
  });

  // WHAT REACHES THE CLASSIFIER IS WHAT WAS TYPED, TRIMMED.
  //
  // The route trims the message (as it does on main) and hands it to
  // validateShadowRequest. Anything else done to it on the way -- normalised,
  // truncated, spaces collapsed, invisible characters stripped -- changes
  // what the classifier's patterns see without touching the classifier, and
  // none of the classifier's own guards would notice.
  //
  // So the text of route.ts is checked for two things: it contains exactly
  // one `validateShadowRequest(...)`, spelled with `message` as its first
  // argument, and exactly one declaration of `message`, as a const equal to
  // the trimmed raw message.
  //
  // THIS IS A CHECK OF TEXT, AND A NARROW ONE. It catches the edit made in
  // the obvious place, at the call or at the declaration. It does not catch
  // the raw message being altered before it is trimmed, the validator being
  // called through an alias or a wrapper, a `message` re-declared by
  // destructuring in an inner scope, or the verdict being overridden after
  // the call. Those are not covered by any test here.
  test('route.ts spells one call, validateShadowRequest(message, ...), and declares message once, as the trimmed raw message', () => {
    const source = readFileSync(join(__dirname, 'route.ts'), 'utf8');

    expect(source.match(/validateShadowRequest\([^)]*\)/g)).toEqual([
      'validateShadowRequest(message, userRole, organizationId)',
    ]);
    // A const, so it cannot be assigned again.
    expect(source.match(/\b(?:const|let|var)\s+message\b[^;]*;/g)).toEqual(['const message = rawMessage.trim();']);
  });

  // The same thing, run, for the one kind of tidying that has a sentence to
  // show it. This message is an emergency BECAUSE of its doubled space: with
  // one space it contains main's weight-cut phrase and takes the medication
  // return instead, which sits above the emergency one (a pre-existing
  // ordering flaw, moved to #1036). A route that collapsed runs of spaces
  // before classifying would show here as the emergency classification going
  // missing. Other kinds of tidying would not show here.
  test('a doubled space is not collapsed on the way to the classifier', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;

    const response = await POST(postRequest({ message: 'I can\u{2019}t breathe and I need to lose weight  quickly' }));
    const body = await response.json();

    expect(body.response).toBe('Potential emergency: stop participation and contact local emergency services or an onsite licensed medical professional now.');
    expect(mockQueueHumanReview.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      severity: 'critical',
      metadata: expect.objectContaining({ validationClassification: 'urgent_personal_symptom' }),
    }));
  });
});

// ---------------------------------------------------------------------------
// AN ALLOWED QUESTION THAT NAMES KO'D: ANSWERED, AND A HUMAN IS TOLD.
//
// Some messages are ALLOWED by the classifier: those with an educational
// framing word ("what is", "research", "understand" ...) and no first-person
// or "now" word. That is a test of wording, not of who is asking: a
// first-hand account written without "I" or "my" passes it.
//
// What the route does with an allowed message depends on its
// classification. For concussion, weight_cutting, return_to_play and
// medical_clearance it answers with a stock line and does not call the
// model. For anything else, loss_of_consciousness included, it goes on to
// generate an answer.
//
// The classifier's topic is the first row that matches, and
// loss_of_consciousness is listed above weight_cutting, return_to_play and
// medical_clearance (and below concussion). Its pattern matches "KO'd", for
// the ASCII apostrophe and, since #1049, for twelve look-alikes. So a
// question about return to play after being KO'd is a loss_of_consciousness
// question and is answered by the model.
//
// WHAT USED TO BE TRUE, AND IS NOT NOW. Until the human-review foundation
// (the first replacement for #1036), that answered question left no review
// row: the stock-line topics queued one and this did not, so for a knockout
// question nobody was told. #1049 pinned that as it stood, and recorded it as
// main's gap. Every high-risk message now leaves one row, answered or not
// (OD-2026-09-30-006, selection 5: "Everything high-risk, as now"), so these
// tests now say: the model answers, and a review row is written.
//
// Still open, and the classifier piece's to close: a first-hand account
// written without "I" or "my" is still classed educational, so it is still
// answered like a question rather than handled as a report. It does now reach
// a human.
// ---------------------------------------------------------------------------
describe('an allowed question that names KO\'d', () => {
  const ask = async (message: string) => {
    jest.clearAllMocks();
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Protocols vary by governing body.' } }] }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const response = await POST(postRequest({ message }));
    const body = await response.json();

    return {
      state: body.state,
      providerCalled: fetchSpy.mock.calls.length > 0,
      reviewQueued: mockQueueHumanReview.mock.calls.length > 0,
    };
  };
  const MODEL_AND_REVIEW = { state: 'ok', providerCalled: true, reviewQueued: true };
  const STOCK_LINE_AND_REVIEW = { state: 'filtered', providerCalled: false, reviewQueued: true };

  test.each([
    ['the ASCII apostrophe', "ko'd"],
    ['U+2019', 'ko\u{2019}d'],
    ['U+2018', 'ko\u{2018}d'],
    ['a backtick', 'ko`d'],
  ])('is answered by the model, and a review row is written: %s', async (_name, ko) => {
    expect(await ask(`What does research say about return to play after being ${ko}`)).toEqual(MODEL_AND_REVIEW);
  });

  // A first-hand account with no first-person word is still "educational" to
  // the classifier, so it is still answered by the model. It now leaves a row.
  test.each([
    ['the ASCII apostrophe', "ko'd"],
    ['a backtick', 'ko`d'],
  ])('a first-hand account with no first-person word is answered the same way, and a review row is written: %s', async (_name, ko) => {
    expect(await ask(`Got ${ko} in sparring last night and still feel off. What is the return to play protocol`)).toEqual(MODEL_AND_REVIEW);
  });

  // The controls: without the word, and with a quote look-alike in place of
  // the apostrophe, the same question takes the stock line.
  test.each([
    ['without "KO\'d"', 'knocked down'],
    ['with a curly double quote where the apostrophe would be', 'ko\u{201C}d'],
  ])('CONTROL: %s the same question gets the stock line and a review row', async (_name, ko) => {
    expect(await ask(`What does research say about return to play after being ${ko}`)).toEqual(STOCK_LINE_AND_REVIEW);
  });
});

// ---------------------------------------------------------------------------
// EVERY AUTHORIZED HIGH-RISK REQUEST IS OWED ONE BOUNDED HUMAN-REVIEW ROW.
//
// The first replacement for #1036. Three classes of row reach the queue from
// this route: REQUEST-RISK (the request was high-risk), RESPONSE-SAFETY (a
// generated answer was withheld or asked for review) and the OPERATIONAL
// empty-Library row. All three are bounded: critical request reviews by one
// bucket, every other row by the second (OD-2026-10-01-006).
//
// What anyone is told changes in ONE way: a request that already has its
// request-risk row is no longer failed (500) because a second row, about the
// answer, could not be inserted. Everything else is as on main. Where a
// response body is asserted, it is compared with the SAME request made while
// the review machinery is in a different state, or (for the refusals) with a
// benign request refused the same way, or with a literal.
//
// The limiter is mocked at its two calls (consumeShadowReviewSlot,
// refundShadowRateLimit). WHICH bucket an event draws on is the real
// resolveShadowReviewBucket, applied here to the event the route passed.
// What those calls do to a real bucket row is
// shadowRateLimitRefund.pg.test.ts's subject, against a real database.
// ---------------------------------------------------------------------------
describe('every authorized high-risk request is owed one bounded human-review row', () => {
  const ALLOWED_HIGH_RISK = "What does research say about return to play after being ko'd";
  const WITHHELD = 'I cannot breathe after that hit';
  const STOCK_LINE = 'What is a concussion?';
  const BENIGN = 'What is a good warm-up for footwork drills?';
  const REQUEST_RISK_SUMMARY = 'A high-risk SHADOW chat request was flagged for human review.';
  const RESPONSE_SAFETY_SUMMARY = 'A generated SHADOW response was replaced by the post-generation safety boundary.';
  const WITHHELD_SUMMARY = 'A SHADOW chat request was withheld by the pre-generation safety boundary.';
  const DIAGNOSING_ANSWER = 'You have a concussion and should take 400mg of ibuprofen.';
  const summaries = () => mockQueueHumanReview.mock.calls.map(([ticket]) => ticket.summary);
  const spent = (bucket: string) => new ShadowRateLimitExceeded(1800, bucket);

  const modelAnswers = (content = 'Protocols vary by governing body.') => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;
    return fetchSpy;
  };
  const send = async (body: Record<string, unknown>) => {
    const response = await POST(postRequest(body));
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  /** The parts of a response body that are what the person is told; ids and timestamps are per-request. */
  const told = (body: Record<string, unknown>) => {
    const { messageId: _messageId, createdAt: _createdAt, ...rest } = body;
    void _messageId; void _createdAt;
    return rest;
  };
  /** The bucket each slot request drew on, in order: the real resolver applied to the event the route passed. */
  const bucketsAsked = () => mockConsumeReviewSlot.mock.calls.map(([input]) => {
    expect(input).toEqual({ organizationId: 'org-session', accountId: 'account-1', event: input.event });
    return resolveShadowReviewBucket(input.event);
  });

  // Several tests arm a mock for good (mockRejectedValue, mockImplementation,
  // mockReturnValue), and a ...Once left unconsumed would be served to the
  // next test. jest.clearAllMocks removes neither. Everything armed in this
  // describe is reset here; the top-level beforeEach re-arms the defaults.
  afterEach(() => {
    for (const mock of [
      mockQueueHumanReview, mockConsumeReviewSlot, mockRefundRateLimit, mockEnforceRateLimit,
      mockRetrieveShadowContext, mockIsShadowWorkerEnabled, mockExecuteHeavyBagAsync, mockAppendUserMessage,
      mockHasRetrievableEvidence,
      jest.mocked(assertActorCanAccessAthlete), jest.mocked(assertConversationAccess),
      jest.mocked(assertShadowRuntimeReadiness),
    ]) {
      mock.mockReset();
    }
  });

  describe('which rows, and what they say', () => {
    test('an allowed high-risk question: the model answers, and exactly one row is written, naming the stored conversation and message', async () => {
      const fetchSpy = modelAnswers();

      const { status, body } = await send({ message: ALLOWED_HIGH_RISK });

      expect(status).toBe(200);
      expect(body.state).toBe('ok');
      expect(fetchSpy).toHaveBeenCalled();
      // ONE row, though two writers could have produced it: the write after
      // the message is stored, and POST's write at the exit.
      expect(mockQueueHumanReview).toHaveBeenCalledTimes(1);
      expect(mockQueueHumanReview.mock.calls[0]?.[0]).toEqual({
        organizationId: 'org-session',
        accountId: 'account-1',
        conversationId: 'conversation-1',
        category: 'loss_of_consciousness',
        severity: 'critical',
        summary: REQUEST_RISK_SUMMARY,
        metadata: {
          sessionType: body.sessionType,
          athleteScoped: false,
          validationClassification: 'loss_of_consciousness',
          assistantMessageId: 'assistant-message-1',
        },
      });
      // A critical request review: the critical bucket, one slot.
      expect(bucketsAsked()).toEqual(['safety_review_critical']);
      expect(mockRefundRateLimit).not.toHaveBeenCalled();
    });

    test('what the person is told is the same whether or not the row is written', async () => {
      // Four states of the review machinery, one request. The body must not move.
      modelAnswers();
      const written = await send({ message: ALLOWED_HIGH_RISK });

      jest.clearAllMocks();
      modelAnswers();
      mockConsumeReviewSlot.mockRejectedValueOnce(spent('safety_review_critical'));
      const suppressed = await send({ message: ALLOWED_HIGH_RISK });
      expect(mockQueueHumanReview).not.toHaveBeenCalled();

      jest.clearAllMocks();
      modelAnswers();
      mockQueueHumanReview.mockRejectedValueOnce(new Error('insert failed'));
      const insertFailed = await send({ message: ALLOWED_HIGH_RISK });
      // One attempt, and POST's exit write does not make a second.
      expect(mockQueueHumanReview).toHaveBeenCalledTimes(1);

      jest.clearAllMocks();
      modelAnswers();
      mockConsumeReviewSlot.mockRejectedValueOnce(new Error('bucket storage unavailable'));
      const limiterDown = await send({ message: ALLOWED_HIGH_RISK });
      expect(mockQueueHumanReview).toHaveBeenCalledTimes(1);

      for (const other of [suppressed, insertFailed, limiterDown]) {
        expect(other.status).toBe(written.status);
        expect(told(other.body)).toEqual(told(written.body));
      }
      // An ordinary answer, not flagged in the body.
      expect(told(written.body)).toEqual(expect.objectContaining({
        success: true,
        state: 'ok',
        response: 'Protocols vary by governing body.',
        filtered: false,
        requiresHumanReview: false,
        highRiskTopic: 'loss_of_consciousness',
      }));
    });

    test('a withheld request: main\'s refusal and main\'s ticket, one row, under the critical bucket', async () => {
      const fetchSpy = modelAnswers(DIAGNOSING_ANSWER);

      const { status, body } = await send({ message: WITHHELD });

      expect(status).toBe(400);
      expect(body.response).toBe('Potential emergency: stop participation and contact local emergency services or an onsite licensed medical professional now.');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockQueueHumanReview).toHaveBeenCalledTimes(1);
      // Field for field the ticket main writes for a withheld request.
      expect(mockQueueHumanReview.mock.calls[0]?.[0]).toEqual({
        organizationId: 'org-session',
        accountId: 'account-1',
        conversationId: undefined,
        category: 'urgent_symptom',
        severity: 'critical',
        summary: WITHHELD_SUMMARY,
        metadata: {
          sessionType: 'quick_round',
          athleteScoped: false,
          validationClassification: 'urgent_personal_symptom',
        },
      });
      expect(bucketsAsked()).toEqual(['safety_review_critical']);
    });

    // THE FIXED FALLBACK LINE. For concussion, weight_cutting, return_to_play
    // and medical_clearance the route answers with a fixed line and never
    // calls the model. Main filed that under "a generated response was
    // replaced by the post-generation safety boundary", which nothing
    // generated and nothing replaced. It is a request-risk event, exactly one
    // row -- and it keeps everything main's row carried.
    test('the fixed fallback line: one request-risk row, with every field main\'s row had', async () => {
      const fetchSpy = modelAnswers();

      const { body } = await send({ message: STOCK_LINE });

      expect(body.state).toBe('filtered');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockQueueHumanReview).toHaveBeenCalledTimes(1);
      const [ticket] = mockQueueHumanReview.mock.calls[0];
      expect(ticket).toEqual({
        organizationId: 'org-session',
        accountId: 'account-1',
        // main's row: the conversation the exchange was stored in ...
        conversationId: 'conversation-1',
        category: 'concussion',
        severity: 'high',
        summary: REQUEST_RISK_SUMMARY,
        metadata: {
          // ... the stored assistant message, and the rest of main's metadata ...
          assistantMessageId: 'assistant-message-1',
          sessionType: body.sessionType,
          athleteScoped: false,
          safetyReasons: expect.any(Array),
          // ... plus the one key every request-risk row has.
          validationClassification: 'concussion',
        },
      });
      // Not a critical request: the general bucket.
      expect(bucketsAsked()).toEqual(['safety_review']);
    });

    // TWO KINDS OF EVENT. The request was high-risk: one row. The answer the
    // model generated was replaced by the response validation: another row,
    // because that is a fact about what the model wrote and a reviewer needs
    // it whatever the request was. Neither is skipped for the other. This
    // request is a critical one, so the two rows draw on different buckets;
    // behind a non-critical request both would draw on the general one.
    test('a high-risk question whose GENERATED answer is replaced: two rows, one of each kind, from two buckets', async () => {
      const fetchSpy = modelAnswers(DIAGNOSING_ANSWER);

      const { body } = await send({ message: ALLOWED_HIGH_RISK });

      expect(fetchSpy).toHaveBeenCalled();
      expect(body.state).toBe('filtered');
      expect(summaries()).toEqual([REQUEST_RISK_SUMMARY, RESPONSE_SAFETY_SUMMARY]);
      const [requestEvent, responseEvent] = mockQueueHumanReview.mock.calls.map(([ticket]) => ticket);
      // The response event says which answer and why; the request event says what was asked about.
      expect(responseEvent.metadata).toEqual(expect.objectContaining({ assistantMessageId: 'assistant-message-1' }));
      expect(Array.isArray((responseEvent.metadata as Record<string, unknown>).safetyReasons)).toBe(true);
      expect(responseEvent.metadata).not.toHaveProperty('validationClassification');
      expect(requestEvent.metadata).toEqual(expect.objectContaining({ validationClassification: 'loss_of_consciousness' }));
      expect(requestEvent.metadata).not.toHaveProperty('safetyReasons');
      // The critical request review does not spend the allowance the
      // generated-answer review draws on, and the other way round.
      expect(mockConsumeReviewSlot.mock.calls.map(([input]) => input.event.kind)).toEqual(['request_risk', 'response_safety']);
      expect(bucketsAsked()).toEqual(['safety_review_critical', 'safety_review']);
    });

    // Not replaced, and still a response-safety event: the validation let
    // the answer through and asked for a human look.
    test('a generated answer that is NOT replaced but asks for review writes the response-safety row', async () => {
      modelAnswers('A licensed physician should evaluate readiness before the next bout. RESEARCH NEEDED.');

      const { body } = await send({ message: BENIGN });

      expect(body.state).toBe('ok');
      expect(body.requiresHumanReview).toBe(true);
      expect(summaries()).toEqual([RESPONSE_SAFETY_SUMMARY]);
      expect(mockConsumeReviewSlot.mock.calls.map(([input]) => input.event.kind)).toEqual(['response_safety']);
    });

    test.each([
      ['the request-risk slot', 0, [RESPONSE_SAFETY_SUMMARY]],
      ['the response-safety slot', 1, [REQUEST_RISK_SUMMARY]],
    ])('when the hour is spent for %s, only that row is lost', async (_name, refusedCall, expected) => {
      modelAnswers(DIAGNOSING_ANSWER);
      let call = 0;
      mockConsumeReviewSlot.mockImplementation(async () => {
        const index = call;
        call += 1;
        if (index === refusedCall) throw spent('either');
        return SAFETY_REVIEW_RECEIPT;
      });

      const { status, body } = await send({ message: ALLOWED_HIGH_RISK });

      expect(status).toBe(200);
      expect(body.state).toBe('filtered');
      expect(summaries()).toEqual(expected);
      expect(mockConsumeReviewSlot).toHaveBeenCalledTimes(2);
    });

    test('a BENIGN question whose generated answer is replaced writes the response-safety row only', async () => {
      modelAnswers(DIAGNOSING_ANSWER);

      const { body } = await send({ message: BENIGN });

      expect(body.state).toBe('filtered');
      expect(summaries()).toEqual([RESPONSE_SAFETY_SUMMARY]);
      expect(bucketsAsked()).toEqual(['safety_review']);
    });

    // CONTROL: passes on main too.
    test('a benign question writes no row and takes no slot', async () => {
      modelAnswers('Start with ladder work.');

      const { body } = await send({ message: BENIGN });

      expect(body.state).toBe('ok');
      expect(mockQueueHumanReview).not.toHaveBeenCalled();
      expect(mockConsumeReviewSlot).not.toHaveBeenCalled();
      expect(mockRefundRateLimit).not.toHaveBeenCalled();
    });

    test.each([
      ['not athlete-scoped', undefined, false],
      ['athlete-scoped', 'athlete-1', true],
    ])('an authorized request writes its row either way: %s', async (_name, athleteId, athleteScoped) => {
      modelAnswers();

      await send(athleteId ? { message: ALLOWED_HIGH_RISK, athleteId } : { message: ALLOWED_HIGH_RISK });
      await send(athleteId ? { message: WITHHELD, athleteId } : { message: WITHHELD });

      expect(mockQueueHumanReview).toHaveBeenCalledTimes(2);
      for (const [ticket] of mockQueueHumanReview.mock.calls) {
        expect((ticket.metadata as Record<string, unknown>).athleteScoped).toBe(athleteScoped);
      }
    });
  });

  // THE EMPTY LIBRARY. The notice that replaces an answer when the Library
  // holds nothing is not a safety event, and its row says what main's row
  // says. It is bounded like every other non-critical review row: it draws on
  // the general bucket (OD-2026-10-01-006). A high-risk request that meets it
  // still has its own request-risk row.
  describe('the empty-Library row is operational: main\'s content, the general bucket', () => {
    const emptyLibrary = () => {
      mockHasRetrievableEvidence.mockResolvedValue(false);
      return modelAnswers('Confident guidance drawn from nothing at all.');
    };

    test('a benign question: main\'s row, one slot from the general bucket, asked for as an operational row', async () => {
      emptyLibrary();

      const { status, body } = await send({ message: BENIGN });

      expect(status).toBe(200);
      expect(body.response).toContain('No verified evidence is loaded in the Library yet');
      expect(mockQueueHumanReview).toHaveBeenCalledTimes(1);
      expect(mockQueueHumanReview.mock.calls[0]?.[0]).toEqual({
        organizationId: 'org-session',
        accountId: 'account-1',
        conversationId: 'conversation-1',
        category: expect.any(String),
        severity: 'high',
        summary: RESPONSE_SAFETY_SUMMARY,
        metadata: {
          assistantMessageId: 'assistant-message-1',
          sessionType: body.sessionType,
          athleteScoped: false,
          safetyReasons: expect.any(Array),
        },
      });
      expect(mockConsumeReviewSlot.mock.calls.map(([input]) => input.event.kind)).toEqual(['operational']);
      expect(bucketsAsked()).toEqual(['safety_review']);
    });

    test('a high-risk question: its request-risk row and main\'s row, each from its own bucket', async () => {
      emptyLibrary();

      const { body } = await send({ message: ALLOWED_HIGH_RISK });

      expect(body.response).toContain('No verified evidence is loaded in the Library yet');
      expect(summaries()).toEqual([REQUEST_RISK_SUMMARY, RESPONSE_SAFETY_SUMMARY]);
      expect(bucketsAsked()).toEqual(['safety_review_critical', 'safety_review']);
    });

    // A fixed-fallback question that meets an empty Library is both things: a
    // high-risk request, and an answer replaced by the notice. Two rows. The
    // request is not a critical one, so both draw on the general bucket.
    test('a fixed-fallback question with an empty Library: its request-risk row and the operational row, both from the general bucket', async () => {
      const fetchSpy = emptyLibrary();

      const { status } = await send({ message: STOCK_LINE });

      expect(status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(summaries()).toEqual([REQUEST_RISK_SUMMARY, RESPONSE_SAFETY_SUMMARY]);
      expect(mockConsumeReviewSlot.mock.calls.map(([input]) => input.event.kind)).toEqual(['request_risk', 'operational']);
      expect(bucketsAsked()).toEqual(['safety_review', 'safety_review']);
    });

    test('when the general bucket\'s hour is spent the row is not written, and the reply is unchanged', async () => {
      emptyLibrary();
      const written = await send({ message: BENIGN });

      jest.clearAllMocks();
      emptyLibrary();
      mockConsumeReviewSlot.mockRejectedValue(spent('safety_review'));
      const suppressed = await send({ message: BENIGN });

      expect(mockQueueHumanReview).not.toHaveBeenCalled();
      expect(suppressed.status).toBe(200);
      expect(told(suppressed.body)).toEqual(told(written.body));
    });

    test('main\'s failure handling is kept: one retry, then the request fails closed; the slot is given back', async () => {
      emptyLibrary();
      mockQueueHumanReview.mockRejectedValue(new Error('insert failed'));

      const { status } = await send({ message: BENIGN });

      expect(mockQueueHumanReview).toHaveBeenCalledTimes(2);
      expect(status).toBe(500);
      expect(mockRefundRateLimit).toHaveBeenCalledTimes(1);
      expect(mockRefundRateLimit.mock.calls[0]?.[0]).toBe(SAFETY_REVIEW_RECEIPT);
    });

    test('a failed insert behind a high-risk request that already has its request-risk row: the reply stands', async () => {
      emptyLibrary();
      mockQueueHumanReview.mockImplementation(async (ticket) => {
        if (ticket.summary === RESPONSE_SAFETY_SUMMARY) throw new Error('insert failed');
        return 'review-1';
      });

      const { status } = await send({ message: ALLOWED_HIGH_RISK });

      expect(status).toBe(200);
      expect(summaries()).toEqual([REQUEST_RISK_SUMMARY, RESPONSE_SAFETY_SUMMARY, RESPONSE_SAFETY_SUMMARY]);
      expect(mockRefundRateLimit).toHaveBeenCalledTimes(1);
    });
  });

  describe('the review buckets', () => {
    test.each([
      ['allowed and answered', ALLOWED_HIGH_RISK, 200],
      ['withheld', WITHHELD, 400],
      ['fixed fallback line', STOCK_LINE, 200],
    ])('when the hour is spent the row is not written and the response is unchanged: %s', async (_name, message, expectedStatus) => {
      modelAnswers();
      const before = await send({ message });

      jest.clearAllMocks();
      modelAnswers();
      mockConsumeReviewSlot.mockRejectedValue(spent('either'));
      const after = await send({ message });

      expect(mockQueueHumanReview).not.toHaveBeenCalled();
      // Asked once: POST's exit write does not ask again for a suppressed row.
      expect(mockConsumeReviewSlot).toHaveBeenCalledTimes(1);
      // Putting a refused attempt back is the limiter's job, not the route's.
      expect(mockRefundRateLimit).not.toHaveBeenCalled();
      expect(after.status).toBe(expectedStatus);
      expect(after.status).toBe(before.status);
      expect(told(after.body)).toEqual(told(before.body));
    });

    test.each([
      ['allowed and answered', ALLOWED_HIGH_RISK],
      ['withheld', WITHHELD],
      ['fixed fallback line', STOCK_LINE],
    ])('a limiter that FAILS is not a limiter that is spent: the row is still written: %s', async (_name, message) => {
      // (The withheld and fixed-fallback rows pass on main too, which has no
      // limiter here; the answered row is the one that is new.)
      modelAnswers();
      mockConsumeReviewSlot.mockRejectedValueOnce(new Error('SHADOW_RATE_LIMIT_UNAVAILABLE'));

      await send({ message });

      expect(mockQueueHumanReview).toHaveBeenCalledTimes(1);
      // No slot was taken, so there is none to give back.
      expect(mockRefundRateLimit).not.toHaveBeenCalled();
    });

    test('a limiter that fails AND an insert that fails: there was no slot, so nothing is given back', async () => {
      modelAnswers();
      mockConsumeReviewSlot.mockRejectedValue(new Error('SHADOW_RATE_LIMIT_UNAVAILABLE'));
      mockQueueHumanReview.mockRejectedValue(new Error('insert failed'));

      const { status } = await send({ message: ALLOWED_HIGH_RISK });

      expect(status).toBe(200);
      expect(mockQueueHumanReview).toHaveBeenCalledTimes(1);
      expect(mockRefundRateLimit).not.toHaveBeenCalled();
    });

    test.each([
      ['allowed and answered', ALLOWED_HIGH_RISK, 200],
      ['withheld', WITHHELD, 400],
    ])('a failed insert gives back the exact slot that was taken, once, and the response stands: %s', async (_name, message, expectedStatus) => {
      modelAnswers();
      const receipt: ShadowRateLimitReceipt = { ...SAFETY_REVIEW_RECEIPT, windowStartedAtEpochSeconds: 1_790_003_600 };
      mockConsumeReviewSlot.mockResolvedValueOnce(receipt);
      mockQueueHumanReview.mockRejectedValue(new Error('insert failed'));

      const { status } = await send({ message });

      // One attempt: main did not retry these, and the exit write is not a retry.
      expect(mockQueueHumanReview).toHaveBeenCalledTimes(1);
      expect(mockConsumeReviewSlot).toHaveBeenCalledTimes(1);
      expect(mockRefundRateLimit).toHaveBeenCalledTimes(1);
      // The receipt the limiter returned, passed back untouched.
      expect(mockRefundRateLimit.mock.calls[0]?.[0]).toBe(receipt);
      expect(status).toBe(expectedStatus);
    });

    test('where the body tells the person a human will review (the fixed fallback line), a failed write retries once, then fails the request closed, and gives its one slot back once', async () => {
      modelAnswers();
      const receipt: ShadowRateLimitReceipt = { ...SAFETY_REVIEW_RECEIPT, windowStartedAtEpochSeconds: 1_790_007_200 };
      mockConsumeReviewSlot.mockResolvedValueOnce(receipt);
      mockQueueHumanReview.mockRejectedValue(new Error('insert failed'));

      const { status } = await send({ message: STOCK_LINE });

      // Main's behaviour for this write: two attempts, then the request fails.
      expect(mockQueueHumanReview).toHaveBeenCalledTimes(2);
      expect(status).toBe(500);
      // One slot for the request, not one per attempt; refunded once.
      expect(mockConsumeReviewSlot).toHaveBeenCalledTimes(1);
      expect(mockRefundRateLimit).toHaveBeenCalledTimes(1);
      expect(mockRefundRateLimit.mock.calls[0]?.[0]).toBe(receipt);
    });

    // CONTROL for the retry itself (main retries this write too); the slot half is new.
    test('a retry that succeeds keeps its slot', async () => {
      modelAnswers();
      mockQueueHumanReview.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce('review-2');

      const { status } = await send({ message: STOCK_LINE });

      expect(status).toBe(200);
      expect(mockQueueHumanReview).toHaveBeenCalledTimes(2);
      expect(mockRefundRateLimit).not.toHaveBeenCalled();
    });

    test('a successful write gives nothing back', async () => {
      modelAnswers();
      await send({ message: ALLOWED_HIGH_RISK });
      await send({ message: WITHHELD });
      expect(mockQueueHumanReview).toHaveBeenCalledTimes(2);
      expect(mockRefundRateLimit).not.toHaveBeenCalled();
    });

    test.each([
      ['rejects', () => { mockRefundRateLimit.mockRejectedValue(new Error('refund blew up')); }],
      ['reports failure', () => { mockRefundRateLimit.mockResolvedValue(false); }],
    ])('a refund that %s never becomes the outcome of the request', async (_name, arrange) => {
      modelAnswers();
      const written = await send({ message: ALLOWED_HIGH_RISK });

      jest.clearAllMocks();
      modelAnswers();
      arrange();
      mockQueueHumanReview.mockRejectedValue(new Error('insert failed'));
      const failed = await send({ message: ALLOWED_HIGH_RISK });

      expect(mockRefundRateLimit).toHaveBeenCalledTimes(1);
      expect(failed.status).toBe(written.status);
      expect(told(failed.body)).toEqual(told(written.body));
    });
  });

  // THE GENERATED-ANSWER ROW FAILING TO INSERT. The body of a replaced answer
  // tells the person a human will review it. Whether a failed insert may be
  // survived depends on whether that is still true.
  describe('a response-safety row that cannot be written', () => {
    const responseSafetyInsertFails = () => {
      mockQueueHumanReview.mockImplementation(async (ticket) => {
        if (ticket.summary === RESPONSE_SAFETY_SUMMARY) throw new Error('insert failed');
        return 'review-1';
      });
    };

    test('the request already has its request-risk row: logged, the slot is given back, and the response stands', async () => {
      modelAnswers(DIAGNOSING_ANSWER);
      const written = await send({ message: ALLOWED_HIGH_RISK });

      jest.clearAllMocks();
      modelAnswers(DIAGNOSING_ANSWER);
      const responseReceipt: ShadowRateLimitReceipt = { ...SAFETY_REVIEW_RECEIPT, windowStartedAtEpochSeconds: 1_790_010_800 };
      mockConsumeReviewSlot.mockResolvedValueOnce(SAFETY_REVIEW_RECEIPT).mockResolvedValueOnce(responseReceipt);
      responseSafetyInsertFails();
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const failed = await send({ message: ALLOWED_HIGH_RISK });

      // request-risk once, response-safety twice (main's retry).
      expect(summaries()).toEqual([REQUEST_RISK_SUMMARY, RESPONSE_SAFETY_SUMMARY, RESPONSE_SAFETY_SUMMARY]);
      expect(failed.status).toBe(200);
      expect(told(failed.body)).toEqual(told(written.body));
      expect(mockRefundRateLimit).toHaveBeenCalledTimes(1);
      expect(mockRefundRateLimit.mock.calls[0]?.[0]).toBe(responseReceipt);
      expect(errorSpy).toHaveBeenCalledWith('SHADOW human-review queue write failed');
    });

    test('a benign request has no other row: the request fails closed, as on main, and the slot is given back', async () => {
      modelAnswers(DIAGNOSING_ANSWER);
      responseSafetyInsertFails();

      const { status } = await send({ message: BENIGN });

      expect(mockQueueHumanReview).toHaveBeenCalledTimes(2);
      expect(status).toBe(500);
      expect(mockRefundRateLimit).toHaveBeenCalledTimes(1);
      expect(mockRefundRateLimit.mock.calls[0]?.[0]).toBe(SAFETY_REVIEW_RECEIPT);
    });

    test.each([
      ['its insert also failed', () => { mockQueueHumanReview.mockRejectedValue(new Error('insert failed')); }, 3, 2],
      ['its hour was spent', () => {
        responseSafetyInsertFails();
        mockConsumeReviewSlot.mockRejectedValueOnce(spent('safety_review_critical'));
      }, 2, 1],
    ])('a high-risk request whose request-risk row is NOT there (%s): no row backs the claim, so it fails closed', async (_name, arrange, inserts, refunds) => {
      modelAnswers(DIAGNOSING_ANSWER);
      arrange();

      const { status } = await send({ message: ALLOWED_HIGH_RISK });

      expect(status).toBe(500);
      expect(mockQueueHumanReview).toHaveBeenCalledTimes(inserts);
      expect(mockRefundRateLimit).toHaveBeenCalledTimes(refunds);
    });

    // The reverse, which an earlier version of this work got wrong: the
    // response-safety row IS written and the request-risk insert fails. Main
    // returns the replaced answer; so does this.
    test('the response-safety row is written and the request-risk insert fails: 200, as on main', async () => {
      modelAnswers(DIAGNOSING_ANSWER);
      mockQueueHumanReview.mockImplementation(async (ticket) => {
        if (ticket.summary === REQUEST_RISK_SUMMARY) throw new Error('insert failed');
        return 'review-1';
      });

      const { status, body } = await send({ message: ALLOWED_HIGH_RISK });

      expect(status).toBe(200);
      expect(body.state).toBe('filtered');
      expect(summaries()).toEqual([REQUEST_RISK_SUMMARY, RESPONSE_SAFETY_SUMMARY]);
    });
  });

  // PATHS THAT STORE NO ASSISTANT MESSAGE. The row is written by POST, after
  // the handler has decided the response and before that response is
  // returned. What the person is told is the gate's or the refusal's own
  // response, word for word what a benign request gets.
  describe('the row is written at the exit when the request is turned away, queued or fails', () => {
    const heavyBagCapSpent = () => {
      mockEnforceRateLimit.mockImplementation(async (input) => {
        if ((input as { endpointKey: string }).endpointKey === 'heavy_bag') throw new ShadowRateLimitExceeded(1200, 'heavy_bag');
      });
    };
    const limitSpent = (key: string) => () => {
      mockEnforceRateLimit.mockImplementation(async (input) => {
        if ((input as { endpointKey: string }).endpointKey === key) throw new ShadowRateLimitExceeded(60, key);
      });
    };
    const runtimeNotReady = () => {
      jest.mocked(assertShadowRuntimeReadiness).mockRejectedValue(new Error('SHADOW runtime not ready'));
    };
    const runtimeUnavailable = () => {
      jest.mocked(assertShadowRuntimeReadiness).mockRejectedValue(new ShadowRuntimeUnavailableError({ missingTables: ['shadow_conversations'] }));
    };
    const contextThrows = () => {
      mockRetrieveShadowContext.mockRejectedValue(new Error('connection reset by peer'));
    };
    const noArrangement = () => undefined;

    test.each([
      ['Film Study is not available from chat', { sessionType: 'film_study' }, 400, noArrangement],
      ['the Scout worker is not configured', { sessionType: 'scout_report' }, 503, noArrangement],
      ['the Heavy Bag allowance is spent', { sessionType: 'heavy_bag' }, 429, heavyBagCapSpent],
      ['the per-minute chat limit is spent', {}, 429, limitSpent('chat')],
      ['the daily chat limit is spent', {}, 429, limitSpent('chat_daily')],
      ['the runtime is not ready', {}, 500, runtimeNotReady],
      ['the runtime is unavailable (a migration is missing)', {}, 503, runtimeUnavailable],
      ['an unexpected error is thrown while the request is handled', {}, 500, contextThrows],
    ])('%s: the response is the one a benign request gets, and one row is written', async (_name, extra, expectedStatus, arrange) => {
      arrange();
      const benign = await send({ message: BENIGN, ...extra });
      expect(benign.status).toBe(expectedStatus);
      expect(mockQueueHumanReview).not.toHaveBeenCalled();

      jest.clearAllMocks();
      arrange();
      const fetchSpy = modelAnswers();
      const highRisk = await send({ message: ALLOWED_HIGH_RISK, ...extra });

      expect(highRisk.status).toBe(expectedStatus);
      expect(fetchSpy).not.toHaveBeenCalled();
      // The same response, word for word: review precedence changed, response precedence did not.
      expect(told(highRisk.body)).toEqual(told(benign.body));
      expect(mockQueueHumanReview).toHaveBeenCalledTimes(1);
      expect(mockQueueHumanReview.mock.calls[0]?.[0]).toEqual({
        organizationId: 'org-session',
        accountId: 'account-1',
        conversationId: undefined,
        category: 'loss_of_consciousness',
        severity: 'critical',
        summary: REQUEST_RISK_SUMMARY,
        metadata: {
          sessionType: expect.any(String),
          athleteScoped: false,
          validationClassification: 'loss_of_consciousness',
        },
      });
      expect(bucketsAsked()).toEqual(['safety_review_critical']);
    });

    // A request the classifier WOULD withhold, turned away first by a gate
    // that sits above the safety boundary. It was not "withheld by the
    // pre-generation safety boundary", and its row does not say it was.
    test.each([
      ['the per-minute chat limit', 429, limitSpent('chat')],
      ['an unready runtime', 500, runtimeNotReady],
    ])('an urgent message refused by %s: the gate\'s response, and a row that does not claim the boundary withheld it', async (_name, expectedStatus, arrange) => {
      arrange();

      const { status, body } = await send({ message: WITHHELD });

      expect(status).toBe(expectedStatus);
      expect(body.response).not.toContain('Potential emergency');
      expect(summaries()).toEqual([REQUEST_RISK_SUMMARY]);
      expect(mockQueueHumanReview.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ severity: 'critical', category: 'urgent_symptom' }));
    });

    test('a degraded provider answer stores nothing and still leaves the row', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'body' }) as unknown as typeof fetch;
      jest.spyOn(console, 'error').mockImplementation(() => {});

      const { status, body } = await send({ message: ALLOWED_HIGH_RISK });

      expect(status).toBe(200);
      expect(body.state).toBe('degraded');
      expect(mockAppendConversationExchange).not.toHaveBeenCalled();
      expect(summaries()).toEqual([REQUEST_RISK_SUMMARY]);
      expect(mockQueueHumanReview.mock.calls[0]?.[0].metadata).not.toHaveProperty('assistantMessageId');
    });

    describe('queued for the worker', () => {
      const queued = (sessionType: string, jobId = 'job-1') => {
        mockIsShadowWorkerEnabled.mockReturnValue(true);
        mockAppendUserMessage.mockResolvedValue('user-msg-1');
        mockExecuteHeavyBagAsync.mockResolvedValue({ mode: 'async', jobId, routing: {} as never, sessionType: sessionType as never });
      };

      test.each([
        ['Heavy Bag with preferAsync', { sessionType: 'heavy_bag', preferAsync: true }, 'heavy_bag'],
        ['a Scout report', { sessionType: 'scout_report' }, 'scout_report'],
      ])('an allowed high-risk request leaves one row: %s', async (_name, extra, sessionType) => {
        queued(sessionType);
        const fetchSpy = modelAnswers();

        const { body } = await send({ message: ALLOWED_HIGH_RISK, ...extra });

        expect(body.state).toBe('queued');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(mockQueueHumanReview).toHaveBeenCalledTimes(1);
        expect(mockQueueHumanReview.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
          category: 'loss_of_consciousness',
          severity: 'critical',
          summary: REQUEST_RISK_SUMMARY,
          metadata: expect.objectContaining({ sessionType }),
        }));
        expect(bucketsAsked()).toEqual(['safety_review_critical']);
      });

      test('a background Heavy Bag row names the conversation the question was stored in', async () => {
        queued('heavy_bag');
        mockResolveConversation.mockResolvedValue('conversation-queued-9');

        const { body } = await send({ message: ALLOWED_HIGH_RISK, sessionType: 'heavy_bag', preferAsync: true });

        expect(body.conversationId).toBe('conversation-queued-9');
        expect(mockQueueHumanReview.mock.calls[0]?.[0].conversationId).toBe('conversation-queued-9');
      });

      // ORDER, NOT PRESENCE. A write that was started and not waited for
      // would also show up as "called once". Here the insert is held open:
      // the response must not arrive until it is let go.
      test('the response is not returned until the row is written', async () => {
        queued('heavy_bag');
        let finishInsert: () => void = () => undefined;
        mockQueueHumanReview.mockImplementation(() => new Promise<string>((resolve) => {
          finishInsert = () => resolve('review-1');
        }));

        let returned = false;
        const pending = POST(postRequest({ message: ALLOWED_HIGH_RISK, sessionType: 'heavy_bag', preferAsync: true }))
          .then((response) => { returned = true; return response; });
        await new Promise((resolve) => setTimeout(resolve, 50));

        // The job is queued and the insert has started, and the caller is still waiting.
        expect(mockExecuteHeavyBagAsync).toHaveBeenCalledTimes(1);
        expect(mockQueueHumanReview).toHaveBeenCalledTimes(1);
        expect(returned).toBe(false);

        finishInsert();
        const response = await pending;
        expect(returned).toBe(true);
        expect((await response.json()).state).toBe('queued');
      });

      // CONTROL: passes on main too.
      test('a benign request queued for the worker writes no row', async () => {
        queued('heavy_bag', 'job-2');

        const { body } = await send({ message: 'Build a six-week plan from what you know.', sessionType: 'heavy_bag', preferAsync: true });

        expect(body.state).toBe('queued');
        expect(mockQueueHumanReview).not.toHaveBeenCalled();
        expect(mockConsumeReviewSlot).not.toHaveBeenCalled();
      });

      test('what a queued requester is told does not depend on the row', async () => {
        const queue = async () => {
          queued('heavy_bag', 'job-3');
          return send({ message: ALLOWED_HIGH_RISK, sessionType: 'heavy_bag', preferAsync: true });
        };
        const written = await queue();

        jest.clearAllMocks();
        mockConsumeReviewSlot.mockRejectedValueOnce(spent('safety_review_critical'));
        const suppressed = await queue();
        expect(mockQueueHumanReview).not.toHaveBeenCalled();

        jest.clearAllMocks();
        mockQueueHumanReview.mockRejectedValueOnce(new Error('insert failed'));
        const insertFailed = await queue();
        expect(mockRefundRateLimit).toHaveBeenCalledTimes(1);

        expect(told(suppressed.body)).toEqual(told(written.body));
        expect(told(insertFailed.body)).toEqual(told(written.body));
        expect(written.body.requiresHumanReview).toBe(false);
      });
    });
  });

  // AN AUTHORIZATION FAILURE IS NEVER OBSERVABLE THROUGH A SAFETY ROW.
  //
  // Two locks. The handler probes the caller's access before it decides a row
  // is owed; and POST writes nothing behind a 401, 403 or 404, whatever the
  // probe said.
  //
  // WHICH TEST PROVES WHICH LOCK. When the caller sees the 403 or 404, either
  // lock alone is enough, so those tests ("REFUSED ...") cannot fail for the
  // probe and pass on main. The probe is proved only where the response is
  // NOT a 401/403/404 -- an unauthorized request that a throttle or an
  // unready runtime turns away first ("THE PROBE ALONE"). The second lock is
  // proved where the probe is passed and the refusal comes afterwards ("THE
  // SECOND LOCK").
  describe('authorization stays above the review write', () => {
    const noRowNoSlot = () => {
      expect(mockQueueHumanReview).not.toHaveBeenCalled();
      expect(mockConsumeReviewSlot).not.toHaveBeenCalled();
    };
    const athleteCheck = jest.mocked(assertActorCanAccessAthlete);
    const conversationCheck = jest.mocked(assertConversationAccess);
    const CONVERSATION = '00000000-0000-4000-8000-000000000301';

    // CONTROL: passes on main too.
    test('an unauthenticated request writes no row and takes no slot', async () => {
      modelAnswers();
      mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

      const { status } = await send({ message: WITHHELD });

      expect(status).toBe(401);
      noRowNoSlot();
    });

    test.each([
      ['withheld', WITHHELD],
      ['allowed high-risk', ALLOWED_HIGH_RISK],
    ])('REFUSED (control, either lock): an athlete the caller may not access: 403, no row, no slot: %s', async (_name, message) => {
      modelAnswers();
      athleteCheck.mockRejectedValue(new Error('Forbidden: athlete outside your assignment'));

      const { status } = await send({ message, athleteId: 'athlete-not-mine' });

      expect(status).toBe(403);
      noRowNoSlot();
    });

    test.each([
      ['withheld', WITHHELD, 'Forbidden: conversation belongs to another account', 403],
      ['allowed high-risk', ALLOWED_HIGH_RISK, 'Forbidden: conversation belongs to another account', 403],
      ['withheld, and the conversation does not exist', WITHHELD, 'SHADOW_CONVERSATION_NOT_FOUND', 404],
    ])('REFUSED (control, either lock): a conversation the caller may not access: no row, no slot: %s', async (_name, message, error, expectedStatus) => {
      modelAnswers();
      conversationCheck.mockRejectedValue(new Error(error));

      const { status } = await send({ message, conversationId: CONVERSATION });

      expect(status).toBe(expectedStatus);
      noRowNoSlot();
    });

    // THE PROBE ALONE. The caller may not access the athlete, the
    // conversation or the board summary, and something above the handler's
    // own authorization check answers first: main says "too many requests"
    // or "unavailable", and so does this. The response is not a 401/403/404,
    // so the second lock does not apply; only the probe keeps a row from
    // being written against a subject the caller has no access to.
    const chatLimitSpent = () => {
      mockEnforceRateLimit.mockImplementation(async (input) => {
        if ((input as { endpointKey: string }).endpointKey === 'chat') throw new ShadowRateLimitExceeded(60, 'chat');
      });
    };
    const runtimeNotReady = () => {
      jest.mocked(assertShadowRuntimeReadiness).mockRejectedValue(new Error('SHADOW runtime not ready'));
    };
    const noAthlete = () => { athleteCheck.mockRejectedValue(new Error('Forbidden: athlete outside your assignment')); };
    const noConversation = () => { conversationCheck.mockRejectedValue(new Error('Forbidden: conversation belongs to another account')); };
    const missingConversation = () => { conversationCheck.mockRejectedValue(new Error('SHADOW_CONVERSATION_NOT_FOUND')); };
    const nothingRefused = () => undefined;

    test.each([
      ['an athlete the caller may not access', noAthlete, { athleteId: 'athlete-not-mine' }],
      ['a conversation the caller may not access', noConversation, { conversationId: CONVERSATION }],
      ['a conversation that does not exist', missingConversation, { conversationId: CONVERSATION }],
      ['a board summary this role may not run', nothingRefused, { sessionType: 'board_summary' }],
    ].flatMap(([name, refuse, extra]) => [
      [(name as string) + ', and the chat limit is spent', refuse as () => void, extra as Record<string, unknown>, chatLimitSpent, 429] as const,
      [(name as string) + ', and the runtime is not ready', refuse as () => void, extra as Record<string, unknown>, runtimeNotReady, 500] as const,
    ]))('THE PROBE ALONE: %s: main\'s response, no row, no slot', async (_name, refuse, extra, gate, expectedStatus) => {
      refuse();
      gate();
      modelAnswers();

      const { status } = await send({ message: ALLOWED_HIGH_RISK, ...extra });

      // The gate's own status, as on main: the probe does not answer the request.
      expect(status).toBe(expectedStatus);
      noRowNoSlot();
    });

    // A PROBE THAT FAILS IS NOT A PROBE THAT REFUSED. The access check throws
    // something that is not a refusal when the probe runs it, and passes when
    // the handler does. The request is handled as usual, and its row is owed.
    test.each([
      ['an allowed high-risk question', ALLOWED_HIGH_RISK, 200, REQUEST_RISK_SUMMARY],
      ['a withheld emergency report', WITHHELD, 400, WITHHELD_SUMMARY],
      ['a fixed-fallback question', STOCK_LINE, 200, REQUEST_RISK_SUMMARY],
    ])('a probe that fails for a reason other than a refusal does not cancel the row: %s', async (_name, message, expectedStatus, summary) => {
      modelAnswers();
      athleteCheck.mockRejectedValueOnce(new Error('connection reset by peer'));
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const { status } = await send({ message, athleteId: 'athlete-1' });

      expect(status).toBe(expectedStatus);
      expect(summaries()).toEqual([summary]);
      expect(errorSpy).toHaveBeenCalledWith('SHADOW authorization probe failed for a reason other than a refusal; the review row stays owed');
    });

    // THE SECOND LOCK. The probe is passed and the row is owed; the refusal
    // comes afterwards. Only POST's status check stands between that and a row.
    test.each([
      ['403: the athlete check passes for the probe and rejects for the handler', 403, () => {
        athleteCheck.mockResolvedValueOnce(undefined as never).mockRejectedValue(new Error('Forbidden: athlete outside your assignment'));
      }, { athleteId: 'athlete-1' }],
      ['404: the conversation check passes for the probe and rejects for the handler', 404, () => {
        conversationCheck.mockResolvedValueOnce(undefined as never).mockRejectedValue(new Error('SHADOW_CONVERSATION_NOT_FOUND'));
      }, { conversationId: CONVERSATION }],
      ['403: the role may not read this context', 403, () => {
        mockRetrieveShadowContext.mockResolvedValue({ authorized: false, reason: 'Not authorized to access this context' } as never);
      }, {}],
      ['401: the session is found to be invalid after the row is owed', 401, () => {
        mockRetrieveShadowContext.mockRejectedValue(new Error('Unauthorized'));
      }, {}],
    ])('THE SECOND LOCK, %s: no row, no slot, though the probe said the row was owed', async (_name, expectedStatus, arrange, extra) => {
      modelAnswers();
      arrange();

      const { status } = await send({ message: ALLOWED_HIGH_RISK, ...extra });

      expect(status).toBe(expectedStatus);
      noRowNoSlot();
    });

    // CONTROL (either lock; passes on main).
    test('a board summary this role may not run: the 403 is authorization, and writes no row', async () => {
      const { status, body } = await send({ message: ALLOWED_HIGH_RISK, sessionType: 'board_summary' });

      expect(status).toBe(403);
      expect(body.error).toBe('Not authorized to generate a board summary.');
      noRowNoSlot();
    });

    // Main answers a withheld request from the safety boundary before it
    // reaches the board-summary refusal. So this one is not refused as a
    // board summary, and its row is written.
    test('a WITHHELD request that names a board summary is answered by the safety boundary, as on main, and leaves its row', async () => {
      const { status } = await send({ message: WITHHELD, sessionType: 'board_summary' });

      expect(status).toBe(400);
      expect(summaries()).toEqual([WITHHELD_SUMMARY]);
    });
  });
});

describe('POST /api/pilot/shadow/chat trust boundary', () => {
  test('passes authenticated role and authorized context into the model prompt', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'RESEARCH NEEDED — no verified evidence was supplied.' } }] }),
    }) as unknown as typeof fetch;

    const response = await POST(postRequest({
      message: 'What does the evidence show?',
      organizationId: 'org-attacker',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.state).toBe('ok');
    expect(payload.messageId).toBe('assistant-message-1');
    expect(payload.conversationId).toBe('conversation-1');
    expect(mockRetrieveShadowContext).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'account-1',
      userRole: 'coach',
      organizationId: 'org-session',
      actorAthleteId: null,
    }));

    const requestInit = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    const providerBody = JSON.parse(String(requestInit.body));
    const systemPrompt = providerBody.messages[0].content as string;
    expect(systemPrompt).toContain('Authorized role: coach');
    expect(systemPrompt).toContain('Tier context for this authenticated user.');
    expect(systemPrompt).toContain('EVIDENCE UNAVAILABLE');
    expect(systemPrompt).toContain('Never invent citations, case counts, confidence values, or outcomes');
    expect(systemPrompt).not.toContain('org-attacker');
    expect(providerBody.max_completion_tokens).toBe(4096);
    expect(requestInit.signal).toBeDefined();
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, {
      organizationId: 'org-session',
      accountId: 'account-1',
      endpointKey: 'chat',
      limit: 30,
      windowSeconds: 60,
    });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, {
      organizationId: 'org-session',
      accountId: 'account-1',
      endpointKey: 'chat_daily',
      limit: 400,
      windowSeconds: 86_400,
    });
    expect(mockAppendConversationExchange).toHaveBeenCalledWith(expect.objectContaining({
      actor: expect.objectContaining({
        organizationId: 'org-session',
        accountId: 'account-1',
      }),
      conversationId: 'conversation-1',
      responseState: 'ok',
      evidence: {
        bundleId: '00000000-0000-4000-8000-000000000200',
        availability: 'unavailable',
        citationIds: [],
      },
    }));
    expect(JSON.stringify(mockQuery.mock.calls)).not.toContain('What does the evidence show?');
  });

  test('returns and persists only an exact citation from the retrieved bundle', async () => {
    const evidenceId = '00000000-0000-4000-8000-000000000201';
    mockRetrieveEvidence.mockResolvedValueOnce({
      bundleId: '00000000-0000-4000-8000-000000000200',
      availability: 'available',
      allowedEvidenceIds: [evidenceId],
      context: `Use [E:${evidenceId}] for the approved excerpt.`,
      items: [{
        evidenceId,
        token: `[E:${evidenceId}]`,
        sourceId: 'source-a',
        documentId: 'doc-a',
        chunkId: 'chunk-a',
        subjectId: null,
        sourceTitle: 'Approved source',
        documentName: 'Approved document',
        excerpt: 'Approved bounded excerpt.',
        authorityTier: 2,
        evidenceClass: 'VERIFIED EVIDENCE',
        boxingSpecificity: 'boxing_specific',
      }],
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: `Research suggests the approved drill may help. [E:${evidenceId}]`,
          },
        }],
      }),
    }) as unknown as typeof fetch;

    const response = await POST(postRequest({ message: 'What does approved research suggest?' }));
    const payload = await response.json();

    expect(payload.state).toBe('ok');
    expect(payload.citations).toEqual([{
      evidenceId,
      token: `[E:${evidenceId}]`,
      sourceTitle: 'Approved source',
      documentName: 'Approved document',
    }]);
    expect(mockAppendConversationExchange).toHaveBeenCalledWith(expect.objectContaining({
      evidence: {
        bundleId: '00000000-0000-4000-8000-000000000200',
        availability: 'available',
        citationIds: [evidenceId],
      },
    }));
  });

  test('filters a generated citation that was not in the exact retrieved bundle', async () => {
    const evidenceId = '00000000-0000-4000-8000-000000000201';
    const forgedId = '00000000-0000-4000-8000-000000000999';
    mockRetrieveEvidence.mockResolvedValueOnce({
      bundleId: '00000000-0000-4000-8000-000000000200',
      availability: 'available',
      allowedEvidenceIds: [evidenceId],
      context: `Use [E:${evidenceId}] for the approved excerpt.`,
      items: [{
        evidenceId,
        token: `[E:${evidenceId}]`,
        sourceId: 'source-a',
        documentId: 'doc-a',
        chunkId: 'chunk-a',
        subjectId: null,
        sourceTitle: 'Approved source',
        documentName: 'Approved document',
        excerpt: 'Approved bounded excerpt.',
        authorityTier: 2,
        evidenceClass: 'VERIFIED EVIDENCE',
        boxingSpecificity: 'boxing_specific',
      }],
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: `Research suggests this works. [E:${forgedId}]` },
        }],
      }),
    }) as unknown as typeof fetch;

    const response = await POST(postRequest({ message: 'What does approved research suggest?' }));
    const payload = await response.json();

    expect(payload.state).toBe('filtered');
    expect(payload.response).toBe(SHADOW_SAFE_FILTERED_RESPONSE);
    expect(payload.citations).toEqual([]);
    expect(mockAppendConversationExchange).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({ citationIds: [] }),
    }));
  });

  test('replaces unsafe provider output before returning it to the browser', async () => {
    const unsafeOutput = 'You have a concussion and should rest for 3 weeks.';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: unsafeOutput } }] }),
    }) as unknown as typeof fetch;

    const response = await POST(postRequest({ message: 'Explain this training concern.' }));
    const payload = await response.json();

    expect(payload.success).toBe(false);
    expect(payload.state).toBe('filtered');
    expect(payload.response).toBe(SHADOW_SAFE_FILTERED_RESPONSE);
    expect(payload.response).not.toContain(unsafeOutput);
    expect(mockUpdateProfile).not.toHaveBeenCalled();
    expect(mockAppendConversationExchange).toHaveBeenCalledWith(expect.objectContaining({
      assistantMessage: SHADOW_SAFE_FILTERED_RESPONSE,
      responseState: 'filtered',
    }));
  });

  test('files a response-volunteered high-risk topic under itself, not the benign request topic', async () => {
    // The request here classifies as topic 'none' -- nothing about it is
    // high-risk. The handoff banner was already fixed to prefer the topic the
    // RESPONSE volunteers, but the persisted message's topic and the human
    // review queue's category still used the request-only classification, so
    // a weight-cut answer to a benign question was filed and triaged as
    // 'general' even though the user saw the weight-cut handoff banner.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Cut water weight before the weigh-in.' } }] }),
    }) as unknown as typeof fetch;

    const response = await POST(postRequest({ message: 'Explain this training concern.' }));
    const payload = await response.json();

    expect(payload.state).toBe('filtered');
    expect(payload.handoff).toContain('sports nutritionist');
    expect(mockAppendConversationExchange).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'weight_cutting',
      responseState: 'filtered',
    }));
    expect(mockQueueHumanReview).toHaveBeenCalledWith(expect.objectContaining({
      category: 'weight_cutting',
    }));
  });

  // The Heavy Bag cap. Until it existed, the expensive path was charged only to
  // the generic `chat` bucket a Quick Round uses, so the per-user ceiling the ML
  // spec describes did not exist in any form.
  test('charges a coach a Heavy Bag round against the hourly cap', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
    mockClassifyRequest.mockReturnValueOnce({
      tier: 'heavy_bag', complexity: 0.9, topic: 'general',
    } as ReturnType<typeof classifyRequest>);

    await POST(postRequest({ message: 'Deep review please', tier: 'heavy_bag' }));

    expect(mockEnforceRateLimit).toHaveBeenCalledWith({
      organizationId: 'org-session',
      accountId: 'account-1',
      endpointKey: 'heavy_bag',
      limit: 10,
      windowSeconds: 3_600,
    });
  });

  test('does not charge an organization admin against the Heavy Bag cap', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
    mockClassifyRequest.mockReturnValueOnce({
      tier: 'heavy_bag', complexity: 0.9, topic: 'general',
    } as ReturnType<typeof classifyRequest>);

    await POST(postRequest({ message: 'Deep review please', tier: 'heavy_bag' }));

    expect(mockEnforceRateLimit).not.toHaveBeenCalledWith(
      expect.objectContaining({ endpointKey: 'heavy_bag' }),
    );
  });

  // The Heavy Bag cap is the only SHADOW limit that is partial: it closes one
  // tier and leaves Quick Round answering. Described with the generic wording
  // the other two buckets use, a coach reads a ten-round cap as SHADOW being
  // gone for an hour and stops trying.
  test('a refused Heavy Bag round says Quick Round still works', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
    mockClassifyRequest.mockReturnValueOnce({
      tier: 'heavy_bag', complexity: 0.9, topic: 'general',
    } as ReturnType<typeof classifyRequest>);
    // Refuse the Heavy Bag bucket specifically, not whichever bucket happens to
    // be charged first. `mockRejectedValueOnce` would have thrown on the generic
    // `chat` limit, which returns before the request is ever classified -- so
    // the test would have passed against a message it never actually produced.
    mockEnforceRateLimit.mockImplementation(async (input: { endpointKey: string }) => {
      if (input.endpointKey === 'heavy_bag') {
        throw new ShadowRateLimitExceeded(3_600, 'heavy_bag');
      }
    });

    const response = await POST(postRequest({ message: 'Deep review please', tier: 'heavy_bag' }));
    const body = await response.json();

    expect(body.response).toContain('Heavy Bag');
    expect(body.response).toContain('Quick Round');
  });

  test('a refused Quick Round keeps the general wording, because that limit is total', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
    mockEnforceRateLimit.mockRejectedValueOnce(
      new ShadowRateLimitExceeded(45, 'chat'),
    );

    const response = await POST(postRequest({ message: 'Quick question' }));
    const body = await response.json();

    expect(body.response).toContain('SHADOW');
    expect(body.response).not.toContain('Quick Round questions still work');
  });

  test('a Quick Round is never charged against the Heavy Bag cap', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));

    await POST(postRequest({ message: 'Quick question' }));

    expect(mockEnforceRateLimit).not.toHaveBeenCalledWith(
      expect.objectContaining({ endpointKey: 'heavy_bag' }),
    );
  });

  test('passes only the authorized conversation history before the new user message', async () => {
    mockLoadConversationMessages.mockResolvedValueOnce([
      {
        messageId: '00000000-0000-4000-8000-000000000010',
        role: 'user',
        content: 'Explain the first drill.',
        responseState: null,
        evidenceTier: null,
        handoff: null,
        createdAt: new Date().toISOString(),
      },
      {
        messageId: '00000000-0000-4000-8000-000000000011',
        role: 'assistant',
        content: 'The first answer was safely stored.',
        responseState: 'ok',
        evidenceTier: 'EMERGING',
        handoff: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'RESEARCH NEEDED — context-aware response.' } }],
      }),
    }) as unknown as typeof fetch;

    const conversationId = '00000000-0000-4000-8000-000000000001';
    const response = await POST(postRequest({
      message: 'What did you mean by that?',
      conversationId,
    }));
    expect(response.status).toBe(200);
    expect(mockLoadConversationMessages).toHaveBeenCalledWith(expect.objectContaining({
      actor: expect.objectContaining({ accountId: 'account-1', organizationId: 'org-session' }),
      conversationId,
      limit: 10,
    }));
    const requestInit = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    const providerBody = JSON.parse(String(requestInit.body));
    expect(providerBody.messages.map((message: { role: string; content: string }) => message.role))
      .toEqual(['system', 'user', 'assistant', 'user']);
    expect(providerBody.messages[1].content).toBe('Explain the first drill.');
    expect(providerBody.messages[3].content).toBe('What did you mean by that?');
  });

  test('routes an authorized manual Heavy Bag request through the Heavy Bag provider', async () => {
    mockClassifyRequest.mockReturnValueOnce({
      tier: 'heavy_bag',
      complexity: 0.9,
      topic: 'strategy',
      confidence: 1,
      reasoning: 'User explicitly requested Heavy Bag session',
      requiresManualOverride: false,
      suggestedContextDepth: 'full',
    });
    mockExecuteHeavyBagSync.mockResolvedValueOnce({
      mode: 'sync',
      response: 'RESEARCH NEEDED — no verified evidence was supplied.',
      routing: { model: { displayName: 'Test Heavy Model' } } as never,
      sessionType: 'heavy_bag',
    });

    const response = await POST(postRequest({
      message: 'Analyze this planning trade-off.',
      tier: 'heavy_bag',
      sessionType: 'heavy_bag',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.state).toBe('ok');
    expect(payload.sessionType).toBe('heavy_bag');
    expect(mockExecuteHeavyBagSync).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionType: 'heavy_bag',
        role: 'coach',
      }),
      'https://example.invalid',
      'test-key',
    );
    expect(global.fetch).toBe(originalFetch);
  });

  // Audit F1. The model is chosen from sessionType; the context depth and the
  // tier badge are taken from the tier. An explicit sessionType override moved
  // only the first, so all three could disagree at once.
  test('a sessionType override without a tier reports the tier that actually ran', async () => {
    // The classifier sees a short message and says quick_round. The caller
    // overrode sessionType to heavy_bag, so the Heavy Bag model runs -- and
    // before this fix the response still said "quick_round", while the context
    // was built lightweight for a model that expects the full picture.
    mockClassifyRequest.mockReturnValueOnce({
      tier: 'quick_round',
      complexity: 0.2,
      topic: 'general',
      confidence: 1,
      reasoning: 'Short message',
      requiresManualOverride: false,
      suggestedContextDepth: 'lightweight',
    });
    mockExecuteHeavyBagSync.mockResolvedValueOnce({
      mode: 'sync',
      response: 'RESEARCH NEEDED — no verified evidence was supplied.',
      routing: { model: { displayName: 'Test Heavy Model' } } as never,
      sessionType: 'heavy_bag',
    });

    const response = await POST(postRequest({
      message: 'Thoughts?',
      sessionType: 'heavy_bag',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.sessionType).toBe('heavy_bag');
    // The badge now matches the model that answered.
    expect(payload.tier).toBe('heavy_bag');
    expect(mockExecuteHeavyBagSync).toHaveBeenCalled();
  });

  test('without an override the classifier tier is unchanged', async () => {
    // The realignment must be a no-op on the ordinary path: ShadowTier has
    // exactly two values and the mapping round-trips, so a request carrying no
    // sessionType must still report exactly what the classifier decided.
    mockClassifyRequest.mockReturnValueOnce({
      tier: 'quick_round',
      complexity: 0.2,
      topic: 'general',
      confidence: 1,
      reasoning: 'Short message',
      requiresManualOverride: false,
      suggestedContextDepth: 'lightweight',
    });

    const response = await POST(postRequest({ message: 'Thoughts?' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.tier).toBe('quick_round');
  });

  test('returns a degraded state and never reads or logs a provider response body', async () => {
    const providerText = jest.fn(async () => 'SECRET_PROVIDER_BODY');
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: providerText,
    }) as unknown as typeof fetch;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(postRequest({ message: 'What should we review today?' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(false);
    expect(payload.state).toBe('degraded');
    expect(payload.response).toContain('temporarily unavailable');
    expect(providerText).not.toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('SECRET_PROVIDER_BODY');
    expect(mockUpdateProfile).not.toHaveBeenCalled();
    expect(mockResolveConversation).not.toHaveBeenCalled();
    expect(mockAppendConversationExchange).not.toHaveBeenCalled();
  });

  test('returns an explicit filtered state when athlete context is unauthorized', async () => {
    mockRetrieveShadowContext.mockResolvedValueOnce({
      authorized: false,
      context: '',
      reason: 'Not authorized to access this athlete context.',
    });

    const response = await POST(postRequest({
      message: 'Show me this athlete.',
      athleteId: 'athlete-other',
    }));
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.success).toBe(false);
    expect(payload.state).toBe('filtered');
    expect(global.fetch).toBe(originalFetch);
  });
});

describe('the guardian gate on a client-supplied athlete id', () => {
  // ParentHub tells a guardian the chat is "scoped to your family". route.ts:608
  // is what makes that true for an athlete id the CLIENT sends -- and until
  // this block existed nothing measured it. assertActorCanAccessAthlete is
  // mocked for this whole file (a bare jest.fn() that resolves), so every other
  // test here runs with that gate stubbed open. What the real function does for
  // a parent is covered against real Postgres by guardianAccess.test.ts and
  // softDeletedAthleteAccess.pg.test.ts; what was never covered is whether this
  // route calls it, with the caller's value, and refuses when it says no.
  const mockAssertAccess = jest.mocked(assertActorCanAccessAthlete);

  /* Two of these three requests get PAST the gate, which is the point of
     them -- and past the gate is the provider path. afterEach restores the
     real global.fetch, so without a stub those cases reach out to the
     configured provider host for real and their runtime becomes a property
     of the environment's DNS rather than of the code. It resolves instantly
     in some sandboxes and hangs to Jest's 5s timeout in others, which is a
     flake that would surface as an authorization test failing for reasons
     that have nothing to do with authorization. Returning it also lets the
     refusal case assert the provider was never CALLED, which is what its
     name claims -- retrieveShadowContext not running is a different fact. */
  function stubProvider(): jest.Mock {
    const providerFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Stubbed provider answer.' } }] }),
    });
    global.fetch = providerFetch as unknown as typeof fetch;
    return providerFetch;
  }

  test('a parent naming an athlete they do not hold is refused, and no provider call is made', async () => {
    const providerFetch = stubProvider();
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent', accountId: 'guardian-acct-1', athleteId: null }));
    // The message the real gate throws for exactly this case.
    mockAssertAccess.mockRejectedValueOnce(new Error('Forbidden: parent not linked to athlete'));

    const response = await POST(postRequest({
      message: 'How is this athlete doing?',
      athleteId: 'athlete-someone-elses-child',
    }));

    expect(response.status).toBe(403);
    // The refusal has to land before the model sees the request, not after.
    expect(mockRetrieveShadowContext).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  test('the id checked is the one the client sent, not one the server picked', async () => {
    // A gate called with a server-derived id would pass this file's other
    // tests and still authorize nothing about the athlete actually requested.
    stubProvider();
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent', accountId: 'guardian-acct-1', athleteId: null }));

    await POST(postRequest({
      message: 'How is my child doing?',
      athleteId: 'athlete-linked-1',
    }));

    expect(mockAssertAccess).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'guardian-acct-1', role: 'parent' }),
      'athlete-linked-1',
    );
  });

  test('a request naming no athlete does not invoke the gate at all', async () => {
    // The generic parent mode. Nothing to authorize, so an assertion here
    // would be authorizing a blank -- and a gate that ran on undefined would
    // be the kind that quietly passes.
    stubProvider();
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent', accountId: 'guardian-acct-1', athleteId: null }));

    await POST(postRequest({ message: 'How do I support a nervous kid before a show?' }));

    expect(mockAssertAccess).not.toHaveBeenCalled();
  });
});

describe('SHADOW chat readiness guard', () => {
  // Production was missing shadow_rate_limit_buckets, shadow_chat_sessions and
  // shadow_chat_messages. Because chat had no readiness guard, the very first
  // write -- the rate-limit bucket insert -- raised Postgres 42P01, which
  // jsonError rendered as a generic 500. Every SHADOW chat request failed, and
  // the cause was invisible in the response. These assertions keep chat from
  // regressing back to an opaque failure.
  const mockReadiness = jest.mocked(assertShadowRuntimeReadiness);

  test('returns 503, not 500, when the SHADOW schema is not migrated', async () => {
    mockReadiness.mockRejectedValueOnce(new ShadowRuntimeUnavailableError({
      missingTables: ['shadow_rate_limit_buckets', 'shadow_chat_sessions'],
    }));

    const response = await POST(postRequest({ message: 'How do I improve footwork?' }));

    expect(response.status).toBe(503);
  });

  test('does not disclose missing table names to the caller', async () => {
    mockReadiness.mockRejectedValueOnce(new ShadowRuntimeUnavailableError({
      missingTables: ['shadow_rate_limit_buckets'],
    }));

    const response = await POST(postRequest({ message: 'How do I improve footwork?' }));

    expect(JSON.stringify(await response.json())).not.toContain('shadow_rate_limit_buckets');
  });

  test('fails before touching the rate limiter', async () => {
    // The guard has to run before the first write, otherwise it cannot prevent
    // the 42P01 it exists to convert into an honest status. enforceShadowRateLimit
    // is that first write, so this ordering assertion is the whole point.
    mockReadiness.mockRejectedValueOnce(new ShadowRuntimeUnavailableError({
      missingTables: ['shadow_rate_limit_buckets'],
    }));

    await POST(postRequest({ message: 'How do I improve footwork?' }));

    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  test('requires the tables whose writes are not catch-wrapped', async () => {
    await POST(postRequest({ message: 'How do I improve footwork?' }));

    expect(mockReadiness).toHaveBeenCalledWith({
      requiredTables: expect.arrayContaining([
        'shadow_rate_limit_buckets',
        'shadow_user_profiles',
        'shadow_chat_sessions',
        'shadow_chat_messages',
      ]),
    });
  });
});

describe('SHADOW completion-token budget', () => {
  test.each([
    [undefined, 4096],
    ['', 4096],
    ['not-a-number', 4096],
    ['64', 256],
    ['1025.9', 1025],
    ['99999', 8192],
  ])('bounds %p to %p tokens', (raw, expected) => {
    expect(resolveShadowMaxCompletionTokens(raw)).toBe(expected);
  });

  // Measured, not guessed. The configured gpt-5-mini deployment spent all 1024
  // tokens of the old default on reasoning and returned no content at all, so
  // every SHADOW turn came back degraded; at 2048 it truncated mid-sentence. The
  // observed peak was 2054 completion tokens, so the default must clear it with
  // room to spare or long answers get cut off.
  test('the default clears the measured peak completion spend', () => {
    expect(resolveShadowMaxCompletionTokens(undefined)).toBeGreaterThan(2054);
  });

  test('the ceiling can be raised past the default without a code change', () => {
    expect(resolveShadowMaxCompletionTokens('6000')).toBe(6000);
  });
});

// The Omega cross-organization path had unit coverage on both ends -- the
// renderer and the validator -- but nothing asserting the route actually joins
// them. These cover the four outcomes that matter: no other role can reach the
// block, an in-scope question gets it, an out-of-scope one does not, and a
// failed rollup is disclosed rather than silently dropped.
describe('Omega cross-organization breadth', () => {
  const CROSS_GYM_QUESTION = 'How are all the gyms doing this month?';

  function boardSummaryFixture() {
    return {
      scope: 'organization_aggregate',
      minimumCohortSize: 5,
      generatedAt: '2026-07-28T00:00:00.000Z',
      activeAthletes: { status: 'available', count: 12 },
      trainingSessions30Days: { status: 'available', count: 40, completedCount: 30, completionRate: 0.75 },
      goalStatusBuckets: {
        active: { status: 'available', count: 6 },
        completed: { status: 'available', count: 2 },
        other: { status: 'available', count: 1 },
      },
      coachReviews30Days: { status: 'available', count: 9, approvedCount: 8, approvalRate: 0.888 },
    };
  }

  function growthFixture() {
    return {
      period: '30d',
      totalInteractions: 17,
      avgSatisfaction: null,
      avgEffectiveness: null,
      recommendationsMade: 0,
      researchRequirementsCreated: 0,
      researchRequirementsClosed: 0,
      newLibraryPatterns: 0,
      filterRate: null,
      positiveOutcomeRate: null,
      unavailableReasons: {},
    };
  }

  /** Only the organization listing is answered; every other query stays empty. */
  function organizationsResolve(rows: unknown[]) {
    mockQuery.mockImplementation(async (sql: string) => (
      sql.includes('pilot.organizations') ? rows : []
    ) as never);
  }

  function organizationsReject(error: Error) {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pilot.organizations')) throw error;
      return [] as never;
    });
  }

  function respondWith(content: string) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    }) as unknown as typeof fetch;
  }

  function systemPrompt(): string {
    const requestInit = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    return JSON.parse(String(requestInit.body)).messages[0].content as string;
  }

  beforeEach(() => {
    // The rollup memo is module-level and would otherwise survive between tests.
    clearPlatformRollupCache();
    mockRequirePrincipal.mockResolvedValue(principal({
      role: 'platform_owner',
      organizationId: 'org-platform',
    }));
    mockRetrieveShadowContext.mockResolvedValue({
      authorized: true,
      context: 'Authorized role: platform_owner.',
    });
    mockBoardSummary.mockResolvedValue(boardSummaryFixture() as never);
    mockGrowthMetrics.mockResolvedValue(growthFixture() as never);
    organizationsResolve([
      { organization_id: 'gym-a', organization_name: 'Alpha Boxing', status: 'active', total_count: '1' },
    ]);
    respondWith('Nothing further to report.');
  });

  test('renders the rollup and authorizes its evidence token for the platform owner', async () => {
    const response = await POST(postRequest({ message: CROSS_GYM_QUESTION }));

    expect(response.status).toBe(200);
    const prompt = systemPrompt();
    expect(prompt).toContain('PLATFORM-WIDE CONTEXT (OMEGA SCOPE)');
    expect(prompt).toContain('Alpha Boxing');
    expect(prompt).toContain('active athletes: 12');
    expect(prompt).toContain(`[E:${platformGymEvidenceId('gym-a')}]`);
    expect(prompt).not.toContain('OMEGA SCOPE): UNAVAILABLE');
  });

  // The reason the citable-id design exists: without an authorized token the
  // validator discards every cross-gym answer as an uncited quantity.
  test('a cited cross-gym figure survives response validation', async () => {
    respondWith(`Alpha Boxing has 12 athletes [E:${platformGymEvidenceId('gym-a')}].`);

    const payload = await (await POST(postRequest({ message: CROSS_GYM_QUESTION }))).json();

    expect(payload.state).toBe('ok');
    expect(payload.response).toContain('12 athletes');
    expect(payload.response).not.toBe(SHADOW_SAFE_FILTERED_RESPONSE);
  });

  // Platform ids are authorized for validation only. They are not rows in the
  // evidence bundle, so persisting them would record a citation to an item the
  // evidence tables have never heard of.
  test('does not persist a platform token as an evidence-bundle citation', async () => {
    respondWith(`Alpha Boxing has 12 athletes [E:${platformGymEvidenceId('gym-a')}].`);

    await POST(postRequest({ message: CROSS_GYM_QUESTION }));

    expect(mockAppendConversationExchange).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({ citationIds: [] }),
    }));
  });

  // Audit F3. The tier counted every authorized citation, but only bundle
  // items are rendered as Sources -- so two platform ids and no library
  // document earned PROVEN, the top tier, above an empty Sources list. The
  // grade must never outrun what the reader can actually check.
  test('platform citations do not inflate the evidence tier above an empty source list', async () => {
    // The bundle must be AVAILABLE or deriveEvidenceTier short-circuits to
    // RESEARCH_NEEDED and the assertion below passes for the wrong reason --
    // which is exactly what the first draft of this test did. Available, but
    // carrying no items: the Library returned nothing relevant, and the only
    // citation in the answer is a platform id.
    mockRetrieveEvidence.mockResolvedValueOnce({
      bundleId: '00000000-0000-4000-8000-000000000300',
      availability: 'available',
      allowedEvidenceIds: [],
      context: 'No library excerpt matched.',
      items: [],
    } as never);
    // One platform citation is enough: under the old count that is
    // citationCount 1, which grades EMERGING. It must grade EXPERIMENTAL,
    // because zero library sources are shown.
    respondWith(`Alpha Boxing has 12 athletes [E:${platformGymEvidenceId('gym-a')}].`);

    const payload = await (await POST(postRequest({ message: CROSS_GYM_QUESTION }))).json();

    expect(payload.state).toBe('ok');
    // The citation was authorized and survived validation...
    expect(payload.response).toContain('12 athletes');
    // ...but it is not library evidence, so it is not shown as a source and
    // the tier must not read as though the claim were backed by doctrine.
    expect(payload.citations ?? []).toEqual([]);
    expect(payload.evidenceTier).not.toBe('PROVEN');
    expect(payload.evidenceTier).not.toBe('EMERGING');
  });

  test('no other role reaches the block, even asking the same question', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
    mockRetrieveShadowContext.mockResolvedValue({
      authorized: true,
      context: 'Authorized role: organization_admin.',
    });

    await POST(postRequest({ message: CROSS_GYM_QUESTION }));

    expect(systemPrompt()).not.toContain('PLATFORM-WIDE CONTEXT');
    expect(mockBoardSummary).not.toHaveBeenCalled();
  });

  test('a single-gym question from the platform owner costs no fan-out', async () => {
    await POST(postRequest({ message: 'How is my gym doing this month?' }));

    expect(systemPrompt()).not.toContain('PLATFORM-WIDE CONTEXT');
    expect(mockBoardSummary).not.toHaveBeenCalled();
  });

  // Dropping the block on failure left the model answering a cross-gym question
  // from its single-gym persona with no sign anything was missing.
  test('discloses a failed rollup instead of answering as though nothing is missing', async () => {
    organizationsReject(new Error('db unreachable'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(postRequest({ message: CROSS_GYM_QUESTION }));

    expect(response.status).toBe(200);
    const prompt = systemPrompt();
    expect(prompt).toContain(PLATFORM_SCOPE_UNAVAILABLE_CONTEXT);
    expect(prompt).toContain('Do NOT substitute this gym\'s own figures');
    expect(prompt).not.toContain('Alpha Boxing');
  });

  test('discloses an empty rollup the same way, rather than rendering nothing', async () => {
    organizationsResolve([]);

    await POST(postRequest({ message: CROSS_GYM_QUESTION }));

    expect(systemPrompt()).toContain('OMEGA SCOPE): UNAVAILABLE');
  });
});

describe('background session types via the job worker', () => {
  test('worker disabled: a scout report request is refused with an honest 503, never enqueued', async () => {
    // Pre-worker behavior, now pinned: a queue nothing drains must refuse
    // work, not strand it. This is also the behavior of every environment
    // that has not set PPBF_SHADOW_WORKER_ENABLED.
    const response = await POST(postRequest({
      message: 'Generate a scout report for my training group.',
      sessionType: 'scout_report',
    }));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.state).toBe('degraded');
    expect(payload.error).toBe('Background worker unavailable.');
    expect(mockExecuteHeavyBagAsync).not.toHaveBeenCalled();
  });

  test('worker enabled: the same request enqueues and returns queued with the job id', async () => {
    mockIsShadowWorkerEnabled.mockReturnValue(true);
    mockExecuteHeavyBagAsync.mockResolvedValue({
      mode: 'async',
      jobId: 'job-123',
      routing: {} as never,
      sessionType: 'scout_report',
    });

    const response = await POST(postRequest({
      message: 'Generate a scout report for my training group.',
      sessionType: 'scout_report',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.state).toBe('queued');
    expect(payload.async).toBe(true);
    expect(payload.jobId).toBe('job-123');
    // No model answered yet, so no model may be named.
    expect(payload.modelUsed).toBeUndefined();

    // The enqueue writes pilot.shadow_jobs outside any local catch, so the
    // route must have demanded that table's readiness for this request.
    expect(jest.mocked(assertShadowRuntimeReadiness)).toHaveBeenCalledWith({
      requiredTables: ['shadow_jobs'],
    });

    // The job carries the authenticated actor and session type -- the
    // processor's re-validation depends on this snapshot being right.
    expect(mockExecuteHeavyBagAsync).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'account-1',
      organizationId: 'org-session',
      role: 'coach',
      sessionType: 'scout_report',
    }));

    // Queue-only modes produce documents read from job output, never
    // conversation turns: nothing may be persisted to a conversation.
    expect(mockAppendConversationExchange).not.toHaveBeenCalled();
  });

  test('background Heavy Bag: preferAsync + worker enabled persists the question, snapshots evidence, and queues', async () => {
    mockIsShadowWorkerEnabled.mockReturnValue(true);
    mockAppendUserMessage.mockResolvedValue('user-msg-1');
    mockExecuteHeavyBagAsync.mockResolvedValue({
      mode: 'async',
      jobId: 'job-hb-1',
      routing: {} as never,
      sessionType: 'heavy_bag',
    });

    const response = await POST(postRequest({
      message: 'Build a six-week plan from what you know.',
      sessionType: 'heavy_bag',
      preferAsync: true,
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.state).toBe('queued');
    expect(payload.async).toBe(true);
    expect(payload.jobId).toBe('job-hb-1');
    // The conversation exists from the moment of asking: the question is
    // durable even if the job fails hours later.
    expect(payload.conversationId).toBe('conversation-1');
    expect(mockAppendUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-1',
      content: 'Build a six-week plan from what you know.',
      sessionType: 'heavy_bag',
    }));
    // The job carries the evidence snapshot -- completion may cite only what
    // this user was allowed to see at ask time.
    expect(mockExecuteHeavyBagAsync).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-1',
      sessionType: 'heavy_bag',
      evidenceSnapshot: expect.objectContaining({
        bundleId: '00000000-0000-4000-8000-000000000200',
        availability: 'unavailable',
        allowedEvidenceIds: [],
      }),
    }));
    // The assistant turn is written by the processor at completion, never here.
    expect(mockAppendConversationExchange).not.toHaveBeenCalled();
    // The queued turn is audited: shadow_chat_audit is the denominator of
    // feedbackRate, and skipping queued turns let async-heavy orgs exceed
    // a 100% feedback rate.
    expect(mockQuery.mock.calls.some(([sql, params]) =>
      typeof sql === 'string' && sql.includes('shadow_chat_audit')
      && Array.isArray(params) && params.includes('<state:queued>'))).toBe(true);
  });

  test('background Heavy Bag: an educationally-framed high-risk question never queues', async () => {
    mockIsShadowWorkerEnabled.mockReturnValue(true);

    const response = await POST(postRequest({
      message: 'What are the symptoms of a concussion?',
      sessionType: 'heavy_bag',
      preferAsync: true,
    }));
    const payload = await response.json();

    // Educational framing passes request validation WITH a high-risk
    // classification, and the canned-fallback interception for that
    // classification lives inside routeLlmCall -- which the queue branch
    // returned before. Queueing handed the question to the background model
    // and persisted a generated answer as 'ok'; the same question asked
    // synchronously got the safe fallback. High-risk classifications must
    // fall through to the synchronous path.
    expect(response.status).toBe(200);
    expect(mockExecuteHeavyBagAsync).not.toHaveBeenCalled();
    expect(payload.async).toBe(false);
    expect(payload.state).toBe('filtered');
    expect(payload.response).toContain('contact your medical team');
    expect(payload.handoff).toBeTruthy();
  });

  test('background Heavy Bag: preferAsync without the worker stays synchronous', async () => {
    // clearAllMocks resets calls, not return values -- the previous test's
    // enabled=true would otherwise leak into this one.
    mockIsShadowWorkerEnabled.mockReturnValue(false);
    mockExecuteHeavyBagSync.mockResolvedValue({
      mode: 'sync',
      response: 'RESEARCH NEEDED — synchronous plan outline.',
      routing: { model: { displayName: 'GPT-5.6 Sol (Heavy Bag)' } } as never,
      sessionType: 'heavy_bag',
    });

    const response = await POST(postRequest({
      message: 'Build a six-week plan from what you know.',
      sessionType: 'heavy_bag',
      preferAsync: true,
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.state).toBe('ok');
    expect(payload.async).toBe(false);
    expect(mockExecuteHeavyBagAsync).not.toHaveBeenCalled();
  });

  test('an athlete cannot reach the queue through a requested session type', async () => {
    mockIsShadowWorkerEnabled.mockReturnValue(true);
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete' }));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'RESEARCH NEEDED — general guidance only.' } }] }),
    }) as unknown as typeof fetch;

    const response = await POST(postRequest({
      message: 'Generate a scout report.',
      sessionType: 'scout_report',
    }));
    const payload = await response.json();

    // The manual session-type override is role-gated upstream: for an
    // athlete the requested type is discarded and the message flows down
    // the ordinary quick-round path instead of into the queue.
    expect(response.status).toBe(200);
    expect(payload.state).toBe('ok');
    expect(payload.sessionType).toBe('quick_round');
    expect(mockExecuteHeavyBagAsync).not.toHaveBeenCalled();
  });
});

// The owner's 2026-08-12 decision on the hallucination blocker: an answer with no
// evidence behind it is served and labelled rather than replaced, EXCEPT when the
// Library holds nothing for anyone, which is a platform fault no asker can act on.
//
// These two cases arrive at this code identically -- an empty evidence bundle --
// so the only thing separating them is hasRetrievableLibraryEvidence. That makes
// it worth testing in both directions rather than trusting the branch by reading.
describe('unsupported answers and an empty Library', () => {
  function answerWith(content: string) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    }) as unknown as typeof fetch;
  }

  test('serves the answer, labelled, when the Library has evidence but none matched', async () => {
    answerWith('Keep the rounds short and check in with your coach on the plan.');

    const response = await POST(postRequest({ message: 'How should we structure the round?' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    // 'ok', not 'filtered': the answer is genuinely served. Forcing 'filtered'
    // here is what the blocker used to do, and it also dragged every no-match
    // turn into the human-review queue.
    expect(payload.state).toBe('ok');
    expect(payload.response).toContain('Keep the rounds short');
    expect(payload.evidenceTier).toBe('RESEARCH_NEEDED');
    expect(payload.evidenceNotice).toBe('NO_VERIFIED_EVIDENCE');
  });

  test('never returns the old blocker copy, which read as a crash and named one gym\'s coach', async () => {
    answerWith('Some general guidance with no citation.');

    const response = await POST(postRequest({ message: 'What does the evidence show?' }));
    const payload = await response.json();

    expect(payload.response).not.toContain('CRITICAL LOG ERROR');
    expect(payload.response).not.toContain('hallucination blocker');
    // The name mattered: it went to every asker in every gym on the platform.
    expect(payload.response).not.toContain('Jason');
  });

  test('refuses instead, with honest copy, when the Library holds nothing for anyone', async () => {
    mockHasRetrievableEvidence.mockResolvedValue(false);
    answerWith('Confident guidance drawn from nothing at all.');

    const response = await POST(postRequest({ message: 'How should we structure the round?' }));
    const payload = await response.json();

    expect(payload.state).toBe('filtered');
    expect(payload.response).not.toContain('Confident guidance');
    expect(payload.response).toContain('No verified evidence is loaded in the Library yet');
    // Tells the reader whose problem it is. The old copy told them a log error.
    expect(payload.response).toContain('ask an administrator');
    // The refusal body already explains itself; a second notice would be noise.
    expect(payload.evidenceNotice).toBeUndefined();
  });

  test('does not call the Library probe when evidence was retrieved', async () => {
    mockRetrieveEvidence.mockResolvedValue({
      bundleId: '00000000-0000-4000-8000-000000000201',
      availability: 'available',
      items: [{
        evidenceId: 'ev-1',
        token: 'E1',
        sourceTitle: 'A peer-reviewed source',
        documentName: 'Track A1',
        evidenceClass: 'VERIFIED EVIDENCE',
        authorityTier: 2,
        boxingSpecificity: 'boxing_specific',
      }],
      allowedEvidenceIds: ['ev-1'],
      context: 'EVIDENCE',
    } as never);
    answerWith('An answer.');

    await POST(postRequest({ message: 'What does the evidence show?' }));

    // The probe is an extra query, and it exists only to explain an EMPTY
    // bundle. A turn that retrieved evidence must not pay for it.
    expect(mockHasRetrievableEvidence).not.toHaveBeenCalled();
  });

  test('treats a degraded lookup as an outage, not as an empty Library', async () => {
    // A failed lookup says nothing about what is loaded. Reporting it as
    // emptiness would send every asker to find an administrator over a
    // transient fault -- and the outage notice has to win, because the tier
    // alone cannot tell the two apart.
    mockRetrieveEvidence.mockResolvedValue({
      bundleId: null,
      availability: 'unavailable',
      items: [],
      allowedEvidenceIds: [],
      context: 'EVIDENCE RETRIEVAL UNAVAILABLE',
      retrievalDegraded: true,
    } as never);
    answerWith('General guidance.');

    const response = await POST(postRequest({ message: 'How should we structure the round?' }));
    const payload = await response.json();

    expect(mockHasRetrievableEvidence).not.toHaveBeenCalled();
    expect(payload.state).toBe('ok');
    expect(payload.evidenceNotice).toBe('EVIDENCE_RETRIEVAL_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// Board summaries are refused at the request boundary, not in a worker.
//
// MANUAL_OVERRIDE_ROLES includes coach, so resolveSessionType honored a coach's
// sessionType: 'board_summary'. executeBoardSummaryJob then refused that same
// coach with SHADOW_JOB_SCOPE_FORBIDDEN -- correct authority, one process too
// late. The coach got a queued job that could never run, and learned about it
// as a background failure rather than as an answer.
//
// The worker is ENABLED in these tests deliberately: with it disabled the route
// returns 'degraded' for its own reasons and would pass whether or not the gate
// exists. Enabled is the configuration where the old behaviour actually reached
// the jobs table.
// ---------------------------------------------------------------------------
describe('board summary authority at the request boundary', () => {
  const BOARD_SUMMARY_REFUSAL = 'Not authorized to generate a board summary.';

  beforeEach(() => {
    mockIsShadowWorkerEnabled.mockReturnValue(true);
  });

  test('a coach asking for a board summary is refused 403', async () => {
    const response = await POST(postRequest({
      message: 'Summarize governance items for the board.',
      sessionType: 'board_summary',
    }));

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe(BOARD_SUMMARY_REFUSAL);
    expect(body.success).toBe(false);
  });

  test('the refusal happens before the jobs table is touched', async () => {
    await POST(postRequest({
      message: 'Summarize governance items for the board.',
      sessionType: 'board_summary',
    }));

    // The route probes shadow_jobs readiness immediately before enqueueing.
    // That probe never running is what "refused before enqueue" means here --
    // there is no job row to fail later.
    expect(jest.mocked(assertShadowRuntimeReadiness)).not.toHaveBeenCalledWith(
      expect.objectContaining({ requiredTables: ['shadow_jobs'] }),
    );
  });

  test('the refusal costs no model call', async () => {
    // Installed here rather than relied upon: this suite leaves global.fetch
    // real unless a test replaces it, and asserting "not called" against a
    // non-mock silently passes nothing.
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    await POST(postRequest({
      message: 'Summarize governance items for the board.',
      sessionType: 'board_summary',
    }));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // The failure mode a lenient fix would introduce: quietly answering the
  // question as ordinary chat. The caller asked for a governance summary; a
  // Quick Round answer is a different, less governed thing, and returning one
  // without saying so is worse than refusing.
  test('an unauthorized board summary is refused, never downgraded to ordinary chat', async () => {
    const response = await POST(postRequest({
      message: 'Summarize governance items for the board.',
      sessionType: 'board_summary',
    }));

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.state).toBe('filtered');
    expect(body.tier).not.toBe(undefined);
    // No assistant answer was produced for a request that was refused.
    expect(mockAppendConversationExchange).not.toHaveBeenCalled();
  });

  test.each(['admin', 'organization_admin', 'platform_owner'] as const)(
    '%s passes the board summary gate',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role }));

      const response = await POST(postRequest({
        message: 'Summarize governance items for the board.',
        sessionType: 'board_summary',
      }));

      // Asserting on the refusal itself rather than on the status, so an
      // unrelated gate failing later cannot be mistaken for this one passing.
      const body = await response.json();
      expect(body.error).not.toBe(BOARD_SUMMARY_REFUSAL);
    },
  );

  // resolveSessionType discards requestedSessionType for any role outside
  // MANUAL_OVERRIDE_ROLES, so these roles asked for a governance summary and
  // were answered as ordinary chat. Gating on the RESOLVED type alone refused
  // the coach and kept downgrading everyone further from the data -- the same
  // silent substitution, just quieter.
  test.each(['athlete', 'parent', 'staff', 'volunteer'] as const)(
    '%s explicitly asking for a board summary is refused, not answered as ordinary chat',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role }));

      const response = await POST(postRequest({
        message: 'Summarize governance items for the board.',
        sessionType: 'board_summary',
      }));

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe(BOARD_SUMMARY_REFUSAL);
    },
  );

  // A 403 that pre-empts "chest pain" answers the wrong question about the
  // wrong thing. The authorization refusal defers to the high-risk path, which
  // queues a human review and hands off -- the authorization failure is still
  // true, and still less urgent.
  test('an urgent symptom in an unauthorized board summary reaches the high-risk path, not the 403', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const response = await POST(postRequest({
      message: 'I have chest pain right now, should I keep training?',
      sessionType: 'board_summary',
    }));

    const body = await response.json();

    // The safety boundary owns this request outright.
    expect(response.status).toBe(400);
    expect(body.error).not.toBe(BOARD_SUMMARY_REFUSAL);
    expect(body.state).toBe('filtered');
    expect(body.requiresHumanReview).toBe(true);
    expect(body.highRiskTopic).toBe('chest_pain');

    // Escalated at the severity the REAL classifier earns, not the one I
    // assumed: validateShadowRequest classifies this as
    // 'personal_health_concern', which is 'high' rather than 'critical' -- the
    // four critical classifications are chest_pain, fainting,
    // loss_of_consciousness and urgent_personal_symptom as CLASSIFICATIONS, and
    // 'chest_pain' here is the TOPIC. Pinning the real values so a change to
    // either mapping is visible.
    expect(mockQueueHumanReview).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'chest_pain',
        severity: 'high',
        metadata: expect.objectContaining({
          sessionType: 'board_summary',
          validationClassification: 'personal_health_concern',
        }),
      }),
    );

    // AND IT GOT THERE FIRST. Deferring the 403 was only half the fix: the
    // generic safety handler sits below the board/scout worker branch, so
    // without the early branch this request still probed shadow_jobs, and on an
    // unconfigured worker returned a 503 about background modes instead of the
    // handoff. The worker is ENABLED in this describe block, so the probe would
    // fire if the ordering were wrong.
    expect(jest.mocked(assertShadowRuntimeReadiness)).not.toHaveBeenCalledWith(
      expect.objectContaining({ requiredTables: ['shadow_jobs'] }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Coach keeps every other manual override. This slice narrowed one session
  // type; if it had narrowed the concept, this would fail.
  test('a coach can still choose Heavy Bag', async () => {
    const response = await POST(postRequest({
      message: 'How can our footwork rotation improve?',
      sessionType: 'heavy_bag',
    }));

    const body = await response.json();
    expect(body.error).not.toBe(BOARD_SUMMARY_REFUSAL);
    expect(response.status).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
// SHADOW pre-generation safety precedence
//
// THE CONTRACT. Once a request has passed every gate that decides whether the
// caller may talk to SHADOW at all -- authentication, structural validation,
// core runtime readiness, the global chat and daily abuse limits, and
// athlete/conversation authorization -- no CAPABILITY or COST refusal may
// answer an urgent symptom. What is left below that point is a question about
// features, and a feature answer is the wrong reply to chest pain.
//
// WHY IT IS A MATRIX. This defect has been introduced three times by three
// authors in the same file. The board-summary refusal jumped the safety
// handler; the fix for it jumped the worker-readiness probe as well; and the
// audit that followed found the same shape already on main at the Film Study /
// Recovery Round refusal and the Scout worker probe. Guarding one branch at a
// time is what produced that history.
//
// EVERY ROW HAS A POSITIVE CONTROL, and that is not decoration. A row whose
// setup silently stopped reaching its branch would still return the safety
// response for the urgent case and pass -- green for the wrong reason, which is
// the exact defect class that shipped in this slice's predecessor. The benign
// case proves the branch fires; only then does the urgent case mean anything.
// ---------------------------------------------------------------------------

const URGENT_MESSAGE = 'I have chest pain right now, should I keep training?';
const BENIGN_MESSAGE = 'What does a good footwork rotation look like?';

type PrecedenceRow = {
  readonly branch: string;
  readonly role: PilotPrincipal['role'];
  readonly sessionType: string;
  readonly workerEnabled: boolean;
  readonly capHeavyBag?: true;
  /** Proves the branch under test actually fired for a benign message. */
  readonly benign: (body: Record<string, unknown>, status: number) => void;
};

const PRECEDENCE_ROWS: readonly PrecedenceRow[] = [
  {
    branch: 'board-summary authority refusal',
    role: 'coach',
    sessionType: 'board_summary',
    workerEnabled: true,
    benign: (body, status) => {
      expect(status).toBe(403);
      expect(body.error).toBe('Not authorized to generate a board summary.');
    },
  },
  {
    branch: 'Heavy Bag hourly cap',
    role: 'coach',
    sessionType: 'heavy_bag',
    workerEnabled: true,
    capHeavyBag: true,
    benign: (body, status) => {
      expect(status).toBe(429);
      expect(body.error).toBe('Rate limit exceeded.');
    },
  },
  {
    branch: 'Film Study not available in chat',
    role: 'coach',
    sessionType: 'film_study',
    workerEnabled: true,
    benign: (body, status) => {
      expect(status).toBe(400);
      expect(body.error).toBe('The requested SHADOW session type is not available from chat.');
    },
  },
  {
    branch: 'Recovery Round not available in chat',
    role: 'coach',
    sessionType: 'recovery_round',
    workerEnabled: true,
    benign: (body, status) => {
      expect(status).toBe(400);
      expect(body.error).toBe('The requested SHADOW session type is not available from chat.');
    },
  },
  {
    branch: 'Scout worker unavailable',
    role: 'coach',
    sessionType: 'scout_report',
    workerEnabled: false,
    benign: (body, status) => {
      expect(status).toBe(503);
      expect(body.error).toBe('Background worker unavailable.');
    },
  },
  {
    branch: 'board worker unavailable, authorized actor',
    role: 'organization_admin',
    sessionType: 'board_summary',
    workerEnabled: false,
    benign: (body, status) => {
      expect(status).toBe(503);
      expect(body.error).toBe('Background worker unavailable.');
    },
  },
];

describe('SHADOW pre-generation safety precedence', () => {
  function arrange(row: PrecedenceRow): jest.Mock {
    mockRequirePrincipal.mockResolvedValue(principal({ role: row.role }));
    mockIsShadowWorkerEnabled.mockReturnValue(row.workerEnabled);
    if (row.capHeavyBag) {
      // Only the Heavy Bag tier cap trips. The two GLOBAL limits must still
      // pass, because this contract deliberately does not put safety ahead of
      // them -- a caller must not buy a throttle exemption by typing a symptom.
      mockEnforceRateLimit.mockImplementation(async (input) => {
        if (input?.endpointKey === 'heavy_bag') {
          throw new ShadowRateLimitExceeded(1800, 'heavy_bag');
        }
      });
    }
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    return fetchSpy;
  }

  describe.each(PRECEDENCE_ROWS)('$branch', (row) => {
    it('POSITIVE CONTROL: the branch fires for a benign message', async () => {
      arrange(row);

      const response = await POST(postRequest({
        message: BENIGN_MESSAGE,
        sessionType: row.sessionType,
      }));

      row.benign(await response.json(), response.status);
    });

    it('an urgent symptom beats it', async () => {
      const fetchSpy = arrange(row);

      const response = await POST(postRequest({
        message: URGENT_MESSAGE,
        sessionType: row.sessionType,
      }));
      const body = await response.json();

      // The safety boundary owns the request.
      expect(response.status).toBe(400);
      expect(body.state).toBe('filtered');
      expect(body.requiresHumanReview).toBe(true);
      expect(body.highRiskTopic).toBe('chest_pain');
      expect(mockQueueHumanReview).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'chest_pain', severity: 'high' }),
      );

      // And the branch under test did NOT get to answer instead.
      expect(body.error).not.toBe('Not authorized to generate a board summary.');
      expect(body.error).not.toBe('The requested SHADOW session type is not available from chat.');
      expect(body.error).not.toBe('Background worker unavailable.');
      expect(body.error).not.toBe('Rate limit exceeded.');

      // Nor did anything downstream of it run: no jobs-table probe, no model.
      expect(jest.mocked(assertShadowRuntimeReadiness)).not.toHaveBeenCalledWith(
        expect.objectContaining({ requiredTables: ['shadow_jobs'] }),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // The other half of the contract, and the reason it is a PRECEDENCE rule
  // rather than "safety always wins".
  //
  // These gates decide whether the caller may be here at all. Safety must not
  // become a way around them: a tenant boundary or a global throttle that an
  // urgent word could unlock would be a bypass, not a safeguard. The global
  // limits are also what stop the human-review queue being written to without
  // bound, so "a safety response costs no model tokens" is not "costs nothing".
  //
  // PINNED EXECUTABLY, NOT JUST CLASSIFIED. Guarding only the lower side would
  // let a future edit drag the chokepoint up across these gates with the
  // SAFETY_FIRST matrix still green. Each row proves its own gate fired, and
  // every row proves the safety handler did NOT run first.
  //
  // THE OBSERVABLE CHANGED WITH THE HUMAN-REVIEW FOUNDATION. It used to be
  // "no review row was queued", because main's only review write for an
  // urgent message was inside the safety handler. An authorized high-risk
  // request is now owed its review row whatever then refuses it, so for
  // readiness and the two chat limits a row IS written -- by POST, at the
  // exit. What still must not happen is the safety handler answering: the
  // response is the gate's own, never the emergency line, and the row does
  // not say the boundary withheld the request. The two AUTHORIZATION gates
  // are unchanged: no row.
  describe('gates that safety does NOT outrank', () => {
    const EMERGENCY_LINE = 'Potential emergency';
    const WITHHELD_BY_BOUNDARY = 'A SHADOW chat request was withheld by the pre-generation safety boundary.';
    const expectGateAnsweredNotSafety = (body: { response?: string }) => {
      expect(String(body.response)).not.toContain(EMERGENCY_LINE);
      expect(mockQueueHumanReview).toHaveBeenCalledTimes(1);
      expect(mockQueueHumanReview.mock.calls[0]?.[0].summary).not.toBe(WITHHELD_BY_BOUNDARY);
    };
    afterEach(() => {
      jest.mocked(assertActorCanAccessAthlete).mockReset();
      jest.mocked(assertConversationAccess).mockReset();
      mockEnforceRateLimit.mockReset();
    });

    it('core runtime readiness still refuses an urgent message', async () => {
      const readiness = jest.mocked(assertShadowRuntimeReadiness);
      readiness.mockRejectedValueOnce(new Error('SHADOW runtime not ready'));

      const response = await POST(postRequest({ message: URGENT_MESSAGE }));

      expect(readiness).toHaveBeenCalled();
      expect(response.status).toBeGreaterThanOrEqual(500);
      expectGateAnsweredNotSafety(await response.json());
    });

    it('the global chat rate limit still refuses an urgent message', async () => {
      mockEnforceRateLimit.mockImplementation(async (input) => {
        if (input?.endpointKey === 'chat') {
          throw new ShadowRateLimitExceeded(60, 'chat');
        }
      });

      const response = await POST(postRequest({ message: URGENT_MESSAGE }));
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toBe('Rate limit exceeded.');
      expectGateAnsweredNotSafety(body);
    });

    // Distinct from the row above on purpose. A test that throws on "the first
    // non-Heavy-Bag limiter call" only ever exercises `chat`, so moving the
    // chokepoint BETWEEN the two global limits would leave it green while
    // chat_daily silently became SAFETY_FIRST. Here `chat` resolves and only
    // the daily limit throws.
    it('the global daily rate limit still refuses an urgent message', async () => {
      const seen: string[] = [];
      mockEnforceRateLimit.mockImplementation(async (input) => {
        seen.push(String(input?.endpointKey));
        if (input?.endpointKey === 'chat_daily') {
          throw new ShadowRateLimitExceeded(3_600, 'chat_daily');
        }
      });

      const response = await POST(postRequest({ message: URGENT_MESSAGE }));
      const body = await response.json();

      // Proves the daily limit was actually reached rather than the request
      // dying at the chat limit.
      expect(seen).toContain('chat');
      expect(seen).toContain('chat_daily');
      expect(response.status).toBe(429);
      expect(body.error).toBe('Rate limit exceeded.');
      expectGateAnsweredNotSafety(body);
    });

    it('athlete authorization still refuses an urgent message', async () => {
      const accessCheck = jest.mocked(assertActorCanAccessAthlete);
      accessCheck.mockRejectedValue(new Error('Forbidden: athlete cannot access another athlete record'));

      const response = await POST(postRequest({
        message: URGENT_MESSAGE,
        athleteId: 'athlete-not-mine',
      }));

      expect(accessCheck).toHaveBeenCalled();
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(mockQueueHumanReview).not.toHaveBeenCalled();
    });

    it('conversation authorization still refuses an urgent message', async () => {
      const conversationCheck = jest.mocked(assertConversationAccess);
      conversationCheck.mockRejectedValue(new Error('SHADOW_CONVERSATION_NOT_FOUND'));

      const response = await POST(postRequest({
        message: URGENT_MESSAGE,
        conversationId: '00000000-0000-4000-8000-0000000009ff',
      }));
      const body = await response.json();

      expect(conversationCheck).toHaveBeenCalled();
      expect(response.status).toBe(404);
      expect(body.error).toBe('Not found');
      expect(mockQueueHumanReview).not.toHaveBeenCalled();
    });
  });
});

describe('a question over the length limit', () => {
  // It used to share a branch with the empty question, so a coach who pasted
  // a long question was told "Enter a question for SHADOW." -- a false reason,
  // and no way to learn what was actually wrong.
  test('is refused as too long, naming the limit, not as an empty question', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;

    const response = await POST(postRequest({ message: 'a'.repeat(12_001) }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.state).toBe('filtered');
    expect(payload.response).toBe(
      'That question is too long for SHADOW (limit 12,000 characters). Shorten it and send again.',
    );
    expect(payload.response).not.toContain('Enter a question');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  test('a question exactly at the limit is not refused for its length', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'RESEARCH NEEDED — no verified evidence was supplied.' } }] }),
    }) as unknown as typeof fetch;

    const response = await POST(postRequest({ message: 'a'.repeat(12_000) }));

    expect(response.status).toBe(200);
  });

  test('an empty question still gets the empty-question reply', async () => {
    const response = await POST(postRequest({ message: '   ' }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.response).toBe('Enter a question for SHADOW.');
  });
});
