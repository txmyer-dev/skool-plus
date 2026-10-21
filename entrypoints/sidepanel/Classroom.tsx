import { useCallback, useEffect, useState } from 'react';
import { lessonToMarkdown } from '@/lib/classroom';
import { rpc } from '@/lib/rpc';
import type { Course, CourseUnit, ExportProgress, Lesson } from '@/lib/types';

function fmtLen(ms?: number) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'course';

export default function Classroom({ groupId, onThink }: { groupId: string; onThink: (text: string) => void }) {
  const [courses, setCourses] = useState<Course[]>();
  const [courseSlug, setCourseSlug] = useState<string>('');
  const [tree, setTree] = useState<CourseUnit>();
  const [lesson, setLesson] = useState<Lesson>();
  const [busy, setBusy] = useState<'courses' | 'tree' | 'lesson' | 'export' | null>(null);
  const [err, setErr] = useState<string>();
  const [progress, setProgress] = useState<ExportProgress>();
  const [note, setNote] = useState<string>();

  // Course list per community.
  useEffect(() => {
    if (!groupId) return;
    setCourses(undefined);
    setTree(undefined);
    setLesson(undefined);
    setErr(undefined);
    setCourseSlug(localStorage.getItem(`skoolplus.course.${groupId}`) ?? '');
    setBusy('courses');
    rpc<Course[]>({ type: 'classroom.courses', groupId })
      .then(setCourses)
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(null));
  }, [groupId]);

  // Course tree.
  useEffect(() => {
    if (!groupId || !courseSlug) return;
    localStorage.setItem(`skoolplus.course.${groupId}`, courseSlug);
    setTree(undefined);
    setLesson(undefined);
    setErr(undefined);
    setBusy('tree');
    rpc<CourseUnit>({ type: 'classroom.tree', groupId, courseSlug })
      .then(setTree)
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(null));
  }, [groupId, courseSlug]);

  const openLesson = useCallback(
    async (moduleId: string) => {
      setBusy('lesson');
      setErr(undefined);
      try {
        setLesson(await rpc<Lesson>({ type: 'classroom.lesson', groupId, courseSlug, moduleId }));
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setBusy(null);
      }
    },
    [groupId, courseSlug],
  );

  // Export progress polling while an export runs.
  useEffect(() => {
    if (busy !== 'export') return;
    const t = setInterval(() => rpc<ExportProgress | undefined>({ type: 'classroom.export.status' }).then(setProgress).catch(() => {}), 800);
    return () => {
      clearInterval(t);
      setProgress(undefined);
    };
  }, [busy]);

  const exportCourse = async () => {
    if (!tree) return;
    setBusy('export');
    setErr(undefined);
    setNote(undefined);
    try {
      const r = await rpc<{ title: string; markdown: string; lessons: number }>({ type: 'classroom.export', groupId, courseSlug });
      saveFile(`${slugify(r.title)}.md`, r.markdown);
      setNote(`Saved ${r.lessons} lessons as ${slugify(r.title)}.md`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const openFile = async (fileId: string) => {
    setErr(undefined);
    try {
      const url = await rpc<string>({ type: 'classroom.fileUrl', fileId });
      await chrome.tabs.create({ url });
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const course = courses?.find((c) => c.slug === courseSlug);
  const lessonMd = lesson ? lessonToMarkdown(lesson, 1) : '';

  return (
    <>
      <label>
        Course
        <select value={courseSlug} onChange={(e) => setCourseSlug(e.target.value)} disabled={!courses}>
          <option value="">{busy === 'courses' ? 'Loading courses…' : courses?.length ? '(pick a course)' : 'No classroom in this community'}</option>
          {courses?.map((c) => (
            <option key={c.id} value={c.slug}>
              {c.hasAccess ? '' : '🔒 '}
              {c.title} · {c.numModules}
            </option>
          ))}
        </select>
      </label>
      {course?.desc && !lesson && <div className="muted">{course.desc}</div>}
      {err && <div className="err">{err}</div>}

      {lesson ? (
        <div className="card lesson">
          <div className="row">
            <button onClick={() => setLesson(undefined)}>← {tree?.title ?? 'Course'}</button>
            <a style={{ marginLeft: 'auto' }} href={lesson.url} target="_blank" rel="noreferrer">
              Open on Skool
            </a>
          </div>
          <h3>{lesson.title}</h3>
          {!lesson.hasAccess && <div className="err">Locked — you don't have access to this lesson.</div>}
          {lesson.videos.map((v, i) => (
            <div key={i} className="row">
              <a href={v.url} target="_blank" rel="noreferrer">
                ▶ {v.title && v.title !== lesson.title ? v.title : 'Video'}
              </a>
              <span className="muted">
                {fmtLen(v.lenMs)}
                {v.from === 'pinned-post' ? ' · pinned post' : ''}
              </span>
            </div>
          ))}
          {lesson.markdown ? <pre className="guide">{lesson.markdown}</pre> : <div className="muted">No text in this lesson.</div>}
          {lesson.pinnedPosts
            .filter((p) => p.content?.trim())
            .map((p) => (
              <div key={p.id} className="card">
                <b>Pinned: {p.title}</b>
                <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{p.content}</div>
              </div>
            ))}
          {lesson.resources.length > 0 && (
            <div>
              <b>Attachments</b>
              {lesson.resources.map((r) => (
                <div key={r.fileId} className="row" style={{ marginTop: 4 }}>
                  <button onClick={() => openFile(r.fileId)}>📎 {r.title}</button>
                  {r.title !== r.fileName && <span className="muted">{r.fileName}</span>}
                </div>
              ))}
              <div className="muted" style={{ marginTop: 4 }}>
                Opens Skool's short-lived download link in a new tab.
              </div>
            </div>
          )}
          <div className="row end" style={{ marginTop: 8 }}>
            <button onClick={() => navigator.clipboard.writeText(lessonMd)}>Copy markdown</button>
            <button onClick={() => saveFile(`${slugify(lesson.title)}.md`, lessonMd)}>Download .md</button>
            <button className="primary" onClick={() => onThink(lessonMd)}>
              Discuss in Think
            </button>
          </div>
        </div>
      ) : (
        tree && (
          <div className="card">
            <div className="row">
              <b>{tree.title}</b>
              <span className="muted">{tree.children.length ? '' : 'empty'}</span>
              <button style={{ marginLeft: 'auto' }} className="primary" onClick={exportCourse} disabled={busy === 'export'}>
                {busy === 'export' ? 'Exporting…' : 'Export course .md'}
              </button>
            </div>
            {progress && (
              <div className="muted">
                {progress.phase} ({progress.done}/{progress.total})
              </div>
            )}
            {note && <div className="ok">{note}</div>}
            <div className="tree">
              {tree.children.map((u) => (
                <Unit key={u.id} unit={u} depth={0} onOpen={openLesson} disabled={busy === 'lesson' || busy === 'export'} />
              ))}
            </div>
          </div>
        )
      )}
      {busy === 'lesson' && <div className="muted">Loading lesson…</div>}
      {busy === 'tree' && <div className="muted">Loading course…</div>}
      {!courseSlug && courses?.length ? <div className="muted">Read any lesson as markdown, export a whole course, or hand a lesson to Think.</div> : null}
    </>
  );
}

function Unit({ unit, depth, onOpen, disabled }: { unit: CourseUnit; depth: number; onOpen: (id: string) => void; disabled: boolean }) {
  if (unit.type === 'module') {
    return (
      <button className="unit module" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => onOpen(unit.id)} disabled={disabled || !unit.hasAccess} title={unit.hasAccess ? 'Open lesson' : 'Locked'}>
        <span className="grow">{unit.title}</span>
        <span className="muted">
          {unit.hasVideo ? '▶ ' : ''}
          {unit.resourceCount ? `📎${unit.resourceCount} ` : ''}
          {unit.hasAccess ? '' : '🔒'}
        </span>
      </button>
    );
  }
  return (
    <>
      <div className="unit set" style={{ paddingLeft: 8 + depth * 12 }}>
        {unit.title}
      </div>
      {unit.children.map((c) => (
        <Unit key={c.id} unit={c} depth={depth + 1} onOpen={onOpen} disabled={disabled} />
      ))}
    </>
  );
}
