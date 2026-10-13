// Tests that need no browser: request checking, the usher relay, and the Worker itself
// (sign-in, sessions, allowlist, sync) run directly in Node with the Durable Object faked.
// Run with `npm run test:unit`; `npm test` runs these and then the browser tests.
import { loadBundles } from "./support.mjs";

const { worker, lib } = await loadBundles();
const { toolsLib, relayMaster, parseClipsQuery, parseVideosQuery, parseCreateClip, parseDuration, videoThumb, slimVideo, clipFailure } = lib;
let passed = 0, failed = 0;
const check = (label, cond, extra = "") => {
  cond ? passed++ : failed++;
  console.log((cond ? "PASS " : "FAIL ") + label + (extra && !cond ? "  → " + extra : ""));
};
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=6890302,RESOLUTION=1920x1080,VIDEO="chunked"\nhttps://video.test/chunked.m3u8\n';

// =============== moderator and personal tools: request checking ===============
{
  const T = toolsLib;
  check("announcement: 1-500 characters, known colors only", T.parseAnnounce({ broadcaster_id: "9", message: " hi  there ", color: "blue" }).message === "hi there" && T.parseAnnounce({ broadcaster_id: "9", message: "x" }).color === "primary" && typeof T.parseAnnounce({ broadcaster_id: "9", message: "" }) === "string" && typeof T.parseAnnounce({ broadcaster_id: "9", message: "x".repeat(501) }) === "string" && typeof T.parseAnnounce({ broadcaster_id: "9", message: "x", color: "red" }) === "string" && typeof T.parseAnnounce({ broadcaster_id: "abc", message: "x" }) === "string");
  check("shoutout target is cleaned up (name, @name, URL) or refused", T.parseShoutout({ broadcaster_id: "9", to_login: "@SomeChan" }).toLogin === "somechan" && T.parseShoutout({ broadcaster_id: "9", to_login: "https://www.twitch.tv/SomeChan/about" }).toLogin === "somechan" && typeof T.parseShoutout({ broadcaster_id: "9", to_login: "bad name" }) === "string");
  check("warning needs a reason (≤500) and numeric ids", T.parseWarn({ broadcaster_id: "9", user_id: "5", reason: "be nice" }).reason === "be nice" && typeof T.parseWarn({ broadcaster_id: "9", user_id: "5", reason: "  " }) === "string" && typeof T.parseWarn({ broadcaster_id: "9", user_id: "x", reason: "r" }) === "string");
  check("blocked term: 2-500 characters; removal needs a plain id", T.parseTerm({ broadcaster_id: "9", text: "spoiler" }).text === "spoiler" && typeof T.parseTerm({ broadcaster_id: "9", text: "a" }) === "string" && T.parseTermRemove({ broadcaster_id: "9", id: "abc-123" }).id === "abc-123" && typeof T.parseTermRemove({ broadcaster_id: "9", id: "a b" }) === "string");
  check("shield mode needs a real boolean; suspicious status is one of three", T.parseShield({ broadcaster_id: "9", active: true }).active === true && typeof T.parseShield({ broadcaster_id: "9", active: "yes" }) === "string" && T.parseSuspicious({ broadcaster_id: "9", user_id: "5", status: "RESTRICTED" }).status === "RESTRICTED" && T.parseSuspicious({ broadcaster_id: "9", user_id: "5", status: "NONE" }).status === "NONE" && typeof T.parseSuspicious({ broadcaster_id: "9", user_id: "5", status: "BANNED" }) === "string");
  check("unban answer: approved or denied, optional note ≤500", T.parseUnbanResolve({ broadcaster_id: "9", id: "r-1", status: "approved" }).status === "approved" && T.parseUnbanResolve({ broadcaster_id: "9", id: "r-1", status: "denied", text: "no" }).text === "no" && typeof T.parseUnbanResolve({ broadcaster_id: "9", id: "r-1", status: "maybe" }) === "string" && typeof T.parseUnbanResolve({ broadcaster_id: "9", id: "r-1", status: "denied", text: "x".repeat(501) }) === "string");
  check("whisper: 1-500 characters to a numeric id; block needs a boolean", T.parseWhisper({ user_id: "5", message: "hey" }).message === "hey" && typeof T.parseWhisper({ user_id: "5", message: "" }) === "string" && T.parseBlock({ user_id: "5", block: false }).block === false && typeof T.parseBlock({ user_id: "5" }) === "string");
  check("search and top-streams parameters are checked", T.parseSearch(new URLSearchParams("q=cats&live=1")).liveOnly === true && typeof T.parseSearch(new URLSearchParams("q=")) === "string" && typeof T.parseTop(new URLSearchParams("game_id=x")) === "string" && T.parseTop(new URLSearchParams("game_id=33214")).gameId === "33214");
  check("tool failures are explained in words", /Reconnect Twitch/.test(T.toolFailure("x", 401, "")) && /may not be a moderator/.test(T.toolFailure("send the announcement", 403, "")) && /rate limiting/.test(T.toolFailure("x", 429, "")) && T.slimUnban({ id: "1", user_id: "2", user_login: "l", user_name: "L", text: "t", created_at: "c", status: "pending" }).login === "l" && T.slimStreamRow({ user_id: "1", user_login: "a", user_name: "A", title: "t", game_name: "g", viewer_count: 5, started_at: "s", thumbnail_url: "https://x/{width}x{height}.jpg", language: "en" }).thumbnail === "https://x/320x180.jpg");
}


// =============== the usher relay ===============
{
  // Strict about its inputs, only ever talks to usher.
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return new Response(globalThis.__usherBody ?? MASTER, { status: globalThis.__usherStatus ?? 200 }); };
  const sig = "f9db5ddefa11ef4ea9e92a6cafaa1b6c3d52d387", tokenFor = (c) => JSON.stringify({ channel: c, authorization: { forbidden: false } });
  const bads = [
    relayMaster({ login: "../etc", sig, token: tokenFor("x") }), relayMaster({ login: "uwoslab", sig: "zz", token: tokenFor("uwoslab") }),
    relayMaster({ login: "uwoslab", sig, token: tokenFor("someoneelse") }), relayMaster({ login: "uwoslab", sig, token: "not json" }),
    relayMaster({ login: "uwoslab", sig, token: "x".repeat(9000) }), relayMaster({}),
  ];
  check("relay refuses bad channel names, signatures, tokens for another channel, and junk (without calling Twitch)", (await Promise.all(bads)).every((r) => r.ok === false && r.status === 400) && calls.length === 0, JSON.stringify(await Promise.all(bads)));
  const good = await relayMaster({ login: "UwoSlab", sig, token: tokenFor("uwoslab") });
  check("relay fetches only usher, for that channel, asking for audio-only too", good.ok && good.playlist.startsWith("#EXTM3U") && calls.length === 1 &&
    calls[0].startsWith("https://usher.ttvnw.net/api/channel/hls/uwoslab.m3u8?") && new URL(calls[0]).searchParams.get("allow_audio_only") === "true" && new URL(calls[0]).searchParams.get("sig") === sig, calls[0]);
  globalThis.__usherStatus = 403;
  const realErr = console.error; console.error = () => {}; // the relay logs refusals for the Worker's logs
  const denied = await relayMaster({ login: "uwoslab", sig, token: tokenFor("uwoslab") });
  console.error = realErr;
  check("relay reports Twitch refusing", denied.ok === false && denied.status === 502 && /403/.test(denied.error), JSON.stringify(denied));
  globalThis.__usherStatus = 200; globalThis.__usherBody = "<html>not a playlist</html>";
  check("relay rejects something that isn't a playlist", (await relayMaster({ login: "uwoslab", sig, token: tokenFor("uwoslab") })).ok === false);
  globalThis.fetch = realFetch; delete globalThis.__usherBody; delete globalThis.__usherStatus;

}

// =============== clips and VODs: request checking (pure functions) ===============
{
  const T = Date.UTC(2026, 9, 11, 12, 0, 0);
  const sp = (o) => new URLSearchParams(o);
  const cq = parseClipsQuery(sp({ broadcaster_id: "999", period: "week" }), T);
  check("clips query: a week = the last 7 days up to now; all-time sends no dates",
    cq.broadcasterId === "999" && cq.endedAt === new Date(T).toISOString() && cq.startedAt === new Date(T - 7 * 86400e3).toISOString() && parseClipsQuery(sp({ broadcaster_id: "999" }), T).startedAt === undefined, JSON.stringify(cq));
  check("clips query rejects bad ids, periods and cursors",
    ["../x", "", "12a"].every((id) => typeof parseClipsQuery(sp({ broadcaster_id: id })) === "string") && typeof parseClipsQuery(sp({ broadcaster_id: "1", period: "year" })) === "string" && typeof parseClipsQuery(sp({ broadcaster_id: "1", after: "a b;c" })) === "string" && typeof parseClipsQuery(sp({ broadcaster_id: "1", after: "eyJiIjp7fQ" })) === "object");
  check("videos query: defaults to past broadcasts newest first; validates the rest",
    JSON.stringify(parseVideosQuery(sp({ user_id: "5" }))) === '{"userId":"5","type":"archive","sort":"time"}' && typeof parseVideosQuery(sp({ user_id: "5", type: "clip" })) === "string" && typeof parseVideosQuery(sp({ user_id: "5", sort: "random" })) === "string" && typeof parseVideosQuery(sp({})) === "string");
  const cc = (o) => parseCreateClip(o);
  check("create-clip request: 5–60s to a tenth, title trimmed, everything else refused",
    cc({ broadcaster_id: "9", duration: 30.04, title: "  nice \n play  " }).duration === 30 && cc({ broadcaster_id: "9", duration: 30, title: "  nice \n play  " }).title === "nice play" && cc({ broadcaster_id: "9" }).duration === undefined &&
    [4.9, 61, NaN, "30", Infinity].every((d) => typeof cc({ broadcaster_id: "9", duration: d }) === "string") && typeof cc({ broadcaster_id: "9", title: "x".repeat(101) }) === "string" && typeof cc({ broadcaster_id: "x" }) === "string" && typeof cc({ broadcaster_id: "9", title: 5 }) === "string");
  check("video helpers: duration text → seconds, thumbnail template filled, in-progress has none",
    parseDuration("3h25m10s") === 12310 && parseDuration("45s") === 45 && parseDuration("2m") === 120 && parseDuration("") === 0 &&
    videoThumb("https://x/thumb-%{width}x%{height}.jpg") === "https://x/thumb-320x180.jpg" && videoThumb("") === null &&
    slimVideo({ id: "1", url: "u", title: "t", type: "archive", view_count: 3, created_at: "c", thumbnail_url: "https://x/%{width}x%{height}.jpg", duration: "1h1m1s" }).seconds === 3661);
  check("clip failures are explained in plain words", /isn't live/.test(clipFailure(404, "")) && /followers or subscribers/.test(clipFailure(403, "")) && /AutoMod/.test(clipFailure(400, "title failed AutoMod")));

}

// =============== sign-in and the allowlist (the Worker, run directly) ===============
{
  let syncSaved = null;
  const calls = { stored: [], disconnected: [], revoked: 0, names: [] };
  let twitchLogin = { user_id: "4242", login: "AllowedUser" };
  const env = {
    SESSION_SECRET: "s".repeat(48), ALLOWED_LOGINS: "alloweduser, 777", APP_HOST: "app.test", TWITCH_CLIENT_ID: "cid", TWITCH_CLIENT_SECRET: "sec",
    CF_VERSION_METADATA: { timestamp: "t" },
    COLOR_LOOP: { getByName: (name) => { calls.names.push(name); return {
      syncVersion: async () => {}, storeTokens: async (tok, info) => { calls.stored.push([name, info.login, tok.access_token]); }, disconnectTwitch: async () => { calls.disconnected.push(name); },
      status: async () => ({ ok: true, twitch: null }),
      getSync: async () => syncSaved, putSync: async (b) => { syncSaved = b; return { ok: true, stored: true, current: b }; },
    }; } },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    const url = String(u);
    if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: [], token_type: "bearer" });
    if (url.endsWith("/oauth2/validate")) return Response.json({ client_id: "cid", login: twitchLogin.login, user_id: twitchLogin.user_id, scopes: ["user:read:chat"], expires_in: 3600 });
    if (url.endsWith("/oauth2/revoke")) { calls.revoked++; return new Response(null, { status: 200 }); }
    return realFetch(u, init);
  };
  const req = (path, init = {}) => new Request("https://app.test" + path, init);
  const get = (path, cookie) => worker.default.fetch(req(path, { headers: cookie ? { Cookie: cookie } : {} }), env);
  const post = (path, cookie, origin = "https://app.test") => worker.default.fetch(req(path, { method: "POST", headers: { ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), "Content-Type": "application/json" }, body: "{}" }), env);
  const cookieOf = (res) => (res.headers.getSetCookie().find((c) => c.startsWith("__Host-yappa_session=")) || "").split(";")[0];
  const cb = (query, state = "st8") => get("/auth/callback?" + query, "twitch_oauth_state=" + state);

  // Signed out: only the sign-in page; no app, no data.
  let r = await get("/");
  let body = await r.text();
  check("signed out: the front page is just a sign-in page", r.status === 200 && body.includes("Sign in with Twitch") && !body.includes("/app.js") && !body.includes('id="chat"'));
  check("the sign-in page links to the self-hosting guide", /href="https:\/\/github\.com\/0x9-ca\/yappa\/blob\/main\/docs\/SELF-HOSTING\.md"/.test(body));
  r = await get("/api/status");
  check("signed out: the API answers 401 signedOut", r.status === 401 && (await r.json()).signedOut === true);
  r = await get("/api/streams?ids=1");
  check("signed out: even the public Twitch lookups need a sign-in", r.status === 401);
  r = await post("/api/chat/send");
  check("signed out: POSTs are refused too", r.status === 401);
  r = await post("/api/chat/send", "", null);
  check("a POST from another origin is refused outright", r.status === 403);
  r = await get("/app.js");
  check("the app's own files stay public (no secrets in them)", r.status === 200 && (await r.text()).length > 10000);
  r = await worker.default.fetch(new Request("https://old.test/"), env);
  check("the old address still forwards to the new one without a sign-in", r.status === 200 && (await r.text()).includes("app.test"));
  r = await get("/?error=" + encodeURIComponent("<script>alert(1)</script>"));
  body = await r.text();
  check("the front page never reflects free text from the URL", !body.includes("alert(1)") && !body.includes("&#60;script"));
  r = await get("/?error=denied");
  check("known error codes show a fixed message", (await r.text()).includes("isn&#39;t allowed"));

  r = await get("/auth/login");
  const loc = new URL(r.headers.get("Location"));
  check("sign-in sends you to Twitch with a state that is also in a cookie",
    r.status === 302 && loc.host === "id.twitch.tv" && loc.searchParams.get("redirect_uri") === "https://app.test/auth/callback" && (r.headers.get("Set-Cookie") || "").includes("twitch_oauth_state=" + loc.searchParams.get("state")));

  // An allowed account (login matching ignores case).
  r = await cb("code=abc&state=st8");
  const sess = cookieOf(r);
  check("allowed account: signed in, Twitch tokens kept in that account's Durable Object (named by Twitch id)",
    r.status === 302 && r.headers.get("Location") === "/" && !!sess && JSON.stringify(calls.stored) === '[["4242","AllowedUser","at"]]', JSON.stringify(calls.stored));
  check("the session cookie is host-locked, HttpOnly, Secure and SameSite", /^__Host-yappa_session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax/.test(r.headers.getSetCookie().find((c) => c.startsWith("__Host-")) || ""));
  r = await get("/api/status", sess);
  check("with the session the API answers, from the Durable Object of that Twitch id", r.status === 200 && calls.names.at(-1) === "4242");
  r = await get("/", sess);
  body = await r.text();
  check("with the session the front page is the app (and the cookie is renewed)", body.includes("/app.js") && !!cookieOf(r));

  // The cookie can't be forged, edited or reused after it expires.
  const [payload, sig] = sess.split("=")[1].split(".");
  const evil = btoa(JSON.stringify({ u: "999", l: "alloweduser", e: Date.now() + 1e9 })).replace(/=+$/, "");
  r = await get("/api/status", "__Host-yappa_session=" + evil + "." + sig);
  check("an edited cookie is refused", r.status === 401);
  r = await get("/api/status", "__Host-yappa_session=" + payload + ".AAAA");
  check("a cookie with a bad signature is refused", r.status === 401);
  r = await get("/api/status", "__Host-yappa_session=garbage");
  check("a malformed cookie is refused", r.status === 401);
  const old = "__Host-yappa_session=" + (await worker.signSession(env, "4242", "alloweduser", Date.now() - 31 * 86400e3));
  r = await get("/api/status", old);
  check("an expired cookie is refused", r.status === 401);
  const other = { ...env, SESSION_SECRET: "t".repeat(48) };
  r = await worker.default.fetch(req("/api/status", { headers: { Cookie: sess } }), other);
  check("a cookie signed with a different secret is refused", r.status === 401);
  const weak = await worker.signSession({ ...env, SESSION_SECRET: "short" }, "1", "a").then(() => "signed", () => "refused");
  check("a weak SESSION_SECRET is refused rather than used", weak === "refused");

  // Allowlist rules.
  check("allowlist: logins match any case, numeric ids match, others and an empty list don't",
    worker.isAllowed(env, "1", "ALLOWEDUSER") && worker.isAllowed(env, "777", "renamed") && !worker.isAllowed(env, "5", "stranger") && !worker.isAllowed({ ...env, ALLOWED_LOGINS: "" }, "4242", "alloweduser") && !worker.isAllowed({ ...env, ALLOWED_LOGINS: undefined }, "4242", "alloweduser"));
  r = await worker.default.fetch(req("/api/status", { headers: { Cookie: sess } }), { ...env, ALLOWED_LOGINS: "somebodyelse" });
  check("taking a login off the list ends its existing sessions at once", r.status === 401);

  // Someone not on the list.
  const storedBefore = calls.stored.length, revokedBefore = calls.revoked;
  twitchLogin = { user_id: "5", login: "stranger" };
  r = await cb("code=abc&state=st8");
  check("a stranger is refused: no session, no tokens kept, the Twitch grant revoked",
    r.status === 302 && r.headers.get("Location") === "/?error=denied" && !cookieOf(r) && calls.stored.length === storedBefore && calls.revoked === revokedBefore + 1);
  twitchLogin = { user_id: "777", login: "renamed_later" };
  r = await cb("code=abc&state=st8");
  check("an account on the list by numeric id signs in whatever its login is", r.status === 302 && r.headers.get("Location") === "/" && !!cookieOf(r));

  // Broken callbacks.
  r = await cb("code=abc&state=other");
  check("a callback whose state doesn't match the cookie is refused", r.headers.get("Location") === "/?error=state" && !cookieOf(r));
  r = await get("/auth/callback?code=abc&state=st8");
  check("a callback without the state cookie is refused", r.headers.get("Location") === "/?error=state");
  r = await cb("error=access_denied&error_description=" + encodeURIComponent("<b>hi</b>"));
  check("cancelling at Twitch comes back with a fixed code, not Twitch's text", r.headers.get("Location") === "/?error=cancelled");

  // Syncing settings between devices.
  const syncReq = (method, bodyObj, cookie = sess) => worker.default.fetch(req("/api/sync", { method, headers: { Cookie: cookie, Origin: "https://app.test", "Content-Type": "application/json" }, ...(bodyObj !== undefined ? { body: JSON.stringify(bodyObj) } : {}) }), env);
  r = await get("/api/sync");
  check("sync needs a session", r.status === 401);
  r = await syncReq("GET");
  check("sync: nothing saved yet", (await r.json()).sync === null);
  const good = { at: 1700000000000, settings: { rules: [] }, tabs: ["uwoslab"], pinned: null };
  r = await syncReq("POST", good);
  check("sync: a valid copy is saved", r.status === 200 && syncSaved && syncSaved.tabs[0] === "uwoslab");
  r = await syncReq("GET");
  check("sync: ...and read back", (await r.json()).sync.at === good.at);
  for (const [label, bad] of [["a bad time", { ...good, at: "now" }], ["settings that aren't an object", { ...good, settings: [] }], ["tabs that aren't channel names", { ...good, tabs: ["<script>"] }], ["too many tabs", { ...good, tabs: Array(101).fill("a") }], ["a bad pinned name", { ...good, pinned: "x y" }], ["oversized settings", { ...good, settings: { big: "x".repeat(70000) } }]]) {
    r = await syncReq("POST", bad);
    check("sync refuses " + label, r.status === 400);
  }
  r = await worker.default.fetch(req("/api/sync", { method: "POST", headers: { Cookie: sess, Origin: "https://evil.test", "Content-Type": "application/json" }, body: JSON.stringify(good) }), env);
  check("sync from another origin is refused", r.status === 403);

  // Logging out.
  r = await post("/auth/logout", sess);
  check("logging out disconnects Twitch for that account and clears the cookie", calls.disconnected.at(-1) === "4242" && /__Host-yappa_session=;[^]*Max-Age=0/.test(r.headers.get("Set-Cookie") || ""));
  r = await post("/auth/logout", sess, "https://evil.test");
  check("logging out from another origin is refused", r.status === 403);
  globalThis.fetch = realFetch;
}


console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
