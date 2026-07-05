import { useEffect, useRef, useState } from 'react';
import { api } from 'aws-blocks';
import { useChat, type ChatMessage } from '@aws-blocks/bb-agent/client';
import { applyPersona, COPY, loadTheme, saveTheme, stripPersona, type Theme, type ThemeCopy } from './theme';
import { clearConversationId, loadConversationId, saveConversationId } from './session';

// Backend APIs are fully typed — hover over api.* for signatures.
// Full docs: node_modules/@aws-blocks/blocks/README.md

type User = { username: string };
type ModelOption = { key: string; label: string };

/** Cycle through `messages` every 2s while `active`; returns the current one. */
function useRotatingMessage(messages: string[], active: boolean): string {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!active) {
      setIndex(0);
      return;
    }
    if (messages.length <= 1) return;
    const id = setInterval(() => setIndex((n) => (n + 1) % messages.length), 2000);
    return () => clearInterval(id);
  }, [active, messages.length]);

  return messages[index] ?? messages[0] ?? '';
}

// `model` is fixed for the lifetime of a ChatApp instance: App keys <ChatApp> by model,
// so switching models remounts this component with a fresh conversation. That matches the
// backend, where each model is a separate agent with its own storage and Realtime channel.
function ChatApp({ model, copy, theme }: { model: string; copy: ThemeCopy; theme: Theme }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const thinkingMessage = useRotatingMessage(copy.thinking, loading);

  // Hold the live theme in a ref so the send closure below (created once) reads the
  // CURRENT persona — this is what lets toggling the theme change tone mid-conversation.
  const personaRef = useRef<Theme>(theme);
  personaRef.current = theme;

  // useChat is a factory, NOT a React hook — create it exactly once.
  // It owns the subscribe-before-send ordering and channel lifecycle.
  const chatRef = useRef<ReturnType<typeof useChat> | null>(null);
  if (!chatRef.current) {
    chatRef.current = useChat({
      api: {
        // Pass the selected model on every call — storage + channel are per-agent.
        // In fun mode, prepend the persona marker so the agent answers in-character.
        sendMessage: async (convId, msg, chId) => {
          await api.sendMessage(convId, applyPersona(msg, personaRef.current), chId, model);
        },
        createConversation: () => api.createConversation(model),
        // Strip the persona marker from stored user messages so it never shows on reload.
        getConversation: async (id) => {
          const res = await api.getConversation(id, model);
          return {
            ...res,
            messages: res.messages.map((m) =>
              m.role === 'user' ? { ...m, content: stripPersona(m.content) } : m,
            ),
          };
        },
      },
      // Subscribe to the Realtime (WebSocket) channel the agent streams chunks on.
      subscribe: async (channelId, handler) => {
        const channel = await api.getChannel(channelId, model);
        return channel.subscribe(handler);
      },
      onMessagesChange: setMessages,
      onLoadingChange: setLoading,
      onError: (e) => setMessages((m) => [...m, errorBubble(e)]),
    });
  }
  const chat = chatRef.current;

  // Auto-scroll to the newest message as tokens stream in.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // On mount (i.e. per model), resume the last conversation for this model if we saved
  // one; otherwise the first send lazily creates a fresh one. Tear down the subscription
  // on unmount (e.g. when switching models remounts this component).
  useEffect(() => {
    const saved = loadConversationId(model);
    if (saved) {
      chat.loadConversation(saved).catch(() => clearConversationId(model));
    }
    return () => chat.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    await chat.sendMessage(text);
    // Persist the (possibly just-created) conversation id so a reload resumes it.
    const id = chat.getConversationId();
    if (id) saveConversationId(model, id);
  };

  // Start a fresh conversation: open a new one, then delete the old thread server-side
  // so abandoned chats don't accumulate. Best-effort delete — a failure won't block.
  const newChat = async () => {
    if (loading) return;
    const previous = chat.getConversationId();
    setMessages([]);
    const { conversationId } = await api.createConversation(model);
    await chat.loadConversation(conversationId);
    saveConversationId(model, conversationId);
    if (previous && previous !== conversationId) {
      await api.deleteConversation(previous, model).catch(() => undefined);
    }
  };

  return (
    <div className="panel flex flex-col mx-auto w-full max-w-[760px] h-[70vh] p-4">
      <div className="flex justify-end pb-2 mb-1 border-b border-[var(--border)]">
        <button
          onClick={newChat}
          disabled={loading || messages.length === 0}
          className="btn-ghost px-3 py-1.5 text-[0.8em] whitespace-nowrap"
          title="Clear this chat and start a new one"
        >
          {copy.newChatLabel}
        </button>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto flex flex-col gap-3 px-1 py-2">
        {messages.length === 0 && (
          <p className="text-sm text-[var(--text-muted)]">{copy.emptyState}</p>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} message={m} />
        ))}
        {loading && <p className="thinking text-sm italic text-[var(--text-muted)]">{thinkingMessage}</p>}
      </div>

      <div className="flex gap-2 pt-3 mt-2 border-t border-[var(--border)]">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder={copy.inputPlaceholder}
          disabled={loading}
          className="field flex-1 px-3 py-2.5 text-[0.95em]"
        />
        <button onClick={send} disabled={loading || !input.trim()} className="btn-accent px-4 py-2.5 font-medium whitespace-nowrap">
          {copy.sendLabel}
        </button>
      </div>
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div
      className={[
        isUser ? 'bubble-user self-end' : 'bubble-bot self-start',
        'max-w-[85%] px-3.5 py-2.5 rounded-xl whitespace-pre-wrap leading-relaxed',
      ].join(' ')}
    >
      {message.content}
    </div>
  );
}

function errorBubble(text: string): ChatMessage {
  return { id: `err-${Date.now()}`, role: 'assistant', content: `⚠️ ${text}` };
}

/** Sign in, or sign up with an invite code. No public open signup. */
function AuthGate({ onAuthed, copy }: { onAuthed: (user: User) => void; copy: ThemeCopy }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const res =
        mode === 'signin'
          ? await api.signIn(username.trim(), password)
          : await api.signUp(invite.trim(), username.trim(), password);
      onAuthed({ username: res.username });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel max-w-[380px] mx-auto flex flex-col gap-2.5 p-6">
      <div className="flex gap-2 mb-1">
        <button onClick={() => setMode('signin')} className={`btn-ghost px-3 py-1.5 ${mode === 'signin' ? 'font-bold' : ''}`}>Sign in</button>
        <button onClick={() => setMode('signup')} className={`btn-ghost px-3 py-1.5 ${mode === 'signup' ? 'font-bold' : ''}`}>Sign up</button>
      </div>
      <input className="field px-3 py-2.5 text-[0.95em] w-full box-border" placeholder="Email" value={username} onChange={(e) => setUsername(e.target.value)} />
      <input className="field px-3 py-2.5 text-[0.95em] w-full box-border" type="password" placeholder="Password (8+ chars)" value={password} onChange={(e) => setPassword(e.target.value)} />
      {mode === 'signup' && (
        <input className="field px-3 py-2.5 text-[0.95em] w-full box-border" placeholder="Invite code" value={invite} onChange={(e) => setInvite(e.target.value)} />
      )}
      <button onClick={submit} disabled={busy} className="btn-accent px-4 py-2.5 font-medium">
        {busy ? '…' : mode === 'signin' ? 'Sign in' : 'Create account'}
      </button>
      {error && <p className="text-[0.85em] text-red-500 m-0">{error}</p>}
      {mode === 'signup' && <p className="text-[0.8em] text-[var(--text-muted)] m-0">{copy.authTagline}</p>}
    </div>
  );
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<string>('');
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const copy = COPY[theme];

  // Persist theme whenever it changes so a teammate's pick survives a refresh.
  useEffect(() => {
    saveTheme(theme);
  }, [theme]);

  // Resolve the current session on load.
  useEffect(() => {
    api
      .me()
      .then((u) => setUser(u ? { username: u.username } : null))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  // Load the selectable models once the user is signed in (listModels requires auth).
  useEffect(() => {
    if (!user) {
      setModels([]);
      return;
    }
    api
      .listModels()
      .then((res) => {
        setModels(res.models);
        setModel((cur) => cur || res.defaultModel);
      })
      .catch(() => setModels([]));
  }, [user]);

  const signOut = async () => {
    await api.signOut();
    setUser(null);
  };

  const toggleTheme = () => setTheme((t) => (t === 'fun' ? 'simple' : 'fun'));

  return (
    <div className="app-root" data-theme={theme}>
      <div className="p-4 sm:p-6 max-w-[900px] mx-auto">
        <div className="flex flex-wrap justify-between items-start gap-4 mb-5">
          <div className="min-w-0">
            <h1 className="neon-title text-xl sm:text-2xl font-bold mb-1">{copy.title}</h1>
            <p className="text-[0.9em] text-[var(--text-muted)] m-0 max-w-[560px]">{copy.subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2.5">
            <button
              onClick={toggleTheme}
              className="btn-ghost px-3 py-2 text-[1.15em] leading-none"
              aria-label={theme === 'fun' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={theme === 'fun' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'fun' ? '⛩️' : '🌤️'}
            </button>
            {user && models.length > 0 && model && (
              <label className="flex flex-col text-[0.7em] text-[var(--text-muted)] gap-1">
                {copy.modelLabel}
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="field px-2 py-1.5 text-[0.9em]"
                  title={copy.modelHint}
                >
                  {models.map((m) => (
                    <option key={m.key} value={m.key}>{m.label}</option>
                  ))}
                </select>
              </label>
            )}
            {user && (
              <button onClick={signOut} className="btn-ghost px-3 py-2 whitespace-nowrap text-[0.85em]">
                Sign out ({user.username})
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <p className="text-[var(--text-muted)]">Loading…</p>
        ) : user ? (
          // Key by model: changing the selection remounts ChatApp with a fresh conversation
          // on the newly chosen agent. Wait for a resolved model so the first mount is correct.
          model ? <ChatApp key={model} model={model} copy={copy} theme={theme} /> : <p className="text-[var(--text-muted)]">Loading…</p>
        ) : (
          <AuthGate onAuthed={setUser} copy={copy} />
        )}
      </div>
    </div>
  );
}
