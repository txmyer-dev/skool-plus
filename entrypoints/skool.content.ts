// Isolated-world content script on skool.com: keeps a small store of what the
// page has loaded (self, group, post, comments, chat), shows a floating "Draft"
// pill next to whichever composer is focused, and inserts Claude's draft into
// Skool's own editor. Sending is always the user's click on Skool's button.

import { rpc } from '@/lib/rpc';
import { flattenTree, normPost } from '@/lib/skool';
import type { ChatDraftContext, CommentDraftContext, DraftContext, SkoolPost } from '@/lib/types';

interface Store {
  selfId?: string;
  selfName?: string;
  groupSlug?: string;
  groupName?: string;
  groupId?: string;
  postsById: Map<string, SkoolPost>;
  postsByName: Map<string, SkoolPost>;
  commentsByRoot: Map<string, SkoolPost[]>;
  channels: Map<string, { otherName?: string; userIds: string[] }>;
  lastChannelId?: string;
  messagesByChannel: Map<string, Array<{ src: string; content: string; createdAt: string }>>;
}

const store: Store = { postsById: new Map(), postsByName: new Map(), commentsByRoot: new Map(), channels: new Map(), messagesByChannel: new Map() };

const clean = (s: string) => (s ?? '').replace(/\[@([^\]]+)\]\(obj:\/\/user\/[a-f0-9]+\)/g, '@$1').replace(/\]\((https?:[^)]+)\)/g, ']').trim();

function absorbPost(p?: SkoolPost) {
  if (!p) return;
  store.postsById.set(p.id, p);
  if (p.name) store.postsByName.set(p.name, p);
}

function absorb(url: string, json: any) {
  try {
    if (url.startsWith('nextdata:') || url.includes('/_next/data/')) {
      const pp = json?.pageProps ?? {};
      if (pp.self?.id) {
        store.selfId = pp.self.id;
        store.selfName = [pp.self.firstName, pp.self.lastName].filter(Boolean).join(' ') || pp.self.name;
      }
      if (pp.currentGroup?.id) {
        store.groupId = pp.currentGroup.id;
        store.groupSlug = pp.currentGroup.name;
        store.groupName = pp.currentGroup.metadata?.displayName || pp.currentGroup.name;
      }
      for (const t of pp.postTrees ?? pp.renderData?.postTrees ?? []) absorbPost(normPost(t));
      if (pp.postTree) {
        const all = flattenTree(pp.postTree);
        const root = all[0];
        absorbPost(root);
        if (root) store.commentsByRoot.set(root.id, all.slice(1));
      }
      return;
    }
    if (url.includes('/post-detail')) {
      const all = flattenTree(json?.post_tree);
      const root = all[0];
      absorbPost(root);
      if (root) store.commentsByRoot.set(root.id, all.slice(1));
      return;
    }
    const cm = url.match(/\/posts\/([a-f0-9]+)\/comments/);
    if (cm) {
      const out: SkoolPost[] = [];
      for (const c of json?.post_tree?.children ?? []) flattenTree(c, out);
      const rootId = cm[1]!;
      const prev = store.commentsByRoot.get(rootId) ?? [];
      const seen = new Set(prev.map((p) => p.id));
      store.commentsByRoot.set(rootId, [...prev, ...out.filter((p) => !seen.has(p.id))]);
      return;
    }
    if (url.includes('/self/chat-channels')) {
      for (const c of json?.channels ?? []) {
        const u = c.user;
        store.channels.set(c.id, { otherName: u ? [u.firstName ?? u.first_name, u.lastName ?? u.last_name].filter(Boolean).join(' ') || u.name : undefined, userIds: c.user_ids ?? [] });
      }
      return;
    }
    const mm = url.match(/\/channels\/([a-f0-9]+)\/messages/);
    if (mm) {
      const msgs = (json?.messages ?? []).map((m: any) => ({ src: m.metadata?.src, content: m.metadata?.content ?? '', createdAt: m.created_at })).sort((a: any, b: any) => (a.createdAt < b.createdAt ? -1 : 1));
      store.messagesByChannel.set(mm[1]!, msgs);
      store.lastChannelId = mm[1]!;
    }
  } catch (e) {
    console.warn('[skool+] absorb failed', url, e);
  }
}

// ---------- context extraction ----------

function isForeign(el: Element): boolean {
  // Other extensions inject their own inputs into Skool (e.g. `la-*` classes); leave those alone.
  return /(^|\s)la-/.test(String(el.className)) || !!el.closest('[class^="la-"], [id^="la-"]');
}

function isEditor(el: Element | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement) || isForeign(el)) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  return el.isContentEditable && el.getAttribute('contenteditable') !== 'false';
}

function inChat(editor: HTMLElement): boolean {
  // Skool's comment/post composer is TipTap (contenteditable); the 1:1 chat composer is a plain textarea.
  if (editor instanceof HTMLTextAreaElement) return true;
  let el: HTMLElement | null = editor;
  for (let i = 0; i < 12 && el; i++, el = el.parentElement) {
    const t = el.textContent ?? '';
    if (el !== editor && /active \d+[smhd]? ago|active (just now|now)|@[a-z0-9-]+/i.test(t) && el.querySelectorAll('img').length > 3 && el.getBoundingClientRect().height > 300) return true;
  }
  return false;
}

function visibleTextAround(editor: HTMLElement, maxChars = 5000): string {
  let el: HTMLElement | null = editor.parentElement;
  let best = '';
  for (let i = 0; i < 10 && el; i++, el = el.parentElement) {
    const t = (el.innerText ?? '').trim();
    if (t.length > best.length) best = t;
    if (t.length > maxChars) break;
  }
  return best.slice(-maxChars);
}

function nearbyCommentText(editor: HTMLElement): string | undefined {
  // Walk up a few levels; the previous sibling of an ancestor usually holds the comment being replied to.
  let el: HTMLElement | null = editor;
  for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
    const prev = el.previousElementSibling as HTMLElement | null;
    const t = prev?.innerText?.trim();
    if (t && t.length > 20 && t.length < 3000) return t;
  }
  return undefined;
}

function buildContext(editor: HTMLElement): DraftContext {
  const selfId = store.selfId;
  if (inChat(editor)) {
    const chId = store.lastChannelId;
    const msgs = chId ? store.messagesByChannel.get(chId) ?? [] : [];
    const ch = chId ? store.channels.get(chId) : undefined;
    const ctx: ChatDraftContext = {
      kind: 'chat',
      groupName: store.groupName,
      otherName: ch?.otherName,
      messages: msgs.slice(-25).map((m) => ({ author: m.src === selfId ? 'ME' : ch?.otherName ?? 'Them', text: clean(m.content), isMe: m.src === selfId })),
      pageText: msgs.length ? undefined : visibleTextAround(editor, 4000),
    };
    return ctx;
  }
  const postName = location.pathname.split('/').filter(Boolean)[1];
  const post = postName ? store.postsByName.get(postName) : undefined;
  const comments = post ? store.commentsByRoot.get(post.id) ?? [] : [];
  const ctx: CommentDraftContext = {
    kind: 'comment',
    groupName: store.groupName,
    post: post ? { ...post, content: clean(post.content ?? '') } : undefined,
    thread: comments.slice(-20).map((c) => ({ author: c.authorName ?? 'Someone', text: clean(c.content ?? ''), isMe: c.userId === selfId })),
    nearbyText: nearbyCommentText(editor),
    pageText: post ? undefined : visibleTextAround(editor),
  };
  return ctx;
}

// ---------- insertion ----------

function insertText(editor: HTMLElement, text: string) {
  editor.focus();
  if (editor instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    const start = editor.selectionStart ?? editor.value.length;
    const next = editor.value.slice(0, start) + text + editor.value.slice(editor.selectionEnd ?? start);
    setter.call(editor, next);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const before = editor.textContent ?? '';
  // Put caret at end.
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  let ok = false;
  try {
    ok = document.execCommand('insertText', false, text);
  } catch {
    ok = false;
  }
  if (!ok || (editor.textContent ?? '') === before) {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }
  if ((editor.textContent ?? '') === before) {
    // Last resort: type it via beforeinput/input events.
    editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }));
    if ((editor.textContent ?? '') === before) {
      editor.textContent = before + text;
      editor.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
    }
  }
}

// ---------- UI ----------

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
.pill { position: fixed; z-index: 2147483000; display: flex; gap: 6px; align-items: center; background: #f5c542; color: #1a1a1a; border: 0; border-radius: 999px; padding: 6px 12px; font-size: 12px; font-weight: 600; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
.pill:hover { background: #ffd35a; }
.panel { position: fixed; z-index: 2147483001; width: 380px; max-width: calc(100vw - 24px); background: #1f1f23; color: #eee; border: 1px solid #3a3a42; border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,.5); padding: 12px; font-size: 13px; }
.panel h4 { margin: 0 0 8px; font-size: 12px; color: #f5c542; letter-spacing: .04em; text-transform: uppercase; }
.panel textarea { width: 100%; min-height: 54px; background: #121216; color: #eee; border: 1px solid #3a3a42; border-radius: 8px; padding: 8px; font-size: 13px; resize: vertical; }
.panel .draft { white-space: pre-wrap; background: #121216; border: 1px solid #3a3a42; border-radius: 8px; padding: 10px; margin: 8px 0; max-height: 260px; overflow: auto; line-height: 1.4; }
.row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; flex-wrap: wrap; }
button { border: 0; border-radius: 8px; padding: 7px 12px; font-size: 12px; font-weight: 600; cursor: pointer; background: #2c2c33; color: #eee; }
button.primary { background: #f5c542; color: #1a1a1a; }
button:disabled { opacity: .5; cursor: default; }
.muted { color: #9a9aa5; font-size: 11px; }
.err { color: #ff8a80; white-space: pre-wrap; }
`;

class DraftUI {
  host: HTMLElement;
  root: ShadowRoot;
  pill: HTMLButtonElement;
  panel?: HTMLDivElement;
  editor?: HTMLElement;
  draft = '';
  busy = false;

  constructor() {
    this.host = document.createElement('div');
    this.host.id = 'skoolplus-root';
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.root.appendChild(style);
    this.pill = document.createElement('button');
    this.pill.className = 'pill';
    this.pill.textContent = '✨ Draft';
    this.pill.title = 'skool+ — draft a reply in your voice (Ctrl+Shift+D)';
    this.pill.hidden = true;
    this.pill.addEventListener('mousedown', (e) => e.preventDefault()); // keep editor focus
    this.pill.addEventListener('click', () => this.open());
    this.root.appendChild(this.pill);
    document.documentElement.appendChild(this.host);
  }

  attach(editor: HTMLElement) {
    this.editor = editor;
    this.pill.hidden = false;
    this.place();
  }

  detach() {
    if (this.panel) return; // keep while panel open
    this.editor = undefined;
    this.pill.hidden = true;
  }

  place() {
    if (!this.editor) return;
    const r = this.editor.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return this.detach();
    this.pill.style.left = `${Math.max(8, r.right - 84)}px`;
    this.pill.style.top = `${Math.max(8, r.top - 30)}px`;
    if (this.panel) {
      const pw = 380;
      this.panel.style.left = `${Math.max(8, Math.min(window.innerWidth - pw - 8, r.right - pw))}px`;
      const below = r.bottom + 8;
      this.panel.style.top = `${below + 320 < window.innerHeight ? below : Math.max(8, r.top - 330)}px`;
    }
  }

  async open() {
    if (!this.editor) return;
    if (this.panel) return this.panel.remove(), (this.panel = undefined);
    const p = document.createElement('div');
    p.className = 'panel';
    p.innerHTML = `
      <h4>skool+ draft</h4>
      <textarea placeholder="Optional guidance (e.g. 'keep it to one line', 'push back gently', 'mention the Thursday call')"></textarea>
      <div class="draft muted">Click Draft to write a reply in your voice from the thread above.</div>
      <div class="err" hidden></div>
      <div class="row">
        <span class="muted" style="margin-right:auto"></span>
        <button data-act="close">Close</button>
        <button data-act="draft" class="primary">Draft</button>
        <button data-act="insert" disabled>Insert</button>
      </div>`;
    p.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).tagName !== 'TEXTAREA') e.preventDefault();
    });
    p.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).dataset.act;
      if (act === 'close') return this.close();
      if (act === 'draft') return this.generate();
      if (act === 'insert') return this.insert();
    });
    this.root.appendChild(p);
    this.panel = p;
    this.place();
    p.querySelector('textarea')!.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) this.generate();
    });
  }

  close() {
    this.panel?.remove();
    this.panel = undefined;
    this.draft = '';
  }

  async generate() {
    if (!this.panel || !this.editor || this.busy) return;
    const guidance = this.panel.querySelector('textarea')!.value.trim();
    const draftEl = this.panel.querySelector('.draft') as HTMLElement;
    const err = this.panel.querySelector('.err') as HTMLElement;
    const status = this.panel.querySelector('.row .muted') as HTMLElement;
    const btn = this.panel.querySelector('[data-act=draft]') as HTMLButtonElement;
    const ins = this.panel.querySelector('[data-act=insert]') as HTMLButtonElement;
    this.busy = true;
    btn.disabled = true;
    err.hidden = true;
    const ctx = buildContext(this.editor);
    status.textContent = ctx.kind === 'chat' ? `1:1 chat${ctx.otherName ? ` with ${ctx.otherName}` : ''} · ${ctx.messages.length} msgs` : `comment · ${ctx.post ? 'post loaded' : 'from page text'} · ${ctx.thread.length} comments`;
    draftEl.textContent = 'Writing…';
    draftEl.classList.add('muted');
    try {
      const text = await rpc<string>({ type: 'draft', context: ctx, guidance: guidance || undefined, previous: this.draft || undefined });
      this.draft = text;
      draftEl.textContent = text;
      draftEl.classList.remove('muted');
      ins.disabled = false;
      btn.textContent = 'Redraft';
    } catch (e: any) {
      err.hidden = false;
      err.textContent = e?.message ?? String(e);
      draftEl.textContent = '';
    } finally {
      this.busy = false;
      btn.disabled = false;
    }
  }

  insert() {
    if (!this.editor || !this.draft) return;
    insertText(this.editor, this.draft);
    this.close();
  }
}

export default defineContentScript({
  matches: ['https://www.skool.com/*'],
  runAt: 'document_idle',
  main() {
    window.addEventListener('skoolplus:api', (e) => {
      const d = (e as CustomEvent).detail;
      if (d?.url) absorb(d.url, d.json);
    });

    const ui = new DraftUI();

    document.addEventListener('focusin', (e) => {
      const t = e.target as Element;
      if (isEditor(t) && !ui.host.contains(t)) ui.attach(t);
    });
    document.addEventListener('focusout', (e) => {
      const t = e.target as Element;
      if (isEditor(t)) setTimeout(() => {
        const a = document.activeElement;
        if (!isEditor(a) || ui.host.contains(a)) ui.detach();
      }, 150);
    });
    const reposition = () => ui.place();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    setInterval(reposition, 500);

    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
        const a = document.activeElement as HTMLElement | null;
        if (isEditor(a)) {
          e.preventDefault();
          ui.attach(a);
          ui.open();
        }
      }
    });

    console.log('[skool+] ready');
  },
});
