function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundToOneDecimal(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

export function calculateReadinessL14(
  sleepHours: number,
  sorenessLevel: number,
  disciplineScore: number,
): number {
  // Keep formula coefficients in hundredths to reduce float drift at x.x5
  // rounding boundaries (for example, values that should land on 4.15).
  const rawScore = ((sleepHours * 125) - (sorenessLevel * 45) + (disciplineScore * 30)) / 100;
  const clamped = clamp(rawScore, 1, 10);
  return roundToOneDecimal(clamped);
}

export function calculateDeltaRPE(rpeObserved: number, rpeIntended: number): number {
  return rpeObserved - rpeIntended;
}

export function isDeltaRPELocked(deltaRpe: number, rationale: string | null): boolean {
  if (deltaRpe < 2) {
    return false;
  }

  return !rationale || rationale.trim().length === 0;
}
