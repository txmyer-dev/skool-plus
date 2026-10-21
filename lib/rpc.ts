import type { Req, Res } from './types';

// Typed request to the background worker from any extension context.
export async function rpc<T = any>(req: Req): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as Res<T> | undefined;
  if (!res) throw new Error('No response from skool+ background (was the extension reloaded? refresh the page).');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
