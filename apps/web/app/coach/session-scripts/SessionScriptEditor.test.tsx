/**
 * @jest-environment jsdom
 */

// Editing a plan's name, block titles and minutes (lane L1). What these pin:
// the form opens on what is stored; a save sends one PATCH carrying the script
// id, the name and every block's title and whole minutes, and nothing else;
// what the server answered is handed up as it came; a bad row is named before
// anything is sent; and a refusal says nothing was saved and keeps the form.

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import SessionScriptEditor from './SessionScriptEditor';
import type { SessionScriptWithDetail } from '@/src/server/pilot/sessionScripts';

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

function answer(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function mockFetch(handler: () => Response | Promise<Response>) {
  const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(async () => handler());
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const SCRIPT = {
  script_id: 'scr-1',
  lineage_id: 'scr-1',
  version: 1,
  name: 'Tuesday juniors',
  blocks: [
    { block_id: 'blk-1', block_order: 1, block_label: 'Jab Drill', start_offset_min: 0, end_offset_min: 6 },
    { block_id: 'blk-2', block_order: 2, block_label: 'Partner mirror', start_offset_min: 6, end_offset_min: 11 },
  ],
  renderings: [],
} as unknown as SessionScriptWithDetail;

function setup(handler: () => Response | Promise<Response> = () => answer(200, { outcome: 'updated', script: SCRIPT })) {
  const fetchMock = mockFetch(handler);
  const onSaved = jest.fn();
  const onCancel = jest.fn();
  render(<SessionScriptEditor script={SCRIPT} onSaved={onSaved} onCancel={onCancel} />);
  return { fetchMock, onSaved, onCancel };
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

  it('a save sends one PATCH with the script, the name and every block, minutes as whole numbers', async () => {
    const saved = { ...SCRIPT, script_id: 'scr-2', version: 2 };
    const { fetchMock, onSaved } = setup(() => answer(200, { outcome: 'new_version', script: saved }));

    type(screen.getByLabelText('Plan name'), 'Tuesday juniors, longer');
    type(block(1).getByLabelText('Title'), 'Long jab round');
    type(block(1).getByLabelText('Ends at minute'), ' 12 ');
    await act(async () => save());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/pilot/session-scripts');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({
      script_id: 'scr-1',
      name: 'Tuesday juniors, longer',
      blocks: [
        { block_id: 'blk-1', block_label: 'Long jab round', start_offset_min: 0, end_offset_min: 12 },
        { block_id: 'blk-2', block_label: 'Partner mirror', start_offset_min: 6, end_offset_min: 11 },
      ],
    });
    // The server's answer, as it came: which of the two things happened is its to say.
    expect(onSaved).toHaveBeenCalledWith('new_version', saved);
  });

  it.each([
    ['a blank title', 2, 'Title', '  ', 'Block 2 needs a title.'],
    ['an end not after its start', 1, 'Ends at minute', '0', 'Block 1 needs whole minutes, with its end after its start.'],
    ['minutes that are not a whole number', 2, 'Starts at minute', '6.5', 'Block 2 needs whole minutes, with its end after its start.'],
    ['minutes left empty', 1, 'Ends at minute', '', 'Block 1 needs whole minutes, with its end after its start.'],
  ])('%s is named by block and nothing is sent', async (_case, number, field, value, sentence) => {
    const { fetchMock, onSaved } = setup();

    type(block(number).getByLabelText(field), value);
    await act(async () => save());

    expect(screen.getByRole('alert')).toHaveTextContent(sentence);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('a blank plan name is refused here and nothing is sent', async () => {
    const { fetchMock } = setup();

    type(screen.getByLabelText('Plan name'), ' ');
    await act(async () => save());

    expect(screen.getByRole('alert')).toHaveTextContent('The plan needs a name.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a plan replaced while it was being edited says nothing was saved, and the form stays as typed', async () => {
    const { onSaved } = setup(() => answer(409, { error: 'SESSION_SCRIPT_SUPERSEDED' }));

    type(block(1).getByLabelText('Title'), 'Typed before the refusal');
    await act(async () => save());

    expect(screen.getByRole('alert')).toHaveTextContent(/replaced by a newer version while you were editing, so nothing was saved/);
    expect(onSaved).not.toHaveBeenCalled();
    expect(block(1).getByLabelText('Title')).toHaveValue('Typed before the refusal');
    expect(screen.getByRole('button', { name: 'Save plan' })).not.toBeDisabled();
  });

  it('no answer is "may or may not have been saved", never "saved" and never "not saved"', async () => {
    const { onSaved } = setup(() => { throw new Error('offline'); });

    await act(async () => save());

    expect(screen.getByRole('alert')).toHaveTextContent(/may or may not have been saved/);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('a double tap on Save sends one request', async () => {
    let finish: ((value: Response) => void) | null = null;
    const { fetchMock, onSaved } = setup(() => new Promise<Response>((resolve) => { finish = resolve; }));

    await act(async () => {
      save();
      save();
    });
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
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
