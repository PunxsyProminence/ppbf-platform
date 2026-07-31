import { bootstrapKeyMatches, hashPin, verifyPin } from './security';

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

describe('bootstrapKeyMatches', () => {
  // Deploy tooling and the SHADOW job drain send different header names for
  // the same key. Dropping either one silently locks out a live caller.
  test.each(['x-ppbf-bootstrap-key', 'x-bootstrap-key'])('accepts the key sent as %s', (header) => {
    expect(bootstrapKeyMatches(new Headers({ [header]: 'operator-key' }), 'operator-key')).toBe(true);
  });

  test('rejects a wrong key, a missing header, and an unset expected key', () => {
    expect(bootstrapKeyMatches(new Headers({ 'x-bootstrap-key': 'wrong' }), 'operator-key')).toBe(false);
    expect(bootstrapKeyMatches(new Headers(), 'operator-key')).toBe(false);
    expect(bootstrapKeyMatches(new Headers({ 'x-bootstrap-key': 'operator-key' }), undefined)).toBe(false);
    expect(bootstrapKeyMatches(new Headers({ 'x-bootstrap-key': 'operator-key' }), '   ')).toBe(false);
  });

  test('a shorter or longer candidate is rejected rather than throwing', () => {
    expect(bootstrapKeyMatches(new Headers({ 'x-bootstrap-key': 'operator' }), 'operator-key')).toBe(false);
    expect(bootstrapKeyMatches(new Headers({ 'x-bootstrap-key': 'operator-key-plus' }), 'operator-key')).toBe(false);
  });
});
