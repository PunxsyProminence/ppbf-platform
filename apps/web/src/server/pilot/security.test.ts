import { hashPin, verifyPin } from './security';

describe('security PIN hashing', () => {
  test('hashPin returns a salted hash and never returns plaintext', async () => {
    const pin = '123456';
    const hashed = await hashPin(pin);

    expect(hashed).toContain('scrypt$');
    expect(hashed).not.toContain(pin);
  });

  test('verifyPin accepts correct PIN and rejects incorrect PIN', async () => {
    const hashed = await hashPin('123456');

    await expect(verifyPin('123456', hashed)).resolves.toBe(true);
    await expect(verifyPin('654321', hashed)).resolves.toBe(false);
  });
});
