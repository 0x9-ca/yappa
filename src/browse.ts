/**
 * Request checking and response shaping for browsing a channel's clips and VODs, and for
 * creating clips. Pure functions (no I/O) so they can be tested on their own.
 */
import type { Clip, Video } from "./twitch";

const ID = /^\d{1,20}$/;
const CURSOR = /^[A-Za-z0-9=_.+/-]{1,300}$/;
export const PAGE_SIZE = 20;

const DAY = 86_400_000;
const PERIODS: Record<string, number> = { day: DAY, week: 7 * DAY, month: 30 * DAY };

export interface ClipsQuery {
  broadcasterId: string;
  startedAt?: string;
  endedAt?: string;
  after?: string;
}

/** Validates ?broadcaster_id=&period=day|week|month|all&after=. Returns an error message instead of a query when it's bad. */
export function parseClipsQuery(p: URLSearchParams, now = Date.now()): ClipsQuery | string {
  const broadcasterId = p.get("broadcaster_id") ?? "";
  if (!ID.test(broadcasterId)) return "Bad broadcaster_id.";
  const period = p.get("period") ?? "all";
  if (period !== "all" && !(period in PERIODS)) return "Bad period.";
  const after = p.get("after") ?? undefined;
  if (after !== undefined && !CURSOR.test(after)) return "Bad cursor.";
  const q: ClipsQuery = { broadcasterId, after };
  // With no date range Twitch returns the all-time most viewed; with one, a missing end means "a week after the start".
  if (period !== "all") {
    q.startedAt = new Date(now - PERIODS[period]).toISOString();
    q.endedAt = new Date(now).toISOString();
  }
  return q;
}

/** Validates ?after= for the list of clips made through Yappa: a plain offset into it. */
export function parseOffset(p: URLSearchParams): number | string {
  const after = p.get("after") ?? "0";
  return /^\d{1,6}$/.test(after) ? Number(after) : "Bad cursor.";
}

export interface VideosQuery {
  userId: string;
  type: "all" | "archive" | "highlight" | "upload";
  sort: "time" | "views";
  after?: string;
}

/** Validates ?user_id=&type=archive|highlight|upload|all&sort=time|views&after=. */
export function parseVideosQuery(p: URLSearchParams): VideosQuery | string {
  const userId = p.get("user_id") ?? "";
  if (!ID.test(userId)) return "Bad user_id.";
  const type = p.get("type") ?? "archive";
  if (!["all", "archive", "highlight", "upload"].includes(type)) return "Bad type.";
  const sort = p.get("sort") ?? "time";
  if (sort !== "time" && sort !== "views") return "Bad sort.";
  const after = p.get("after") ?? undefined;
  if (after !== undefined && !CURSOR.test(after)) return "Bad cursor.";
  return { userId, type: type as VideosQuery["type"], sort, after };
}

export interface CreateClipRequest {
  broadcasterId: string;
  title?: string;
  duration?: number;
}

/** Validates a create-clip request: Twitch allows 5 to 60 seconds, to a tenth of a second. */
export function parseCreateClip(body: Record<string, unknown>): CreateClipRequest | string {
  const broadcasterId = body.broadcaster_id;
  if (typeof broadcasterId !== "string" || !ID.test(broadcasterId)) return "Bad broadcaster_id.";
  const req: CreateClipRequest = { broadcasterId };
  if (body.duration !== undefined) {
    const d = body.duration;
    if (typeof d !== "number" || !Number.isFinite(d) || d < 5 || d > 60) return "Clips are 5 to 60 seconds long.";
    req.duration = Math.round(d * 10) / 10;
  }
  if (body.title !== undefined) {
    if (typeof body.title !== "string") return "Bad title.";
    const title = body.title.replace(/\s+/g, " ").trim();
    if (title.length > 100) return "Titles can be up to 100 characters.";
    if (title) req.title = title;
  }
  return req;
}

/** "3h25m10s" -> seconds. */
export function parseDuration(text: string): number {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text || "");
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

/** Video thumbnail URLs are templates ("...-%{width}x%{height}.jpg"); in-progress broadcasts have none yet. */
export function videoThumb(template: string, width = 320, height = 180): string | null {
  if (!template) return null;
  return template.replace("%{width}", String(width)).replace("%{height}", String(height));
}

export interface SlimClip {
  id: string;
  url: string;
  title: string;
  creator: string;
  broadcaster: string;
  views: number;
  createdAt: string;
  thumbnail: string;
  duration: number;
  game: string | null;
}

export function slimClip(c: Clip, game: string | null): SlimClip {
  return {
    id: c.id, url: c.url, title: c.title, creator: c.creator_name, broadcaster: c.broadcaster_name,
    views: c.view_count, createdAt: c.created_at, thumbnail: c.thumbnail_url, duration: c.duration, game,
  };
}

export interface SlimVideo {
  id: string;
  url: string;
  title: string;
  type: string;
  views: number;
  createdAt: string;
  thumbnail: string | null;
  seconds: number;
}

export function slimVideo(v: Video): SlimVideo {
  return {
    id: v.id, url: v.url, title: v.title, type: v.type, views: v.view_count, createdAt: v.created_at,
    thumbnail: videoThumb(v.thumbnail_url), seconds: parseDuration(v.duration),
  };
}

/** A friendlier message for why Create Clip failed (Twitch's own wording is terse). */
export function clipFailure(status: number, detail: string): string {
  if (status === 404) return "This channel isn't live, so there's nothing to clip.";
  if (status === 403) return "Twitch won't let you clip this channel right now: it may limit clips to followers or subscribers, have clips turned off, or you may be banned or timed out.";
  if (status === 401) return "Twitch rejected the clip permission. Reconnect Twitch and try again.";
  if (status === 400) return "Twitch couldn't create the clip" + (detail ? ": " + detail : ".");
  return "Couldn't create the clip" + (detail ? " (" + detail + ")" : ".");
}
