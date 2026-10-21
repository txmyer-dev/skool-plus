// Voice ingestion: pull your own posts, comments and chat messages from Skool,
// pair each with what it was replying to, and ask Claude for a style guide.

import { buildVoiceGuide } from './claude';
import { fetchChannels, fetchComments, fetchFeed, fetchMessages } from './skool';
import { setVoice, setVoiceProgress } from './storage';
import type { Bootstrap, Settings, SkoolPost, VoiceProfile, VoiceSample } from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = (s: string) => (s ?? '').replace(/\[@([^\]]+)\]\(obj:\/\/user\/[a-f0-9]+\)/g, '@$1').trim();

const FEED_PAGES_PER_GROUP = 3;
const MAX_POSTS_TO_EXPAND_PER_GROUP = 25;
const MAX_SAMPLES_PER_GROUP = 40;
const MAX_CHANNELS = 40;
const MAX_CHAT_SAMPLES = 80;

export async function buildVoice(settings: Settings, boot: Bootstrap): Promise<VoiceProfile> {
  const selfId = boot.self.id;
  const samples: VoiceSample[] = [];
  const perGroup: Record<string, number> = {};
  const total = boot.groups.length + 1;
  let done = 0;

  for (const g of boot.groups) {
    await setVoiceProgress({ phase: `Reading ${g.displayName}`, done, total });
    const groupSamples: VoiceSample[] = [];
    try {
      const candidates: SkoolPost[] = [];
      for (let p = 1; p <= FEED_PAGES_PER_GROUP; p++) {
        const { posts } = await fetchFeed(boot.buildId, g.name, p);
        if (!posts.length) break;
        for (const post of posts) {
          if (post.userId === selfId && (post.content || post.title)) {
            groupSamples.push({ kind: 'post', group: g.displayName, context: `(a new post in ${g.displayName})`, text: clean([post.title, post.content].filter(Boolean).join('\n\n')) });
          }
          candidates.push(post);
        }
        await sleep(150);
      }
      // Expand posts most likely to contain my comments: ones I authored or that have comments.
      const toExpand = candidates.filter((p) => (p.comments ?? 0) > 0).slice(0, MAX_POSTS_TO_EXPAND_PER_GROUP);
      for (const post of toExpand) {
        if (groupSamples.length >= MAX_SAMPLES_PER_GROUP) break;
        try {
          const comments = await fetchComments(post.id, g.id);
          const byId = new Map(comments.map((c) => [c.id, c]));
          for (const c of comments) {
            if (c.userId !== selfId || !c.content) continue;
            const parent = c.parentId && c.parentId !== post.id ? byId.get(c.parentId) : undefined;
            const context = parent
              ? `${parent.authorName ?? 'Someone'} commented: ${clean(parent.content ?? '')}`
              : `${post.authorName ?? 'Someone'} posted "${post.title ?? ''}": ${clean(post.content ?? '').slice(0, 400)}`;
            groupSamples.push({ kind: 'comment', group: g.displayName, context, text: clean(c.content) });
          }
        } catch {
          /* skip post */
        }
        await sleep(150);
      }
    } catch (e) {
      console.warn('[skool+] voice: group failed', g.name, e);
    }
    perGroup[g.displayName] = groupSamples.length;
    samples.push(...groupSamples.slice(0, MAX_SAMPLES_PER_GROUP));
    done++;
  }

  await setVoiceProgress({ phase: 'Reading chats', done, total });
  try {
    const channels = (await fetchChannels(selfId, MAX_CHANNELS)).filter((c) => c.userIds.includes(selfId));
    let chatCount = 0;
    for (const ch of channels) {
      if (chatCount >= MAX_CHAT_SAMPLES) break;
      try {
        const msgs = await fetchMessages(ch.id);
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i]!;
          if (m.src !== selfId || !m.content) continue;
          // context = the run of the other person's messages immediately before mine
          const ctx: string[] = [];
          for (let j = i - 1; j >= 0 && msgs[j]!.src !== selfId && ctx.length < 3; j--) ctx.unshift(msgs[j]!.content);
          if (!ctx.length) continue; // opening messages are less useful for reply style
          samples.push({ kind: 'chat', context: `${ch.otherName ?? 'Them'}: ${ctx.join('\n')}`, text: clean(m.content) });
          chatCount++;
          if (chatCount >= MAX_CHAT_SAMPLES) break;
        }
      } catch {
        /* skip channel */
      }
      await sleep(150);
    }
    perGroup['(chats)'] = chatCount;
  } catch (e) {
    console.warn('[skool+] voice: chats failed', e);
  }

  if (!samples.length) {
    await setVoiceProgress(undefined);
    throw new Error('Found no messages written by you. Post or comment on Skool first, then rebuild.');
  }

  await setVoiceProgress({ phase: 'Asking Claude to write your style guide', done: total, total });
  const who = [boot.self.firstName, boot.self.lastName].filter(Boolean).join(' ') || boot.self.name;
  // Shuffle lightly so the guide sees a mix of kinds.
  const mixed = [...samples].sort(() => Math.random() - 0.5);
  const guide = await buildVoiceGuide(settings, who, mixed);
  const profile: VoiceProfile = { builtAt: new Date().toISOString(), selfId, samples, guide, perGroup };
  await setVoice(profile);
  await setVoiceProgress(undefined);
  return profile;
}
