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

export function createOpaqueToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
