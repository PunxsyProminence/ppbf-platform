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
  {
    name: 'personal_projects',
    owner: 'punxsy.prominence.boxing@gmail.com',
    allowedData: ['camper', 'danielle_consulting', 'neeko_3d', 'henry_military'],
    isolated: true,
  },
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
