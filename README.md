# skool+

Unofficial Chrome extension for Skool (not affiliated with Skool): draft replies in your own voice inside Skool's comment and chat boxes, and post to any of your communities from anywhere on the web (including straight out of a chatbot conversation).

Everything runs on your own logged-in Skool session and your own Claude subscription (via Claude Code on this laptop). Nothing is auto-sent: a draft goes into Skool's composer and you click Skool's button.

## Install (personal, unpacked)

```bash
pnpm install
pnpm build          # → .output/chrome-mv3
```

1. Start the bridge (it runs Claude Code headless with your subscription login): `pnpm bridge`. To have it start at logon instead, run once: `pwsh -File bridge\install-startup.ps1`.
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick `.output/chrome-mv3`.
3. Click the skool+ toolbar icon (pin it) → **Settings**. "Claude access" defaults to the bridge; **Test** should say online. (An Anthropic API key is the alternative.)
4. Press **Build my voice**. It reads your own posts, comments and chat replies across your communities (a couple of minutes) and asks Claude for a style guide.
5. Reload any open Skool tabs.

After code changes: `pnpm build`, then the ↻ button on the extension card in `chrome://extensions`, then reload Skool tabs.

## Use

**On Skool** — focus any comment box or the 1:1 chat box. A **✨ Draft** pill appears above it (or press `Ctrl+Shift+D`). Optional guidance → **Draft** → read it → **Insert**. Then send with Skool's own button. **Redraft** asks for something different.

**Anywhere on the web** — select text and press `Ctrl+Shift+K`, or right-click → *Send selection to skool+*. The side panel opens on **Post** with the selection captured. Pick the community and category, **Rewrite in my voice**, edit, **Post to Skool**.

**Think tab** — talk an idea through with Claude (it knows your voice and the target community). **Use as post** drops any reply into the Post tab.

**Classroom tab** — pick a course in the selected community, open any lesson as markdown (text, video links, pinned post, attachments), **Copy markdown** / **Download .md**, or **Discuss in Think**. **Export course .md** pulls every lesson you have access to into one markdown file (one request per lesson, ~5 lessons/sec). Attachments open Skool's own short-lived download link in a new tab. Locked courses show their outline only.

## How it works

- `entrypoints/skool-hook.content.ts` — MAIN-world script; watches Skool's own API responses (post detail, comments, chat channels, messages) and page data, forwards them to the isolated script.
- `entrypoints/skool.content.ts` — keeps the page store, shows the Draft pill, builds the reply context, inserts into TipTap (comments) or the textarea (chat).
- `entrypoints/background.ts` — service worker: Skool API calls with your cookies (`lib/skool.ts`), Claude calls (`lib/claude.ts`), voice ingestion (`lib/voice.ts`), context menu + shortcut capture.
- `entrypoints/sidepanel/` — React side panel: Post / Think / Settings.
- `lib/tiptap.ts` — TipTap/ProseMirror JSON (`[v2]…`, how Skool stores lesson bodies) → markdown. `lib/classroom.ts` — whole-course export with progress.
- `bridge/server.mjs` — localhost-only HTTP server (`127.0.0.1:47391`) that runs `claude -p --tools "" --system-prompt-file …` per request, so the extension uses the laptop's subscription instead of an API key.

Skool facts this relies on (verified 2026-09-08): Next.js pages router; REST at `api2.skool.com` authenticated by cookie; posts, comments and replies are one `POST /posts` object; chat is `GET/POST /channels/{id}/messages`; the labels endpoint is admin-only, so categories are read from the group page data. Classroom (2026-09-09): course list and trees from `/_next/data/{buildId}/{group}/classroom[/{course}].json`, lesson body only for the module in `?md=<full id>`, attachments via `POST /files/{id}/download-url`.

## Ground rules

Skool's policy bans bots that post, comment, or message. skool+ never sends anything on its own: every send is your click. Keep it that way.

## License

MIT. See `LICENSE`.
