import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(nodeScrypt);

export async function hashPin(pin: string): Promise<string> {
  const normalized = pin.trim();
  if (!normalized) {
    throw new Error('PIN is required');
  }

  const salt = randomBytes(16).toString('hex');
  const derived = (await scrypt(normalized, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

export async function verifyPin(pin: string, encodedHash: string): Promise<boolean> {
  const parts = encodedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }

  const [, salt, storedHex] = parts;
  const derived = (await scrypt(pin.trim(), salt, 64)) as Buffer;
  const stored = Buffer.from(storedHex, 'hex');

  if (derived.length !== stored.length) {
    return false;
  }

  return timingSafeEqual(derived, stored);
}

/**
 * scrypt cost for a password. The numbers are written into every stored hash,
 * so raising one here changes new hashes only and old ones still verify.
 *
 * N is double hashPin's (Node's default 2^14): a starting point, open to the
 * architect's review. One hash needs about 128 * N * r bytes (33 MB here),
 * which is over node:crypto's default 32 MB ceiling -- hence maxmem below.
 */
export const PASSWORD_SCRYPT_COST = { N: 2 ** 15, r: 8, p: 1 } as const;

/** Refuses a stored cost no hash written here could carry, before deriving. */
const MAX_STORED_SCRYPT_N = 2 ** 20;

function scryptOptions(cost: { N: number; r: number; p: number }) {
  return { ...cost, maxmem: 256 * cost.N * cost.r };
}

// promisify picks scrypt's three-argument overload; this is the four-argument
// one, still the asynchronous form (libuv's thread pool, not the request thread).
function scryptWithCost(secret: string, salt: string, cost: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(secret, salt, 64, scryptOptions(cost), (error, derived) => (error ? reject(error) : resolve(derived)));
  });
}

/** One spelling per password: a composed and a decomposed "é" are the same key. */
function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

/**
 * Hashes a password a person chose. Stored as scrypt$N$r$p$salt$hex.
 *
 * Not hashPin: a PIN is trimmed and a password is not (a leading or trailing
 * space is part of what the person typed), and the two formats do not verify
 * as each other, so a PIN hash can never be accepted as a password.
 */
export async function hashPassword(password: string): Promise<string> {
  const normalized = normalizePassword(password);
  if (!normalized) {
    throw new Error('Password is required');
  }

  const { N, r, p } = PASSWORD_SCRYPT_COST;
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptWithCost(normalized, salt, PASSWORD_SCRYPT_COST);
  return `scrypt$${N}$${r}$${p}$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const parts = encodedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }

  const [, rawN, rawR, rawP, salt, storedHex] = parts;
  const cost = { N: Number(rawN), r: Number(rawR), p: Number(rawP) };
  const costIsSane = Number.isInteger(cost.N) && cost.N >= 2 ** 14 && cost.N <= MAX_STORED_SCRYPT_N
    && (cost.N & (cost.N - 1)) === 0
    && Number.isInteger(cost.r) && cost.r >= 1 && cost.r <= 32
    && Number.isInteger(cost.p) && cost.p >= 1 && cost.p <= 16;
  if (!costIsSane || !salt || !storedHex) {
    return false;
  }

  const derived = await scryptWithCost(normalizePassword(password), salt, cost);
  const stored = Buffer.from(storedHex, 'hex');

  if (derived.length !== stored.length) {
    return false;
  }

  return timingSafeEqual(derived, stored);
}

// Both header names are in live use -- the admin bootstrap/migration routes
// and their deploy tooling send x-ppbf-bootstrap-key, the SHADOW job drain
// sends x-bootstrap-key -- so both must keep being accepted.
const BOOTSTRAP_KEY_HEADERS = ['x-ppbf-bootstrap-key', 'x-bootstrap-key'];

export function readBootstrapKeyHeader(headers: Headers): string {
  for (const header of BOOTSTRAP_KEY_HEADERS) {
    const value = headers.get(header)?.trim();
    if (value) {
      return value;
    }
  }

  return '';
}

// Compares the operator key in constant time: a length-independent byte
// comparison would leak the expected key one character at a time to a caller
// that can time the response.
export function bootstrapKeyMatches(headers: Headers, expectedKey: string | undefined): boolean {
  const provided = readBootstrapKeyHeader(headers);
  const expected = expectedKey?.trim() || '';

  if (!provided || !expected) {
    return false;
  }

  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export function createOpaqueToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
