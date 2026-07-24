jest.mock('./shadowUserProfile', () => ({
  getOrCreateShadowUserProfile: jest.fn(),
  buildUserShadowContext: jest.fn(),
}));

jest.mock('./db', () => ({
  query: jest.fn(),
}));

import {
  buildUserShadowContext,
  getOrCreateShadowUserProfile,
} from './shadowUserProfile';
import { buildPersonalShadowPrompt } from './shadowPersonalization';

const mockGetOrCreateShadowUserProfile = jest.mocked(getOrCreateShadowUserProfile);
const mockBuildUserShadowContext = jest.mocked(buildUserShadowContext);

describe('SHADOW personalization role boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('keeps Board fail-closed without loading personal or athlete context', async () => {
    const result = await buildPersonalShadowPrompt(
      'board-account',
      'org-1',
      'board',
      'Summarize an athlete',
    );

    expect(result.systemPrompt).toContain('SHADOW chat is not available to Board accounts');
    expect(result.systemPrompt).toContain('aggregate-only Board workspace');
    expect(result.userContext).toBe('');
    expect(mockGetOrCreateShadowUserProfile).not.toHaveBeenCalled();
    expect(mockBuildUserShadowContext).not.toHaveBeenCalled();
  });
});
