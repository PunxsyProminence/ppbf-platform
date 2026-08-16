import {
  createMicrosoftSignInHandler,
  getMicrosoftStartUrl,
} from './loginPageHelpers';

describe('login page helpers', () => {
  test('builds the Microsoft start URL from the API base when origin matches', () => {
    const assign = global.window;
    Object.defineProperty(global, 'window', {
      value: { location: { origin: 'http://localhost:3000' } },
      writable: true,
    });

    expect(getMicrosoftStartUrl('http://localhost:3000')).toBe('http://localhost:3000/api/pilot/auth/microsoft/start');

    Object.defineProperty(global, 'window', {
      value: assign,
      writable: true,
    });
  });

  test('falls back to same-origin Microsoft start URL when configured API base is cross-origin', () => {
    const assign = global.window;
    Object.defineProperty(global, 'window', {
      value: { location: { origin: 'https://www.punxsyprominence.org' } },
      writable: true,
    });

    expect(getMicrosoftStartUrl('https://app-example.example-env.eastus.azurecontainerapps.io')).toBe(
      '/api/pilot/auth/microsoft/start',
    );

    Object.defineProperty(global, 'window', {
      value: assign,
      writable: true,
    });
  });

  // The only helper the login page actually calls. Asserted through the handler
  // rather than through signInWithMicrosoft so the covered path is the one
  // production takes.
  test('the sign-in handler navigates to the resolved Microsoft start URL', () => {
    const original = global.window;
    const navigated: string[] = [];
    Object.defineProperty(global, 'window', {
      value: {
        location: {
          origin: 'http://localhost:3000',
          assign: (url: string) => navigated.push(url),
        },
      },
      writable: true,
    });

    createMicrosoftSignInHandler('http://localhost:3000')();

    expect(navigated).toEqual(['http://localhost:3000/api/pilot/auth/microsoft/start']);

    Object.defineProperty(global, 'window', {
      value: original,
      writable: true,
    });
  });
});
