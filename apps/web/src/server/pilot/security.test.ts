import {
  PASSWORD_SCRYPT_COST,
  bootstrapKeyMatches,
  hashPassword,
  hashPin,
  verifyPassword,
  verifyPin,
} from './security';

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

describe('security password hashing', () => {
  const PASSWORD = 'correct horse battery';

  test('the stored hash carries its own cost, a fresh salt, and never the password', async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);

    const { N, r, p } = PASSWORD_SCRYPT_COST;
    expect(first.split('$').slice(0, 4)).toEqual(['scrypt', String(N), String(r), String(p)]);
    expect(first.split('$')).toHaveLength(6);
    expect(first).not.toContain(PASSWORD);
    expect(second).not.toBe(first);
  });

  test('the right password verifies and a wrong one does not', async () => {
    const hashed = await hashPassword(PASSWORD);

    await expect(verifyPassword(PASSWORD, hashed)).resolves.toBe(true);
    await expect(verifyPassword('correct horse batterx', hashed)).resolves.toBe(false);
  });

  test('a space at either end is part of the password, unlike a PIN', async () => {
    const hashed = await hashPassword(PASSWORD);

    await expect(verifyPassword(` ${PASSWORD}`, hashed)).resolves.toBe(false);
    await expect(verifyPassword(`${PASSWORD} `, hashed)).resolves.toBe(false);
  });

  test('a composed and a decomposed spelling of the same password are one password', async () => {
    const hashed = await hashPassword('café au lait 99');

    await expect(verifyPassword('café au lait 99', hashed)).resolves.toBe(true);
  });

  test('a hash written at a different cost still verifies, by the cost it names', async () => {
    // What makes PASSWORD_SCRYPT_COST safe to raise: old rows keep working.
    const { scryptSync } = jest.requireActual('node:crypto') as typeof import('node:crypto');
    const salt = 'a1'.repeat(16);
    const older = scryptSync(PASSWORD, salt, 64, { N: 2 ** 14, r: 8, p: 1 }).toString('hex');

    await expect(verifyPassword(PASSWORD, `scrypt$16384$8$1$${salt}$${older}`)).resolves.toBe(true);
    // The same bytes under the wrong stated cost derive a different key.
    await expect(verifyPassword(PASSWORD, `scrypt$32768$8$1$${salt}$${older}`)).resolves.toBe(false);
  });

  test('a PIN hash is never a password, and a password hash is never a PIN', async () => {
    // The parent rows the retired createParentAccount left behind hold PIN
    // hashes. One of those must not verify as a password under any input.
    const pinHash = await hashPin('481902');
    const passwordHash = await hashPassword('4819024819');

    await expect(verifyPassword('481902', pinHash)).resolves.toBe(false);
    await expect(verifyPin('4819024819', passwordHash)).resolves.toBe(false);
  });

  test.each([
    ['not scrypt', 'bcrypt$32768$8$1$aa$bb'],
    ['a cost that is not a power of two', 'scrypt$30000$8$1$aa$bb'],
    ['a cost below any this code wrote', 'scrypt$2$8$1$aa$bb'],
    ['a cost large enough to exhaust memory', `scrypt$${2 ** 24}$8$1$aa$bb`],
    ['a non-numeric cost', 'scrypt$N$8$1$aa$bb'],
    ['an empty salt', 'scrypt$32768$8$1$$bb'],
    ['an empty string', ''],
  ])('a malformed stored hash refuses without deriving: %s', async (_label, stored) => {
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(false);
  });

  test('an empty password is refused, not hashed', async () => {
    await expect(hashPassword('')).rejects.toThrow('Password is required');
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
