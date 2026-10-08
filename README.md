# yappa

Web Twitch chat client (EventSub WebSocket + Helix, with 7TV emotes) that can also
change your chat color to a random hex color
every 10 seconds while the channel is live. Gated by Cloudflare Access.

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

- Twitch scopes: `user:manage:chat_color`, `user:read:chat`, `user:write:chat`.
- Start requires the channel to be live. The loop stops when the channel has been offline
  for 3 consecutive checks (~30s), when you click Stop, or on unrecoverable errors.
- Twitch only allows hex colors for **Turbo or Prime** accounts; otherwise the
  first color change fails with a 400 error and the loop stops.
- Chat color is account-wide on Twitch, so it changes in every channel, not only the selected one.
