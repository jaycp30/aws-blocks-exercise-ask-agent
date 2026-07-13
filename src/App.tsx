import { useEffect, useRef, useState } from 'react';
import { api } from 'aws-blocks';
import { useChat, type ChatMessage } from '@aws-blocks/bb-agent/client';
import { QRCodeSVG } from 'qrcode.react';
import { applyPersona, COPY, loadTheme, saveTheme, stripPersona, type Theme, type ThemeCopy } from './theme';
import { clearConversationId, loadConversationId, saveConversationId } from './session';
import ElectricBorder from './components/ElectricBorder';
import ScrollFloatItem from './components/ScrollFloatItem';
import DecryptedText from './components/DecryptedText';
import LightRays from './components/LightRays';

// Per-theme intensity for the ReactBits effects: fun mode goes full neon, simple mode
// stays restrained so the same effects still read as professional.
const EFFECTS: Record<Theme, { border: { color: string; speed: number; chaos: number }; float: 'full' | 'subtle' }> = {
  fun: { border: { color: '#9b5fe0', speed: 1, chaos: 0.14 }, float: 'full' },
  simple: { border: { color: '#6366f1', speed: 0.35, chaos: 0.02 }, float: 'subtle' },
};

// Backend APIs are fully typed — hover over api.* for signatures.
// Full docs: node_modules/@aws-blocks/blocks/README.md

type User = { username: string };
type ModelOption = { key: string; label: string };
type SignInResult = Awaited<ReturnType<typeof api.signIn>>;
type AuthChallenge = Extract<SignInResult, { status: 'continueSignIn' }>['nextStep'];
type PasswordResetStage = 'request' | 'confirm';

const TOTP_ISSUER = 'Handover Base Camp';

/** Standard URI understood by Google Authenticator, 1Password, Authy, and similar apps. */
function totpSetupUri(username: string, sharedSecret: string): string {
  const account = username.trim().toLowerCase();
  const label = `${encodeURIComponent(TOTP_ISSUER)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: sharedSecret,
    issuer: TOTP_ISSUER,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

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
function ChatApp({
  model,
  models,
  onModelChange,
  copy,
  theme,
}: {
  model: string;
  models: ModelOption[];
  onModelChange: (model: string) => void;
  copy: ThemeCopy;
  theme: Theme;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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

  // Auto-grow the composer as the user types across lines, up to a cap; past the cap
  // it scrolls internally. Runs on every input change, including the reset to '' after
  // send, so the box snaps back to one line once a message is sent.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

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

  const fx = EFFECTS[theme];

  return (
    <ElectricBorder
      color={fx.border.color}
      speed={fx.border.speed}
      chaos={fx.border.chaos}
      borderRadius={16}
      className="mx-auto w-full max-w-[min(93.5%,1540px)]"
    >
      <div className="panel flex h-[clamp(484px,71.5dvh,792px)] w-full flex-col p-4 sm:h-[clamp(550px,71.5dvh,836px)]">
        <div className="flex items-center justify-end gap-2.5 pb-2 mb-1 border-b border-[var(--border)]">
          {models.length > 0 && (
            <label className="flex items-center gap-1.5 text-[0.7em] text-[var(--text-muted)]">
              {copy.modelLabel}
              <select
                value={model}
                onChange={(e) => onModelChange(e.target.value)}
                className="field px-2 py-1.5 text-[0.9em]"
                title={copy.modelHint}
              >
                {models.map((m) => (
                  <option key={m.key} value={m.key}>{m.label}</option>
                ))}
              </select>
            </label>
          )}
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
            <ScrollFloatItem
              key={m.id}
              scrollContainerRef={scrollRef}
              intensity={fx.float}
              className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
            >
              <Bubble message={m} />
            </ScrollFloatItem>
          ))}
          {loading && (
            <p className="thinking text-sm italic text-[var(--text-muted)]">
              {/* Re-key on the rotating message so each new "thinking" line re-plays the decrypt. */}
              <DecryptedText
                key={thinkingMessage}
                text={thinkingMessage}
                animateOn="view"
                sequential
                speed={theme === 'fun' ? 38 : 26}
                maxIterations={12}
                useOriginalCharsOnly={theme === 'simple'}
                className="text-[var(--text-muted)]"
                encryptedClassName={
                  theme === 'fun'
                    ? 'text-[var(--accent)] opacity-80'
                    : 'text-[var(--text-muted)] opacity-50'
                }
              />
            </p>
          )}
        </div>

        <div className="flex items-end gap-2 pt-3 mt-2 border-t border-[var(--border)]">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter inserts a newline. Skip send while an IME
              // composition is active so confirming kana/kanji candidates with Enter
              // doesn't fire the message.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={copy.inputPlaceholder}
            disabled={loading}
            rows={1}
            className="field flex-1 px-3 py-2.5 text-[0.95em] resize-none max-h-40 overflow-y-auto"
          />
          <button onClick={send} disabled={loading || !input.trim()} className="btn-accent px-4 py-2.5 font-medium whitespace-nowrap">
            {copy.sendLabel}
          </button>
        </div>
      </div>
    </ElectricBorder>
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

/** Cognito sign-in with temporary-password and required-TOTP challenge handling. */
function AuthGate({ onAuthed, copy }: { onAuthed: (user: User) => void; copy: ThemeCopy }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<AuthChallenge | null>(null);
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [resetStage, setResetStage] = useState<PasswordResetStage | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const applyResult = (result: SignInResult) => {
    if (result.status === 'signedIn') {
      onAuthed({ username: result.user.username });
      return;
    }
    setChallenge(result.nextStep);
    setCode('');
    setNewPassword('');
  };

  const submitSignIn = async () => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      applyResult(await api.signIn(username.trim(), password));
      setPassword('');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Something went wrong';
      if (/password reset required/i.test(message)) {
        try {
          await api.beginPasswordReset(username.trim());
          setPassword('');
          setCode('');
          setNewPassword('');
          setResetStage('confirm');
          setNotice('We sent a 6-digit password-reset code to your verified email address.');
        } catch (resetError) {
          setError(resetError instanceof Error ? resetError.message : 'Could not start password reset');
        }
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  const requestPasswordReset = async () => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await api.beginPasswordReset(username.trim());
      setCode('');
      setNewPassword('');
      setResetStage('confirm');
      setNotice('We sent a 6-digit password-reset code to your verified email address.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start password reset');
    } finally {
      setBusy(false);
    }
  };

  const confirmPasswordReset = async () => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await api.confirmPasswordReset(username.trim(), code.trim(), newPassword);
      setResetStage(null);
      setCode('');
      setNewPassword('');
      setPassword('');
      setNotice('Password changed. Sign in with your new password.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reset password');
    } finally {
      setBusy(false);
    }
  };

  const submitChallenge = async () => {
    if (!challenge) return;
    if (!('session' in challenge)) {
      setError('This authentication step is not supported here. Start over and try again.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const result =
        challenge.name === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED'
          ? await api.completeNewPassword(challenge.session, newPassword)
          : await api.confirmSignInCode(challenge.session, code.trim());
      applyResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const startOver = () => {
    setChallenge(null);
    setResetStage(null);
    setCode('');
    setNewPassword('');
    setPassword('');
    setError('');
    setNotice('');
  };

  const isNewPassword = challenge?.name === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED';
  const isTotpSetup = challenge?.name === 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP';

  return (
    <div className="panel max-w-[380px] mx-auto flex flex-col gap-2.5 p-6">
      <h2 className="text-lg font-semibold m-0">
        {resetStage
          ? resetStage === 'request' ? 'Reset your password' : 'Enter your reset code'
          : challenge
            ? (isNewPassword ? 'Choose a new password' : isTotpSetup ? 'Secure your account' : 'Authenticator code')
            : 'Sign in'}
      </h2>

      {!challenge && !resetStage && (
        <>
          <input
            className="field px-3 py-2.5 text-[0.95em] w-full box-border"
            type="email"
            autoComplete="username"
            placeholder="Email"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            className="field px-3 py-2.5 text-[0.95em] w-full box-border"
            type="password"
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitSignIn()}
          />
          <button onClick={submitSignIn} disabled={busy || !username.trim() || !password} className="btn-accent px-4 py-2.5 font-medium">
            {busy ? '…' : 'Sign in'}
          </button>
          <button onClick={() => { setError(''); setNotice(''); setResetStage('request'); }} disabled={busy} className="btn-ghost px-3 py-1.5">
            Forgot password?
          </button>
        </>
      )}

      {resetStage === 'request' && (
        <>
          <p className="text-[0.85em] text-[var(--text-muted)] m-0">
            Enter your account email. Cognito will send a 6-digit verification code.
          </p>
          <input
            className="field px-3 py-2.5 text-[0.95em] w-full box-border"
            type="email"
            autoComplete="username"
            placeholder="Email"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && requestPasswordReset()}
          />
          <button onClick={requestPasswordReset} disabled={busy || !username.trim()} className="btn-accent px-4 py-2.5 font-medium">
            {busy ? '…' : 'Send reset code'}
          </button>
        </>
      )}

      {resetStage === 'confirm' && (
        <>
          <p className="text-[0.85em] text-[var(--text-muted)] m-0">
            Enter the code from your email and choose a password with at least 12 characters, uppercase, lowercase, a number and a symbol.
          </p>
          <input
            className="field px-3 py-2.5 text-[0.95em] w-full box-border"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            placeholder="6-digit verification code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          <input
            className="field px-3 py-2.5 text-[0.95em] w-full box-border"
            type="password"
            autoComplete="new-password"
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirmPasswordReset()}
          />
          <button onClick={confirmPasswordReset} disabled={busy || code.length !== 6 || newPassword.length < 12} className="btn-accent px-4 py-2.5 font-medium">
            {busy ? '…' : 'Set new password'}
          </button>
          <button onClick={requestPasswordReset} disabled={busy} className="btn-ghost px-3 py-1.5">
            Send a new code
          </button>
        </>
      )}

      {challenge && !resetStage && isNewPassword && (
        <>
          <p className="text-[0.85em] text-[var(--text-muted)] m-0">
            Your administrator issued a temporary password. Choose a unique password with at least 12 characters, uppercase, lowercase, a number and a symbol.
          </p>
          <input
            className="field px-3 py-2.5 text-[0.95em] w-full box-border"
            type="password"
            autoComplete="new-password"
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitChallenge()}
          />
          <button onClick={submitChallenge} disabled={busy || newPassword.length < 12} className="btn-accent px-4 py-2.5 font-medium">
            {busy ? '…' : 'Continue'}
          </button>
        </>
      )}

      {challenge && !resetStage && !isNewPassword && (
        <>
          {isTotpSetup && (
            <>
              <p className="text-[0.85em] text-[var(--text-muted)] m-0">
                Scan this QR code with your authenticator app, then enter its current 6-digit code.
              </p>
              <div className="self-center rounded-xl bg-white p-3" aria-label="Authenticator setup QR code">
                <QRCodeSVG
                  value={totpSetupUri(username, challenge.sharedSecret)}
                  size={196}
                  level="M"
                  marginSize={2}
                  title={`Set up ${TOTP_ISSUER} in an authenticator app`}
                />
              </div>
              <details className="text-[0.8em] text-[var(--text-muted)]">
                <summary className="cursor-pointer select-none">Can't scan? Use the setup key</summary>
                <code className="field block mt-2 px-3 py-2.5 text-sm break-all select-all">
                  {challenge.sharedSecret}
                </code>
              </details>
            </>
          )}
          {!isTotpSetup && (
            <p className="text-[0.85em] text-[var(--text-muted)] m-0">
              Enter the current 6-digit code from your authenticator app.
            </p>
          )}
          <input
            className="field px-3 py-2.5 text-[0.95em] w-full box-border"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(e) => e.key === 'Enter' && submitChallenge()}
          />
          <button onClick={submitChallenge} disabled={busy || code.length !== 6} className="btn-accent px-4 py-2.5 font-medium">
            {busy ? '…' : isTotpSetup ? 'Enable MFA and sign in' : 'Verify'}
          </button>
        </>
      )}

      {notice && <p className="text-[0.85em] text-emerald-600 m-0" role="status">{notice}</p>}
      {error && <p className="text-[0.85em] text-red-500 m-0" role="alert">{error}</p>}
      {(challenge || resetStage) && <button onClick={startOver} disabled={busy} className="btn-ghost px-3 py-1.5">Back to sign in</button>}
      <p className="text-[0.8em] text-[var(--text-muted)] m-0">{copy.authTagline}</p>
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
    <div className="app-root relative" data-theme={theme}>
      {/* Fun-only: WebGL light rays streaming down behind everything. Light Rays is an
          additive light-on-dark effect, so it only renders on the dark fun theme; the
          simple theme keeps its clean white background. Fixed + pointer-events-none so it
          never intercepts clicks or scrolls with the content. */}
      {theme === 'fun' && (
        <div className="fixed inset-0 z-0 pointer-events-none">
          <LightRays
            raysOrigin="top-center"
            raysColor="#9b5fe0"
            raysSpeed={0.9}
            lightSpread={0.85}
            rayLength={1.6}
            followMouse
            mouseInfluence={0.1}
            fadeDistance={1.1}
            className="opacity-70"
          />
        </div>
      )}
      <div className="relative z-[1] p-4 sm:p-6">
        {/* Header spans the full window so the title hugs the top-left corner and the
            controls hug the top-right — the chat/auth content below stays centered. */}
        <header className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="neon-title text-xl sm:text-2xl font-bold mb-1">{copy.title}</h1>
            <p className="text-[0.9em] text-[var(--text-muted)] m-0 max-w-[560px]">{copy.subtitle}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={toggleTheme}
              className="btn-ghost px-3 py-2 text-[1.15em] leading-none"
              aria-label={theme === 'fun' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={theme === 'fun' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'fun' ? '⛩️' : '🌤️'}
            </button>
            {user && (
              <button
                onClick={signOut}
                className="btn-ghost px-3 py-2 whitespace-nowrap text-[0.85em]"
                title="Sign out of this account"
              >
                Sign out
              </button>
            )}
          </div>
        </header>

        <div>
          {loading ? (
            <p className="text-[var(--text-muted)]">Loading…</p>
          ) : user ? (
            // Key by model: changing the selection remounts ChatApp with a fresh conversation
            // on the newly chosen agent. Wait for a resolved model so the first mount is correct.
            model ? (
              <ChatApp key={model} model={model} models={models} onModelChange={setModel} copy={copy} theme={theme} />
            ) : (
              <p className="text-[var(--text-muted)]">Loading…</p>
            )
          ) : (
            <AuthGate onAuthed={setUser} copy={copy} />
          )}
        </div>
      </div>
    </div>
  );
}
