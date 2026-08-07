import assert from 'node:assert/strict';
import test from 'node:test';

import { trackSafeException } from './telemetry.js';

// Telemetry is the only window into a job that runs unattended, and it used to
// reduce every unrecognized failure to a bare class name. A real staging failure
// reported exactly "TypeError" -- no class, no code, no HTTP status -- which was
// not enough to tell an SDK-side throw apart from a 403 for a missing role.
// These tests pin the diagnostic fields that closed that gap, and pin the limit
// that keeps them safe: shape only, never a message body.

function captureError(run: () => void): Record<string, unknown> {
  const original = console.error;
  let captured = '{}';
  console.error = (line: string) => { captured = line; };
  try {
    run();
  } finally {
    console.error = original;
  }
  return JSON.parse(captured) as Record<string, unknown>;
}

test('reports the HTTP status that distinguishes a 403 from a client-side throw', () => {
  const restError = Object.assign(new Error('Forbidden'), {
    name: 'RestError',
    statusCode: 403,
    code: 'AuthorizationFailure',
  });

  const logged = captureError(() => trackSafeException(restError, 'research.search-create-index'));

  assert.equal(logged.operation, 'research.search-create-index');
  assert.equal(logged.status_code, 403);
  assert.equal(logged.error_code, 'AuthorizationFailure');
});

test('reports the underlying transport code from a cause', () => {
  const wrapped = new Error('request failed', {
    cause: Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' }),
  });
  wrapped.name = 'TypeError';

  const logged = captureError(() => trackSafeException(wrapped, 'research.search-create-index'));

  assert.equal(logged.error_type, 'TypeError');
  assert.equal(logged.cause_code, 'ENOTFOUND');
});

test('never emits the message body of an unrecognized error', () => {
  const leaky = new Error('athlete Jane Doe id ATH-1 failed to index');
  leaky.name = 'TypeError';

  const logged = captureError(() => trackSafeException(leaky, 'research.build-documents'));

  const serialized = JSON.stringify(logged);
  assert.equal(serialized.includes('Jane Doe'), false);
  assert.equal(serialized.includes('ATH-1'), false);
  assert.equal(logged.error_type, 'TypeError');
});

test('still passes through the two allowlisted diagnostic messages', () => {
  const logged = captureError(() =>
    trackSafeException(new Error('StagingExportHttp503'), 'research.fetch-export'));

  assert.equal(logged.error_type, 'StagingExportHttp503');
});

test('handles a non-Error throw without crashing the job', () => {
  const logged = captureError(() => trackSafeException('a string', 'research.fetch-export'));

  assert.equal(logged.error_type, 'UnknownError');
});
