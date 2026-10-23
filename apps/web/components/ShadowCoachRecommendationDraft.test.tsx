/**
 * @jest-environment jsdom
 */

// The coach's SHADOW F2 panel: what it asks the server for, what a no-draft
// answer says, and that Save sends only the signed preview (never text the
// browser could have edited).

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import ShadowCoachRecommendationDraft from './ShadowCoachRecommendationDraft';

const ENDPOINT = '/api/pilot/shadow/recommendations/draft';
const CHOICE = {
  resultId: 'res-1', formulaId: 'MVP-03', outputKey: 'accuracy', value: 45, unit: 'percent',
  computedAt: '2026-10-20T10:00:00.000Z', validationState: 'valid', warnings: [], inputObservationIds: ['obs-1'],
};
const PREVIEW = {
  status: 'unpersisted_needs_coach_review', previewToken: 'signed.preview', draftId: 'draft-1',
  recommendationText: 'Repeat the pivot drill with feedback.', expectedOutcome: 'Pivot finishes on balance.',
  modelUsed: 'stub-model', citations: [{ chunkId: 'chunk-1', sourceTitle: 'Footwork study', documentName: 'Chapter 2' }],
};

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let posts: Array<Record<string, unknown>>;
let gets: string[];

function serve(onPost: (body: Record<string, unknown>) => Response) {
  posts = [];
  gets = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      return onPost(body);
    }
    gets.push(String(input));
    return respond({ ok: true, choices: [CHOICE], origins: {} });
  }) as unknown as typeof fetch;
}

async function askForDraft() {
  await screen.findByRole('option', { name: /MVP-03 \/ accuracy/ });
  fireEvent.change(screen.getByLabelText('Current measurement'), { target: { value: 'res-1' } });
  fireEvent.change(screen.getByLabelText('Coaching question'), { target: { value: 'What next?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate draft for coach review' }));
}

afterEach(() => {
  jest.restoreAllMocks();
});

test("reads this athlete's current measurements", async () => {
  serve(() => respond({ ok: true }));
  render(<ShadowCoachRecommendationDraft athleteId="ath-1" onSaved={() => {}} />);
  await screen.findByRole('option', { name: /MVP-03 \/ accuracy/ });
  expect(gets).toEqual([`${ENDPOINT}?athleteId=ath-1`]);
});

test.each([
  ['no_eligible_evidence', 'The Library has nothing on that yet, so SHADOW made no draft and cited nothing.'],
  // Passages came back for these two, so the screen must not say the Library has nothing.
  ['no_supported_answer', 'SHADOW has no draft it can offer for this question, so it made none and cited nothing.'],
  ['filtered_draft', 'SHADOW has no draft it can offer for this question, so it made none and cited nothing.'],
] as const)(
  'a %s answer says so plainly, shows no citation and offers no Save',
  async (reason, words) => {
    serve(() => respond({ ok: false, state: 'no_draft', reason }, 422));
    render(<ShadowCoachRecommendationDraft athleteId="ath-1" onSaved={() => {}} />);
    await askForDraft();
    expect((await screen.findByRole('alert')).textContent).toBe(words);
    expect(posts).toEqual([{ action: 'draft', athleteId: 'ath-1', formulaResultId: 'res-1', coachQuestion: 'What next?' }]);
    expect(screen.queryByRole('button', { name: 'Save as provisional' })).toBeNull();
    expect(screen.queryByText(/Cited sources/)).toBeNull();
  },
);

test('Save sends only the signed preview, then reports it saved as provisional', async () => {
  const onSaved = jest.fn();
  serve((body) => (body.action === 'draft'
    ? respond({ ok: true, preview: PREVIEW })
    : respond({ ok: true, recommendation: { recommendation_id: 'rec-1', athlete_id: 'ath-1', status: 'provisional' } })));
  render(<ShadowCoachRecommendationDraft athleteId="ath-1" onSaved={onSaved} />);
  await askForDraft();
  expect(await screen.findByText(PREVIEW.recommendationText)).toBeTruthy();
  expect(screen.getByText(/Footwork study/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Save as provisional' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(posts[1]).toEqual({ action: 'save', athleteId: 'ath-1', previewToken: 'signed.preview' });
  expect(screen.getByRole('status').textContent).toContain('Saved as provisional.');
});

test('Discard clears the preview without a request', async () => {
  serve(() => respond({ ok: true, preview: PREVIEW }));
  render(<ShadowCoachRecommendationDraft athleteId="ath-1" onSaved={() => {}} />);
  await askForDraft();
  await screen.findByText(PREVIEW.recommendationText);
  fireEvent.click(screen.getByRole('button', { name: 'Discard preview' }));
  expect(screen.queryByText(PREVIEW.recommendationText)).toBeNull();
  expect(posts).toHaveLength(1);
});

test('stays away for anyone the route does not admit (404), such as a gym admin', async () => {
  global.fetch = jest.fn(async () => respond({ error: 'Not found' }, 404)) as unknown as typeof fetch;
  const { container } = render(<ShadowCoachRecommendationDraft athleteId="ath-1" onSaved={() => {}} />);
  await waitFor(() => expect(container.innerHTML).toBe(''));
  expect(screen.queryByRole('alert')).toBeNull();
});

test.each([
  ['limits_not_set', 'coach-set limits are not all set yet', 422],
  ['limits_unavailable', 'coach-set limits could not be read', 503],
  ['preview_unavailable', 'SHADOW drafts are unavailable right now', 503],
] as const)('a %s answer says so plainly and offers no Save', async (reason, words, status) => {
  serve(() => respond({ ok: false, state: 'no_draft', reason }, status));
  render(<ShadowCoachRecommendationDraft athleteId="ath-1" onSaved={() => {}} />);
  await askForDraft();
  expect((await screen.findByRole('alert')).textContent).toContain(words);
  expect(screen.queryByRole('button', { name: 'Save as provisional' })).toBeNull();
});
