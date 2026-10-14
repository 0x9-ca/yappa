/**
 * Request checking and plain-words errors for the moderator tools (announcements, shoutouts,
 * warnings, blocked terms, Shield Mode, suspicious users, unban requests, chatters) and the
 * personal ones (whispers, block list, subscription check). Pure functions, tested on their own.
 */

/** Permissions these features add. Optional: older logins keep working, the page offers a reconnect. */
export const TOOL_SCOPES = [
  "moderator:manage:announcements",
  "moderator:manage:shoutouts",
  "moderator:manage:warnings",
  "moderator:manage:blocked_terms",
  "moderator:manage:shield_mode",
  "moderator:manage:suspicious_users",
  "moderator:read:suspicious_users",
  "moderator:manage:unban_requests",
  "moderator:read:chatters",
  "user:read:subscriptions",
  "user:read:blocked_users",
  "user:manage:blocked_users",
  "user:manage:whispers",
  "user:read:whispers",
] as const;

const NUM = /^\d{1,20}$/;
const TOKEN = /^[A-Za-z0-9-]{1,64}$/;
const LOGIN = /^[a-z0-9_]{1,25}$/;

const clean = (v: unknown, min: number, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  const n = Array.from(t).length;
  return n >= min && n <= max ? t : null;
};

const num = (v: unknown): string | null => (typeof v === "string" && NUM.test(v) ? v : null);
type Body = Record<string, unknown>;

export function parseAnnounce(b: Body): { broadcasterId: string; message: string; color: string } | string {
  const broadcasterId = num(b.broadcaster_id);
  if (!broadcasterId) return "Bad broadcaster_id.";
  const message = clean(b.message, 1, 500);
  if (!message) return "An announcement needs 1 to 500 characters.";
  const color = b.color === undefined ? "primary" : b.color;
  if (typeof color !== "string" || !["blue", "green", "orange", "purple", "primary"].includes(color)) return "Bad color.";
  return { broadcasterId, message, color };
}

export function parseShoutout(b: Body): { broadcasterId: string; toLogin: string } | string {
  const broadcasterId = num(b.broadcaster_id);
  if (!broadcasterId) return "Bad broadcaster_id.";
  const raw = typeof b.to_login === "string" ? b.to_login : "";
  const toLogin = raw.trim().replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "").replace(/^[#@]/, "").split(/[/?#]/)[0].toLowerCase();
  return LOGIN.test(toLogin) ? { broadcasterId, toLogin } : "Enter the channel to shout out.";
}

export function parseWarn(b: Body): { broadcasterId: string; userId: string; reason: string } | string {
  const broadcasterId = num(b.broadcaster_id), userId = num(b.user_id);
  if (!broadcasterId || !userId) return "Bad broadcaster_id or user_id.";
  const reason = clean(b.reason, 1, 500);
  return reason ? { broadcasterId, userId, reason } : "A warning needs a reason of 1 to 500 characters.";
}

export function parseTerm(b: Body): { broadcasterId: string; text: string } | string {
  const broadcasterId = num(b.broadcaster_id);
  if (!broadcasterId) return "Bad broadcaster_id.";
  const text = clean(b.text, 2, 500);
  return text ? { broadcasterId, text } : "A blocked term needs 2 to 500 characters.";
}

export function parseTermRemove(b: Body): { broadcasterId: string; id: string } | string {
  const broadcasterId = num(b.broadcaster_id);
  if (!broadcasterId) return "Bad broadcaster_id.";
  return typeof b.id === "string" && TOKEN.test(b.id) ? { broadcasterId, id: b.id } : "Bad term id.";
}

export function parseShield(b: Body): { broadcasterId: string; active: boolean } | string {
  const broadcasterId = num(b.broadcaster_id);
  if (!broadcasterId) return "Bad broadcaster_id.";
  return typeof b.active === "boolean" ? { broadcasterId, active: b.active } : "Say whether Shield Mode should be on.";
}

export function parseSuspicious(b: Body): { broadcasterId: string; userId: string; status: "ACTIVE_MONITORING" | "RESTRICTED" | "NONE" } | string {
  const broadcasterId = num(b.broadcaster_id), userId = num(b.user_id);
  if (!broadcasterId || !userId) return "Bad broadcaster_id or user_id.";
  const s = b.status;
  return s === "ACTIVE_MONITORING" || s === "RESTRICTED" || s === "NONE" ? { broadcasterId, userId, status: s } : "Bad status.";
}

export function parseUnbanResolve(b: Body): { broadcasterId: string; id: string; status: "approved" | "denied"; text?: string } | string {
  const broadcasterId = num(b.broadcaster_id);
  if (!broadcasterId) return "Bad broadcaster_id.";
  if (typeof b.id !== "string" || !TOKEN.test(b.id)) return "Bad request id.";
  if (b.status !== "approved" && b.status !== "denied") return "Bad status.";
  const text = b.text === undefined || b.text === "" ? undefined : clean(b.text, 1, 500);
  if (text === null) return "The note can be up to 500 characters.";
  return { broadcasterId, id: b.id, status: b.status, text };
}

export function parseBroadcaster(p: URLSearchParams): string | null {
  return num(p.get("broadcaster_id") ?? "");
}

export function parseWhisper(b: Body): { userId: string; message: string } | string {
  const userId = num(b.user_id);
  if (!userId) return "Bad user_id.";
  const message = clean(b.message, 1, 500);
  return message ? { userId, message } : "A whisper needs 1 to 500 characters.";
}

export function parseBlock(b: Body): { userId: string; block: boolean } | string {
  const userId = num(b.user_id);
  if (!userId) return "Bad user_id.";
  return typeof b.block === "boolean" ? { userId, block: b.block } : "Say whether to block or unblock.";
}

export interface SearchQuery { q: string; liveOnly: boolean; after?: string }

export function parseSearch(p: URLSearchParams): SearchQuery | string {
  const q = clean(p.get("q") ?? "", 1, 100);
  if (!q) return "Type something to search for.";
  const after = p.get("after") ?? undefined;
  if (after !== undefined && !/^[A-Za-z0-9=_.+/-]{1,300}$/.test(after)) return "Bad cursor.";
  return { q, liveOnly: p.get("live") === "1", after };
}

/** Twitch's refusal of a moderator tool, in words someone can act on. */
export function toolFailure(what: string, status: number, detail: string): string {
  if (status === 401) return "Twitch rejected the permission. Reconnect Twitch and try again.";
  if (status === 403) return `Twitch won't let you ${what} here${detail ? ": " + detail : ". You may not be a moderator of this channel, or lack the permission."}`;
  if (status === 404) return "Twitch couldn't find that.";
  if (status === 409) return `That ${what} conflicts with something already set${detail ? " (" + detail + ")" : ""}.`;
  if (status === 429) return "Twitch is rate limiting this. Wait a moment and try again.";
  return `Couldn't ${what}${detail ? " (" + detail + ")" : "."}`;
}

// ---------- trimmed shapes the page uses ----------

export interface Term { id: string; text: string; createdAt: string }
export const slimTerm = (t: { id: string; text: string; created_at: string }): Term => ({ id: t.id, text: t.text, createdAt: t.created_at });

export interface UnbanRequest { id: string; userId: string; login: string; name: string; text: string; createdAt: string; status: string }
export const slimUnban = (r: { id: string; user_id: string; user_login: string; user_name: string; text: string; created_at: string; status: string }): UnbanRequest => ({
  id: r.id, userId: r.user_id, login: r.user_login, name: r.user_name, text: r.text, createdAt: r.created_at, status: r.status,
});

export interface Ban { userId: string; login: string; name: string; bannedAt: string; expiresAt: string | null; reason: string; by: string }
export const slimBan = (r: { user_id: string; user_login: string; user_name: string; created_at: string; expires_at: string; reason: string; moderator_login: string; moderator_name: string }): Ban => ({
  userId: r.user_id, login: r.user_login, name: r.user_name, bannedAt: r.created_at, expiresAt: r.expires_at || null, reason: (r.reason || "").slice(0, 500), by: r.moderator_name || r.moderator_login || "",
});

/** The banned-users list query: a channel, and the cursor of the page after the one already shown. */
export function parseBanned(p: URLSearchParams): { broadcasterId: string; after?: string } | string {
  const broadcasterId = parseBroadcaster(p);
  if (!broadcasterId) return "Bad broadcaster_id.";
  const after = p.get("after");
  if (after && !/^[A-Za-z0-9+/=_-]{1,400}$/.test(after)) return "Bad page cursor.";
  return { broadcasterId, ...(after ? { after } : {}) };
}

export interface SubStatus { tier: string; isGift: boolean; gifter: string | null }

// ---------- discovery (public lookups) ----------

export interface FoundChannel { id: string; login: string; name: string; live: boolean; title: string; game: string; startedAt: string | null }
export const slimChannel = (c: { id: string; broadcaster_login: string; display_name: string; is_live: boolean; title: string; game_name: string; started_at: string }): FoundChannel => ({
  id: c.id, login: c.broadcaster_login, name: c.display_name, live: c.is_live, title: c.title, game: c.game_name, startedAt: c.is_live && c.started_at ? c.started_at : null,
});

export interface TopStream { id: string; login: string; name: string; title: string; game: string; viewers: number; startedAt: string; thumbnail: string | null; language: string }
export const slimStreamRow = (s: { user_id: string; user_login: string; user_name: string; title: string; game_name: string; viewer_count: number; started_at: string; thumbnail_url: string; language: string }): TopStream => ({
  id: s.user_id, login: s.user_login, name: s.user_name, title: s.title, game: s.game_name, viewers: s.viewer_count, startedAt: s.started_at,
  thumbnail: s.thumbnail_url ? s.thumbnail_url.replace("{width}", "320").replace("{height}", "180") : null, language: s.language,
});

export interface Category { id: string; name: string; art: string | null }
export const slimCategory = (c: { id: string; name: string; box_art_url: string }): Category => ({
  id: c.id, name: c.name, art: c.box_art_url ? c.box_art_url.replace("{width}", "52").replace("{height}", "72") : null,
});

export interface Segment { id: string; start: string; end: string | null; title: string; category: string | null; recurring: boolean; canceled: boolean }
export const slimSegment = (s: { id: string; start_time: string; end_time: string | null; title: string; canceled_until: string | null; category: { name: string } | null; is_recurring: boolean }): Segment => ({
  id: s.id, start: s.start_time, end: s.end_time, title: s.title, category: s.category ? s.category.name : null, recurring: s.is_recurring, canceled: !!s.canceled_until,
});

export function parseTop(p: URLSearchParams): { gameId?: string; after?: string } | string {
  const gameId = p.get("game_id") ?? undefined;
  if (gameId !== undefined && !NUM.test(gameId)) return "Bad game_id.";
  const after = p.get("after") ?? undefined;
  if (after !== undefined && !/^[A-Za-z0-9=_.+/-]{1,300}$/.test(after)) return "Bad cursor.";
  return { gameId, after };
}
