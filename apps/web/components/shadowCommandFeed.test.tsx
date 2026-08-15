/**
 * @jest-environment jsdom
 */

// The command node feed replaced a stamped placeholder whose whole job was to
// stop an empty panel from being mistaken for a quiet floor. These pin that
// the replacement keeps the doctrine in every state: loading never claims
// quiet, a failed read says it is blind, an empty record says empty is not
// clear, and a populated feed shows the record newest-first without inventing
// severity.

import { render, screen, waitFor } from '@testing-library/react';

import ShadowCommandFeed from './ShadowCommandFeed';

const EVENT = {
  shadow_event_id: 41,
  event_name: 'observation_recorded',
  entity_type: 'athlete',
  created_at: '2026-08-14T12:00:00.000Z',
};

const NEWER_METRIC = {
  shadow_telemetry_event_id: 7,
  metric_name: 'projection_read',
  created_at: '2026-08-15T09:00:00.000Z',
};

function mockFetch(responder: (url: string) => Response | Promise<Response>) {
  return jest.fn(async (input: RequestInfo | URL) => responder(String(input))) as unknown as typeof fetch;
}

const okEvents = (events: unknown[]) => ({ ok: true, json: async () => ({ ok: true, events }) }) as Response;
const okTelemetry = (telemetry: unknown[]) => ({ ok: true, json: async () => ({ ok: true, telemetry }) }) as Response;

afterEach(() => {
  jest.restoreAllMocks();
});

test('while reading, the panel says so and never shows the empty-record claim', async () => {
  global.fetch = mockFetch(() => new Promise<Response>(() => {}));

  render(<ShadowCommandFeed />);

  await screen.findByText(/Reading the operational record/);
  expect(screen.queryByText(/nothing has been recorded/i)).toBeNull();
});

test('an empty record is stated as empty, never as a clear floor', async () => {
  global.fetch = mockFetch((url) => (url.includes('/telemetry') ? okTelemetry([]) : okEvents([])));

  render(<ShadowCommandFeed />);

  await screen.findByText(/nothing has been recorded/i);
  expect(screen.getByText(/not that the floor is clear/i)).toBeTruthy();
});

test('a failed read reports blindness, not quiet', async () => {
  global.fetch = mockFetch(() => ({ ok: false, json: async () => ({}) }) as Response);

  render(<ShadowCommandFeed />);

  await screen.findByRole('alert');
  expect(screen.getByText(/blind right now, not that the floor is clear/i)).toBeTruthy();
});

test('events and telemetry combine newest-first with their kinds labeled', async () => {
  global.fetch = mockFetch((url) => (url.includes('/telemetry') ? okTelemetry([NEWER_METRIC]) : okEvents([EVENT])));

  render(<ShadowCommandFeed />);

  await screen.findByText('observation_recorded');
  expect(screen.getByText('projection_read')).toBeTruthy();
  expect(screen.getByText('event')).toBeTruthy();
  expect(screen.getByText('telemetry')).toBeTruthy();

  const rows = screen.getAllByRole('listitem');
  expect(rows[0].textContent).toContain('projection_read');
  expect(rows[1].textContent).toContain('observation_recorded');

  await waitFor(() => expect(screen.queryByText(/Reading the operational record/)).toBeNull());
});
