# Yappa

A Twitch chat client that runs as a Cloudflare Worker (deployed as the `yappa` Worker).

Built on EventSub WebSocket + Helix. It can also change your chat color to a random hex color
every time you send a message. Gated by Cloudflare Access.

## Setup

1. **Twitch app** – https://dev.twitch.tv/console/apps → Register (Confidential client).
   OAuth Redirect URL: `https://<your-worker-host>/auth/callback`.
2. **Config** – in `wrangler.jsonc` set `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` (the AUD tag
   of your existing Access application) and `TWITCH_CLIENT_ID`. Then:
   ```sh
   npm install
   npx wrangler secret put TWITCH_CLIENT_SECRET
   npm run deploy
   ```
3. **Access** – make sure the Worker's hostname (custom domain or workers.dev) is covered
   by the existing Access application. The Worker also verifies the `Cf-Access-Jwt-Assertion`
   JWT itself and returns 403 without a valid one.

## Behavior

- Twitch scopes: `user:manage:chat_color`, `user:read:chat`, `user:write:chat` (required);
  `user:read:emotes`, `user:read:moderated_channels`, `moderator:manage:chat_messages`,
  `moderator:manage:banned_users`, `moderator:read:followers`, `moderator:manage:automod`,
  `moderator:manage:chat_settings` (optional: emote list and mod tools).
- Chat: channel tabs sharing one EventSub WebSocket, 7TV/BTTV/FFZ emotes, cheermotes, emote picker, autocomplete
  (`:name`, Tab, `@user`), and mod tools (message actions plus `/ban`, `/unban`, `/timeout`,
  `/untimeout`, `/clear`) in channels you moderate, plus the AutoMod
  queue, chat-mode toggles and user cards (follow age, quick timeouts).
- Live status on tabs, search/filter, highlight words, mention notifications and sound, hidden
  users, text size. Color cycling also reacts to messages you send from other apps while their
  channel is open in a tab.
- Client code lives in `src/client/` and is bundled as text modules (see `rules` in `wrangler.jsonc`).
- Color cycling picks a new color when switched on and again after every message sent
  through the app, so each message comes out a different color.
- Twitch only allows hex colors for **Turbo or Prime** accounts; otherwise the
  first color change fails with a 400 error and cycling switches off.
- Chat color is account-wide on Twitch, so it changes in every channel, not only the selected one.
