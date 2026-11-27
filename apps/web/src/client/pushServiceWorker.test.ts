import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// The push-only service worker, public/sw.js (lane W5-WP, WP-1c; QE A on
// #2228: the pop-up says only "Open the app"). The file runs here in a fresh
// context with a stand-in `self`, the way a browser runs it: its listeners are
// collected and driven with stand-in events.

const SOURCE = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');
const ORIGIN = 'https://app.example.test';

type Listener = (event: unknown) => void;

function load() {
  const listeners = new Map<string, Listener[]>();
  const showNotification = jest.fn().mockResolvedValue(undefined);
  const matchAll = jest.fn().mockResolvedValue([]);
  const openWindow = jest.fn().mockResolvedValue(null);
  const self = {
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    registration: { showNotification },
    clients: { matchAll, openWindow },
    location: { origin: ORIGIN },
  };
  vm.runInNewContext(SOURCE, { self, URL });
  return { listeners, showNotification, matchAll, openWindow };
}

/** Runs one listener and waits for what it handed to waitUntil. The event object is passed as is, getters included. */
async function dispatch(listener: Listener, event: object) {
  const waited: Promise<unknown>[] = [];
  Object.defineProperty(event, 'waitUntil', { value: (promise: Promise<unknown>) => waited.push(promise) });
  listener(event);
  expect(waited).toHaveLength(1);
  return Promise.all(waited);
}

test('it listens for a push and a tap on the pop-up, and for nothing else (no fetch handler, no install or cache step)', () => {
  const { listeners } = load();
  expect([...listeners.keys()].sort()).toEqual(['notificationclick', 'push']);
  expect(listeners.get('push')).toHaveLength(1);
  expect(listeners.get('notificationclick')).toHaveLength(1);
  expect(SOURCE).not.toMatch(/\bcaches\b|importScripts|indexedDB|localStorage/);
});

test('a push shows one pop-up titled "Open the app", with no body, under one tag that alerts again', async () => {
  const { listeners, showNotification } = load();
  await dispatch(listeners.get('push')![0], {});
  expect(showNotification).toHaveBeenCalledTimes(1);
  expect(showNotification).toHaveBeenCalledWith('Open the app', { tag: 'open-the-app', renotify: true });
});

test('whatever the push carries is never read, so it cannot reach the lock screen', async () => {
  const { listeners, showNotification } = load();
  let read = 0;
  await dispatch(listeners.get('push')![0], {
    get data() {
      read += 1;
      return { json: () => ({ title: 'A name and what happened' }), text: () => 'A name and what happened' };
    },
  });
  expect(read).toBe(0);
  expect(showNotification).toHaveBeenCalledWith('Open the app', { tag: 'open-the-app', renotify: true });
});

test('a tap closes the pop-up and brings forward an open window of the app, opening nothing new', async () => {
  const { listeners, matchAll, openWindow } = load();
  const focus = jest.fn(async () => undefined);
  const other = jest.fn(async () => undefined);
  matchAll.mockResolvedValueOnce([
    { url: 'https://elsewhere.example.test/page', focus: other },
    { url: `${ORIGIN}/coach`, focus },
  ]);
  const close = jest.fn();
  await dispatch(listeners.get('notificationclick')![0], { notification: { close } });
  expect(close).toHaveBeenCalledTimes(1);
  expect(matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
  expect(focus).toHaveBeenCalledTimes(1);
  expect(other).not.toHaveBeenCalled();
  expect(openWindow).not.toHaveBeenCalled();
});

test.each([
  ['no window is open', []],
  ['only another site\'s window is open', [{ url: 'https://elsewhere.example.test/', focus: jest.fn() }]],
])('a tap opens the app at "/" when %s', async (_label, windows) => {
  const { listeners, matchAll, openWindow } = load();
  matchAll.mockResolvedValueOnce(windows);
  const close = jest.fn();
  await dispatch(listeners.get('notificationclick')![0], { notification: { close } });
  expect(close).toHaveBeenCalledTimes(1);
  expect(openWindow).toHaveBeenCalledWith('/');
  for (const window of windows) expect(window.focus).not.toHaveBeenCalled();
});
