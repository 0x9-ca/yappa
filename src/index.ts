import * as publicApi from "./app-token";
import { renderMoved } from "./moved";
import { PAGE_HEADERS, renderLogin, renderPage } from "./page";
import { clearSessionCookie, isAllowed, readSession, sessionCookie, signSession } from "./session";
import { staticFiles } from "./static";
import { relayMaster } from "./usher";
import { parseSync } from "./sync";
import { fetchX, parseXId } from "./previews";
import { parseAnnounce, parseBlock, parseBroadcaster, parseShield, parseShoutout, parseSuspicious, parseTerm, parseTermRemove, parseUnbanResolve, parseSearch, parseTop, parseWarn, parseWhisper } from "./tools";
import { PAGE_SIZE, parseClipsQuery, parseCreateClip, parseOffset, parseVideosQuery } from "./browse";
import { authorizeUrl, exchangeCode, revokeToken, validateToken } from "./twitch";

export { ColorLoop } from "./color-loop";

const STATE_COOKIE = "twitch_oauth_state";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

/** A lookup's result, or a 502 the client can tell apart from a genuinely empty answer. */
function orFail(data: unknown): Response {
  return data === null ? json({ ok: false, error: "Couldn't reach Twitch." }, 502) : json(data);
}

/** A tool's result: 403 for a missing permission (the page offers a reconnect), 502 for Twitch refusing. */
function toolResult(r: { ok: boolean; needsScope?: boolean }): Response {
  return json(r, r.ok ? 200 : r.needsScope ? 403 : 502);
}

function getCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
}

/** Accepts "name", "#name", "@name" or a twitch.tv URL; returns a lowercase login or null. */
function parseChannel(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim().replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "").replace(/^[#@]/, "");
  s = s.split(/[/?#]/)[0].toLowerCase();
  return /^[a-z0-9_]{1,25}$/.test(s) ? s : null;
}

const HTML_HEADERS = { ...PAGE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // The old address: send the page (only) to the new one. API calls keep working so
  // already-open copies of the app don't break mid-session.
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1"; // wrangler dev
  if (env.APP_HOST && !isLocal && url.hostname !== env.APP_HOST && request.method === "GET" && url.pathname === "/") {
    return new Response(renderMoved(env.APP_HOST), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" },
    });
  }
  // The app's own files hold no secrets and no data, so they're public (the manifest and
  // service worker are fetched without the page's cookies in some browsers).
  const file = request.method === "GET" ? staticFiles[url.pathname] : undefined;
  if (file) {
    return new Response(file.body, { headers: { "Content-Type": file.type, "Cache-Control": file.cache } });
  }

  // Cross-site form/fetch protection for state-changing requests.
  if (request.method === "POST" && request.headers.get("Origin") !== url.origin) {
    return new Response("Bad origin", { status: 403 });
  }

  const redirectUri = `${url.origin}/auth/callback`;

  // Signing in doesn't need a session (it creates one).
  if (request.method === "GET" && url.pathname === "/auth/login") {
    const state = crypto.randomUUID();
    return new Response(null, {
      status: 302,
      headers: {
        Location: authorizeUrl(env.TWITCH_CLIENT_ID, redirectUri, state),
        "Set-Cookie": `${STATE_COOKIE}=${state}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/auth/callback") return handleCallback(request, env, url, redirectUri);
  if (request.method === "POST" && url.pathname === "/auth/logout") {
    const session = await readSession(request, env);
    if (session) await (await currentStub(env, session.uid, false)).disconnectTwitch();
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": clearSessionCookie },
    });
  }

  // Everything else is for allowed, signed-in users only. The allowlist is checked on every
  // request, so removing a login from it ends that person's access immediately.
  const session = await readSession(request, env);
  if (!session || !isAllowed(env, session.uid, session.login)) {
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(renderLogin(url.searchParams.get("error")), { headers: HTML_HEADERS });
    }
    return json({ ok: false, error: "Sign in again.", signedOut: true }, 401);
  }

  // Public Twitch data: answered with the app token, without waking the user's Durable Object.
  switch (`${request.method} ${url.pathname}`) {
    case "GET /api/streams": {
      const ids = (url.searchParams.get("ids") ?? "").split(",").filter((x) => /^\d+$/.test(x)).slice(0, 100);
      return orFail(await publicApi.streams(env, url.origin, ids));
    }
    case "GET /api/chat/cheermotes": {
      const id = url.searchParams.get("broadcaster_id");
      if (!id) return json({ ok: false, error: "Missing broadcaster_id." }, 400);
      return orFail(await publicApi.cheermotes(env, url.origin, id));
    }
    case "GET /api/chat/badges": {
      const id = url.searchParams.get("broadcaster_id");
      if (!id) return json({ ok: false, error: "Missing broadcaster_id." }, 400);
      return orFail(await publicApi.badges(env, url.origin, id));
    }
    case "GET /api/chat/clip": {
      const id = url.searchParams.get("id") ?? "";
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return json({ ok: false, error: "Bad clip id." }, 400);
      const result = await publicApi.clip(env, url.origin, id);
      return json(result, result.ok ? 200 : 502);
    }
    // Browsing a channel's clips and VODs: public data, answered with the app token.
    case "GET /api/channel/clips": {
      const q = parseClipsQuery(url.searchParams);
      if (typeof q === "string") return json({ ok: false, error: q }, 400);
      return orFail(await publicApi.clipsPage(env, url.origin, q));
    }
    case "GET /api/channel/videos": {
      const q = parseVideosQuery(url.searchParams);
      if (typeof q === "string") return json({ ok: false, error: q }, 400);
      return orFail(await publicApi.videosPage(env, url.origin, q));
    }
    // Discovery: public data, answered with the app token.
    case "GET /api/discover/search": {
      const q = parseSearch(url.searchParams);
      return typeof q === "string" ? json({ ok: false, error: q }, 400) : orFail(await publicApi.searchChannelsFor(env, url.origin, q));
    }
    case "GET /api/discover/categories": {
      const q = parseSearch(url.searchParams);
      return typeof q === "string" ? json({ ok: false, error: q }, 400) : orFail(await publicApi.categoriesFor(env, url.origin, q.q));
    }
    case "GET /api/discover/top": {
      const q = parseTop(url.searchParams);
      return typeof q === "string" ? json({ ok: false, error: q }, 400) : orFail(await publicApi.topStreamsFor(env, url.origin, q.gameId, q.after));
    }
    case "GET /api/schedule": {
      const id = url.searchParams.get("broadcaster_id") ?? "";
      return /^\d{1,20}$/.test(id) ? orFail(await publicApi.scheduleFor(env, url.origin, id)) : json({ ok: false, error: "Bad broadcaster_id." }, 400);
    }
    // Preview card for an X/Twitter post linked in chat (see src/previews.ts).
    case "GET /api/preview/x": {
      const id = parseXId(url.searchParams.get("id"));
      if (!id) return json({ ok: false, error: "Bad post id." }, 400);
      const r = await fetchX(id);
      return json(r, r.ok ? 200 : r.status);
    }
    // The native player's quality list (see src/usher.ts). No Durable Object needed.
    case "POST /api/hls/master": {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const result = await relayMaster(body);
      return json(result, result.ok ? 200 : result.status);
    }
  }

  if (request.method === "GET" && url.pathname === "/") {
    // Renewing the cookie on every page load keeps a regularly used sign-in from ever expiring.
    // The page itself needs nothing from the user's Durable Object, so it isn't kept waiting for it.
    return new Response(renderPage(), {
      headers: { ...HTML_HEADERS, "Set-Cookie": sessionCookie(await signSession(env, session.uid, session.login)) },
    });
  }

  // The first status call of a page load (it carries ?sync) makes sure the Durable Object runs this
  // deploy's code before anything else is asked of it.
  const stub = await currentStub(env, session.uid, url.pathname === "/api/status" && url.searchParams.has("sync"));

  switch (`${request.method} ${url.pathname}`) {

    case "GET /api/following":
      return json(await stub.followed(url.searchParams.has("fresh")));

    case "GET /api/sync":
      return json({ ok: true, sync: await stub.getSync() });

    case "POST /api/sync": {
      const blob = parseSync(await request.json().catch(() => null));
      if (typeof blob === "string") return json({ ok: false, error: blob }, 400);
      return json(await stub.putSync(blob));
    }

    case "GET /api/status":
      // The first call after opening the app also carries the account's synced settings, saving a round trip.
      if (url.searchParams.has("sync")) {
        const [status, sync] = await Promise.all([stub.status(), stub.getSync()]);
        return json({ ...status, sync });
      }
      return json(await stub.status());

    case "POST /api/cycle": {
      const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
      return json({ ok: true, cycle: await stub.setCycle(body.enabled === true) });
    }

    case "POST /api/chat/subscribe": {
      const body = (await request.json().catch(() => ({}))) as { channel?: unknown; session_id?: unknown; mod_log?: unknown };
      const channel = parseChannel(body.channel);
      if (!channel) return json({ ok: false, error: "Enter a valid channel name." }, 400);
      if (typeof body.session_id !== "string") return json({ ok: false, error: "Missing session_id." }, 400);
      const result = await stub.chatSubscribe(channel, body.session_id, { modLog: body.mod_log === true });
      return json(result, result.ok ? 200 : 502);
    }

    case "POST /api/chat/send": {
      const body = (await request.json().catch(() => ({}))) as {
        broadcaster_id?: unknown;
        message?: unknown;
        reply_parent_message_id?: unknown;
      };
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (typeof body.broadcaster_id !== "string" || !message || message.length > 500) {
        return json({ ok: false, error: "Message must be 1–500 characters." }, 400);
      }
      const reply = typeof body.reply_parent_message_id === "string" ? body.reply_parent_message_id : undefined;
      const result = await stub.chatSend(body.broadcaster_id, message, reply);
      return json(result, result.ok ? 200 : 502);
    }

    case "POST /api/whispers/subscribe": {
      const body = (await request.json().catch(() => ({}))) as { session_id?: unknown };
      if (typeof body.session_id !== "string") return json({ ok: false, error: "Missing session_id." }, 400);
      return json(await stub.whisperSubscribe(body.session_id));
    }

    case "POST /api/chat/unsubscribe": {
      const body = (await request.json().catch(() => ({}))) as { ids?: unknown };
      const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
      await stub.chatUnsubscribe(ids);
      return json({ ok: true });
    }

    case "POST /api/chat/mod": {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      const action = body.action;
      const broadcasterId = str(body.broadcaster_id);
      if (!broadcasterId || !["delete", "clear", "ban", "timeout", "unban"].includes(action as string)) {
        return json({ ok: false, error: "Bad moderation request." }, 400);
      }
      const login = str(body.login)?.replace(/^@/, "").toLowerCase();
      const result = await stub.chatMod(broadcasterId, action as "delete" | "clear" | "ban" | "timeout" | "unban", {
        userId: str(body.user_id),
        login,
        messageId: str(body.message_id),
        duration: typeof body.duration === "number" ? body.duration : undefined,
        reason: str(body.reason)?.slice(0, 500),
      });
      return json(result, result.ok ? 200 : 502);
    }

    case "GET /api/chat/emotes": {
      const id = url.searchParams.get("broadcaster_id");
      if (!id) return json({ ok: false, error: "Missing broadcaster_id." }, 400);
      return json(await stub.chatEmotes(id));
    }

    case "GET /api/chat/user": {
      const b = url.searchParams.get("broadcaster_id"), u = url.searchParams.get("user_id");
      if (!b || !u) return json({ ok: false, error: "Missing broadcaster_id or user_id." }, 400);
      const result = await stub.userCard(b, u);
      return json(result, result.ok ? 200 : 502);
    }

    case "POST /api/chat/automod": {
      const body = (await request.json().catch(() => ({}))) as { msg_id?: unknown; allow?: unknown };
      if (typeof body.msg_id !== "string") return json({ ok: false, error: "Missing msg_id." }, 400);
      const result = await stub.automodAction(body.msg_id, body.allow === true);
      return json(result, result.ok ? 200 : 502);
    }

    case "POST /api/chat/settings": {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.broadcaster_id !== "string") return json({ ok: false, error: "Missing broadcaster_id." }, 400);
      // Only pass through known setting fields with the right types.
      const patch: Record<string, unknown> = {};
      for (const k of ["slow_mode", "follower_mode", "subscriber_mode", "emote_mode", "unique_chat_mode"]) {
        if (typeof body[k] === "boolean") patch[k] = body[k];
      }
      for (const k of ["slow_mode_wait_time", "follower_mode_duration"]) {
        if (typeof body[k] === "number" && Number.isFinite(body[k])) patch[k] = body[k];
      }
      const result = await stub.updateSettings(body.broadcaster_id, patch);
      return json(result, result.ok ? 200 : 502);
    }

    // Clips this user made through Yappa (Twitch can't list them by creator), with fresh details.
    case "GET /api/my/clips": {
      const offset = parseOffset(url.searchParams);
      if (typeof offset === "string") return json({ ok: false, error: offset }, 400);
      const page = await stub.myClips(offset, PAGE_SIZE);
      if (!page.ids.length) return json({ ok: true, clips: [], cursor: null });
      const clips = await publicApi.clipsByIds(env, url.origin, page.ids);
      if (clips === null) return json({ ok: false, error: "Couldn't reach Twitch." }, 502);
      const next = offset + page.ids.length;
      return json({ ok: true, clips, cursor: next < page.total ? String(next) : null });
    }

    // Creating a clip needs the user's own token, so it goes through their Durable Object.
    case "POST /api/clips/create": {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const req = parseCreateClip(body);
      if (typeof req === "string") return json({ ok: false, error: req }, 400);
      const result = await stub.createClip(req.broadcasterId, { title: req.title, duration: req.duration });
      return json(result, result.ok ? 200 : result.needsScope ? 403 : 502);
    }

    // Moderator tools: the channel is named by the page, Twitch checks that you moderate it.
    case "POST /api/mod/announce": {
      const r = parseAnnounce((await request.json().catch(() => ({}))) as Record<string, unknown>);
      return typeof r === "string" ? json({ ok: false, error: r }, 400) : toolResult(await stub.announce(r.broadcasterId, r.message, r.color));
    }
    case "POST /api/mod/shoutout": {
      const r = parseShoutout((await request.json().catch(() => ({}))) as Record<string, unknown>);
      return typeof r === "string" ? json({ ok: false, error: r }, 400) : toolResult(await stub.shoutout(r.broadcasterId, r.toLogin));
    }
    case "POST /api/mod/warn": {
      const r = parseWarn((await request.json().catch(() => ({}))) as Record<string, unknown>);
      return typeof r === "string" ? json({ ok: false, error: r }, 400) : toolResult(await stub.warn(r.broadcasterId, r.userId, r.reason));
    }
    case "GET /api/mod/terms": {
      const id = parseBroadcaster(url.searchParams);
      return id ? toolResult(await stub.blockedTerms(id)) : json({ ok: false, error: "Bad broadcaster_id." }, 400);
    }
    case "POST /api/mod/terms": {
      const r = parseTerm((await request.json().catch(() => ({}))) as Record<string, unknown>);
      return typeof r === "string" ? json({ ok: false, error: r }, 400) : toolResult(await stub.addTerm(r.broadcasterId, r.text));
    }
    case "POST /api/mod/terms/remove": {
      const r = parseTermRemove((await request.json().catch(() => ({}))) as Record<string, unknown>);
      return typeof r === "string" ? json({ ok: false, error: r }, 400) : toolResult(await stub.removeTerm(r.broadcasterId, r.id));
    }
    case "GET /api/mod/shield": {
      const id = parseBroadcaster(url.searchParams);
      return id ? toolResult(await stub.shield(id)) : json({ ok: false, error: "Bad broadcaster_id." }, 400);
    }
    case "POST /api/mod/shield": {
      const r = parseShield((await request.json().catch(() => ({}))) as Record<string, unknown>);
      return typeof r === "string" ? json({ ok: false, error: r }, 400) : toolResult(await stub.setShield(r.broadcasterId, r.active));
    }
    case "POST /api/mod/suspicious": {
      const r = parseSuspicious((await request.json().catch(() => ({}))) as Record<string, unknown>);
      return typeof r === "string" ? json({ ok: false, error: r }, 400) : toolResult(await stub.suspicious(r.broadcasterId, r.userId, r.status));
    }
    case "GET /api/mod/unbans": {
      const id = parseBroadcaster(url.searchParams);
      return id ? toolResult(await stub.unbanRequests(id)) : json({ ok: false, error: "Bad broadcaster_id." }, 400);
    }
    case "POST /api/mod/unbans": {
      const r = parseUnbanResolve((await request.json().catch(() => ({}))) as Record<string, unknown>);
      return typeof r === "string" ? json({ ok: false, error: r }, 400) : toolResult(await stub.resolveUnban(r.broadcasterId, r.id, r.status, r.text));
    }
    case "GET /api/mod/chatters": {
      const id = parseBroadcaster(url.searchParams);
      return id ? toolResult(await stub.chatters(id)) : json({ ok: false, error: "Bad broadcaster_id." }, 400);
    }
    // Personal tools.
    case "GET /api/sub": {
      const id = parseBroadcaster(url.searchParams);
      return id ? toolResult(await stub.subscription(id)) : json({ ok: false, error: "Bad broadcaster_id." }, 400);
    }
    case "GET /api/blocks":
      return toolResult(await stub.blockedUsers());
    case "POST /api/blocks": {
      const r = parseBlock((await request.json().catch(() => ({}))) as Record<string, unknown>);
      return typeof r === "string" ? json({ ok: false, error: r }, 400) : toolResult(await stub.block(r.userId, r.block));
    }
    case "POST /api/whisper": {
      const r = parseWhisper((await request.json().catch(() => ({}))) as Record<string, unknown>);
      return typeof r === "string" ? json({ ok: false, error: r }, 400) : toolResult(await stub.whisper(r.userId, r.message));
    }

    case "POST /api/cycle/bump": {
      const body = (await request.json().catch(() => ({}))) as { message_id?: unknown };
      const messageId = typeof body.message_id === "string" && body.message_id ? body.message_id.slice(0, 100) : undefined;
      return json({ ok: true, cycle: await stub.cycleBump(messageId) });
    }

  }

  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      // Right after a deploy the Durable Object can briefly still run the previous version.
      if (message.includes("does not implement the method")) {
        synced.clear(); // check again next time
        return json({ ok: false, error: "The server is updating; try again in a minute.", retry: true }, 503);
      }
      console.error(err);
      return json({ ok: false, error: message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

// Users whose Durable Object this isolate has already brought up to its own version. An
// object can't fall back to older code, so each isolate needs to check only once per user
// (new isolates start empty after every deploy).
const synced = new Set<string>();

/**
 * Gets the user's Durable Object, first restarting it if it's still on an older deploy.
 * Checks on every page load, and otherwise once per isolate per user.
 */
async function currentStub(env: Env, user: string, pageLoad: boolean) {
  if (pageLoad || !synced.has(user)) {
    try {
      await env.COLOR_LOOP.getByName(user).syncVersion(env.CF_VERSION_METADATA.timestamp);
      synced.add(user);
    } catch {
      // Either it just restarted itself (a fresh stub reaches the new instance), or it
      // predates syncVersion; both are fine to continue past.
    }
  }
  return env.COLOR_LOOP.getByName(user);
}

/** Back to the front page with a short error code (never free text: it's shown on the page). */
function redirectHome(setCookie: string, error: string): Response {
  return new Response(null, { status: 302, headers: { Location: `/?error=${error}`, "Set-Cookie": setCookie } });
}

/** Twitch sends the browser back here after sign-in. Only the Worker ever sees the code and tokens. */
async function handleCallback(request: Request, env: Env, url: URL, redirectUri: string): Promise<Response> {
  const clearState = `${STATE_COOKIE}=; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  const fail = (code: string) => redirectHome(clearState, code);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error")) return fail("cancelled");
  if (!state || !code || state !== getCookie(request, STATE_COOKIE)) return fail("state");
  let tok;
  let info;
  try {
    tok = await exchangeCode(env, code, redirectUri);
    info = await validateToken(tok.access_token);
  } catch (err) {
    console.error("sign-in failed", (err as Error).message);
    return fail("failed");
  }
  if (!isAllowed(env, info.user_id, info.login)) {
    await revokeToken(env, tok.access_token).catch(() => {}); // nothing is kept for anyone not on the list
    console.log(JSON.stringify({ event: "sign-in refused" }));
    return fail("denied");
  }
  await (await currentStub(env, info.user_id, true)).storeTokens(tok, info);
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", clearState);
  headers.append("Set-Cookie", sessionCookie(await signSession(env, info.user_id, info.login)));
  return new Response(null, { status: 302, headers });
}
