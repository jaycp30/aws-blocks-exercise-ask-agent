/**
 * Conversation persistence.
 *
 * The backend already stores every conversation in DynamoDB; this only remembers WHICH
 * conversation the user was in, so a page reload resumes it instead of starting fresh.
 * Scoped per model because each model is a separate agent with its own conversations.
 */

const KEY_PREFIX = 'ask-docs-convo:';

/** The conversation id last used for this model, if any. */
export function loadConversationId(model: string): string | null {
  return localStorage.getItem(KEY_PREFIX + model);
}

/** Remember the active conversation id for this model so a reload can resume it. */
export function saveConversationId(model: string, id: string): void {
  localStorage.setItem(KEY_PREFIX + model, id);
}

/** Forget the stored conversation for this model (used by "New chat"). */
export function clearConversationId(model: string): void {
  localStorage.removeItem(KEY_PREFIX + model);
}
