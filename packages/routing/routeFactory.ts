import { ROUTING_MATRIX } from '../governance/featureFlags';

export interface RouteRequest {
  goal: string;
  participantType: string;
  lifecycleTag: string;
  taskDimension: string;
}

export function generateRoute(request: RouteRequest) {
  // Uses the full 16×11 matrix
  const tags = ROUTING_MATRIX.lifecycleTags.length ? ROUTING_MATRIX.lifecycleTags : ['Youth Development (Non-Contact Safe)'];
  const dims = ROUTING_MATRIX.taskDimensions.length ? ROUTING_MATRIX.taskDimensions : ['Emotional Regulation & Stress Response'];

  const effectiveTag = request.lifecycleTag || tags[0];
  const effectiveDim = request.taskDimension || dims[0];

  const route = {
    assignedRoute: request.participantType,
    lifecycleTag: effectiveTag,
    taskDimension: effectiveDim,
    matrixPosition: {
      rank: Math.floor(Math.random() * ROUTING_MATRIX.ranks) + 1,
      tagIndex: tags.indexOf(effectiveTag),
      dimensionIndex: dims.indexOf(effectiveDim),
    },
    safetyGate: 'pending_jason_approval',
  };
  return route;
}

export const ALL_LIFECYCLE_TAGS = ROUTING_MATRIX.lifecycleTags;
export const ALL_TASK_DIMENSIONS = ROUTING_MATRIX.taskDimensions;
