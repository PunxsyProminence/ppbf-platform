import { checkGuardianMediaConsent, readAdultOwnMediaConsent, type ConsentCheckResult, type OwnMediaConsent } from './guardianConsent';
import { assertConsentCoversVideo, coverageRefusalKind } from './videoPlaybackConsent';
import { ConflictError } from './errors';

jest.mock('./guardianConsent', () => ({
  ...jest.requireActual('./guardianConsent'),
  checkGuardianMediaConsent: jest.fn(),
  readAdultOwnMediaConsent: jest.fn(),
}));

const mockCheck = jest.mocked(checkGuardianMediaConsent);
const mockAdultOwn = jest.mocked(readAdultOwnMediaConsent);

function guardians(status: string | null, coversVideo: boolean | null = true): ConsentCheckResult {
  return {
    ok: status === 'signed',
    guardianIds: ['parent-1'],
    missingParentIds: status === 'signed' ? [] : ['parent-1'],
    perGuardian: [{ parentId: 'parent-1', status, coversVideo, publicUseAllowed: false, signedAt: null }],
    retained: [],
  };
}

function own(over: Partial<OwnMediaConsent> = {}): OwnMediaConsent {
  return { status: 'signed', coversVideo: true, publicUseAllowed: false, signedAt: '2026-10-01T00:00:00Z', recordedByOwnLogin: true, ...over };
}

const code = (promise: Promise<unknown>) => promise.then(() => 'plays', (error: { code?: string }) => error.code ?? 'threw');

beforeEach(() => {
  mockCheck.mockReset();
  mockAdultOwn.mockReset();
});

describe("an adult's own consent governs their playback (OD-2026-10-08-015)", () => {
  test('their own video consent plays, though the guardian-era row is withdrawn', async () => {
    mockCheck.mockResolvedValue(guardians('withdrawn', false));
    mockAdultOwn.mockResolvedValue(own());
    await expect(code(assertConsentCoversVideo('org-a', 'ath-1'))).resolves.toBe('plays');
  });

  test('their own video consent plays, though the guardian-era row is photo-only', async () => {
    mockCheck.mockResolvedValue(guardians('signed', false));
    mockAdultOwn.mockResolvedValue(own());
    await expect(code(assertConsentCoversVideo('org-a', 'ath-1'))).resolves.toBe('plays');
  });

  test('their own withdrawal refuses, though the guardian-era row consents to video', async () => {
    mockCheck.mockResolvedValue(guardians('signed', true));
    mockAdultOwn.mockResolvedValue(own({ status: 'withdrawn', coversVideo: false }));
    await expect(code(assertConsentCoversVideo('org-a', 'ath-1'))).resolves.toBe('ADULT_OWN_CONSENT_WITHDRAWN');
  });

  test('their own photo-only consent refuses', async () => {
    mockCheck.mockResolvedValue(guardians('signed', true));
    mockAdultOwn.mockResolvedValue(own({ coversVideo: false }));
    await expect(code(assertConsentCoversVideo('org-a', 'ath-1'))).resolves.toBe('ADULT_OWN_CONSENT_EXCLUDES_VIDEO');
  });

  test('an own status this gate cannot read refuses', async () => {
    mockCheck.mockResolvedValue(guardians('signed', true));
    mockAdultOwn.mockResolvedValue(own({ status: 'declined' }));
    await expect(code(assertConsentCoversVideo('org-a', 'ath-1'))).resolves.toBe('ADULT_OWN_CONSENT_UNREADABLE');
  });

  test('a signature recorded untidily still counts', async () => {
    mockCheck.mockResolvedValue(guardians('withdrawn', false));
    mockAdultOwn.mockResolvedValue(own({ status: ' Signed ' }));
    await expect(code(assertConsentCoversVideo('org-a', 'ath-1'))).resolves.toBe('plays');
  });

  test("a signed row the adult's own login did not record cannot authorise: the guardian-era reading stands", async () => {
    mockCheck.mockResolvedValue(guardians('withdrawn', false));
    mockAdultOwn.mockResolvedValue(own({ recordedByOwnLogin: false }));
    await expect(code(assertConsentCoversVideo('org-a', 'ath-1'))).resolves.toBe('GUARDIAN_CONSENT_WITHDRAWN');
  });

  test("their own video consent plays over a purged former guardian's retained no", async () => {
    mockCheck.mockResolvedValue({
      ...guardians(null, null),
      guardianIds: [],
      perGuardian: [],
      retained: [{ parentId: 'former-1', status: 'withdrawn', coversVideo: false, publicUseAllowed: false, signedAt: null }],
    });
    mockAdultOwn.mockResolvedValue(own());
    await expect(code(assertConsentCoversVideo('org-a', 'ath-1'))).resolves.toBe('plays');
  });

  test("a photo-only row their own login did not record still refuses: it can refuse, never authorise", async () => {
    mockCheck.mockResolvedValue(guardians('signed', true));
    mockAdultOwn.mockResolvedValue(own({ coversVideo: false, recordedByOwnLogin: false }));
    await expect(code(assertConsentCoversVideo('org-a', 'ath-1'))).resolves.toBe('ADULT_OWN_CONSENT_EXCLUDES_VIDEO');
  });

  test('the adult read runs after the guardian read (which takes the lock), on the same client', async () => {
    const client = { query: jest.fn() };
    const order: string[] = [];
    mockCheck.mockImplementation(async () => { order.push('guardian'); return guardians('signed', true); });
    mockAdultOwn.mockImplementation(async () => { order.push('adult'); return null; });
    await assertConsentCoversVideo('org-a', 'ath-1', client);
    expect(order).toEqual(['guardian', 'adult']);
    expect(mockCheck).toHaveBeenCalledWith('org-a', 'ath-1', client);
    expect(mockAdultOwn).toHaveBeenCalledWith('org-a', 'ath-1', client);
  });
});

describe('a minor, an unknown date of birth, or an adult with no own row: unchanged', () => {
  test.each([
    ['guardian video consent plays', guardians('signed', true), 'plays'],
    ['guardian withdrawal refuses', guardians('withdrawn', false), 'GUARDIAN_CONSENT_WITHDRAWN'],
    ['guardian photo-only refuses', guardians('signed', false), 'GUARDIAN_CONSENT_EXCLUDES_VIDEO'],
    ['an unreadable guardian status refuses', guardians('active', true), 'GUARDIAN_CONSENT_UNREADABLE'],
    ['no guardian row on file still plays (absence plays)', guardians(null, null), 'plays'],
  ])('%s', async (_label, consent, expected) => {
    mockCheck.mockResolvedValue(consent);
    mockAdultOwn.mockResolvedValue(null);
    await expect(code(assertConsentCoversVideo('org-a', 'ath-1'))).resolves.toBe(expected);
  });
});

describe("coverageRefusalKind reads a guardian's refusal and an adult's own as the same three kinds", () => {
  test.each([
    ['GUARDIAN_CONSENT_WITHDRAWN', 'withdrawn'],
    ['GUARDIAN_CONSENT_EXCLUDES_VIDEO', 'excludes_video'],
    ['GUARDIAN_CONSENT_UNREADABLE', 'unreadable'],
    ['ADULT_OWN_CONSENT_WITHDRAWN', 'withdrawn'],
    ['ADULT_OWN_CONSENT_EXCLUDES_VIDEO', 'excludes_video'],
    ['ADULT_OWN_CONSENT_UNREADABLE', 'unreadable'],
    ['GUARDIAN_CONSENT_MISSING', null],
  ])('%s', (errorCode, kind) => {
    expect(coverageRefusalKind(new ConflictError('Blocked.', errorCode))).toBe(kind);
  });

  test('anything that is not a ConflictError is not a refusal', () => {
    const fault = Object.assign(new Error('boom'), { code: 'ADULT_OWN_CONSENT_WITHDRAWN' });
    expect(coverageRefusalKind(fault)).toBeNull();
  });
});
