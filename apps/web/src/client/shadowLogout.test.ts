import { revokeShadowSession } from './shadowLogout';

describe('SHADOW logout', () => {
  test('revokes the HttpOnly server session before local logout', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    await revokeShadowSession('https://staging.example.test/', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://staging.example.test/api/pilot/auth/logout',
      {
        method: 'POST',
        credentials: 'include',
      },
    );
  });

  test('reports server-side revocation failure to the caller', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 503 });

    await expect(
      revokeShadowSession('', fetchImpl),
    ).rejects.toThrow('shadow_logout_failed_503');
  });
});
