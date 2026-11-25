/**
 * @jest-environment jsdom
 */

// The copy picker (SP-2b): the gym's plans are read and listed, one is opened
// and its blocks listed with their kind and contact level, and a block is handed
// up. Loading, could not be loaded (with Try again), no plans, and a plan with
// no blocks are each said in words; a read that failed is never shown as a list.
// The picker's use inside the editor is in SessionScriptEditor.test.tsx.

import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';

import CopyBlockPicker from './CopyBlockPicker';

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

const reply = (ok: boolean, body: unknown) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;

const PLANS = { scripts: [{ script_id: 'scr-1', name: 'Tuesday juniors' }, { script_id: 'scr-9', name: 'Saturday seniors' }] };
const SENIORS = {
  script: {
    script_id: 'scr-9',
    name: 'Saturday seniors',
    blocks: [
      { block_id: 'blk-90', block_label: 'Body shots', block_kind: 'drill_round', contact_level: 'controlled_sparring', what_to_say: 'Stay tight.' },
      { block_id: 'blk-91', block_label: 'Breathe', block_kind: 'reflection', contact_level: 'none', what_to_say: null },
    ],
  },
};

function routed(detail: () => Response = () => reply(true, SENIORS), list: () => Response = () => reply(true, PLANS)) {
  const fetchMock = jest.fn(async (url: RequestInfo | URL) => (String(url).includes('script_id=') ? detail() : list()));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function setup(currentScriptId = 'scr-1') {
  const onPick = jest.fn();
  const onClose = jest.fn();
  render(<CopyBlockPicker currentScriptId={currentScriptId} onPick={onPick} onClose={onClose} />);
  return { onPick, onClose };
}

describe('the copy picker', () => {
  it('lists the gym\'s plans, marks the one being edited, opens one, and hands up the block chosen', async () => {
    const fetchMock = routed();
    const { onPick } = setup();

    expect(await screen.findByRole('button', { name: 'Tuesday juniors (this plan)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Saturday seniors' }));

    // Each block with its kind and contact level, which a copy carries.
    fireEvent.click(await screen.findByRole('button', { name: 'Body shots (Drill, Controlled sparring)' }));
    expect(screen.getByRole('button', { name: 'Breathe (Reflection, No contact)' })).toBeInTheDocument();

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/pilot/session-scripts',
      '/api/pilot/session-scripts?script_id=scr-9',
    ]);
    expect(fetchMock).toHaveBeenCalledWith('/api/pilot/session-scripts', { credentials: 'include' });
    expect(onPick).toHaveBeenCalledWith({
      block_id: 'blk-90',
      block_label: 'Body shots',
      block_kind: 'drill_round',
      contact_level: 'controlled_sparring',
      plan_name: 'Saturday seniors',
    });
  });

  it('says it is loading the plans, and then the blocks', async () => {
    const list: { finish?: (value: Response) => void } = {};
    global.fetch = jest.fn((url: RequestInfo | URL) =>
      String(url).includes('script_id=')
        ? new Promise<Response>(() => {})
        : new Promise<Response>((resolve) => { list.finish = resolve; })) as unknown as typeof fetch;
    setup();

    expect(screen.getByRole('status')).toHaveTextContent('Loading the gym\'s plans…');
    expect(screen.queryByRole('list')).toBeNull();
    list.finish?.(reply(true, PLANS));
    fireEvent.click(await screen.findByRole('button', { name: 'Saturday seniors' }));

    expect(screen.getByRole('status')).toHaveTextContent('Loading the blocks of Saturday seniors…');
  });

  it('a list that cannot be read is said in words, not shown as an empty list; Try again reads again', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(reply(false, { error: 'boom' }))
      .mockResolvedValueOnce(reply(true, {}))
      .mockResolvedValueOnce(reply(true, PLANS));
    global.fetch = fetchMock as unknown as typeof fetch;
    setup();

    expect(await screen.findByRole('alert')).toHaveTextContent('The gym\'s plans could not be loaded, so no plans are shown. Try again.');
    expect(screen.queryByText(/no plans to copy/)).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    // A body with no list is not a list either.
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('button', { name: 'Saturday seniors' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a plan whose blocks cannot be read says so, with Try again', async () => {
    const detail = jest.fn()
      .mockReturnValueOnce(reply(false, { error: 'SESSION_SCRIPT_NOT_FOUND' }))
      .mockReturnValueOnce(reply(true, SENIORS));
    routed(detail);
    setup();

    fireEvent.click(await screen.findByRole('button', { name: 'Saturday seniors' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The blocks of Saturday seniors could not be loaded, so none are shown. Try again.');
    expect(screen.queryByText(/has no blocks/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /^Body shots/ })).toBeInTheDocument();
  });

  it('says so when the gym has no plans, and when a plan has no blocks', async () => {
    routed(undefined, () => reply(true, { scripts: [] }));
    const { unmount } = render(<CopyBlockPicker currentScriptId="scr-1" onPick={jest.fn()} onClose={jest.fn()} />);
    expect(await screen.findByText('The gym has no plans to copy a block from.')).toBeInTheDocument();
    unmount();

    routed(() => reply(true, { script: { ...SENIORS.script, blocks: [] } }));
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Saturday seniors' }));
    expect(await screen.findByText('Saturday seniors has no blocks to copy.')).toBeInTheDocument();
  });

  it('keyboard focus goes into the picker when it opens, to Back when a plan opens, and back to that plan on Back', async () => {
    routed();
    setup();
    expect(screen.getByRole('region', { name: 'Copy a block from a plan' })).toHaveFocus();

    fireEvent.click(await screen.findByRole('button', { name: 'Saturday seniors' }));
    expect(screen.getByRole('button', { name: 'Back to the list of plans' })).toHaveFocus();
    await screen.findByRole('button', { name: /^Body shots/ });

    fireEvent.click(screen.getByRole('button', { name: 'Back to the list of plans' }));
    expect(screen.getByRole('button', { name: 'Saturday seniors' })).toHaveFocus();
  });

  it('no block can be chosen while the editor is saving', async () => {
    routed();
    const onPick = jest.fn();
    render(<CopyBlockPicker currentScriptId="scr-1" onPick={onPick} onClose={jest.fn()} disabled />);
    fireEvent.click(await screen.findByRole('button', { name: 'Saturday seniors' }));

    const choice = await screen.findByRole('button', { name: /^Body shots/ });
    expect(choice).toBeDisabled();
    fireEvent.click(choice);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('Close hands back', async () => {
    routed();
    const { onClose, onPick } = setup();
    await screen.findByRole('button', { name: 'Saturday seniors' });

    fireEvent.click(screen.getByRole('button', { name: 'Close without copying' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('every button meets the gym-floor tap and type floors', async () => {
    routed();
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Saturday seniors' }));
    await screen.findByRole('button', { name: /^Body shots/ });

    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toContain('min-h-[var(--tap)]');
      expect(button.className).toContain('text-[length:var(--t-md)]');
    }
  });
});
