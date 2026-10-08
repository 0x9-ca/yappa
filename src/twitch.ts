const ID_BASE = "https://id.twitch.tv/oauth2";
const API_BASE = "https://api.twitch.tv/helix";

export const SCOPES = ["user:manage:chat_color"];

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
    scope: SCOPES.join(" "),
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
