import { useEffect, useRef, useState } from 'react';
import { api } from 'aws-blocks';
import { useChat, type ChatMessage } from '@aws-blocks/bb-agent/client';

// Backend APIs are fully typed — hover over api.* for signatures.
// Full docs: node_modules/@aws-blocks/blocks/README.md

type User = { username: string };

function ChatApp() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // useChat is a factory, NOT a React hook — create it exactly once.
  // It owns the subscribe-before-send ordering and channel lifecycle.
  const chatRef = useRef<ReturnType<typeof useChat> | null>(null);
  if (!chatRef.current) {
    chatRef.current = useChat({
      api: {
        sendMessage: async (convId, msg, chId) => {
          await api.sendMessage(convId, msg, chId);
        },
        createConversation: () => api.createConversation(),
        getConversation: (id) => api.getConversation(id),
      },
      // Subscribe to the Realtime (WebSocket) channel the agent streams chunks on.
      subscribe: async (channelId, handler) => {
        const channel = await api.getChannel(channelId);
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

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    await chat.sendMessage(text);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '70vh', maxWidth: 760, margin: '0 auto' }}>
      <div
        ref={scrollRef}
        style={{ flex: 1, overflowY: 'auto', padding: '8px 4px', display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        {messages.length === 0 && (
          <p style={{ color: '#888', fontSize: '0.9em' }}>
            Ask about your AWS account — e.g. “list my S3 buckets” or “what EC2 instances are running in Tokyo?”
          </p>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} message={m} />
        ))}
        {loading && <p style={{ color: '#888', fontSize: '0.85em', fontStyle: 'italic' }}>Thinking…</p>}
      </div>

      <div style={{ display: 'flex', gap: 8, paddingTop: 12, borderTop: '1px solid #eee' }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Ask your AWS account…"
          disabled={loading}
          style={{ flex: 1, padding: 10, fontSize: '0.95em' }}
        />
        <button onClick={send} disabled={loading || !input.trim()} style={{ padding: '10px 18px' }}>
          Send
        </button>
      </div>
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div
      style={{
        alignSelf: isUser ? 'flex-end' : 'flex-start',
        maxWidth: '85%',
        padding: '10px 14px',
        borderRadius: 12,
        background: isUser ? '#2563eb' : '#f3f4f6',
        color: isUser ? '#fff' : '#111',
        whiteSpace: 'pre-wrap',
        lineHeight: 1.5,
      }}
    >
      {message.content}
    </div>
  );
}

function errorBubble(text: string): ChatMessage {
  return { id: `err-${Date.now()}`, role: 'assistant', content: `⚠️ ${text}` };
}

/** Sign in, or sign up with an invite code. No public open signup. */
function AuthGate({ onAuthed }: { onAuthed: (user: User) => void }) {
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

  const inputStyle = { padding: 10, fontSize: '0.95em', width: '100%', boxSizing: 'border-box' as const };

  return (
    <div style={{ maxWidth: 360, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
        <button onClick={() => setMode('signin')} style={{ fontWeight: mode === 'signin' ? 700 : 400 }}>Sign in</button>
        <button onClick={() => setMode('signup')} style={{ fontWeight: mode === 'signup' ? 700 : 400 }}>Sign up</button>
      </div>
      <input style={inputStyle} placeholder="Email" value={username} onChange={(e) => setUsername(e.target.value)} />
      <input style={inputStyle} type="password" placeholder="Password (8+ chars)" value={password} onChange={(e) => setPassword(e.target.value)} />
      {mode === 'signup' && (
        <input style={inputStyle} placeholder="Invite code" value={invite} onChange={(e) => setInvite(e.target.value)} />
      )}
      <button onClick={submit} disabled={busy} style={{ padding: '10px 18px' }}>
        {busy ? '…' : mode === 'signin' ? 'Sign in' : 'Create account'}
      </button>
      {error && <p style={{ color: '#b91c1c', fontSize: '0.85em', margin: 0 }}>{error}</p>}
      {mode === 'signup' && (
        <p style={{ color: '#888', fontSize: '0.8em', margin: 0 }}>Sign-up requires an invite code.</p>
      )}
    </div>
  );
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Resolve the current session on load.
  useEffect(() => {
    api
      .me()
      .then((u) => setUser(u ? { username: u.username } : null))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const signOut = async () => {
    await api.signOut();
    setUser(null);
  };

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>Ask my AWS account</h1>
          <p style={{ color: '#666', fontSize: '0.9em', margin: 0 }}>
            Read-only assistant for ap-northeast-1 (Tokyo). It can inspect resources, costs, and config — it cannot change anything.
          </p>
        </div>
        {user && (
          <button onClick={signOut} style={{ padding: '8px 14px', whiteSpace: 'nowrap' }}>
            Sign out ({user.username})
          </button>
        )}
      </div>
      {loading ? <p style={{ color: '#888' }}>Loading…</p> : user ? <ChatApp /> : <AuthGate onAuthed={setUser} />}
    </div>
  );
}
