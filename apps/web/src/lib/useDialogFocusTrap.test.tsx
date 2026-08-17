/**
 * @jest-environment jsdom
 */

import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import { useDialogFocusTrap } from './useDialogFocusTrap';

function TestModal({
  open,
  onClose,
  closeOnEscape,
}: {
  open: boolean;
  onClose: () => void;
  closeOnEscape?: boolean;
}) {
  const dialogRef = useDialogFocusTrap<HTMLDivElement>({ open, onClose, closeOnEscape });
  if (!open) return null;
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" data-testid="dialog">
      <button type="button">First</button>
      <button type="button">Last</button>
    </div>
  );
}

function Harness({ closeOnEscape }: { closeOnEscape?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <TestModal open={open} onClose={() => setOpen(false)} closeOnEscape={closeOnEscape} />
    </div>
  );
}

describe('useDialogFocusTrap', () => {
  // fireEvent.click does not move focus the way a real browser click does,
  // so each test focuses the trigger explicitly first -- simulating the
  // realistic precondition the hook actually relies on (whatever a user
  // clicked to open the dialog was the focused element at that moment).
  test('moves focus into the dialog when it opens', () => {
    render(<Harness />);
    const trigger = screen.getByText('Open');
    trigger.focus();
    fireEvent.click(trigger);

    expect(document.activeElement).toBe(screen.getByText('First'));
  });

  test('returns focus to the trigger when the dialog closes', () => {
    render(<Harness />);
    const trigger = screen.getByText('Open');
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByText('First'));

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByTestId('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test('Tab from the last element wraps back to the first, not out of the dialog', () => {
    render(<Harness />);
    const trigger = screen.getByText('Open');
    trigger.focus();
    fireEvent.click(trigger);
    screen.getByText('Last').focus();

    fireEvent.keyDown(document, { key: 'Tab' });

    expect(document.activeElement).toBe(screen.getByText('First'));
  });

  test('Shift+Tab from the first element wraps to the last, not out of the dialog', () => {
    render(<Harness />);
    const trigger = screen.getByText('Open');
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByText('First'));

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(screen.getByText('Last'));
  });

  // A destructive-confirmation dialog can opt out of Escape-to-close (e.g.
  // admin/page.tsx's bulk-delete alertdialog, whose own design comment says
  // its two buttons are the only intended way out) without losing the rest
  // of the trap.
  test('closeOnEscape: false ignores Escape but still traps Tab', () => {
    render(<Harness closeOnEscape={false} />);
    const trigger = screen.getByText('Open');
    trigger.focus();
    fireEvent.click(trigger);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByTestId('dialog')).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByText('First'));
  });
});
