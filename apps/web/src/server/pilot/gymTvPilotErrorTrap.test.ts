import { PilotError as PackagePilotError } from 'gym-tv-timer/errors';
import { GymTvError, validateTvName } from 'gym-tv-timer/gymTvs';

import { ConflictError, ForbiddenError, NotFoundError, PilotError, ServiceUnavailableError, ValidationError } from './errors';
import { jsonError } from './http';

// THE TRAP (GTT-02a, issue #1873). The gym-tv-timer package's GymTvError extends the package's
// PilotError, and jsonError (http.ts) decides disclosure with `instanceof PilotError` against the
// class errors.ts exports. If errors.ts defined a PilotError of its own, there would be two classes:
// a GymTvError such as TV_NAME_LENGTH would stop matching, fall past every typed branch, and be
// answered as an opaque 500 instead of the 400 the coach needs to fix the name. So errors.ts must
// re-export the package's class, and this pins that there is exactly one.

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('one PilotError class across ppbf and gym-tv-timer', () => {
  test('errors.ts exports the package PilotError itself, not a copy', () => {
    expect(PilotError).toBe(PackagePilotError);
  });

  test("a GymTvError from the package's validateTvName is instanceof the PilotError errors.ts exports", () => {
    const error = thrownBy(() => validateTvName(''));
    expect(error).toBeInstanceOf(GymTvError);
    expect(error).toBeInstanceOf(PilotError);
  });

  test('jsonError answers that GymTvError as its own 400 with its code', async () => {
    const res = jsonError(thrownBy(() => validateTvName('')));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'TV_NAME_LENGTH', code: 'TV_NAME_LENGTH' });
  });

  test("every ppbf PilotError subclass extends the package's class", () => {
    for (const error of [
      new ValidationError('x'),
      new ForbiddenError('x'),
      new NotFoundError('x'),
      new ConflictError('x'),
      new ServiceUnavailableError('x'),
    ]) {
      expect(error).toBeInstanceOf(PackagePilotError);
    }
  });
});
