/**
 * @jest-environment jsdom
 */

// Lane AS4-4D4E (AS-4 part 4e; GO on #2128, Q5 = A, condition 2): the open tab
// is kept in the address with replace, and only an allowed tab opens from it.

import { act, renderHook } from '@testing-library/react';

import { openTabHere, readTabParam, useTabParam } from './useTabParam';

const TABS = ['overview', 'progress', 'messages'] as const;
type Tab = (typeof TABS)[number];

function at(url: string) {
  window.history.replaceState(null, '', url);
}

afterEach(() => at('/'));

describe('reading the tab from the address', () => {
  test('an allowed tab opens', () => {
    at('/parent/dashboard?tab=progress');
    expect(readTabParam<Tab>(TABS, 'overview')).toBe('progress');
  });

  test.each([
    ['no value', '/parent/dashboard'],
    ['an unknown value', '/parent/dashboard?tab=nonsense'],
    ['a tab the page does not draw', '/parent/dashboard?tab=assessments'],
    ['an empty value', '/parent/dashboard?tab='],
  ])('%s opens the default tab', (_name, url) => {
    at(url);
    expect(readTabParam<Tab>(TABS, 'overview')).toBe('overview');
  });
});

describe('writing the tab to the address', () => {
  test('a tab press replaces the address, adding no history entry, and keeps other parameters and the hash', () => {
    at('/parent/dashboard?child=ath_2#top');
    const before = window.history.length;
    const { result } = renderHook(() => useTabParam<Tab>(TABS, 'overview'));

    act(() => result.current[1]('messages'));

    expect(result.current[0]).toBe('messages');
    expect(window.location.pathname).toBe('/parent/dashboard');
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('messages');
    expect(new URLSearchParams(window.location.search).get('child')).toBe('ath_2');
    expect(window.location.hash).toBe('#top');
    expect(window.history.length).toBe(before);
  });

  test('going back to the default tab leaves no ?tab= behind', () => {
    at('/parent/dashboard?tab=progress');
    const { result } = renderHook(() => useTabParam<Tab>(TABS, 'overview'));
    expect(result.current[0]).toBe('progress');

    act(() => result.current[1]('overview'));

    expect(result.current[0]).toBe('overview');
    expect(window.location.search).toBe('');
  });
});

// Review on #2130: a same-page link must reopen the tab in place, the write
// must carry a null state (so the Next.js router copies the address), and a
// tab set after leaving the page must not write onto the next page.
describe('a same-page tab link, the history state, and a late write', () => {
  test('openTabHere on the same page changes the tab of every reader, in place', () => {
    at('/parent/dashboard');
    const { result } = renderHook(() => useTabParam<Tab>(TABS, 'overview'));
    const before = window.history.length;

    let handled = false;
    act(() => {
      handled = openTabHere('/parent/dashboard?tab=messages');
    });

    expect(handled).toBe(true);
    expect(result.current[0]).toBe('messages');
    expect(window.history.length).toBe(before);
  });

  test('openTabHere for another page leaves the address alone and lets the link navigate', () => {
    at('/schedule');
    expect(openTabHere('/parent/dashboard?tab=messages')).toBe(false);
    expect(window.location.pathname).toBe('/schedule');
  });

  test('the write carries a null history state', () => {
    window.history.replaceState({ __NA: true }, '', '/parent/dashboard');
    const { result } = renderHook(() => useTabParam<Tab>(TABS, 'overview'));

    act(() => result.current[1]('progress'));

    expect(window.history.state).toBeNull();
  });

  test('a tab set after the reader has left the page writes nothing', () => {
    at('/athlete/dashboard');
    const { result } = renderHook(() => useTabParam<Tab>(TABS, 'overview'));
    at('/athlete/dashboard/sparring');

    act(() => result.current[1]('progress'));

    expect(window.location.pathname).toBe('/athlete/dashboard/sparring');
    expect(window.location.search).toBe('');
  });
});
