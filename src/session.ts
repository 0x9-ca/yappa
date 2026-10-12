/**
 * Yappa's own sign-in: after Twitch OAuth proves who someone is and their login is on the
 * allowlist, they get a signed cookie. The cookie holds only the Twitch user id, login and an
 * expiry, signed with SESSION_SECRET; the Twitch tokens stay in that user's Durable Object.
 */
export const SESSION_COOKIE = "__Host-yappa_session";
const MAX_AGE_S = 30 * 86400;
const enc = new TextEncoder();

export interface Session {
  uid: string;
  login: string;
  exp: number; // ms since epoch
}

const b64 = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmacKey(env: Env): Promise<CryptoKey> {
  const secret = env.SESSION_SECRET;
  if (typeof secret !== "string" || secret.length < 32) throw new Error("SESSION_SECRET must be set to at least 32 characters.");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signSession(env: Env, uid: string, login: string, now = Date.now()): Promise<string> {
  const payload = b64(enc.encode(JSON.stringify({ u: uid, l: login, e: now + MAX_AGE_S * 1000 })));
  return payload + "." + b64(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(payload)));
}

/** The session in the request's cookie, or null if it's missing, forged, malformed or expired. */
export async function readSession(request: Request, env: Env, now = Date.now()): Promise<Session | null> {
  const header = request.headers.get("Cookie") ?? "";
  let token: string | undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) token = v.join("=");
  }
  const dot = token?.indexOf(".") ?? -1;
  if (!token || dot < 1) return null;
  try {
    const payload = token.slice(0, dot);
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(env), unb64(token.slice(dot + 1)), enc.encode(payload)))) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64(payload))) as { u?: unknown; l?: unknown; e?: unknown };
    if (typeof p.u !== "string" || typeof p.l !== "string" || typeof p.e !== "number" || p.e <= now) return null;
    return { uid: p.u, login: p.l, exp: p.e };
  } catch {
    return null;
  }
}

export const sessionCookie = (token: string): string =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE_S}`;
export const clearSessionCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/**
 * Whether this Twitch account may use the app. ALLOWED_LOGINS is a comma- or space-separated
 * list of Twitch logins and/or numeric user ids (an id can't be taken over by someone who
 * later claims a renamed login). An empty list allows nobody.
 */
export function isAllowed(env: Env, uid: string, login: string): boolean {
  const list = String(env.ALLOWED_LOGINS ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
  return list.includes(login.toLowerCase()) || list.includes(uid);
}
