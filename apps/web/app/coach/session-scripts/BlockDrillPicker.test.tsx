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
    const fetchMock = jest.fn(async () => reply(true, { items: [{ drill_id: 'd1', name: 'Jab', category: 'x' }] }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const onPick = jest.fn();
    render(<BlockDrillPicker onPick={onPick} onClose={jest.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Jab' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/pilot/drills', { credentials: 'include' });
    expect(onPick).toHaveBeenCalledWith({ drill_id: 'd1', name: 'Jab' });
  });

  it('says so when the gym has no drills, and when the search matches none', async () => {
    global.fetch = jest.fn(async () => reply(true, { items: [] })) as unknown as typeof fetch;
    const { unmount } = render(<BlockDrillPicker onPick={jest.fn()} onClose={jest.fn()} />);
    expect(await screen.findByText('The gym has no drills in its library yet.')).toBeInTheDocument();
    unmount();

    global.fetch = jest.fn(async () => reply(true, { items: [{ drill_id: 'd1', name: 'Jab' }] })) as unknown as typeof fetch;
    render(<BlockDrillPicker onPick={jest.fn()} onClose={jest.fn()} />);
    fireEvent.change(await screen.findByLabelText('Search drills by name'), { target: { value: 'zzz' } });
    expect(screen.getByText('No drill name matches that search.')).toBeInTheDocument();
  });

  it('a failed read, or a body without a list, says it could not be loaded; Try again reads again', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(reply(true, {}))
      .mockResolvedValueOnce(reply(true, { items: [{ drill_id: 'd1', name: 'Jab' }] }));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<BlockDrillPicker onPick={jest.fn()} onClose={jest.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded, so no drills are shown');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('button', { name: 'Jab' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('Close hands back', async () => {
    global.fetch = jest.fn(async () => reply(true, { items: [] })) as unknown as typeof fetch;
    const onClose = jest.fn();
    render(<BlockDrillPicker onPick={jest.fn()} onClose={onClose} />);
    await screen.findByText('The gym has no drills in its library yet.');

    fireEvent.click(screen.getByRole('button', { name: 'Close the drill library' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
