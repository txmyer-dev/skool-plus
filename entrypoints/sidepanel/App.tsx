import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from '@/lib/rpc';
import type { Bootstrap, PendingCapture, Settings, SkoolLabel } from '@/lib/types';
import Classroom from './Classroom';

type Tab = 'compose' | 'chat' | 'classroom' | 'settings';
type ChatMsg = { role: 'user' | 'assistant'; content: string };

function useBootstrap() {
  const [boot, setBoot] = useState<Bootstrap>();
  const [error, setError] = useState<string>();
  const load = useCallback(async (force = false) => {
    setError(undefined);
    try {
      setBoot(await rpc<Bootstrap>({ type: 'bootstrap', force }));
    } catch (e: any) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return { boot, error, reload: () => load(true) };
}

export default function App() {
  const [tab, setTab] = useState<Tab>('compose');
  const { boot, error, reload } = useBootstrap();
  const [settings, setSettings] = useState<Settings>();
  const [groupId, setGroupId] = useState<string>('');
  const [handoff, setHandoff] = useState<{ title?: string; body: string } | null>(null);
  const [thinkSeed, setThinkSeed] = useState<string | null>(null);

  useEffect(() => {
    rpc<Settings>({ type: 'settings.get' }).then((s) => {
      setSettings(s);
      if (s.provider === 'apikey' && !s.apiKey) setTab('settings');
    });
  }, []);
  useEffect(() => {
    if (boot && !groupId) {
      const saved = localStorage.getItem('skoolplus.group');
      setGroupId(boot.groups.find((g) => g.id === saved)?.id ?? boot.groups[0]?.id ?? '');
    }
  }, [boot, groupId]);
  useEffect(() => {
    if (groupId) localStorage.setItem('skoolplus.group', groupId);
  }, [groupId]);

  const who = boot ? [boot.self.firstName, boot.self.lastName].filter(Boolean).join(' ') || boot.self.name : '';

  return (
    <>
      <header>
        <span className="brand">skool+</span>
        <span className="who">{who ? `as ${who}` : error ? 'not connected' : 'connecting…'}</span>
      </header>
      <nav>
        {(['compose', 'chat', 'classroom', 'settings'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'compose' ? 'Post' : t === 'chat' ? 'Think' : t === 'classroom' ? 'Classroom' : 'Settings'}
          </button>
        ))}
      </nav>
      <main>
        {error && (
          <div className="card">
            <div className="err">{error}</div>
            <div className="row end" style={{ marginTop: 8 }}>
              <a href="https://www.skool.com/" target="_blank" rel="noreferrer">
                Open Skool
              </a>
              <button onClick={reload}>Retry</button>
            </div>
          </div>
        )}
        {boot && (
          <label>
            Community
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              {boot.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.displayName}
                </option>
              ))}
            </select>
          </label>
        )}
        {tab === 'compose' && <Compose boot={boot} groupId={groupId} handoff={handoff} clearHandoff={() => setHandoff(null)} />}
        {tab === 'chat' && (
          <Think
            groupId={groupId}
            seed={thinkSeed}
            clearSeed={() => setThinkSeed(null)}
            onUse={(text) => {
              setHandoff({ body: text });
              setTab('compose');
            }}
          />
        )}
        {tab === 'classroom' && (
          <Classroom
            groupId={groupId}
            onThink={(text) => {
              setThinkSeed(text);
              setTab('chat');
            }}
          />
        )}
        {tab === 'settings' && settings && <SettingsView settings={settings} setSettings={setSettings} boot={boot} reload={reload} />}
      </main>
    </>
  );
}

// ---------------- Post ----------------

function Compose({ boot, groupId, handoff, clearHandoff }: { boot?: Bootstrap; groupId: string; handoff: { title?: string; body: string } | null; clearHandoff: () => void }) {
  const [labels, setLabels] = useState<SkoolLabel[]>([]);
  const [labelId, setLabelId] = useState('');
  const [title, setTitle] = useState(() => localStorage.getItem('skoolplus.title') ?? '');
  const [body, setBody] = useState(() => localStorage.getItem('skoolplus.body') ?? '');
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState<'rewrite' | 'post' | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; url?: string }>();
  const [source, setSource] = useState<PendingCapture>();

  useEffect(() => {
    localStorage.setItem('skoolplus.title', title);
  }, [title]);
  useEffect(() => {
    localStorage.setItem('skoolplus.body', body);
  }, [body]);

  // Pull anything captured from the context menu / shortcut.
  const takeCapture = useCallback(async () => {
    const c = await rpc<PendingCapture | undefined>({ type: 'capture.take' });
    if (!c) return;
    setSource(c);
    if (c.text) setBody((b) => (b.trim() ? `${b.trim()}\n\n${c.text}` : c.text));
  }, []);
  useEffect(() => {
    takeCapture();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes.pendingCapture?.newValue) takeCapture();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [takeCapture]);

  useEffect(() => {
    if (handoff) {
      setBody(handoff.body);
      if (handoff.title) setTitle(handoff.title);
      clearHandoff();
    }
  }, [handoff, clearHandoff]);

  useEffect(() => {
    if (!groupId) return;
    setLabels([]);
    setLabelId('');
    rpc<SkoolLabel[]>({ type: 'labels', groupId }).then(setLabels).catch(() => setLabels([]));
  }, [groupId]);

  const rewrite = async () => {
    setBusy('rewrite');
    setMsg(undefined);
    try {
      const raw = source?.url && !body.includes(source.url) ? `${body}\n\n(Source: ${source.title} — ${source.url})` : body;
      const r = await rpc<{ title: string; body: string }>({ type: 'rewrite', text: raw, groupId, guidance: guidance || undefined });
      if (r.title && !title) setTitle(r.title);
      setBody(r.body);
    } catch (e: any) {
      setMsg({ kind: 'err', text: e.message });
    } finally {
      setBusy(null);
    }
  };

  const post = async () => {
    if (!title.trim() || !body.trim()) return setMsg({ kind: 'err', text: 'Title and body are both required.' });
    const g = boot?.groups.find((x) => x.id === groupId);
    if (!confirm(`Post "${title.trim()}" to ${g?.displayName ?? 'this community'} as you?`)) return;
    setBusy('post');
    setMsg(undefined);
    try {
      const r = await rpc<{ url: string }>({ type: 'post.create', groupId, labelId: labelId || undefined, title: title.trim(), content: body.trim() });
      setMsg({ kind: 'ok', text: 'Posted.', url: r.url });
      setTitle('');
      setBody('');
      setSource(undefined);
    } catch (e: any) {
      setMsg({ kind: 'err', text: e.message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {labels.length > 0 && (
        <label>
          Category
          <select value={labelId} onChange={(e) => setLabelId(e.target.value)}>
            <option value="">(none)</option>
            {labels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.displayName}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Post title" />
      </label>
      <label>
        Body
        <textarea className="tall" value={body} onChange={(e) => setBody(e.target.value)} placeholder={'Drop a thought here, or select text anywhere on the web and press Ctrl+Shift+K (or right-click → Send selection to skool+).'} />
      </label>
      {source && (
        <div className="muted">
          Captured from <a href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a>{' '}
          <button style={{ padding: '2px 6px', fontSize: 11 }} onClick={() => setSource(undefined)}>
            ×
          </button>
        </div>
      )}
      <label>
        Guidance for the rewrite (optional)
        <input value={guidance} onChange={(e) => setGuidance(e.target.value)} placeholder="e.g. make it a question to the group, keep it under 120 words" />
      </label>
      <div className="row end">
        <button onClick={rewrite} disabled={!!busy || !body.trim()}>
          {busy === 'rewrite' ? 'Rewriting…' : 'Rewrite in my voice'}
        </button>
        <button className="primary" onClick={post} disabled={!!busy || !groupId}>
          {busy === 'post' ? 'Posting…' : 'Post to Skool'}
        </button>
      </div>
      {msg && (
        <div className={msg.kind}>
          {msg.text}{' '}
          {msg.url && (
            <a href={msg.url} target="_blank" rel="noreferrer">
              Open post
            </a>
          )}
        </div>
      )}
    </>
  );
}

// ---------------- Think (chat with Claude) ----------------

function Think({ groupId, onUse, seed, clearSeed }: { groupId: string; onUse: (text: string) => void; seed: string | null; clearSeed: () => void }) {
  const [messages, setMessages] = useState<ChatMsg[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem('skoolplus.chat') ?? '[]');
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sessionStorage.setItem('skoolplus.chat', JSON.stringify(messages));
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);
  useEffect(() => {
    if (!seed || busy) return;
    clearSeed();
    send(`Here's a Skool classroom lesson I want to talk through. Summarise the key ideas in a few lines, then ask me what I want to do with it.\n\n${seed}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || busy) return;
    const next = [...messages, { role: 'user' as const, content: text }];
    setMessages(next);
    setInput('');
    setBusy(true);
    setErr(undefined);
    try {
      const reply = await rpc<string>({ type: 'chat', messages: next, groupId: groupId || undefined });
      setMessages([...next, { role: 'assistant', content: reply }]);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="muted">Talk the idea through. When a reply is post-worthy, hit “Use as post”.</div>
      <div className="chat">
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.content}
            {m.role === 'assistant' && (
              <div className="tools">
                <button onClick={() => onUse(m.content)}>Use as post</button>
                <button onClick={() => navigator.clipboard.writeText(m.content)}>Copy</button>
              </div>
            )}
          </div>
        ))}
        {busy && <div className="msg assistant muted">thinking…</div>}
        <div ref={endRef} />
      </div>
      {err && <div className="err">{err}</div>}
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder="What's the thought? (Enter to send, Shift+Enter for newline)"
        style={{ minHeight: 70 }}
      />
      <div className="row end">
        <button onClick={() => setMessages([])} disabled={!messages.length}>
          Clear
        </button>
        <button className="primary" onClick={() => send()} disabled={busy || !input.trim()}>
          Send
        </button>
      </div>
    </>
  );
}

// ---------------- Settings ----------------

function SettingsView({ settings, setSettings, boot, reload }: { settings: Settings; setSettings: (s: Settings) => void; boot?: Bootstrap; reload: () => void }) {
  const [local, setLocal] = useState(settings);
  const [saved, setSaved] = useState(false);
  const [voice, setVoice] = useState<{ voice?: { builtAt: string; count: number; perGroup: Record<string, number>; guide: string }; progress?: { phase: string; done: number; total: number } }>();
  const [building, setBuilding] = useState(false);
  const [err, setErr] = useState<string>();
  const [showGuide, setShowGuide] = useState(false);
  const [health, setHealth] = useState<{ ok: boolean; version?: string; error?: string }>();

  const testBridge = useCallback(async () => {
    const s = await rpc<Settings>({ type: 'settings.set', settings: { bridgeUrl: local.bridgeUrl, provider: local.provider } });
    setSettings(s);
    setHealth(await rpc({ type: 'bridge.health' }));
  }, [local.bridgeUrl, local.provider, setSettings]);
  useEffect(() => {
    if (settings.provider === 'bridge') rpc({ type: 'bridge.health' }).then(setHealth).catch(() => {});
  }, [settings.provider]);

  const refreshVoice = useCallback(() => rpc({ type: 'voice.status' }).then(setVoice).catch(() => {}), []);
  useEffect(() => {
    refreshVoice();
    const t = setInterval(refreshVoice, 1500);
    return () => clearInterval(t);
  }, [refreshVoice]);

  const save = async () => {
    const s = await rpc<Settings>({ type: 'settings.set', settings: local });
    setSettings(s);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const build = async () => {
    setBuilding(true);
    setErr(undefined);
    try {
      await rpc({ type: 'voice.build' });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBuilding(false);
      refreshVoice();
    }
  };

  return (
    <>
      <div className="card">
        <label>
          Claude access
          <select value={local.provider} onChange={(e) => setLocal({ ...local, provider: e.target.value as Settings['provider'] })}>
            <option value="bridge">Claude Code on this laptop (subscription)</option>
            <option value="apikey">Anthropic API key</option>
          </select>
        </label>
        {local.provider === 'bridge' ? (
          <>
            <label style={{ marginTop: 8 }}>
              Bridge URL
              <input value={local.bridgeUrl} onChange={(e) => setLocal({ ...local, bridgeUrl: e.target.value.trim() })} placeholder="http://127.0.0.1:47391" />
            </label>
            <div className="row" style={{ marginTop: 6 }}>
              <span className={health ? (health.ok ? 'ok' : 'err') : 'muted'}>{health ? (health.ok ? `bridge online (v${health.version})` : 'bridge offline — run "pnpm bridge" in the skool-plus folder') : 'checking bridge…'}</span>
              <button style={{ marginLeft: 'auto' }} onClick={testBridge}>
                Test
              </button>
            </div>
          </>
        ) : (
          <label style={{ marginTop: 8 }}>
            Anthropic API key
            <input type="password" value={local.apiKey} onChange={(e) => setLocal({ ...local, apiKey: e.target.value.trim() })} placeholder="sk-ant-…" />
          </label>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <label className="grow">
            Model
            <select value={local.model} onChange={(e) => setLocal({ ...local, model: e.target.value as Settings['model'] })}>
              <option value="claude-opus-5">Claude Opus 5</option>
              <option value="claude-sonnet-5">Claude Sonnet 5</option>
            </select>
          </label>
          <label className="grow">
            Effort
            <select value={local.effort} onChange={(e) => setLocal({ ...local, effort: e.target.value as Settings['effort'] })}>
              <option value="low">low (fast)</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>
        </div>
        <label style={{ marginTop: 8 }}>
          Standing instructions (optional)
          <textarea value={local.extraInstructions} onChange={(e) => setLocal({ ...local, extraInstructions: e.target.value })} placeholder="Things Claude should always know: what you're building, what you never say, who you are in these communities…" style={{ minHeight: 80 }} />
        </label>
        <div className="row end" style={{ marginTop: 8 }}>
          {saved && <span className="ok">Saved</span>}
          <button className="primary" onClick={save}>
            Save
          </button>
        </div>
        <div className="muted" style={{ marginTop: 6 }}>
          {local.provider === 'bridge' ? 'Requests go to a localhost bridge that runs Claude Code headless with your subscription login. Nothing leaves this machine except what Claude Code sends to Anthropic.' : "The key is stored only in this browser's extension storage and sent only to api.anthropic.com."}
        </div>
      </div>

      <div className="card">
        <b>Voice</b>
        <div className="muted" style={{ margin: '4px 0 8px' }}>
          Reads your own posts, comments and chat replies across your communities and has Claude write a style guide. Nothing leaves your browser except the samples sent to Claude.
        </div>
        {voice?.progress && (
          <div className="muted">
            {voice.progress.phase} ({voice.progress.done}/{voice.progress.total})
          </div>
        )}
        {voice?.voice ? (
          <div>
            <div className="ok">
              {voice.voice.count} samples · built {new Date(voice.voice.builtAt).toLocaleString()}
            </div>
            <div className="muted">
              {Object.entries(voice.voice.perGroup)
                .filter(([, n]) => n > 0)
                .map(([g, n]) => `${g}: ${n}`)
                .join(' · ')}
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <button onClick={() => setShowGuide((s) => !s)}>{showGuide ? 'Hide' : 'Show'} style guide</button>
            </div>
            {showGuide && <pre className="guide">{voice.voice.guide}</pre>}
          </div>
        ) : (
          <div className="muted">No voice profile yet.</div>
        )}
        {err && <div className="err">{err}</div>}
        <div className="row end" style={{ marginTop: 8 }}>
          <button className="primary" onClick={build} disabled={building || !!voice?.progress || (local.provider === 'apikey' && !local.apiKey)}>
            {building || voice?.progress ? 'Building…' : voice?.voice ? 'Rebuild voice' : 'Build my voice'}
          </button>
        </div>
      </div>

      <div className="card">
        <b>Skool connection</b>
        <div className="muted" style={{ marginTop: 4 }}>
          {boot ? `${boot.self.name} · ${boot.groups.length} communities · refreshed ${new Date(boot.fetchedAt).toLocaleTimeString()}` : 'Not connected'}
        </div>
        <div className="row end" style={{ marginTop: 8 }}>
          <button onClick={reload}>Refresh communities</button>
        </div>
      </div>

      <div className="muted">
        On Skool: focus any comment or chat box and click <b>✨ Draft</b> (or <span className="kbd">Ctrl+Shift+D</span>). Anywhere: select text and press <span className="kbd">Ctrl+Shift+K</span>.
      </div>
    </>
  );
}
