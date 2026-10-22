/**
 * Preview cards for Imgur albums (and gallery posts) linked in chat. Imgur has no keyless public
 * feed, so the Worker asks the same API the imgur.com website uses (with the website's own public
 * client id; unofficial, it can change) and passes on a trimmed card. Going through the Worker keeps
 * the viewer's address away from that API; the pictures themselves are small thumbnails the browser
 * loads from i.imgur.com, and only if image previews are on. Everything but `fetchImgur` is pure.
 */

export interface ImgurCard {
  id: string;
  url: string;
  title: string;
  /** How many pictures the album holds (the card shows the first few). */
  count: number;
  /** Marked mature: the client doesn't load its pictures. */
  sensitive: boolean;
  /** Up to four pictures, always https://i.imgur.com/<id>h.jpg (1024px) for the first and <id>l.jpg (640px) for the rest. */
  thumbs: { url: string; video: boolean; width: number | null; height: number | null }[];
}

const API = "https://api.imgur.com/3";
// The public client id of imgur.com's own web app.
const CLIENT = "546c25a59c58ad7";
const ID = /^[A-Za-z0-9]{5,10}$/;
const MAX_THUMBS = 4;

/** An album or image id from the query string, or null. */
export const parseImgurId = (v: string | null): string | null => (v && ID.test(v) ? v : null);

const dim = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 100000 ? v : null);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** Turns Imgur's answer for an album (or a single image) into a card, or null if it isn't one. */
export function slimImgur(id: string, body: unknown): ImgurCard | null {
  const d = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!d || typeof d !== "object") return null;
  const list = Array.isArray(d.images) ? (d.images as Record<string, unknown>[]) : [d];
  const pics = list.filter((i) => i && typeof i.id === "string" && ID.test(i.id as string));
  if (!pics.length) return null;
  const count = typeof d.images_count === "number" && d.images_count >= pics.length ? Math.min(d.images_count, 9999) : pics.length;
  return {
    id,
    url: `https://imgur.com/${Array.isArray(d.images) ? "a" : "gallery"}/${id}`,
    title: str(d.title, 120),
    count,
    sensitive: d.nsfw === true || pics.some((i) => i.nsfw === true),
    thumbs: pics.slice(0, MAX_THUMBS).map((i, n) => ({ url: `https://i.imgur.com/${i.id}${n === 0 ? "h" : "l"}.jpg`, video: i.animated === true && typeof i.type === "string" && i.type.startsWith("video/"), width: dim(i.width), height: dim(i.height) })),
  };
}

const TTL_OK = 15 * 60_000;
const TTL_FAIL = 2 * 60_000;
const cache = new Map<string, { at: number; value: ImgurAnswer }>();
export type ImgurAnswer = { ok: true; card: ImgurCard } | { ok: false; error: string; status: number };

const get = (path: string) =>
  fetch(`${API}${path}`, { headers: { Authorization: `Client-ID ${CLIENT}`, "User-Agent": "Yappa (personal Twitch chat client)", Accept: "application/json" }, signal: AbortSignal.timeout(8000) });

export async function fetchImgur(id: string, now = Date.now()): Promise<ImgurAnswer> {
  const hit = cache.get(id);
  if (hit && now - hit.at < (hit.value.ok ? TTL_OK : TTL_FAIL)) return hit.value;
  let value: ImgurAnswer;
  try {
    let res = await get(`/album/${id}`);
    if (res.status === 404) res = await get(`/image/${id}`); // a gallery link can be a single picture
    if (res.status === 404) value = { ok: false, error: "That album isn't available.", status: 404 };
    else if (!res.ok) value = { ok: false, error: `Imgur answered ${res.status}.`, status: 502 };
    else {
      const card = slimImgur(id, await res.json().catch(() => null));
      value = card ? { ok: true, card } : { ok: false, error: "Imgur sent nothing usable.", status: 502 };
    }
  } catch {
    value = { ok: false, error: "Couldn't reach Imgur.", status: 502 };
  }
  if (cache.size >= 200) cache.delete(cache.keys().next().value as string);
  cache.set(id, { at: now, value });
  return value;
}

/** For tests: forget remembered answers. */
export const clearImgurCache = () => cache.clear();
