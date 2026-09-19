/**
 * @jest-environment jsdom
 */

/**
 * ONE DRILL OPEN AT A TIME, WHATEVER ORDER THE NETWORK ANSWERS IN.
 *
 * useDrillOpener promises three things to every page that opens a drill from
 * somewhere other than the library (W-D4B): a newer open cancels an older one,
 * so a slow answer can never replace a faster one; leaving (closing, or leaving
 * the page) cancels whatever is loading; and closing returns focus to the
 * control that opened it -- unless the close was a side effect of something
 * else the person is doing.
 *
 * The page suites exercise those promises only through fetch mocks that answer
 * in the order they were asked, so nothing there could tell a hook that guards
 * the race from one that does not. Here every read is a deferred the test
 * settles by hand, in the order that hurts.
 *
 * Every read below also IGNORES its abort signal on purpose. A read that has
 * already received its response (or a transport that does not honour abort)
 * still resolves after it was cancelled, so aborting is not enough on its own:
 * the request counter inside the hook is what must keep a stale answer out, and
 * these tests are written so that removing it turns them red.
 */

import { act, renderHook } from '@testing-library/react';

import type { OpenedInstruction } from './drillInstructionRead';
import { useDrillOpener } from './useDrillOpener';

/** A distinct answer per drill; identity (toBe) is what the assertions compare. */
function answer(assignedBy: string): OpenedInstruction {
  return { state: 'available', view: null, assignedBy, operationalLifecycle: null, athleteAccess: null };
}

/** Lets the hook's then/catch/finally chain run to the end, inside act. */
async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A read the test settles by hand. It records the signal the hook handed it
 * and never looks at it -- see the header for why.
 */
function controlledRead() {
  let settle: { resolve: (value: OpenedInstruction) => void; reject: (error: unknown) => void } | null = null;
  let seen: AbortSignal | null = null;
  const read = jest.fn((signal: AbortSignal) => {
    seen = signal;
    return new Promise<OpenedInstruction>((resolve, reject) => {
      settle = { resolve, reject };
    });
  });
  const pending = () => {
    if (!settle) throw new Error('the hook never called this read');
    return settle;
  };
  return {
    read,
    signal(): AbortSignal {
      if (!seen) throw new Error('the hook never called this read');
      return seen;
    },
    async resolve(value: OpenedInstruction): Promise<void> {
      await act(async () => {
        pending().resolve(value);
        await drain();
      });
    },
    async reject(error: unknown): Promise<void> {
      await act(async () => {
        pending().reject(error);
        await drain();
      });
    },
  };
}

/** Renders the hook and records every `opened` any render ever held. */
function renderOpener() {
  const everOpened: Array<OpenedInstruction | null> = [];
  const rendered = renderHook(() => {
    const hook = useDrillOpener();
    everOpened.push(hook.opened);
    return hook;
  });
  return { ...rendered, everOpened };
}

let consoleError: jest.SpyInstance;

/** Only the hook's own failure log -- nothing else console.error might carry. */
function loadFailureLogs(): unknown[][] {
  return consoleError.mock.calls.filter(
    ([first]) =>
      typeof first === 'object' &&
      first !== null &&
      (first as { event?: unknown }).event === 'drill-instruction-load-failed',
  );
}

beforeEach(() => {
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('a newer open wins, whatever order the reads answer in', () => {
  it('an earlier read that answers after a newer one never replaces it, and never appears at all', async () => {
    const A = answer('coach of A');
    const B = answer('coach of B');
    const a = controlledRead();
    const b = controlledRead();
    const { result, everOpened } = renderOpener();

    act(() => result.current.open('drill-a', 'opener-a', a.read));
    // B is opened without closing A first -- the coach clicked the next drill.
    act(() => result.current.open('drill-b', 'opener-b', b.read));

    await b.resolve(B);
    expect(result.current.opened).toBe(B);
    expect(result.current.loading).toBe(false);

    // A answers last. Its abort was ignored, so its answer really arrives.
    await a.resolve(A);

    expect(result.current.openKey).toBe('drill-b');
    expect(result.current.opened).toBe(B);
    expect(result.current.loading).toBe(false);
    expect(result.current.failed).toBe(false);
    expect(everOpened).not.toContain(A);
    expect(loadFailureLogs()).toHaveLength(0);
  });

  it('an earlier read that answers while the newer one is still loading shows nothing and keeps loading', async () => {
    const A = answer('coach of A');
    const B = answer('coach of B');
    const a = controlledRead();
    const b = controlledRead();
    const { result, everOpened } = renderOpener();

    act(() => result.current.open('drill-a', 'opener-a', a.read));
    act(() => result.current.open('drill-b', 'opener-b', b.read));

    await a.resolve(A);
    // A's then AND A's finally have both run. Neither may touch B's request:
    // no stale drill on screen, and B is still loading.
    expect(result.current.opened).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.openKey).toBe('drill-b');

    await b.resolve(B);
    expect(result.current.opened).toBe(B);
    expect(result.current.loading).toBe(false);
    expect(everOpened).not.toContain(A);
  });

  it('opening B aborts the signal A was read with, and hands B a fresh one', () => {
    const a = controlledRead();
    const b = controlledRead();
    const { result } = renderOpener();

    act(() => result.current.open('drill-a', 'opener-a', a.read));
    expect(a.read).toHaveBeenCalledTimes(1);
    expect(a.signal().aborted).toBe(false);

    act(() => result.current.open('drill-b', 'opener-b', b.read));
    expect(b.read).toHaveBeenCalledTimes(1);
    expect(a.signal().aborted).toBe(true);
    expect(b.signal()).not.toBe(a.signal());
    expect(b.signal().aborted).toBe(false);
  });
});

describe('closing cancels and clears', () => {
  it('close() aborts the in-flight read, clears every state, and a late answer never opens anything', async () => {
    const A = answer('coach of A');
    const a = controlledRead();
    const { result, everOpened } = renderOpener();

    act(() => result.current.open('drill-a', 'opener-a', a.read));
    expect(result.current.openKey).toBe('drill-a');
    expect(result.current.loading).toBe(true);

    act(() => result.current.close());
    expect(a.signal().aborted).toBe(true);
    expect(result.current.openKey).toBeNull();
    expect(result.current.opened).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.failed).toBe(false);

    await a.resolve(A);
    expect(result.current.openKey).toBeNull();
    expect(result.current.opened).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(everOpened).not.toContain(A);
  });

  it('close() takes down an answer already on screen, and a failure already shown', async () => {
    const A = answer('coach of A');
    const a = controlledRead();
    const b = controlledRead();
    const { result } = renderOpener();

    act(() => result.current.open('drill-a', 'opener-a', a.read));
    await a.resolve(A);
    expect(result.current.opened).toBe(A);

    act(() => result.current.close());
    expect(result.current.opened).toBeNull();
    expect(result.current.openKey).toBeNull();

    act(() => result.current.open('drill-b', 'opener-b', b.read));
    await b.reject(new Error('drill-instruction read answered 500'));
    expect(result.current.failed).toBe(true);

    act(() => result.current.close());
    expect(result.current.failed).toBe(false);
    expect(result.current.openKey).toBeNull();
  });

  it('unmounting aborts the in-flight read, and its later failure is not logged', async () => {
    const a = controlledRead();
    const { result, unmount } = renderOpener();

    act(() => result.current.open('drill-a', 'opener-a', a.read));
    expect(a.signal().aborted).toBe(false);

    unmount();
    expect(a.signal().aborted).toBe(true);

    // Nothing incremented the request counter here -- the page simply went
    // away -- so only the aborted signal can keep this out of the log.
    await a.reject(new Error('drill-instruction read answered 500'));
    expect(loadFailureLogs()).toHaveLength(0);
  });
});

describe('failures belong to the request that is still current', () => {
  it('a rejection of the current read sets failed, stops loading, and is logged once with its error', async () => {
    const a = controlledRead();
    const { result } = renderOpener();
    const error = new Error('drill-instruction read answered 503');

    act(() => result.current.open('drill-a', 'opener-a', a.read));
    await a.reject(error);

    expect(result.current.failed).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.opened).toBeNull();
    expect(result.current.openKey).toBe('drill-a');
    const logs = loadFailureLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual([{ event: 'drill-instruction-load-failed', error }]);
    expect((logs[0][0] as { error: unknown }).error).toBe(error);
  });

  it('a rejection of a superseded read sets nothing and logs nothing', async () => {
    const B = answer('coach of B');
    const a = controlledRead();
    const b = controlledRead();
    const { result } = renderOpener();

    act(() => result.current.open('drill-a', 'opener-a', a.read));
    act(() => result.current.open('drill-b', 'opener-b', b.read));

    await a.reject(new Error('drill-instruction read answered 500'));
    expect(result.current.failed).toBe(false);
    expect(result.current.loading).toBe(true);
    expect(loadFailureLogs()).toHaveLength(0);

    await b.resolve(B);
    expect(result.current.opened).toBe(B);
    expect(result.current.failed).toBe(false);
  });

  it('a rejection of a read closed before it answered sets nothing and logs nothing', async () => {
    const a = controlledRead();
    const { result } = renderOpener();

    act(() => result.current.open('drill-a', 'opener-a', a.read));
    act(() => result.current.close());

    await a.reject(new DOMException('The operation was aborted.', 'AbortError'));
    expect(result.current.failed).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.openKey).toBeNull();
    expect(loadFailureLogs()).toHaveLength(0);
  });
});

describe('loading follows the current request only', () => {
  it('is true while the read is pending and false once it settles', async () => {
    const A = answer('coach of A');
    const a = controlledRead();
    const { result } = renderOpener();

    expect(result.current.loading).toBe(false);
    act(() => result.current.open('drill-a', 'opener-a', a.read));
    expect(result.current.loading).toBe(true);
    expect(result.current.opened).toBeNull();

    await a.resolve(A);
    expect(result.current.loading).toBe(false);
    expect(result.current.opened).toBe(A);
  });

  it("a superseded read's failure does not end the newer read's loading either", async () => {
    const a = controlledRead();
    const b = controlledRead();
    const { result } = renderOpener();

    act(() => result.current.open('drill-a', 'opener-a', a.read));
    act(() => result.current.open('drill-b', 'opener-b', b.read));

    await a.reject(new Error('drill-instruction read answered 500'));
    expect(result.current.loading).toBe(true);

    await b.reject(new Error('drill-instruction read answered 502'));
    expect(result.current.loading).toBe(false);
    expect(result.current.failed).toBe(true);
    expect(loadFailureLogs()).toHaveLength(1);
  });
});

describe('where focus goes on close', () => {
  let frames: FrameRequestCallback[];

  function button(id: string): HTMLButtonElement {
    const element = document.createElement('button');
    element.id = id;
    element.type = 'button';
    document.body.appendChild(element);
    return element;
  }

  function runFrames() {
    const due = frames;
    frames = [];
    act(() => {
      for (const frame of due) frame(0);
    });
  }

  beforeEach(() => {
    frames = [];
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
  });

  it('close() returns focus to the opener by id on the next animation frame, and scrolls it into view', () => {
    const opener = button('opener-a');
    const scrollIntoView = jest.fn();
    opener.scrollIntoView = scrollIntoView;
    const elsewhere = button('elsewhere');
    const a = controlledRead();
    const { result } = renderOpener();

    act(() => result.current.open('drill-a', 'opener-a', a.read));
    elsewhere.focus();

    act(() => result.current.close());
    // Not yet: the page has to re-render without the panel first.
    expect(frames).toHaveLength(1);
    expect(document.activeElement).toBe(elsewhere);

    runFrames();
    expect(document.activeElement).toBe(opener);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
  });

  it('focus goes to the opener of the drill open now, not of an earlier one', () => {
    const openerA = button('opener-a');
    const openerB = button('opener-b');
    const a = controlledRead();
    const b = controlledRead();
    const { result } = renderOpener();

    act(() => result.current.open('drill-a', 'opener-a', a.read));
    act(() => result.current.open('drill-b', 'opener-b', b.read));
    openerA.focus();

    act(() => result.current.close());
    runFrames();
    expect(document.activeElement).toBe(openerB);
  });

  it('close({ returnFocus: false }) leaves focus where the person is working', () => {
    button('opener-a');
    const elsewhere = button('elsewhere');
    const a = controlledRead();
    const { result } = renderOpener();

    act(() => result.current.open('drill-a', 'opener-a', a.read));
    elsewhere.focus();

    act(() => result.current.close({ returnFocus: false }));
    expect(frames).toHaveLength(0);
    runFrames();
    expect(document.activeElement).toBe(elsewhere);
    // It is still a full close.
    expect(a.signal().aborted).toBe(true);
    expect(result.current.openKey).toBeNull();
  });

  it('the opener is used once: a second close() does not pull focus back again', () => {
    const opener = button('opener-a');
    const elsewhere = button('elsewhere');
    const a = controlledRead();
    const { result } = renderOpener();

    act(() => result.current.open('drill-a', 'opener-a', a.read));
    act(() => result.current.close());
    runFrames();
    expect(document.activeElement).toBe(opener);

    elsewhere.focus();
    act(() => result.current.close());
    expect(frames).toHaveLength(0);
    expect(document.activeElement).toBe(elsewhere);
  });
});
