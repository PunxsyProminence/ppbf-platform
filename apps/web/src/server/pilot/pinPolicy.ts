export const DEFAULT_PIN_LENGTH = 6;

export function validatePinPolicy(pin: string): void {
  const normalized = pin.trim();
  if (!normalized) {
    throw new Error('PIN is required');
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error('PIN must contain only digits');
  }

  if (normalized.length !== DEFAULT_PIN_LENGTH) {
    throw new Error(`PIN must be exactly ${DEFAULT_PIN_LENGTH} digits`);
  }
}