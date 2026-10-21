// Claude calls. Only ever runs in extension-origin contexts (service worker),
// never in a content script: Skool's CSP blocks api.anthropic.com from the page,
// and the key must never sit next to page code.

import Anthropic from '@anthropic-ai/sdk';
import type { DraftContext, Settings, VoiceProfile, VoiceSample } from './types';

function client(settings: Settings) {
  if (!settings.apiKey) throw new Error('No Anthropic API key set. Open the skool+ side panel → Settings.');
  return new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
}

// Bridge = Claude Code running headless on this machine (uses the laptop's subscription login).
// The conversation is flattened to one prompt because `claude -p` takes a single turn.
function flatten(messages: Anthropic.MessageParam[]): string {
  const text = (c: Anthropic.MessageParam['content']) => (typeof c === 'string' ? c : c.map((b) => ('text' in b ? b.text : '')).join(''));
  if (messages.length === 1 && messages[0]?.role === 'user') return text(messages[0].content);
  const lines = messages.map((m) => `<${m.role === 'user' ? 'me' : 'you'}>\n${text(m.content)}\n</${m.role === 'user' ? 'me' : 'you'}>`);
  return `Conversation so far (you are "you"):\n\n${lines.join('\n\n')}\n\nWrite your next reply only.`;
}

async function viaBridge(settings: Settings, system: string, messages: Anthropic.MessageParam[], effort: Settings['effort']): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${settings.bridgeUrl.replace(/\/$/, '')}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system, prompt: flatten(messages), model: settings.model, effort }),
    });
  } catch {
    throw new Error(`skool+ bridge not reachable at ${settings.bridgeUrl}. Start it with "pnpm bridge" in the skool-plus folder (or run bridge/install-startup.ps1 once).`);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `bridge → ${res.status}`);
  return String(j.text ?? '').trim();
}

export async function bridgeHealth(settings: Settings): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const r = await fetch(`${settings.bridgeUrl.replace(/\/$/, '')}/health`);
    const j = await r.json();
    return { ok: !!j.ok, version: j.version };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

function voiceBlock(voice?: VoiceProfile, groupName?: string): string {
  if (!voice) {
    return `No voice profile yet. Write plainly, warmly, and briefly, like a real community member — not like an assistant.`;
  }
  // Prefer samples from the same community, then the rest; cap total.
  const same = voice.samples.filter((s) => s.group && groupName && s.group === groupName);
  const rest = voice.samples.filter((s) => !same.includes(s));
  const chosen = [...same.slice(0, 18), ...rest.slice(0, 22)];
  const ex = chosen
    .map((s: VoiceSample, i) => `<example n="${i + 1}" kind="${s.kind}"${s.group ? ` community="${s.group}"` : ''}>\n<they_wrote>${s.context.slice(0, 500)}</they_wrote>\n<i_wrote>${s.text.slice(0, 700)}</i_wrote>\n</example>`)
    .join('\n');
  return `## My voice\n${voice.guide}\n\n## Real examples of how I write on Skool\n${ex}`;
}

function baseSystem(settings: Settings, voice: VoiceProfile | undefined, groupName: string | undefined, who: string) {
  return [
    `You are skool+, a writing partner for ${who}, who is active on Skool communities. You draft text that ${who} will personally review and send under their own name. Everything you write must sound exactly like them — their rhythm, warmth, length, punctuation habits, emoji habits, and level of directness. Never sound like an AI assistant. Never add sign-offs, hashtags, or hedges they wouldn't use. No markdown headings; Skool renders plain text.`,
    settings.extraInstructions ? `## Standing instructions from ${who}\n${settings.extraInstructions}` : '',
    voiceBlock(voice, groupName),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function renderContext(ctx: DraftContext): string {
  if (ctx.kind === 'chat') {
    const lines = ctx.messages.map((m) => `${m.isMe ? 'ME' : m.author}: ${m.text}`).join('\n');
    return `<conversation kind="1:1 chat"${ctx.groupName ? ` community="${ctx.groupName}"` : ''}${ctx.otherName ? ` with="${ctx.otherName}"` : ''}>\n${lines || ctx.pageText || '(no messages captured)'}\n</conversation>`;
  }
  const post = ctx.post
    ? `<post author="${ctx.post.authorName ?? 'unknown'}">\n${[ctx.post.title, ctx.post.content].filter(Boolean).join('\n\n')}\n</post>`
    : '';
  const thread = ctx.thread.length ? `<comments>\n${ctx.thread.map((m) => `${m.isMe ? 'ME' : m.author}: ${m.text}`).join('\n---\n')}\n</comments>` : '';
  const nearby = ctx.nearbyText ? `<replying_to_probably>\n${ctx.nearbyText}\n</replying_to_probably>` : '';
  const page = !post && !thread && ctx.pageText ? `<visible_thread>\n${ctx.pageText}\n</visible_thread>` : '';
  return [`<context kind="community post comment"${ctx.groupName ? ` community="${ctx.groupName}"` : ''}>`, post, thread, nearby, page, '</context>'].filter(Boolean).join('\n');
}

async function run(settings: Settings, system: string, messages: Anthropic.MessageParam[], maxTokens = 1500): Promise<string> {
  if (settings.provider === 'bridge') return viaBridge(settings, system, messages, settings.effort);
  const c = client(settings);
  const res = await c.messages.create({
    model: settings.model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    thinking: { type: 'adaptive' },
    output_config: { effort: settings.effort },
    messages,
  });
  if (res.stop_reason === 'refusal') throw new Error('Claude declined this request.');
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

export async function draftReply(settings: Settings, voice: VoiceProfile | undefined, who: string, ctx: DraftContext, guidance?: string, previous?: string): Promise<string> {
  const system = baseSystem(settings, voice, ctx.groupName, who);
  const task =
    ctx.kind === 'chat'
      ? `Draft my next message in this 1:1 chat. Match the length and energy of how I usually chat (often one to three short lines). Reply to what they actually said.`
      : `Draft my reply comment. If <replying_to_probably> is present, that is the comment I'm answering; otherwise I'm commenting on the post itself. Keep it the length I'd naturally write.`;
  const user = [renderContext(ctx), task, guidance ? `Guidance from me for this one: ${guidance}` : '', previous ? `My previous draft, which I rejected — do something different:\n${previous}` : '', 'Output only the message text, nothing else.']
    .filter(Boolean)
    .join('\n\n');
  return run(settings, system, [{ role: 'user', content: user }]);
}

export async function rewriteInVoice(settings: Settings, voice: VoiceProfile | undefined, who: string, text: string, groupName?: string, guidance?: string): Promise<{ title: string; body: string }> {
  const system = baseSystem(settings, voice, groupName, who);
  const user = [
    `Turn the following raw thought into a Skool community post I would write${groupName ? ` in "${groupName}"` : ''}. Keep my ideas and specifics; drop anything that reads like an AI chatbot's phrasing. Plain text only.`,
    guidance ? `Guidance: ${guidance}` : '',
    `<raw>\n${text}\n</raw>`,
    `Respond in exactly this format:\nTITLE: <a short post title, under 80 characters>\nBODY:\n<the post body>`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const out = await run(settings, system, [{ role: 'user', content: user }], 2500);
  const m = out.match(/TITLE:\s*(.*)\n+BODY:\s*\n?([\s\S]*)$/);
  if (!m) return { title: '', body: out };
  return { title: (m[1] ?? '').trim(), body: (m[2] ?? '').trim() };
}

export async function chatTurn(settings: Settings, voice: VoiceProfile | undefined, who: string, groupName: string | undefined, messages: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<string> {
  const system =
    baseSystem(settings, voice, groupName, who) +
    `\n\n## Mode: thinking partner\nRight now ${who} is talking an idea through with you before posting it${groupName ? ` in "${groupName}"` : ''}. Be a sharp, brief collaborator: ask at most one question at a time, offer angles, and when asked for a draft, produce the full post text in their voice with no preamble. Address them as a peer.`;
  return run(settings, system, messages as Anthropic.MessageParam[], 3000);
}

export async function buildVoiceGuide(settings: Settings, who: string, samples: VoiceSample[]): Promise<string> {
  const ex = samples
    .slice(0, 120)
    .map((s, i) => `[${i + 1}|${s.kind}${s.group ? `|${s.group}` : ''}] ${s.text.slice(0, 600)}`)
    .join('\n\n');
  const analystSystem = `You are a writing-style analyst. You will read real messages written by ${who} on Skool and produce a compact style guide another writer could follow to sound exactly like them. Be concrete and specific: sentence length, openers, how they address people, punctuation and capitalization quirks, emoji use (which ones, how often), slang, typical closings, how they disagree, how they encourage, typical message length by context (post vs comment vs chat), and what they never do. Quote short phrases as evidence. Under 450 words. No preamble.`;
  if (settings.provider === 'bridge') return viaBridge(settings, analystSystem, [{ role: 'user', content: `Messages:\n\n${ex}` }], 'medium');
  const c = client(settings);
  const res = await c.messages.create({
    model: settings.model,
    max_tokens: 2500,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system: analystSystem,
    messages: [{ role: 'user', content: `Messages:\n\n${ex}` }],
  });
  if (res.stop_reason === 'refusal') throw new Error('Claude declined to analyze the samples.');
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}
