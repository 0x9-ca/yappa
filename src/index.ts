import { verifyAccess } from "./access";
import { renderPage } from "./page";
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

export default {
  async fetch(request, env): Promise<Response> {
    const user = await verifyAccess(request, env);
    if (!user) return new Response("Forbidden", { status: 403 });

    const url = new URL(request.url);
    const redirectUri = `${url.origin}/auth/callback`;
    const stub = env.COLOR_LOOP.getByName(user);

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

      case "POST /api/start": {
        const body = (await request.json().catch(() => ({}))) as { channel?: unknown };
        const channel = parseChannel(body.channel);
        if (!channel) return json({ ok: false, error: "Enter a valid channel name." }, 400);
        const result = await stub.start(channel);
        return json(result, result.ok ? 200 : 409);
      }

      case "POST /api/stop":
        await stub.stop();
        return json({ ok: true });

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

      case "GET /api/chat/badges": {
        const id = url.searchParams.get("broadcaster_id");
        if (!id) return json({}, 400);
        return json(await stub.chatBadges(id));
      }
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function redirectHome(setCookie: string, error?: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: error ? `/?error=${encodeURIComponent(error)}` : "/", "Set-Cookie": setCookie },
  });
}
