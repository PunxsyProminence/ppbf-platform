/**
 * @jest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';

import { useCameraRecorder } from './useCameraRecorder';

/*
 * WHAT THIS SUITE PINS: a recording is the one thing in this workflow that
 * cannot be re-shot, so no path may drop it unless the person chose to.
 * keepFailedRecording is opt-in; without it the hook behaves as it did before
 * (Film Study), and that is pinned here too so the opt-in cannot become the
 * default by accident.
 */

interface RecorderInstance {
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  state: string;
  start: jest.Mock;
  stop: jest.Mock;
}

let recorders: RecorderInstance[] = [];

class FakeMediaRecorder implements RecorderInstance {
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state = 'inactive';
  start = jest.fn(() => { this.state = 'recording'; });
  stop = jest.fn(() => { this.state = 'inactive'; this.onstop?.(); });
  constructor() { recorders.push(this); }
  static isTypeSupported() { return true; }
}

beforeEach(() => {
  recorders = [];
  (global as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(global.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: jest.fn(async () => ({ getTracks: () => [{ stop: jest.fn() }] })) },
  });
  HTMLMediaElement.prototype.play = jest.fn(async () => {});
});

interface Ctx { take: string }

function setup(options: { keep: boolean; onRecorded: jest.Mock }) {
  return renderHook(() =>
    useCameraRecorder<Ctx>({
      unsupportedFormatMessage: 'unsupported',
      keepFailedRecording: options.keep,
      onRecorded: options.onRecorded,
    }),
  );
}

async function film(hook: ReturnType<typeof setup>, context: Ctx = { take: 'take-1' }) {
  await act(async () => { await hook.result.current.start(context); });
  await act(async () => { recorders.at(-1)!.ondataavailable?.({ data: new Blob(['footage-bytes']) }); });
  await act(async () => { hook.result.current.stop(); });
}

test('a failed upload keeps the recording held, with what it belongs to', async () => {
  const onRecorded = jest.fn().mockRejectedValue(new Error('That attempt is already closed.'));
  const hook = setup({ keep: true, onRecorded });

  await film(hook);

  expect(hook.result.current.errorMessage).toBe('That attempt is already closed.');
  expect(hook.result.current.phase).toBe('idle');
  const held = hook.result.current.held;
  expect(held).not.toBeNull();
  expect(held!.context).toEqual({ take: 'take-1' });
  expect(held!.file.size).toBe('footage-bytes'.length);
});

test('retry re-sends the SAME file against the take it was recorded for, and clears it on success', async () => {
  const onRecorded = jest.fn()
    .mockRejectedValueOnce(new Error('network down'))
    .mockResolvedValueOnce(undefined);
  const hook = setup({ keep: true, onRecorded });

  await film(hook, { take: 'take-1' });
  const firstFile = onRecorded.mock.calls[0]![0] as File;

  await act(async () => { await hook.result.current.retryHeld(); });

  expect(onRecorded).toHaveBeenCalledTimes(2);
  // Same object, so the same bytes -- not a re-encode and not a new recording.
  expect(onRecorded.mock.calls[1]![0]).toBe(firstFile);
  expect(onRecorded.mock.calls[1]![1].context).toEqual({ take: 'take-1' });
  expect(onRecorded.mock.calls[1]![1].recordedAt).toBe(onRecorded.mock.calls[0]![1].recordedAt);
  expect(hook.result.current.held).toBeNull();
  expect(hook.result.current.errorMessage).toBe('');
});

test('a retry that fails again keeps holding the recording', async () => {
  const onRecorded = jest.fn().mockRejectedValue(new Error('still down'));
  const hook = setup({ keep: true, onRecorded });

  await film(hook);
  await act(async () => { await hook.result.current.retryHeld(); });

  expect(hook.result.current.held).not.toBeNull();
  expect(hook.result.current.errorMessage).toBe('still down');
  expect(hook.result.current.phase).toBe('idle');
});

test('a held recording is never replaced by recording again', async () => {
  const onRecorded = jest.fn().mockRejectedValue(new Error('down'));
  const hook = setup({ keep: true, onRecorded });
  await film(hook);
  const held = hook.result.current.held;
  const recordersBefore = recorders.length;

  await act(async () => { await hook.result.current.start({ take: 'take-2' }); });

  // The camera is not even opened: the next failure would otherwise overwrite
  // the held file and the earlier rep would be gone without anyone choosing it.
  expect(recorders).toHaveLength(recordersBefore);
  expect(hook.result.current.held).toBe(held);
  expect(hook.result.current.errorMessage).toMatch(/still being kept/);
});

test('discard is the only thing that drops it', async () => {
  const onRecorded = jest.fn().mockRejectedValue(new Error('down'));
  const hook = setup({ keep: true, onRecorded });
  await film(hook);

  // Neither saving nor stopping the camera nor a failed retry clears it...
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = jest.fn(() => 'blob:x');
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = jest.fn();
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  act(() => { hook.result.current.saveHeld(); });
  click.mockRestore();
  expect(hook.result.current.held).not.toBeNull();

  // ...the person's choice does.
  act(() => { hook.result.current.discardHeld(); });
  expect(hook.result.current.held).toBeNull();
});

test('save-to-phone hands the held file to the browser as a download and keeps it held', async () => {
  const onRecorded = jest.fn().mockRejectedValue(new Error('down'));
  const hook = setup({ keep: true, onRecorded });
  await film(hook);

  const createObjectURL = jest.fn(() => 'blob:saved');
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = jest.fn();
  const clicked: HTMLAnchorElement[] = [];
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this);
  });

  act(() => { hook.result.current.saveHeld(); });

  expect(createObjectURL).toHaveBeenCalledWith(hook.result.current.held!.file);
  expect(clicked).toHaveLength(1);
  expect(clicked[0]!.download).toMatch(/^shadow-capture-.*\.webm$/);
  expect(clicked[0]!.href).toBe('blob:saved');
  expect(hook.result.current.held).not.toBeNull();
  click.mockRestore();
});

test('a held recording asks the browser before the page is left, and stops asking once it is gone', async () => {
  const onRecorded = jest.fn().mockRejectedValue(new Error('down'));
  const hook = setup({ keep: true, onRecorded });
  await film(hook);

  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);

  act(() => { hook.result.current.discardHeld(); });
  const after = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
});

test('without the opt-in nothing is held, exactly as Film Study has always behaved', async () => {
  const onRecorded = jest.fn().mockRejectedValue(new Error('down'));
  const hook = setup({ keep: false, onRecorded });

  await film(hook);

  expect(hook.result.current.errorMessage).toBe('down');
  expect(hook.result.current.held).toBeNull();
});

test('a successful upload holds nothing', async () => {
  const onRecorded = jest.fn().mockResolvedValue(undefined);
  const hook = setup({ keep: true, onRecorded });

  await film(hook);

  expect(onRecorded).toHaveBeenCalledTimes(1);
  expect(hook.result.current.held).toBeNull();
});
