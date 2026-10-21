import { DEFAULT_SETTINGS, type Bootstrap, type ExportProgress, type PendingCapture, type Settings, type VoiceProfile } from './types';

const local = () => chrome.storage.local;
const session = () => chrome.storage.session;

export async function getSettings(): Promise<Settings> {
  const { settings } = await local().get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await local().set({ settings: next });
  return next;
}

export async function getBootstrapCache(): Promise<Bootstrap | undefined> {
  const { bootstrap } = await local().get('bootstrap');
  return bootstrap as Bootstrap | undefined;
}

export async function setBootstrapCache(b: Bootstrap) {
  await local().set({ bootstrap: b });
}

export async function getVoice(): Promise<VoiceProfile | undefined> {
  const { voice } = await local().get('voice');
  return voice as VoiceProfile | undefined;
}

export async function setVoice(v: VoiceProfile | undefined) {
  if (v) await local().set({ voice: v });
  else await local().remove('voice');
}

export async function setVoiceProgress(p: { phase: string; done: number; total: number; error?: string } | undefined) {
  if (p) await session().set({ voiceProgress: p });
  else await session().remove('voiceProgress');
}

export async function getVoiceProgress() {
  const { voiceProgress } = await session().get('voiceProgress');
  return voiceProgress as { phase: string; done: number; total: number; error?: string } | undefined;
}

export async function setPendingCapture(c: PendingCapture | undefined) {
  if (c) await session().set({ pendingCapture: c });
  else await session().remove('pendingCapture');
}

export async function takePendingCapture(): Promise<PendingCapture | undefined> {
  const { pendingCapture } = await session().get('pendingCapture');
  if (pendingCapture) await session().remove('pendingCapture');
  return pendingCapture as PendingCapture | undefined;
}

export async function setExportProgress(p: ExportProgress | undefined) {
  if (p) await session().set({ exportProgress: p });
  else await session().remove('exportProgress');
}

export async function getExportProgress(): Promise<ExportProgress | undefined> {
  const { exportProgress } = await session().get('exportProgress');
  return exportProgress as ExportProgress | undefined;
}
