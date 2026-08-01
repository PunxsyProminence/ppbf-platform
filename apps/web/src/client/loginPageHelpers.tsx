export function getMicrosoftStartUrl(apiBaseUrl: string): string {
  const startPath = '/api/pilot/auth/microsoft/start';

  if (typeof window !== 'undefined' && apiBaseUrl.trim()) {
    try {
      const configuredBase = new URL(apiBaseUrl, window.location.origin);
      if (configuredBase.origin !== window.location.origin) {
        return startPath;
      }
      return `${configuredBase.origin}${startPath}`;
    } catch {
      return startPath;
    }
  }

  if (!apiBaseUrl.trim()) {
    return startPath;
  }

  return `${apiBaseUrl}${startPath}`;
}

export function signInWithMicrosoft(apiBaseUrl: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.location.assign(getMicrosoftStartUrl(apiBaseUrl));
}

export function createMicrosoftSignInHandler(apiBaseUrl: string): () => void {
  return () => signInWithMicrosoft(apiBaseUrl);
}
