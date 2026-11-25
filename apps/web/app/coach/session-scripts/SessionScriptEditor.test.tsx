/**
 * @jest-environment jsdom
 */

// Editing a plan's name, block titles and minutes (lane L1). What these pin:
// the form opens on what is stored; a save sends one PATCH carrying the script
// id, the state of the plan the form was opened on, and ONLY what was changed;
// what the server answered is handed up as it came; a bad row is named before
// anything is sent; and the form says "nothing was saved" only when the server
// said so -- saved (any 2xx), refused (a status the route refuses with), or
// not known (anything else).

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import SessionScriptEditor, { runOn } from './SessionScriptEditor';
import type { SessionScriptWithDetail } from '@/src/server/pilot/sessionScripts';

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

function answer(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new Error('unreadable');
      return body;
    },
  } as Response;
}

function mockFetch(handler: () => Response | Promise<Response>) {
  const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(async () => handler());
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const READ_AT = '2026-10-13T15:00:00.000Z';

const SCRIPT = {
  script_id: 'scr-1',
  lineage_id: 'scr-1',
  version: 1,
  name: 'Tuesday juniors',
  updated_at: READ_AT,
  blocks: [
    { block_id: 'blk-1', block_order: 1, block_label: 'Jab Drill', start_offset_min: 0, end_offset_min: 6 },
    { block_id: 'blk-2', block_order: 2, block_label: 'Partner mirror', start_offset_min: 6, end_offset_min: 11 },
  ],
  renderings: [],
} as unknown as SessionScriptWithDetail;

function setup(
  handler: () => Response | Promise<Response> = () => answer(200, { outcome: 'updated', script: SCRIPT }),
  script: SessionScriptWithDetail = SCRIPT,
) {
  const fetchMock = mockFetch(handler);
  const onSaved = jest.fn();
  const onCancel = jest.fn();
  const onBusyChange = jest.fn();
  const { unmount } = render(
    <SessionScriptEditor script={script} onSaved={onSaved} onCancel={onCancel} onBusyChange={onBusyChange} />,
  );
  const sent = () => JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'PATCH')?.[1]?.body)) as Record<string, unknown>;
  return { fetchMock, onSaved, onCancel, onBusyChange, sent, unmount };
}

function block(number: number) {
  return within(screen.getByRole('group', { name: `Block ${number}` }));
}

const type = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save plan' }));

describe('the plan editor', () => {
  it('opens on the stored name, titles and minutes, in running order', () => {
    setup();

    expect(screen.getByLabelText('Plan name')).toHaveValue('Tuesday juniors');
    expect(block(1).getByLabelText('Title')).toHaveValue('Jab Drill');
    expect(block(1).getByLabelText('Starts at minute')).toHaveValue('0');
    expect(block(1).getByLabelText('Ends at minute')).toHaveValue('6');
    expect(block(2).getByLabelText('Title')).toHaveValue('Partner mirror');
    expect(block(2).getByLabelText('Ends at minute')).toHaveValue('11');
  });

  it('a save sends one PATCH: the script, the state it was opened on, and only what was changed', async () => {
    const saved = { ...SCRIPT, script_id: 'scr-2', version: 2 };
    const { fetchMock, onSaved, onBusyChange, sent } = setup(() => answer(200, { outcome: 'new_version', script: saved }));

    type(screen.getByLabelText('Plan name'), 'Tuesday juniors, longer');
    type(block(1).getByLabelText('Title'), 'Long jab round');
    type(block(1).getByLabelText('Ends at minute'), ' 12 ');
    await act(async () => save());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/pilot/session-scripts');
    expect(init?.method).toBe('PATCH');
    expect(sent()).toEqual({
      script_id: 'scr-1',
      expected_updated_at: READ_AT,
      name: 'Tuesday juniors, longer',
      // Block 2 was not touched, so it is not sent: the server keeps it.
      blocks: [{ block_id: 'blk-1', block_label: 'Long jab round', start_offset_min: 0, end_offset_min: 12 }],
    });
    // The server's answer, as it came: which of the two things happened is its to say.
    expect(onSaved).toHaveBeenCalledWith('new_version', saved);
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });

  it('a save with nothing changed sends neither a name nor a block, so a delivered plan gets no new version', async () => {
    const { onSaved, sent } = setup(() => answer(200, { outcome: 'unchanged', script: SCRIPT }));

    await act(async () => save());

    expect(sent()).toEqual({ script_id: 'scr-1', expected_updated_at: READ_AT });
    expect(onSaved).toHaveBeenCalledWith('unchanged', SCRIPT);
  });

  it('a block nobody touched is not judged, whatever is stored in it', async () => {
    // An imported plan may hold a block the form itself would refuse.
    const imported = {
      ...SCRIPT,
      blocks: [SCRIPT.blocks[0], { ...SCRIPT.blocks[1], block_label: '  ', end_offset_min: 2000 }],
    } as unknown as SessionScriptWithDetail;
    const { sent } = setup(undefined, imported);

    type(screen.getByLabelText('Plan name'), 'Renamed');
    await act(async () => save());

    expect(screen.queryByRole('alert')).toBeNull();
    expect(sent()).toEqual({ script_id: 'scr-1', expected_updated_at: READ_AT, name: 'Renamed' });
  });

  it('the Enter key in a field saves, as the button does', async () => {
    const { fetchMock } = setup();

    type(block(2).getByLabelText('Title'), 'Mirror work');
    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: 'Edit plan' }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a blank title', 2, 'Title', '  ', 'Block 2 needs a title.'],
    ['an end not after its start', 1, 'Ends at minute', '0', 'Block 1 needs whole minutes, with its end after its start.'],
    ['minutes that are not a whole number', 2, 'Starts at minute', '6.5', 'Block 2 needs whole minutes, with its end after its start.'],
    ['minutes left empty', 1, 'Ends at minute', '', 'Block 1 needs whole minutes, with its end after its start.'],
    ['an end past the last minute a plan can hold', 2, 'Ends at minute', '1441', 'Block 2 ends after minute 1440, the longest a plan can run.'],
  ])('%s is named by block and nothing is sent', async (_case, number, field, value, sentence) => {
    const { fetchMock, onSaved } = setup();

    type(block(number).getByLabelText(field), value);
    await act(async () => save());

    expect(screen.getByRole('alert')).toHaveTextContent(sentence);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('minute 1440 itself is accepted', async () => {
    const { sent } = setup();

    type(block(2).getByLabelText('Ends at minute'), '1440');
    await act(async () => save());

    expect(sent().blocks).toEqual([{ block_id: 'blk-2', block_label: 'Partner mirror', start_offset_min: 6, end_offset_min: 1440 }]);
  });

  it('a blank plan name is refused here and nothing is sent', async () => {
    const { fetchMock } = setup();

    type(screen.getByLabelText('Plan name'), ' ');
    await act(async () => save());

    expect(screen.getByRole('alert')).toHaveTextContent('The plan needs a name.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    // True whoever saved it: the same coach on another screen as much as another coach (F-078).
    ['SESSION_SCRIPT_CHANGED', /This plan was saved after you opened it, on another screen or by another coach, so nothing of yours was saved and that save is as it was left/],
    ['SESSION_SCRIPT_SUPERSEDED', /replaced by a newer version, so nothing was saved/],
    ['SESSION_SCRIPT_BLOCK_MINUTES_INVALID', /Nothing was saved\. Each block needs whole minutes.*no later than minute 1440/],
    ['A_CODE_ADDED_LATER', /The server refused, so nothing was saved/],
  ])('a refusal (%s) says nothing was saved and why, and the form stays as typed', async (code, sentence) => {
    const { onSaved, onBusyChange } = setup(() => answer(409, { error: code }));

    type(block(1).getByLabelText('Title'), 'Typed before the refusal');
    await act(async () => save());

    expect(screen.getByRole('alert')).toHaveTextContent(sentence);
    // An ordinary message: --locked is the medical stop and nothing else.
    expect(screen.getByRole('alert').className).not.toMatch(/locked/);
    expect(onSaved).not.toHaveBeenCalled();
    expect(block(1).getByLabelText('Title')).toHaveValue('Typed before the refusal');
    expect(screen.getByRole('button', { name: 'Save plan' })).not.toBeDisabled();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('no answer, a server fault, or a 4xx that is not the app\'s is "not known": never "nothing was saved"', async () => {
    const handlers = [
      () => { throw new Error('offline'); },
      () => answer(500, { error: 'boom' }),
      // The route saves and then re-reads; a fault after the save still answers 500.
      () => answer(500, undefined),
      () => answer(429, undefined),
      // Not this route's refusal, whatever its body says (Codex on #1565).
      () => answer(429, { error: 'Too many requests' }),
      () => answer(408, { error: 'SESSION_SCRIPT_CHANGED' }),
    ];
    for (const handler of handlers) {
      const { onSaved, unmount } = setup(handler);
      type(screen.getByLabelText('Plan name'), 'Changed');

      await act(async () => save());

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(/it is not known whether the plan was saved/);
      expect(alert).not.toHaveTextContent(/nothing was saved/i);
      expect(onSaved).not.toHaveBeenCalled();
      unmount();
    }
  });

  it.each([
    [401, 'Unauthorized', /You are signed out, so nothing was saved/],
    [403, 'Forbidden: role not allowed', /Your account may not edit session plans, so nothing was saved/],
    [400, 'expected_updated_at', /The server refused, so nothing was saved/],
  ])('a %i from the route is a refusal with a plain sentence', async (status, error, sentence) => {
    const { onSaved } = setup(() => answer(status, { error }));
    type(screen.getByLabelText('Plan name'), 'Changed');

    await act(async () => save());

    expect(screen.getByRole('alert')).toHaveTextContent(sentence);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('a 200 whose body cannot be read is still a save: handed up as saved with nothing to show', async () => {
    for (const body of [undefined, {}, { outcome: 'updated' }]) {
      const { onSaved, unmount } = setup(() => answer(200, body));
      type(screen.getByLabelText('Plan name'), 'Changed');

      await act(async () => save());

      expect(onSaved).toHaveBeenCalledWith(null, null);
      expect(screen.queryByRole('alert')).toBeNull();
      unmount();
    }
  });

  it('a double tap on Save sends one request', async () => {
    let finish: ((value: Response) => void) | null = null;
    const { fetchMock, onSaved } = setup(() => new Promise<Response>((resolve) => { finish = resolve; }));

    await act(async () => {
      save();
      save();
    });
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await act(async () => {
      finish?.(answer(200, { outcome: 'updated', script: SCRIPT }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('Cancel hands back without sending anything', () => {
    const { fetchMock, onCancel } = setup();

    type(block(1).getByLabelText('Title'), 'Abandoned');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('runOn: the blocks from the change point on run on', () => {
  const rows = [
    { start: '0', end: '6' },
    { start: '6', end: '11' },
    { start: '11', end: '20' },
  ];

  it('each block from the change point keeps its length and starts where the one before ends', () => {
    // The middle block was removed: the last one (9 minutes) now follows the first.
    expect(runOn([rows[0], rows[2]], 1)).toEqual([
      { start: '0', end: '6' },
      { start: '6', end: '15' },
    ]);
  });

  it('blocks before the change point keep their minutes, even when they leave gaps', () => {
    expect(runOn([{ start: '3', end: '8' }, { start: '20', end: '25' }, { start: '25', end: '30' }], 2)).toEqual([
      { start: '3', end: '8' },
      { start: '20', end: '25' },
      { start: '25', end: '30' },
    ]);
  });

  it('a change at the top starts the first block at the given first start', () => {
    expect(runOn([rows[1], rows[0]], 0, 0)).toEqual([
      { start: '0', end: '5' },
      { start: '5', end: '11' },
    ]);
  });

  it('a block whose minutes cannot be read is left as typed, and the run goes on from its end if known', () => {
    expect(runOn([rows[0], { start: 'x', end: '9' }, { start: '9', end: '12' }], 1)).toEqual([
      { start: '0', end: '6' },
      { start: 'x', end: '9' },
      { start: '9', end: '12' },
    ]);
    expect(runOn([rows[0], { start: 'x', end: 'y' }, rows[2]], 1)[2]).toEqual(rows[2]);
  });
});

describe('runOn with a first block that is not a whole number', () => {
  it('leaves the minutes from the change on as typed', () => {
    const rows = [{ start: '1.5', end: '6' }, { start: '6', end: '11' }];
    expect(runOn(rows, 0, null)).toEqual(rows);
  });
});

describe('adding, removing and moving blocks', () => {
  const drillList = () => answer(200, { ok: true, items: [{ drill_id: 'drl-1', name: 'Slip and counter' }, { drill_id: 'drl-2', name: 'Footwork ladder' }] });

  function setupRouted(patch: Response = answer(200, { outcome: 'updated', script: SCRIPT })) {
    const fetchMock = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'PATCH' ? patch : String(url).includes('/api/pilot/drills') ? drillList() : answer(404, {}));
    global.fetch = fetchMock as unknown as typeof fetch;
    const onSaved = jest.fn();
    render(<SessionScriptEditor script={SCRIPT} onSaved={onSaved} onCancel={jest.fn()} />);
    const sent = () => JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'PATCH')?.[1]?.body)) as Record<string, unknown>;
    return { fetchMock, onSaved, sent };
  }

  const addDrill = async (name: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'Add a drill from the library' }));
    fireEvent.click(await screen.findByRole('button', { name }));
  };

  it('a drill from the library is added last, marked New, 5 minutes from where the last block ends, and sent in add_blocks', async () => {
    const { sent } = setupRouted();

    await addDrill('Slip and counter');

    expect(block(3).getByLabelText('Title')).toHaveValue('Slip and counter');
    expect(block(3).getByLabelText('Starts at minute')).toHaveValue('11');
    expect(block(3).getByLabelText('Ends at minute')).toHaveValue('16');
    expect(block(3).getByText(/New, not saved yet/)).toBeInTheDocument();
    await act(async () => save());

    // Last, and not retitled: no order, no block_label, and nothing else is sent.
    expect(sent()).toEqual({
      script_id: 'scr-1',
      expected_updated_at: READ_AT,
      add_blocks: [{ ref: expect.any(String), kind: 'drill', drill_id: 'drl-1', start_offset_min: 11, end_offset_min: 16 }],
    });
  });

  it('the picker searches the drill names', async () => {
    setupRouted();
    fireEvent.click(screen.getByRole('button', { name: 'Add a drill from the library' }));
    await screen.findByRole('button', { name: 'Footwork ladder' });

    type(screen.getByLabelText('Search drills by name'), 'slip');

    expect(screen.queryByRole('button', { name: 'Footwork ladder' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Slip and counter' })).toBeInTheDocument();
  });

  it('removing a block sends remove_block_ids, re-times the rest, and sends the edited block only', async () => {
    const { sent } = setupRouted();

    fireEvent.click(screen.getByRole('button', { name: 'Remove, block 1' }));

    expect(block(1).getByLabelText('Title')).toHaveValue('Partner mirror');
    expect(block(1).getByLabelText('Starts at minute')).toHaveValue('0');
    expect(block(1).getByLabelText('Ends at minute')).toHaveValue('5');
    await act(async () => save());

    expect(sent()).toEqual({
      script_id: 'scr-1',
      expected_updated_at: READ_AT,
      blocks: [{ block_id: 'blk-2', block_label: 'Partner mirror', start_offset_min: 0, end_offset_min: 5 }],
      remove_block_ids: ['blk-1'],
    });
  });

  it('moving a block down sends the running order and the re-timed minutes', async () => {
    const { sent } = setupRouted();

    fireEvent.click(screen.getByRole('button', { name: 'Move down, block 1' }));

    expect(block(1).getByLabelText('Title')).toHaveValue('Partner mirror');
    expect(block(2).getByLabelText('Starts at minute')).toHaveValue('5');
    await act(async () => save());

    expect(sent()).toEqual({
      script_id: 'scr-1',
      expected_updated_at: READ_AT,
      blocks: [
        { block_id: 'blk-2', block_label: 'Partner mirror', start_offset_min: 0, end_offset_min: 5 },
        { block_id: 'blk-1', block_label: 'Jab Drill', start_offset_min: 5, end_offset_min: 11 },
      ],
      order: ['blk-2', 'blk-1'],
    });
  });

  it('moving a block and moving it back sends no order and nothing else; the ends of the list cannot move off it', async () => {
    const { sent } = setupRouted();

    expect(screen.getByRole('button', { name: 'Move up, block 1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move down, block 2' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move up, block 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move up, block 2' }));
    await act(async () => save());

    expect(sent()).toEqual({ script_id: 'scr-1', expected_updated_at: READ_AT });
  });

  it('an added block moved above a kept one sends order naming its ref', async () => {
    const { sent } = setupRouted();

    await addDrill('Slip and counter');
    fireEvent.click(screen.getByRole('button', { name: 'Move up, block 3' }));
    await act(async () => save());

    const body = sent() as { add_blocks: Array<{ ref: string }>; order: string[] };
    expect(body.order).toEqual(['blk-1', body.add_blocks[0].ref, 'blk-2']);
  });

  it('a drill library that cannot be loaded is said in words, not shown as an empty list', async () => {
    global.fetch = jest.fn(async () => answer(500, { error: 'boom' })) as unknown as typeof fetch;
    render(<SessionScriptEditor script={SCRIPT} onSaved={jest.fn()} onCancel={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add a drill from the library' }));

    expect(await screen.findByText(/could not be loaded, so no drills are shown/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Drills in the library' })).toBeNull();
  });

  it('each row button\'s accessible name starts with its visible text', () => {
    setupRouted();

    for (const [visible, name] of [['Move up', 'Move up, block 2'], ['Move down', 'Move down, block 1'], ['Remove', 'Remove, block 2']]) {
      const button = screen.getByRole('button', { name });
      expect(button).toHaveTextContent(visible);
      expect(name.startsWith(visible)).toBe(true);
    }
  });

  it('says it is loading while the library is read', () => {
    global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<SessionScriptEditor script={SCRIPT} onSaved={jest.fn()} onCancel={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add a drill from the library' }));

    expect(screen.getByText('Loading the drill library…')).toBeInTheDocument();
  });

  it.each([
    ['SESSION_SCRIPT_ORDER_INVALID', 422, /Nothing was saved\. The running order/],
    ['SESSION_SCRIPT_BLOCK_REPEATED', 422, /Nothing was saved\. A block was named twice/],
    ['SESSION_SCRIPT_BLOCK_REF_INVALID', 422, /Nothing was saved\. A block you added was not accepted/],
    ['SESSION_SCRIPT_BLOCK_NOT_IN_SCRIPT', 422, /Nothing was saved\. A block you changed or removed is not in this plan/],
    ['SESSION_SCRIPT_DRILL_NOT_FOUND', 422, /Nothing was saved\. A drill you added is not one of this gym's drills/],
    // True for an added drill and for a copied block whose drill was withdrawn (SP-2b).
    ['SESSION_SCRIPT_DRILL_NOT_CURRENT', 409, /Nothing was saved\. A drill you added, or the drill of a block you copied, has been replaced or withdrawn\. Remove that block, then choose again from the drill library or from the plans\./],
  ])('%s is put in plain words and nothing is saved', async (code, status, sentence) => {
    const { onSaved } = setupRouted(answer(status, { error: code }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove, block 2' }));
    await act(async () => save());

    expect(screen.getByRole('alert')).toHaveTextContent(sentence);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('hands up why a new version was made', async () => {
    const { onSaved } = setupRouted(answer(200, { outcome: 'new_version', because: 'removal', script: SCRIPT }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove, block 2' }));
    await act(async () => save());

    expect(onSaved).toHaveBeenCalledWith('new_version', SCRIPT, 'removal');
  });

  const LATE = {
    ...SCRIPT,
    blocks: [
      { block_id: 'blk-1', block_order: 1, block_label: 'Jab Drill', start_offset_min: 3, end_offset_min: 9 },
      { block_id: 'blk-2', block_order: 2, block_label: 'Partner mirror', start_offset_min: 9, end_offset_min: 14 },
      { block_id: 'blk-3', block_order: 3, block_label: 'Cool down', start_offset_min: 14, end_offset_min: 20 },
    ],
  } as unknown as SessionScriptWithDetail;

  function setupWith(script: SessionScriptWithDetail) {
    const fetchMock = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'PATCH' ? answer(200, { outcome: 'updated', script }) : String(url).includes('/api/pilot/drills') ? drillList() : answer(404, {}));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<SessionScriptEditor script={script} onSaved={jest.fn()} onCancel={jest.fn()} />);
    return { sent: () => JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'PATCH')?.[1]?.body)) as Record<string, unknown> };
  }

  const starts = () => Array.from(document.querySelectorAll('ol[aria-label^="Blocks"] li')).map((li) => (within(li as HTMLElement).getByLabelText('Starts at minute') as HTMLInputElement).value);

  it('removing the first block keeps the start the first block had (minute 3)', async () => {
    const { sent } = setupWith(LATE);

    fireEvent.click(screen.getByRole('button', { name: 'Remove, block 1' }));

    expect(starts()).toEqual(['3', '8']);
    await act(async () => save());
    expect(sent()).toEqual({
      script_id: 'scr-1',
      expected_updated_at: READ_AT,
      blocks: [
        { block_id: 'blk-2', block_label: 'Partner mirror', start_offset_min: 3, end_offset_min: 8 },
        { block_id: 'blk-3', block_label: 'Cool down', start_offset_min: 8, end_offset_min: 14 },
      ],
      remove_block_ids: ['blk-1'],
    });
  });

  it('moving a block to the top keeps the start the first block had (minute 3)', () => {
    setupWith(LATE);

    fireEvent.click(screen.getByRole('button', { name: 'Move up, block 2' }));

    expect(block(1).getByLabelText('Title')).toHaveValue('Partner mirror');
    expect(starts()).toEqual(['3', '8', '14']);
  });

  it('removing two blocks sends both ids', async () => {
    const { sent } = setupWith(LATE);

    fireEvent.click(screen.getByRole('button', { name: 'Remove, block 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove, block 1' }));
    await act(async () => save());

    expect((sent().remove_block_ids as string[]).sort()).toEqual(['blk-1', 'blk-3']);
  });

  it('retitling an added block sends its block_label', async () => {
    const { sent } = setupRouted();

    await addDrill('Slip and counter');
    type(block(3).getByLabelText('Title'), 'Slip, my way');
    await act(async () => save());

    expect((sent() as { add_blocks: unknown[] }).add_blocks).toEqual([
      { ref: expect.any(String), kind: 'drill', drill_id: 'drl-1', block_label: 'Slip, my way', start_offset_min: 11, end_offset_min: 16 },
    ]);
  });

  it.each([
    ['whole minutes', 'Starts at minute', '2.5', /Block 3 needs whole minutes/],
    ['an end not after the start', 'Ends at minute', '11', /Block 3 needs whole minutes, with its end after its start/],
    ['an end past the last minute', 'Ends at minute', '1441', /Block 3 ends after minute 1440/],
  ])('invalid minutes typed into an added block (%s) are named and nothing is sent', async (_case, field, value, sentence) => {
    const { fetchMock } = setupRouted();

    await addDrill('Slip and counter');
    type(block(3).getByLabelText(field), value);
    await act(async () => save());

    expect(screen.getByRole('alert')).toHaveTextContent(sentence);
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'PATCH')).toBe(false);
  });

  it('an empty plan takes a drill as its first block, from minute 0 for 5 minutes', async () => {
    const { sent } = setupWith({ ...SCRIPT, blocks: [] } as unknown as SessionScriptWithDetail);

    expect(screen.getByText(/This plan has no blocks/)).toBeInTheDocument();
    await addDrill('Footwork ladder');
    expect(block(1).getByLabelText('Starts at minute')).toHaveValue('0');
    expect(block(1).getByLabelText('Ends at minute')).toHaveValue('5');
    expect(screen.queryByText(/This plan has no blocks/)).toBeNull();
    await act(async () => save());

    expect(sent()).toEqual({
      script_id: 'scr-1',
      expected_updated_at: READ_AT,
      add_blocks: [{ ref: expect.any(String), kind: 'drill', drill_id: 'drl-2', start_offset_min: 0, end_offset_min: 5 }],
    });
  });

  it('removing every block sends every id and says the plan has no blocks', async () => {
    const { sent } = setupRouted();

    fireEvent.click(screen.getByRole('button', { name: 'Remove, block 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove, block 1' }));

    expect(screen.getByText(/This plan has no blocks/)).toBeInTheDocument();
    await act(async () => save());
    expect(sent()).toEqual({ script_id: 'scr-1', expected_updated_at: READ_AT, remove_block_ids: ['blk-1', 'blk-2'] });
  });

  it('a first block whose start is not a whole number is not re-timed from 0', () => {
    setupWith({
      ...SCRIPT,
      blocks: [
        { block_id: 'blk-1', block_order: 1, block_label: 'A', start_offset_min: 0, end_offset_min: 6 },
        { block_id: 'blk-2', block_order: 2, block_label: 'B', start_offset_min: 6, end_offset_min: 11 },
      ],
    } as unknown as SessionScriptWithDetail);

    type(block(1).getByLabelText('Starts at minute'), '2.5');
    fireEvent.click(screen.getByRole('button', { name: 'Move down, block 1' }));

    expect(block(1).getByLabelText('Title')).toHaveValue('B');
    expect(starts()).toEqual(['6', '2.5']);
  });

  describe('keyboard focus stays on a control that exists', () => {
    it('after Move up or Move down, on the same button of the moved block', () => {
      setupWith(LATE);

      fireEvent.click(screen.getByRole('button', { name: 'Move down, block 1' }));
      expect(screen.getByRole('button', { name: 'Move down, block 2' })).toHaveFocus();

      fireEvent.click(screen.getByRole('button', { name: 'Move up, block 2' }));
      expect(screen.getByRole('button', { name: 'Move up, block 1' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Move down, block 1' })).toHaveFocus();
    });

    it('after a move to the top or the bottom, on the block\'s other move button', () => {
      setupWith(LATE);

      fireEvent.click(screen.getByRole('button', { name: 'Move up, block 2' }));
      expect(screen.getByRole('button', { name: 'Move down, block 1' })).toHaveFocus();

      fireEvent.click(screen.getByRole('button', { name: 'Move down, block 2' }));
      expect(screen.getByRole('button', { name: 'Move down, block 3' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Move up, block 3' })).toHaveFocus();
    });

    it('after Remove, on the next row\'s Remove, else the previous row\'s, else Add a drill', () => {
      setupWith(LATE);

      fireEvent.click(screen.getByRole('button', { name: 'Remove, block 2' }));
      expect(screen.getByRole('button', { name: 'Remove, block 2' })).toHaveFocus();
      expect(block(2).getByLabelText('Title')).toHaveValue('Cool down');

      fireEvent.click(screen.getByRole('button', { name: 'Remove, block 2' }));
      expect(screen.getByRole('button', { name: 'Remove, block 1' })).toHaveFocus();

      fireEvent.click(screen.getByRole('button', { name: 'Remove, block 1' }));
      expect(screen.getByRole('button', { name: 'Add a drill from the library' })).toHaveFocus();
    });

    it('after a drill is picked, in the new block\'s title; after the picker is closed, on Add a drill', async () => {
      setupRouted();

      await addDrill('Slip and counter');
      expect(block(3).getByLabelText('Title')).toHaveFocus();

      fireEvent.click(screen.getByRole('button', { name: 'Add a drill from the library' }));
      await screen.findByRole('button', { name: 'Footwork ladder' });
      fireEvent.click(screen.getByRole('button', { name: 'Close the drill library' }));
      expect(screen.getByRole('button', { name: 'Add a drill from the library' })).toHaveFocus();
    });
  });
});

describe('writing a text block and copying a block (SP-2b)', () => {
  const PLANS = { scripts: [{ script_id: 'scr-1', name: 'Tuesday juniors' }, { script_id: 'scr-9', name: 'Saturday seniors' }] };
  const DETAILS: Record<string, unknown> = {
    'scr-1': { script: { ...SCRIPT, blocks: SCRIPT.blocks.map((stored) => ({ ...stored, block_kind: 'drill_round', contact_level: 'none' })) } },
    'scr-9': {
      script: {
        script_id: 'scr-9',
        name: 'Saturday seniors',
        blocks: [{ block_id: 'blk-90', block_label: 'Body shots', block_kind: 'drill_round', contact_level: 'controlled_sparring' }],
      },
    },
  };

  function setupAll(patch: Response | Promise<Response> = answer(200, { outcome: 'updated', script: SCRIPT })) {
    const fetchMock = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') return patch;
      const address = String(url);
      const id = new URLSearchParams(address.split('?')[1] ?? '').get('script_id');
      if (id) return answer(200, DETAILS[id]);
      return address === '/api/pilot/session-scripts' ? answer(200, PLANS) : answer(404, {});
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const onSaved = jest.fn();
    render(<SessionScriptEditor script={SCRIPT} onSaved={onSaved} onCancel={jest.fn()} />);
    const patched = () => fetchMock.mock.calls.some((call) => call[1]?.method === 'PATCH');
    const sent = () => JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'PATCH')?.[1]?.body)) as Record<string, unknown>;
    return { onSaved, patched, sent };
  }

  const textForm = () => within(screen.getByRole('region', { name: 'Write a text block' }));
  const write = (fields: { kind: string; title: string; words?: string; contact?: string }) => {
    fireEvent.click(screen.getByRole('button', { name: 'Write a text block' }));
    type(textForm().getByLabelText('Kind of block'), fields.kind);
    type(textForm().getByLabelText('Title'), fields.title);
    if (fields.words !== undefined) type(textForm().getByLabelText('What to say'), fields.words);
    if (fields.contact !== undefined) type(textForm().getByLabelText('Contact level'), fields.contact);
    fireEvent.click(textForm().getByRole('button', { name: 'Add this block' }));
  };
  const copy = async (plan: string, choice: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'Copy a block from a plan' }));
    fireEvent.click(await screen.findByRole('button', { name: plan }));
    fireEvent.click(await screen.findByRole('button', { name: choice }));
  };

  it('a text block goes last, marked New with its kind and the contact level chosen, and is sent as exactly the text shape', async () => {
    const { sent } = setupAll();

    write({ kind: 'instruction', title: 'Guard talk', words: 'Hands up, chin down.', contact: 'light_technical' });

    expect(screen.queryByRole('region', { name: 'Write a text block' })).toBeNull();
    expect(block(3).getByText('New, not saved yet: Instruction block you wrote (Light technical contact)')).toBeInTheDocument();
    expect(block(3).getByText('What to say: Hands up, chin down.')).toBeInTheDocument();
    expect(block(3).getByLabelText('Title')).toHaveValue('Guard talk');
    expect(block(3).getByLabelText('Starts at minute')).toHaveValue('11');
    expect(block(3).getByLabelText('Ends at minute')).toHaveValue('16');
    // Keyboard focus: in the new block's title.
    expect(block(3).getByLabelText('Title')).toHaveFocus();
    await act(async () => save());

    expect(sent()).toEqual({
      script_id: 'scr-1',
      expected_updated_at: READ_AT,
      add_blocks: [{
        ref: expect.any(String),
        kind: 'text',
        block_kind: 'instruction',
        block_label: 'Guard talk',
        text: 'Hands up, chin down.',
        contact_level: 'light_technical',
        start_offset_min: 11,
        end_offset_min: 16,
      }],
    });
  });

  it('a text block is not added without a contact level, and nothing is sent', async () => {
    const { patched } = setupAll();

    write({ kind: 'instruction', title: 'Guard talk', words: 'Hands up.' });

    expect(textForm().getByRole('alert')).toHaveTextContent('Choose the contact level. A text block has none until you choose one.');
    expect(screen.queryByRole('group', { name: 'Block 3' })).toBeNull();
    // Save is refused while the form holds a block not added: it would be lost.
    await act(async () => save());
    expect(screen.getByText('Add the text block you are writing, or close its form, before you save.')).toBeInTheDocument();
    expect(patched()).toBe(false);
  });

  it('a text block of a kind that needs words is not added without them', () => {
    setupAll();

    write({ kind: 'teaching_minute', title: 'Why we slip', contact: 'none' });

    expect(textForm().getByRole('alert')).toHaveTextContent('Write what to say in this block.');
    expect(screen.queryByRole('group', { name: 'Block 3' })).toBeNull();
  });

  it('a transition with no words is added and sent with empty text', async () => {
    const { sent } = setupAll();

    write({ kind: 'transition', title: 'Water', contact: 'none' });
    expect(block(3).getByText('New, not saved yet: Transition block you wrote (No contact)')).toBeInTheDocument();
    expect(block(3).getByText('What to say: no words')).toBeInTheDocument();
    await act(async () => save());

    expect((sent() as { add_blocks: unknown[] }).add_blocks).toEqual([{
      ref: expect.any(String), kind: 'text', block_kind: 'transition', block_label: 'Water', text: '', contact_level: 'none', start_offset_min: 11, end_offset_min: 16,
    }]);
  });

  it('a copy goes last, marked New with its plan, kind and contact level, and is sent as exactly the copy shape', async () => {
    const { sent } = setupAll();

    await copy('Saturday seniors', 'Body shots (Drill, Controlled sparring)');

    expect(screen.queryByRole('region', { name: 'Copy a block from a plan' })).toBeNull();
    expect(block(3).getByText('New, not saved yet: copy of Body shots from Saturday seniors (Drill, Controlled sparring)')).toBeInTheDocument();
    expect(block(3).getByLabelText('Title')).toHaveValue('Body shots');
    expect(block(3).getByLabelText('Title')).toHaveFocus();
    await act(async () => save());

    // Not retitled: no block_label, so the server carries the source's title.
    expect(sent()).toEqual({
      script_id: 'scr-1',
      expected_updated_at: READ_AT,
      add_blocks: [{ ref: expect.any(String), kind: 'copy', block_id: 'blk-90', start_offset_min: 11, end_offset_min: 16 }],
    });
  });

  it('a retitled copy sends its block_label', async () => {
    const { sent } = setupAll();

    await copy('Saturday seniors', 'Body shots (Drill, Controlled sparring)');
    type(block(3).getByLabelText('Title'), 'Body shots, light');
    await act(async () => save());

    expect((sent() as { add_blocks: unknown[] }).add_blocks).toEqual([
      { ref: expect.any(String), kind: 'copy', block_id: 'blk-90', block_label: 'Body shots, light', start_offset_min: 11, end_offset_min: 16 },
    ]);
  });

  it('a block of this plan itself may be copied', async () => {
    const { sent } = setupAll();

    await copy('Tuesday juniors (this plan)', 'Jab Drill (Drill, No contact)');
    await act(async () => save());

    expect((sent() as { add_blocks: unknown[] }).add_blocks).toEqual([
      { ref: expect.any(String), kind: 'copy', block_id: 'blk-1', start_offset_min: 11, end_offset_min: 16 },
    ]);
  });

  it('new blocks of each kind move and are removed like any block, and go in add_blocks in running order', async () => {
    const { sent } = setupAll();

    write({ kind: 'close', title: 'Line up', contact: 'none' });
    await copy('Saturday seniors', 'Body shots (Drill, Controlled sparring)');
    write({ kind: 'reflection', title: 'One word', words: 'What did you learn?', contact: 'none' });
    // The copy (added second) above the close block (added first), re-timed; the reflection removed.
    fireEvent.click(screen.getByRole('button', { name: 'Move up, block 4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove, block 5' }));
    await act(async () => save());

    const body = sent() as { add_blocks: Array<{ ref: string; kind: string; start_offset_min: number }>; order?: string[] };
    expect(body.add_blocks.map((add) => [add.kind, add.start_offset_min])).toEqual([['copy', 11], ['text', 16]]);
    expect(new Set(body.add_blocks.map((add) => add.ref)).size).toBe(2);
    // New blocks last, in add_blocks order, is the server's own default: no order is sent.
    expect(body.order).toBeUndefined();
  });

  it('a text block moved above a kept block sends order naming its ref', async () => {
    const { sent } = setupAll();

    write({ kind: 'arrival', title: 'Wraps on', contact: 'none' });
    fireEvent.click(screen.getByRole('button', { name: 'Move up, block 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move up, block 2' }));
    await act(async () => save());

    const body = sent() as { add_blocks: Array<{ ref: string; start_offset_min: number }>; order: string[] };
    expect(body.order).toEqual([body.add_blocks[0].ref, 'blk-1', 'blk-2']);
    expect(body.add_blocks[0].start_offset_min).toBe(0);
  });

  it('keyboard focus goes into the text form or the copy picker when it opens, and back to its button when it closes', async () => {
    setupAll();

    fireEvent.click(screen.getByRole('button', { name: 'Write a text block' }));
    expect(textForm().getByLabelText('Kind of block')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Close without adding' }));
    expect(screen.getByRole('button', { name: 'Write a text block' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Copy a block from a plan' }));
    expect(screen.getByRole('region', { name: 'Copy a block from a plan' })).toHaveFocus();
    await screen.findByRole('button', { name: 'Saturday seniors' });
    fireEvent.click(screen.getByRole('button', { name: 'Close without copying' }));
    expect(screen.getByRole('button', { name: 'Copy a block from a plan' })).toHaveFocus();
  });

  it('while a save is in flight, no block can be copied in: it would miss the save', async () => {
    setupAll(new Promise<Response>(() => {}));

    fireEvent.click(screen.getByRole('button', { name: 'Copy a block from a plan' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Saturday seniors' }));
    const choice = await screen.findByRole('button', { name: /^Body shots/ });
    await act(async () => save());

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(choice).toBeDisabled();
  });

  it.each([
    ['SESSION_SCRIPT_BLOCK_KIND_INVALID', 422, /^Nothing was saved\. A text block you wrote has a kind of block that was not accepted\. Remove it and write it again\.$/],
    ['SESSION_SCRIPT_BLOCK_CONTACT_INVALID', 422, /^Nothing was saved\. A block you wrote or copied does not have a contact level from the contact ladder\. Remove that block and write it as a text block, choosing its contact level from the list\.$/],
    ['SESSION_SCRIPT_BLOCK_TEXT_INVALID', 422, /^Nothing was saved\. The words of a text block you wrote were not accepted: every kind but Arrival, Transition and Close needs words, and they can be 1000 characters at most\. Remove it and write it again\.$/],
    ['SESSION_SCRIPT_COPY_SOURCE_NOT_FOUND', 422, /^Nothing was saved\. A block you copied is not in this gym's plans any more\. Remove that block and copy one from the plans again\.$/],
    ['SESSION_SCRIPT_COPY_CONTACT_ABOVE_DRILL', 422, /^Nothing was saved\. A block you copied runs at more contact than its drill now allows: the gym has lowered that drill's contact level\. Remove that block, or add the drill from the library, which carries its new level\.$/],
    ['SESSION_SCRIPT_DRILL_NOT_CURRENT', 409, /^Nothing was saved\. A drill you added, or the drill of a block you copied, has been replaced or withdrawn\./],
  ])('%s is put in plain words, nothing is saved, and the new block stays as it was', async (code, status, sentence) => {
    const { onSaved } = setupAll(answer(status, { error: code }));

    await copy('Saturday seniors', 'Body shots (Drill, Controlled sparring)');
    await act(async () => save());

    expect(screen.getByRole('alert')).toHaveTextContent(sentence);
    expect(screen.getByRole('alert').className).not.toMatch(/locked/);
    expect(onSaved).not.toHaveBeenCalled();
    expect(block(3).getByText(/New, not saved yet: copy of Body shots/)).toBeInTheDocument();
  });
});
