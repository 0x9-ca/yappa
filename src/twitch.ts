const ID_BASE = "https://id.twitch.tv/oauth2";
const API_BASE = "https://api.twitch.tv/helix";

/** Scopes the app can't work without. */
export const SCOPES = ["user:manage:chat_color", "user:read:chat", "user:write:chat"];
/** Nice-to-have scopes: requested at login, but older tokens without them still work. */
export const OPTIONAL_SCOPES = [
  "user:read:emotes",
  "user:read:moderated_channels",
  "moderator:manage:chat_messages",
  "moderator:manage:banned_users",
  "moderator:read:followers",
  "moderator:manage:automod",
  "moderator:manage:chat_settings",
  "user:read:follows",
  "clips:edit",
];

export class TwitchError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[];
}

export interface ValidateResponse {
  client_id: string;
  login: string;
  user_id: string;
  scopes: string[];
  expires_in: number;
}

async function check(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  let detail = "";
  try {
    const body = (await res.json()) as { message?: string };
    detail = body.message ?? "";
  } catch {}
  throw new TwitchError(res.status, `${what} failed (${res.status})${detail ? `: ${detail}` : ""}`);
}

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(`${ID_BASE}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: [...SCOPES, ...OPTIONAL_SCOPES].join(" "),
    state,
    force_verify: "true",
  }).toString();
  return url.toString();
}

async function tokenRequest(params: Record<string, string>, what: string): Promise<TokenResponse> {
  const res = await fetch(`${ID_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return (await check(res, what)).json();
}

export function exchangeCode(env: Env, code: string, redirectUri: string): Promise<TokenResponse> {
  return tokenRequest(
    {
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    },
    "Token exchange",
  );
}

export function refreshToken(env: Env, refresh: string): Promise<TokenResponse> {
  return tokenRequest(
    {
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refresh,
    },
    "Token refresh",
  );
}

export async function validateToken(accessToken: string): Promise<ValidateResponse> {
  const res = await fetch(`${ID_BASE}/validate`, {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  return (await check(res, "Token validation")).json();
}

export async function revokeToken(env: Env, accessToken: string): Promise<void> {
  await fetch(`${ID_BASE}/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID, token: accessToken }),
  });
}

function helixHeaders(env: Env, accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}`, "Client-Id": env.TWITCH_CLIENT_ID };
}

/** Returns true if the channel (by login name) currently has a live stream. */
export async function isLive(env: Env, accessToken: string, channel: string): Promise<boolean> {
  const url = `${API_BASE}/streams?user_login=${encodeURIComponent(channel)}&type=live`;
  const res = await check(await fetch(url, { headers: helixHeaders(env, accessToken) }), "Get Streams");
  const body = (await res.json()) as { data: unknown[] };
  return body.data.length > 0;
}

/** Update User Chat Color. Hex colors require Turbo or Prime on the account. */
export async function setChatColor(env: Env, accessToken: string, userId: string, color: string): Promise<void> {
  const url = `${API_BASE}/chat/color?user_id=${encodeURIComponent(userId)}&color=${encodeURIComponent(color)}`;
  await check(
    await fetch(url, { method: "PUT", headers: helixHeaders(env, accessToken) }),
    "Update User Chat Color",
  );
}

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
}

export async function getUser(env: Env, accessToken: string, login: string): Promise<TwitchUser | null> {
  const url = `${API_BASE}/users?login=${encodeURIComponent(login)}`;
  const res = await check(await fetch(url, { headers: helixHeaders(env, accessToken) }), "Get Users");
  const body = (await res.json()) as { data: TwitchUser[] };
  return body.data[0] ?? null;
}

/** Creates an EventSub subscription delivered to the browser's WebSocket session. */
export async function createWebSocketSubscription(
  env: Env,
  accessToken: string,
  type: string,
  condition: Record<string, string>,
  sessionId: string,
  version = "1",
): Promise<string> {
  const res = await check(
    await fetch(`${API_BASE}/eventsub/subscriptions`, {
      method: "POST",
      headers: { ...helixHeaders(env, accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({ type, version, condition, transport: { method: "websocket", session_id: sessionId } }),
    }),
    `Subscribe to ${type}`,
  );
  return ((await res.json()) as { data: { id: string }[] }).data[0].id;
}

export async function deleteSubscription(env: Env, accessToken: string, id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/eventsub/subscriptions?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: helixHeaders(env, accessToken),
  });
  if (res.status !== 404) await check(res, "Delete EventSub subscription");
}

export interface SendResult {
  message_id: string;
  is_sent: boolean;
  drop_reason?: { code: string; message: string } | null;
}

export async function sendChatMessage(
  env: Env,
  accessToken: string,
  broadcasterId: string,
  senderId: string,
  message: string,
  replyParentId?: string,
): Promise<SendResult> {
  const res = await check(
    await fetch(`${API_BASE}/chat/messages`, {
      method: "POST",
      headers: { ...helixHeaders(env, accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({
        broadcaster_id: broadcasterId,
        sender_id: senderId,
        message,
        ...(replyParentId ? { reply_parent_message_id: replyParentId } : {}),
      }),
    }),
    "Send Chat Message",
  );
  return ((await res.json()) as { data: SendResult[] }).data[0];
}

interface BadgeSet {
  set_id: string;
  versions: { id: string; image_url_1x: string; image_url_2x: string; title: string; description?: string }[];
}

/** Returns "set_id/version" -> {url, title, description}, channel badges overriding global ones. */
export async function getBadges(
  env: Env,
  accessToken: string,
  broadcasterId: string,
): Promise<Record<string, { url: string; title: string; description?: string }>> {
  const headers = helixHeaders(env, accessToken);
  const [global, channel] = await Promise.all(
    [`${API_BASE}/chat/badges/global`, `${API_BASE}/chat/badges?broadcaster_id=${encodeURIComponent(broadcasterId)}`].map(
      async (url) => ((await (await check(await fetch(url, { headers }), "Get Chat Badges")).json()) as { data: BadgeSet[] }).data,
    ),
  );
  const out: Record<string, { url: string; title: string; description?: string }> = {};
  for (const set of [...global, ...channel]) {
    for (const v of set.versions) out[`${set.set_id}/${v.id}`] = { url: v.image_url_2x, title: v.title, description: v.description };
  }
  return out;
}

export interface UserEmote {
  id: string;
  name: string;
  emote_type: string;
  owner_id: string;
  format: string[];
}

/** Every Twitch emote the user can use in the given channel (Get User Emotes; needs user:read:emotes). */
export async function getUserEmotes(
  env: Env,
  accessToken: string,
  userId: string,
  broadcasterId: string,
): Promise<UserEmote[]> {
  const out: UserEmote[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${API_BASE}/chat/emotes/user`);
    url.searchParams.set("user_id", userId);
    url.searchParams.set("broadcaster_id", broadcasterId);
    if (cursor) url.searchParams.set("after", cursor);
    const res = await check(await fetch(url, { headers: helixHeaders(env, accessToken) }), "Get User Emotes");
    const body = (await res.json()) as { data: UserEmote[]; pagination?: { cursor?: string } };
    out.push(...body.data);
    cursor = body.pagination?.cursor;
    if (!cursor) break;
  }
  return out;
}

/** IDs of channels the user moderates (Get Moderated Channels; needs user:read:moderated_channels). */
export async function getModeratedChannelIds(env: Env, accessToken: string, userId: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${API_BASE}/moderation/channels`);
    url.searchParams.set("user_id", userId);
    url.searchParams.set("first", "100");
    if (cursor) url.searchParams.set("after", cursor);
    const res = await check(await fetch(url, { headers: helixHeaders(env, accessToken) }), "Get Moderated Channels");
    const body = (await res.json()) as { data: { broadcaster_id: string }[]; pagination?: { cursor?: string } };
    out.push(...body.data.map((c) => c.broadcaster_id));
    cursor = body.pagination?.cursor;
    if (!cursor) break;
  }
  return out;
}

/** Deletes one message, or clears the whole chat when messageId is omitted. */
export async function deleteChatMessages(
  env: Env,
  accessToken: string,
  broadcasterId: string,
  moderatorId: string,
  messageId?: string,
): Promise<void> {
  const url = new URL(`${API_BASE}/moderation/chat`);
  url.searchParams.set("broadcaster_id", broadcasterId);
  url.searchParams.set("moderator_id", moderatorId);
  if (messageId) url.searchParams.set("message_id", messageId);
  await check(await fetch(url, { method: "DELETE", headers: helixHeaders(env, accessToken) }), "Delete Chat Messages");
}

/** Bans a user, or times them out when duration (seconds) is given. */
export async function banUser(
  env: Env,
  accessToken: string,
  broadcasterId: string,
  moderatorId: string,
  userId: string,
  duration?: number,
  reason?: string,
): Promise<void> {
  const url = new URL(`${API_BASE}/moderation/bans`);
  url.searchParams.set("broadcaster_id", broadcasterId);
  url.searchParams.set("moderator_id", moderatorId);
  await check(
    await fetch(url, {
      method: "POST",
      headers: { ...helixHeaders(env, accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({ data: { user_id: userId, ...(duration ? { duration } : {}), ...(reason ? { reason } : {}) } }),
    }),
    duration ? "Timeout" : "Ban",
  );
}

/** Removes a ban or timeout. */
export async function unbanUser(
  env: Env,
  accessToken: string,
  broadcasterId: string,
  moderatorId: string,
  userId: string,
): Promise<void> {
  const url = new URL(`${API_BASE}/moderation/bans`);
  url.searchParams.set("broadcaster_id", broadcasterId);
  url.searchParams.set("moderator_id", moderatorId);
  url.searchParams.set("user_id", userId);
  await check(await fetch(url, { method: "DELETE", headers: helixHeaders(env, accessToken) }), "Unban");
}

export interface TwitchUserProfile {
  id: string;
  login: string;
  display_name: string;
  description: string;
  profile_image_url: string;
  broadcaster_type: string;
  created_at: string;
}

export async function getUserById(env: Env, accessToken: string, id: string): Promise<TwitchUserProfile | null> {
  const url = `${API_BASE}/users?id=${encodeURIComponent(id)}`;
  const res = await check(await fetch(url, { headers: helixHeaders(env, accessToken) }), "Get Users");
  return ((await res.json()) as { data: TwitchUserProfile[] }).data[0] ?? null;
}

/** When userId followed the channel (null if not following). Needs moderator:read:followers + mod. */
export async function getFollowedAt(
  env: Env,
  accessToken: string,
  broadcasterId: string,
  userId: string,
): Promise<string | null> {
  const url = `${API_BASE}/channels/followers?broadcaster_id=${encodeURIComponent(broadcasterId)}&user_id=${encodeURIComponent(userId)}`;
  const res = await check(await fetch(url, { headers: helixHeaders(env, accessToken) }), "Get Channel Followers");
  return ((await res.json()) as { data: { followed_at: string }[] }).data[0]?.followed_at ?? null;
}

/** Allows or denies a message AutoMod is holding for review. */
export async function manageHeldMessage(
  env: Env,
  accessToken: string,
  moderatorId: string,
  messageId: string,
  action: "ALLOW" | "DENY",
): Promise<void> {
  await check(
    await fetch(`${API_BASE}/moderation/automod/message`, {
      method: "POST",
      headers: { ...helixHeaders(env, accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: moderatorId, msg_id: messageId, action }),
    }),
    "Manage Held AutoMod Message",
  );
}

export interface ChatSettings {
  slow_mode: boolean;
  slow_mode_wait_time: number | null;
  follower_mode: boolean;
  follower_mode_duration: number | null;
  subscriber_mode: boolean;
  emote_mode: boolean;
  unique_chat_mode: boolean;
}

export async function getChatSettings(
  env: Env,
  accessToken: string,
  broadcasterId: string,
): Promise<ChatSettings | null> {
  const url = `${API_BASE}/chat/settings?broadcaster_id=${encodeURIComponent(broadcasterId)}`;
  const res = await check(await fetch(url, { headers: helixHeaders(env, accessToken) }), "Get Chat Settings");
  return ((await res.json()) as { data: ChatSettings[] }).data[0] ?? null;
}

/** Needs moderator:manage:chat_settings and moderator status. */
export async function updateChatSettings(
  env: Env,
  accessToken: string,
  broadcasterId: string,
  moderatorId: string,
  patch: Partial<ChatSettings>,
): Promise<ChatSettings | null> {
  const url = `${API_BASE}/chat/settings?broadcaster_id=${encodeURIComponent(broadcasterId)}&moderator_id=${encodeURIComponent(moderatorId)}`;
  const res = await check(
    await fetch(url, {
      method: "PATCH",
      headers: { ...helixHeaders(env, accessToken), "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
    "Update Chat Settings",
  );
  return ((await res.json()) as { data: ChatSettings[] }).data[0] ?? null;
}

export interface StreamInfo {
  user_id: string;
  title: string;
  game_name: string;
  viewer_count: number;
  started_at: string;
}

/** Live streams among up to 100 user ids. */
export async function getStreamsByIds(env: Env, accessToken: string, ids: string[]): Promise<StreamInfo[]> {
  if (!ids.length) return [];
  const url = new URL(`${API_BASE}/streams`);
  for (const id of ids.slice(0, 100)) url.searchParams.append("user_id", id);
  url.searchParams.set("first", "100");
  const res = await check(await fetch(url, { headers: helixHeaders(env, accessToken) }), "Get Streams");
  return ((await res.json()) as { data: StreamInfo[] }).data;
}

export interface Cheermote {
  prefix: string;
  tiers: { min_bits: number; color: string; images: { dark: { animated: Record<string, string> } } }[];
}

export async function getCheermotes(env: Env, accessToken: string, broadcasterId: string): Promise<Cheermote[]> {
  const url = `${API_BASE}/bits/cheermotes?broadcaster_id=${encodeURIComponent(broadcasterId)}`;
  const res = await check(await fetch(url, { headers: helixHeaders(env, accessToken) }), "Get Cheermotes");
  return ((await res.json()) as { data: Cheermote[] }).data;
}

export interface Clip {
  id: string;
  url: string;
  broadcaster_name: string;
  creator_name: string;
  title: string;
  view_count: number;
  created_at: string;
  thumbnail_url: string;
  duration: number;
  game_id: string;
}

/** One page of a channel's clips, most viewed first. Any token works (the app's too). */
export async function getClipsPage(
  env: Env,
  accessToken: string,
  broadcasterId: string,
  opts: { startedAt?: string; endedAt?: string; after?: string; first: number },
): Promise<{ clips: Clip[]; cursor: string | null }> {
  const url = new URL(`${API_BASE}/clips`);
  url.searchParams.set("broadcaster_id", broadcasterId);
  url.searchParams.set("first", String(opts.first));
  if (opts.startedAt) url.searchParams.set("started_at", opts.startedAt);
  if (opts.endedAt) url.searchParams.set("ended_at", opts.endedAt);
  if (opts.after) url.searchParams.set("after", opts.after);
  const res = await check(await fetch(url, { headers: helixHeaders(env, accessToken) }), "Get Clips");
  const body = (await res.json()) as { data: Clip[]; pagination?: { cursor?: string } };
  return { clips: body.data, cursor: body.pagination?.cursor ?? null };
}

/** Specific clips by id (up to 100). Unknown or deleted ids are simply left out. */
export async function getClipsByIds(env: Env, accessToken: string, ids: string[]): Promise<Clip[]> {
  if (!ids.length) return [];
  const url = new URL(`${API_BASE}/clips`);
  for (const id of ids.slice(0, 100)) url.searchParams.append("id", id);
  const res = await check(await fetch(url, { headers: helixHeaders(env, accessToken) }), "Get Clips");
  return ((await res.json()) as { data: Clip[] }).data;
}

export interface Video {
  id: string;
  url: string;
  title: string;
  type: string;
  view_count: number;
  created_at: string;
  thumbnail_url: string;
  duration: string;
}

/** One page of a channel's videos (past broadcasts, highlights or uploads). Any token works. */
export async function getVideosPage(
  env: Env,
  accessToken: string,
  userId: string,
  opts: { type: string; sort: string; after?: string; first: number },
): Promise<{ videos: Video[]; cursor: string | null }> {
  const url = new URL(`${API_BASE}/videos`);
  url.searchParams.set("user_id", userId);
  url.searchParams.set("type", opts.type);
  url.searchParams.set("sort", opts.sort);
  url.searchParams.set("first", String(opts.first));
  if (opts.after) url.searchParams.set("after", opts.after);
  const res = await check(await fetch(url, { headers: helixHeaders(env, accessToken) }), "Get Videos");
  const body = (await res.json()) as { data: Video[]; pagination?: { cursor?: string } };
  return { videos: body.data, cursor: body.pagination?.cursor ?? null };
}

/** Category names for up to 100 game ids. */
export async function getGameNames(env: Env, accessToken: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const url = new URL(`${API_BASE}/games`);
  for (const id of ids.slice(0, 100)) url.searchParams.append("id", id);
  const res = await check(await fetch(url, { headers: helixHeaders(env, accessToken) }), "Get Games");
  for (const g of ((await res.json()) as { data: { id: string; name: string }[] }).data) out.set(g.id, g.name);
  return out;
}

/**
 * Create Clip: captures the live stream (up to the last ~90s), then publishes `duration` seconds
 * of it. Needs a user token with clips:edit. Asynchronous: the clip appears in Get Clips a few
 * seconds later. The channel must be live.
 */
export async function createClip(
  env: Env,
  accessToken: string,
  broadcasterId: string,
  opts: { title?: string; duration?: number },
): Promise<{ id: string; edit_url: string }> {
  const url = new URL(`${API_BASE}/clips`);
  url.searchParams.set("broadcaster_id", broadcasterId);
  if (opts.title) url.searchParams.set("title", opts.title);
  if (opts.duration) url.searchParams.set("duration", String(opts.duration));
  const res = await check(await fetch(url, { method: "POST", headers: helixHeaders(env, accessToken) }), "Create Clip");
  return ((await res.json()) as { data: { id: string; edit_url: string }[] }).data[0];
}

export async function getClip(env: Env, accessToken: string, id: string): Promise<Clip | null> {
  const url = `${API_BASE}/clips?id=${encodeURIComponent(id)}`;
  const res = await check(await fetch(url, { headers: helixHeaders(env, accessToken) }), "Get Clips");
  return ((await res.json()) as { data: Clip[] }).data[0] ?? null;
}

export async function getGameName(env: Env, accessToken: string, id: string): Promise<string | null> {
  const url = `${API_BASE}/games?id=${encodeURIComponent(id)}`;
  const res = await check(await fetch(url, { headers: helixHeaders(env, accessToken) }), "Get Games");
  return ((await res.json()) as { data: { name: string }[] }).data[0]?.name ?? null;
}

/** Pages through a Helix list endpoint (100 per page, at most maxPages pages). */
async function allPages<T>(env: Env, accessToken: string, url: URL, what: string, maxPages: number): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  url.searchParams.set("first", "100");
  for (let page = 0; page < maxPages; page++) {
    if (cursor) url.searchParams.set("after", cursor);
    const res = await check(await fetch(url, { headers: helixHeaders(env, accessToken) }), what);
    const body = (await res.json()) as { data: T[]; pagination?: { cursor?: string } };
    out.push(...body.data);
    cursor = body.pagination?.cursor;
    if (!cursor) break;
  }
  return out;
}

/** Channels the user follows, most recently followed first. Needs user:read:follows. */
export function getFollowedChannels(
  env: Env,
  accessToken: string,
  userId: string,
): Promise<{ broadcaster_id: string; broadcaster_login: string; broadcaster_name: string }[]> {
  const url = new URL(`${API_BASE}/channels/followed`);
  url.searchParams.set("user_id", userId);
  return allPages(env, accessToken, url, "Get Followed Channels", 20);
}

/** Live streams among the channels the user follows. Needs user:read:follows. */
export function getFollowedStreams(
  env: Env,
  accessToken: string,
  userId: string,
): Promise<(StreamInfo & { user_login: string; user_name: string })[]> {
  const url = new URL(`${API_BASE}/streams/followed`);
  url.searchParams.set("user_id", userId);
  return allPages(env, accessToken, url, "Get Followed Streams", 5);
}
