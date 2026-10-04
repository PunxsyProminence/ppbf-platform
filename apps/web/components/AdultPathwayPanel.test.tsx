/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import AdultPathwayPanel, { NOT_ELIGIBLE_FLAG, SWITCH_OFF_WARNING } from './AdultPathwayPanel';

// The panel sends what the coach chose and shows what the server answers.
// The rules themselves are the server's (adultPathway.ts); here: the approved
// wording appears where it should, frozen controls are disabled, a reason is
// needed before "Switch on", "Switch off" asks first, and refusals show.

type Reading = Record<string, unknown>;

const ADULT: Reading = {
  eligibility: { eligible: true, basis: 'adult' },
  allowance: null,
  current: { placement_id: 'pl-1', stage_key: 'foundation', set_by_name: 'Coach A', set_at: '2026-10-01T15:00:00Z' },
  checkpoints: [{ stage_key: 'foundation', goal_key: 'footwork', confirmed_by_name: 'Coach A', confirmed_at: '2026-10-02T15:00:00Z' }],
};
const FROZEN: Reading = { ...ADULT, eligibility: { eligible: false, basis: 'minor' } };
const MINOR_ALLOWED: Reading = {
  ...ADULT,
  eligibility: { eligible: true, basis: 'allowance' },
  allowance: { reason: 'Adult open class; guardian agreed.', granted_by_name: 'Coach A', granted_at: '2026-09-30T15:00:00Z' },
};
const MINOR_NONE: Reading = { ...ADULT, eligibility: { eligible: false, basis: 'no_date_of_birth' }, current: null, checkpoints: [] };

const posts: Record<string, unknown>[] = [];

function serve(reading: Reading, postResponse: { ok: boolean; body?: unknown } = { ok: true }) {
  posts.length = 0;
  global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return { ok: postResponse.ok, json: async () => postResponse.body ?? { ok: true } } as Response;
    }
    return { ok: true, json: async () => reading } as Response;
  }) as unknown as typeof fetch;
}

async function openPanel() {
  render(<AdultPathwayPanel athleteId="ath-1" athleteName="Ana" />);
  fireEvent.click(screen.getByRole('button', { name: 'Pathway' }));
  await screen.findByText('Set stage', { selector: 'label' });
}

describe('AdultPathwayPanel', () => {
  it('reads nothing until opened', () => {
    serve(ADULT);
    render(<AdultPathwayPanel athleteId="ath-1" athleteName="Ana" />);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('shows an adult with no allowance section, the current stage and a ticked goal', async () => {
    serve(ADULT);
    await openPanel();
    expect(screen.queryByText(/Allowed on the adult pathway/)).toBeNull();
    expect((screen.getByLabelText('Set stage') as HTMLSelectElement).value).toBe('foundation');
    expect(screen.getByText(/^Confirmed by Coach A on /)).toBeInTheDocument();
    expect(screen.queryByText(NOT_ELIGIBLE_FLAG)).toBeNull();
  });

  it('flags and freezes a placed athlete who is no longer eligible', async () => {
    serve(FROZEN);
    await openPanel();
    expect(screen.getByText(NOT_ELIGIBLE_FLAG)).toBeInTheDocument();
    expect(screen.getByLabelText('Set stage')).toBeDisabled();
    for (const tick of screen.getAllByRole('button', { name: /^Tick: / })) expect(tick).toBeDisabled();
    // Undoing a tick is still allowed.
    expect(screen.getByRole('button', { name: 'Untick' })).not.toBeDisabled();
  });

  it('needs a reason before switching the allowance on, and sends it', async () => {
    serve(MINOR_NONE);
    await openPanel();
    expect(screen.getByText('Allowed on the adult pathway (under 18 or no date of birth)')).toBeInTheDocument();
    const on = screen.getByRole('button', { name: 'Switch on' });
    expect(on).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Why is this athlete on the adult pathway? Required, kept on record.'), {
      target: { value: 'Adult open class.' },
    });
    fireEvent.click(on);
    await waitFor(() => expect(posts).toEqual([{ athlete_id: 'ath-1', action: 'grant_allowance', reason: 'Adult open class.' }]));
  });

  it('asks before switching off, with the approved warning', async () => {
    serve(MINOR_ALLOWED);
    await openPanel();
    expect(screen.getByText('Adult open class; guardian agreed.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Switch off' }));
    expect(posts).toHaveLength(0);
    expect(screen.getByText(SWITCH_OFF_WARNING)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Switch off' }));
    await waitFor(() => expect(posts).toEqual([{ athlete_id: 'ath-1', action: 'withdraw_allowance' }]));
  });

  it('sets a stage and ticks a goal', async () => {
    serve(ADULT);
    await openPanel();
    fireEvent.change(screen.getByLabelText('Set stage'), { target: { value: 'intermediate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set stage' }));
    await waitFor(() => expect(posts[0]).toEqual({ athlete_id: 'ath-1', action: 'place', stage_key: 'intermediate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Tick: Aerobic base' }));
    await waitFor(() => expect(posts.at(-1)).toEqual(
      { athlete_id: 'ath-1', action: 'confirm', stage_key: 'foundation', goal_key: 'aerobic_base' },
    ));
  });

  it("shows the server's refusal", async () => {
    serve(ADULT, { ok: false, body: { error: 'This athlete is under 18.', code: 'PATHWAY_ALLOWANCE_REQUIRED' } });
    await openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Tick: Aerobic base' }));
    expect(await screen.findByText('This athlete is under 18.')).toBeInTheDocument();
  });
});
