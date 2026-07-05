/**
 * Theme model for the app: two looks that share one component tree.
 *
 *  - 'fun'    — Tokyo-night futuristic, neon purple, playful hiking copy.
 *  - 'simple' — clean, light, no-nonsense.
 *
 * The palette itself lives in index.css (CSS variables keyed by data-theme). This
 * module owns the parts that JSX needs: the current theme, its persistence, and the
 * user-facing copy that differs between the two.
 */

export type Theme = 'fun' | 'simple';

const STORAGE_KEY = 'ask-docs-theme';

/**
 * Persona marker. In fun mode the UI prepends this to the message it sends, and the
 * agent's system prompt (aws-blocks/index.ts) switches to the playful persona when a
 * message starts with it. The UI strips it back off before displaying the message, so
 * the user never sees it. Keep this literal in sync with the backend system prompt.
 */
export const PERSONA_MARKER = '[[FUN]]';

/** Prepend the persona marker when in fun mode; leave the text untouched otherwise. */
export function applyPersona(text: string, theme: Theme): string {
  return theme === 'fun' ? `${PERSONA_MARKER} ${text}` : text;
}

/** Remove a leading persona marker so it never shows in the chat bubble. */
export function stripPersona(text: string): string {
  return text.replace(/^\[\[FUN\]\]\s*/, '');
}

/** Load the saved theme, defaulting to the fun one for first-time visitors. */
export function loadTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === 'simple' || saved === 'fun' ? saved : 'fun';
}

/** Persist the chosen theme so a teammate's pick survives a refresh. */
export function saveTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
}

/** Copy that changes per theme. The 'fun' strings carry the Tokyo + hiking humour. */
export interface ThemeCopy {
  title: string;
  subtitle: string;
  emptyState: string;
  inputPlaceholder: string;
  sendLabel: string;
  newChatLabel: string;
  modelLabel: string;
  modelHint: string;
  /** Rotating "thinking" messages — fun mode cycles through them for delight. */
  thinking: string[];
  authTagline: string;
}

export const COPY: Record<Theme, ThemeCopy> = {
  fun: {
    title: '⛩️ Handover Base Camp',
    subtitle:
      "Ask the docs while I'm off summiting Mt. Fuji 🗻 — I only know what's written down. Everything else is somewhere on a mountain with no signal.",
    emptyState:
      "🥾 No questions yet. Ask me anything from the handover — I promise not to say “it depends”.",
    inputPlaceholder: 'Ask base camp anything…',
    sendLabel: 'Send it 🚀',
    newChatLabel: '🥾 New trek',
    modelLabel: 'Trail guide',
    modelHint: 'Switching guide starts a fresh trek',
    thinking: [
      '🥾 Trekking through the docs…',
      '🗻 Summiting Mt. Fuji for your answer…',
      '🍜 Slurping ramen, back in a sec…',
      '🚄 Catching the Shinkansen to that section…',
      '🏮 Following the trail markers…',
    ],
    authTagline: 'Team access only — account and authenticator required. 🔐',
  },
  simple: {
    title: 'Ask my handover docs',
    subtitle:
      "Answers your team's questions from the handover documents — processes, contacts, and where things live. It only knows what's in the docs.",
    emptyState:
      'Ask about the handover docs — e.g. “who do I contact for deployments?” or “how do I roll back production?”',
    inputPlaceholder: 'Ask the handover docs…',
    sendLabel: 'Send',
    newChatLabel: 'New chat',
    modelLabel: 'Model',
    modelHint: 'Switching model starts a new chat',
    thinking: ['Thinking…'],
    authTagline: 'Accounts are created by the administrator. MFA is required.',
  },
};
