// MAIN-world hook: runs inside Skool's own JS context so it can see the app's
// API responses. It has no chrome.* access; it forwards JSON to the isolated
// content script via CustomEvents. Nothing here modifies requests.

export default defineContentScript({
  matches: ['https://www.skool.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const w = window as any;
    if (w.__skoolPlusHooked) return;
    w.__skoolPlusHooked = true;

    const emit = (detail: unknown) => window.dispatchEvent(new CustomEvent('skoolplus:api', { detail }));

    const interesting = (url: string) => /api2\.skool\.com\/(groups\/[^/]+\/post-detail|posts\/[^/]+\/comments|self\/chat-channels|channels\/[^/]+\/messages)/.test(url) || /\/_next\/data\//.test(url);

    const origFetch = window.fetch;
    window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
      const res = await origFetch.apply(this, [input, init] as any);
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (interesting(url) && res.ok) {
          res
            .clone()
            .json()
            .then((json) => emit({ url, json }))
            .catch(() => {});
        }
      } catch {
        /* ignore */
      }
      return res;
    };

    // Initial server-rendered page data.
    const pushNextData = () => {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return false;
      try {
        const nd = JSON.parse(el.textContent || '{}');
        emit({ url: 'nextdata:' + location.pathname, json: { pageProps: nd?.props?.pageProps } });
      } catch {
        /* ignore */
      }
      return true;
    };
    if (!pushNextData()) document.addEventListener('DOMContentLoaded', pushNextData, { once: true });
  },
});
