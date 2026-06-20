export function handlePPBFError(error: any, context: string) {
  console.error(`[PPBF ERROR - ${context}]`, error);

  // Log to Continuity Ledger in production
  return {
    handled: true,
    message: 'An error occurred. It has been logged for governance review.',
    context,
  };
}
