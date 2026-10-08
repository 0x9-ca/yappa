const ID_BASE = "https://id.twitch.tv/oauth2";
const API_BASE = "https://api.twitch.tv/helix";

/** Scopes the app can't work without. */
export const SCOPES = ["user:manage:chat_color", "user:read:chat", "user:write:chat"];
/** Nice-to-have scopes: requested at login, but older tokens without them still work. */
export const OPTIONAL_SCOPES = ["user:read:emotes"];

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
): Promise<void> {
  await check(
    await fetch(`${API_BASE}/eventsub/subscriptions`, {
      method: "POST",
      headers: { ...helixHeaders(env, accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({ type, version: "1", condition, transport: { method: "websocket", session_id: sessionId } }),
    }),
    `Subscribe to ${type}`,
  );
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
  versions: { id: string; image_url_1x: string; image_url_2x: string; title: string }[];
}

/** Returns "set_id/version" -> {url, title}, channel badges overriding global ones. */
export async function getBadges(
  env: Env,
  accessToken: string,
  broadcasterId: string,
): Promise<Record<string, { url: string; title: string }>> {
  const headers = helixHeaders(env, accessToken);
  const [global, channel] = await Promise.all(
    [`${API_BASE}/chat/badges/global`, `${API_BASE}/chat/badges?broadcaster_id=${encodeURIComponent(broadcasterId)}`].map(
      async (url) => ((await (await check(await fetch(url, { headers }), "Get Chat Badges")).json()) as { data: BadgeSet[] }).data,
    ),
  );
  const out: Record<string, { url: string; title: string }> = {};
  for (const set of [...global, ...channel]) {
    for (const v of set.versions) out[`${set.set_id}/${v.id}`] = { url: v.image_url_2x, title: v.title };
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
