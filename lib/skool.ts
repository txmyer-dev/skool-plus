// Skool API client. Runs in the extension service worker, where fetches to
// *.skool.com carry the user's own cookies (host_permissions makes them same-site).
// Every call here rides the logged-in session — nothing is stored or proxied.

import { tiptapToMarkdown } from './tiptap';
import type { Bootstrap, ChatChannel, ChatMessage, Course, CourseUnit, Lesson, LessonResource, LessonVideo, SkoolGroup, SkoolLabel, SkoolMember, SkoolPost, SkoolUser } from './types';

const API = 'https://api2.skool.com';
const WEB = 'https://www.skool.com';

type Query = Record<string, string | number | boolean | undefined>;

function qs(query?: Query): string {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export class SkoolError extends Error {
  constructor(message: string, public status: number, public body?: string) {
    super(message);
  }
}

async function api<T = any>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API}${path}${qs(opts.query)}`, {
    method,
    credentials: 'include',
    headers: { 'content-type': 'application/json', referer: `${WEB}/`, origin: WEB },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) throw new SkoolError('Not logged in to Skool. Open skool.com and sign in, then retry.', 401, text);
    throw new SkoolError(`Skool API ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`, res.status, text);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

// ---------- bootstrap: who am I, which groups ----------

function parseNextData(html: string): any {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new SkoolError('Could not find Skool page data. Are you logged in?', 0);
  return JSON.parse(m[1]!);
}

function normGroup(g: any): SkoolGroup | undefined {
  const raw = g?.group ?? g;
  if (!raw?.id) return undefined;
  const md = raw.metadata ?? {};
  return {
    id: raw.id,
    name: raw.name,
    displayName: md.displayName || md.display_name || raw.displayName || raw.name,
    role: g?.member?.role ?? raw?.member?.role ?? md.role,
  };
}

export async function fetchBootstrap(): Promise<Bootstrap> {
  const res = await fetch(`${WEB}/`, { credentials: 'include', redirect: 'follow' });
  const html = await res.text();
  const nd = parseNextData(html);
  const pp = nd?.props?.pageProps ?? {};
  const self = pp.self;
  if (!self?.id) throw new SkoolError('Not logged in to Skool. Open skool.com and sign in, then retry.', 401);

  let groups: SkoolGroup[] = [];
  try {
    const r = await api<any>('GET', '/self/groups', { query: { limit: 100, offset: 0 } });
    const list: any[] = r?.groups ?? r?.data ?? (Array.isArray(r) ? r : []);
    groups = list.map(normGroup).filter(Boolean) as SkoolGroup[];
  } catch {
    // fall through to page data
  }
  if (!groups.length && Array.isArray(self.allGroups)) {
    groups = self.allGroups.map(normGroup).filter(Boolean) as SkoolGroup[];
  }
  const user: SkoolUser = { id: self.id, name: self.name, firstName: self.firstName, lastName: self.lastName };
  return { self: user, groups, buildId: nd.buildId, fetchedAt: new Date().toISOString() };
}

// The labels endpoint is admin-only; members get categories from the group page data
// (pageProps.currentGroup.labels, with postWriteRole telling who may post there).
export async function fetchLabels(buildId: string, groupSlug: string): Promise<SkoolLabel[]> {
  const res = await fetch(`${WEB}/_next/data/${buildId}/${groupSlug}.json${qs({ group: groupSlug })}`, {
    credentials: 'include',
    headers: { 'x-nextjs-data': '1' },
  });
  if (!res.ok) throw new SkoolError(`Group ${groupSlug} → ${res.status}`, res.status);
  const j = await res.json();
  const list: any[] = j?.pageProps?.currentGroup?.labels ?? [];
  return list
    .map((l) => ({ id: l.id, displayName: l.metadata?.displayName || l.displayName || l.name || l.id, postWriteRole: l.metadata?.postWriteRole }))
    .filter((l) => l.id);
}

// ---------- posts & comments ----------

export function normPost(node: any): SkoolPost | undefined {
  const p = node?.post ?? node;
  if (!p?.id) return undefined;
  const md = p.metadata ?? {};
  const u = node?.user ?? p.user;
  return {
    id: p.id,
    name: p.name,
    groupId: p.groupId ?? p.group_id,
    rootId: p.rootId ?? p.root_id,
    parentId: p.parentId ?? p.parent_id,
    userId: p.userId ?? p.user_id ?? u?.id,
    postType: p.postType ?? p.post_type,
    createdAt: p.createdAt ?? p.created_at,
    title: md.title,
    content: md.content,
    authorName: u ? [u.firstName ?? u.first_name, u.lastName ?? u.last_name].filter(Boolean).join(' ') || u.name : undefined,
    authorHandle: u?.name,
    comments: md.comments,
    upvotes: md.upvotes,
  };
}

// Flatten a post_tree (post + nested children) into a list, depth-first.
export function flattenTree(tree: any, out: SkoolPost[] = []): SkoolPost[] {
  if (!tree) return out;
  const p = normPost(tree);
  if (p) out.push(p);
  for (const c of tree.children ?? []) flattenTree(c, out);
  return out;
}

export async function fetchFeed(buildId: string, groupSlug: string, page = 1, sort = 'newest-cm'): Promise<{ posts: SkoolPost[]; total: number; self?: any }> {
  const res = await fetch(`${WEB}/_next/data/${buildId}/${groupSlug}.json${qs({ group: groupSlug, p: page, s: sort })}`, {
    credentials: 'include',
    headers: { 'x-nextjs-data': '1' },
  });
  if (!res.ok) throw new SkoolError(`Feed ${groupSlug} p${page} → ${res.status}`, res.status);
  const j = await res.json();
  const pp = j?.pageProps ?? {};
  const trees: any[] = pp.postTrees ?? pp.renderData?.postTrees ?? [];
  return { posts: trees.map(normPost).filter(Boolean) as SkoolPost[], total: pp.total ?? 0, self: pp.self };
}

export async function fetchComments(postId: string, groupId: string, limit = 50): Promise<SkoolPost[]> {
  const r = await api<any>('GET', `/posts/${postId}/comments`, { query: { 'group-id': groupId, limit } });
  const tree = r?.post_tree ?? r;
  const out: SkoolPost[] = [];
  for (const c of tree?.children ?? []) flattenTree(c, out);
  return out;
}

export async function createPost(input: { groupId: string; rootId?: string; parentId?: string; title?: string; content: string; labelId?: string; postType?: 'generic' | 'comment' }) {
  const isComment = !!input.rootId;
  return api<any>('POST', '/posts', {
    body: {
      post_type: input.postType ?? (isComment ? 'comment' : 'generic'),
      group_id: input.groupId,
      root_id: input.rootId,
      parent_id: input.parentId,
      metadata: {
        title: input.title,
        content: input.content,
        labels: input.labelId,
        action: 0,
      },
    },
  });
}

// ---------- chat ----------

export async function fetchChannels(selfId: string, limit = 50): Promise<ChatChannel[]> {
  const r = await api<any>('GET', '/self/chat-channels', { query: { offset: 0, limit } });
  const list: any[] = r?.channels ?? [];
  return list.map((c) => {
    const u = c.user;
    return {
      id: c.id,
      groupId: c.group_id,
      userIds: c.user_ids ?? [],
      otherName: u ? [u.firstName ?? u.first_name, u.lastName ?? u.last_name].filter(Boolean).join(' ') || u.name : undefined,
      otherHandle: u?.name,
      lastMessageAt: c.last_message_at,
      numUnread: c.metadata?.num_unread,
    };
  });
}

export async function fetchMessages(channelId: string): Promise<ChatMessage[]> {
  const r = await api<any>('GET', `/channels/${channelId}/messages`);
  const list: any[] = r?.messages ?? [];
  return list
    .map((m) => ({ id: m.id, channelId: m.channel_id ?? channelId, src: m.metadata?.src, dst: m.metadata?.dst, content: m.metadata?.content ?? '', createdAt: m.created_at }))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

export async function sendMessage(channelId: string, content: string) {
  return api<any>('POST', `/channels/${channelId}/messages`, { query: { ct: 'web' }, body: { content } });
}

// ---------- members ----------
// Verified 2026-09-15: the members tab is SSR'd via the same Next.js data route as
// classroom/feed (30/page). lastOffline is Skool-wide presence, not group-specific —
// spData.pts (leaderboard points) is the reliable signal for actual engagement in
// this group, since Skool only awards points for posts/comments/reactions here.

function normMember(u: any): SkoolMember | undefined {
  if (!u?.id) return undefined;
  const m = u.member ?? {};
  let spData: any = {};
  try { spData = JSON.parse(u.metadata?.spData ?? '{}'); } catch { /* ignore */ }
  return {
    id: u.id,
    name: u.name,
    firstName: u.firstName,
    lastName: u.lastName,
    role: m.role ?? 'member',
    bio: u.metadata?.bio,
    timeZone: u.timeZone,
    joinedAt: m.createdAt,
    lastOffline: m.lastOffline,
    points: spData.pts ?? 0,
    level: spData.lv ?? 0,
  };
}

export async function fetchMembers(buildId: string, groupSlug: string, page = 1): Promise<{ members: SkoolMember[]; total: number; totalPages: number }> {
  const pp = await nextData(buildId, `${groupSlug}/-/members`, { group: groupSlug, p: page });
  const list: any[] = pp.users ?? [];
  return { members: list.map(normMember).filter(Boolean) as SkoolMember[], total: pp.total ?? 0, totalPages: pp.totalPages ?? 1 };
}

// Fetches every page. 30/page, so a ~800-member group is ~27 requests — sequential
// with a small delay to stay polite to Skool's backend.
export async function fetchAllMembers(buildId: string, groupSlug: string): Promise<SkoolMember[]> {
  const first = await fetchMembers(buildId, groupSlug, 1);
  const all = [...first.members];
  for (let page = 2; page <= first.totalPages; page++) {
    await new Promise((r) => setTimeout(r, 150));
    const { members } = await fetchMembers(buildId, groupSlug, page);
    all.push(...members);
  }
  return all;
}

// ---------- classroom ----------
// Verified 2026-09-09: course list and trees come from the Next.js data routes on the
// member's own session (no admin role). The lesson body (metadata.desc) only ships for
// the module selected via ?md=<full 32-hex module id>, so it is one request per lesson.

async function nextData(buildId: string, path: string, query: Query): Promise<any> {
  const res = await fetch(`${WEB}/_next/data/${buildId}/${path}.json${qs(query)}`, { credentials: 'include', headers: { 'x-nextjs-data': '1' } });
  if (res.status === 404) throw new SkoolError('Skool page data not found (Skool may have redeployed — refresh communities in Settings and retry).', 404);
  if (!res.ok) throw new SkoolError(`Skool ${path} → ${res.status}`, res.status);
  return (await res.json())?.pageProps ?? {};
}

function normCourse(raw: any): Course | undefined {
  if (!raw?.id) return undefined;
  const md = raw.metadata ?? {};
  return { id: raw.id, slug: raw.name, title: md.title ?? raw.name, desc: md.desc, numModules: md.numModules ?? 0, hasAccess: !!md.hasAccess, coverImage: md.coverImage };
}

export async function fetchCourses(buildId: string, groupSlug: string): Promise<Course[]> {
  const pp = await nextData(buildId, `${groupSlug}/classroom`, { group: groupSlug });
  const list: any[] = pp.allCourses ?? [];
  return list.map(normCourse).filter(Boolean) as Course[];
}

function parseResources(s: unknown): LessonResource[] {
  if (!s) return [];
  try {
    const list = typeof s === 'string' ? JSON.parse(s) : s;
    if (!Array.isArray(list)) return [];
    return list.filter((r) => r?.file_id).map((r) => ({ title: r.title || r.file_name, fileId: r.file_id, fileName: r.file_name, contentType: r.file_content_type }));
  } catch {
    return [];
  }
}

function normUnit(node: any): CourseUnit | undefined {
  const raw = node?.course ?? node;
  if (!raw?.id) return undefined;
  const md = raw.metadata ?? {};
  return {
    id: raw.id,
    slug: raw.name,
    type: raw.unitType ?? 'module',
    title: md.title ?? raw.name,
    hasAccess: !!md.hasAccess,
    hasVideo: !!md.videoLink,
    resourceCount: parseResources(md.resources).length,
    children: (node?.children ?? []).map(normUnit).filter(Boolean) as CourseUnit[],
  };
}

export function flattenUnits(u: CourseUnit | undefined, out: CourseUnit[] = []): CourseUnit[] {
  if (!u) return out;
  out.push(u);
  for (const c of u.children) flattenUnits(c, out);
  return out;
}

// Raw course page for a given module. Without md Skool answers with a redirect to
// the first module; we follow it once so callers can pass no md for "the default".
async function coursePage(buildId: string, groupSlug: string, courseSlug: string, moduleId?: string): Promise<{ pp: any; moduleId: string }> {
  let pp = await nextData(buildId, `${groupSlug}/classroom/${courseSlug}`, { group: groupSlug, course: courseSlug, md: moduleId });
  if (pp.__N_REDIRECT) {
    const md = new URL(pp.__N_REDIRECT, WEB).searchParams.get('md') ?? undefined;
    if (!md) throw new SkoolError('Course has no modules.', 0);
    pp = await nextData(buildId, `${groupSlug}/classroom/${courseSlug}`, { group: groupSlug, course: courseSlug, md });
    return { pp, moduleId: md };
  }
  return { pp, moduleId: moduleId ?? pp.selectedModule };
}

export async function fetchCourseTree(buildId: string, groupSlug: string, courseSlug: string): Promise<CourseUnit> {
  const { pp } = await coursePage(buildId, groupSlug, courseSlug);
  const tree = normUnit(pp.course);
  if (!tree) throw new SkoolError('Course not found or not accessible.', 404);
  return tree;
}

function pinnedVideos(post: any): LessonVideo[] {
  const md = post?.metadata ?? {};
  try {
    const list = typeof md.videoLinksData === 'string' ? JSON.parse(md.videoLinksData) : md.videoLinksData;
    if (Array.isArray(list)) return list.filter((v) => v?.url).map((v) => ({ url: v.url, title: v.title, lenMs: v.len_ms, thumbnail: v.thumbnail, from: 'pinned-post' as const }));
  } catch {
    /* fall through */
  }
  return md.videoLinks ? [{ url: String(md.videoLinks).split(',')[0]!, from: 'pinned-post' }] : [];
}

export function lessonUrl(groupSlug: string, courseSlug: string, moduleId: string) {
  return `${WEB}/${groupSlug}/classroom/${courseSlug}?md=${moduleId}`;
}

export async function fetchLesson(buildId: string, groupSlug: string, courseSlug: string, moduleId: string): Promise<Lesson> {
  const { pp, moduleId: md } = await coursePage(buildId, groupSlug, courseSlug, moduleId);
  const raw = findRaw(pp.course, md);
  if (!raw) throw new SkoolError('Lesson not found in this course.', 404);
  const m = raw.metadata ?? {};
  const videos: LessonVideo[] = [];
  if (m.videoLink) videos.push({ url: m.videoLink, title: m.title, lenMs: m.videoLenMs, thumbnail: m.videoThumbnail, from: 'lesson' });
  const pinnedRaw: any[] = pp.pinnedPosts ?? [];
  for (const p of pinnedRaw) videos.push(...pinnedVideos(p.post ?? p));
  return {
    id: raw.id,
    slug: raw.name,
    title: m.title ?? raw.name,
    hasAccess: !!m.hasAccess,
    markdown: tiptapToMarkdown(m.desc),
    videos,
    resources: parseResources(m.resources),
    pinnedPosts: pinnedRaw.map(normPost).filter(Boolean) as SkoolPost[],
    url: lessonUrl(groupSlug, courseSlug, raw.id),
  };
}

function findRaw(node: any, id: string): any {
  if (!node) return undefined;
  const raw = node.course ?? node;
  if (raw?.id === id) return raw;
  for (const c of node.children ?? []) {
    const hit = findRaw(c, id);
    if (hit) return hit;
  }
  return undefined;
}

// Attachments: POST (GET is 405) returns a plain-text short-lived signed CloudFront URL.
export async function fetchFileUrl(fileId: string, expireSeconds = 300): Promise<string> {
  const url = await api<string>('POST', `/files/${fileId}/download-url`, { query: { expire: expireSeconds } });
  const s = String(url).trim().replace(/^"|"$/g, '');
  if (!/^https?:\/\//.test(s)) throw new SkoolError('Skool did not return a download link for this file.', 0, s);
  return s;
}

export function postUrl(groupSlug: string, postSlug?: string) {
  return postSlug ? `${WEB}/${groupSlug}/${postSlug}` : `${WEB}/${groupSlug}`;
}
