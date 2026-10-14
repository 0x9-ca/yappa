/**
 * Preview cards for X/Twitter posts linked in chat. X has no usable public API, so the Worker asks
 * FixTweet (api.fxtwitter.com, an unofficial public service) for the post and passes on a trimmed
 * version. Going through the Worker keeps the viewer's address away from that service, and lets
 * answers be remembered for a while. Everything here is a pure function except `fetchX`.
 */

export interface XCard {
  id: string;
  url: string;
  text: string;
  createdAt: string | null;
  author: { name: string; handle: string; avatar: string | null; verified: boolean };
  replies: number | null;
  retweets: number | null;
  likes: number | null;
  views: number | null;
  /** The first picture, or a video/GIF's still frame. Only ever an https image on X's own CDN. */
  media: { kind: "photo" | "video" | "gif"; url: string; width: number | null; height: number | null } | null;
  /** Flagged as possibly sensitive: the client doesn't load its media. */
  sensitive: boolean;
  /** More media than the one shown. */
  moreMedia: number;
}

const ID = /^\d{1,25}$/;

/** A tweet id from the query string, or null. */
export const parseXId = (v: string | null): string | null => (v && ID.test(v) ? v : null);

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** Only https pictures served from X's CDN are passed on (the client loads them directly). */
export function twimgUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && /(^|\.)twimg\.com$/.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

/** The part of a FixTweet answer the card needs, or null if there's no post in it. */
export function slimTweet(raw: unknown): XCard | null {
  const t = (raw as { tweet?: Record<string, any> } | null)?.tweet;
  if (!t || typeof t !== "object" || typeof t.id !== "string" || !ID.test(t.id)) return null;
  const a = (t.author ?? {}) as Record<string, any>;
  const handle = str(a.screen_name, 40);
  if (!handle) return null;
  const photos: any[] = Array.isArray(t.media?.photos) ? t.media.photos : [];
  const videos: any[] = Array.isArray(t.media?.videos) ? t.media.videos : [];
  let media: XCard["media"] = null;
  const photo = photos.map((p) => ({ url: twimgUrl(p?.url), w: num(p?.width), h: num(p?.height) })).find((p) => p.url);
  if (photo) media = { kind: "photo", url: photo.url!, width: photo.w, height: photo.h };
  else {
    const video = videos.map((v) => ({ url: twimgUrl(v?.thumbnail_url), w: num(v?.width), h: num(v?.height), gif: v?.type === "gif" })).find((v) => v.url);
    if (video) media = { kind: video.gif ? "gif" : "video", url: video.url!, width: video.w, height: video.h };
  }
  const total = photos.length + videos.length;
  return {
    id: t.id,
    url: `https://x.com/${handle}/status/${t.id}`,
    text: str(t.text, 700),
    createdAt: typeof t.created_at === "string" && !Number.isNaN(Date.parse(t.created_at)) ? new Date(t.created_at).toISOString() : null,
    author: { name: str(a.name, 80) || handle, handle, avatar: twimgUrl(a.avatar_url), verified: !!a.verification?.verified },
    replies: num(t.replies),
    retweets: num(t.retweets),
    likes: num(t.likes),
    views: num(t.views),
    media,
    sensitive: !!t.possibly_sensitive,
    moreMedia: media ? Math.max(0, total - 1) : 0,
  };
}

const TTL_OK = 15 * 60_000;
const TTL_FAIL = 2 * 60_000;
const cache = new Map<string, { at: number; value: XAnswer }>();

export type XAnswer = { ok: true; card: XCard } | { ok: false; error: string; status: number };

export async function fetchX(id: string, now = Date.now()): Promise<XAnswer> {
  const hit = cache.get(id);
  if (hit && now - hit.at < (hit.value.ok ? TTL_OK : TTL_FAIL)) return hit.value;
  let value: XAnswer;
  try {
    const res = await fetch(`https://api.fxtwitter.com/status/${id}`, {
      headers: { "User-Agent": "Yappa (personal Twitch chat client)", Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (res.status === 404 || res.status === 403) value = { ok: false, error: "That post isn't available (deleted, private or age-restricted).", status: 404 };
    else if (!res.ok) value = { ok: false, error: `The preview service answered ${res.status}.`, status: 502 };
    else {
      const card = slimTweet(await res.json().catch(() => null));
      value = card ? { ok: true, card } : { ok: false, error: "The preview service sent nothing usable.", status: 502 };
    }
  } catch {
    value = { ok: false, error: "Couldn't reach the preview service.", status: 502 };
  }
  if (cache.size >= 200) cache.delete(cache.keys().next().value as string);
  cache.set(id, { at: now, value });
  return value;
}

/** For tests: forget remembered answers. */
export const clearPreviewCache = () => cache.clear();
