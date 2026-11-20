/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import DrillEditForm, { DRILL_EDIT_FORM_KEYS, type DrillEditOutcome } from './DrillEditForm';
import { cueRequiredMessage } from '@/src/lib/drillCueRule';
import { EDITABLE_DRILL_LIBRARY_KEYS, MAX_LONG_TEXT, MAX_SHORT_TEXT } from '@/src/server/pilot/drillLibraryEdit';
import type { DrillWithDetail } from '@/src/server/pilot/drillLibraryV3';

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));
// The route's editable-key list is read from the server module itself; its
// database and audit imports are not wanted in a jsdom test.
jest.mock('@/src/server/pilot/db', () => ({}));
jest.mock('@/src/server/pilot/audit', () => ({}));

const drill = {
  organization_id: 'org-1',
  drill_id: 'drl-1',
  lineage_id: 'drl-1',
  version: 1,
  supersedes_drill_id: null,
  superseded_at: null,
  name: 'Jab return',
  discipline: 'boxing',
  category: 'striking',
  difficulty: 'beginner',
  skill_id: 'SK-JAB-01',
  target_behavior: 'Return the hand to guard.',
  purpose: 'Protect the chin after the jab.',
  standard_setup: 'Partners at technical distance.',
  execution: 'Jab at the mitt.',
  what_good_looks_like: 'Hand back before the next beat',
  what_bad_looks_like: 'Hand drops',
  common_errors: 'Pawing',
  corrections: 'Coach calls home',
  transfer: 'Protects the chin',
  exit_condition: '',
  correction_path: '',
  contact_level: 'light_technical',
  equipment_needed: 'focus mitts',
  requires_coach_authorization: false,
  content_class: 'COACHING CRAFT',
  source_ref: null,
  grounding_claim_ids: [],
  field_provenance: 'PPBF source manual v3',
  active: true,
  created_by_account_id: null,
  created_by_role: null,
  created_at: '2026-09-16T00:00:00.000Z',
  updated_at: '2026-09-16T00:00:00.000Z',
  scale_levels: [
    { organization_id: 'org-1', scale_id: 's-a', drill_id: 'drl-1', scale_level: 'A', is_starting_point: false, demand_description: 'Slow the pace.', constraint_applied: '', contact_level: 'light_technical', coach_watch_point: 'Repeating it?', authoring_state: 'authored' },
    { organization_id: 'org-1', scale_id: 's-b', drill_id: 'drl-1', scale_level: 'B', is_starting_point: true, demand_description: 'As designed.', constraint_applied: '', contact_level: 'light_technical', coach_watch_point: 'One cue?', authoring_state: 'authored' },
  ],
  stop_rules: [
    { organization_id: 'org-1', stop_rule_id: 'st-1', drill_id: 'drl-1', ordinal: 1, condition_text: 'Stop on fatigue.', scope: 'universal', rule_kind: 'fatigue', origin: 'drill' },
    { organization_id: 'org-1', stop_rule_id: 'st-2', drill_id: 'drl-1', ordinal: 2, condition_text: 'Stop when the hand stops coming home.', scope: 'drill_specific', rule_kind: 'technique_degradation', origin: 'drill' },
  ],
  universal_stop_rules: [],
  cues: [
    { organization_id: 'org-1', cue_id: 'c-1', drill_id: 'drl-1', cue_text: 'Hand home first', cue_family: 'Jab', focus_type: 'external', evidence_note: '', source_ref: null },
  ],
  secondary_skills: [],
} as unknown as DrillWithDetail;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function renderForm(options: { drill?: DrillWithDetail; answer?: () => Promise<Response>; busy?: boolean } = {}) {
  const fetchMock = jest.fn(options.answer ?? (async () => jsonResponse({ ok: true, changed: true, drill_id: 'drl-1-v2', version: 2 })));
  global.fetch = fetchMock as unknown as typeof fetch;
  const onSaved = jest.fn<void, [DrillEditOutcome]>();
  const onCancel = jest.fn();
  const onSaving = jest.fn();
  const onFailed = jest.fn<void, [number | null]>();
  render(<DrillEditForm drill={options.drill ?? drill} onSaved={onSaved} onCancel={onCancel} onSaving={onSaving} onFailed={onFailed} busy={options.busy ?? false} />);
  return { fetchMock, onSaved, onCancel, onSaving, onFailed };
}

function sentBody(fetchMock: jest.Mock) {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('/api/pilot/drill-library');
  expect(init.method).toBe('PATCH');
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

it('offers the keys the edit route accepts, and none it refuses; scale levels and stop rules are PR1b', () => {
  const later = ['scale_levels', 'stop_rules'];
  expect([...DRILL_EDIT_FORM_KEYS].sort()).toEqual(EDITABLE_DRILL_LIBRARY_KEYS.filter((key) => !later.includes(key)).sort());
});

it('opens on the drill as it is, under "Edit <name>", with focus on its heading', () => {
  renderForm();
  const heading = screen.getByRole('heading', { name: 'Edit Jab return' });
  expect(heading).toHaveFocus();
  expect(screen.getByLabelText('What it is for')).toHaveValue('Protect the chin after the jab.');
  expect(screen.getByLabelText('Coaching cues, one per line')).toHaveValue('Hand home first');
  expect(screen.getByLabelText('Contact')).toHaveValue('light_technical');
  expect(screen.getByLabelText('Coach authorization')).toHaveValue('not_required');
  expect(screen.getByLabelText('Exit condition')).toHaveValue('');
  // Never on the form: the floor-test gate and the drill's identity.
  expect(screen.queryByLabelText(/provenance|discipline|content class|source/i)).not.toBeInTheDocument();
  // Not in PR1: the scale levels and stop rules (PR1b).
  expect(screen.queryByLabelText(/Standard \(B\)|Stop rule/)).not.toBeInTheDocument();
});

it('sends only what changed, part by part, and hands the new version up', async () => {
  const { fetchMock, onSaved, onSaving, onFailed } = renderForm();
  change('What it is for', 'Protect the chin.');
  change('Corrections', 'Coach calls home on every return');
  change('Contact', 'none');
  change('Coach authorization', 'required');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ changed: true, drillId: 'drl-1-v2', version: 2 }));
  expect(sentBody(fetchMock)).toEqual({
    drill_id: 'drl-1',
    purpose: 'Protect the chin.',
    corrections: 'Coach calls home on every return',
    contact_level: 'none',
    requires_coach_authorization: true,
  });
  // The page is told a save went out, and then how it ended.
  expect(onSaving).toHaveBeenCalledTimes(1);
  expect(onFailed).not.toHaveBeenCalled();
});

it('writes nothing when nothing changed, and says so through the page', () => {
  const { fetchMock, onSaved } = renderForm();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(onSaved).toHaveBeenCalledWith({ changed: false });
});

it('passes the server answer "changed: false" through as nothing changed', async () => {
  const { onSaved } = renderForm({ answer: async () => jsonResponse({ ok: true, changed: false, drill_id: 'drl-1', version: 1 }) });
  change('What it is for', 'Protect the chin after the jab. ');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ changed: false }));
});

it('cancel writes nothing', () => {
  const { fetchMock, onCancel } = renderForm();
  change('What it is for', 'Something else.');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCancel).toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

describe('the cue rule, checked before save as the server checks it (OD-2026-10-06-026 ruling 2)', () => {
  it('refuses a technique drill with every cue removed, in the server\'s words, and sends nothing', () => {
    const { fetchMock, onSaved } = renderForm();
    change('Coaching cues, one per line', '  \n ');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent(cueRequiredMessage('Jab return'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('takes the exemption from the discipline, not a category that says conditioning', () => {
    const { fetchMock } = renderForm({ drill: { ...drill, category: 'conditioning' } as DrillWithDetail });
    change('Coaching cues, one per line', '');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent(cueRequiredMessage('Jab return'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets a conditioning drill go without a cue', async () => {
    const { fetchMock } = renderForm({ drill: { ...drill, discipline: 'conditioning' } as DrillWithDetail });
    change('Coaching cues, one per line', '');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sentBody(fetchMock)).toEqual({ drill_id: 'drl-1', cues: [] });
  });

  it('is not judged when the cues do not change, as the server does not judge it', async () => {
    const noCues = { ...drill, cues: [] } as unknown as DrillWithDetail;
    const { fetchMock } = renderForm({ drill: noCues });
    change('What it is for', 'Protect the chin.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sentBody(fetchMock)).toEqual({ drill_id: 'drl-1', purpose: 'Protect the chin.' });
  });
});

describe('a refusal is shown as the server words it', () => {
  it('a 409 is the server\'s sentence and that nothing changed, and the page is told the status', async () => {
    const stale = 'This is not the current version of the drill. Reload it and edit the current version.';
    const { onSaved, onFailed } = renderForm({ answer: async () => jsonResponse({ error: stale, code: 'DRILL_VERSION_STALE' }, 409) });
    change('What it is for', 'Protect the chin.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(stale);
    expect(alert).toHaveTextContent('Nothing was changed. This drill is as it was.');
    expect(alert).not.toHaveTextContent('It is not known');
    expect(onSaved).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledWith(409);
    // The coach's text is still there to fix and save again.
    expect(screen.getByLabelText('What it is for')).toHaveValue('Protect the chin.');
  });

  // Only what is known: never "could not be saved", nothing changed, or the browser's own words.
  const expectOnlyUnknown = (alert: HTMLElement) => {
    expect(alert).toHaveTextContent(/^▲ It is not known whether this change was saved\.$/);
  };

  it('a lost answer says only that it is not known whether the change was saved', async () => {
    const { onFailed } = renderForm({ answer: async () => { throw new TypeError('Failed to fetch'); } });
    change('What it is for', 'Protect the chin.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expectOnlyUnknown(await screen.findByRole('alert'));
    expect(onFailed).toHaveBeenCalledWith(null);
  });

  it('a 500 says the same', async () => {
    const { onFailed } = renderForm({ answer: async () => jsonResponse({ error: 'Unknown server error' }, 500) });
    change('What it is for', 'Protect the chin.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expectOnlyUnknown(await screen.findByRole('alert'));
    expect(onFailed).toHaveBeenCalledWith(500);
  });

  it('a success that does not say what it wrote says the same, and is not a save', async () => {
    const { onFailed, onSaved } = renderForm({ answer: async () => jsonResponse({ ok: true }) });
    change('What it is for', 'Protect the chin.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expectOnlyUnknown(await screen.findByRole('alert'));
    expect(onFailed).toHaveBeenCalledWith(null);
    expect(onSaved).not.toHaveBeenCalled();
  });
});

it('keeps a value outside the vocabulary selectable, so an untouched select sends nothing', () => {
  const { fetchMock, onSaved } = renderForm({ drill: { ...drill, difficulty: 'fundamentals' } as DrillWithDetail });
  expect(screen.getByLabelText('Difficulty')).toHaveValue('fundamentals');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(onSaved).toHaveBeenCalledWith({ changed: false });
});

it('never sends cues nobody typed in, even when the stored text would read as changed', async () => {
  const untrimmed = { ...drill, cues: [{ ...(drill.cues[0]), cue_text: ' Hand home first ' }] } as unknown as DrillWithDetail;
  const { fetchMock } = renderForm({ drill: untrimmed });
  change('What it is for', 'Protect the chin.');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(sentBody(fetchMock)).toEqual({ drill_id: 'drl-1', purpose: 'Protect the chin.' });
});

it('cannot be typed past the route\'s bounds', () => {
  renderForm();
  expect(screen.getByLabelText('Name')).toHaveAttribute('maxLength', String(MAX_SHORT_TEXT));
  expect(screen.getByLabelText('Category')).toHaveAttribute('maxLength', String(MAX_SHORT_TEXT));
  expect(screen.getByLabelText('How it runs')).toHaveAttribute('maxLength', String(MAX_LONG_TEXT));
});

it('locks the fields while a save runs', async () => {
  let answer: (response: Response) => void = () => {};
  renderForm({ answer: () => new Promise<Response>((resolve) => { answer = resolve; }) });
  change('What it is for', 'Protect the chin.');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByLabelText('What it is for')).toBeDisabled();
  answer(jsonResponse({ error: 'Refused.' }, 400));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('What it is for')).toBeEnabled();
});

it('starts nothing and offers no way out while the page is still busy with the last save', () => {
  const { fetchMock } = renderForm({ busy: true });
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(screen.getByLabelText('What it is for')).toBeDisabled();
  expect(fetchMock).not.toHaveBeenCalled();
});
