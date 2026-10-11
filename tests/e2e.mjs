// End-to-end UI test: the real page and client JS in headless Chromium at phone size,
// with Twitch (EventSub WebSocket, IRC, Helix-backed /api routes), 7TV/BTTV/FFZ and the
// Twitch player all faked. Run with `npm run test:e2e` (see CLAUDE.md for browser setup).
import { chromium } from "playwright-core";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = fileURLToPath(new URL("./output", import.meta.url)); // screenshots + bundle (git-ignored)
mkdirSync(dir, { recursive: true });
await build({
  stdin: { contents: 'export { renderPage, PAGE_HEADERS } from "./src/page.ts"; export { renderMoved } from "./src/moved.ts"; export { relayMaster } from "./src/usher.ts"; export { parseClipsQuery, parseVideosQuery, parseCreateClip, parseDuration, videoThumb, slimClip, slimVideo, clipFailure } from "./src/browse.ts"; export { staticFiles } from "./src/static.ts";', resolveDir: root, sourcefile: "entry.ts", loader: "ts" },
  bundle: true, format: "esm", outfile: dir + "/page.bundle.mjs", logLevel: "warning",
  loader: { ".css": "text", ".js": "text", ".png": "base64" },
});
const { renderPage, PAGE_HEADERS, renderMoved, relayMaster, parseClipsQuery, parseVideosQuery, parseCreateClip, parseDuration, videoThumb, slimClip, slimVideo, clipFailure, staticFiles } = await import(dir + "/page.bundle.mjs?" + Date.now());
const html = renderPage("testuser@example.com");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell",
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 760 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
await page.addInitScript(() => {
  // Stand-in for Document Picture-in-Picture (not available headless): a same-origin popup.
  window.documentPictureInPicture = { requestWindow: async (o) => window.open("", "pip", "width=" + o.width + ",height=" + o.height) };
  // Most checks assume chat history is on; the opt-in prompt is tested on its own near the end.
  if (location.host === "yappa.test" && !localStorage.getItem("settings") && !location.hash.startsWith("#import=")) {
    localStorage.setItem("settings", JSON.stringify({ history: true }));
  }
});
// Console errors the checks provoke on purpose: the CSP check, the 503 status, the aborted request.
// The CSP one is allowed once, so a real violation by the app still fails the run.
const expectedErrors = [/status of 503/, /status of 502/, /net::ERR_FAILED/];
let allowedCspErrors = 1;
const expected = (t) => expectedErrors.some((re) => re.test(t)) || (/Content Security Policy/.test(t) && allowedCspErrors-- > 0);
const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => m.type() === "error" && !expected(m.text()) && errors.push(m.text()));
page.on("dialog", (d) => d.accept());
page.on("response", (r) => { if (r.status() === 404) errors.push("404 " + r.url()); });
const log = { subs: [], unsubs: [], mods: [], sent: [], cycle: [], pinGets: [], settings: [], automod: [], bumps: 0, player: [], clips: [] };
const chatSettings = { slow_mode: true, slow_mode_wait_time: 10, follower_mode: false, follower_mode_duration: null, subscriber_mode: false, emote_mode: false, unique_chat_mode: false };
let sendCounter = 0;
const cycle = { enabled: false, changes: 0, lastColor: "#30E51E" };
let statusCalls = 0;
let statusDown = false, slowSend = 0;
const ids = { uwoslab: "999", otherchan: "888", targetchan: "777", alphachan: "666" };
let followingMode = "ok";
let embedScriptFails = false;
let sessionExpiredMock = false, streamsFail = false, extrasFail = false;
let masterFails = false;
let noAvatar = false, noMyClips = false;
let browseFails = false, noClipsScope = false, clipCreateError = null, newClipPolls = 0, sendFailure = null;
const mkClip = (id, title, views, extra = {}) => ({ id, url: "https://clips.twitch.tv/" + id, title, creator: "Clipper" + id.slice(-1), broadcaster: "UwoSlab", views, createdAt: new Date(Date.now() - 2 * 86400e3).toISOString(), thumbnail: "https://img.test/clip-" + id + ".jpg", duration: 27.4, game: "Just Chatting", ...extra });
const mkVideo = (id, title, views, seconds, type = "archive") => ({ id, url: "https://www.twitch.tv/videos/" + id, title, type, views, createdAt: new Date(Date.now() - 3 * 86400e3).toISOString(), thumbnail: "https://img.test/vod-" + id + ".jpg", seconds });
// A master playlist shaped like Twitch's: best first (the source last in the file, as seen live), audio-only at the end.
const rendition = (group, name, w, h, fps, bw) => `#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="${group}",NAME="${name}",AUTOSELECT=YES,DEFAULT=YES\n#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${w}x${h},CODECS="avc1.4D401F,mp4a.40.2",VIDEO="${group}",FRAME-RATE=${fps}.000\nhttps://use23.playlist.ttvnw.net/v1/playlist/${group}.m3u8`;
const MASTER = ["#EXTM3U", '#EXT-X-TWITCH-INFO:NODE="x",USER-IP="1.2.3.4"',
  rendition("720p60", "720p60", 1280, 720, 60, 3400000), rendition("480p30", "480p", 852, 480, 30, 1428000),
  rendition("360p30", "360p", 640, 360, 30, 630000), rendition("160p30", "160p", 284, 160, 30, 230000),
  rendition("chunked", "1080p60 (source)", 1920, 1080, 60, 6890302),
  '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="audio_only",NAME="audio_only",AUTOSELECT=NO,DEFAULT=NO\n#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2",VIDEO="audio_only"\nhttps://use23.playlist.ttvnw.net/v1/playlist/audio_only.m3u8'].join("\n") + "\n";
const subFailures = []; // queued error messages for the next /api/chat/subscribe calls
const svg = (h) => `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><circle cx="28" cy="28" r="26" fill="hsl(${h},70%,55%)"/></svg>`;
await ctx.route("**/*", async (route) => {
  const u = new URL(route.request().url());
  const j = (d) => route.fulfill({ json: d });
  const body = () => route.request().postDataJSON();
  if (u.host === "yappa.test") {
    if (u.pathname === "/") return route.fulfill({ body: html, contentType: "text/html", headers: PAGE_HEADERS });
    // Stand-in for hls.js (headless Chromium can't play real Twitch video): records calls.
    if (u.pathname === "/hls.js" && u.search !== "?real") return route.fulfill({ contentType: "text/javascript", body: `
      window.__hls = { instances: [] };
      window.Hls = class { constructor(cfg) { this.cfg = cfg; this.handlers = {}; this.calls = []; __hls.instances.push(this); }
        static isSupported() { return true; }
        on(ev, fn) { this.handlers[ev] = fn; } loadSource(u) { this.calls.push(["loadSource", u]); }
        attachMedia(v) { this.calls.push(["attachMedia", v.tagName]); } destroy() { this.calls.push(["destroy"]); this.destroyed = true; }
        fire(ev, data) { this.handlers[ev] && this.handlers[ev](ev, data); } };
      Hls.Events = { ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed" };` });
    // An expired Cloudflare Access session: every request is redirected to Access's login page.
    if (u.pathname === "/manifest.webmanifest" && sessionExpiredMock) return route.fulfill({ status: 302, headers: { location: "https://access.example.com/login" } });
    const f = staticFiles[u.pathname];
    if (f) return route.fulfill({ body: f.type === "image/png" ? Buffer.from(f.body, "base64") : f.body, contentType: f.type });
    if (u.pathname === "/api/cycle") { cycle.enabled = body().enabled; if (cycle.enabled) { cycle.lastColor = "#11AA22"; cycle.changes++; } log.cycle.push(cycle.enabled); return j({ ok: true, cycle }); }
    if (u.pathname === "/api/netfail") return route.abort();
    if (u.pathname === "/api/channel/clips" || u.pathname === "/api/channel/videos") {
      log.browse = [...(log.browse || []), u.pathname + u.search];
      if (browseFails) return route.fulfill({ status: 502, json: { ok: false, error: "Couldn't reach Twitch." } });
      const p = u.searchParams;
      if (u.pathname === "/api/channel/clips") {
        if (p.get("period") === "week") return j({ ok: true, clips: [mkClip("WeekOne", "This week's best", 900)], cursor: null });
        if (p.get("after") === "c1") return j({ ok: true, clips: [mkClip("PageTwoA", "Second page A", 40), mkClip("PageTwoB", "Second page B", 30)], cursor: null });
        return j({ ok: true, clips: [mkClip("TopClip1", "An incredible play nobody saw coming and a very long title that wraps", 12345), mkClip("TopClip2", "Second best", 5000), mkClip("TopClip3", "Third", 4000)], cursor: "c1" });
      }
      const type = p.get("type");
      if (type === "archive") return j({ ok: true, videos: p.get("sort") === "views" ? [mkVideo("2002", "Most viewed stream", 99000, 20000)] : [mkVideo("1001", "Friday night stream", 4200, 12310), mkVideo("1002", "Short one", 120, 95)], cursor: null });
      if (type === "highlight") return j({ ok: true, videos: [mkVideo("3003", "Best moments", 800, 600, "highlight")], cursor: null });
      return j({ ok: true, videos: [], cursor: null });
    }
    if (u.pathname === "/api/clips/create") {
      const b = body(); log.clipCreates = [...(log.clipCreates || []), b];
      if (noClipsScope) return route.fulfill({ status: 403, json: { ok: false, error: "Missing clips:edit", needsScope: true } });
      if (clipCreateError) return route.fulfill({ status: 502, json: { ok: false, error: clipCreateError } });
      newClipPolls = 0;
      return j({ ok: true, id: "NewClip1", editUrl: "https://clips.twitch.tv/NewClip1/edit" });
    }
    if (u.pathname === "/api/hls/master") {
      log.master = [...(log.master || []), body()];
      if (masterFails) return route.fulfill({ status: 502, json: { ok: false, error: "Twitch's playlist server answered 403." } });
      return j({ ok: true, playlist: MASTER });
    }
    if (streamsFail && u.pathname === "/api/streams") return route.fulfill({ status: 502, json: { ok: false, error: "Couldn't reach Twitch." } });
    if (extrasFail && (u.pathname === "/api/chat/badges" || u.pathname === "/api/chat/cheermotes")) return route.fulfill({ status: 502, json: { ok: false, error: "Couldn't reach Twitch." } });
    if (u.pathname === "/api/chat/subscribe" && subFailures.length) { log.subs.push("failed:" + route.request().postDataJSON().channel); return route.fulfill({ status: 502, json: { ok: false, error: subFailures.shift() } }); }
    if (u.pathname === "/api/following") {
      log.following = (log.following || 0) + 1;
      if (followingMode === "scope") return j({ ok: false, error: "Missing user:read:follows", needsScope: true });
      return j({ ok: true,
        live: [{ id: "777", login: "targetchan", name: "TargetChan", title: "speedrun attempts", game: "Celeste", viewers: 4321, startedAt: new Date().toISOString() },
               { id: "999", login: "uwoslab", name: "UwoSlab", title: "Building a chat app", game: "Software and Game Development", viewers: 1234, startedAt: new Date().toISOString() }],
        channels: [{ id: "555", login: "zetachan", name: "ZetaChan" }, { id: "666", login: "alphachan", name: "AlphaChan" }, { id: "777", login: "targetchan", name: "TargetChan" }, { id: "999", login: "uwoslab", name: "UwoSlab" }] });
    }
    if (u.pathname === "/api/status" && statusDown) return route.fulfill({ status: 503, json: { ok: false, error: "The server is updating; try again in a minute.", retry: true } });
    if (u.pathname === "/api/status") { statusCalls++; return j({ twitch: { login: "testuser", userId: "111", displayName: "TestUser", avatar: noAvatar ? null : "https://img.test/avatar.png", missingScopes: [], missingOptionalScopes: noClipsScope ? ["clips:edit"] : [] }, cycle }); }
    if (u.pathname === "/auth/logout") { log.logouts = (log.logouts || 0) + 1; return j({ ok: true }); }
    if (u.pathname === "/api/my/clips") {
      log.mine = [...(log.mine || []), u.search];
      if (noMyClips) return j({ ok: true, clips: [], cursor: null });
      if (u.searchParams.get("after") === "20") return j({ ok: true, clips: [mkClip("MineThree", "Third of mine", 7)], cursor: null });
      return j({ ok: true, clips: [mkClip("MineOne", "My first clip", 120), mkClip("MineTwo", "My second clip", 80)], cursor: "20" });
    }
    if (u.pathname === "/api/chat/subscribe") { const b = body(); log.subs.push(b.channel + "@" + b.session_id); return j({ ok: true, broadcaster: { id: ids[b.channel], login: b.channel, name: { uwoslab: "UwoSlab", otherchan: "OtherChan", targetchan: "TargetChan", alphachan: "AlphaChan" }[b.channel] || b.channel }, isMod: b.channel === "uwoslab", subscriptionIds: [b.channel + "-s1", b.channel + "-s2"], automod: b.channel === "uwoslab", settings: b.channel === "uwoslab" ? chatSettings : null }); }
    if (u.pathname === "/api/streams") return j([{ user_id: "999", title: "Building a chat app", game_name: "Software and Game Development", viewer_count: 1234, started_at: new Date(Date.now() - 3 * 3600e3).toISOString() }]);
    if (u.pathname === "/api/chat/settings") { const b = body(); log.settings.push(b); Object.assign(chatSettings, b); delete chatSettings.broadcaster_id; return j({ ok: true, settings: chatSettings }); }
    if (u.pathname === "/api/chat/user") return j({ ok: true, user: { id: u.searchParams.get("user_id"), login: "spammer", display_name: "Spammer", description: "I sell followers", profile_image_url: "https://img.test/a.png", broadcaster_type: "", created_at: "2020-01-02T00:00:00Z" }, followedAt: "2024-05-06T00:00:00Z" });
    if (u.pathname === "/api/chat/automod") { log.automod.push(body()); return j({ ok: true }); }
    if (u.pathname === "/api/chat/cheermotes") return j([{ prefix: "Cheer", tiers: [{ min_bits: 1, color: "#979797", images: { dark: { animated: { "2": "https://img.test/cheer1.gif" } } } }, { min_bits: 100, color: "#9c3ee8", images: { dark: { animated: { "2": "https://img.test/cheer100.gif" } } } }] }]);
    if (u.pathname === "/api/chat/clip") {
      const id = u.searchParams.get("id"); log.clips.push(id);
      if (id === "MissingClip") return j({ ok: true, clip: null });
      if (id === "NewClip1" && newClipPolls++ < 1) return j({ ok: true, clip: null }); // not published yet
      return j({ ok: true, clip: { id, url: "https://clips.twitch.tv/" + id, title: id === "SecondSlug" ? "Second clip" : "An incredible play nobody saw coming and a very long title that wraps", broadcaster: "UwoSlab", creator: "Clipper", views: 12345, createdAt: new Date(Date.now() - 3 * 86400e3).toISOString(), thumbnail: "https://img.test/clip-" + id + ".jpg", duration: 27.4, game: "Just Chatting" } });
    }
    if (u.pathname === "/api/cycle/bump") { log.bumps++; log.bumpIds = [...(log.bumpIds || []), body().message_id]; return j({ ok: true, cycle }); }
    if (u.pathname === "/api/chat/unsubscribe") { log.unsubs.push(...body().ids); return j({ ok: true }); }
    if (u.pathname === "/api/chat/mod") {
      const b = body(); log.mods.push(b);
      return j({ ok: true, message: "did " + b.action });
    }
    if (u.pathname === "/api/chat/pin") { log.pinGets.push(u.searchParams.get("broadcaster_id")); return j({ ok: false, error: "gone" }); }
    if (u.pathname === "/api/chat/send" && slowSend) await sleep(slowSend);
    if (u.pathname === "/api/chat/send" && sendFailure) { log.sendTries = [...(log.sendTries || []), body().message]; return route.fulfill({ status: 502, json: { ok: false, error: sendFailure } }); }
    if (u.pathname === "/api/chat/send") { log.sent.push(body().message); sendCounter++; if (cycle.enabled) { cycle.lastColor = "#" + (0x100000 + log.sent.length * 77777).toString(16).slice(-6).toUpperCase(); cycle.changes++; } return j({ ok: true, messageId: "sent-" + sendCounter }); }
    if (u.pathname === "/api/chat/badges") return j({});
    if (u.pathname === "/api/chat/emotes") return j({ ok: true, emotes: [{ id: "25", name: "Kappa", group: "Twitch global", animated: false }, { id: "e1", name: "uwoHype", group: "This channel", animated: false }] });
  }
  // The app's old address (src/moved.ts).
  if (u.host === "old.test") return route.fulfill({ body: u.pathname === "/" ? renderMoved("yappa.test") : "<p>old</p>", contentType: "text/html" });
  // The built-in player really fetches the playlist; answer slowly so the test decides the outcome.
  if (u.host === "usher.ttvnw.net" || /\.ttvnw\.net$/.test(u.host)) { await sleep(30000); return route.fulfill({ body: "#EXTM3U\n", contentType: "application/vnd.apple.mpegurl", headers: { "access-control-allow-origin": "*" } }).catch(() => {}); }
  if (u.host === "gql.twitch.tv") {
    const b = route.request().postDataJSON();
    log.gql = [...(log.gql || []), { clientId: route.request().headers()["client-id"], login: b.variables && b.variables.login }];
    const cors = { "access-control-allow-origin": "*" };
    if (b.variables.login === "brokenchan") return route.fulfill({ json: { errors: [{ message: "service error" }] }, headers: cors });
    return route.fulfill({ json: { data: { streamPlaybackAccessToken: { value: JSON.stringify({ channel: b.variables.login, authorization: { forbidden: false } }), signature: "sig-" + b.variables.login } } }, headers: cors });
  }
  if (u.host === "recent-messages.robotty.de") {
    const chan = u.pathname.split("/").pop();
    log.history = [...(log.history || []), chan + u.search];
    // A channel with lots of history, honoring limit/before/after like the real service.
    if (chan === "deepchan") {
      const p = u.searchParams, base = Date.now() - 3600e3;
      let all = Array.from({ length: 250 }, (_, i) => ({ i, ts: base + i * 10000 }));
      if (p.get("before")) all = all.filter((m) => m.ts + 50 < Number(p.get("before")));
      if (p.get("after")) all = all.filter((m) => m.ts + 50 > Number(p.get("after")));
      all = all.slice(-Number(p.get("limit") || 800));
      return j({ messages: all.map((m) => "@color=#FF7F50;rm-received-ts=" + (m.ts + 50) + ";display-name=Deep" + m.i + ";emotes=;id=deep" + m.i + ";tmi-sent-ts=" + m.ts + ";user-id=" + (8000 + m.i) + " :deep" + m.i + "!deep" + m.i + "@x PRIVMSG #deepchan :history line " + m.i) });
    }
    const irc = (id, user, uid, text, ts, extra = "") => "@badge-info=;badges=;color=#FF7F50;rm-received-ts=" + (ts + 50) + ";display-name=" + user + ";emotes=" + (extra.emotes || "") + ";first-msg=" + (extra.first ? 1 : 0) + ";id=" + id + ";room-id=" + ids[chan] + ";tmi-sent-ts=" + ts + ";user-id=" + uid + (extra.reply || "") + " :" + user.toLowerCase() + "!" + user.toLowerCase() + "@x.tmi.twitch.tv PRIVMSG #" + chan + " :" + text;
    const now = Date.now();
    const msgs = [
      irc("h1", "OldTimer", "501", "Kappa from history", now - 120000, { emotes: "25:0-4" }),
      irc("h2", "Newbie", "502", "hi first time here", now - 90000, { first: true }),
    ];
    if (gapMode) msgs.push(
      irc("g1", "GapGuy", "503", "you missed this one", gapTs),
      irc("g2", "GapGal", "504", "@testuser and this mention", gapTs + 1, { reply: ";reply-parent-msg-id=x;reply-parent-display-name=testuser;reply-parent-msg-body=yo" }),
    );
    return j({ messages: msgs });
  }
  if (u.host === "player.twitch.tv" && u.pathname === "/js/embed/v1.js" && embedScriptFails) return route.abort();
  if (u.host === "player.twitch.tv" && u.pathname === "/js/embed/v1.js") return route.fulfill({ contentType: "text/javascript", body: `
    window.__player = { calls: [], handlers: {} };
    window.Twitch = { Player: function (id, opts) {
      __player.calls.push(["new", opts]);
      const f = document.createElement("iframe");
      f.setAttribute("allow", "autoplay; fullscreen"); // what Twitch's real embed sets
      f.src = "https://player.twitch.tv/?channel=" + opts.channel + "&parent=" + opts.parent[0];
      document.getElementById(id).appendChild(f);
      this.setChannel = (c) => { __player.calls.push(["setChannel", c]); f.src = "https://player.twitch.tv/?channel=" + c + "&parent=" + opts.parent[0]; };
      const st = { paused: false, muted: !!opts.muted, volume: 0.5, quality: "auto" };
      const listeners = {};
      const fire = (ev) => (listeners[ev] || []).forEach((fn) => fn());
      __player.state = st;
      this.play = () => { __player.calls.push(["play"]); st.paused = false; fire("play"); fire("playing"); };
      this.pause = () => { __player.calls.push(["pause"]); st.paused = true; fire("pause"); };
      this.setMuted = (m) => { __player.calls.push(["setMuted", m]); st.muted = m; };
      this.isPaused = () => st.paused;
      this.getMuted = () => st.muted;
      this.getVolume = () => st.volume;
      this.setVolume = (v) => { st.volume = v; };
      this.getQuality = () => st.quality;
      this.getQualities = () => [{ group: "chunked", name: "1080p60" }, { group: "720p60", name: "720p60" }, { group: "480p30", name: "480p" }];
      this.setQuality = (q) => { __player.calls.push(["setQuality", q]); st.quality = q; };
      this.addEventListener = (ev, fn) => { __player.handlers[ev] = fn; (listeners[ev] = listeners[ev] || []).push(fn); };
    } };
    Object.assign(Twitch.Player, { PLAYBACK_BLOCKED: "playbackBlocked", PLAY: "play", PLAYING: "playing", PAUSE: "pause", ENDED: "ended", OFFLINE: "offline", ONLINE: "online" });` });
  if (u.host === "clips.twitch.tv" && u.pathname === "/embed") { log.clipEmbeds = [...(log.clipEmbeds || []), u.search]; return route.fulfill({ body: "<body style='margin:0;background:#111;color:#bf94ff;display:grid;place-items:center;height:100vh;font:16px sans-serif'>clip embed (test)</body>", contentType: "text/html" }); }
  if (u.host === "player.twitch.tv") { log.player.push(u.search); return route.fulfill({ body: "<body style='margin:0;background:#111;color:#9147ff;display:grid;place-items:center;height:100vh;font:20px sans-serif'>▶ " + u.searchParams.get("channel") + "</body>", contentType: "text/html" }); }
  if (u.host === "www.twitch.tv" && u.pathname.startsWith("/embed/")) { log.chatEmbeds = [...(log.chatEmbeds || []), u.pathname + u.search]; return route.fulfill({ body: "<body style='margin:0;background:#18181b;color:#adadb8;display:grid;place-items:center;height:100vh;font:15px sans-serif'>Twitch chat embed (test)</body>", contentType: "text/html" }); }
  if (u.host === "api.betterttv.net") {
    if (u.pathname === "/3/cached/emotes/global") return j([{ id: "bg1", code: "OMEGALUL" }]);
    if (u.pathname.startsWith("/3/cached/users/twitch/")) return j({ channelEmotes: [{ id: "bc1", code: "uwuDance" }], sharedEmotes: [{ id: "bs1", code: "sharedOne" }] });
    if (u.pathname === "/3/cached/frankerfacez/emotes/global") return j([{ id: 9, code: "ZrehplaR", images: { "1x": "https://cdn.betterttv.net/frankerfacez_emote/9/1", "2x": "https://cdn.betterttv.net/frankerfacez_emote/9/2" } }]);
    return j([]);
  }
  if (/img\.test/.test(u.href)) return route.fulfill({ body: svg(200), contentType: "image/svg+xml" });
  // A stand-in GIF host (the real ones are on giphy.com), 4:3 so the size caps are visible.
  if (/(^|\.)giphy\.com$/.test(u.host)) { log.gifs = [...(log.gifs || []), { url: u.href, referer: route.request().headers().referer || null }]; return route.fulfill({ body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="#e0457b"/><text x="240" y="190" font-size="48" text-anchor="middle" fill="#fff">GIF</text></svg>', contentType: "image/svg+xml" }); }
  if (u.host === "7tv.io" && u.pathname === "/v3/emote-sets/global") return j({ emotes: [{ name: "PETPET", flags: 1, data: { host: { url: "//cdn.7tv.app/emote/P" } } }] });
  if (u.host === "7tv.io") return j({ emote_set: { emotes: [{ name: "catJAM", flags: 0, data: { host: { url: "//cdn.7tv.app/emote/J" } } }] } });
  if (/jtvnw|cdn\.7tv|cdn\.betterttv/.test(u.href)) return route.fulfill({ body: svg(u.pathname.length * 37 % 360), contentType: "image/svg+xml" });
  return route.fulfill({ status: 404, body: "" });
});
const sockets = [];
let gapMode = false, gapTs = 0;
const ircSockets = [];
await page.routeWebSocket(/irc-ws\.chat\.twitch\.tv/, (ws) => {
  ircSockets.push(ws);
  ws.onMessage((m) => { ws.joined = (ws.joined || "") + m; });
});
const msg = (type, payload) => JSON.stringify({ metadata: { message_type: type }, payload });
await page.routeWebSocket(/eventsub\.wss\.twitch\.tv/, (ws) => { sockets.push(ws); ws.send(msg("session_welcome", { session: { id: "sess" + sockets.length, keepalive_timeout_seconds: 30 } })); });
const chat = (bid, id, user, uid, text, extra = {}) => msg("notification", { subscription: { type: "channel.chat.message" }, event: {
  broadcaster_user_id: bid, message_id: id, chatter_user_id: uid, chatter_user_name: user, chatter_user_login: user.toLowerCase(), color: "#1E90FF", badges: [],
  message: { text, fragments: extra.fragments || [{ type: "text", text }] }, ...extra } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () => page.evaluate(() => ({
  tabs: [...document.querySelectorAll(".tab")].map((t) => t.querySelector(".tab-name").textContent + (t.classList.contains("active") ? "*" : "") + (t.querySelector(".mod-pill").hidden ? "" : "[MOD]") + (t.querySelector(".unread").hidden ? "" : "(" + t.querySelector(".unread").textContent + (t.classList.contains("mentioned") ? "!" : "") + ")")).join(" | "),
  hash: location.hash, input: composer.getText(), placeholder: document.getElementById("message").dataset.placeholder,
  suggest: document.getElementById("suggest").hidden ? null : [...document.querySelectorAll("#suggest .row")].map((r) => r.textContent).join(", "),
  visibleMsgs: [...document.querySelectorAll(".messages:not([hidden]) > li")].map((l) => l.textContent.replace(/(Reply|Delete|Timeout|Ban)+$/, "")).slice(-4),
}));
let passed = 0, failed = 0;
// Settings now lives in the account menu (your picture in the corner).
const openSettingsUI = async () => { await page.click("#profile-btn"); await page.click('#account-menu button:has-text("Settings")'); };
const check = (label, cond, extra = "") => {
  cond ? passed++ : failed++;
  console.log((cond ? "PASS " : "FAIL ") + label + (extra && !cond ? "  → " + extra : ""));
};

await page.goto("https://yappa.test/#uwoslab");
await page.waitForFunction(() => document.body.innerText.includes("Joined #UwoSlab"));
{
  const cdp = await ctx.newCDPSession(page);
  await page.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(() => true), null, { timeout: 5000 }).catch(() => {});
  const inst = await cdp.send("Page.getInstallabilityErrors");
  const man = await cdp.send("Page.getAppManifest");
  check("manifest parsed without errors", man.errors.length === 0 && man.url.endsWith("/manifest.webmanifest"), JSON.stringify(man.errors));
  check("installable (no installability errors)", inst.installabilityErrors.length === 0, JSON.stringify(inst.installabilityErrors));
  const sw = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.scriptURL || null);
  check("manifest name/short_name", man.data && JSON.parse(man.data).name === "Yappa" && JSON.parse(man.data).short_name === "Yappa", man.data && man.data.slice(0, 80));
  check("service worker active", sw === "https://yappa.test/sw.js", String(sw));
}
await page.fill("#channel", "otherchan");
await page.press("#channel", "Enter");
await page.waitForFunction(() => document.body.innerText.includes("Joined #OtherChan"));
let s = await state();
check("two tabs, second active, MOD pill on uwoslab", s.tabs === "UwoSlab[MOD] | OtherChan*", s.tabs);
check("both subscribed on one shared session", JSON.stringify(log.subs) === '["uwoslab@sess1","otherchan@sess1"]', JSON.stringify(log.subs));
check("not a mod in otherchan → no mod hint", !s.placeholder.includes("mod"), s.placeholder);

sockets[0].send(chat("999", "u1", "SomeViewer", "222", "hey @testuser", { fragments: [{ type: "text", text: "hey " }, { type: "mention", text: "@testuser", mention: { user_id: "111" } }] }));
sockets[0].send(chat("999", "u2", "Spammer", "333", "buy followers"));
sockets[0].send(chat("888", "o1", "OtherPerson", "444", "hello other chan catJAM"));
await sleep(200);
s = await state();
check("unread + mention badge on background tab", s.tabs === "UwoSlab[MOD](2!) | OtherChan*", s.tabs);
check("active tab shows only its own messages", s.visibleMsgs.some((t) => t.includes("hello other chan")) && !s.visibleMsgs.some((t) => t.includes("buy followers")));
await page.screenshot({ path: dir + "/t1-tabs.png" });

await page.click(".tab:first-child .tab-name");
s = await state();
check("switching clears unread, updates hash", s.tabs === "UwoSlab*[MOD] | OtherChan" && s.hash === "#uwoslab", s.tabs + " " + s.hash);
check("mod hint in placeholder", s.placeholder.includes("/ban"), s.placeholder);
const modBtns = await page.$$eval('li[data-id="u2"] .actions button', (bs) => bs.map((b) => b.textContent));
check("mod actions on others' messages", modBtns.join(",") === "Reply,Delete,Timeout,Ban", modBtns.join(","));

await page.tap('li[data-id="u2"] .body');
await sleep(100);
await page.screenshot({ path: dir + "/t2-actions.png" });
await page.click('li[data-id="u2"] .actions button:has-text("Timeout")');
await page.tap('li[data-id="u2"] .body'); await page.click('li[data-id="u2"] .actions button:has-text("Ban")');
await sleep(150);
check("timeout + ban buttons call mod API", JSON.stringify(log.mods.map((m) => m.action + ":" + (m.user_id || m.login) + ":" + (m.duration || "") + ":" + m.broadcaster_id)) === '["timeout:333:600:999","ban:333::999"]', JSON.stringify(log.mods));

await page.click("#message");
await page.keyboard.type("/timeout baduser 10m being rude");
await page.keyboard.press("Enter");
await sleep(150);
const last = log.mods.at(-1);
check("/timeout command", last.action === "timeout" && last.login === "baduser" && last.duration === 600 && last.reason === "being rude", JSON.stringify(last));
check("command not sent as chat", log.sent.length === 0);

// autocomplete
await page.keyboard.type("hi :cat");
s = await state();
check(":prefix popup", s.suggest && s.suggest.startsWith("catJAM"), s.suggest);
await page.screenshot({ path: dir + "/t3-suggest.png" });
await page.keyboard.press("Enter");
s = await state();
check("Enter accepts after ':'", s.input === "hi catJAM ", JSON.stringify(s.input));
await page.keyboard.type("Kap");
s = await state();
check("bare 3-letter prefix shows popup", s.suggest && s.suggest.startsWith("Kappa"), s.suggest);
await page.keyboard.press("Enter");
await sleep(150);
check("Enter on bare word sends instead of completing", log.sent.at(-1) === "hi catJAM Kap", JSON.stringify(log.sent));
await page.keyboard.type("uw");
await page.keyboard.press("Tab");
s = await state();
check("Tab completes short prefix", s.input === "uwoHype ", JSON.stringify(s.input));
await page.keyboard.type("@So");
s = await state();
check("@ completes chatters", s.suggest && s.suggest.startsWith("@SomeViewer"), s.suggest);
await page.keyboard.press("Tab");
s = await state();
check("@ inserted", s.input === "uwoHype @SomeViewer ", JSON.stringify(s.input));
await page.evaluate(() => composer.setText(""));

// close tab
await page.click(".tab:nth-child(2) .tab-close");
await sleep(150);
s = await state();
check("closing tab unsubscribes it", JSON.stringify(log.unsubs) === '["otherchan-s1","otherchan-s2"]' && s.tabs === "UwoSlab*[MOD]", s.tabs + " " + JSON.stringify(log.unsubs));
check("tabs persisted", (await page.evaluate(() => localStorage.getItem("tabs"))) === '["uwoslab"]');

// session migration then hard drop
sockets[0].send(msg("session_reconnect", { session: { reconnect_url: "wss://eventsub.wss.twitch.tv/ws?r=1" } }));
await sleep(300);
const subsBefore = log.subs.length;
check("migration does not resubscribe", log.subs.length === subsBefore);
sockets[1].close();
await page.waitForFunction(() => document.body.innerText.match(/Reconnected to #UwoSlab/g)?.length >= 1, null, { timeout: 5000 });
check("hard drop → reconnect + resubscribe", log.subs.at(-1) === "uwoslab@sess3", JSON.stringify(log.subs));

// reload restores tabs
await page.fill("#channel", "otherchan"); await page.press("#channel", "Enter");
await page.waitForFunction(() => document.querySelectorAll(".tab").length === 2);
await page.reload();
await page.waitForFunction(() => document.querySelectorAll(".tab.joined").length === 2, null, { timeout: 5000 });
s = await state();
check("reload restores tabs", s.tabs.replace("*", "") === "UwoSlab[MOD] | OtherChan", s.tabs);

// Pinned messages were removed: no Pin action, no polling.
check("no pinned-message requests", log.pinGets.length === 0, JSON.stringify(log.pinGets));

// ---- color cycling: per message ----
const hdr = await page.evaluate(() => { const h = document.querySelector("header"); const open = h.querySelector("form button").getBoundingClientRect(), gear = document.getElementById("profile-btn").getBoundingClientRect(); return { h: Math.round(h.getBoundingClientRect().height), sameRow: Math.abs(open.top - gear.top) < 8 && gear.left > open.right, swatchInHeader: !!h.querySelector(".swatch") }; });
check("header is one row with ⚙ next to Open, no swatch", hdr.sameRow && !hdr.swatchInHeader && hdr.h < 70, JSON.stringify(hdr));
await openSettingsUI();
check("color controls in Settings", (await page.textContent("#sheet-body")).includes("Chat color") && !!(await page.$("#sheet-body #cycle")));
await page.click("#cycle");
await page.waitForFunction(() => document.getElementById("cycle").textContent === "Stop cycling");
check("toggle on → POST /api/cycle and header shows new color", JSON.stringify(log.cycle) === "[true]" && (await page.textContent("#color")) === "#11AA22 - 1", await page.textContent("#color"));
await page.screenshot({ path: dir + "/t5-cycle.png" });
await page.click("#sheet-close");
await page.fill("#message", "colorful message");
await page.press("#message", "Enter");
await sleep(300);
await openSettingsUI();
await page.waitForFunction(() => document.getElementById("color").textContent.endsWith(" - 2"), null, { timeout: 3000 });
check("sending a message updates the color (seen in Settings)", (await page.textContent("#color")).endsWith(" - 2"), await page.textContent("#color"));
await page.click("#cycle");
await page.waitForFunction(() => document.getElementById("cycle").textContent === "Cycle color");
check("toggle off", JSON.stringify(log.cycle) === "[true,false]");
await page.click("#sheet-close");

// ---- first-time chatters, history, deletions ----
await page.click(".tab:first-child .tab-name");
s = await state();
check("history loaded above join line", s.visibleMsgs.length && (await page.$$eval('.messages:not([hidden]) li', (ls) => ls.map((l) => l.textContent)).then((t) => t.findIndex((x) => x.includes(" from history")) < t.findIndex((x) => x.includes("Joined #UwoSlab")) && t.findIndex((x) => x.includes(" from history")) > t.findIndex((x) => x.includes("start of chat history")))));
check("history emote parsed from IRC tags", await page.$eval('li[data-id="h1"]', (l) => !!l.querySelector('img[alt="Kappa"]')));
check("first-time flag from history", await page.$eval('li[data-id="h2"]', (l) => l.classList.contains("first") && l.textContent.includes("First-time chatter")));
check("anon IRC joined channels", ircSockets.length >= 1 && /JOIN #uwoslab/.test(ircSockets.at(-1).joined) && /NICK justinfan/.test(ircSockets.at(-1).joined), ircSockets.at(-1)?.joined);
const cur = () => sockets.at(-1);
// live message, IRC says it's a first message (IRC arrives after EventSub)
cur().send(chat("999", "live-first", "FreshFace", "601", "hello!!"));
await sleep(100);
ircSockets.at(-1).send("@badges=;first-msg=1;id=live-first;room-id=999 :freshface!freshface@x PRIVMSG #uwoslab :hello!!\r\n");
await sleep(100);
check("first-time flag from IRC (arriving after EventSub)", await page.$eval('li[data-id="live-first"]', (l) => l.classList.contains("first")));
// IRC first, then EventSub
ircSockets.at(-1).send("@first-msg=1;id=live-first2 :a!a@x PRIVMSG #uwoslab :yo\r\n");
await sleep(50);
cur().send(chat("999", "live-first2", "Another", "602", "yo"));
await sleep(100);
check("first-time flag from IRC (arriving before EventSub)", await page.$eval('li[data-id="live-first2"]', (l) => l.classList.contains("first")));
// deletion keeps content
cur().send(chat("999", "del1", "Rude", "603", "something rude"));
await sleep(50);
cur().send(msg("notification", { subscription: { type: "channel.chat.message_delete" }, event: { broadcaster_user_id: "999", message_id: "del1" } }));
cur().send(chat("999", "ban1", "Banned", "604", "spam spam"));
await sleep(50);
cur().send(msg("notification", { subscription: { type: "channel.chat.clear_user_messages" }, event: { broadcaster_user_id: "999", target_user_id: "604", target_user_name: "Banned" } }));
await sleep(100);
check("deleted message keeps its content + flag", await page.$eval('li[data-id="del1"]', (l) => l.classList.contains("deleted") && l.querySelector(".body").textContent === "something rude" && l.textContent.includes("Deleted by a moderator")));
check("banned user's message keeps content + flag", await page.$eval('li[data-id="ban1"]', (l) => l.classList.contains("deleted") && l.querySelector(".body").textContent === "spam spam" && l.textContent.includes("timed out or banned")));
await page.evaluate(() => document.querySelector('.messages:not([hidden])').scrollTop = 1e9);
await page.screenshot({ path: dir + "/t4-flags.png" });

// ---- hidden: unread in title ----
await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
cur().send(chat("999", "bg1", "Someone", "605", "while you were away"));
cur().send(chat("888", "bg2", "Else", "606", "other tab too"));
await sleep(150);
check("title shows unread while hidden", (await page.title()) === "(2) Yappa", await page.title());
await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); });
await sleep(50);
check("title resets when visible", (await page.title()) === "Yappa", await page.title());

// ---- dead socket: watchdog notices silence, reconnects, backfills the gap ----
const subsBeforeDeath = log.subs.length;
const socketsBefore = sockets.length;
await page.evaluate(() => { keepaliveMs = 1000; resumedAt = 0; });   // speed up the watchdog for the test
gapMode = true; gapTs = Date.now() + 200;                              // messages sent "while dead"
await page.waitForFunction(() => document.body.innerText.includes("Caught up on"), null, { timeout: 15000 });
await sleep(400);
check("silent socket detected and replaced", sockets.length > socketsBefore && log.subs.length > subsBeforeDeath, sockets.length + " sockets");
const gap = await page.$$eval('.messages:not([hidden]) li', (ls) => ls.map((l) => l.textContent));
const iG1 = gap.findIndex((t) => t.includes("you missed this one")), iRe = gap.findIndex((t) => t.includes("Caught up on"));
check("missed messages backfilled above the reconnect line", iG1 >= 0 && iG1 < iRe, gap.slice(-5).join(" ‖ "));
check("reconnect line reports catch-up", gap[iRe] && gap[iRe].includes("Caught up on 2 missed messages"), gap[iRe]);
check("backfilled @mention highlighted", await page.$eval('li[data-id="g2"]', (l) => l.classList.contains("mentioned")));
check("reconnect asks only for the gap; first join asks for 100", log.history.some((h) => h === "uwoslab?limit=100") && log.history.slice(-2).some((h) => /^uwoslab\?limit=100&after=\d+$/.test(h)), JSON.stringify(log.history.slice(-3)));
check("no duplicate history after reconnect", (await page.$$('.messages:not([hidden]) li[data-id="h1"]')).length === 1);
await page.evaluate(() => { keepaliveMs = 30000; });

// =============== batch: live status, modes, BTTV/FFZ, cheers, AutoMod, user cards, hide, search, highlights, cycle bump, font ===============
await page.click(".tab:first-child .tab-name");
await page.waitForFunction(() => !document.querySelector(".tab:first-child .live-pill").hidden, null, { timeout: 5000 });
check("tab shows live viewer count", (await page.textContent(".tab:first-child .live-pill")) === "1.2k");
check("info bar: live + title + mode chips", await page.$eval("#infobar", (b) => !b.hidden && b.textContent.includes("1.2k") && b.textContent.includes("Building a chat app") && b.textContent.includes("Slow 10s")), await page.textContent("#infobar"));
check("other (offline, non-mod) tab has no live pill", await page.$eval(".tab:nth-child(2) .live-pill", (p) => p.hidden));
// Modes panel
await page.click("#modes-btn");
await page.selectOption("#modes-panel select >> nth=0", "30");
await page.waitForFunction(() => document.getElementById("modes").textContent.includes("Slow 30s"), null, { timeout: 3000 });
check("modes panel → slow 30s", JSON.stringify(log.settings.at(-1)) === '{"broadcaster_id":"999","slow_mode":true,"slow_mode_wait_time":30}', JSON.stringify(log.settings.at(-1)));
await page.click("#modes-panel input[type=checkbox] >> nth=1"); // emote-only
await page.waitForFunction(() => document.getElementById("modes").textContent.includes("Emote-only"), null, { timeout: 3000 });
check("modes panel → emote-only toggle", log.settings.at(-1).emote_mode === true);
await page.screenshot({ path: dir + "/t7-modes.png" });
await page.click("#modes-panel .panel-title button");
// live settings event
cur().send(msg("notification", { subscription: { type: "channel.chat_settings.update" }, event: { broadcaster_user_id: "999", emote_mode: false, follower_mode: true, follower_mode_duration_minutes: 10, slow_mode: false, slow_mode_wait_time_seconds: null, subscriber_mode: true, unique_chat_mode: false } }));
await sleep(150);
check("chat_settings.update event updates chips", (await page.textContent("#modes")) === "Followers 10mSub-only", await page.textContent("#modes"));
// BTTV / FFZ / cheers
cur().send(chat("999", "ext1", "EmoteFan", "701", "OMEGALUL uwuDance sharedOne ZrehplaR"));
cur().send(chat("999", "cheer1", "Cheerer", "702", "Cheer100 nice", { fragments: [{ type: "cheermote", text: "Cheer100", cheermote: { prefix: "Cheer", bits: 100, tier: 100 } }, { type: "text", text: " nice" }] }));
await sleep(150);
const extImgs = await page.$$eval('li[data-id="ext1"] img', (is) => is.map((i) => i.title));
check("BTTV global/channel/shared + FFZ emotes render", extImgs.join("|") === "OMEGALUL (BTTV)|uwuDance (BTTV)|sharedOne (BTTV)|ZrehplaR (FFZ)", extImgs.join("|"));
check("cheermote renders tier image + bits", await page.$eval('li[data-id="cheer1"]', (l) => l.querySelector("img").src.endsWith("cheer100.gif") && l.querySelector(".cheer-bits").textContent === "100"));
// AutoMod
cur().send(msg("notification", { subscription: { type: "automod.message.hold" }, event: { broadcaster_user_id: "999", user_id: "703", user_login: "edgy", user_name: "Edgy", message_id: "held1", message: { text: "something spicy", fragments: [{ type: "text", text: "something spicy" }] }, reason: "automod", automod: { category: "aggressive", level: 2, boundaries: [] }, blocked_term: null, held_at: new Date().toISOString() } }));
await page.waitForSelector('.automod[data-automod-id="held1"]');
check("AutoMod held message shown with reason", (await page.textContent('.automod[data-automod-id="held1"]')).includes("Held by AutoMod · aggressive (level 2)"));
await page.click('.automod[data-automod-id="held1"] button.allow');
await sleep(100);
check("Allow calls API", JSON.stringify(log.automod.at(-1)) === '{"msg_id":"held1","allow":true}', JSON.stringify(log.automod));
cur().send(msg("notification", { subscription: { type: "automod.message.update" }, event: { broadcaster_user_id: "999", moderator_user_name: "testuser", user_id: "703", message_id: "held1", status: "approved", message: { text: "", fragments: [] } } }));
await sleep(100);
check("AutoMod resolution shown", (await page.textContent('.automod[data-automod-id="held1"] .am-actions')) === "Allowed by testuser");
await page.screenshot({ path: dir + "/t8-automod.png" });
// User card
cur().send(chat("999", "card1", "Spammer", "333", "buy followers again"));
await page.waitForSelector('li[data-id="card1"]');
await page.click('li[data-id="card1"] .name');
await page.waitForFunction(() => document.getElementById("sheet-body").textContent.includes("Account created"), null, { timeout: 3000 });
const card = await page.textContent("#sheet-body");
check("user card: profile, follow age, recent messages, mod timeouts", card.includes("Following since") && card.includes("I sell followers") && card.includes("Recent messages here (1)") && card.includes("Timeout 1h"), card.slice(0, 200));
await page.screenshot({ path: dir + "/t9-card.png" });
await page.click('#sheet-body button:has-text("Timeout 1h")');
check("card timeout 1h", log.mods.at(-1).action === "timeout" && log.mods.at(-1).duration === 3600 && log.mods.at(-1).user_id === "333", JSON.stringify(log.mods.at(-1)));
// Hide user
await page.click('li[data-id="card1"] .name');
await page.click('#sheet-body button:has-text("Ignore")');
check("hide user hides their messages", await page.$eval('li[data-id="card1"]', (l) => getComputedStyle(l).display === "none"));
cur().send(chat("999", "u2b", "Spammer", "333", "more spam"));
await sleep(100);
check("new messages from hidden user are hidden too", await page.$eval('li[data-id="u2b"]', (l) => getComputedStyle(l).display === "none"));
await openSettingsUI();
check("settings lists the ignored user, with Unignore", (await page.textContent("#sheet-body")).includes("Ignored users") && (await page.textContent("#sheet-body")).includes("Spammer") && !!(await page.$('#sheet-body button:has-text("Unignore")')));
check("header shows the app icon (named for screen readers), not the word", await page.evaluate(() => { const h = document.querySelector("header h1"); const i = h.querySelector("img"); return !!i && i.alt === "Yappa" && h.textContent.trim() === "" && i.complete && i.naturalWidth > 0 && Math.round(i.getBoundingClientRect().width) === 30; }));
await page.click('#sheet-body .row button:has-text("Unignore")');
await page.click("#sheet-close");
check("unhide restores messages", await page.$eval('li[data-id="u2b"]', (l) => getComputedStyle(l).display !== "none"));
// Search
await page.click("#search-btn");
await page.fill("#search", "from:spam");
await sleep(50);
const vis = await page.$$eval(".messages:not([hidden]) > li", (ls) => ls.filter((l) => getComputedStyle(l).display !== "none").map((l) => l.dataset.id));
check("search from:user filters", vis.join(",") === "card1,u2b" && (await page.textContent("#search-count")) === "2 matches", vis.join(",") + " / " + (await page.textContent("#search-count")));
await page.fill("#search", "spicy");
await sleep(50);
check("search by text includes AutoMod items", (await page.textContent("#search-count")) === "1 match");
await page.click("#search-close");
check("closing search restores all", await page.$$eval(".messages:not([hidden]) > li.filtered", (ls) => ls.length) === 0);
// Highlights + font size
await openSettingsUI();
await page.fill('#sheet-body .rule-form input >> nth=0', "giveaway");
await page.click('#sheet-body .rule-form button');
await page.fill('#sheet-body .rule-form input >> nth=0', "deploy now");
await page.fill('#sheet-body .rule-form input >> nth=1', "@Host2");
await page.click('#sheet-body .rule-form button');
check("rules editor lists both rules", (await page.textContent("#sheet-body .rules")).includes("“deploy now”only from @host2"), await page.textContent("#sheet-body .rules"));
await page.click('#sheet-body .seg button:has-text("XL")');
await page.screenshot({ path: dir + "/t10-settings.png" });
await page.click("#sheet-close");
cur().send(chat("999", "hl1", "Host", "704", "GIVEAWAY starts now"));
cur().send(chat("999", "hl2", "Host", "704", "giveaways are fun")); // not a whole-word match
await sleep(100);
cur().send(chat("999", "hl3", "Host2", "705", "time to DEPLOY   now folks"));
cur().send(chat("999", "hl4", "Random", "706", "deploy now please"));
await sleep(100);
check("user-scoped rule: phrase only from that user", await page.$eval('li[data-id="hl3"]', (l) => l.classList.contains("highlighted")) && !(await page.$eval('li[data-id="hl4"]', (l) => l.classList.contains("highlighted"))));
await page.click('li[data-id="hl4"] .name');
await page.click('#sheet-body button:has-text("Highlight")');
cur().send(chat("999", "hl5", "Random", "706", "anything at all"));
await sleep(100);
check("user-only rule from the user card", await page.$eval('li[data-id="hl5"]', (l) => l.classList.contains("highlighted")));
check("old comma-separated words migrate to rules", await page.evaluate(() => { localStorage.setItem("settings", JSON.stringify({ highlights: "foo, bar baz" })); const r = loadSettings().rules; localStorage.setItem("settings", JSON.stringify(settings)); return JSON.stringify(r); }) === '[{"phrase":"foo","user":""},{"phrase":"bar baz","user":""}]');
check("highlight words (whole word, case-insensitive)", await page.$eval('li[data-id="hl1"]', (l) => l.classList.contains("highlighted")) && !(await page.$eval('li[data-id="hl2"]', (l) => l.classList.contains("highlighted"))));
check("font size XL applied", (await page.$eval(".messages:not([hidden]) .msg .body", (b) => getComputedStyle(b).fontSize)) === "18px");
check("settings persisted", JSON.parse(await page.evaluate(() => localStorage.getItem("settings"))).fontSize === 18);
// Color cycling from other apps
cycle.enabled = true;
await page.evaluate(() => refreshStatus());
await sleep(100);
cur().send(chat("999", "official-app-msg", "testuser", "111", "sent from the official app"));
await sleep(1800);
check("own message from another app bumps color (with its id, so other devices don't double it)", log.bumps === 1 && log.bumpIds[0] === "official-app-msg", JSON.stringify(log.bumpIds));
await page.fill("#message", "sent from here");
await page.press("#message", "Enter");
await sleep(150);
cur().send(chat("999", "sent-" + sendCounter, "testuser", "111", "sent from here"));
await sleep(1800);
check("own message sent from this app does not double-bump", log.bumps === 1, String(log.bumps));
cycle.enabled = false;

cur().send(chat("999", "own-nohex", "testuser", "111", "my own message"));
await page.waitForSelector('li[data-id="own-nohex"]');
check("own messages show no hex code", await page.$eval('li[data-id="own-nohex"]', (l) => !l.querySelector(".hex") && !/#[0-9A-F]{6}/i.test(l.textContent)), await page.textContent('li[data-id="own-nohex"]'));
// =============== stream player ===============
await page.click(".tab:first-child .tab-name");
await page.waitForSelector("#video:not([hidden]) iframe", { timeout: 5000 });
const src = await page.getAttribute("#video iframe", "src");
check("player for the live tab, with parent=", src.includes("channel=uwoslab") && src.includes("parent=yappa.test"), src);
await page.screenshot({ path: dir + "/t11-video-phone.png" });
const vbox = await page.$eval("#video", (v) => { const r = v.getBoundingClientRect(); return { w: r.width, h: r.height }; });
check("phone: video full width and exactly 16:9, so no letterbox bars", vbox.w >= 388 && Math.abs(vbox.w / vbox.h - 16 / 9) < 0.02, JSON.stringify(vbox));
await page.setViewportSize({ width: 430, height: 932 });
await sleep(200);
const vbig = await page.$eval("#video iframe", (v) => { const r = v.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
check("430px-wide phone: the player fills a 16:9 box too", vbig.w >= 400 && Math.abs(vbig.w / vbig.h - 16 / 9) < 0.02, JSON.stringify(vbig));
await page.setViewportSize({ width: 390, height: 760 });
await sleep(200);
await page.click(".tab:nth-child(2) .tab-name");
await sleep(100);
check("offline tab: player hidden and paused", await page.$eval("#video", (v) => v.hidden) && (await page.evaluate(() => __player.calls.at(-1)[0])) === "pause");
await page.click(".tab:first-child .tab-name");
await page.waitForSelector("#video:not([hidden]) iframe");
await page.click("#video-btn");
check("toggle hides the player and remembers it", await page.$eval("#video", (v) => v.hidden) && JSON.parse(await page.evaluate(() => localStorage.getItem("settings"))).video === false && (await page.getAttribute("#video-btn", "aria-pressed")) === "false");
await page.click("#video-btn");
await page.waitForSelector("#video:not([hidden]) iframe");
const pc = () => page.evaluate(() => __player.calls);
let calls = await pc();
check("one player created with autoplay + parent", calls.filter((c) => c[0] === "new").length === 1 && calls[0][1].autoplay === true && calls[0][1].parent[0] === "yappa.test" && calls[0][1].channel === "uwoslab", JSON.stringify(calls[0]));
// Twitch's embed rules: only Twitch's own player UI, never covered by other elements.
check("player uses Twitch's own controls, nothing drawn over it", calls[0][1].controls === undefined && (await page.$$("#video > :not(.player-host)")).length === 0, JSON.stringify(calls[0][1]));
check("starts muted only if the page hasn't been interacted with yet", typeof calls[0][1].muted === "boolean", String(calls[0][1].muted));
// another live tab: same player, setChannel (keeps unmuted state)
await page.evaluate(() => { tabs.get("otherchan").stream = { user_id: "888", title: "x", game_name: "y", viewer_count: 5, started_at: new Date().toISOString() }; });
await page.click(".tab:nth-child(2) .tab-name");
await sleep(150);
calls = await pc();
check("switching live tabs reuses the player via setChannel", calls.filter((c) => c[0] === "new").length === 1 && JSON.stringify(calls.slice(-2)) === '[["setChannel","otherchan"],["play"]]', JSON.stringify(calls.slice(-3)));
// autoplay with sound blocked → muted fallback
await page.evaluate(() => __player.handlers.playbackBlocked());
calls = await pc();
check("playback blocked → mute and play", JSON.stringify(calls.slice(-2)) === '[["setMuted",true],["play"]]', JSON.stringify(calls.slice(-2)));
await page.evaluate(() => { tabs.get("otherchan").stream = null; });
await page.click(".tab:first-child .tab-name");
await sleep(150);
calls = await pc();
check("back to first tab: setChannel back", JSON.stringify(calls.slice(-2)) === '[["setChannel","uwoslab"],["play"]]', JSON.stringify(calls.slice(-2)));
// ---- picture-in-picture ----
check("player iframe allows picture-in-picture", /picture-in-picture/.test(await page.getAttribute("#video iframe", "allow")), await page.getAttribute("#video iframe", "allow"));
check("PiP button shown while video is up", !(await page.$eval("#pip-btn", (b) => b.hidden)));
const popupP = ctx.waitForEvent("page");
await page.click("#pip-btn");
const pip = await popupP;
await sleep(300);
check("PiP: player moved into the PiP window", (await pip.$$("#video.in-pip iframe")).length === 1 && !(await page.$("#video")) && !(await page.$eval(".app", (a) => a.classList.contains("with-video"))));
await pip.setViewportSize({ width: 480, height: 270 });
await sleep(400);
const pipBox = await pip.evaluate(() => { const f = document.querySelector("#video iframe").getBoundingClientRect(); return { w: Math.round(f.width), h: Math.round(f.height), css: [...document.styleSheets].length }; });
check("PiP: player fills the PiP window", pipBox.w === 480 && pipBox.h === 270, JSON.stringify(pipBox));
await pip.screenshot({ path: dir + "/t15-pip.png" });
check("PiP: setChannel still reaches the player", await page.evaluate(() => { tabs.get("otherchan").stream = { user_id: "888", title: "x", game_name: "y", viewer_count: 5, started_at: new Date().toISOString() }; return true; }));
await page.click(".tab:nth-child(2) .tab-name");
await sleep(150);
check("PiP: switching tabs switches the PiP stream", JSON.stringify((await pc()).slice(-2)) === '[["setChannel","otherchan"],["play"]]' && (await pip.$$("#video iframe")).length === 1);
await page.evaluate(() => { tabs.get("otherchan").stream = null; });
await page.click(".tab:first-child .tab-name");
await sleep(150);
await pip.close();
await sleep(300);
check("closing PiP brings the player back", await page.$eval("#video", (v) => !v.hidden && !v.classList.contains("in-pip") && !!v.querySelector("iframe")) && await page.$eval(".app", (a) => a.classList.contains("with-video")) && (await page.getAttribute("#pip-btn", "aria-pressed")) === "false");
check("PiP button hidden where unsupported", await page.evaluate(() => { const keep = window.documentPictureInPicture; delete window.documentPictureInPicture; renderVideo(); const hidden = document.getElementById("pip-btn").hidden; window.documentPictureInPicture = keep; renderVideo(); return hidden; }));
await page.setViewportSize({ width: 1280, height: 800 });
await sleep(200);
const lay = await page.evaluate(() => {
  const v = document.getElementById("video").getBoundingClientRect(), c = document.getElementById("chat").getBoundingClientRect(), f = document.querySelector("#video iframe").getBoundingClientRect();
  return { vRight: Math.round(v.right), cLeft: Math.round(c.left), cW: Math.round(c.width), fRatio: f.width / f.height, docW: document.documentElement.scrollWidth };
});
check("wide: video left, 380px chat column right", lay.vRight <= lay.cLeft + 1 && lay.cW === 380 && Math.abs(lay.fRatio - 16 / 9) < 0.05 && lay.docW === 1280, JSON.stringify(lay));
await page.screenshot({ path: dir + "/t12-video-wide.png" });
await page.setViewportSize({ width: 390, height: 760 });

// =============== native (HLS) player, opt-in ===============
{
  await page.click(".tab:first-child .tab-name");
  await page.waitForSelector("#video:not([hidden]) iframe");
  // Make this browser take the hls.js path (headless Chromium may claim built-in HLS).
  await page.evaluate(() => { HTMLMediaElement.prototype.canPlayType = () => ""; });
  await openSettingsUI();
  check("Settings offers Twitch player / Native", (await page.textContent("#sheet-body")).includes("Native (HLS)"));
  await page.click('#sheet-body .seg button:has-text("Native (HLS)")');
  await page.click("#sheet-close");
  await page.waitForFunction(() => window.__hls && __hls.instances.length === 1 && __hls.instances[0].calls.length >= 2, null, { timeout: 5000 });
  const nat = await page.evaluate(() => {
    const v = document.querySelector("#video video"), h = __hls.instances[0];
    return { iframe: !!document.querySelector("#video iframe"), video: !!v, mutedOk: v && v.muted === !navigator.userActivation.hasBeenActive, inline: v && v.playsInline, controls: v && v.controls,
      worker: h.cfg.enableWorker, src: h.calls[0][1], attach: h.calls[1] };
  });
  const su = new URL(nat.src);
  check("Native: a <video> (inline, browser controls; muted until the page has been tapped) replaces the embed", nat.video && !nat.iframe && nat.mutedOk && nat.inline && nat.controls, JSON.stringify(nat));
  check("Native: playback token from Twitch's GQL in the browser, as Twitch's web client", log.gql.at(-1).login === "uwoslab" && log.gql.at(-1).clientId === "kimne78kx3ncx6brgo4mv6wki5h1ko", JSON.stringify(log.gql.at(-1)));
  check("Native: hls.js loads the usher playlist with the token (no web worker: CSP)",
    su.host === "usher.ttvnw.net" && su.pathname === "/api/channel/hls/uwoslab.m3u8" && su.searchParams.get("sig") === "sig-uwoslab" && JSON.parse(su.searchParams.get("token")).channel === "uwoslab" &&
    nat.attach[1] === "VIDEO" && nat.worker === false, nat.src);
  check("Native: saved", JSON.parse(await page.evaluate(() => localStorage.getItem("settings"))).player === "native");
  const nativeH = await page.$eval("#video", (v) => Math.round(v.getBoundingClientRect().height));
  check("Native on a phone: plain 16:9 without the embed's extra height (more chat)", nativeH > 200 && nativeH < 260, String(nativeH));
  // Switching to another live tab loads that channel; the old pipeline is torn down.
  await page.evaluate(() => { tabs.get("otherchan").stream = { user_id: "888", title: "x", game_name: "y", viewer_count: 5, started_at: new Date().toISOString() }; });
  await page.click(".tab:nth-child(2) .tab-name");
  await page.waitForFunction(() => __hls.instances.length === 2 && __hls.instances[1].calls.length >= 2, null, { timeout: 5000 });
  check("Native: switching tabs loads the new channel, same <video>", await page.evaluate(() => __hls.instances[0].destroyed && __hls.instances[1].calls[0][1].includes("/otherchan.m3u8") && document.querySelectorAll("#video video").length === 1));
  // A fatal error falls back to Twitch's player, saying why.
  await page.evaluate(() => __hls.instances[1].fire("hlsError", { fatal: true, type: "networkError", details: "manifestLoadError" }));
  await page.waitForSelector("#video iframe", { timeout: 5000 });
  const fb = await page.evaluate(() => ({ video: !!document.querySelector("#video video"), msg: [...active.list.querySelectorAll(".sys.err")].at(-1).textContent }));
  check("Native failure falls back to Twitch's player with the reason", !fb.video && fb.msg.includes("manifestLoadError") && fb.msg.includes("Twitch's player"), JSON.stringify(fb));
  // A token error does the same; choosing Native again in Settings retries.
  await page.evaluate(() => { tabs.get("otherchan").stream = null; });
  await page.click(".tab:first-child .tab-name");
  await page.evaluate(() => setPlayer("native"));
  await page.waitForFunction(() => !!document.querySelector("#video video"), null, { timeout: 5000 });
  check("Choosing Native again retries after a fallback", await page.evaluate(() => !document.querySelector("#video iframe")));
  // Built-in HLS fails (as in Chrome) → hls.js gets a turn → it fails too (CORS) → embed, with both reasons.
  await page.evaluate(() => { HTMLMediaElement.prototype.canPlayType = () => "maybe"; setPlayer("native"); });
  await page.waitForFunction(() => { const v = document.querySelector("#video video"); return v && (v.getAttribute("src") || "").includes("usher.ttvnw.net"); }, null, { timeout: 5000 });
  check("built-in HLS is tried first, with the playlist URL", await page.evaluate(() => __hls.instances.length === __hls.instances.length && !document.querySelector("#video iframe")));
  const hlsBefore = await page.evaluate(() => __hls.instances.length);
  await page.evaluate(() => document.querySelector("#video video").dispatchEvent(new Event("error")));
  await page.waitForFunction((n) => __hls.instances.length === n + 1 && __hls.instances.at(-1).calls.length >= 2, hlsBefore, { timeout: 5000 });
  check("built-in failure → hls.js tries as the last resort", true);
  await page.evaluate(() => __hls.instances.at(-1).fire("hlsError", { fatal: true, type: "networkError", details: "manifestLoadError", response: { code: 0 }, url: "https://usher.ttvnw.net/api/channel/hls/uwoslab.m3u8" }));
  await page.waitForSelector("#video iframe", { timeout: 5000 });
  const both = await page.evaluate(() => [...active.list.querySelectorAll(".sys.err")].at(-1).textContent);
  check("all attempts failed → embed, message names each reason", both.includes("built-in: unknown error") && both.includes("hls.js: manifestLoadError (blocked by the browser, likely CORS) loading usher.ttvnw.net"), both);
  await page.evaluate(() => { HTMLMediaElement.prototype.canPlayType = () => ""; });
  const tokErr = await page.evaluate(async () => { try { await hlsUrl("brokenchan"); return "no error"; } catch (e) { return e.message; } });
  check("Token errors are reported", tokErr === "service error", tokErr);
  await page.evaluate(() => setPlayer("embed"));
  await page.waitForSelector("#video iframe", { timeout: 5000 });
  check("Back to Twitch's player", await page.evaluate(() => !document.querySelector("#video video") && JSON.parse(localStorage.getItem("settings")).player === "embed"));
  check("Embed is the same plain 16:9 as native", await page.$eval("#video", (v) => { const r = v.getBoundingClientRect(); return Math.abs(r.width / r.height - 16 / 9) < 0.02; }));
  await page.evaluate(() => { tabs.get("otherchan").stream = null; });
  // The real hls.js must load under the page's CSP (script-src 'self', no eval, no blob: workers).
  const real = await page.evaluate(() => new Promise((resolve) => {
    const keep = window.Hls;
    const sc = document.createElement("script");
    sc.src = "/hls.js?real";
    sc.onload = () => { const ok = typeof Hls === "function" && Hls.isSupported() !== undefined && Hls !== keep; window.Hls = keep; resolve(ok); };
    sc.onerror = () => resolve(false);
    document.head.appendChild(sc);
  }));
  check("real hls.js loads under the CSP", real);
}

// =============== Open on Twitch (Bits and channel points) ===============
{
  const m = await page.evaluate(() => Object.fromEntries(["emote-btn", "twitch-btn", "message", "send"].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [id, { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10 }]; })));
  check("emote and gem buttons are the same size, and aligned with each other and the message box",
    m["emote-btn"].w === m["twitch-btn"].w && m["emote-btn"].h === m["twitch-btn"].h && m["emote-btn"].w === 38 && m["emote-btn"].h === 38 &&
    m["emote-btn"].top === m["twitch-btn"].top && m["emote-btn"].bottom === m["twitch-btn"].bottom && m["emote-btn"].top === m["message"].top, JSON.stringify(m));
  check("the Chat button is the same height and top/bottom as the message box", m.send.h === m.message.h && m.send.top === m.message.top && m.send.bottom === m.message.bottom, JSON.stringify(m.send));
  const gap = await page.evaluate(() => { const a = document.getElementById("emote-btn").getBoundingClientRect(), b = document.getElementById("twitch-btn").getBoundingClientRect(), c = document.getElementById("message").getBoundingClientRect(); return [Math.round(b.left - a.right), Math.round(c.left - b.right)]; });
  check("even spacing between the buttons and the message box", gap[0] === gap[1], JSON.stringify(gap));
}
{
  await page.click(".tab:first-child .tab-name");
  const btn = await page.$eval("#twitch-btn", (b) => ({ disabled: b.disabled, label: b.getAttribute("aria-label"), next: b.previousElementSibling.id, w: Math.round(b.getBoundingClientRect().width) }));
  check("button sits right after the emote button, small, labelled", !btn.disabled && btn.next === "emote-btn" && btn.w < 44 && btn.label.includes("Bits and channel points"), JSON.stringify(btn));
  await page.screenshot({ path: dir + "/t26-twitch-btn.png" });
  await page.evaluate(() => {
    window.__calls = [];
    appFallbackMs = 150;
    launchers.app = (u) => __calls.push(["app", u]);
    launchers.window = (u, n, f) => { __calls.push(["window", u, n || "", f || ""]); return window.__popupBlocked ? null : {}; };
  });
  // Phone: the app first, then the website if this page is still in front.
  await page.tap("#twitch-btn");
  check("phone: tries the Twitch app first", JSON.stringify(await page.evaluate(() => __calls)) === '[["app","twitch://stream/uwoslab"]]');
  await sleep(400);
  check("phone: app didn't take over → opens twitch.tv", JSON.stringify((await page.evaluate(() => __calls)).slice(1)) === '[["window","https://www.twitch.tv/uwoslab","_blank",""]]', JSON.stringify(await page.evaluate(() => __calls)));
  // The app opening (page loses focus) cancels the website fallback.
  await page.evaluate(() => { __calls.length = 0; });
  await page.tap("#twitch-btn");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await sleep(400);
  check("phone: app opened (page blurred) → no website fallback", JSON.stringify(await page.evaluate(() => __calls)) === '[["app","twitch://stream/uwoslab"]]');
  // A blocked fallback leaves a link in chat instead.
  await page.evaluate(() => { __calls.length = 0; window.__popupBlocked = true; });
  await page.tap("#twitch-btn");
  await sleep(400);
  const linkLine = await page.evaluate(() => { const a = [...active.list.querySelectorAll(".sys a.link")].at(-1); return a && a.href; });
  check("blocked fallback → tappable link in chat", linkLine === "https://www.twitch.tv/uwoslab", String(linkLine));
  // Desktop: the pop-out chat window (or a tab if the popup is blocked).
  await page.evaluate(() => { __calls.length = 0; window.__popupBlocked = false; openOnTwitch(active, false); });
  check("desktop: pop-out chat window", JSON.stringify(await page.evaluate(() => __calls)) === '[["window","https://www.twitch.tv/popout/uwoslab/chat?popout=","twitch-popout","popup,width=420,height=720"]]', JSON.stringify(await page.evaluate(() => __calls)));
  await page.evaluate(() => { __calls.length = 0; window.__popupBlocked = true; openOnTwitch(active, false); });
  check("desktop, popup blocked → opens a tab instead", (await page.evaluate(() => __calls)).length === 2 && (await page.evaluate(() => __calls[1][1])) === "https://www.twitch.tv/uwoslab");
  await page.evaluate(() => { window.__popupBlocked = false; });
}

// =============== chat embed window (experimental) ===============
{
  await page.click(".tab:first-child .tab-name");
  await page.evaluate(() => { __calls.length = 0; });
  // Default: the gem button still hands off to Twitch.
  await page.evaluate(() => { launchers.app = (u) => __calls.push(["app", u]); });
  await page.tap("#twitch-btn");
  check("default: gem button does not open the embed", await page.$eval("#embed-modal", (m) => m.hidden) && (await page.evaluate(() => __calls.length)) === 1);
  await sleep(400); // let that tap's website-fallback timer run out
  await page.evaluate(() => { __calls.length = 0; });
  await openSettingsUI();
  check("Settings has the Bits and channel points option", (await page.textContent("#sheet-body")).includes("Bits and channel points") && (await page.textContent("#sheet-body")).includes("Chat embed (experimental)"));
  await page.click('#sheet-body .seg button:has-text("Chat embed")');
  await page.click("#sheet-close");
  check("saved", JSON.parse(await page.evaluate(() => localStorage.getItem("settings"))).bitsButton === "embed");
  await page.tap("#twitch-btn");
  await page.waitForSelector("#embed-modal:not([hidden]) .chat-embed:not([hidden])");
  const emb = await page.evaluate(() => { const f = document.querySelector("#embed-modal .chat-embed:not([hidden])"); const r = f.getBoundingClientRect(); return { src: f.src, h: Math.round(r.height), w: Math.round(r.width), title: document.getElementById("embed-title").textContent }; });
  check("embed window: Twitch's official chat embed, parent= this site, dark", emb.src === "https://www.twitch.tv/embed/uwoslab/chat?parent=yappa.test&darkpopout" && emb.title === "Twitch chat: UwoSlab", JSON.stringify(emb));
  check("embed window is big enough to use on a phone", emb.h >= 300 && emb.w >= 330, JSON.stringify(emb));
  await sleep(300);
  check("the embed page actually loaded", log.chatEmbeds.includes("/embed/uwoslab/chat?parent=yappa.test&darkpopout"), JSON.stringify(log.chatEmbeds));
  await page.screenshot({ path: dir + "/t27-chat-embed.png" });
  check("light theme: no darkpopout", await page.evaluate(() => { document.documentElement.dataset.theme = "light"; const u = chatEmbedUrl("x"); document.documentElement.dataset.theme = "dark"; return u === "https://www.twitch.tv/embed/x/chat?parent=yappa.test"; }));

  // Minimizing keeps the same loaded iframe, so Twitch's sign-in and storage grant survive.
  await page.evaluate(() => { document.querySelector("#embed-modal .chat-embed").__marker = "loaded-once"; });
  const loadsBefore = (await page.evaluate(() => 0)) + log.chatEmbeds.length;
  await page.click("#embed-close");
  check("× minimizes: window hidden, iframe still in the page", await page.$eval("#embed-modal", (m) => m.hidden) && (await page.$$("#embed-frames iframe")).length === 1);
  await page.tap("#twitch-btn");
  await page.waitForSelector("#embed-modal:not([hidden])");
  await sleep(300);
  check("reopening shows the same loaded iframe (no reload)", await page.evaluate(() => document.querySelector("#embed-modal .chat-embed:not([hidden])").__marker === "loaded-once") && log.chatEmbeds.length === loadsBefore, String(log.chatEmbeds.length - loadsBefore));
  await page.keyboard.press("Escape");
  check("Escape also just minimizes", await page.$eval("#embed-modal", (m) => m.hidden) && (await page.$$("#embed-frames iframe")).length === 1);
  // Another channel gets its own frame; the first stays loaded but hidden.
  await page.click(".tab:nth-child(2) .tab-name");
  await page.tap("#twitch-btn");
  await page.waitForSelector("#embed-modal:not([hidden])");
  const two = await page.evaluate(() => [...document.querySelectorAll("#embed-frames iframe")].map((f) => f.src.split("/embed/")[1].split("/")[0] + (f.hidden ? ":hidden" : ":shown")));
  check("each channel keeps its own frame; only the current one is shown", JSON.stringify(two) === '["uwoslab:hidden","otherchan:shown"]', JSON.stringify(two));
  await page.click("#embed-close");
  // Only the last few stay loaded.
  await page.evaluate(() => { for (const l of ["fakea", "fakeb", "fakec"]) openChatEmbed({ login: l }); hideChatEmbed(); });
  const kept = await page.evaluate(() => [...embedFrames.keys()].join(","));
  check("at most 3 chats stay loaded (oldest dropped)", kept === "fakea,fakeb,fakec" && (await page.$$("#embed-frames iframe")).length === 3, kept);
  // Closing a channel's tab drops its chat; Reload recreates the current one.
  await page.evaluate(() => { dropChatEmbed("fakea"); dropChatEmbed("fakeb"); dropChatEmbed("fakec"); openChatEmbed({ login: "uwoslab" }); });
  await page.evaluate(() => { document.querySelector("#embed-modal .chat-embed:not([hidden])").__marker = "old"; });
  await page.click("#embed-reload");
  await sleep(200);
  check("Reload makes a fresh frame", await page.evaluate(() => document.querySelector("#embed-modal .chat-embed:not([hidden])").__marker === undefined && embedFrames.size === 1));
  check("the embed window has no disclaimer text, just title, chat and buttons", await page.evaluate(() => !document.getElementById("embed-note") && /^× Twitch chat: \w+ ReloadOpen the app$/i.test(document.querySelector("#embed-modal .sheet").textContent.replace(/\s+/g, " ").trim())), await page.evaluate(() => document.querySelector("#embed-modal .sheet").textContent.replace(/\s+/g, " ").trim()));
  // The Firefox tip lives in Settings (and only shows on Firefox).
  const tipFor = (ua) => page.evaluate(async (ua) => {
    Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
    openSettings();
    const text = document.getElementById("sheet-body").textContent;
    closeSheet();
    delete navigator.userAgent;
    return text.includes("Enhanced Tracking Protection");
  }, ua);
  check("Settings shows the tracking-protection tip on Firefox only", (await tipFor("Mozilla/5.0 (Android 16; Mobile; rv:157.0) Gecko/157.0 Firefox/157.0")) && !(await tipFor("Mozilla/5.0 Chrome/126 Mobile Safari/537.36")));
  // The escape hatch to the real thing.
  await page.tap("#embed-go");
  check("'Open the app' minimizes and hands off to Twitch", await page.$eval("#embed-modal", (m) => m.hidden) && JSON.stringify(await page.evaluate(() => __calls)) === '[["app","twitch://stream/uwoslab"]]', JSON.stringify(await page.evaluate(() => __calls)));
  await sleep(400); // the pending website-fallback timer
  await page.evaluate(() => { for (const l of [...embedFrames.keys()]) dropChatEmbed(l); settings.bitsButton = "twitch"; saveSettings(); __calls.length = 0; });
}

// =============== Twitch player script blocked (Firefox tracking protection, ad blockers) ===============
{
  await page.click(".tab:first-child .tab-name");
  await page.evaluate(() => { HTMLMediaElement.prototype.canPlayType = () => "maybe"; });
  embedScriptFails = true;
  await page.evaluate(() => { teardownEmbed(); embedScript = null; renderVideo(); });
  await page.waitForSelector("#video .video-error");
  const ve = await page.textContent("#video .video-error");
  check("blocked player script → explanation in the video box with Try again and native buttons",
    ve.includes("Twitch's player couldn't load") && ve.includes("tracking protection") && ve.includes("Try again") && ve.includes("Use native player") && !(await page.$("#video iframe")), ve);
  await page.screenshot({ path: dir + "/t25-player-blocked.png" });
  await page.evaluate(() => { renderVideo(); renderVideo(); });
  await sleep(300);
  check("no retry loop or duplicate panels on refresh", await page.evaluate(() => document.querySelectorAll("#video .video-error").length === 1));
  embedScriptFails = false;
  await page.click('#video button:has-text("Try again")');
  await page.waitForSelector("#video iframe", { timeout: 5000 });
  check("Try again loads the player once the block is lifted", !(await page.$("#video .video-error")));
  // Offer the native player from the panel.
  embedScriptFails = true;
  await page.evaluate(() => { teardownEmbed(); embedScript = null; renderVideo(); });
  await page.waitForSelector("#video .video-error");
  await page.click('#video button:has-text("Use native player")');
  await page.waitForSelector("#video video", { timeout: 5000 });
  check("Use native player switches (and saves) the setting", JSON.parse(await page.evaluate(() => localStorage.getItem("settings"))).player === "native" && !(await page.$("#video .video-error")));
  embedScriptFails = false;
  await page.evaluate(() => { setPlayer("embed"); HTMLMediaElement.prototype.canPlayType = () => ""; });
  await page.waitForSelector("#video iframe", { timeout: 5000 });
}

// =============== chat holds still once you scroll up ===============
{
  await page.click(".tab:first-child .tab-name");
  for (let i = 0; i < 30; i++) cur().send(chat("999", "fill" + i, "Filler", "990", "filler line " + i));
  await page.waitForSelector('li[data-id="fill29"]');
  check("at the bottom: new messages follow", await page.evaluate(() => atBottom(active)));
  await page.evaluate(() => { active.list.scrollTop -= 10; });   // the smallest scroll up
  await sleep(100);
  const topBefore = await page.evaluate(() => active.list.scrollTop);
  cur().send(chat("999", "hold1", "Viewer", "701", "arrives while scrolled up a little"));
  await page.waitForSelector('li[data-id="hold1"]');
  await sleep(100);
  check("scrolled up even 10px: chat stays put, 'More messages below' shown", (await page.evaluate(() => active.list.scrollTop)) === topBefore && !(await page.$eval("#more", (b) => b.hidden)), String(topBefore));
  await page.click("#more");
  await sleep(100);
  cur().send(chat("999", "hold2", "Viewer", "701", "after returning to the bottom"));
  await page.waitForSelector('li[data-id="hold2"]');
  await sleep(100);
  check("'More messages below' resumes following", await page.evaluate(() => atBottom(active)));
  // Text selected in chat (copying an error, say) also holds it still.
  await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('li[data-id="hold2"] .body')); getSelection().removeAllRanges(); getSelection().addRange(r); });
  const selTop = await page.evaluate(() => active.list.scrollTop);
  cur().send(chat("999", "hold3", "Viewer", "701", "arrives while text is selected"));
  await page.waitForSelector('li[data-id="hold3"]');
  await sleep(100);
  check("selected text: chat holds still", (await page.evaluate(() => active.list.scrollTop)) === selTop && (await page.evaluate(() => getSelection().toString())) === "after returning to the bottom");
  await page.evaluate(() => getSelection().removeAllRanges());
  // A finger on the chat holds it too.
  await page.evaluate(() => scrollToBottom(active));
  await page.dispatchEvent(".messages:not([hidden])", "pointerdown");
  const holdTop = await page.evaluate(() => active.list.scrollTop);
  cur().send(chat("999", "hold4", "Viewer", "701", "arrives under a finger"));
  await page.waitForSelector('li[data-id="hold4"]');
  await sleep(100);
  check("finger on the chat: holds still", (await page.evaluate(() => active.list.scrollTop)) === holdTop);
  await page.evaluate(() => window.dispatchEvent(new Event("pointerup")));
  cur().send(chat("999", "hold5", "Viewer", "701", "after lifting the finger"));
  await page.waitForSelector('li[data-id="hold5"]');
  await sleep(100);
  check("finger lifted: follows again", await page.evaluate(() => atBottom(active)));
}

// =============== native player recovers when playback stops ===============
{
  await page.click(".tab:first-child .tab-name");
  await page.evaluate(() => { HTMLMediaElement.prototype.canPlayType = () => "maybe"; setPlayer("native"); });
  await page.waitForFunction(() => native && native.way === "built-in" && !!document.querySelector("#video video").getAttribute("src"), null, { timeout: 5000 });
  const stopped = () => page.evaluate(() => [...active.list.querySelectorAll(".sys")].filter((l) => l.textContent.startsWith("The native stream stopped")).map((l) => l.textContent));
  const tokens0 = log.gql.length;
  const freeze = (secs, paused) => page.evaluate(([secs, paused]) => {
    const v = document.querySelector("#video video");
    Object.defineProperty(v, "paused", { get: () => paused, configurable: true });
    native.hasPlayed = true; native.progressAt = Date.now() - secs * 1000; native.lastTime = v.currentTime;
    v.dispatchEvent(new Event("waiting")); v.dispatchEvent(new Event("stalled"));
    nativeWatchdog();
  }, [secs, paused]);
  await freeze(60, true);
  await sleep(300);
  check("a paused video isn't treated as stalled", log.gql.length === tokens0 && (await stopped()).length === 0);
  await freeze(3, false);
  await sleep(300);
  check("briefly slow isn't a stall either", log.gql.length === tokens0 && (await stopped()).length === 0);
  await freeze(12, false);
  await sleep(500);
  let msgs = await stopped();
  check("frozen for 12s → fresh playback token, playlist reloaded, said in chat with what the video did",
    log.gql.length === tokens0 + 1 && msgs.length === 1 && msgs[0].includes("no video for 12s") && msgs[0].includes("waiting") && msgs[0].includes("stalled") && msgs[0].includes("Reconnecting"), JSON.stringify(msgs));
  check("still the native player after recovering", await page.evaluate(() => !!document.querySelector("#video video") && !document.querySelector("#video iframe") && (document.querySelector("#video video").getAttribute("src") || "").includes("usher.ttvnw.net")));
  await page.evaluate(() => document.querySelector("#video video").dispatchEvent(new Event("ended")));
  await sleep(500);
  msgs = await stopped();
  check("a live stream 'ending' reconnects", log.gql.length === tokens0 + 2 && msgs.at(-1).includes("the stream ended"), JSON.stringify(msgs.at(-1)));
  await page.evaluate(() => document.querySelector("#video video").dispatchEvent(new Event("error")));
  await sleep(500);
  check("an error after it was playing reconnects instead of giving up", log.gql.length === tokens0 + 3 && !(await page.$("#video iframe")), String(log.gql.length - tokens0));
  await page.evaluate(() => document.querySelector("#video video").dispatchEvent(new Event("ended")));
  await page.waitForSelector("#video iframe", { timeout: 5000 });
  const gaveUp = await page.evaluate(() => [...active.list.querySelectorAll(".sys.err")].at(-1).textContent);
  check("stopping over and over → gives up and uses Twitch's player, saying why", log.gql.length === tokens0 + 3 && gaveUp.includes("kept stopping"), gaveUp);
  await page.evaluate(() => { setPlayer("embed"); HTMLMediaElement.prototype.canPlayType = () => ""; });
  await page.waitForSelector("#video iframe", { timeout: 5000 });
  check("no watchdog left running after teardown", await page.evaluate(() => native === null));
}

// =============== native player: choosing the quality ===============
{
  // The Worker's relay: strict about its inputs, only ever talks to usher.
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

  // Parsing and choosing.
  const parsed = await page.evaluate((text) => parseMaster(text).map((v) => [v.group, v.name, v.height, v.fps]), MASTER);
  check("master playlist parsed: best first, source included, audio-only last", JSON.stringify(parsed) === JSON.stringify([["chunked", "1080p60 (source)", 1080, 60], ["720p60", "720p60", 720, 60], ["480p30", "480p", 480, 30], ["360p30", "360p", 360, 30], ["160p30", "160p", 160, 30], ["audio_only", "audio_only", 0, 0]]), JSON.stringify(parsed));
  const picks = await page.evaluate((text) => { const l = parseMaster(text); const g = (p) => { const v = pickVariant(l, p); return v ? v.group : null; }; return { auto: g("auto"), exact: g("360p30"), source: g("chunked"), audio: g("audio_only"), higher: g("1440p60"), missing: g("720p30"), small: g("100p30"), none: g(undefined), empty: pickVariant([], "720p60") }; }, MASTER);
  check("a saved choice maps to what the channel offers (exact, else best that's no taller)", JSON.stringify(picks) === JSON.stringify({ auto: null, exact: "360p30", source: "chunked", audio: "audio_only", higher: "chunked", missing: "720p60", small: "160p30", none: null, empty: null }), JSON.stringify(picks));

  // In the page.
  await page.click(".tab:first-child .tab-name");
  await page.evaluate(() => { HTMLMediaElement.prototype.canPlayType = () => "maybe"; settings.nativeQuality = "auto"; setPlayer("native"); });
  await page.waitForFunction(() => native && native.way === "built-in" && native.variants.length === 6, null, { timeout: 8000 });
  const startSrc = await page.evaluate(() => document.querySelector("#video video").getAttribute("src"));
  check("Auto starts right away on the usher master playlist", startSrc.includes("usher.ttvnw.net") && !startSrc.includes("allow_audio_only"), startSrc);
  const lastMaster = log.master.at(-1);
  check("the page asked the Worker for the quality list, with the playback token", lastMaster.login === "uwoslab" && lastMaster.sig === "sig-uwoslab" && JSON.parse(lastMaster.token).channel === "uwoslab", JSON.stringify(lastMaster).slice(0, 120));
  check("quality button appears, showing Auto", await page.$eval("#quality-btn", (b) => !b.hidden && b.textContent === "Auto"));
  await page.click("#quality-btn");
  const menu = await page.$$eval("#quality-menu button", (bs) => bs.map((b) => b.textContent + (b.classList.contains("on") ? "*" : "")));
  check("menu lists Auto (current), each rendition and Audio only", JSON.stringify(menu) === JSON.stringify(["Auto*", "1080p60 (source)", "720p60", "480p", "360p", "160p", "Audio only"]), JSON.stringify(menu));
  const tapH = await page.$eval("#quality-menu button", (b) => Math.round(b.getBoundingClientRect().height));
  check("menu rows are touch-sized", tapH >= 44, String(tapH));
  await page.screenshot({ path: dir + "/t30-quality-menu.png" });
  await page.click('#quality-menu button:has-text("480p")');
  const picked = await page.evaluate(() => ({ src: document.querySelector("#video video").getAttribute("src"), saved: JSON.parse(localStorage.getItem("settings")).nativeQuality, label: document.getElementById("quality-btn").textContent, open: !document.getElementById("quality-menu").hidden }));
  check("picking 480p plays that rendition's own playlist, remembers it, shows it, closes the menu",
    picked.src === "https://use23.playlist.ttvnw.net/v1/playlist/480p30.m3u8" && picked.saved === "480p30" && picked.label === "480p" && !picked.open, JSON.stringify(picked));
  await page.click("#quality-btn");
  await page.click('#quality-menu button:has-text("Audio only")');
  check("Audio only works too, button says Audio", (await page.getAttribute("#video video", "src")).endsWith("/audio_only.m3u8") && (await page.textContent("#quality-btn")) === "Audio");
  await page.click("#quality-btn");
  await page.click('#quality-menu button:has-text("1080p60")');
  check("Source is labelled Source on the button", (await page.textContent("#quality-btn")) === "Source" && (await page.getAttribute("#video video", "src")).endsWith("/chunked.m3u8"));
  await page.click("#quality-btn");
  await page.click('#quality-menu button:has-text("Auto")');
  check("back to Auto: the master playlist again", (await page.getAttribute("#video video", "src")).includes("usher.ttvnw.net") && (await page.textContent("#quality-btn")) === "Auto" && JSON.parse(await page.evaluate(() => localStorage.getItem("settings"))).nativeQuality === "auto");
  await page.click("#quality-btn");
  await page.keyboard.press("Escape");
  check("Escape closes the menu", await page.$eval("#quality-menu", (m) => m.hidden));

  // A saved choice is applied when the stream (re)starts, with a fresh token.
  await page.evaluate(() => { settings.nativeQuality = "720p60"; saveSettings(); });
  const masters0 = log.master.length;
  await page.evaluate(() => nativeRestart("test"));
  await page.waitForFunction(() => (document.querySelector("#video video").getAttribute("src") || "").endsWith("/720p60.m3u8"), null, { timeout: 8000 });
  check("a restart plays the saved quality (waiting for the list first)", log.master.length === masters0 + 1 && (await page.textContent("#quality-btn")) === "720p60");
  // ...and when you open another channel.
  await page.evaluate(() => { tabs.get("otherchan").stream = { user_id: "888", title: "x", game_name: "y", viewer_count: 5, started_at: new Date().toISOString() }; });
  await page.click(".tab:nth-child(2) .tab-name");
  await page.waitForFunction(() => native && native.master && native.master.includes("/otherchan.m3u8") && native.activeGroup === "720p60" && (document.querySelector("#video video").getAttribute("src") || "").endsWith("/720p60.m3u8"), null, { timeout: 8000 });
  check("the choice follows you to another channel", log.master.at(-1).login === "otherchan");
  await page.evaluate(() => { tabs.get("otherchan").stream = null; });
  await page.click(".tab:first-child .tab-name");

  // If the list can't be had: play Auto, say why once, and don't show a useless button.
  masterFails = true;
  await page.evaluate(() => nativeRestart("test"));
  await page.waitForFunction(() => native && (document.querySelector("#video video").getAttribute("src") || "").includes("usher.ttvnw.net"), null, { timeout: 8000 });
  await page.waitForFunction(() => [...active.list.querySelectorAll(".sys")].some((l) => l.textContent.startsWith("Couldn't load the quality list")), null, { timeout: 8000 });
  const noList = await page.evaluate(() => ({ btn: document.getElementById("quality-btn").hidden, msg: [...active.list.querySelectorAll(".sys")].filter((l) => l.textContent.startsWith("Couldn't load the quality list")).at(-1).textContent }));
  check("relay failure: plays Auto, no quality button, explains why", noList.btn && noList.msg.includes("answered 403"), JSON.stringify(noList));
  masterFails = false;
  // Leaving native hides the button and menu.
  await page.evaluate(() => { settings.nativeQuality = "auto"; saveSettings(); setPlayer("embed"); HTMLMediaElement.prototype.canPlayType = () => ""; });
  await page.waitForSelector("#video iframe", { timeout: 5000 });
  check("back on Twitch's player: no quality button", await page.$eval("#quality-btn", (b) => b.hidden) && await page.$eval("#quality-menu", (m) => m.hidden));
}

// =============== recent emotes: only what works in this channel ===============
await page.click(".tab:first-child .tab-name");
await page.evaluate(() => localStorage.setItem("recentEmotes", JSON.stringify([
  { name: "otherChanOnly", url: "https://cdn.7tv.app/emote/X/2x.webp" },     // 7TV, another channel's
  { name: "PETPET", url: "https://cdn.7tv.app/emote/P/2x.webp" },            // 7TV global
  { name: "Kappa", url: "https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/2.0" },
  { name: "otherFollowerEmote", url: "https://static-cdn.jtvnw.net/emoticons/v2/999/static/dark/2.0" }, // not in your list here
  { name: "catJAM", url: "https://cdn.7tv.app/emote/OLD/2x.webp" },          // this channel's 7TV, stored with an old image
])));
await page.click("#emote-btn");
await page.waitForSelector("#picker:not([hidden]) .grid button");
const recent = await page.evaluate(() => {
  const h = [...document.querySelectorAll("#picker-list h3")].find((x) => x.textContent.startsWith("Recent"));
  return [...h.nextElementSibling.querySelectorAll("button")].map((b) => b.dataset.name + "|" + b.dataset.url);
});
check("recent emotes: only ones usable in this channel, with this channel's image",
  JSON.stringify(recent.map((r) => r.split("|")[0])) === '["PETPET","Kappa","catJAM"]' && recent[2].endsWith("//cdn.7tv.app/emote/J/2x.webp"), JSON.stringify(recent));
await page.click("#emote-btn");
await page.evaluate(() => localStorage.removeItem("recentEmotes"));

// =============== composer: emote images ===============
await page.evaluate(() => composer.setText(""));
await page.click("#message");
await page.keyboard.type("hi Kappa catJAM OMEGALUL");
let ce = await page.evaluate(() => ({ text: composer.getText(), imgs: [...document.querySelectorAll("#message .ce-emote")].map((i) => i.dataset.name) }));
check("finished emote names become images; the word being typed stays text", ce.imgs.join(",") === "Kappa,catJAM" && ce.text === "hi Kappa catJAM OMEGALUL", JSON.stringify(ce));
await page.keyboard.type(" and more");
ce = await page.evaluate(() => ({ text: composer.getText(), imgs: [...document.querySelectorAll("#message .ce-emote")].map((i) => i.dataset.name), caretAtEnd: composer.caret() === composer.getText().length }));
check("typing continues normally after conversion (caret stays at end)", ce.imgs.join(",") === "Kappa,catJAM,OMEGALUL" && ce.text === "hi Kappa catJAM OMEGALUL and more" && ce.caretAtEnd, JSON.stringify(ce));
await sleep(400);
await page.screenshot({ path: dir + "/t14-composer.png" });
check("emotes stay real text in the box (what phone keyboards read for predictions)", await page.evaluate(() => {
  const box = document.getElementById("message");
  return !box.querySelector("img") && box.textContent.replace(/\u00a0/g, " ") === composer.getText();
}));
// Typing more must not rebuild the emotes already shown (that resets keyboard predictions).
check("typing after an emote leaves earlier nodes untouched", await page.evaluate(() => {
  const before = document.querySelector('#message .ce-emote[data-name="Kappa"]');
  document.getElementById("message").lastChild.appendData("x");
  document.getElementById("message").dispatchEvent(new InputEvent("input", { bubbles: true }));
  const same = document.querySelector('#message .ce-emote[data-name="Kappa"]') === before;
  const t = document.getElementById("message").lastChild; t.deleteData(t.length - 1, 1);
  document.getElementById("message").dispatchEvent(new InputEvent("input", { bubbles: true }));
  return same;
}));
await page.keyboard.press("Home");
await page.keyboard.type("so ");
ce = await page.evaluate(() => composer.getText());
check("editing in the middle keeps the caret in place", ce === "so hi Kappa catJAM OMEGALUL and more", ce);
const sentBefore = log.sent.length;
await page.keyboard.press("End");
await page.keyboard.press("Enter");
await sleep(200);
check("sends plain text with emote names", log.sent.at(-1) === "so hi Kappa catJAM OMEGALUL and more" && log.sent.length === sentBefore + 1 && (await page.evaluate(() => composer.getText())) === "", log.sent.at(-1));
await page.click("#emote-btn");
await page.click('#picker-list button[data-name="uwoHype"]');
check("picker inserts an image", await page.evaluate(() => !!document.querySelector('#message .ce-emote[data-name="uwoHype"]') && composer.getText() === "uwoHype "));
await page.keyboard.press("Escape");
await page.evaluate(() => composer.setText(""));

// =============== links + clip cards ===============
await page.click(".tab:first-child .tab-name");
cur().send(chat("999", "lnk1", "Linker", "801", "see https://example.com/page?x=1). and twitch.tv/foo, but hi.there ok.so stays text"));
await page.waitForSelector('li[data-id="lnk1"]');
const links = await page.$$eval('li[data-id="lnk1"] a.link', (as) => as.map((a) => [a.textContent, a.href, a.target, a.rel]));
check("links: full URL + bare domain, trailing punctuation excluded, plain words untouched",
  JSON.stringify(links.map((l) => l.slice(0, 2))) === '[["https://example.com/page?x=1","https://example.com/page?x=1"],["twitch.tv/foo","https://twitch.tv/foo"]]' &&
  links.every((l) => l[2] === "_blank" && l[3].includes("noopener")) &&
  (await page.textContent('li[data-id="lnk1"] .body')).includes("x=1). and twitch.tv/foo, but hi.there ok.so"), JSON.stringify(links));
const selectedAfterLinkClick = await page.evaluate(() => {
  const a = document.querySelector('li[data-id="lnk1"] a.link');
  addEventListener("click", (e) => e.preventDefault(), { once: true }); // don't actually navigate in the test
  a.click();
  return a.closest(".msg").classList.contains("selected");
});
check("clicking a link doesn't select the message", !selectedAfterLinkClick);
cur().send(chat("999", "clip1", "Clipper", "802", "lol https://clips.twitch.tv/FunnyClipSlug-AbC123 and https://www.twitch.tv/uwoslab/clip/SecondSlug?filter=clips"));
cur().send(chat("999", "clip2", "Again", "803", "reposting clips.twitch.tv/FunnyClipSlug-AbC123"));
cur().send(chat("999", "clip3", "Nope", "804", "https://clips.twitch.tv/MissingClip"));
await page.waitForFunction(() => document.querySelectorAll('li[data-id="clip1"] .clip-card').length === 2, null, { timeout: 3000 });
const cards = await page.$$eval('li[data-id="clip1"] .clip-card', (cs) => cs.map((c) => ({ href: c.href, target: c.target, text: c.textContent, img: c.querySelector("img").src })));
check("clip cards: both URL styles, thumbnail + duration + metadata",
  cards[0].href === "https://clips.twitch.tv/FunnyClipSlug-AbC123" && cards[0].target === "_blank" && cards[0].img.endsWith("clip-FunnyClipSlug-AbC123.jpg") &&
  cards[0].text.includes("0:27") && cards[0].text.includes("UwoSlab · Just Chatting") && cards[0].text.includes("Clipped by Clipper · 12.3k views · 3d ago") &&
  cards[1].text.includes("Second clip"), JSON.stringify(cards));
await sleep(200);
check("repeated clip fetched once; missing clip shows no card",
  log.clips.filter((x) => x === "FunnyClipSlug-AbC123").length === 1 && (await page.$$('li[data-id="clip2"] .clip-card')).length === 1 && (await page.$$('li[data-id="clip3"] .clip-card')).length === 0,
  JSON.stringify(log.clips));
await page.evaluate(() => document.querySelector('li[data-id="clip1"]').scrollIntoView());
await page.screenshot({ path: dir + "/t16-clips.png" });

// =============== raids ===============
const raid = (fromId, fromName, to, viewers) => msg("notification", { subscription: { type: "channel.raid" }, event: { from_broadcaster_user_id: fromId, from_broadcaster_user_login: fromName.toLowerCase(), from_broadcaster_user_name: fromName, to_broadcaster_user_id: ids[to] || "1", to_broadcaster_user_login: to, to_broadcaster_user_name: to === "targetchan" ? "TargetChan" : to, viewers } });
await page.click(".tab:first-child .tab-name");
cur().send(raid("999", "UwoSlab", "targetchan", 1234));
await page.waitForSelector(".messages:not([hidden]) .notice.raid");
const raidText = await page.textContent(".messages:not([hidden]) .notice.raid");
check("raid notice + countdown on watched tab", raidText.includes("UwoSlab raided TargetChan with 1,234 viewers.") && raidText.includes("Following in 5s"), raidText);
await page.screenshot({ path: dir + "/t13-raid.png" });
await page.waitForFunction(() => location.hash === "#targetchan", null, { timeout: 8000 });
await page.waitForFunction(() => document.body.innerText.includes("Joined #TargetChan"), null, { timeout: 5000 });
check("followed the raid: new tab opened, active, joined", (await state()).tabs.includes("TargetChan*") && log.subs.some((x) => x.startsWith("targetchan@")), (await state()).tabs);
check("original tab kept, notice says followed", (await page.$eval(".tab:first-child .tab-name", (n) => n.textContent)) === "UwoSlab");
// Stay here
await page.click(".tab:first-child .tab-name");
cur().send(raid("999", "UwoSlab", "targetchan", 50));
await page.waitForSelector('.messages:not([hidden]) .notice.raid:last-of-type button:has-text("Stay here")');
await page.click('.messages:not([hidden]) .notice.raid:last-of-type button:has-text("Stay here")');
await sleep(6000);
check("Stay here cancels following", (await page.evaluate(() => location.hash)) === "#uwoslab");
// background tab raids: no switch, red badge
cur().send(raid("888", "OtherChan", "targetchan", 3));
await sleep(200);
check("background tab raid: no switch, badge flagged", (await page.evaluate(() => location.hash)) === "#uwoslab" && (await page.$eval(".tab:nth-child(2)", (t) => t.classList.contains("mentioned"))));
// setting off
await page.evaluate(() => { settings.followRaids = false; });
cur().send(raid("999", "UwoSlab", "targetchan", 9));
await sleep(6000);
check("follow-raids off: notice only", (await page.evaluate(() => location.hash)) === "#uwoslab" && !(await page.textContent(".messages:not([hidden]) .notice.raid:last-of-type")).includes("Following"));
await page.evaluate(() => { settings.followRaids = true; });

// =============== review fixes ===============
check("CSP blocks injected inline script", await page.evaluate(() => {
  const sc = document.createElement("script");
  sc.textContent = "window.__injected = 1";
  document.body.appendChild(sc);
  return window.__injected === undefined;
}));
// A failed status request (mid-deploy, offline) must not swap the chat for "Connect Twitch".
statusDown = true;
await page.evaluate(() => refreshStatus());
await sleep(150);
check("status error keeps chat visible", await page.evaluate(() => !document.getElementById("chat").hidden && document.getElementById("connect").hidden));
statusDown = false;
const net = await page.evaluate(() => api("/api/netfail"));
check("network error is a retryable failure, not a throw", net.ok === false && net.retry === true, JSON.stringify(net));
// Enter twice while a send is in flight sends once; text typed meanwhile survives.
slowSend = 400;
const sendsBefore = log.sent.length;
await page.fill("#message", "only once please");
await page.evaluate(() => { document.getElementById("send-form").requestSubmit(); document.getElementById("send-form").requestSubmit(); });
await sleep(100);
await page.evaluate(() => composer.setText("next message"));
await sleep(600);
slowSend = 0;
check("no double send on repeated Enter", log.sent.length === sendsBefore + 1, JSON.stringify(log.sent.slice(sendsBefore)));
check("text typed during a send is kept", (await page.evaluate(() => composer.getText())) === "next message");
await page.evaluate(() => composer.setText(""));
// Localized display names: mention by login.
cur().send(chat("999", "kanji1", "テスト", "601", "こんにちは", { chatter_user_login: "tesuto_jp" }));
await page.waitForSelector('li[data-id="kanji1"]');
await page.fill("#message", "@tes");
await sleep(100);
check("@ autocomplete uses login for localized names", ((await state()).suggest || "").includes("@tesuto_jp"), (await state()).suggest);
await page.evaluate(() => composer.setText(""));
// The periodic live-status refresh must not resume a stream you paused.
await page.evaluate(() => { __player.calls.length = 0; });
await page.evaluate(() => refreshStreams());
await sleep(200);
check("stream refresh doesn't call play() again", !(await page.evaluate(() => __player.calls.some((c) => c[0] === "play"))), JSON.stringify(await page.evaluate(() => __player.calls)));

// =============== followed channels (channel box dropdown) ===============
await page.evaluate(() => { following = null; }); // start from a cold cache
const followFetches = log.following || 0;
await page.tap("#channel");
await page.waitForSelector("#follow-list .fl-row");
const fl = await page.$$eval("#follow-list > *", (ns) => ns.map((n) => n.textContent));
check("focusing the channel box lists followed channels: live first by viewers, then A–Z", JSON.stringify(fl) === JSON.stringify(["Live now", "TargetChanCeleste · speedrun attempts4.3kopen", "UwoSlabSoftware and Game Development · Building a chat app1.2kopen", "Offline", "AlphaChan", "ZetaChan"]), JSON.stringify(fl));
const flBox = await page.$eval("#follow-list", (b) => { const r = b.getBoundingClientRect(), h = document.querySelector("header").getBoundingClientRect(); return { top: Math.round(r.top - h.bottom), w: Math.round(r.width) }; });
check("dropdown sits under the header, full width on phones", flBox.top <= 0 && flBox.w >= 360, JSON.stringify(flBox));
await page.screenshot({ path: dir + "/t20-following.png" });
await page.type("#channel", "zet");
check("typing filters the list", JSON.stringify(await page.$$eval("#follow-list .fl-row", (r) => r.map((x) => x.textContent))) === '["ZetaChan"]');
await page.fill("#channel", "");
await page.type("#channel", "alp");
await page.tap('#follow-list .fl-row:has-text("AlphaChan")');
await page.waitForFunction(() => location.hash === "#alphachan");
check("tapping a channel opens it and closes the list", await page.$eval("#follow-list", (b) => b.hidden) && (await page.inputValue("#channel")) === "" && log.subs.some((x) => x.startsWith("alphachan@")));
await page.focus("#channel");
await page.waitForSelector("#follow-list .fl-row");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
await page.waitForFunction(() => location.hash === "#uwoslab");
check("arrow keys + Enter pick a channel", await page.$eval("#follow-list", (b) => b.hidden));
check("list is cached briefly (one fetch for two opens)", log.following - followFetches === 1, String(log.following - followFetches));
await page.evaluate(() => closeTab(tabs.get("alphachan")));
followingMode = "scope";
await page.evaluate(() => { following = null; });
await page.focus("#channel");
await page.waitForSelector("#follow-list .fl-note a");
check("without the follows permission: reconnect prompt", (await page.textContent("#follow-list")).includes("Reconnect Twitch to see channels you follow"));
await page.keyboard.press("Escape");
check("Escape closes the list", await page.$eval("#follow-list", (b) => b.hidden));
followingMode = "ok";

// =============== chat history opt-in ===============
{
  await page.evaluate(() => { settings.history = null; saveSettings(); });
  const histBefore = log.history.length;
  await page.evaluate(() => openTab("alphachan"));
  await page.waitForSelector(".messages:not([hidden]) .history-ask");
  const ask = await page.textContent(".messages:not([hidden]) .history-ask");
  check("not asked yet: no history fetched, opt-in card explains the service with a link",
    log.history.length === histBefore && ask.includes("Load chat history?") && ask.includes("recent-messages.robotty.de") &&
    (await page.getAttribute(".history-ask a.link", "href")) === "https://recent-messages.robotty.de/", ask);
  await page.screenshot({ path: dir + "/t21-history-optin.png" });
  // A live message arrives before opting in; history must merge in above it, in time order.
  cur().send(chat("666", "live-before-optin", "Viewer", "701", "live message before opting in"));
  await page.waitForSelector('li[data-id="live-before-optin"]');
  await page.click('.history-ask button:has-text("Load history")');
  await page.waitForSelector('.messages:not([hidden]) li[data-id="h1"]');
  const order = await page.$$eval(".messages:not([hidden]) > li", (ls) => ls.map((l) => l.dataset.id || l.textContent.slice(0, 30)));
  const iH1 = order.indexOf("h1"), iH2 = order.indexOf("h2"), iLive = order.indexOf("live-before-optin");
  const tsSorted = await page.$$eval(".messages:not([hidden]) > li", (ls) => ls.every((l, i) => i === 0 || Number(l.dataset.ts) >= Number(ls[i - 1].dataset.ts)));
  check("opting in merges history by time around what's on screen", iH1 >= 0 && iH1 < iH2 && iH2 < iLive && tsSorted && !(await page.$(".history-ask")), JSON.stringify(order));
  check("saved as opted in; asked for 100", JSON.parse(await page.evaluate(() => localStorage.getItem("settings"))).history === true && log.history.at(-1) === "alphachan?limit=100", log.history.at(-1));
  // Opt out from Settings: the toggle carries the same info and link.
  await openSettingsUI();
  const histRow = page.locator('#sheet-body .row:has-text("Load chat history")');
  check("Settings has the history toggle with info and link", (await histRow.textContent()).includes("recent-messages.robotty.de") && await histRow.locator("input").isChecked());
  await histRow.locator("input").click();
  await page.click("#sheet-close");
  const n = log.history.length;
  await page.evaluate(() => closeTab(tabs.get("alphachan")));
  await page.evaluate(() => openTab("alphachan"));
  await page.waitForFunction(() => document.body.innerText.includes("Joined #AlphaChan"));
  await sleep(300);
  check("opted out: no fetch and no prompt", log.history.length === n && !(await page.$(".history-ask")));
  // "No thanks" from the prompt.
  await page.evaluate(() => { settings.history = null; closeTab(tabs.get("alphachan")); openTab("alphachan"); });
  await page.waitForSelector(".history-ask");
  await page.click('.history-ask button:has-text("No thanks")');
  check("No thanks: saved, card gone, nothing fetched", JSON.parse(await page.evaluate(() => localStorage.getItem("settings"))).history === false && !(await page.$(".history-ask")) && log.history.length === n);
  await page.evaluate(() => { closeTab(tabs.get("alphachan")); settings.history = true; saveSettings(); });
}
// Scrolling up pages in older history, keeping your place.
{
  ids.deepchan = "444";
  const n0 = log.history.length;
  await page.evaluate(() => openTab("deepchan"));
  await page.waitForSelector('li[data-id="deep249"]');
  await sleep(300);
  const first = await page.evaluate(() => ({ msgs: active.list.querySelectorAll(".msg").length, divider: active.list.querySelector(".history-divider").textContent, atBottom: atBottom(active) }));
  check("first load: newest 100, divider invites scrolling up, scrolled to the bottom", first.msgs === 100 && first.divider.includes("scroll up for older messages") && first.atBottom && log.history[n0] === "deepchan?limit=100", JSON.stringify(first));
  const anchorTop = await page.evaluate(() => { const l = active.list; l.scrollTop = 0; return null; });
  await page.waitForFunction(() => active.list.querySelectorAll(".msg").length === 200, null, { timeout: 5000 });
  await sleep(200);
  const second = await page.evaluate(() => {
    const l = active.list, d150 = l.querySelector('[data-id="deep150"]');
    const ts = [...l.children].map((n) => Number(n.dataset.ts));
    return { req: null, sorted: ts.every((t, i) => i === 0 || t >= ts[i - 1]), firstId: l.querySelector(".msg").dataset.id, kept: d150.getBoundingClientRect().top - l.getBoundingClientRect().top > 0, top: l.scrollTop };
  });
  check("scrolling to the top loads the next 100 older, in order, without jumping to them", second.sorted && second.firstId === "deep50" && second.top > 400 && /^deepchan\?limit=100&before=\d+$/.test(log.history.at(-1)), JSON.stringify(second) + " " + log.history.at(-1));
  await page.evaluate(() => { active.list.scrollTop = 0; });
  await page.waitForFunction(() => active.list.querySelectorAll(".msg").length === 250, null, { timeout: 5000 });
  await sleep(200);
  const done = await page.evaluate(() => ({ div: active.list.querySelector(".history-divider").textContent, firstAfterDivider: active.list.querySelector(".history-divider").nextElementSibling.dataset.id, dividers: active.list.querySelectorAll(".history-divider").length }));
  check("runs out cleanly: start-of-history divider above the oldest message", done.div.includes("start of chat history") && done.firstAfterDivider === "deep0" && done.dividers === 1, JSON.stringify(done));
  const reqs = log.history.length;
  await page.evaluate(() => { active.list.scrollTop = 0; });
  await sleep(300);
  check("no more requests once history is exhausted", log.history.length === reqs);
  await page.screenshot({ path: dir + "/t22-history-top.png" });
  await page.evaluate(() => closeTab(tabs.get("deepchan")));
}
// =============== light theme ===============
{
  check("dark by default, applied before app.js", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");
  cur().send(chat("999", "yellow1", "Sunny", "702", "bright name", { color: "#FFFF00" }));
  await page.waitForSelector('li[data-id="yellow1"]');
  await openSettingsUI();
  await page.click('#sheet-body .seg button:has-text("Light")');
  const lt = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.querySelector(".app")).backgroundColor,
    meta: document.querySelector('meta[name="theme-color"]').content, saved: JSON.parse(localStorage.getItem("settings")).theme,
    yellow: document.querySelector('li[data-id="yellow1"] .name').style.color,
  }));
  const lum = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  check("Light: white panels, saved, browser bar color", lt.theme === "light" && lt.bg === "rgb(255, 255, 255)" && lt.meta === "#ffffff" && lt.saved === "light", JSON.stringify(lt));
  check("Light: bright names darkened enough to read on white", lum(lt.yellow) <= 0.31 && lum(lt.yellow) > 0.2, lt.yellow);
  await page.click("#sheet-close");
  await page.screenshot({ path: dir + "/t23-light.png" });
  await openSettingsUI();
  await page.screenshot({ path: dir + "/t24-light-settings.png" });
  await page.click("#sheet-close");
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll(".tab.joined").length >= 1, null, { timeout: 5000 });
  check("Light survives reload (set before first paint by theme.js)", (await page.evaluate(() => document.documentElement.dataset.theme)) === "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => { settings.theme = "system"; saveSettings(); });
  const sysDark = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.emulateMedia({ colorScheme: "light" });
  await sleep(100);
  check("Match device follows the system setting live", sysDark === "dark" && (await page.evaluate(() => document.documentElement.dataset.theme)) === "light");
  await page.emulateMedia({ colorScheme: null });
  await page.evaluate(() => { settings.theme = "dark"; saveSettings(); });
  check("back to Dark restores real name colors", (await page.evaluate(() => { const n = document.querySelector(".name[data-color='#FFFF00']"); return !n || n.style.color === "rgb(255, 255, 0)"; })));
}
// Deleted-before-load messages from history are flagged like live deletions.
check("history marks messages deleted before they were loaded", await page.evaluate(() => {
  const ev = ircToEvent("@id=d1;tmi-sent-ts=1;user-id=9;display-name=X;rm-deleted=1 :x!x@x PRIVMSG #c :gone");
  return ev.deleted === true;
}));

// =============== review fixes (second pass) ===============
{
  await page.click(".tab:first-child .tab-name");
  // Expired Access session: say so, instead of "network error" forever.
  sessionExpiredMock = true;
  await page.evaluate(() => { sessionProbe = null; });
  const exp = await page.evaluate(() => api("/api/netfail"));
  check("expired sign-in is detected and explained (with a reload button)", exp.ok === false && /sign-in expired/.test(exp.error) && !(await page.$eval("#expired", (b) => b.hidden)) && !!(await page.$("#expired-reload")), JSON.stringify(exp));
  sessionExpiredMock = false;
  await page.evaluate(() => { sessionProbe = null; });
  const offline = await page.evaluate(() => api("/api/netfail"));
  check("a plain network error is still just a network error", offline.retry === true && /Network error/.test(offline.error));
  await page.evaluate(() => api("/api/status"));
  check("banner clears once requests work again", await page.$eval("#expired", (b) => b.hidden));

  // A failed live-status lookup must not mark everyone offline (and pause the video).
  await page.evaluate(() => { tabs.get("uwoslab").stream = { user_id: "999", title: "t", game_name: "g", viewer_count: 1, started_at: new Date().toISOString() }; });
  streamsFail = true;
  await page.evaluate(() => refreshStreams());
  await sleep(200);
  check("failed live-status lookup keeps the previous state", await page.evaluate(() => !!tabs.get("uwoslab").stream));
  streamsFail = false;

  // A failed badge/cheermote lookup is retried at the next join, not forgotten all session.
  extrasFail = true;
  await page.evaluate(() => { const t = tabs.get("uwoslab"); t.loadedExtras = true; return loadTabExtras(t); });
  check("failed badges/cheermotes lookup → empty for now, retried next join", await page.evaluate(() => tabs.get("uwoslab").loadedExtras === false && Object.keys(tabs.get("uwoslab").badges).length === 0));
  extrasFail = false;
  await page.evaluate(() => { const t = tabs.get("uwoslab"); return loadTabExtras(t).then(() => { t.loadedExtras = true; }); });
  check("…and a later success sticks", await page.evaluate(() => tabs.get("uwoslab").loadedExtras === true));

  // Joining: transient failures retry, permanent ones don't.
  await page.evaluate(() => { joinRetryMs = 100; });
  ids.retrychan = "555";
  const joinsBefore = log.subs.length;
  subFailures.push("Subscribe to channel.chat.message failed (503): temporarily unavailable");
  await page.evaluate(() => openTab("retrychan", false));
  await page.waitForFunction(() => tabs.get("retrychan") && tabs.get("retrychan").joined, null, { timeout: 8000 });
  check("transient join failure (503) is retried and succeeds", log.subs.slice(joinsBefore).filter((x) => x.includes("retrychan")).join(",") === "failed:retrychan,retrychan@" + log.subs.at(-1).split("@")[1], JSON.stringify(log.subs.slice(joinsBefore)));
  await page.evaluate(() => closeTab(tabs.get("retrychan")));
  ids.nopechan = "556";
  const before2 = log.subs.length;
  subFailures.push("No Twitch channel named nopechan.");
  await page.evaluate(() => openTab("nopechan", false));
  await sleep(800);
  check("a permanent join failure ('No Twitch channel…') is not retried", log.subs.slice(before2).length === 1 && !(await page.evaluate(() => tabs.get("nopechan").joined)), JSON.stringify(log.subs.slice(before2)));
  await page.evaluate(() => closeTab(tabs.get("nopechan")));

  // History auto-fill must never spin when its load returns early (history off, load in progress).
  const spun = await page.evaluate(async () => {
    const t = active;
    Object.defineProperty(t.list, "scrollHeight", { get: () => 100, configurable: true });
    t.historyDone = false; t.historyBefore = 123;
    const was = settings.history;
    settings.history = false;
    fillScreen(t);                         // before the fix this re-entered itself without yielding, freezing the page
    await new Promise((r) => setTimeout(r, 50));
    settings.history = was;
    delete t.list.scrollHeight;
    return "responsive";
  });
  check("history auto-fill can't freeze the page when history is off", spun === "responsive");
  check("loadOlder reports whether it loaded", await page.evaluate(async () => { const was = settings.history; settings.history = false; const r = await loadOlder(active); settings.history = was; return r === false; }));

  // Search filtering: another tab's stale filter marks don't linger.
  await page.evaluate(() => { document.getElementById("search-btn").click(); });
  await page.fill("#search", "zzzz-no-match");
  await page.evaluate(() => { filterText = "zzzz-no-match"; applyFilter(); });
  const hiddenA = await page.evaluate(() => active.list.querySelectorAll(".filtered").length);
  await page.click(".tab:nth-child(2) .tab-name");
  await page.click("#search-close");
  await page.click(".tab:first-child .tab-name");
  check("filter marks are cleared when you come back to a tab after clearing the search", hiddenA > 0 && (await page.evaluate(() => active.list.querySelectorAll(".filtered").length)) === 0, String(hiddenA));

  // Emote picker: Enter picks from what was just typed (the grid is debounced).
  await page.evaluate(() => composer.setText(""));
  await page.click("#emote-btn");
  await page.fill("#emote-search", "uwoH");
  await page.press("#emote-search", "Enter");
  check("emote picker: Enter right after typing picks the matching emote", (await page.evaluate(() => composer.getText())).startsWith("uwoHype"), await page.evaluate(() => composer.getText()));
  await page.evaluate(() => { composer.setText(""); closePicker(); });
}

// =============== channel points redemptions that show up in chat ===============
{
  await page.click(".tab:first-child .tab-name");
  cur().send(chat("999", "pts1", "Pointer", "801", "look at me", { message_type: "channel_points_highlighted" }));
  cur().send(chat("999", "pts2", "Pointer", "801", "talking in sub-only mode", { message_type: "channel_points_sub_only" }));
  cur().send(chat("999", "pts3", "Pointer", "801", "my reward answer", { message_type: "text", channel_points_custom_reward_id: "abc-123" }));
  cur().send(chat("999", "pts4", "Pointer", "801", "just chatting", { message_type: "text", channel_points_custom_reward_id: null }));
  cur().send(chat("999", "pts5", "Pointer", "801", "hey @testuser highlighted too", { message_type: "channel_points_highlighted",
    fragments: [{ type: "text", text: "hey " }, { type: "mention", text: "@testuser", mention: { user_id: "111", user_login: "testuser", user_name: "testuser" } }, { type: "text", text: " highlighted too" }] }));
  await page.waitForSelector('li[data-id="pts5"]');
  const labels = await page.evaluate(() => Object.fromEntries(["pts1", "pts2", "pts3", "pts4"].map((id) => { const li = document.querySelector('li[data-id="' + id + '"]'); const f = li.querySelector(".flag.points"); return [id, f ? f.textContent : null]; })));
  check("highlighted message is marked", labels.pts1 === "Highlighted message · channel points", JSON.stringify(labels));
  check("sub-only-mode message is marked", labels.pts2 === "Sub-only mode message · channel points");
  check("a message carrying a reward id is marked", labels.pts3 === "Redeemed a channel points reward");
  check("ordinary messages (even with a null reward id) are not marked", labels.pts4 === null && await page.$eval('li[data-id="pts4"]', (l) => !l.classList.contains("points")));
  check("the message itself is intact under the marker", await page.$eval('li[data-id="pts1"] .body', (b) => b.textContent === "look at me"));
  const colors = await page.evaluate(() => { const bg = (id) => getComputedStyle(document.querySelector('li[data-id="' + id + '"]')).backgroundColor; return { pts1: bg("pts1"), pts4: bg("pts4"), pts5: bg("pts5"), mention: getComputedStyle(document.documentElement).getPropertyValue("--mention").trim() }; });
  check("marked messages get their own background; a mention in one still shows as a mention", colors.pts1 !== colors.pts4 && colors.pts5 === "rgb(92, 22, 24)", JSON.stringify(colors));
  await page.evaluate(() => document.querySelector('li[data-id="pts1"]').scrollIntoView());
  await page.screenshot({ path: dir + "/t28-points.png" });
  // Loaded history uses IRC tags for the same things.
  const hist = await page.evaluate(() => {
    const line = (tags) => ircToEvent("@" + tags + ";tmi-sent-ts=1;user-id=9;display-name=X :x!x@x PRIVMSG #c :hi");
    return [line("id=h1;msg-id=highlighted-message"), line("id=h2;msg-id=skip-subs-mode-message"), line("id=h3;custom-reward-id=abc"), line("id=h4")].map((e) => [e.message_type, e.channel_points_custom_reward_id]);
  });
  check("history lines map IRC tags to the same markers", JSON.stringify(hist) === '[["channel_points_highlighted",null],["channel_points_sub_only",null],["text","abc"],["text",null]]', JSON.stringify(hist));
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  check("light theme has its own colors for the marker", await page.evaluate(() => { const c = getComputedStyle(document.querySelector('li[data-id="pts1"]')).backgroundColor; document.documentElement.dataset.theme = "dark"; return c === "rgb(237, 227, 255)"; }));
}

// =============== GIFs from Tier 2+ subscribers ===============
{
  await page.click(".tab:first-child .tab-name");
  const gifUrl = "https://media4.giphy.com/media/joSNxeswxuc74Juo8X/giphy.gif?cid=abc123&ep=v1_gifs_search&rid=giphy.gif&ct=g";
  const placeholder = "[Y A Y Yes GIF by Djemilah Birnie]";
  cur().send(chat("999", "gif1", "Gifster", "901", "hey " + placeholder, { fragments: [
    { type: "text", text: "hey " }, { type: "gif", text: placeholder, gif: { id: "joSNxeswxuc74Juo8X", url: gifUrl } }] }));
  await page.waitForSelector('li[data-id="gif1"] img.chat-gif.loaded');
  const g = await page.$eval('li[data-id="gif1"]', (li) => { const i = li.querySelector("img.chat-gif"); const r = i.getBoundingClientRect(); return { src: i.getAttribute("src"), alt: i.alt, inBody: !!i.closest(".body"), text: li.querySelector(".body").textContent, h: Math.round(r.height), w: Math.round(r.width), rp: i.referrerPolicy }; });
  check("a GIF fragment becomes an image, with the URL exactly as Twitch sent it", g.src === gifUrl && g.inBody, JSON.stringify(g));
  check("its placeholder text is the alt text, and the text before it is kept", g.alt === placeholder && g.text.trim() === "hey");
  check("sized sensibly (capped at 160px tall, 320px wide)", g.h > 0 && g.h <= 160 && g.w <= 320, JSON.stringify(g));
  check("GIF requests don't send a referrer", g.rp === "no-referrer" && log.gifs.every((x) => x.referer === null), JSON.stringify(log.gifs));
  await page.evaluate(() => document.querySelector('li[data-id="gif1"]').scrollIntoView());
  await page.screenshot({ path: dir + "/t29-gif.png" });
  // Anything that isn't https is shown as text and never loaded.
  const before = log.gifs.length;
  cur().send(chat("999", "gif2", "Gifster", "901", "bad", { fragments: [{ type: "gif", text: "[evil GIF]", gif: { id: "x", url: "http://tracker.example/pixel.gif" } }, { type: "gif", text: "[js GIF]", gif: { id: "y", url: "javascript:alert(1)" } }] }));
  await page.waitForSelector('li[data-id="gif2"]');
  check("non-https GIF URLs are never loaded (text only)", await page.$eval('li[data-id="gif2"]', (li) => !li.querySelector("img") && !li.querySelector("a") && li.querySelector(".body").textContent === "[evil GIF][js GIF]") && log.gifs.length === before);
  // The Settings toggle: off = a link instead of an image.
  check("Settings has the GIF toggle, on by default", await page.evaluate(() => { openSettings(); const row = [...document.querySelectorAll("#sheet-body .row")].find((r) => r.textContent.includes("Show GIFs")); const on = row && row.querySelector("input").checked; closeSheet(); return !!row && on; }));
  await page.evaluate(() => { settings.gifs = false; });
  cur().send(chat("999", "gif3", "Gifster", "901", placeholder, { fragments: [{ type: "gif", text: placeholder, gif: { id: "j", url: gifUrl } }] }));
  await page.waitForSelector('li[data-id="gif3"]');
  check("with GIFs off: a link with the placeholder text, no image", await page.$eval('li[data-id="gif3"]', (li, url) => { const a = li.querySelector(".body a.link"); return !li.querySelector("img.chat-gif") && !!a && a.href === url && a.textContent === "[Y A Y Yes GIF by Djemilah Birnie]" && a.target === "_blank" && a.rel.includes("noopener"); }, gifUrl));
  await page.evaluate(() => { settings.gifs = true; });

  // History: the IRC `gifs` tag, positioned like emotes.
  const irc = (tags, text) => page.evaluate(([tags, text]) => ircToEvent("@" + tags + ";tmi-sent-ts=1;user-id=9;display-name=X :x!x@x PRIVMSG #c :" + text).message.fragments, [tags, text]);
  let f = await irc("id=a;gifs=0-33|joSNxeswxuc74Juo8X|" + gifUrl, placeholder);
  check("history: a gifs tag becomes a gif fragment over the placeholder", JSON.stringify(f) === JSON.stringify([{ type: "gif", text: placeholder, gif: { id: "joSNxeswxuc74Juo8X", url: gifUrl } }]), JSON.stringify(f));
  f = await irc("id=b;emotes=25:0-4;gifs=6-12|g1|https://media.giphy.com/media/g1/giphy.gif", "Kappa [A GIF] done");
  check("history: text, an emote and a gif in one message", JSON.stringify(f.map((x) => x.type + ":" + x.text)) === '["emote:Kappa","text: ","gif:[A GIF]","text: done"]', JSON.stringify(f.map((x) => x.type + ":" + x.text)));
  f = await irc("id=c;gifs=0-4|g1|https://media.giphy.com/a.gif?x=1,2&y=3,5-6|g2|https://media.giphy.com/b.gif", "[One] [Two]");
  check("history: a comma inside a URL doesn't split the entry", f.filter((x) => x.type === "gif").length === 1 && f.find((x) => x.type === "gif").gif.url === "https://media.giphy.com/a.gif?x=1,2&y=3,5-6|g2|https://media.giphy.com/b.gif" || f.filter((x) => x.type === "gif").length === 2, JSON.stringify(f.filter((x) => x.type === "gif").map((x) => x.gif.url)));
  f = await irc("id=d;gifs=0-4|g1|https://media.giphy.com/a.gif?x=1\\:2", "[One]");
  check("history: IRC tag escapes in the URL are undone (\\: is ;)", f[0].gif.url === "https://media.giphy.com/a.gif?x=1;2", f[0].gif.url);
  f = await irc("id=e", "plain text");
  check("history: messages without the tag are unchanged", f.length === 1 && f[0].type === "text");
  // ...and a loaded history message actually renders the image.
  await page.evaluate(([url]) => { const ev = ircToEvent("@id=hist-gif;gifs=0-9|g9|" + url + ";tmi-sent-ts=" + (Date.now() - 5000) + ";user-id=9;display-name=Old :old!old@x PRIVMSG #uwoslab :[Old GIF!]"); renderMessage(active, ev, { merge: true, historical: true }); }, [gifUrl]);
  check("a history GIF message renders the image", await page.$eval('li[data-id="hist-gif"]', (li) => !!li.querySelector("img.chat-gif")));
}

// =============== Gigantify an Emote (Bits Power-up) ===============
{
  await page.click(".tab:first-child .tab-name");
  const emote = (id, name) => ({ type: "emote", text: name, emote: { id } });
  const text = (t) => ({ type: "text", text: t });
  cur().send(chat("999", "giga1", "Spender", "951", "hi Kappa and PogChamp", { message_type: "power_ups_gigantified_emote", fragments: [text("hi "), emote("25", "Kappa"), text(" and "), emote("88", "PogChamp")] }));
  cur().send(chat("999", "giga2", "Spender", "951", "Kappa PogChamp", { message_type: "text", fragments: [emote("25", "Kappa"), text(" "), emote("88", "PogChamp")] }));
  cur().send(chat("999", "giga3", "Spender", "951", "no emote here", { message_type: "power_ups_gigantified_emote" }));
  await page.waitForSelector('li[data-id="giga3"]');
  await sleep(300);
  const look = (id) => page.$$eval('li[data-id="' + id + '"] .body img', (imgs) => imgs.map((i) => ({ alt: i.alt, giant: i.classList.contains("giant"), h: Math.round(i.getBoundingClientRect().height), scale: i.src.split("/").pop() })));
  const g1 = await look("giga1");
  check("gigantified message: only the LAST emote is enlarged (bigger image, larger height)", JSON.stringify(g1.map((x) => [x.alt, x.giant, x.scale])) === '[["Kappa",false,"2.0"],["PogChamp",true,"4.0"]]' && g1[0].h <= 40 && g1[1].h >= 90, JSON.stringify(g1));
  const g2 = await look("giga2");
  check("an ordinary message with the same emotes is unchanged", g2.every((x) => !x.giant && x.scale === "2.0" && x.h <= 40), JSON.stringify(g2));
  check("a gigantified message without any emote doesn't break", await page.$eval('li[data-id="giga3"] .body', (b) => b.textContent === "no emote here") && (await look("giga3")).length === 0);
  await page.evaluate(() => document.querySelector('li[data-id="giga1"]').scrollIntoView());
  await page.screenshot({ path: dir + "/t31-gigantified.png" });
  // History: the raw IRC line carries msg-id=gigantified-emote-message (shape taken from real chat).
  const hist = await page.evaluate(() => {
    const ev = ircToEvent("@badge-info=;badges=;color=#FF7F50;display-name=Spender;emotes=25:0-4;id=giga-hist;msg-id=gigantified-emote-message;tmi-sent-ts=" + (Date.now() - 9000) + ";user-id=951 :spender!spender@spender.tmi.twitch.tv PRIVMSG #uwoslab :Kappa");
    renderMessage(active, ev, { merge: true, historical: true });
    const img = document.querySelector('li[data-id="giga-hist"] .body img');
    return { type: ev.message_type, giant: !!img && img.classList.contains("giant"), src: img && img.src };
  });
  check("history: msg-id=gigantified-emote-message gives a giant emote too", hist.type === "power_ups_gigantified_emote" && hist.giant && hist.src.endsWith("/25/default/dark/4.0"), JSON.stringify(hist));
  check("history: other messages keep type 'text'", await page.evaluate(() => ircToEvent("@id=z;tmi-sent-ts=1;user-id=9;display-name=X :x!x@x PRIVMSG #c :hi").message_type === "text"));
}

// =============== clips and VODs: browsing and creating clips ===============
{
  // The Worker's request checking (pure functions).
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

  // The window.
  await page.evaluate(() => { clipPollMs = 100; tabs.get("uwoslab").stream = null; });
  await page.click(".tab:first-child .tab-name");
  check("the Clips & VODs button is in the info bar", await page.$eval("#clips-btn", (b) => !b.hidden && b.getAttribute("aria-label") === "Clips and VODs"));
  const before = (log.browse || []).length;
  await page.click("#clips-btn");
  await page.waitForSelector("#browse-modal:not([hidden]) .bcard");
  check("opens on the channel's most-viewed clips (all time)", (await page.textContent("#browse-title")) === "Clips & VODs: UwoSlab" && log.browse[before] === "/api/channel/clips?broadcaster_id=999&period=all", log.browse[before]);
  const cards = await page.$$eval("#browse-body .bcard", (cs) => cs.map((c) => ({ t: c.querySelector(".bt").textContent, s: c.querySelector(".bs").textContent, d: c.querySelector(".dur").textContent, img: c.querySelector("img").getAttribute("src") })));
  check("cards show thumbnail, length, title, views, age, category and clipper", cards.length === 3 && cards[0].d === "0:27" && cards[0].s === "12.3k views · 2d ago · Just Chatting · by ClipperT1".replace("T1", "1") && cards[0].img === "https://img.test/clip-TopClip1.jpg", JSON.stringify(cards[0]));
  await page.screenshot({ path: dir + "/t32-browse.png" });
  await page.click('#browse-body .browse-more');
  await page.waitForFunction(() => document.querySelectorAll("#browse-body .bcard").length === 5);
  check("Load more fetches the next page by cursor, then the button goes away", log.browse.at(-1) === "/api/channel/clips?broadcaster_id=999&period=all&after=c1" && !(await page.$("#browse-body .browse-more")));
  await page.selectOption("#browse-body .browse-filter select", "week");
  await page.waitForFunction(() => document.querySelectorAll("#browse-body .bcard").length === 1);
  check("changing the period reloads from the start", log.browse.at(-1) === "/api/channel/clips?broadcaster_id=999&period=week" && (await page.textContent("#browse-body .bt")) === "This week's best");

  // VODs.
  await page.click('#browse-body .browse-tabs button:has-text("Past broadcasts")');
  await page.waitForFunction(() => document.querySelector("#browse-body .bt") && document.querySelector("#browse-body .bt").textContent === "Friday night stream");
  const vod = await page.$$eval("#browse-body .bcard", (cs) => cs.map((c) => [c.querySelector(".dur").textContent, c.querySelector(".bs").textContent]));
  check("past broadcasts: type=archive newest first, hour-long durations as h:mm:ss", log.browse.at(-1) === "/api/channel/videos?user_id=999&type=archive&sort=time" && JSON.stringify(vod) === '[["3:25:10","4.2k views · 3d ago"],["1:35","120 views · 3d ago"]]', JSON.stringify(vod));
  await page.selectOption("#browse-body .browse-filter select", "views");
  await page.waitForFunction(() => document.querySelector("#browse-body .bt") && document.querySelector("#browse-body .bt").textContent === "Most viewed stream");
  check("sorting by views reloads", log.browse.at(-1) === "/api/channel/videos?user_id=999&type=archive&sort=views");
  await page.click('#browse-body .browse-tabs button:has-text("Highlights")');
  await page.waitForFunction(() => document.querySelector("#browse-body .bt") && document.querySelector("#browse-body .bt").textContent === "Best moments");
  await page.click('#browse-body .browse-tabs button:has-text("Uploads")');
  await page.waitForFunction(() => document.querySelector("#browse-body .browse-note") && document.querySelector("#browse-body .browse-note").textContent === "Nothing here yet.");
  check("an empty tab says so", true);
  // Playing.
  await page.click('#browse-body .browse-tabs button:has-text("Past broadcasts")');
  await page.waitForSelector("#browse-body .bcard");
  await page.click("#browse-body .bcard");
  await page.waitForSelector("#browse-body iframe.browse-player");
  const vp = await page.evaluate(() => ({ src: document.querySelector(".browse-player").src, link: document.querySelector("#browse-body a.btn.small").href, title: document.querySelector("#browse-body .ptitle").textContent }));
  check("a VOD plays in Twitch's own embed (with parent=), and can be opened on Twitch", vp.src === "https://player.twitch.tv/?video=v2002&parent=yappa.test&autoplay=true" && vp.link === "https://www.twitch.tv/videos/2002", JSON.stringify(vp));
  await page.screenshot({ path: dir + "/t33-browse-player.png" });
  await page.click('#browse-body button:has-text("Back")');
  await page.waitForSelector("#browse-body .bcard");
  check("Back returns to the list (same tab, no player)", !(await page.$("#browse-body iframe")) && (await page.$$("#browse-body .bcard")).length === 1);
  await page.click('#browse-body .browse-tabs button:has-text("Clips")');
  await page.waitForFunction(() => document.querySelector("#browse-body .bt") && document.querySelector("#browse-body .bt").textContent === "This week's best");
  await page.click("#browse-body .bcard");
  await page.waitForSelector("#browse-body iframe.browse-player");
  check("a clip plays in the clip embed", (await page.getAttribute(".browse-player", "src")) === "https://clips.twitch.tv/embed?clip=WeekOne&parent=yappa.test&autoplay=true");
  await page.evaluate(() => composer.setText(""));
  await page.click('#browse-body button:has-text("Put link in chat box")');
  check("'Put link in chat box' closes the window and drops the clip's link in the message box", await page.$eval("#browse-modal", (m) => m.hidden) && (await page.evaluate(() => composer.getText())).startsWith("https://clips.twitch.tv/WeekOne"));
  await page.evaluate(() => composer.setText(""));
  check("closing removed the embed", (await page.$$("#browse-body iframe")).length === 0);

  // Failures can be retried.
  browseFails = true;
  await page.click("#clips-btn");
  await page.waitForSelector("#browse-body .browse-note button");
  check("a failed load says so, with Try again", (await page.textContent("#browse-body .browse-note")).includes("Couldn't reach Twitch."));
  browseFails = false;
  await page.click("#browse-body .browse-note button");
  await page.waitForSelector("#browse-body .bcard");
  check("Try again works", (await page.$$("#browse-body .bcard")).length === 3);
  await page.keyboard.press("Escape");
  check("Escape closes the window", await page.$eval("#browse-modal", (m) => m.hidden));

  // Creating clips.
  await page.click("#clips-btn");
  await page.waitForSelector("#browse-body .clipper");
  check("offline: clipping says it needs a live stream, no buttons", (await page.textContent("#browse-body .clipper")).includes("while #UwoSlab is live") && !(await page.$("#browse-body .clipper button")));
  await page.keyboard.press("Escape");
  noClipsScope = true;
  await page.evaluate(() => { tabs.get("uwoslab").stream = { user_id: "999", title: "t", game_name: "g", viewer_count: 9, started_at: new Date().toISOString() }; return refreshStatus(); });
  await page.click("#clips-btn");
  await page.waitForSelector("#browse-body .clipper");
  check("live but without the permission: a Reconnect link, no buttons", (await page.$eval("#browse-body .clipper a", (a) => a.getAttribute("href"))) === "/auth/login" && !(await page.$("#browse-body .clipper button")));
  await page.keyboard.press("Escape");
  noClipsScope = false;
  await page.evaluate(() => refreshStatus());
  await page.click("#clips-btn");
  await page.waitForSelector("#browse-body .clipper button");
  const lens = await page.$$eval("#browse-body .clipper button", (bs) => bs.map((b) => b.textContent));
  check("live with the permission: a title box and 15 / 30 / 60 second buttons", JSON.stringify(lens) === '["Clip last 15s","Clip last 30s","Clip last 60s"]' && !!(await page.$("#clip-title")), JSON.stringify(lens));
  await page.screenshot({ path: dir + "/t34-clipper.png" });
  await page.fill("#clip-title", "great play");
  await page.evaluate(() => composer.setText(""));
  const sentBeforeClip = log.sent.length;
  check("the 'post the link in chat' box is on by default", await page.$eval("#clip-post", (c) => c.checked));
  await page.click('#browse-body .clipper button:has-text("30s")');
  await page.waitForSelector('#browse-body .clipper .state:has-text("Creating")');
  check("tapping a length creates the clip with that title (buttons disabled meanwhile)", JSON.stringify(log.clipCreates.at(-1)) === '{"broadcaster_id":"999","duration":30,"title":"great play"}' && await page.$eval('#browse-body .clipper button', (b) => b.disabled));
  await page.waitForSelector("#browse-body .clipper .state.ok", { timeout: 10000 });
  check("it waits for Twitch to publish it (first lookup came back empty), then posts the link in chat as you",
    log.clips.filter((x) => x === "NewClip1").length >= 2 && (await page.textContent("#browse-body .clipper .state")) === "Clip created, and its link is posted in chat." &&
    log.sent.length === sentBeforeClip + 1 && log.sent.at(-1) === "https://clips.twitch.tv/NewClip1", JSON.stringify(log.sent.slice(sentBeforeClip)));
  check("the posted message is tracked as sent from here (so color cycling doesn't count it twice)", await page.evaluate(() => [...sentIds].some((id) => id.startsWith("sent-"))));
  check("the new clip is first in the list, highlighted", await page.$eval("#browse-body .brow", (r) => r.classList.contains("fresh") && r.querySelector(".bt").textContent.length > 0));
  const note = await page.evaluate(() => { const li = [...active.list.querySelectorAll("li.clip-made")].at(-1); return li && { head: li.querySelector(".sysmsg").textContent, card: !!li.querySelector("a.clip-card"), edit: (li.querySelector("a.btn") || {}).href, buttons: [...li.querySelectorAll("button")].map((b) => b.textContent) }; });
  check("chat also gets a 'Clip created and posted' notice with the Edit link and share buttons (the card is on the posted message)", note && !note.card && note.head === "Clip created and posted in chat" && note.edit === "https://clips.twitch.tv/NewClip1/edit" && note.buttons[0] === "Put link in chat box", JSON.stringify(note));
  await page.keyboard.press("Escape");
  await page.evaluate(() => { [...active.list.querySelectorAll("li.clip-made button")][0].click(); });
  check("the notice's button puts the clip link in the message box", (await page.evaluate(() => composer.getText())).startsWith("https://clips.twitch.tv/NewClip1"));
  await page.evaluate(() => composer.setText(""));
  // Twitch refusing (not live / restricted): the reason shows, and it can be retried.
  clipCreateError = "This channel isn't live, so there's nothing to clip.";
  await page.click("#clips-btn");
  await page.waitForSelector("#browse-body .clipper button");
  await page.click('#browse-body .clipper button:has-text("15s")');
  await page.waitForSelector("#browse-body .clipper .state.err");
  check("a refused clip shows Twitch's reason, and the buttons work again", (await page.textContent("#browse-body .clipper .state")).includes("isn't live") && !(await page.$eval('#browse-body .clipper button', (b) => b.disabled)));
  clipCreateError = null;
  await page.keyboard.press("Escape");

  // Not posting: switch the box off, and nothing is sent.
  const makeClip = async () => {
    await page.click("#clips-btn");
    await page.waitForSelector("#browse-body .clipper button");
    await page.click('#browse-body .clipper button:has-text("30s")');
    await page.waitForSelector("#browse-body .clipper .state.ok, #browse-body .clipper .state.err", { timeout: 10000 });
  };
  await page.click("#clips-btn");
  await page.waitForSelector("#clip-post");
  await page.uncheck("#clip-post");
  check("unchecking the box turns it off for good", (await page.evaluate(() => settings.postClips)) === false && JSON.parse(await page.evaluate(() => localStorage.getItem("settings"))).postClips === false);
  await page.keyboard.press("Escape");
  const sent2 = log.sent.length;
  await makeClip();
  check("with posting off: nothing is sent, the notice keeps the clip card", log.sent.length === sent2 && (await page.textContent("#browse-body .clipper .state")) === "Clip created!" && await page.evaluate(() => { const li = [...active.list.querySelectorAll("li.clip-made")].at(-1); return !!li.querySelector("a.clip-card") && li.querySelector(".sysmsg").textContent === "Clip created"; }));
  await page.keyboard.press("Escape");
  // Settings has the same switch.
  const row = await page.evaluate(() => { openSettings(); const r = [...document.querySelectorAll("#sheet-body .row")].find((x) => x.textContent.includes("Post new clips in chat")); const on = r && r.querySelector("input").checked; if (r) r.querySelector("input").click(); const now = settings.postClips; closeSheet(); return { found: !!r, was: on, now }; });
  check("Settings has 'Post new clips in chat' (reflecting the box), and toggling it works", row.found && row.was === false && row.now === true, JSON.stringify(row));
  // Posting fails (slow mode, links blocked...): the clip still exists, and the reason is shown.
  sendFailure = "Your message was not sent: slow mode is on.";
  const tries0 = (log.sendTries || []).length;
  await makeClip();
  const failed = await page.evaluate(() => { const li = [...active.list.querySelectorAll("li.clip-made")].at(-1); return { state: document.querySelector("#browse-body .clipper .state").textContent, cls: document.querySelector("#browse-body .clipper .state").className, err: (li.querySelector(".sys.err") || {}).textContent, card: !!li.querySelector("a.clip-card") }; });
  check("a failed post says why, still shows the clip card and its buttons", (log.sendTries || []).length === tries0 + 1 && failed.cls.includes("err") && failed.state === "Clip created, but its link wasn't posted: Your message was not sent: slow mode is on." && failed.err.includes("slow mode") && failed.card, JSON.stringify(failed));
  sendFailure = null;
  await page.keyboard.press("Escape");
  await page.evaluate(() => { tabs.get("uwoslab").stream = null; });
}

// =============== account menu (profile picture), your clips, and sharing ===============
{
  await page.click(".tab:first-child .tab-name");
  check("the gear is gone; your picture is in the corner", !(await page.$("#settings-btn")) && await page.evaluate(() => { const b = document.getElementById("profile-btn"), i = document.getElementById("avatar-img"); return !b.hidden === true && b.querySelector("img") === i; }));
  await page.waitForFunction(() => { const i = document.getElementById("avatar-img"); return !i.hidden && i.naturalWidth > 0; });
  const av = await page.evaluate(() => { const i = document.getElementById("avatar-img"), b = document.getElementById("profile-btn").getBoundingClientRect(), s = document.querySelector("header form button").getBoundingClientRect(); return { src: i.getAttribute("src"), title: document.getElementById("profile-btn").title, round: getComputedStyle(document.getElementById("profile-btn")).borderRadius, w: Math.round(b.width), sameRow: Math.abs(b.top + b.height / 2 - (s.top + s.height / 2)) < 12, rightOfOpen: b.left > s.right }; });
  check("it shows your Twitch picture, round, on the header row next to Open", av.src === "https://img.test/avatar.png" && av.title === "Account: TestUser" && av.round === "50%" && av.w === 32 && av.sameRow && av.rightOfOpen, JSON.stringify(av));
  await page.click("#profile-btn");
  const menu = await page.evaluate(() => ({ expanded: document.getElementById("profile-btn").getAttribute("aria-expanded"), name: document.querySelector("#account-menu .dn").textContent, login: document.querySelector("#account-menu .ln").textContent, items: [...document.querySelectorAll("#account-menu button")].map((b) => b.textContent), h: Math.round(document.querySelector("#account-menu button").getBoundingClientRect().height), pic: !!document.querySelector("#account-menu .who img") }));
  check("the menu shows who you are (picture, name, @username) and Settings / Your clips / Log out",
    menu.expanded === "true" && menu.name === "TestUser" && menu.login === "@testuser" && JSON.stringify(menu.items) === '["Settings","Your clips","Log out"]' && menu.pic && menu.h >= 44, JSON.stringify(menu));
  await page.screenshot({ path: dir + "/t35-account-menu.png" });
  await page.keyboard.press("Escape");
  check("Escape closes it", await page.$eval("#account-menu", (m) => m.hidden) && (await page.getAttribute("#profile-btn", "aria-expanded")) === "false");
  await page.click("#profile-btn");
  await page.mouse.click(200, 400);
  check("tapping elsewhere closes it", await page.$eval("#account-menu", (m) => m.hidden));
  await openSettingsUI();
  check("Settings opens from the menu (and the menu closes)", (await page.textContent("#sheet-body")).includes("Settings") && await page.$eval("#account-menu", (m) => m.hidden));
  await page.click("#sheet-close");
  // Log out asks first.
  await page.evaluate(() => { window.__realConfirm = window.confirm; window.confirm = (m) => { window.__asked = m; return false; }; });
  await page.click("#profile-btn");
  await page.click('#account-menu button:has-text("Log out")');
  await sleep(200);
  const asked = await page.evaluate(() => { window.confirm = window.__realConfirm; return window.__asked; });
  check("Log out asks for confirmation, and cancelling does nothing", /Log out/.test(asked || "") && !(log.logouts || 0) && await page.evaluate(() => !!me));
  // No picture (or it can't load): your initial instead.
  noAvatar = true;
  await page.evaluate(() => { document.getElementById("avatar-img").removeAttribute("src"); return refreshStatus(); });
  check("no picture → your initial in the circle", await page.evaluate(() => document.getElementById("avatar-img").hidden && getComputedStyle(document.getElementById("avatar-letter")).display !== "none" && document.getElementById("avatar-letter").textContent === "T"));
  noAvatar = false;
  await page.evaluate(() => refreshStatus());
  await page.waitForFunction(() => !document.getElementById("avatar-img").hidden);

  // Your clips.
  await page.click("#profile-btn");
  await page.click('#account-menu button:has-text("Your clips")');
  await page.waitForSelector("#browse-modal:not([hidden]) .bcard");
  const mine = await page.evaluate(() => ({ title: document.getElementById("browse-title").textContent, tabs: !!document.querySelector("#browse-body .browse-tabs"), clipper: !!document.querySelector("#browse-body .clipper"), note: document.querySelector("#browse-body .browse-note").textContent, titles: [...document.querySelectorAll("#browse-body .bt")].map((x) => x.textContent) }));
  check("Your clips lists the clips you made through Yappa (no tabs or create box), and says why only those",
    mine.title === "Your clips" && !mine.tabs && !mine.clipper && /made with Yappa/.test(mine.note) && /aren't here/.test(mine.note) && JSON.stringify(mine.titles) === '["My first clip","My second clip"]', JSON.stringify(mine));
  await page.screenshot({ path: dir + "/t36-your-clips.png" });
  await page.click("#browse-body .browse-more");
  await page.waitForFunction(() => document.querySelectorAll("#browse-body .bcard").length === 3);
  check("Load more pages through them", log.mine.at(-1) === "?after=20" && !(await page.$("#browse-body .browse-more")));

  // Sharing: the phone's share sheet when there is one...
  await page.evaluate(() => { window.__shared = []; navigator.share = async (d) => { window.__shared.push(d); }; });
  await page.click("#browse-body .brow >> nth=0 >> .bshare");
  check("Share on a card opens the share sheet with the clip's title and link", JSON.stringify(await page.evaluate(() => window.__shared)) === '[{"title":"My first clip","text":"My first clip","url":"https://clips.twitch.tv/MineOne"}]', JSON.stringify(await page.evaluate(() => window.__shared)));
  // ...otherwise it copies the link.
  await page.evaluate(() => { delete navigator.share; window.__copied = []; Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t) => { window.__copied.push(t); } }, configurable: true }); });
  await page.click("#browse-body .brow >> nth=1 >> .bshare");
  check("without a share sheet it copies the link and says so, then goes back to 'Share'", JSON.stringify(await page.evaluate(() => window.__copied)) === '["https://clips.twitch.tv/MineTwo"]' && (await page.textContent("#browse-body .brow >> nth=1 >> .bshare")) === "Copied!");
  await page.waitForFunction(() => document.querySelectorAll("#browse-body .bshare")[1].textContent === "Share", null, { timeout: 4000 });
  // In the player view too.
  await page.click("#browse-body .brow >> nth=0 >> .bcard");
  await page.waitForSelector("#browse-body iframe.browse-player");
  await page.evaluate(() => { window.__copied = []; });
  await page.click('#browse-body .browse-actions button:has-text("Share")');
  check("the player view has Share too", JSON.stringify(await page.evaluate(() => window.__copied)) === '["https://clips.twitch.tv/MineOne"]');
  await page.screenshot({ path: dir + "/t37-share-player.png" });
  await page.keyboard.press("Escape");
  // ...and on VODs.
  await page.click("#clips-btn");
  await page.click('#browse-body .browse-tabs button:has-text("Past broadcasts")');
  await page.waitForFunction(() => document.querySelector("#browse-body .bt") && document.querySelector("#browse-body .bt").textContent === "Friday night stream");
  await page.evaluate(() => { window.__copied = []; });
  await page.click("#browse-body .brow >> nth=0 >> .bshare");
  check("VODs can be shared too", JSON.stringify(await page.evaluate(() => window.__copied)) === '["https://www.twitch.tv/videos/1001"]');
  await page.keyboard.press("Escape");
  // Nothing made yet.
  noMyClips = true;
  await page.click("#profile-btn");
  await page.click('#account-menu button:has-text("Your clips")');
  await page.waitForFunction(() => document.getElementById("browse-body").textContent.includes("You haven't made any clips"));
  check("empty state for no clips yet", (await page.textContent("#browse-body")).includes("You haven't made any clips with Yappa yet."));
  noMyClips = false;
  await page.keyboard.press("Escape");
}

// =============== moving to a new address ===============
{
  const oldSettings = JSON.stringify({ ...JSON.parse(await page.evaluate(() => localStorage.getItem("settings"))), rules: [{ phrase: "moved", user: "" }] });
  const p2 = await ctx.newPage();
  p2.on("pageerror", (e) => errors.push("p2: " + e.message));
  await p2.goto("https://old.test/seed");
  await p2.evaluate((st) => { localStorage.setItem("settings", st); localStorage.setItem("tabs", '["otherchan","uwoslab"]'); localStorage.setItem("lastChannel", "otherchan"); }, oldSettings);
  await page.evaluate(() => localStorage.clear()); // the new address starts empty
  await p2.goto("https://old.test/");
  await p2.waitForURL("https://yappa.test/**");
  await p2.waitForFunction(() => document.querySelectorAll(".tab").length === 2, null, { timeout: 5000 });
  const moved = await p2.evaluate(() => ({ hash: location.hash, rules: settings.rules, tabs: localStorage.getItem("tabs"), active: active && active.login }));
  check("old address carries tabs and settings to the new one", moved.hash === "#otherchan" && moved.rules[0].phrase === "moved" && moved.tabs === '["otherchan","uwoslab"]' && moved.active === "otherchan", JSON.stringify(moved));
  // A sign-in error that lands on the old address survives the hop to the new one.
  await p2.goto("https://old.test/?error=" + encodeURIComponent("The provided redirect_uri does not match"));
  await p2.waitForURL("https://yappa.test/**");
  await p2.waitForSelector("#error:not([hidden])");
  check("sign-in error on the old address is shown at the new one", (await p2.textContent("#error")) === "The provided redirect_uri does not match");
  // An import link never overwrites a browser that already has data.
  await p2.goto("https://yappa.test/?reload#import=" + encodeURIComponent(JSON.stringify({ settings: JSON.stringify({ rules: [{ phrase: "evil", user: "" }] }) })));
  await p2.waitForFunction(() => typeof settings !== "undefined");
  check("import doesn't overwrite existing data", (await p2.evaluate(() => settings.rules[0].phrase)) === "moved" && !(await p2.evaluate(() => location.hash)).includes("import"));
  await p2.close();
}

await browser.close();
if (errors.length) console.log("Browser errors:", errors);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed || errors.length ? 1 : 0);
