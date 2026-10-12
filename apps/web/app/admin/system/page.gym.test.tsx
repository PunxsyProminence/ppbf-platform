/**
 * @jest-environment jsdom
 */

// The gym's /admin/system (WO-N7-03 PR B, N7-03-Q1 A): an organization admin sees this gym's local
// findings, citation checks and retraction checks, read through the existing server functions for
// their own organization only. What these pin: the filters reach those functions and nothing else
// does; an empty read says "None recorded." and a failed one never does; values print as stored
// (no percentage, no invented figure); no account id or supporting record id reaches the page; the
// page writes nothing; and the gym sees no route or job inventory.

import type { ReactElement } from 'react';
import { render, screen, within } from '@testing-library/react';

import AdminSystemPage from './page';

jest.mock('@/src/server/pilot/pageGuard', () => ({
  requirePageRole: async () => ({ accountId: 'acct_1', organizationId: 'org_1', role: 'organization_admin' }),
}));

type Answer = unknown[] | 'fail';
const answers: { findings: Answer; citations: Answer; retractions: Answer } = { findings: [], citations: [], retractions: [] };
const calls: { findings: unknown[][]; citations: unknown[][]; retractions: unknown[][] } = { findings: [], citations: [], retractions: [] };

function answer(key: keyof typeof answers, args: unknown[]) {
  calls[key].push(args);
  const value = answers[key];
  return value === 'fail' ? Promise.reject(new Error('database unavailable')) : Promise.resolve(value);
}

jest.mock('@/src/server/pilot/localFindings', () => ({
  listLocalFindings: (...args: unknown[]) => answer('findings', args),
}));
jest.mock('@/src/server/pilot/sourceCitationChecks', () => ({
  getSourceCitationStatus: (...args: unknown[]) => answer('citations', args),
}));
jest.mock('@/src/server/pilot/sourceRetractionChecks', () => ({
  getSourceRetractionStatus: (...args: unknown[]) => answer('retractions', args),
}));

const FINDING = {
  finding_id: 'lf_1',
  title: 'Late guard drop',
  statement: 'Hands drop in the third round.',
  domain: 'technical',
  local_tier: 'local_pattern',
  status: 'active',
  athletes_observed: 6,
  observation_span_days: 40,
  independent_observers: 2,
  supporting_activity_ids: ['act_secret_1'],
  supporting_assessment_ids: ['asmt_secret_1'],
  prediction_outcome: null,
  agrees_with_literature: 'agrees',
  raised_by_account_id: 'acct_coach_secret',
  reviewed_by_account_id: 'acct_admin_secret',
};

const CITATION = {
  source_id: 'src_1',
  claimed_title: 'Punch kinematics in amateur boxing',
  identifier_kind: 'doi',
  identifier_value: '10.1000/xyz',
  outcome: 'resolved_title_match',
  retrieved_title: 'Punch kinematics in amateur boxing',
  match_method: 'title_overlap',
  match_score: 0.83,
  checked_at: '2026-10-01T10:00:00Z',
  review_signal: 'ok',
};

const RETRACTION = {
  source_id: 'src_2',
  title: 'An older study',
  status: 'retracted',
  notice_type: 'retraction',
  notice_date: '2026-09-02',
  disposition: null,
  dependent_chunks: 3,
  checked_at: '2026-10-02T10:00:00Z',
  action_signal: 'urgent_unhandled',
};

async function renderGym(params: Record<string, string> = {}) {
  const page = (await AdminSystemPage({ searchParams: Promise.resolve(params) })) as ReactElement<Record<string, unknown>>;
  const view = page.type as (props: Record<string, unknown>) => Promise<ReactElement>;
  render(await view(page.props));
}

function section(name: string): HTMLElement {
  return screen.getByRole('heading', { name }).closest('section') as HTMLElement;
}

beforeEach(() => {
  answers.findings = [];
  answers.citations = [];
  answers.retractions = [];
  calls.findings = [];
  calls.citations = [];
  calls.retractions = [];
});

test('the filters reach the existing reads, for this gym only', async () => {
  await renderGym({ domain: 'safety', local_tier: 'local_pattern', status: 'active', review_signal: 'needs_adjudication' });
  expect(calls.findings).toEqual([['org_1', { domain: 'safety', localTier: 'local_pattern', status: 'active' }]]);
  expect(calls.citations).toEqual([['org_1', { reviewSignal: 'needs_adjudication' }]]);
  expect(calls.retractions).toEqual([['org_1']]);
});

test('a filter value that is not one of the known words is no filter', async () => {
  await renderGym({ domain: "safety' or 1=1", local_tier: 'gold', review_signal: 'everything' });
  expect(calls.findings).toEqual([['org_1', { domain: undefined, localTier: undefined, status: undefined }]]);
  expect(calls.citations).toEqual([['org_1', { reviewSignal: undefined }]]);
});

test('an empty read says None recorded', async () => {
  await renderGym();
  for (const name of ['Local findings', 'Citation checks', 'Retraction checks']) {
    expect(within(section(name)).getByText('None recorded.')).toBeTruthy();
  }
});

test('a failed read says it could not be read, never none, and the other sections still show', async () => {
  answers.findings = 'fail';
  answers.citations = [CITATION];
  await renderGym();
  expect(within(section('Local findings')).getByText('This could not be read just now.')).toBeTruthy();
  expect(within(section('Local findings')).queryByText('None recorded.')).toBeNull();
  expect(within(section('Citation checks')).getAllByRole('row')).toHaveLength(2);
});

test('a finding shows its tier, counts and evidence words, and no account or record id', async () => {
  answers.findings = [FINDING];
  await renderGym();
  const row = within(within(section('Local findings')).getByRole('table')).getAllByRole('row')[1];
  const cells = within(row).getAllByRole('cell').map((cell) => cell.textContent);
  expect(cells).toEqual([
    'Late guard dropHands drop in the third round.',
    'technical',
    'local pattern',
    'active',
    '6, over 40 days, by 2 observers',
    'None recorded',
    'agrees',
  ]);
  const text = document.body.textContent ?? '';
  for (const secret of ['acct_coach_secret', 'acct_admin_secret', 'act_secret_1', 'asmt_secret_1']) {
    expect(text).not.toContain(secret);
  }
});

test('a citation check prints its score as stored, never as a percentage, and a missing one as missing', async () => {
  answers.citations = [CITATION, { ...CITATION, source_id: 'src_3', match_score: null, match_method: null, retrieved_title: null }];
  await renderGym();
  const rows = within(within(section('Citation checks')).getByRole('table')).getAllByRole('row').slice(1);
  const first = within(rows[0]).getAllByRole('cell').map((cell) => cell.textContent);
  expect(first).toEqual([
    'Punch kinematics in amateur boxing',
    'doi: 10.1000/xyz',
    'resolved title match',
    'Punch kinematics in amateur boxing',
    'title overlap',
    '0.83',
    '2026-10-01',
    'ok',
  ]);
  const second = within(rows[1]).getAllByRole('cell').map((cell) => cell.textContent);
  expect(second[3]).toBe('None recorded');
  expect(second[4]).toBe('None recorded');
  expect(second[5]).toBe('None recorded');
  expect(section('Citation checks').textContent).not.toContain('%');
});

test('a retraction check shows its result and that no decision is recorded yet', async () => {
  answers.retractions = [RETRACTION];
  await renderGym();
  const row = within(within(section('Retraction checks')).getByRole('table')).getAllByRole('row')[1];
  expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
    'An older study',
    'retracted',
    'retraction, 2026-09-02',
    'None recorded',
    '3',
    '2026-10-02',
    'urgent unhandled',
  ]);
});

test('the gym view writes nothing and shows no route or job inventory', async () => {
  await renderGym();
  const forms = Array.from(document.querySelectorAll('form'));
  expect(forms.length).toBeGreaterThan(0);
  for (const form of forms) {
    expect(form.getAttribute('method')).toBe('get');
    expect(form.getAttribute('action')).toBe('/admin/system');
  }
  expect(screen.queryByRole('heading', { name: /^Routes/ })).toBeNull();
  expect(screen.queryByRole('heading', { name: /^Jobs/ })).toBeNull();
});
