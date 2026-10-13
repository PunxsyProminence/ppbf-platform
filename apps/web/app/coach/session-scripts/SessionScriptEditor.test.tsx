/**
 * @jest-environment jsdom
 */

// Editing a plan's name, block titles and minutes (lane L1). What these pin:
// the form opens on what is stored; a save sends one PATCH carrying the script
// id, the state of the plan the form was opened on, and ONLY what was changed;
// what the server answered is handed up as it came; a bad row is named before
// anything is sent; and the form says "nothing was saved" only when the server
// said so -- saved (any 2xx), refused (its worded 4xx), or not known.

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import SessionScriptEditor from './SessionScriptEditor';
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
  const sent = () => JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
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
    ['SESSION_SCRIPT_CHANGED', /Another coach saved this plan after you opened it, so nothing of yours was saved and their save is as they left it/],
    ['SESSION_SCRIPT_SUPERSEDED', /replaced by a newer version, so nothing was saved/],
    ['SESSION_SCRIPT_BLOCK_MINUTES_INVALID', /Nothing was saved\. Each block needs whole minutes.*no later than minute 1440/],
    ['A_CODE_ADDED_LATER', /The server refused, so nothing was saved/],
  ])('a refusal (%s) says nothing was saved and why, and the form stays as typed', async (code, sentence) => {
    const { onSaved, onBusyChange } = setup(() => answer(409, { error: code }));

    type(block(1).getByLabelText('Title'), 'Typed before the refusal');
    await act(async () => save());

    expect(screen.getByRole('alert')).toHaveTextContent(sentence);
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
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
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
