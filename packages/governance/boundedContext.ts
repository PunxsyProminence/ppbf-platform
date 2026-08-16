export interface BoundedContext {
  name: string;
  owner: string;
  allowedData: string[];
  isolated: boolean;
}

export const boundedContexts: BoundedContext[] = [
  {
    name: 'nonprofit',
    owner: 'admin@punxsyprominence.org',
    allowedData: ['athlete_data', 'sessions', 'governance'],
    isolated: true,
  },
  // A personal-projects context used to be declared here with a personal
  // email and a list of the owner's unrelated private ventures -- data about
  // non-platform matters in a public nonprofit repo, consumed by nothing.
  // Unknown contexts already fail closed in enforceBoundedContext, which is
  // the correct answer for anything that is not the nonprofit.
];

export function enforceBoundedContext(contextName: string, dataType: string) {
  const context = boundedContexts.find(c => c.name === contextName);
  if (!context) return { allowed: false, reason: 'Unknown context' };

  if (!context.allowedData.includes(dataType) && context.isolated) {
    return {
      allowed: false,
      reason: `Data type '${dataType}' not allowed in ${contextName} context`,
    };
  }

  return { allowed: true };
}
