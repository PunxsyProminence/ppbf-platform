export function getPilotRoleDestination(role: unknown): string | null {
  if (role === 'platform_owner' || role === 'organization_admin' || role === 'admin') {
    return '/admin';
  }
  if (role === 'coach') {
    return '/coach/review-queue';
  }
  if (role === 'athlete') {
    return '/athlete/dashboard';
  }
  if (role === 'parent') {
    return '/parent/dashboard';
  }
  if (role === 'board') {
    return '/board';
  }
  return null;
}
