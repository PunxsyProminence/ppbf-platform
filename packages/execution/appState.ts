export interface AppState {
  currentUser: any | null;
  currentParticipant: any | null;
  activeRoute: any | null;
  pendingReviews: number;
}

export const initialState: AppState = {
  currentUser: null,
  currentParticipant: null,
  activeRoute: null,
  pendingReviews: 0,
};

export function updateState(currentState: AppState, updates: Partial<AppState>): AppState {
  return { ...currentState, ...updates };
}
