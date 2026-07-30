export interface ShadowConversationHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

const DEFAULT_MAX_HISTORY_MESSAGES = 10;
const DEFAULT_MAX_HISTORY_CHARS = 24_000;

/**
 * Select complete newest conversation turns without truncating message content.
 * This prevents an old conversation from consuming an unbounded provider
 * context window while keeping role order intact.
 */
export function budgetConversationHistory(
  messages: ShadowConversationHistoryMessage[],
  options: {
    maxMessages?: number;
    maxChars?: number;
  } = {},
): ShadowConversationHistoryMessage[] {
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_HISTORY_CHARS;
  if (
    !Number.isSafeInteger(maxMessages)
    || maxMessages <= 0
    || !Number.isSafeInteger(maxChars)
    || maxChars <= 0
  ) {
    return [];
  }

  const recent = messages.slice(-maxMessages);
  const turns: ShadowConversationHistoryMessage[][] = [];
  let currentTurn: ShadowConversationHistoryMessage[] = [];

  for (const message of recent) {
    if (message.role === 'user' && currentTurn.length > 0) {
      turns.push(currentTurn);
      currentTurn = [];
    }
    currentTurn.push(message);
  }
  if (currentTurn.length > 0) {
    turns.push(currentTurn);
  }

  const selected: ShadowConversationHistoryMessage[][] = [];
  let usedChars = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const turnChars = turn.reduce((total, message) => total + message.content.length, 0);
    if (usedChars + turnChars > maxChars) {
      break;
    }
    selected.push(turn);
    usedChars += turnChars;
  }

  return selected.reverse().flat();
}
