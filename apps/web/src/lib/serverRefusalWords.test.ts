import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NOTHING_CHANGED, NOT_SURE, SESSION_REFUSAL_WORDS, looksLikeCode, refusalWords } from './serverRefusalWords';

describe('refusalWords (UXB-09)', () => {
  it('turns a known code into its sentence', () => {
    expect(refusalWords({ error: 'ROUND_TIMER_PAUSED', status: 409 })).toBe(SESSION_REFUSAL_WORDS.ROUND_TIMER_PAUSED);
    expect(refusalWords({ error: 'TV_X' }, { TV_X: 'Pick a TV.' })).toBe('Pick a TV.');
  });

  it('never shows an unknown code, a field name or a status number', () => {
    for (const input of [
      { error: 'SOMETHING_NEW', status: 409 },
      { error: 'some_code', status: 400 },
      { error: { nested: true }, status: 400 },
      { error: 'UNEXPECTED_FIELD: note', status: 400 },
      { error: 'action:expected one of start, pause', status: 400 },
      { error: 'Missing athlete_id', status: 400 },
      { error: 'max_hard_open_sessions_per_7_days must be a whole number, 0 or more', status: 400 },
    ]) {
      expect(refusalWords(input)).toBe(NOTHING_CHANGED);
    }
  });

  it('claims nothing about what changed when the server failed or did not answer', () => {
    // A 5xx or an unreadable reply may have written; "Nothing was changed" would
    // be a false assurance on a hold or a limit (L4 review).
    for (const input of [
      { error: 'HTTP 500', status: 500 },
      { error: '', status: 502 },
      { error: undefined, status: 500 },
      { error: 'relation pilot.waivers does not exist', status: 500 },
      { error: 'Unexpected token < in JSON at position 0', status: 502 },
      { error: 'Internal server error' },
    ]) {
      const words = refusalWords(input);
      expect(words).toBe(NOT_SURE);
      expect(words).not.toMatch(/\d{3}|[A-Z]{2,}_[A-Z]|Nothing was changed/);
    }
  });

  it('keeps a sentence the server wrote for people, without a trailing code', () => {
    expect(refusalWords({ error: 'That athlete is not on your roster.', status: 400 })).toBe('That athlete is not on your roster.');
    expect(refusalWords({ error: 'That block is not in the plan. (SESSION_RUN_X)', status: 409 })).toBe('That block is not in the plan.');
  });

  it('answers sign-in and permission refusals in words, whatever the server text', () => {
    expect(refusalWords({ error: 'Unauthorized: session expired', status: 401 })).toMatch(/sign-in has expired/);
    expect(refusalWords({ error: 'whatever', status: 401 })).toMatch(/sign-in has expired/);
    expect(refusalWords({ error: 'FORBIDDEN', status: 403 })).toBe('Your account cannot do this here.');
    expect(refusalWords({ error: 'Forbidden', status: 403 })).toBe('Your account cannot do this here.');
    // The reason is kept when it is words, so a coach knows who can do it.
    expect(refusalWords({ error: 'Forbidden: only an organization admin can lift a hold an admin placed', status: 403 }))
      .toBe('Your account cannot do this here. Only an organization admin can lift a hold an admin placed.');
    expect(refusalWords({ error: 'Forbidden: athlete_id not in scope', status: 403 })).toBe('Your account cannot do this here.');
  });

  it('keeps a sentence that only starts with a word and a colon', () => {
    expect(refusalWords({ error: 'Unsupported: that hold has already expired.', status: 409 }))
      .toBe('Unsupported: that hold has already expired.');
  });

  it('uses the screen\'s own fallback when it has one', () => {
    expect(refusalWords({ error: 'X_Y', status: 500 }, {}, 'The cap was not saved. Try again.')).toBe('The cap was not saved. Try again.');
  });

  it('reads a code as a code', () => {
    expect(looksLikeCode('SESSION_RUN_NOT_LIVE')).toBe(true);
    expect(looksLikeCode('HTTP 409')).toBe(true);
    expect(looksLikeCode('That did not save.')).toBe(false);
  });
});

/**
 * The floor screens UXB-L4 covers. A source check on purpose: it sees every
 * refusal branch, including the ones no rendered case reaches, and fails by
 * file if a raw code, a status number or the medical-stop colour comes back.
 */
const APP = path.resolve(__dirname, '../..');
const FLOOR_FILES = [
  'components/SessionScriptLiveDelivery.tsx',
  'components/RoundTimerControls.tsx',
  'components/GymTvPanel.tsx',
  'components/ContactCapPanel.tsx',
  'components/MinorLimitsPanel.tsx',
  'components/CoachRecognitionPad.tsx',
  'app/coach/attempt-log/page.tsx',
  'app/coach/sports-medicine/page.tsx',
];

describe('floor screens show no raw refusal (UXB-09, UXB-10)', () => {
  it.each(FLOOR_FILES)('%s prints no server code or status number', (file) => {
    const source = readFileSync(path.join(APP, file), 'utf8');
    // `HTTP ${status}`, `(${response.status})`, `refused: ${code}`.
    expect(source).not.toMatch(/HTTP \$\{/);
    expect(source).not.toMatch(/\(\$\{[\w.]*status\}\)/);
    expect(source).not.toMatch(/refused: \$\{/);
    expect(source).not.toMatch(/\([A-Z][A-Z0-9_]{6,}\)['"`]/);
  });

  it.each(['components/SessionScriptLiveDelivery.tsx', 'components/RoundTimerControls.tsx', 'components/CoachRecognitionPad.tsx'])(
    '%s draws its ordinary errors without the medical-stop colour',
    (file) => {
      expect(readFileSync(path.join(APP, file), 'utf8')).not.toMatch(/var\(--locked|badge--locked|tone="locked"|stamp--red/);
    },
  );

  it('the coach-home pain panel is not drawn in the medical-stop colour (OD-2026-10-03-017)', () => {
    const source = readFileSync(path.join(APP, 'components/CoachWorkspace.tsx'), 'utf8');
    const start = source.indexOf('id="coach-dashboard-details"');
    const end = source.indexOf('SAFETY ESCALATIONS', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).not.toMatch(/--locked/);
    // The show-on-wall refusal is words too.
    expect(source).not.toMatch(/refused: \$\{/);
  });
});
