# Yappa

A personal Twitch chat client (tabs, video, 7TV/BTTV/FFZ, mod tools, chat-color cycling) running
as a Cloudflare Worker behind Cloudflare Access at https://yappa.0x9.ca. Installable as a PWA.
The old address, https://yappa.0x9.ca, still routes to the Worker. Its page (`src/moved.ts`) forwards
to `APP_HOST`, carrying the browser's localStorage in the URL fragment; `app.js` imports it into a
fresh browser. API routes still answer there, so copies of the app that are already open keep working.
The Worker is still named `yappa` (the project started as a chat-color prank).

## Commands

- `npm run check`: type-check the Worker (`tsc --noEmit`). Client JS isn't type-checked; run `node --check src/client/app.js`.
- `npm run test:e2e`: end-to-end UI test in headless Chromium (see Testing). Run it before every deploy.
- `npm run deploy`: `wrangler deploy` to the custom domain. Deploying is how changes reach the user; there is no staging.
- `npm run types`: regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` bindings or vars.

## Architecture

- `src/index.ts`: Worker entry. Verifies the Cloudflare Access JWT (`src/access.ts`) on every request, serves static files, then routes `/api/*` and `/auth/*` to the user's Durable Object. POSTs require a same-origin `Origin` header (CSRF).
- `src/color-loop.ts`: Durable Object class `ColorLoop` (historical name), one per Access user, keyed by email. It owns the Twitch tokens (refresh, hourly validation), the color-cycling state, and every Helix call, exposed as RPC methods. **Don't rename the class, the `COLOR_LOOP` binding or the Worker**; that orphans the stored tokens and settings.
- `src/app-token.ts`: public Twitch lookups (live status, clips, badges, cheermotes) answered in the Worker with a shared app access token, so polling doesn't wake Durable Objects. Anything needing the user's identity or permissions belongs in the Durable Object.
- `src/twitch.ts`: OAuth and Helix helpers. `SCOPES` are required. `OPTIONAL_SCOPES` power the emote list and mod tools; adding one means the user must reconnect (the client shows a banner from `missingOptionalScopes`).
- `src/page.ts`: the HTML shell. `src/static.ts`: client assets, icons and the web manifest, served with content-hash `?v=` URLs. `APP_NAME` lives here.
- `src/client/{app.js,app.css,sw.js}`: plain browser JS/CSS with no build step and no TypeScript, imported into the Worker as text modules (`rules` in `wrangler.jsonc`; declarations in `src/client/modules.d.ts`). Keep client code here, not in TS template strings: escapes like `\s` silently break inside template literals.
- `scripts/draw-icon.mjs <outdir>`: draws the app icon (a rainbow chat bubble with a `#`) on a headless Chromium canvas and writes all icon sizes plus a 1024px preview to `<outdir>`. Copy the five icon PNGs into `src/client/icons/`; the preview isn't used.

The browser talks to these directly:
- **Twitch EventSub WebSocket:** one shared socket for all tabs. The Worker creates the subscriptions against the socket's session id.
- **Anonymous read-only Twitch IRC:** only for `first-msg` flags, which EventSub lacks.
- **recent-messages.robotty.de:** history and reconnect backfill, **only after the user opts in** (`settings.history`: `null` = not asked yet). The service's guidelines require consent, a short explanation and a link to it, both in the opt-in prompt and in Settings. Keep that if you touch it. History comes in pages of 100 (`HISTORY_PAGE`, within the service's recommended 50–100): the newest page on first load, older pages via `before=` as you scroll up (`loadOlder`), and reconnect gaps via `after=`. Lists are trimmed only while you're at the bottom.
- **7TV / BTTV / FFZ APIs.**
- **The Twitch embed player** (`player.twitch.tv/js/embed/v1.js`).
- **Native player (opt-in, Settings → Video player):** the browser asks Twitch's internal GraphQL API (`gql.twitch.tv`, using the Client-Id of Twitch's own website) for a playback token, then plays the `usher.ttvnw.net` HLS playlist in a `<video>`. Twitch's usher only sends CORS headers for twitch.tv origins, so hls.js (XHR) can never read the playlist from our origin; it stays only as a last resort (light build, served as `/hls.js`, `enableWorker: false` because the CSP forbids blob: workers). What works is a plain `<video src>` using the browser's built-in HLS: tested working in Firefox for Android, failing in Chrome for Android (source not supported). The Twitch embed has the opposite result (works in Chrome; in Firefox for Android its script fails to load, likely tracking protection or an ad blocker), so the setting is per browser and users pick whichever works. When the embed script can't load, `showEmbedBlocked` explains it in the video box with Try again / Use native player; it never retries on its own. Making it work in Chrome would mean proxying video through the Worker, which was deliberately not done (Twitch's terms, request volume, the IP-bound token). This is unofficial and can break at any time. Any failure falls back to the embed for the session (`nativeFail`). The token is tied to the requester's IP, so keep the token and playlist requests in the browser, never in the Worker.

Tokens never reach the browser.

## Gotchas (learned the hard way)

- **The Durable Object can keep running old code after a deploy.** The Worker calls `syncVersion()` on every page load and once per isolate per user otherwise, and the DO `ctx.abort()`s itself if the Worker is newer. The Worker also maps "does not implement the method" RPC errors to a `503 {retry: true}`, which the client retries. After deploys that change `color-loop.ts`, confirm the switch-over: query Workers Observability for `jsrpc`/`alarm` events and compare `$workers.scriptVersion.id` with the deployed version. `console.log` JSON lands in the event's `source` field.
- **Stay compatible with data written by older versions:** DO storage (e.g. the `scopes` backfill) and client `localStorage` (`settings` migrations in `loadSettings`). Use `structuredClone(DEFAULT_SETTINGS)` so the defaults' arrays aren't shared.
- **The page has a Content-Security-Policy** (`PAGE_HEADERS` in `src/page.ts`): scripts only from our origin and `player.twitch.tv`, no inline scripts or `on*=` attributes, and no framing. Loading a script from a new host means adding it there. Images, fetches and sockets aren't restricted.
- **Token refreshes are single-flight** (`ColorLoop.refresh`). Twitch can rotate the refresh token, so two concurrent refreshes could spend it twice and log the user out.
- **Message lists are kept in time order.** Every `<li>` has `data-ts` (set in `append`, or from the event). History merges in with `insertByTime`, so don't insert list items any other way.
- **The message box is `contenteditable`** (so finished emote names render as images). Emotes in it are text spans with the image as their background, never `<img>`: phone keyboards predict from the text before the caret. `render()` only rebuilds nodes that changed. Always go through the `composer` API (`getText`, `setText(text, caret)`, `caret`, `focus`, `setEnabled`); never `.value`.
- **Two themes.** Colors are CSS variables on `:root` (dark), overridden by `:root[data-theme="light"]`. Use a variable for any new color, unless it sits on the video (always dark) or is white text on the accent color. `src/client/theme.js` sets `data-theme` in `<head>` before first paint; `applyTheme` in app.js keeps it current. Chat names go through `paintName`, which darkens bright names on the light theme.
- **Layout runs on phones first.** The document never scrolls (only message lists do), and the app is sized to `visualViewport` via `--app-height`. Percent heights inside the footer resolve against the footer; use `--app-height`.
- **Twitch API limits:**
  - Hex chat colors need Turbo/Prime, and chat color is account-wide.
  - Bits and channel points can't be used through the API, and Twitch's chat embed doesn't offer them (per Twitch staff; old forum threads), so the gem button next to the emote button hands off to Twitch itself (`openOnTwitch`): pop-out chat window on desktop, `twitch://stream/<channel>` on touch devices with a twitch.tv fallback. `launchers` is the test seam. Settings → "Bits and channel points" can instead open Twitch's official chat embed in a window (`openChatEmbed`, experimental, confirmed to offer Bits and channel points; closing only minimizes, keeping up to 3 iframes loaded because reloading one repeats Twitch's sign-in and storage-access prompts, so never move or re-create those iframes casually; the pop-out page itself can't be framed: it sends `X-Frame-Options: SAMEORIGIN`, while the embed allows framing from the `parent=` host).
  - The embed iframe doesn't allow picture-in-picture by default; the client patches `allow` when creating the player.
  - **Never draw anything over the player or replace its controls.** Twitch's embed terms require Twitch-approved player elements only, never obscured by other page elements, and the player refuses to play when covered. (Custom touch controls were tried and had to be removed.)
  - Autoplay needs a visible player of at least 400×300, and never works on mobile: there the user must tap play.
  - `channel.raid` fires only once a raid completes.

## Testing

`tests/e2e.mjs` loads the real page and client JS in headless Chromium at phone size (390×760) and fakes everything external. That covers the `/api` routes (stateful mocks), the EventSub and IRC WebSockets, the recent-messages service, the 7TV/BTTV/FFZ CDNs, the Twitch embed script and Document Picture-in-Picture. It prints PASS/FAIL per check and exits non-zero on any failure, browser console error or 404. Screenshots go to `tests/output/` (git-ignored). Look at them for layout work: there's no other way to check layout.

- **Add checks with every feature,** including mocks in the `ctx.route` handler.
- **Browser setup:** set `CHROMIUM_PATH` if the headless shell isn't at the default `~/.cache/ms-playwright/chromium_headless_shell-1234/...` path. If it fails to start over missing shared libraries (libatk, libatk-bridge, libXdamage, libasound, libatspi), `apt-get download` those packages, extract them with `dpkg-deb -x`, and run with `LD_LIBRARY_PATH` pointing at the extracted `usr/lib/x86_64-linux-gnu`. No root needed.
- **Real Twitch is never exercised.** Say so when reporting, and note which behavior is still unverified.

## Rules

- **Never put the user's real name or Twitch login anywhere in the repo:** code, placeholders, examples, test data, comments or commit messages. Use neutral stand-ins (`testuser`, "your nickname"). Grep diffs for it (as a whole word) before committing.
- Config (`wrangler.jsonc` vars): `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` (the existing Access app's audience tag) and `TWITCH_CLIENT_ID`. Secret: `TWITCH_CLIENT_SECRET`. Var `APP_HOST` is the canonical hostname. The Twitch app's redirect URL is `https://yappa.0x9.ca/auth/callback`. The OAuth redirect is built from the request's origin, so every hostname in use must be registered with Twitch and covered by the Access app (same AUD).
- There is no git remote. Commits are local unless the user asks otherwise.
