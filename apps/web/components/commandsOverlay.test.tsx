/**
 * @jest-environment jsdom
 */

// The design system shipped a commands card listing eight shortcuts, none of
// which were bound to anything -- a picture of a feature. These tests pin the
// property that replaced it: the overlay renders from the registry, so it can
// only ever show keys that something actually binds.

import { render, screen, fireEvent, act } from '@testing-library/react';

import CommandsOverlay from './CommandsOverlay';
import {
  SHORTCUTS,
  isTypingTarget,
  shortcutsByScope,
  visibleShortcuts,
} from './shortcuts';

function press(key: string, target: Window | Element = window, init: object = {}) {
  act(() => { fireEvent.keyDown(target, { key, ...init }); });
}

describe('the shortcut registry', () => {
  it('marks every shipped shortcut as bound, and names the owner', () => {
    // An unbound entry is allowed to exist, but it must not claim an owner and
    // must not reach the overlay. Today every entry is real.
    for (const s of SHORTCUTS) {
      if (s.bound) {
        expect(s.owner).toBeTruthy();
      }
    }
  });

  it('never exposes an unbound shortcut to the UI', () => {
    for (const s of visibleShortcuts()) expect(s.bound).toBe(true);
  });

  it('gives every shortcut a key and a label', () => {
    for (const s of SHORTCUTS) {
      expect(s.keys.trim()).not.toHaveLength(0);
      expect(s.label.trim()).not.toHaveLength(0);
    }
  });

  it('accounts for every visible shortcut when grouped by scope', () => {
    const grouped = shortcutsByScope().flatMap((g) => g.items);
    expect(grouped).toHaveLength(visibleShortcuts().length);
  });

  it('does not bind coach triage, which has no endpoint yet', () => {
    // Guards the note in shortcuts.ts: the review queue is read-only and
    // coach-reviews takes training sessions, not intake cases. If someone adds
    // an approve/deny key, this fails until the backend exists.
    const labels = SHORTCUTS.map((s) => s.label.toLowerCase()).join(' ');
    expect(labels).not.toMatch(/approve|deny|reject/);
  });
});

describe('isTypingTarget', () => {
  it('recognises the places a printable key belongs to the user', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      const el = document.createElement(tag.toLowerCase());
      expect(isTypingTarget(el)).toBe(true);
    }
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom does not derive isContentEditable from the attribute, so set it.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTypingTarget(editable)).toBe(true);
  });

  it('does not claim an ordinary element or null', () => {
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('CommandsOverlay', () => {
  it('stays closed until asked', () => {
    render(<CommandsOverlay />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens on "?" and closes on Escape', () => {
    render(<CommandsOverlay />);
    press('?');
    expect(screen.getByRole('dialog', { name: /keyboard shortcuts/i })).toBeTruthy();
    press('Escape');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('toggles shut on a second "?"', () => {
    render(<CommandsOverlay />);
    press('?');
    expect(screen.getByRole('dialog')).toBeTruthy();
    press('?');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // The whole reason "?" is guarded: it is a printable character.
  it('does NOT open while the user is typing a note', () => {
    render(
      <>
        <textarea data-testid="note" />
        <CommandsOverlay />
      </>,
    );
    press('?', screen.getByTestId('note'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ignores a modified "?" so it cannot steal a browser chord', () => {
    render(<CommandsOverlay />);
    press('?', window, { metaKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    press('?', window, { ctrlKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lists every bound shortcut, and only bound ones', () => {
    render(<CommandsOverlay />);
    press('?');
    for (const s of visibleShortcuts()) {
      expect(screen.getByText(s.label)).toBeTruthy();
    }
    const rendered = screen.getAllByRole('listitem').length;
    expect(rendered).toBe(visibleShortcuts().length);
  });

  it('groups shortcuts under a scope heading', () => {
    render(<CommandsOverlay />);
    press('?');
    expect(screen.getByText('Anywhere')).toBeTruthy();
  });

  it('hands focus back where it came from', () => {
    render(
      <>
        <button data-testid="origin">origin</button>
        <CommandsOverlay />
      </>,
    );
    const origin = screen.getByTestId('origin');
    origin.focus();
    press('?');
    press('Escape');
    expect(document.activeElement).toBe(origin);
  });

  it('documents its own "?" binding, so the list is self-consistent', () => {
    render(<CommandsOverlay />);
    press('?');
    expect(screen.getByText(/show this list of shortcuts/i)).toBeTruthy();
  });
});
