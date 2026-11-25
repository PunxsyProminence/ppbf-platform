/**
 * @jest-environment jsdom
 */

// The drill picker (SP-2a): loading, failed and loaded are each said in words; a
// loaded list can be searched by name; a pick is handed up; Close hands back.
// The picker's use inside the form is in SessionScriptEditor.test.tsx.

import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';

import BlockDrillPicker from './BlockDrillPicker';

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

const reply = (ok: boolean, body: unknown) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;

describe('the drill picker', () => {
  it('reads the gym\'s drills and hands up the one picked', async () => {
    const fetchMock = jest.fn(async () => reply(true, { drills: [{ drill_id: 'd1', name: 'Jab', category: 'x' }] }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const onPick = jest.fn();
    render(<BlockDrillPicker disabled={false} onPick={onPick} onClose={jest.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Jab' }));

    // pilot.drill_library, the table a block's drill_id names -- never /api/pilot/drills (Codex P1 on #2199).
    expect(fetchMock).toHaveBeenCalledWith('/api/pilot/drill-library', { credentials: 'include' });
    expect(onPick).toHaveBeenCalledWith({ drill_id: 'd1', name: 'Jab' });
  });

  it('says so when the gym has no drills, and when the search matches none', async () => {
    global.fetch = jest.fn(async () => reply(true, { drills: [] })) as unknown as typeof fetch;
    const { unmount } = render(<BlockDrillPicker disabled={false} onPick={jest.fn()} onClose={jest.fn()} />);
    expect(await screen.findByText('The gym has no drills in its library yet.')).toBeInTheDocument();
    unmount();

    global.fetch = jest.fn(async () => reply(true, { drills: [{ drill_id: 'd1', name: 'Jab' }] })) as unknown as typeof fetch;
    render(<BlockDrillPicker disabled={false} onPick={jest.fn()} onClose={jest.fn()} />);
    fireEvent.change(await screen.findByLabelText('Search drills by name'), { target: { value: 'zzz' } });
    expect(screen.getByText('No drill name matches that search.')).toBeInTheDocument();
  });

  it('a failed read, or a body without a list, says it could not be loaded; Try again reads again', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(reply(true, {}))
      .mockResolvedValueOnce(reply(true, { drills: [{ drill_id: 'd1', name: 'Jab' }] }));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<BlockDrillPicker disabled={false} onPick={jest.fn()} onClose={jest.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded, so no drills are shown');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('button', { name: 'Jab' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a body in the shape of /api/pilot/drills (items, not drills) is not read as a list', async () => {
    global.fetch = jest.fn(async () => reply(true, { ok: true, items: [{ drill_id: 'op-1', name: 'Jab' }] })) as unknown as typeof fetch;
    render(<BlockDrillPicker disabled={false} onPick={jest.fn()} onClose={jest.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded, so no drills are shown');
    expect(screen.queryByRole('button', { name: 'Jab' })).toBeNull();
  });

  it('Close hands back', async () => {
    global.fetch = jest.fn(async () => reply(true, { drills: [] })) as unknown as typeof fetch;
    const onClose = jest.fn();
    render(<BlockDrillPicker disabled={false} onPick={jest.fn()} onClose={onClose} />);
    await screen.findByText('The gym has no drills in its library yet.');

    fireEvent.click(screen.getByRole('button', { name: 'Close the drill library' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Codex on #2199: the button that opened the picker is gone, so focus is put on its heading;
  // Try again leaves with the failure, so the heading takes the focus back.
  it('takes keyboard focus on its heading when it opens, and again after Try again', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(reply(false, {}))
      .mockResolvedValueOnce(reply(true, { drills: [{ drill_id: 'd1', name: 'Jab' }] }));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<BlockDrillPicker disabled={false} onPick={jest.fn()} onClose={jest.fn()} />);
    const heading = screen.getByRole('heading', { name: 'Add a drill from the library' });
    expect(heading).toHaveFocus();
    expect(screen.getByRole('region', { name: 'Add a drill from the library' })).toBeInTheDocument();

    await screen.findByRole('alert');
    screen.getByRole('button', { name: 'Try again' }).focus();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Jab' });
    expect(heading).toHaveFocus();
  });

  // Codex on #2199: Enter in the search would submit the plan's form and save it.
  it('Enter in the search does not submit the form around it', async () => {
    global.fetch = jest.fn(async () => reply(true, { drills: [{ drill_id: 'd1', name: 'Jab' }] })) as unknown as typeof fetch;
    render(<form><BlockDrillPicker disabled={false} onPick={jest.fn()} onClose={jest.fn()} /></form>);
    const search = await screen.findByLabelText('Search drills by name');

    // fireEvent answers false when the handler cancelled the event's default.
    expect(fireEvent.keyDown(search, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(search, { key: 'a' })).toBe(true);
  });

  // Codex on #2199: a pick made while the plan saves would be dropped when the editor closes.
  it('while the plan saves, no drill can be picked', async () => {
    global.fetch = jest.fn(async () => reply(true, { drills: [{ drill_id: 'd1', name: 'Jab' }] })) as unknown as typeof fetch;
    const onPick = jest.fn();
    render(<BlockDrillPicker disabled onPick={onPick} onClose={jest.fn()} />);
    const jab = await screen.findByRole('button', { name: 'Jab' });

    expect(jab).toBeDisabled();
    fireEvent.click(jab);
    expect(onPick).not.toHaveBeenCalled();
  });
});
