import { bridgeHealth, chatTurn, draftReply, rewriteInVoice } from '@/lib/claude';
import { exportCourse } from '@/lib/classroom';
import { createPost, fetchBootstrap, fetchCourses, fetchCourseTree, fetchFileUrl, fetchLabels, fetchLesson, postUrl } from '@/lib/skool';
import { getBootstrapCache, getExportProgress, getSettings, getVoice, getVoiceProgress, setBootstrapCache, setPendingCapture, setSettings, takePendingCapture } from '@/lib/storage';
import type { Bootstrap, Req, Res } from '@/lib/types';
import { buildVoice } from '@/lib/voice';

const MENU_ID = 'skoolplus-send-selection';

async function bootstrap(force = false): Promise<Bootstrap> {
  const cached = await getBootstrapCache();
  const fresh = cached && Date.now() - Date.parse(cached.fetchedAt) < 6 * 3600_000;
  if (cached && fresh && !force) return cached;
  try {
    const b = await fetchBootstrap();
    await setBootstrapCache(b);
    return b;
  } catch (e) {
    if (cached) return cached;
    throw e;
  }
}

async function groupOf(groupId: string) {
  const b = await bootstrap();
  const g = b.groups.find((x) => x.id === groupId);
  if (!g) throw new Error('Unknown community');
  return { b, g };
}

function whoAmI(b: Bootstrap) {
  return [b.self.firstName, b.self.lastName].filter(Boolean).join(' ') || b.self.name;
}

async function captureFromTab(tab?: chrome.tabs.Tab) {
  if (!tab?.id) return;
  let text = '';
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.getSelection()?.toString() ?? '' });
    text = (r?.result as string) ?? '';
  } catch {
    /* restricted page */
  }
  await setPendingCapture({ text, url: tab.url ?? '', title: tab.title ?? '', at: new Date().toISOString() });
  if (tab.windowId !== undefined) await chrome.sidePanel.open({ windowId: tab.windowId });
}

async function handle(req: Req): Promise<any> {
  switch (req.type) {
    case 'settings.get':
      return getSettings();
    case 'settings.set':
      return setSettings(req.settings);
    case 'bootstrap':
      return bootstrap(req.force);
    case 'labels': {
      const b = await bootstrap();
      const g = b.groups.find((x) => x.id === req.groupId);
      if (!g) throw new Error('Unknown community');
      return fetchLabels(b.buildId, g.name);
    }
    case 'draft': {
      const [settings, voice, b] = await Promise.all([getSettings(), getVoice(), bootstrap()]);
      return draftReply(settings, voice, whoAmI(b), req.context, req.guidance, req.previous);
    }
    case 'rewrite': {
      const [settings, voice, b] = await Promise.all([getSettings(), getVoice(), bootstrap()]);
      const g = b.groups.find((x) => x.id === req.groupId);
      return rewriteInVoice(settings, voice, whoAmI(b), req.text, g?.displayName, req.guidance);
    }
    case 'chat': {
      const [settings, voice, b] = await Promise.all([getSettings(), getVoice(), bootstrap()]);
      const g = b.groups.find((x) => x.id === req.groupId);
      return chatTurn(settings, voice, whoAmI(b), g?.displayName, req.messages);
    }
    case 'post.create': {
      const b = await bootstrap();
      const g = b.groups.find((x) => x.id === req.groupId);
      if (!g) throw new Error('Unknown community');
      const r = await createPost({ groupId: req.groupId, labelId: req.labelId, title: req.title, content: req.content });
      const slug = r?.post?.name ?? r?.name;
      return { url: postUrl(g.name, slug), raw: r };
    }
    case 'voice.build': {
      const [settings, b] = await Promise.all([getSettings(), bootstrap(true)]);
      return buildVoice(settings, b);
    }
    case 'voice.status': {
      const [voice, progress] = await Promise.all([getVoice(), getVoiceProgress()]);
      return { voice: voice ? { builtAt: voice.builtAt, count: voice.samples.length, perGroup: voice.perGroup, guide: voice.guide } : undefined, progress };
    }
    case 'bridge.health':
      return bridgeHealth(await getSettings());
    case 'capture.take':
      return takePendingCapture();
    case 'capture.set':
      await setPendingCapture(req.capture);
      return true;
    case 'classroom.courses': {
      const { b, g } = await groupOf(req.groupId);
      return fetchCourses(b.buildId, g.name);
    }
    case 'classroom.tree': {
      const { b, g } = await groupOf(req.groupId);
      return fetchCourseTree(b.buildId, g.name, req.courseSlug);
    }
    case 'classroom.lesson': {
      const { b, g } = await groupOf(req.groupId);
      return fetchLesson(b.buildId, g.name, req.courseSlug, req.moduleId);
    }
    case 'classroom.export': {
      const { b, g } = await groupOf(req.groupId);
      return exportCourse(b, g, req.courseSlug);
    }
    case 'classroom.export.status':
      return getExportProgress();
    case 'classroom.fileUrl':
      return fetchFileUrl(req.fileId);
    default:
      throw new Error(`Unknown request ${(req as any).type}`);
  }
}

export default defineBackground(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: 'Send selection to skool+', contexts: ['selection'] });
  });

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== MENU_ID) return;
    await setPendingCapture({ text: info.selectionText ?? '', url: info.pageUrl ?? tab?.url ?? '', title: tab?.title ?? '', at: new Date().toISOString() });
    if (tab?.windowId !== undefined) await chrome.sidePanel.open({ windowId: tab.windowId });
  });

  chrome.commands.onCommand.addListener(async (cmd, tab) => {
    if (cmd === 'capture-to-skool') await captureFromTab(tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]);
  });

  chrome.runtime.onMessage.addListener((req: Req, _sender, sendResponse: (r: Res) => void) => {
    handle(req)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
    return true; // async
  });
});
