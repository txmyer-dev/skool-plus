// Classroom export: walk a course tree, fetch each lesson body (one request per
// lesson — Skool only ships the selected module's body), and assemble one markdown
// document. Progress goes to session storage so the side panel can poll it.

import { fetchCourseTree, fetchLesson, flattenUnits, lessonUrl } from './skool';
import { setExportProgress } from './storage';
import type { Bootstrap, CourseUnit, Lesson, SkoolGroup } from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DELAY_MS = 200;

function fmtLen(ms?: number) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

export function lessonToMarkdown(l: Lesson, level = 3): string {
  const out: string[] = [`${'#'.repeat(level)} ${l.title}`, '', `_Skool: ${l.url}_`, ''];
  for (const v of l.videos) out.push(`▶ ${v.title && v.title !== l.title ? `${v.title} — ` : ''}${v.url}${v.lenMs ? ` (${fmtLen(v.lenMs)})` : ''}${v.from === 'pinned-post' ? ' (pinned post)' : ''}`);
  if (l.videos.length) out.push('');
  if (l.markdown) out.push(l.markdown, '');
  for (const p of l.pinnedPosts) {
    if (p.content?.trim()) out.push(`> **Pinned post: ${p.title ?? ''}**`, ...p.content.trim().split('\n').map((x) => `> ${x}`), '');
  }
  if (l.resources.length) {
    out.push('**Attachments**', ...l.resources.map((r) => `- ${r.title}${r.title !== r.fileName ? ` (${r.fileName})` : ''} — file ${r.fileId}`), '');
  }
  if (!l.hasAccess) out.push('_(locked — no access to this lesson)_', '');
  return out.join('\n');
}

export async function exportCourse(boot: Bootstrap, group: SkoolGroup, courseSlug: string): Promise<{ title: string; markdown: string; lessons: number }> {
  const tree = await fetchCourseTree(boot.buildId, group.name, courseSlug);
  const units = flattenUnits(tree);
  const modules = units.filter((u) => u.type === 'module' && u.hasAccess);
  const total = modules.length;
  let done = 0;
  await setExportProgress({ phase: `Reading ${tree.title}`, done, total });

  const bodies = new Map<string, Lesson>();
  try {
    for (const m of modules) {
      await setExportProgress({ phase: `Reading ${tree.title}: ${m.title}`, done, total });
      try {
        bodies.set(m.id, await fetchLesson(boot.buildId, group.name, courseSlug, m.id));
      } catch (e) {
        console.warn('[skool+] classroom: lesson failed', m.title, e);
      }
      done++;
      await sleep(DELAY_MS);
    }
  } finally {
    await setExportProgress(undefined);
  }

  const lines: string[] = [`# ${tree.title}`, '', `_${group.displayName} · ${lessonUrl(group.name, courseSlug, '').replace(/\?md=$/, '')} · exported ${new Date().toISOString().slice(0, 10)}_`, ''];
  const walk = (u: CourseUnit, depth: number) => {
    if (u.type === 'set') lines.push(`${'#'.repeat(Math.min(6, depth + 1))} ${u.title}`, '');
    if (u.type === 'module') {
      const l = bodies.get(u.id);
      if (l) lines.push(lessonToMarkdown(l, Math.min(6, depth + 1)), '');
      else lines.push(`${'#'.repeat(Math.min(6, depth + 1))} ${u.title}`, '', u.hasAccess ? '_(could not fetch this lesson)_' : '_(locked — no access)_', '');
    }
    for (const c of u.children) walk(c, depth + 1);
  };
  for (const c of tree.children) walk(c, 1);
  return { title: tree.title, markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', lessons: bodies.size };
}
