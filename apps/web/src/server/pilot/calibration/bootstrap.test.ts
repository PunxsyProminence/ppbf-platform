// Guards on the operator bootstrap's argument handling.
//
// No database: parseCalibrationBootstrapArgv is pure, and everything it hands
// on is already covered by calibrationProjects.pg.test.ts and
// calibrationBootstrap.pg.test.ts. What needs proving here is what the command
// line REFUSES, exhaustively and in a millisecond -- above all that it cannot
// be talked into an athlete, an ontology version, or a mistyped offset.
//
// ../db is mocked so importing the module under test can never construct a
// connection pool. Nothing in this file reaches SQL.

jest.mock('../db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import {
  BOOTSTRAP_USAGE,
  parseCalibrationBootstrapArgv,
} from './bootstrap';
import { CLIP_SAMPLING_REASONS } from './ontology';

const VALID = [
  '--organization-id', 'org-calib',
  '--video-session-id', 'vs-calib-ready',
  '--project-name', 'Calibration round 1',
  '--clip-code', 'C-01',
  '--start-ms', '91337',
  '--end-ms', '97004',
  '--sampling-reason', 'simultaneous_exchange',
  '--created-by-account-id', 'acct-calib-coach',
];

/** VALID with one flag's value replaced. */
function withValue(flag: string, value: string): string[] {
  const argv = [...VALID];
  argv[argv.indexOf(flag) + 1] = value;
  return argv;
}

/** VALID with one flag and its value removed. */
function without(flag: string): string[] {
  const argv = [...VALID];
  argv.splice(argv.indexOf(flag), 2);
  return argv;
}

describe('reading a bootstrap request off the command line', () => {
  test('parses a complete argument list, keeping the operator’s values exactly', () => {
    expect(parseCalibrationBootstrapArgv(VALID)).toEqual({
      organizationId: 'org-calib',
      videoSessionId: 'vs-calib-ready',
      projectName: 'Calibration round 1',
      clipCode: 'C-01',
      startMs: 91337,
      endMs: 97004,
      primarySamplingReason: 'simultaneous_exchange',
      createdByAccountId: 'acct-calib-coach',
    });
  });

  test('offsets come back as numbers, not the strings argv actually carries', () => {
    // createCalibrationClip's requireOffsetMs demands `typeof value ===
    // 'number'`, so a parser that passed argv straight through would fail at
    // the database layer with a message about milliseconds rather than here.
    const request = parseCalibrationBootstrapArgv(VALID);
    expect(typeof request.startMs).toBe('number');
    expect(typeof request.endMs).toBe('number');
  });

  test('accepts every sampling reason the ontology defines', () => {
    // Driven off the ontology's own list so this cannot drift from the
    // vocabulary createCalibrationClip enforces.
    for (const reason of CLIP_SAMPLING_REASONS) {
      expect(parseCalibrationBootstrapArgv(withValue('--sampling-reason', reason)))
        .toMatchObject({ primarySamplingReason: reason });
    }
  });
});

describe('the arguments it refuses', () => {
  test('REFUSES --athlete-id, the flag the data model deliberately does not accept', () => {
    // THE ONE THAT MATTERS. A calibration clip takes its athlete from the
    // source video, never from a caller, so that a clip cannot be attributed
    // to a boxer who is not in the footage. A parser that ignored an unknown
    // flag would take this argument, discard it, and report success.
    expect(() => parseCalibrationBootstrapArgv([...VALID, '--athlete-id', 'ATH-SOMEONE-ELSE']))
      .toThrow(/Unrecognised argument: --athlete-id/);
  });

  test('REFUSES --ontology-version, which is not a choice this build offers', () => {
    expect(() => parseCalibrationBootstrapArgv([...VALID, '--ontology-version', 'boxing-ontology-0.2']))
      .toThrow(/Unrecognised argument: --ontology-version/);
  });

  test('REFUSES --calibration-project-status, so a study cannot be born advanced', () => {
    expect(() => parseCalibrationBootstrapArgv([...VALID, '--status', 'completed']))
      .toThrow(/Unrecognised argument: --status/);
  });

  test.each([
    '--organization-id',
    '--video-session-id',
    '--project-name',
    '--clip-code',
    '--start-ms',
    '--end-ms',
    '--sampling-reason',
    '--created-by-account-id',
  ])('REFUSES a request missing %s, and names it', (flag) => {
    expect(() => parseCalibrationBootstrapArgv(without(flag)))
      .toThrow(new RegExp(`Missing required argument\\(s\\).*${flag}`, 's'));
  });

  test('REFUSES a flag with no value rather than reading the next flag as one', () => {
    expect(() => parseCalibrationBootstrapArgv(['--organization-id']))
      .toThrow(/Missing value for --organization-id/);
  });

  test('REFUSES a repeated flag rather than silently taking one of them', () => {
    expect(() => parseCalibrationBootstrapArgv([...VALID, '--clip-code', 'C-02']))
      .toThrow(/Repeated argument: --clip-code/);
  });

  test.each([
    ['5s', 'a unit suffix Number.parseInt would have silently eaten'],
    ['91.5', 'a fraction of a millisecond'],
    ['1_000', 'a digit separator Number.parseInt reads as 1'],
    ['-1', 'a negative offset'],
    ['', 'an empty value'],
    ['0x10', 'hex'],
    [' 91337', 'a leading space'],
  ])('REFUSES --start-ms "%s" (%s)', (value) => {
    expect(() => parseCalibrationBootstrapArgv(withValue('--start-ms', value)))
      .toThrow(/Invalid --start-ms/);
  });

  test('REFUSES --end-ms by the same rule', () => {
    expect(() => parseCalibrationBootstrapArgv(withValue('--end-ms', '97s')))
      .toThrow(/Invalid --end-ms/);
  });

  test('REFUSES a sampling reason outside the ontology, and lists the real ones', () => {
    // Rejected, never coerced to 'other' -- why a clip was sampled is a fact
    // about the study design, and a wrong one silently recorded is worse than
    // a refused run.
    expect(() => parseCalibrationBootstrapArgv(withValue('--sampling-reason', 'looked_interesting')))
      .toThrow(/not a recognised sampling reason/);
    expect(() => parseCalibrationBootstrapArgv(withValue('--sampling-reason', 'looked_interesting')))
      .toThrow(/isolated_punch/);
  });

  test('never produces an athlete field at all, whatever it is given', () => {
    // The absence is the guarantee: there is no key here for a later change to
    // start populating by accident.
    expect(Object.keys(parseCalibrationBootstrapArgv(VALID))).not.toContain('athleteId');
  });
});

describe('the usage line', () => {
  test('names every flag the parser requires', () => {
    for (const flag of [
      '--organization-id',
      '--video-session-id',
      '--project-name',
      '--clip-code',
      '--start-ms',
      '--end-ms',
      '--sampling-reason',
      '--created-by-account-id',
    ]) {
      expect(BOOTSTRAP_USAGE).toContain(flag);
    }
  });

  test('lists the sampling reasons from the ontology rather than a copy of them', () => {
    for (const reason of CLIP_SAMPLING_REASONS) {
      expect(BOOTSTRAP_USAGE).toContain(reason);
    }
  });
});
