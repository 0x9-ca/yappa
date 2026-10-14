/**
 * Preview cards for X/Twitter posts linked in chat. X has no usable public API, so the Worker asks
 * mbedfx (mbedfx.app/_api/v1, an unofficial public service that reads posts for embeds) for the post
 * and passes on a trimmed version. Going through the Worker keeps the viewer's address away from
 * that service, and lets answers be remembered for a while. mbedfx serves every picture from its own
 * `/_media/` URLs, which redirect to X's CDN; the Worker follows that one redirect itself so the
 * browser loads pictures straight from X's CDN (and never from mbedfx). Everything here is a pure
 * function except `fetchX`.
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
  /** The first picture, or a video's poster frame. Only ever an https image on X's own CDN. */
  media: { kind: "photo" | "video" | "gif"; url: string; width: number | null; height: number | null } | null;
  /** Flagged as sensitive: the client doesn't load its media. */
  sensitive: boolean;
  /** More media than the one shown. */
  moreMedia: number;
}

const API = "https://mbedfx.app/_api/v1";
const ID = /^\d{1,25}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

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

/** mbedfx's own picture URLs: https, its host, under /_media/. Nothing else is ever fetched on the post's say-so. */
export function mbedfxMediaUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname === "mbedfx.app" && u.pathname.startsWith("/_media/") ? u.href : null;
  } catch {
    return null;
  }
}

/** A post as the card needs it, before its picture URLs are turned into X CDN ones. */
export interface RawCard extends Omit<XCard, "author" | "media"> {
  author: { name: string; handle: string; avatarSource: string | null; verified: boolean };
  mediaSource: { kind: "photo" | "video" | "gif"; source: string; width: number | null; height: number | null } | null;
}

/** The part of an mbedfx answer the card needs, or null if there's no X post in it. */
export function slimPost(raw: unknown): RawCard | null {
  const r = raw as { ok?: boolean; post?: Record<string, any> } | null;
  const p = r?.ok === true ? r.post : null;
  if (!p || typeof p !== "object" || p.platform !== "x") return null;
  let canonical: URL;
  try { canonical = new URL(String(p.canonical)); } catch { return null; }
  const m = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})\/?$/.exec(canonical.pathname);
  if (!m || canonical.protocol !== "https:" || !/^(x|twitter)\.com$/.test(canonical.hostname.replace(/^www\./, ""))) return null;
  const a = (p.author ?? {}) as Record<string, any>;
  const handle = HANDLE.test(String(a.handle ?? "")) ? String(a.handle) : m[1];
  const items: any[] = Array.isArray(p.media) ? p.media : [];
  const first = items.find((x) => x && (x.kind === "video" ? mbedfxMediaUrl(x.poster) : mbedfxMediaUrl(x.url)));
  let mediaSource: RawCard["mediaSource"] = null;
  if (first) {
    const video = first.kind === "video" || first.still === true;
    mediaSource = { kind: video ? "video" : "photo", source: (first.kind === "video" ? mbedfxMediaUrl(first.poster) : mbedfxMediaUrl(first.url))!, width: num(first.width), height: num(first.height) };
  }
  const counts = (p.counts ?? {}) as Record<string, unknown>;
  return {
    id: m[2],
    url: `https://x.com/${m[1]}/status/${m[2]}`,
    text: str(p.text, 700),
    createdAt: typeof p.createdAt === "string" && !Number.isNaN(Date.parse(p.createdAt)) ? new Date(p.createdAt).toISOString() : null,
    author: { name: str(a.name, 80) || handle, handle, avatarSource: mbedfxMediaUrl(a.avatar), verified: false },
    replies: num(counts.replies),
    retweets: num(counts.reposts),
    likes: num(counts.likes),
    views: num(counts.views),
    sensitive: !!p.sensitive,
    moreMedia: mediaSource ? Math.max(0, items.length - 1) : 0,
    mediaSource,
  };
}

const UA = { "User-Agent": "Yappa (personal Twitch chat client)", Accept: "application/json" };

/** Follows mbedfx's one redirect to the picture's real address on X's CDN (null if it isn't one). */
export async function resolveMedia(source: string | null): Promise<string | null> {
  const url = mbedfxMediaUrl(source);
  if (!url) return null;
  try {
    const res = await fetch(url, { redirect: "manual", headers: UA, signal: AbortSignal.timeout(5000) });
    res.body?.cancel().catch(() => {});
    const loc = res.headers.get("location");
    return res.status >= 300 && res.status < 400 && loc ? twimgUrl(new URL(loc, url).href) : null;
  } catch {
    return null;
  }
}

const TTL_OK = 15 * 60_000;
const TTL_FAIL = 2 * 60_000;
const cache = new Map<string, { at: number; value: XAnswer }>();

export type XAnswer = { ok: true; card: XCard } | { ok: false; error: string; status: number };

// A chat can link many posts at once; the service asks callers to space distinct requests out.
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 3) await new Promise<void>((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

const WHY: Record<string, string> = {
  private: "That post is private.",
  age_restricted: "That post is age-restricted.",
  fetch_fail: "That post isn't available (deleted, or X didn't answer).",
};

export async function fetchX(id: string, now = Date.now()): Promise<XAnswer> {
  const hit = cache.get(id);
  if (hit && now - hit.at < (hit.value.ok ? TTL_OK : TTL_FAIL)) return hit.value;
  const value = await slot(async (): Promise<XAnswer> => {
    try {
      // The post's own handle isn't needed: X resolves any /i/status/<id> link.
      const res = await fetch(`${API}?url=${encodeURIComponent(`https://x.com/i/status/${id}`)}`, { headers: UA, signal: AbortSignal.timeout(12000) });
      if (!res.ok) return { ok: false, error: `The preview service answered ${res.status}.`, status: 502 };
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: { code?: string } } | null;
      if (body && body.ok === false) return { ok: false, error: WHY[body.error?.code ?? ""] ?? "That post isn't available.", status: 404 };
      const raw = slimPost(body);
      if (!raw) return { ok: false, error: "The preview service sent nothing usable.", status: 502 };
      const [avatar, mediaUrl] = await Promise.all([resolveMedia(raw.author.avatarSource), resolveMedia(raw.mediaSource?.source ?? null)]);
      const { author, mediaSource, ...rest } = raw;
      return {
        ok: true,
        card: {
          ...rest,
          author: { name: author.name, handle: author.handle, avatar, verified: author.verified },
          media: mediaSource && mediaUrl ? { kind: mediaSource.kind, url: mediaUrl, width: mediaSource.width, height: mediaSource.height } : null,
        },
      };
    } catch {
      return { ok: false, error: "Couldn't reach the preview service.", status: 502 };
    }
  });
  if (cache.size >= 200) cache.delete(cache.keys().next().value as string);
  cache.set(id, { at: now, value });
  return value;
}

/** For tests: forget remembered answers. */
export const clearPreviewCache = () => cache.clear();
