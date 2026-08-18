/**
 * @jest-environment jsdom
 */

// What this pins: the four states are mutually exclusive by construction --
// most importantly, an error never lets the empty copy render alongside it
// (that was the actual bug in /evidence and the wrestling-league season
// list) -- and dataStatus() applies loading > error > empty > ready in that
// order regardless of the order its inputs are asserted true.

import { render, screen } from '@testing-library/react';

import DataState, { dataStatus } from './DataState';

test('loading renders only the working cue', () => {
  render(
    <DataState status="loading" loadingLabel="Loading seasons..." emptyTitle="No seasons" emptyMessage="msg">
      <p>content</p>
    </DataState>,
  );
  expect(screen.getByText('Loading seasons...')).toBeTruthy();
  expect(screen.queryByText('No seasons')).toBeNull();
  expect(screen.queryByText('content')).toBeNull();
});

test('error renders the failure card and never the empty copy', () => {
  render(
    <DataState
      status="error"
      loadingLabel="Loading..."
      errorMessage="Unable to load league seasons."
      emptyTitle="No seasons on record"
      emptyMessage="When a league season is planned, it gets filed here."
    >
      <p>content</p>
    </DataState>,
  );
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.getByText('Unable to load league seasons.')).toBeTruthy();
  // The exact regression: error and "nothing here" must never both render.
  expect(screen.queryByText('No seasons on record')).toBeNull();
  expect(screen.queryByText('content')).toBeNull();
});

test('empty renders the built empty object, not the error or the content', () => {
  render(
    <DataState
      status="empty"
      loadingLabel="Loading..."
      emptyGlyph="🥊"
      emptyTitle="No seasons on record"
      emptyMessage="When a league season is planned, it gets filed here."
    >
      <p>content</p>
    </DataState>,
  );
  expect(screen.getByText('No seasons on record')).toBeTruthy();
  expect(screen.getByText('When a league season is planned, it gets filed here.')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('content')).toBeNull();
});

test('ready renders only the real content', () => {
  render(
    <DataState status="ready" loadingLabel="Loading..." emptyTitle="No seasons" emptyMessage="msg">
      <p>content</p>
    </DataState>,
  );
  expect(screen.getByText('content')).toBeTruthy();
  expect(screen.queryByText('No seasons')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

describe('dataStatus', () => {
  test('loading wins over every other input', () => {
    expect(dataStatus({ loading: true, error: true, empty: true })).toBe('loading');
  });

  test('error wins over empty once loading has settled', () => {
    expect(dataStatus({ loading: false, error: true, empty: true })).toBe('error');
  });

  test('empty applies only once loading and error are both clear', () => {
    expect(dataStatus({ loading: false, error: false, empty: true })).toBe('empty');
  });

  test('ready is the fallthrough', () => {
    expect(dataStatus({ loading: false, error: false, empty: false })).toBe('ready');
  });
});
