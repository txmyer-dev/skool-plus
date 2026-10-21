// Shared types for skool+.

export interface SkoolUser {
  id: string;
  name: string; // handle/slug
  firstName?: string;
  lastName?: string;
  metadata?: Record<string, any>;
}

export interface SkoolGroup {
  id: string;
  name: string; // slug
  displayName: string;
  role?: string;
}

export interface SkoolMember {
  id: string; // user id
  name: string; // handle/slug
  firstName?: string;
  lastName?: string;
  role: string; // 'member' | 'group-moderator' | 'group-admin'
  bio?: string;
  timeZone?: string;
  joinedAt?: string; // member.createdAt (approved into the group)
  lastOffline?: string; // last presence timestamp (Skool-wide, not group-specific)
  points: number; // spData.pts — the real engagement signal (posts/comments/reactions)
  level: number; // spData.lv
}

export interface SkoolLabel {
  id: string;
  displayName: string;
  postWriteRole?: string;
}

export interface SkoolPost {
  id: string;
  name?: string; // slug
  groupId?: string;
  rootId?: string;
  parentId?: string;
  userId?: string;
  postType?: string;
  createdAt?: string;
  title?: string;
  content?: string;
  authorName?: string;
  authorHandle?: string;
  comments?: number;
  upvotes?: number;
}

export interface ChatChannel {
  id: string;
  groupId?: string;
  userIds: string[];
  otherName?: string;
  otherHandle?: string;
  lastMessageAt?: string;
  numUnread?: number;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  src: string;
  dst?: string;
  content: string;
  createdAt: string;
}

// ---------- classroom ----------

export interface Course {
  id: string;
  slug: string; // short name used in URLs
  title: string;
  desc?: string;
  numModules: number;
  hasAccess: boolean;
  coverImage?: string;
}

export interface CourseUnit {
  id: string;
  slug: string;
  type: 'course' | 'set' | 'module';
  title: string;
  hasAccess: boolean;
  hasVideo: boolean;
  resourceCount: number;
  children: CourseUnit[];
}

export interface LessonVideo {
  url: string;
  title?: string;
  lenMs?: number;
  thumbnail?: string;
  from: 'lesson' | 'pinned-post';
}

export interface LessonResource {
  title: string;
  fileId: string;
  fileName: string;
  contentType?: string;
}

export interface Lesson {
  id: string;
  slug: string;
  title: string;
  hasAccess: boolean;
  markdown: string; // lesson body converted from TipTap
  videos: LessonVideo[];
  resources: LessonResource[];
  pinnedPosts: SkoolPost[];
  url: string; // skool.com URL of this lesson
}

export interface ExportProgress {
  phase: string;
  done: number;
  total: number;
}

export interface Settings {
  provider: 'bridge' | 'apikey'; // bridge = Claude Code on this laptop (subscription); apikey = direct API
  bridgeUrl: string;
  apiKey: string;
  model: 'claude-opus-5' | 'claude-sonnet-5';
  effort: 'low' | 'medium' | 'high';
  extraInstructions: string;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'bridge',
  bridgeUrl: 'http://127.0.0.1:47391',
  apiKey: '',
  model: 'claude-opus-5',
  effort: 'low',
  extraInstructions: '',
};

export interface VoiceSample {
  kind: 'post' | 'comment' | 'chat';
  group?: string; // group displayName
  context: string; // what was being replied to
  text: string; // the user's actual writing
}

export interface VoiceProfile {
  builtAt: string;
  selfId: string;
  samples: VoiceSample[];
  guide: string; // Claude-written style guide
  perGroup: Record<string, number>;
}

export interface Bootstrap {
  self: SkoolUser;
  groups: SkoolGroup[];
  buildId: string;
  fetchedAt: string;
}

// Context handed to the drafting engine from the Skool page.
export interface CommentDraftContext {
  kind: 'comment';
  groupName?: string;
  post?: SkoolPost;
  thread: Array<{ author: string; text: string; isMe: boolean }>;
  nearbyText?: string; // text around the editor (likely the comment being replied to)
  pageText?: string; // trimmed visible thread text as fallback
}

export interface ChatDraftContext {
  kind: 'chat';
  groupName?: string;
  otherName?: string;
  messages: Array<{ author: string; text: string; isMe: boolean }>;
  pageText?: string;
}

export type DraftContext = CommentDraftContext | ChatDraftContext;

export interface PendingCapture {
  text: string;
  url: string;
  title: string;
  at: string;
}

// Message contracts between contexts.
export type Req =
  | { type: 'settings.get' }
  | { type: 'settings.set'; settings: Partial<Settings> }
  | { type: 'bootstrap'; force?: boolean }
  | { type: 'labels'; groupId: string }
  | { type: 'draft'; context: DraftContext; guidance?: string; previous?: string }
  | { type: 'rewrite'; text: string; groupId?: string; guidance?: string }
  | { type: 'chat'; messages: Array<{ role: 'user' | 'assistant'; content: string }>; groupId?: string }
  | { type: 'post.create'; groupId: string; labelId?: string; title: string; content: string }
  | { type: 'voice.build' }
  | { type: 'bridge.health' }
  | { type: 'voice.status' }
  | { type: 'capture.take' }
  | { type: 'capture.set'; capture: PendingCapture }
  | { type: 'classroom.courses'; groupId: string }
  | { type: 'classroom.tree'; groupId: string; courseSlug: string }
  | { type: 'classroom.lesson'; groupId: string; courseSlug: string; moduleId: string }
  | { type: 'classroom.export'; groupId: string; courseSlug: string }
  | { type: 'classroom.export.status' }
  | { type: 'classroom.fileUrl'; fileId: string };

export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; error: string };
export type Res<T = any> = Ok<T> | Err;
