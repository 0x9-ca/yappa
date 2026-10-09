import { verifyAccess } from "./access";
import { renderPage } from "./page";
import { staticFiles } from "./static";
import { authorizeUrl } from "./twitch";

export { ColorLoop } from "./color-loop";

const STATE_COOKIE = "twitch_oauth_state";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
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
  const file = request.method === "GET" ? staticFiles[url.pathname] : undefined;
  if (file) {
    return new Response(file.body, { headers: { "Content-Type": file.type, "Cache-Control": file.cache } });
  }

  const redirectUri = `${url.origin}/auth/callback`;
  const stub = await currentStub(env, user);

  // Cross-site form/fetch protection for state-changing requests.
  if (request.method === "POST" && request.headers.get("Origin") !== url.origin) {
    return new Response("Bad origin", { status: 403 });
  }

  switch (`${request.method} ${url.pathname}`) {
    case "GET /":
      return new Response(renderPage(user), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
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
      if (!broadcasterId || !["delete", "clear", "ban", "timeout", "unban", "pin", "unpin"].includes(action as string)) {
        return json({ ok: false, error: "Bad moderation request." }, 400);
      }
      const login = str(body.login)?.replace(/^@/, "").toLowerCase();
      const result = await stub.chatMod(broadcasterId, action as "delete" | "clear" | "ban" | "timeout" | "unban" | "pin" | "unpin", {
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

    case "GET /api/chat/pin": {
      const id = url.searchParams.get("broadcaster_id");
      if (!id) return json({ ok: false, error: "Missing broadcaster_id." }, 400);
      const result = await stub.chatPinned(id);
      return json(result, result.ok ? 200 : 502);
    }

    case "GET /api/chat/badges": {
      const id = url.searchParams.get("broadcaster_id");
      if (!id) return json({}, 400);
      return json(await stub.chatBadges(id));
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
        return json({ ok: false, error: "The server is updating; try again in a minute.", retry: true }, 503);
      }
      console.error(err);
      return json({ ok: false, error: message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/** Gets the user's Durable Object, first restarting it if it's still on an older deploy. */
async function currentStub(env: Env, user: string) {
  try {
    await env.COLOR_LOOP.getByName(user).syncVersion(env.CF_VERSION_METADATA.timestamp);
  } catch {
    // Either it just restarted itself (a fresh stub reaches the new instance), or it
    // predates syncVersion; both are fine to continue past.
  }
  return env.COLOR_LOOP.getByName(user);
}

function redirectHome(setCookie: string, error?: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: error ? `/?error=${encodeURIComponent(error)}` : "/", "Set-Cookie": setCookie },
  });
}
