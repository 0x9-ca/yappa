# Self-hosting Yappa

This guide takes you from nothing to your own private copy of Yappa running on your own
Cloudflare account, with your own Twitch app, usable only by the Twitch accounts you list.
Plan on 20–30 minutes. Nothing here needs a server of your own: Yappa is one Cloudflare Worker
plus one Durable Object per person.

## How it fits together

- **Cloudflare Worker** serves the app and its API from your domain.
- **Durable Object** (one per person who signs in) stores that person's Twitch tokens. Tokens never reach the browser.
- **Your Twitch application** (free, registered on Twitch's developer site) is what people sign in through.
- **The allowlist** (`ALLOWED_LOGINS`) decides which Twitch accounts get in. Everyone else sees only a sign-in page.

## What you need

| Need | Notes |
|---|---|
| A Cloudflare account | The free plan works to start with. Yappa uses SQLite-backed Durable Objects, which are available on Free and Paid; the Workers Paid plan ($5/month) gives much more headroom if you have several active users. |
| A domain whose DNS is on Cloudflare | Used for the app's address, e.g. `chat.example.com`. (A `workers.dev` address can work instead; see [No domain?](#no-domain)) |
| A Twitch account | With two-factor authentication on (Twitch requires it to register an app). |
| Node.js 20 or newer, npm and git | Check with `node --version`. |

## Step 1: Get the code

```sh
git clone https://github.com/0x9-ca/yappa.git
cd yappa
npm install
```

## Step 2: Register a Twitch application

1. Go to <https://dev.twitch.tv/console/apps> and sign in.
2. Click **Register Your Application**.
3. **Name:** anything unique that doesn't contain the word "Twitch".
4. **OAuth Redirect URLs:** `https://YOUR-HOSTNAME/auth/callback`, using the exact hostname you'll use in step 3, for example `https://chat.example.com/auth/callback`. It must match exactly, including `https` and no trailing slash.
5. **Category:** *Chat Bot* or *Website Integration* (either works).
6. **Client Type:** **Confidential**. (Yappa keeps the secret on the server.)
7. Click **Create**, then **Manage** on the new app.
8. Copy the **Client ID**. Click **New Secret** and copy the **Client Secret** somewhere safe; Twitch shows it only once.

## Step 3: Configure Yappa

Your settings live in `wrangler.jsonc`, which is deliberately **not** in git (it holds your hostnames and IDs). Create it from the template:

```sh
cp wrangler.sample.jsonc wrangler.jsonc
```

Open `wrangler.jsonc` and change:

| Setting | What to put |
|---|---|
| `routes[0].pattern` | Your hostname, e.g. `chat.example.com` (keep `"custom_domain": true`). |
| `vars.APP_HOST` | The same hostname. |
| `vars.ALLOWED_LOGINS` | Who may sign in: Twitch logins and/or numeric Twitch user IDs, separated by commas or spaces, e.g. `"alice, bob"`. **Empty means nobody can sign in.** |
| `vars.TWITCH_CLIENT_ID` | The Client ID from step 2. |
| `name` | Optional. Any Worker name you like (it only needs to be unique in your account). |

**Logins or IDs?** A login can be renamed on Twitch, after which someone else could take the old name and would then match your list. A numeric user ID never changes hands, so IDs are the stricter choice. Plenty of free "Twitch username to ID" lookup sites exist, or you can call Twitch's Get Users API (`GET https://api.twitch.tv/helix/users?login=NAME`, which needs an app access token). Mixing both in one list is fine.

Then generate the type definitions Yappa's type-check needs (also not committed):

```sh
npm run types
```

## Step 4: Log in to Cloudflare

```sh
npx wrangler login
```

A browser opens to authorize Wrangler against your account. If your account has several zones, Wrangler works out the right one from the hostname in `routes`.

## Step 5: Set the two secrets

Yappa needs two secrets. They're stored encrypted on Cloudflare, never in a file:

```sh
# 1. Your Twitch app's client secret (paste it when asked)
npx wrangler secret put TWITCH_CLIENT_SECRET

# 2. A long random string that signs sign-in cookies
openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET
```

The first time, Wrangler may say the Worker doesn't exist yet and offer to create it. Answer **yes**.

No `openssl`? Any random string of at least 32 characters works as `SESSION_SECRET`. Changing it later signs everybody out, which is a handy "log everyone out" switch.

## Step 6: Deploy

```sh
npm run deploy
```

Cloudflare creates the DNS record and TLS certificate for your hostname automatically (this can take a minute the first time). The deploy fails with a clear message if a secret from step 5 is missing.

## Step 7: Sign in

1. Open `https://YOUR-HOSTNAME/`. You should see a plain **Sign in with Twitch** page.
2. Click it. Twitch asks you to authorize your app with a list of permissions (read and send chat, your emotes and followed channels, clips, moderation tools such as announcements, shoutouts and Shield Mode, whispers, your block list and your subscriptions). The permissions marked optional only power the matching features.
3. After you approve, you land in the app. Type a channel name and press **Open**.

If your Twitch login isn't in `ALLOWED_LOGINS`, you'll get "That Twitch account isn't allowed to use this app", and nothing about you is stored.

## Managing who has access

Edit `ALLOWED_LOGINS` in `wrangler.jsonc` and run `npm run deploy`. The list is checked on every request, so someone you remove is signed out immediately. They don't need to do anything, and their stored Twitch tokens stay in their Durable Object until they use **Log out** (which also disconnects Twitch).

## Optional extras

- **Install it as an app.** On a phone, use your browser's *Add to Home Screen* / *Install app*. Yappa is a PWA.
- **Chat history.** The first time you open a channel, Yappa asks whether to load recent messages from a third-party service (recent-messages.robotty.de). It's off until you agree.
- **Native video player.** Settings → Video player offers a native player as an alternative to Twitch's embed, because the embed doesn't load in some browsers (for example Firefox for Android). It relies on unofficial Twitch endpoints and can break at any time.

## Updating later

```sh
git pull
npm install
npm run types
npm run deploy
```

Your `wrangler.jsonc` isn't touched by `git pull`. If a release changes the *structure* of `wrangler.sample.jsonc` (a new variable or secret), copy the new lines into your own file; the release notes and the deploy error will tell you.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Twitch says **redirect_uri does not match** | The URL registered in your Twitch app must be exactly `https://YOUR-HOSTNAME/auth/callback`. Fix it in the Twitch console. |
| **"The sign-in didn't complete"** after Twitch | The sign-in took more than 10 minutes, or cookies are blocked. Try again. |
| **"Twitch sign-in failed"** | The Client ID or secret is wrong. Re-run `wrangler secret put TWITCH_CLIENT_SECRET` and check `TWITCH_CLIENT_ID`. |
| **"That Twitch account isn't allowed"** | Your login or user ID isn't in `ALLOWED_LOGINS`, or you edited the file but haven't run `npm run deploy`. |
| `npm run deploy` fails mentioning a missing secret | Do step 5, then deploy again. |
| `npm run check` complains about `Env` types | Run `npm run types` (it reads your `wrangler.jsonc`). |
| Signed in, then "Your sign-in has ended" bars appear | The cookie expired (30 days), you changed `SESSION_SECRET`, or you were removed from the list. Click *Sign in again*. |
| Banner says to **Reconnect Twitch** | The app gained a permission since you last signed in. Sign in again to grant it. |
| Page shows but the video won't load | Twitch's embed needs your exact hostname and doesn't load in every browser. Try Settings → Video player → Native. |
| Hostname doesn't resolve right after the first deploy | Wait a minute or two for Cloudflare to issue the certificate. |

## No domain?

You can run on a `workers.dev` address instead, but I haven't tested this path. In `wrangler.jsonc`, delete the `routes` block, set `"workers_dev": true`, set `APP_HOST` to the `*.workers.dev` hostname Wrangler prints on deploy, and register `https://THAT-HOSTNAME/auth/callback` in your Twitch app. You'll need to deploy once to learn the hostname.

## Running it locally

Also untested here, but the standard Wrangler workflow applies: put the two secrets in a `.dev.vars` file (git-ignored) as `TWITCH_CLIENT_SECRET=...` and `SESSION_SECRET=...`, add `http://localhost:8787/auth/callback` as a second OAuth redirect URL in your Twitch app, set `APP_HOST` to an empty string, and run `npm run dev`.

## Privacy and security notes

- Twitch tokens are stored only in your Cloudflare account, in each person's own Durable Object. Yappa has no analytics and no other server.
- Anyone on the allowlist can use chat as their own Twitch account through your deployment, so only list people you trust with your Cloudflare bill and your Twitch app's quota.
- The browser talks directly to Twitch (chat, emotes, optionally the player), 7TV, BTTV and FrankerFaceZ, and, only if you opt in, recent-messages.robotty.de.
- Sign-in cookies are `HttpOnly`, `Secure`, `SameSite=Lax`, host-locked, and signed. Forged or edited cookies are rejected.
