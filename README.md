<p align="center">
  <img src="src/client/icons/icon-512.png" width="128" alt="Yappa logo">
</p>

<h1 align="center">Yappa</h1>

<p align="center"><b>A personal Twitch chat client that runs on your own Cloudflare Worker.</b></p>

<p align="center">
  Tabs · 7TV / BTTV / FFZ emotes · mod tools · whispers · clips · native player · installable PWA
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#development">Development</a> ·
  <a href="#screenshots">Screenshots</a>
</p>

<p align="center">
  <img src="docs/screenshots/chat-mobile.png" width="200" alt="Chat tabs with history and a first-time chatter flag">
  <img src="docs/screenshots/mod-tools-mobile.png" width="200" alt="Moderator tools">
  <img src="docs/screenshots/emote-picker-by-channel-mobile.png" width="200" alt="Emote picker grouped by channel">
  <img src="docs/screenshots/mentions-mobile.png" width="200" alt="Mentions from every open channel">
</p>

## What it is

Yappa is a full-featured Twitch chat client for one person (or a few people you list), written as a single
Cloudflare Worker. You sign in with Twitch, open channels as tabs, and chat. It's built on Twitch's EventSub
WebSocket and Helix API, and it runs as a web app you can install on your phone or desktop.

- **Private.** Only the Twitch accounts on your allowlist can sign in. There is no public page and no shared
  server. Your Twitch tokens stay in the Worker and never reach the browser.
- **Yours.** You deploy it to your own Cloudflare account; there's no build step and no database to run.
- **Phone first.** The layout starts from a phone and scales up to desktop, with the video beside the chat on
  wide windows and on a phone turned sideways.

## Features

### Chat

- Channel tabs sharing one EventSub WebSocket, with live status, viewer counts and unread/mention badges.
- Emotes from Twitch, 7TV, BTTV and FFZ, plus cheermotes and GIFs from Tier 2+ subscribers (Settings → Show
  GIFs turns them into links). The composer shows finished emote names as images.
- Emote picker (grouped by where each emote comes from, including one section per channel you're subscribed
  to, with favorites and recents) and autocomplete for `:name`, Tab and `@user`.
- Tap an emote for its name and source; tap a name for their user card (badges with a plain-language
  explanation of each, follow age, recent messages, quick timeouts).
- Optional chat history (via [recent-messages.robotty.de](https://recent-messages.robotty.de/), only after
  you opt in) with older pages as you scroll up, and gap filling after a reconnect.
- Links to X/Twitter posts show a preview card (author, text, picture, counts); the Worker fetches it from the
  unofficial [FixTweet](https://github.com/FxEmbed/FxEmbed) service so your address isn't shared with it. Links to
  images can show the picture too (opt-in). Both are under Settings → Chat → Link previews.
- Clip links in chat show as cards; first-time chatters, deleted messages, highlighted and channel-points
  messages, raids and Gigantified emotes are marked.
- Reply, save a message as a bookmark, or translate it (with the browser's own translator where it has one,
  otherwise Google Translate opens with that message).

### Moderation

- In channels you moderate: delete, timeout and ban from the message menu, plus `/ban`, `/unban`, `/timeout`,
  `/untimeout` and `/clear`.
- The **Mod tools** sheet (shield icon): chat modes (slow, followers-only, subscribers-only, emote-only,
  unique), announcements, shoutouts, blocked terms, Shield Mode, unban requests and the chatters list.
- AutoMod queue (allow or deny held messages), warnings, and monitoring or restricting suspicious users.
- Messages Twitch flags as suspicious are marked in chat; an optional line shows other moderators' actions.

### Video, clips and VODs

- Twitch's own embedded player beside (or above) the chat, with Picture-in-Picture where the browser supports it.
- **Pin a stream** so it keeps playing while you switch chat tabs, or **watch alongside** to show a second
  stream next to the first (windows 1000px wide or more).
- Opt-in **native player** for browsers where the embed doesn't work: quality menu including Source and
  audio-only. The video never goes through the Worker; it only relays the small quality list.
- **Clips & VODs:** browse a channel's clips (by period), past broadcasts, highlights and uploads, play them in
  Twitch's embeds and share them. Create a clip of the live stream (15, 30 or 60 s; a blank title uses the
  stream's title) and optionally post the link to chat. "Your clips" lists the ones you made with Yappa.
- Hand-off button for Bits and channel points, which Twitch doesn't allow third-party apps to use.

### Staying on top of things

- **Mentions** (account menu or Alt+M) collects @mentions and highlights from every open channel; **All chats**
  (Alt+A) shows them all in one feed.
- Highlight rules, notifications and sound; go-live alerts for followed channels and a line in chat when a
  channel changes its title or category (only while Yappa is open).
- Mute filters: hide known bots, `!commands`, and words, phrases or `/patterns/`.
- Tap the live chip for uptime and a viewer graph; a countdown shows when slow mode lets you chat again.
- **Discover** top live streams, browse categories, search channels and see schedules.
- Whispers, your Twitch block list, and a chip showing your subscription to the open channel.

### Make it yours

- **Settings sync** across your devices: settings, open tabs and the pinned stream (video player, theme, text
  size and notification choices stay per device).
- Per-channel overrides for notifications, sound, go-live alerts and muted words.
- Private notes and colored labels on people; quick messages for things you type often; favorite emotes.
- Light and dark themes, compact or shaded rows, hidden times or badges, monospace or serif font. Settings is a short list of collapsible sections with a search box.
- Tab menu (move, live-first, pin, close others), desktop shortcuts (`?` lists them), save a chat as text or
  JSON, and a settings backup you can restore from a file.
- Optional **chat color cycling**: a new random hex color every time you send a message (needs Twitch Turbo or
  Prime; the color is account-wide, so it changes in every channel).

### What Twitch doesn't allow

Some things people expect from a chat client aren't possible for a third-party app, so Yappa doesn't pretend:

- **Follow and unfollow:** Twitch removed the API (2023). The heart shows your status and opens the channel on
  Twitch to change it.
- **Spending Bits or channel points, starting polls, predictions or raids, and choosing your badges:** no API for
  an app acting as you (some need the broadcaster's own token). Yappa hands off to Twitch where it can.
- **Watch streaks, channel points and drops:** Twitch credits these for watching on twitch.tv or its own apps.
  Embedded players on other sites, like the one in Yappa, don't appear to count (Twitch doesn't document it
  either way; in testing, 30 minutes of watching in Yappa didn't advance a streak). Yappa doesn't try to fake watching.
  To keep a streak, watch on Twitch; the gem button opens the channel there.
- **Full channel-points redemption feed:** only the broadcaster can see it; Yappa marks the redemptions that
  show up in chat.

## Quick start

For the full walkthrough, see the **[self-hosting guide](docs/SELF-HOSTING.md)**. The short version:

1. **Twitch app:** register one at <https://dev.twitch.tv/console/apps> (Confidential client). Set the OAuth
   Redirect URL to `https://<your-hostname>/auth/callback`.
2. **Config:** copy the template and fill it in (see [Configuration](#configuration)).
   ```sh
   cp wrangler.sample.jsonc wrangler.jsonc
   npm install
   npm run types        # generates worker-configuration.d.ts (not in git)
   ```
3. **Secrets and deploy:**
   ```sh
   npx wrangler secret put TWITCH_CLIENT_SECRET
   openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET   # signs sign-in cookies
   npm run deploy
   ```
4. Open your hostname and sign in with Twitch. Add Yappa to your home screen to install it.

## Configuration

Your settings live in files that hold your own hostnames, allowlist and IDs, so they're in `.gitignore` and
never committed:

| File | What it is |
|---|---|
| `wrangler.jsonc` | Your Worker config. Create it from `wrangler.sample.jsonc` (placeholders). |
| `worker-configuration.d.ts` | Generated by `npm run types` from `wrangler.jsonc`; run it after cloning and after changing bindings or vars (`npm run check` needs it). |
| `.dev.vars` | Local secrets for `wrangler dev`. |
| `.claude/` | Personal Claude Code settings. |

If you change the structure of `wrangler.jsonc` (bindings, `rules`, migrations, vars), make the same change in
`wrangler.sample.jsonc` so a fresh clone still works.

| Setting | Where | What it does |
|---|---|---|
| `routes`, `APP_HOST` | `wrangler.jsonc` | Your hostname. Extra `routes` entries keep an old address working: it forwards browsers to `APP_HOST`, carrying their settings. |
| `TWITCH_CLIENT_ID` | `wrangler.jsonc` | Your Twitch app's client id. |
| `ALLOWED_LOGINS` | `wrangler.jsonc` | Who may sign in: a comma- or space-separated list of Twitch logins and/or numeric user ids. Empty allows nobody. Prefer ids: a login can be renamed and claimed by someone else, an id can't. |
| `TWITCH_CLIENT_SECRET` | Worker secret | Your Twitch app's secret. Declared under `secrets.required`, so a deploy fails if it's missing. |
| `SESSION_SECRET` | Worker secret | 32+ random characters; signs the sign-in cookie. Changing it signs everyone out. |

`ALLOWED_LOGINS` is checked on every request, so removing someone ends their access immediately (run
`npm run deploy` after changing it). Sign-in is a signed, 30-day, HttpOnly cookie; each account's Twitch tokens
live in its own Durable Object, named by the Twitch user id.

### Twitch permissions

Three scopes are required; the rest are optional and each only powers its own feature. If you add features
after signing in, Yappa offers to reconnect so you can grant the new ones.

| Scope | Used for |
|---|---|
| `user:read:chat`, `user:write:chat` | Reading and sending chat (required) |
| `user:manage:chat_color` | Color cycling (required) |
| `user:read:emotes` | Your Twitch emotes in the picker |
| `user:read:follows` | Followed channels, the follow heart, go-live alerts |
| `user:read:subscriptions` | The subscription chip |
| `user:read:blocked_users`, `user:manage:blocked_users` | Your block list |
| `user:read:whispers`, `user:manage:whispers` | Whispers |
| `clips:edit` | Creating clips |
| `user:read:moderated_channels` | Knowing which channels you moderate |
| `moderator:manage:chat_messages`, `moderator:manage:banned_users` | Delete, timeout and ban; the moderator log |
| `moderator:manage:chat_settings` | Chat modes |
| `moderator:manage:automod` | The AutoMod queue |
| `moderator:read:followers` | Follow age on user cards |
| `moderator:manage:announcements`, `moderator:manage:shoutouts`, `moderator:manage:warnings` | Announcements, shoutouts, warnings |
| `moderator:manage:blocked_terms`, `moderator:manage:shield_mode` | Blocked terms, Shield Mode |
| `moderator:read:suspicious_users`, `moderator:manage:suspicious_users` | Suspicious-user flags and marking |
| `moderator:manage:unban_requests`, `moderator:read:chatters` | Unban requests, the chatters list |

## How it works

```
 Browser (plain JS, no build step)
   ├─ Twitch EventSub WebSocket   chat events, shared by all tabs
   ├─ Twitch embeds               player, clips, VODs
   ├─ 7TV / BTTV / FFZ            emotes
   ├─ recent-messages.robotty.de  history (only after you opt in)
   └─ anonymous Twitch IRC        only for first-time-chatter flags
        │  (same-origin, signed session cookie)
        ▼
 Cloudflare Worker ──► app token ──► public Twitch lookups (live status, badges, clips)
        │
        ▼
 Durable Object, one per Twitch account ──► Helix API as that user
   (holds the tokens, refreshes them, color-cycling state, synced settings)
```

- **Tokens never reach the browser.** The Worker exchanges the sign-in code itself, checks the allowlist, and
  hands the tokens to that account's Durable Object. A stranger's grant is revoked and nothing is kept.
- **The Worker serves the app and answers `/api`.** Anything that needs your identity or permissions goes
  through your Durable Object; public lookups use a shared app token so polling doesn't wake it.
- **The browser talks to Twitch directly** for chat events (one EventSub WebSocket for all tabs), embeds and
  third-party emote services. History comes from a community service and is opt-in.
- **Client code is plain JS and CSS** in `src/client/`, imported into the Worker as text modules.
- The page ships a strict Content-Security-Policy: scripts only from the app and Twitch's player.

More detail, including the gotchas learned along the way, is in [CLAUDE.md](CLAUDE.md).

## Development

```sh
npm install
npm run types      # after cloning and after changing wrangler.jsonc
npm run check      # type-check the Worker
npm test           # unit tests, then the browser tests (about 40 s)
npm run deploy     # wrangler deploy; there is no staging
```

- `npm run test:unit` is the fast, browser-free half (request validation, the usher relay, and the Worker's
  sign-in, sessions, allowlist and sync run directly in Node). `npm run test:e2e` loads the real page in
  headless Chromium at phone size with every external service faked, so real Twitch is never exercised.
- Browser setup for the tests (the Chromium path and missing shared libraries) is described in
  [CLAUDE.md](CLAUDE.md#testing).
- The app icon and the GitHub social preview are drawn by `scripts/draw-icon.mjs` and
  `scripts/draw-social.mjs`.
- Screenshots below are regenerated by the browser tests (see the note at the start of that section).
- GitHub Actions (`.github/workflows/ci.yml`) runs the type-check and both test suites on every push and pull
  request, using `wrangler.sample.jsonc` as the config.

## License

[MIT](LICENSE).

## Screenshots

Each state is shown on a phone (390×760 at 2× pixel density) and on a desktop-sized window (1280×800, also 2×). They come from the end-to-end test, which fakes every Twitch response, so the names, pictures and thumbnails are placeholders and the video box is a stand-in for Twitch's player. They're rendered in Roboto, Android's system font, so they look like a phone rather than the headless browser's fallback font. Regenerate them with `SHOTS=1 SHOTS_FONTS=<dir with Roboto-Regular.woff2, Roboto-Medium.woff2 and Roboto-Bold.woff2> npm run test:e2e` (the `roboto-fontface` npm package has them under `fonts/roboto/`; they land in `docs/screenshots/`).

<details>
<summary><b>Chat</b> (11 screens)</summary>

**Chat tabs, history, first-time chatter flag, live status**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/chat-mobile.png" width="240" alt="Chat tabs, history, first-time chatter flag, live status (phone)"> | <img src="docs/screenshots/chat-desktop.png" width="520" alt="Chat tabs, history, first-time chatter flag, live status (desktop)"> |

**Composer with emotes rendered inline**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/composer-mobile.png" width="240" alt="Composer with emotes rendered inline (phone)"> | <img src="docs/screenshots/composer-desktop.png" width="520" alt="Composer with emotes rendered inline (desktop)"> |

**Tap an emote: its name and where it comes from**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/emote-tooltip-mobile.png" width="240" alt="Emote tooltip (phone)"> | <img src="docs/screenshots/emote-tooltip-desktop.png" width="520" alt="Emote tooltip (desktop)"> |

**Emote autocomplete**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/emote-autocomplete-mobile.png" width="240" alt="Emote autocomplete (phone)"> | <img src="docs/screenshots/emote-autocomplete-desktop.png" width="520" alt="Emote autocomplete (desktop)"> |

**Highlights, mentions, deleted and ignored messages**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/message-flags-mobile.png" width="240" alt="Highlights, mentions, deleted and ignored messages (phone)"> | <img src="docs/screenshots/message-flags-desktop.png" width="520" alt="Highlights, mentions, deleted and ignored messages (desktop)"> |

**Clip links shown as cards**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/clip-cards-mobile.png" width="240" alt="Clip links shown as cards (phone)"> | <img src="docs/screenshots/clip-cards-desktop.png" width="520" alt="Clip links shown as cards (desktop)"> |

**Raid notices**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/raid-mobile.png" width="240" alt="Raid notices (phone)"> | <img src="docs/screenshots/raid-desktop.png" width="520" alt="Raid notices (desktop)"> |

**GIFs from Tier 2+ subscribers**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/gifs-mobile.png" width="240" alt="GIFs from Tier 2+ subscribers (phone)"> | <img src="docs/screenshots/gifs-desktop.png" width="520" alt="GIFs from Tier 2+ subscribers (desktop)"> |

**"Gigantify an Emote" messages**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/giant-emotes-mobile.png" width="240" alt="Gigantify an Emote messages (phone)"> | <img src="docs/screenshots/giant-emotes-desktop.png" width="520" alt="Gigantify an Emote messages (desktop)"> |

**Channel points redemptions that show in chat**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/channel-points-mobile.png" width="240" alt="Channel points redemptions that show in chat (phone)"> | <img src="docs/screenshots/channel-points-desktop.png" width="520" alt="Channel points redemptions that show in chat (desktop)"> |

**Chat history opt-in prompt**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/history-optin-mobile.png" width="240" alt="Chat history opt-in prompt (phone)"> | <img src="docs/screenshots/history-optin-desktop.png" width="520" alt="Chat history opt-in prompt (desktop)"> |

</details>

<details>
<summary><b>Channels and account</b> (3 screens)</summary>

**Followed channels, live ones first**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/channel-picker-mobile.png" width="240" alt="Followed channels, live ones first (phone)"> | <img src="docs/screenshots/channel-picker-desktop.png" width="520" alt="Followed channels, live ones first (desktop)"> |

**Follow status in the info bar (opens Twitch to change it)**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/follow-button-mobile.png" width="240" alt="Follow status in the info bar (opens Twitch to change it) (phone)"> | <img src="docs/screenshots/follow-button-desktop.png" width="520" alt="Follow status in the info bar (opens Twitch to change it) (desktop)"> |

**Account menu: Settings, Your clips, Log out**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/account-menu-mobile.png" width="240" alt="Account menu: Settings, Your clips, Log out (phone)"> | <img src="docs/screenshots/account-menu-desktop.png" width="520" alt="Account menu: Settings, Your clips, Log out (desktop)"> |

</details>

<details>
<summary><b>Video</b> (4 screens)</summary>

**Embedded Twitch player**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/video-mobile.png" width="240" alt="Embedded Twitch player (phone)"> | <img src="docs/screenshots/video-desktop.png" width="520" alt="Embedded Twitch player (desktop)"> |

**Phone turned sideways: video on the left, chat on the right**

<img src="docs/screenshots/video-landscape.png" width="620" alt="Phone in landscape: video left, chat right">

**Pinned stream: keeps playing while you switch chat tabs**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/pinned-stream-mobile.png" width="240" alt="Pinned stream (phone)"> | <img src="docs/screenshots/pinned-stream-desktop.png" width="520" alt="Pinned stream (desktop)"> |

**Native player quality menu**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/video-quality-mobile.png" width="240" alt="Native player quality menu (phone)"> | <img src="docs/screenshots/video-quality-desktop.png" width="520" alt="Native player quality menu (desktop)"> |

**Bits and channel points hand-off button**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/bits-and-points-mobile.png" width="240" alt="Bits and channel points hand-off button (phone)"> | <img src="docs/screenshots/bits-and-points-desktop.png" width="520" alt="Bits and channel points hand-off button (desktop)"> |

</details>

<details>
<summary><b>Clips and VODs</b> (4 screens)</summary>

**Browse a channel's clips and VODs**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/browse-clips-mobile.png" width="240" alt="Browse a channel's clips and VODs (phone)"> | <img src="docs/screenshots/browse-clips-desktop.png" width="520" alt="Browse a channel's clips and VODs (desktop)"> |

**Playing a clip, with Share**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/clip-player-mobile.png" width="240" alt="Playing a clip, with Share (phone)"> | <img src="docs/screenshots/clip-player-desktop.png" width="520" alt="Playing a clip, with Share (desktop)"> |

**Create a clip of the live stream**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/create-clip-mobile.png" width="240" alt="Create a clip of the live stream (phone)"> | <img src="docs/screenshots/create-clip-desktop.png" width="520" alt="Create a clip of the live stream (desktop)"> |

**Clips you made through Yappa**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/your-clips-mobile.png" width="240" alt="Clips you made through Yappa (phone)"> | <img src="docs/screenshots/your-clips-desktop.png" width="520" alt="Clips you made through Yappa (desktop)"> |

</details>

<details>
<summary><b>Moderation</b> (8 screens)</summary>

**Moderator tools**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/mod-tools-mobile.png" width="240" alt="Moderator tools (phone)"> | <img src="docs/screenshots/mod-tools-desktop.png" width="520" alt="Moderator tools (desktop)"> |

**Whispers**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/whispers-mobile.png" width="240" alt="Whispers (phone)"> | <img src="docs/screenshots/whispers-desktop.png" width="520" alt="Whispers (desktop)"> |

**Discover streams**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/discover-mobile.png" width="240" alt="Discover streams (phone)"> | <img src="docs/screenshots/discover-desktop.png" width="520" alt="Discover streams (desktop)"> |

**Message actions**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/mod-actions-mobile.png" width="240" alt="Message actions (phone)"> | <img src="docs/screenshots/mod-actions-desktop.png" width="520" alt="Message actions (desktop)"> |

**Chat modes (the first tab of Mod tools)**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/chat-modes-mobile.png" width="240" alt="Chat modes (phone)"> | <img src="docs/screenshots/chat-modes-desktop.png" width="520" alt="Chat modes (desktop)"> |

**AutoMod queue**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/automod-mobile.png" width="240" alt="AutoMod queue (phone)"> | <img src="docs/screenshots/automod-desktop.png" width="520" alt="AutoMod queue (desktop)"> |

**User card: the badges on their message, and what each means**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/user-badges-mobile.png" width="240" alt="User card badges (phone)"> | <img src="docs/screenshots/user-badges-desktop.png" width="520" alt="User card badges (desktop)"> |

**User card with follow age and quick timeouts**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/user-card-mobile.png" width="240" alt="User card with follow age and quick timeouts (phone)"> | <img src="docs/screenshots/user-card-desktop.png" width="520" alt="User card with follow age and quick timeouts (desktop)"> |

</details>

<details>
<summary><b>Mentions, filters, stats</b> (5 screens)</summary>

**Mentions** and **mute filters**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/mentions-mobile.png" width="240" alt="Mentions (phone)"> | <img src="docs/screenshots/mentions-desktop.png" width="520" alt="Mentions (desktop)"> |
| <img src="docs/screenshots/mute-filters-mobile.png" width="240" alt="Mute filters (phone)"> | <img src="docs/screenshots/mute-filters-desktop.png" width="520" alt="Mute filters (desktop)"> |

**All chats in one feed** and **stream stats**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/combined-feed-mobile.png" width="240" alt="All chats in one feed (phone)"> | <img src="docs/screenshots/combined-feed-desktop.png" width="520" alt="All chats in one feed (desktop)"> |
| <img src="docs/screenshots/stream-stats-mobile.png" width="240" alt="Stream stats (phone)"> | <img src="docs/screenshots/stream-stats-desktop.png" width="520" alt="Stream stats (desktop)"> |

**Emote picker by channel**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/emote-picker-by-channel-mobile.png" width="240" alt="Emote picker grouped by channel (phone)"> | <img src="docs/screenshots/emote-picker-by-channel-desktop.png" width="520" alt="Emote picker grouped by channel (desktop)"> |

</details>

<details>
<summary><b>Personal touches</b> (8 screens)</summary>

**Per-channel settings** and **notes on people**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/channel-settings-mobile.png" width="240" alt="Settings for one channel (phone)"> | <img src="docs/screenshots/channel-settings-desktop.png" width="520" alt="Settings for one channel (desktop)"> |
| <img src="docs/screenshots/user-note-mobile.png" width="240" alt="A note on a person (phone)"> | <img src="docs/screenshots/user-note-desktop.png" width="520" alt="A note on a person (desktop)"> |

**Quick messages**, **favorite emotes** and **bookmarks**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/quick-messages-mobile.png" width="240" alt="Quick messages (phone)"> | <img src="docs/screenshots/quick-messages-desktop.png" width="520" alt="Quick messages (desktop)"> |
| <img src="docs/screenshots/favorite-emotes-mobile.png" width="240" alt="Favorite emotes (phone)"> | <img src="docs/screenshots/favorite-emotes-desktop.png" width="520" alt="Favorite emotes (desktop)"> |
| <img src="docs/screenshots/bookmarks-mobile.png" width="240" alt="Bookmarks (phone)"> | <img src="docs/screenshots/bookmarks-desktop.png" width="520" alt="Bookmarks (desktop)"> |

**Tab menu**, **watching two streams** and **chat layout**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/tab-menu-mobile.png" width="240" alt="Tab menu (phone)"> | <img src="docs/screenshots/tab-menu-desktop.png" width="520" alt="Tab menu (desktop)"> |
| <img src="docs/screenshots/watch-alongside-mobile.png" width="240" alt="Two streams side by side (phone window)"> | <img src="docs/screenshots/watch-alongside-desktop.png" width="520" alt="Two streams side by side (desktop)"> |
| <img src="docs/screenshots/chat-layout-mobile.png" width="240" alt="Compact monospace chat (phone)"> | <img src="docs/screenshots/chat-layout-desktop.png" width="520" alt="Compact monospace chat (desktop)"> |

</details>

<details>
<summary><b>Settings and color cycling</b> (3 screens)</summary>

**Settings: collapsible sections with a search box**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/settings-mobile.png" width="240" alt="Settings sections (phone)"> | <img src="docs/screenshots/settings-desktop.png" width="520" alt="Settings sections (desktop)"> |
| <img src="docs/screenshots/settings-section-mobile.png" width="240" alt="One Settings section open (phone)"> | <img src="docs/screenshots/settings-section-desktop.png" width="520" alt="One Settings section open (desktop)"> |

**Light theme**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/light-theme-mobile.png" width="240" alt="Light theme (phone)"> | <img src="docs/screenshots/light-theme-desktop.png" width="520" alt="Light theme (desktop)"> |

**Chat color cycling**

| Phone | Desktop |
|---|---|
| <img src="docs/screenshots/color-cycling-mobile.png" width="240" alt="Chat color cycling (phone)"> | <img src="docs/screenshots/color-cycling-desktop.png" width="520" alt="Chat color cycling (desktop)"> |

</details>
