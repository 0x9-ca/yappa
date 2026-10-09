import { TwitchError, getBadges, getCheermotes, getClip, getGameName, getStreamsByIds } from "./twitch";

/**
 * Public Twitch lookups (live status, clips, badges, cheermotes) don't need the user's own
 * token, so the Worker answers them with an app access token instead of waking the user's
 * Durable Object. The token is shared by every user and lives in isolate memory, backed by
 * the Cache API so new isolates don't each mint one. Requests to a custom domain
 * always run the Worker, so that cache entry is never served to anyone.
 */
const CACHE_PATH = "/__internal/twitch-app-token";
let memo: { token: string; expiresAt: number } | undefined;

async function appToken(env: Env, origin: string, force = false): Promise<string> {
  const key = origin + CACHE_PATH;
  if (!force && memo && memo.expiresAt - Date.now() > 60_000) return memo.token;
  const cache = caches.default;
  if (!force) {
    const hit = await cache.match(key);
    if (hit) {
      memo = await hit.json();
      if (memo && memo.expiresAt - Date.now() > 60_000) return memo.token;
    }
  }
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) throw new TwitchError(res.status, `App token request failed (${res.status})`);
  const tok = (await res.json()) as { access_token: string; expires_in: number };
  memo = { token: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 };
  // Cache for well under the token's lifetime (Twitch issues ~60-day app tokens).
  const ttl = Math.max(60, Math.min(tok.expires_in - 3600, 7 * 86400));
  await cache.put(key, new Response(JSON.stringify(memo), { headers: { "Cache-Control": `max-age=${ttl}` } }));
  return memo.token;
}

/** Runs fn with the app token, minting a new one once if Twitch rejects it. */
async function withAppToken<T>(env: Env, origin: string, fn: (token: string) => Promise<T>): Promise<T> {
  try {
    return await fn(await appToken(env, origin));
  } catch (err) {
    if (!(err instanceof TwitchError && err.status === 401)) throw err;
    return fn(await appToken(env, origin, true));
  }
}

/**
 * These return null when Twitch can't be reached, which callers must not confuse with a real
 * empty answer: "no live streams" would mark every channel offline and pause the video.
 */
async function lookup<T>(env: Env, origin: string, fn: (token: string) => Promise<T>): Promise<T | null> {
  try {
    return await withAppToken(env, origin, fn);
  } catch (err) {
    console.error("app-token lookup failed", (err as Error).message);
    return null;
  }
}

export const streams = (env: Env, origin: string, ids: string[]) => lookup(env, origin, (t) => getStreamsByIds(env, t, ids));
export const cheermotes = (env: Env, origin: string, broadcasterId: string) => lookup(env, origin, (t) => getCheermotes(env, t, broadcasterId));
export const badges = (env: Env, origin: string, broadcasterId: string) => lookup(env, origin, (t) => getBadges(env, t, broadcasterId));

/** Clip details for link cards in chat. */
export async function clip(env: Env, origin: string, id: string): Promise<{ ok: true; clip: unknown } | { ok: false; error: string }> {
  try {
    return await withAppToken(env, origin, async (t) => {
      const c = await getClip(env, t, id);
      if (!c) return { ok: true as const, clip: null };
      const game = c.game_id ? await getGameName(env, t, c.game_id).catch(() => null) : null;
      return {
        ok: true as const,
        clip: {
          id: c.id, url: c.url, title: c.title, broadcaster: c.broadcaster_name, creator: c.creator_name,
          views: c.view_count, createdAt: c.created_at, thumbnail: c.thumbnail_url, duration: c.duration, game,
        },
      };
    });
  } catch (err) {
    console.error("app-token lookup failed", (err as Error).message);
    return { ok: false, error: (err as Error).message };
  }
}
