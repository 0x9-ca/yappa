import { verifyAccess } from "./access";
import * as publicApi from "./app-token";
import { renderMoved } from "./moved";
import { PAGE_HEADERS, renderPage } from "./page";
import { staticFiles } from "./static";
import { relayMaster } from "./usher";
import { PAGE_SIZE, parseClipsQuery, parseCreateClip, parseOffset, parseVideosQuery } from "./browse";
import { authorizeUrl } from "./twitch";

export { ColorLoop } from "./color-loop";

const STATE_COOKIE = "twitch_oauth_state";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

/** A lookup's result, or a 502 the client can tell apart from a genuinely empty answer. */
function orFail(data: unknown): Response {
  return data === null ? json({ ok: false, error: "Couldn't reach Twitch." }, 502) : json(data);
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

async function handle(request: Request, env: Env): Promise<Response> {
  const user = await verifyAccess(request, env);
  if (!user) return new Response("Forbidden", { status: 403 });

  const url = new URL(request.url);
  // The old address: send the page (only) to the new one. API calls keep working so
  // already-open copies of the app don't break mid-session.
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1"; // wrangler dev
  if (env.APP_HOST && !isLocal && url.hostname !== env.APP_HOST && request.method === "GET" && url.pathname === "/") {
    return new Response(renderMoved(env.APP_HOST), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" },
    });
  }
  const file = request.method === "GET" ? staticFiles[url.pathname] : undefined;
  if (file) {
    return new Response(file.body, { headers: { "Content-Type": file.type, "Cache-Control": file.cache } });
  }

  // Cross-site form/fetch protection for state-changing requests.
  if (request.method === "POST" && request.headers.get("Origin") !== url.origin) {
    return new Response("Bad origin", { status: 403 });
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
    // The native player's quality list (see src/usher.ts). No Durable Object needed.
    case "POST /api/hls/master": {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const result = await relayMaster(body);
      return json(result, result.ok ? 200 : result.status);
    }
  }

  const redirectUri = `${url.origin}/auth/callback`;
  const stub = await currentStub(env, user, url.pathname === "/");

  switch (`${request.method} ${url.pathname}`) {
    case "GET /":
      return new Response(renderPage(user), {
        headers: { ...PAGE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });

    case "GET /auth/login": {
      const state = crypto.randomUUID();
      return new Response(null, {
        status: 302,
        headers: {
          Location: authorizeUrl(env.TWITCH_CLIENT_ID, redirectUri, state),
          "Set-Cookie": `${STATE_COOKIE}=${state}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        },
      });
    }

    case "GET /auth/callback": {
      const clear = `${STATE_COOKIE}=; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (url.searchParams.get("error")) {
        return redirectHome(clear, url.searchParams.get("error_description") ?? "Authorization denied");
      }
      if (!state || !code || state !== getCookie(request, STATE_COOKIE)) {
        return redirectHome(clear, "OAuth state mismatch; try again.");
      }
      try {
        await stub.connectTwitch(code, redirectUri);
      } catch (err) {
        return redirectHome(clear, (err as Error).message);
      }
      return redirectHome(clear);
    }

    case "POST /auth/logout":
      await stub.disconnectTwitch();
      return json({ ok: true });

    case "GET /api/following":
      return json(await stub.followed(url.searchParams.has("fresh")));

    case "GET /api/status":
      return json(await stub.status());

    case "POST /api/cycle": {
      const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
      return json({ ok: true, cycle: await stub.setCycle(body.enabled === true) });
    }

    case "POST /api/chat/subscribe": {
      const body = (await request.json().catch(() => ({}))) as { channel?: unknown; session_id?: unknown };
      const channel = parseChannel(body.channel);
      if (!channel) return json({ ok: false, error: "Enter a valid channel name." }, 400);
      if (typeof body.session_id !== "string") return json({ ok: false, error: "Missing session_id." }, 400);
      const result = await stub.chatSubscribe(channel, body.session_id);
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

function redirectHome(setCookie: string, error?: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: error ? `/?error=${encodeURIComponent(error)}` : "/", "Set-Cookie": setCookie },
  });
}
