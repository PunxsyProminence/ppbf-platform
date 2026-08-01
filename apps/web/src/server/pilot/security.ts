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
