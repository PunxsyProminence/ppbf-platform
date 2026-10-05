/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import AdultPathwayPanel from './AdultPathwayPanel';

// Jason's approved wording (2026-10-04), written out here rather than
// imported, so an edit to the panel's text fails this file.
const NOT_ELIGIBLE_FLAG =
  'Placed, but not eligible: this athlete is under 18 (or has no date of birth on file) and the adult-pathway '
  + 'allowance is off. Nothing new can be set or ticked until a coach switches it on.';
const SWITCH_ON_FIRST =
  'This athlete is under 18 (or has no date of birth on file). Switch the allowance on, with a reason, before '
  + 'setting a stage or ticking goals.';
const SWITCH_OFF_WARNING = "Switching off ends this athlete's current stage. Their history and ticked goals are kept.";

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
const gets: string[] = [];
let holdPost: Promise<void> | null = null;

function serve(reading: Reading, postResponse: { ok: boolean; body?: unknown } = { ok: true }) {
  posts.length = 0;
  gets.length = 0;
  holdPost = null;
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      if (holdPost) await holdPost;
      return { ok: postResponse.ok, json: async () => postResponse.body ?? { ok: true } } as Response;
    }
    gets.push(url);
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

  it('reads this athlete, by id', async () => {
    serve(ADULT);
    await openPanel();
    expect(gets).toEqual(['/api/pilot/coach/adult-pathway?athlete_id=ath-1']);
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
    expect(screen.queryByText(SWITCH_ON_FIRST)).toBeNull();
    expect(screen.getByLabelText('Set stage')).toBeDisabled();
    // Even with a different stage chosen, "Set stage" stays disabled.
    fireEvent.change(screen.getByLabelText('Set stage'), { target: { value: 'advanced' } });
    expect(screen.getByRole('button', { name: 'Set stage' })).toBeDisabled();
    for (const tick of screen.getAllByRole('button', { name: /^Tick: / })) expect(tick).toBeDisabled();
    // Undoing a tick is still allowed.
    expect(screen.getByRole('button', { name: 'Untick' })).not.toBeDisabled();
  });

  it('needs a reason before switching the allowance on, and sends it', async () => {
    serve(MINOR_NONE);
    await openPanel();
    expect(screen.getByText('Allowed on the adult pathway (under 18 or no date of birth)')).toBeInTheDocument();
    expect(screen.getByText(SWITCH_ON_FIRST)).toBeInTheDocument();
    expect(screen.queryByText(NOT_ELIGIBLE_FLAG)).toBeNull();
    expect(screen.getByLabelText('Set stage')).toBeDisabled();
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

  it('disables the controls while a save is in flight, and sends once', async () => {
    serve(ADULT);
    await openPanel();
    let release = () => {};
    holdPost = new Promise<void>((resolve) => { release = resolve; });
    const tick = screen.getByRole('button', { name: 'Tick: Aerobic base' });
    fireEvent.click(tick);
    fireEvent.click(tick);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tick: Aerobic base' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Untick' })).toBeDisabled();
    expect(posts).toHaveLength(1);
    release();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Untick' })).not.toBeDisabled());
  });

  it('forgets an old error and an open switch-off prompt when closed', async () => {
    serve(MINOR_ALLOWED, { ok: false, body: { error: 'Refused.' } });
    await openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Tick: Aerobic base' }));
    await screen.findByText('Refused.');
    fireEvent.click(screen.getByRole('button', { name: 'Switch off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide pathway' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pathway' }));
    await screen.findByText('Set stage', { selector: 'label' });
    expect(screen.queryByText('Refused.')).toBeNull();
    expect(screen.queryByText(SWITCH_OFF_WARNING)).toBeNull();
  });

  it('a failed refresh after a save shows "could not be read", not stale controls', async () => {
    serve(ADULT);
    await openPanel();
    (global.fetch as jest.Mock).mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) } as Response;
      return { ok: false, json: async () => ({}) } as Response;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Tick: Aerobic base' }));
    expect(await screen.findByText('This athlete’s pathway could not be read just now.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tick: Aerobic base' })).toBeNull();
  });

  it('a read that finishes after the panel is closed does not reopen it', async () => {
    serve(ADULT);
    let answer: (r: Response) => void = () => {};
    (global.fetch as jest.Mock).mockImplementation(() => new Promise<Response>((resolve) => { answer = resolve; }));
    render(<AdultPathwayPanel athleteId="ath-1" athleteName="Ana" />);
    fireEvent.click(screen.getByRole('button', { name: 'Pathway' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide pathway' }));
    answer({ ok: true, json: async () => ADULT } as Response);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole('button', { name: 'Pathway' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Set stage', { selector: 'label' })).toBeNull();
  });

  it('switching off with no stage set asks first but claims no stage will end', async () => {
    serve({ ...MINOR_ALLOWED, current: null });
    await openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Switch off' }));
    expect(posts).toHaveLength(0);
    expect(screen.queryByText(SWITCH_OFF_WARNING)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Switch off' }));
    await waitFor(() => expect(posts).toEqual([{ athlete_id: 'ath-1', action: 'withdraw_allowance' }]));
  });

  it("shows the server's refusal, and re-reads", async () => {
    serve(ADULT, { ok: false, body: { error: 'This athlete is under 18.', code: 'PATHWAY_ALLOWANCE_REQUIRED' } });
    await openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Tick: Aerobic base' }));
    expect(await screen.findByText('This athlete is under 18.')).toBeInTheDocument();
    await waitFor(() => expect(gets).toHaveLength(2));
  });
});
