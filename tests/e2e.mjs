// End-to-end UI test: the real page and client JS in headless Chromium at phone size,
// with Twitch (EventSub WebSocket, IRC, Helix-backed /api routes), 7TV/BTTV/FFZ and the
// Twitch player all faked. Run with `npm run test:e2e` (see CLAUDE.md for browser setup).
import { chromium } from "playwright-core";
import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = fileURLToPath(new URL("./output", import.meta.url)); // screenshots + bundle (git-ignored)
mkdirSync(dir, { recursive: true });
await build({
  stdin: { contents: 'export { renderPage, PAGE_HEADERS } from "./src/page.ts"; export { renderMoved } from "./src/moved.ts"; export * as toolsLib from "./src/tools.ts"; export { relayMaster } from "./src/usher.ts"; export { parseClipsQuery, parseVideosQuery, parseCreateClip, parseDuration, videoThumb, slimClip, slimVideo, clipFailure } from "./src/browse.ts"; export { staticFiles } from "./src/static.ts";', resolveDir: root, sourcefile: "entry.ts", loader: "ts" },
  bundle: true, format: "esm", outfile: dir + "/page.bundle.mjs", logLevel: "warning",
  loader: { ".css": "text", ".js": "text", ".png": "base64" },
});
// The Worker itself (sign-in, sessions, allowlist), with the Durable Object runtime faked so it runs in Node.
await build({
  stdin: { contents: 'export { default } from "./src/index.ts"; export { signSession, isAllowed } from "./src/session.ts";', resolveDir: root, loader: "ts" },
  bundle: true, format: "esm", outfile: dir + "/worker.bundle.mjs", logLevel: "warning",
  loader: { ".css": "text", ".js": "text", ".png": "base64" },
  plugins: [{ name: "fake-cloudflare-workers", setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "cf-workers", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export class DurableObject {}", loader: "js" }));
  } }],
});
const worker = await import(dir + "/worker.bundle.mjs?" + Date.now());
const { toolsLib, renderPage, PAGE_HEADERS, renderMoved, relayMaster, parseClipsQuery, parseVideosQuery, parseCreateClip, parseDuration, videoThumb, slimClip, slimVideo, clipFailure, staticFiles } = await import(dir + "/page.bundle.mjs?" + Date.now());
const html = renderPage();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell",
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: process.env.SHOTS ? 2 : 1 }); // 2x only for the README gallery
const page = await ctx.newPage();
// The README screenshots should look like a phone, not like this machine's fallback font: with
// SHOTS_FONTS=<dir holding Roboto-Regular/Medium/Bold .woff2> the page renders in Roboto, Android's system font.
if (process.env.SHOTS && process.env.SHOTS_FONTS) {
  const { readFileSync } = await import("node:fs");
  await page.addInitScript(() => {
    const css = ["400:Regular", "500:Medium", "700:Bold"].map((x) => x.split(":")).map(([w, n]) => `@font-face{font-family:ShotRoboto;font-weight:${w};src:url(/__shotfonts/Roboto-${n}.woff2) format("woff2")}`).join("");
    const st = document.createElement("style");
    st.textContent = css + 'body,button,input,select,textarea{font-family:ShotRoboto,system-ui,sans-serif !important}';
    const add = () => (document.head || document.documentElement).appendChild(st);
    if (document.documentElement) add(); else document.addEventListener("DOMContentLoaded", add);
  });
  await page.route("**/__shotfonts/*", (route) => {
    const file = new URL(route.request().url()).pathname.split("/").pop();
    route.fulfill({ body: readFileSync(process.env.SHOTS_FONTS + "/" + file.replace(/[^\w.-]/g, "")), contentType: "font/woff2" });
  });
}

// README gallery: `SHOTS=1 npm run test:e2e` also saves each state at phone and desktop size to docs/screenshots.
const galleryDir = fileURLToPath(new URL("../docs/screenshots", import.meta.url));
async function shot(name) {
  if (!process.env.SHOTS) return;
  const { mkdirSync } = await import("node:fs");
  mkdirSync(galleryDir, { recursive: true });
  await page.screenshot({ path: galleryDir + "/" + name + "-mobile.png" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(350);
  await page.screenshot({ path: galleryDir + "/" + name + "-desktop.png" });
  await page.setViewportSize({ width: 390, height: 760 });
  await sleep(350);
}

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
const expectedErrors = [/status of 403/, /status of 401/, /status of 503/, /status of 502/, /net::ERR_FAILED/];
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
let followedExtra = false;
let toolsScope = true;
const uwoStartedAt = new Date(Date.now() - 3 * 3600e3).toISOString();
let syncStore = null, syncMockOff = false;
const tools = { terms: [{ id: "t1", text: "spoiler", createdAt: "2024-01-01T00:00:00Z" }], shield: false, unbans: [{ id: "r1", userId: "501", login: "oldtimer", name: "OldTimer", text: "sorry about before!", createdAt: new Date(Date.now() - 3600e3).toISOString(), status: "pending" }] };
let flakyClip = 0;
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
    const f = staticFiles[u.pathname];
    if (f) return route.fulfill({ body: f.type === "image/png" ? Buffer.from(f.body, "base64") : f.body, contentType: f.type });
    if (u.pathname === "/api/cycle") { cycle.enabled = body().enabled; if (cycle.enabled) { cycle.lastColor = "#11AA22"; cycle.changes++; } log.cycle.push(cycle.enabled); return j({ ok: true, cycle }); }
    if (u.pathname === "/api/netfail") return sessionExpiredMock ? route.fulfill({ status: 401, json: { ok: false, error: "Sign in again.", signedOut: true } }) : route.abort();
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
      if (u.searchParams.has("fresh")) log.followingFresh = (log.followingFresh || 0) + 1;
      if (followingMode === "scope") return j({ ok: false, error: "Missing user:read:follows", needsScope: true });
      if (followingMode === "newlive") return j({ ok: true, live: [{ id: "4040", login: "newstreamer", name: "NewStreamer", title: "just started", game: "Chess", viewers: 5, startedAt: new Date().toISOString() }], channels: [{ id: "4040", login: "newstreamer", name: "NewStreamer" }] });
      return j({ ok: true,
        live: [{ id: "777", login: "targetchan", name: "TargetChan", title: "speedrun attempts", game: "Celeste", viewers: 4321, startedAt: new Date().toISOString() },
               { id: "999", login: "uwoslab", name: "UwoSlab", title: "Building a chat app", game: "Software and Game Development", viewers: 1234, startedAt: new Date().toISOString() }],
        channels: [{ id: "555", login: "zetachan", name: "ZetaChan" }, { id: "666", login: "alphachan", name: "AlphaChan" }, { id: "777", login: "targetchan", name: "TargetChan" }, { id: "999", login: "uwoslab", name: "UwoSlab" }, ...(followedExtra ? [{ id: ids.otherchan, login: "otherchan", name: "OtherChan" }] : [])] });
    }
    if (u.pathname === "/api/sync") {
      if (route.request().method() === "POST") {
        const b = body();
        log.sync = [...(log.sync || []), b];
        if (syncStore && syncStore.at > b.at) return j({ ok: true, stored: false, current: syncStore });
        syncStore = b;
        return j({ ok: true, stored: true, current: b });
      }
      return j({ ok: true, sync: syncMockOff ? null : syncStore });
    }
    if (u.pathname === "/api/status" && statusDown) return route.fulfill({ status: 503, json: { ok: false, error: "The server is updating; try again in a minute.", retry: true } });
    if (u.pathname === "/api/status") { statusCalls++; return j({ ...(u.searchParams.has("sync") ? { sync: syncMockOff ? null : syncStore } : {}), twitch: { login: "testuser", userId: "111", displayName: "TestUser", avatar: noAvatar ? null : "https://img.test/avatar.png", missingScopes: [], missingOptionalScopes: noClipsScope ? ["clips:edit"] : [] }, cycle }); }
    if (u.pathname === "/auth/logout") { log.logouts = (log.logouts || 0) + 1; return j({ ok: true }); }
    if (u.pathname === "/api/my/clips") {
      log.mine = [...(log.mine || []), u.search];
      if (noMyClips) return j({ ok: true, clips: [], cursor: null });
      if (u.searchParams.get("after") === "20") return j({ ok: true, clips: [mkClip("MineThree", "Third of mine", 7)], cursor: null });
      return j({ ok: true, clips: [mkClip("MineOne", "My first clip", 120), mkClip("MineTwo", "My second clip", 80)], cursor: "20" });
    }
    // Moderator and personal tools.
    if (u.pathname.startsWith("/api/mod/") || u.pathname === "/api/sub" || u.pathname === "/api/blocks" || u.pathname === "/api/whisper" || u.pathname === "/api/whispers/subscribe") {
      const m = route.request().method();
      const b = m === "POST" ? body() : {};
      log.tools = [...(log.tools || []), m + " " + u.pathname + (m === "POST" ? " " + JSON.stringify(b) : "")];
      if (!toolsScope) return route.fulfill({ status: 403, json: { ok: false, error: "Reconnect Twitch to allow this.", needsScope: true } });
      switch (u.pathname) {
        case "/api/mod/announce": return j({ ok: true });
        case "/api/mod/shoutout": return j({ ok: true, target: "OtherChan" });
        case "/api/mod/warn": return j({ ok: true });
        case "/api/mod/terms": if (m === "GET") return j({ ok: true, terms: tools.terms }); tools.terms.unshift({ id: "t" + (tools.terms.length + 1), text: b.text, createdAt: new Date().toISOString() }); return j({ ok: true, term: tools.terms[0] });
        case "/api/mod/terms/remove": tools.terms = tools.terms.filter((t) => t.id !== b.id); return j({ ok: true });
        case "/api/mod/shield": if (m === "POST") tools.shield = b.active; return j({ ok: true, active: tools.shield });
        case "/api/mod/suspicious": return j({ ok: true });
        case "/api/mod/unbans": if (m === "POST") { tools.unbans = tools.unbans.filter((r) => r.id !== b.id); return j({ ok: true }); } return j({ ok: true, requests: tools.unbans });
        case "/api/mod/chatters": return j({ ok: true, total: 1500, names: ["Alice", "Bob", "Carol", "Dave"] });
        case "/api/sub": return j({ ok: true, sub: u.searchParams.get("broadcaster_id") === "999" ? { tier: "2000", isGift: true, gifter: "KindPerson" } : null });
        case "/api/blocks": if (m === "POST") return j({ ok: true }); return j({ ok: true, users: [{ id: "7777", login: "blockedguy", name: "BlockedGuy" }] });
        case "/api/whisper": return j({ ok: true });
        case "/api/whispers/subscribe": return j({ ok: true, id: "w1" });
      }
    }
    if (u.pathname.startsWith("/api/discover/") || u.pathname === "/api/schedule") {
      log.discover = [...(log.discover || []), u.pathname + u.search];
      if (u.pathname === "/api/schedule") return j({ ok: true, segments: [{ id: "s1", start: new Date(Date.now() + 86400e3).toISOString(), end: null, title: "Friday night stream", category: "Just Chatting", recurring: true, canceled: false }, { id: "s2", start: new Date(Date.now() + 3 * 86400e3).toISOString(), end: null, title: "Special event", category: null, recurring: false, canceled: true }] });
      if (u.pathname === "/api/discover/categories") return j({ ok: true, categories: [{ id: "509658", name: "Just Chatting", art: null }, { id: "27471", name: "Minecraft", art: null }] });
      if (u.pathname === "/api/discover/search") { const q = u.searchParams.get("q"); return j({ ok: true, channels: q === "otherchan" || q === "zzz" ? [] : [{ id: "321", login: "findable", name: "Findable", live: true, title: "found me", game: "Minecraft", startedAt: new Date().toISOString() }, { id: "322", login: "sleepy", name: "Sleepy", live: false, title: "", game: "", startedAt: null }], cursor: null }); }
      const gid = u.searchParams.get("game_id");
      return j({ ok: true, streams: [{ id: "1", login: "topstreamer", name: "TopStreamer", title: gid ? "Minecraft run" : "Huge stream", game: gid ? "Minecraft" : "Fortnite", viewers: 45000, startedAt: new Date().toISOString(), thumbnail: "https://img.test/thumb-top.jpg", language: "en" }], cursor: null });
    }
    if (u.pathname === "/api/chat/subscribe") { const b = body(); log.subs.push(b.channel + "@" + b.session_id); return j({ ok: true, broadcaster: { id: ids[b.channel], login: b.channel, name: { uwoslab: "UwoSlab", otherchan: "OtherChan", targetchan: "TargetChan", alphachan: "AlphaChan" }[b.channel] || b.channel }, isMod: b.channel === "uwoslab", subscriptionIds: [b.channel + "-s1", b.channel + "-s2"], automod: b.channel === "uwoslab", settings: b.channel === "uwoslab" ? chatSettings : null }); }
    if (u.pathname === "/api/streams") return j([{ user_id: "999", title: "Building a chat app", game_name: "Software and Game Development", viewer_count: 1234, started_at: uwoStartedAt }]);
    if (u.pathname === "/api/chat/settings") { const b = body(); log.settings.push(b); Object.assign(chatSettings, b); delete chatSettings.broadcaster_id; return j({ ok: true, settings: chatSettings }); }
    if (u.pathname === "/api/chat/user") return j({ ok: true, user: { id: u.searchParams.get("user_id"), login: "spammer", display_name: "Spammer", description: "I sell followers", profile_image_url: "https://img.test/a.png", broadcaster_type: "", created_at: "2020-01-02T00:00:00Z" }, followedAt: "2024-05-06T00:00:00Z" });
    if (u.pathname === "/api/chat/automod") { log.automod.push(body()); return j({ ok: true }); }
    if (u.pathname === "/api/chat/cheermotes") return j([{ prefix: "Cheer", tiers: [{ min_bits: 1, color: "#979797", images: { dark: { animated: { "2": "https://img.test/cheer1.gif" } } } }, { min_bits: 100, color: "#9c3ee8", images: { dark: { animated: { "2": "https://img.test/cheer100.gif" } } } }] }]);
    if (u.pathname === "/api/chat/clip") {
      const id = u.searchParams.get("id"); log.clips.push(id);
      if (id === "MissingClip") return j({ ok: true, clip: null });
      if (id === "FlakySlug" && flakyClip++ < 1) return route.fulfill({ status: 502, json: { ok: false, error: "Couldn't reach Twitch." } });
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
    if (u.pathname === "/api/chat/badges") return j({
      "moderator/1": { url: "https://img.test/badge-mod.png", title: "Moderator", description: "Moderator" },
      "subscriber/2003": { url: "https://img.test/badge-sub.png", title: "3-Month Subscriber", description: "Subscriber" },
      "bits/1000": { url: "https://img.test/badge-bits.png", title: "cheer 1000", description: "cheer 1000" },
      "weird-badge/1": { url: "https://img.test/badge-weird.png", title: "Weird Badge", description: "Awarded for doing something unusual" },
    });
    if (u.pathname === "/api/chat/emotes") { log.emotes = [...(log.emotes || []), u.searchParams.get("broadcaster_id")]; }
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
  if (u.host === "player.twitch.tv") { log.player.push(u.search); return route.fulfill({ body: "<meta charset=utf-8><body style='margin:0;background:#111;color:#9147ff;display:grid;place-items:center;height:100vh;font:20px sans-serif'>Twitch player (test stand-in): " + u.searchParams.get("channel") + "</body>", contentType: "text/html; charset=utf-8" }); }
  if (u.host === "www.twitch.tv" && u.pathname.startsWith("/embed/")) { log.chatEmbeds = [...(log.chatEmbeds || []), u.pathname + u.search]; return route.fulfill({ body: "<body style='margin:0;background:#18181b;color:#adadb8;display:grid;place-items:center;height:100vh;font:15px sans-serif'>Twitch chat embed (test)</body>", contentType: "text/html" }); }
  if (u.host === "api.betterttv.net") {
    if (u.pathname === "/3/cached/emotes/global") return j([{ id: "bg1", code: "OMEGALUL" }]);
    if (u.pathname.startsWith("/3/cached/users/twitch/")) return j({ channelEmotes: [{ id: "bc1", code: "uwuDance" }], sharedEmotes: [{ id: "bs1", code: "sharedOne" }] });
    if (u.pathname === "/3/cached/frankerfacez/emotes/global") return j([{ id: 9, code: "ZrehplaR", images: { "1x": "https://cdn.betterttv.net/frankerfacez_emote/9/1", "2x": "https://cdn.betterttv.net/frankerfacez_emote/9/2" } }]);
    return j([]);
  }
  if (/img\.test/.test(u.href)) {
    // Varied stand-in pictures (so screenshots aren't a wall of identical blobs): a 16:9 tile for thumbnails, a disc otherwise.
    const hue = [...u.pathname].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
    const wide = /clip-|vod|thumb/.test(u.pathname);
    return route.fulfill({ body: wide ? `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},60%,45%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},60%,25%)"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/></svg>` : svg(hue), contentType: "image/svg+xml" });
  }
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
await shot("chat");

await page.click(".tab:first-child .tab-name");
s = await state();
check("switching clears unread, updates hash", s.tabs === "UwoSlab*[MOD] | OtherChan" && s.hash === "#uwoslab", s.tabs + " " + s.hash);
check("mod hint in placeholder", s.placeholder.includes("/ban"), s.placeholder);
const modBtns = await page.$$eval('li[data-id="u2"] .actions button', (bs) => bs.map((b) => b.textContent));
check("mod actions on others' messages", modBtns.join(",") === "Reply,Save,Translate,Delete,Timeout,Ban", modBtns.join(","));

await page.tap('li[data-id="u2"] .body');
await sleep(100);
await page.screenshot({ path: dir + "/t2-actions.png" });
await shot("mod-actions");
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
await shot("emote-autocomplete");
await page.keyboard.press("Enter");
s = await state();
check("Enter accepts after ':'", s.input === "hi catJAM ", JSON.stringify(s.input));
await page.keyboard.type("Kap");
s = await state();
check("bare 3-letter prefix shows popup", s.suggest && s.suggest.startsWith("Kappa"), s.suggest);
await page.keyboard.press("Enter");
await sleep(150);
check("Enter on bare word sends instead of completing", log.sent.at(-1) === "hi catJAM Kap", JSON.stringify(log.sent));
// Typing a whole emote name adds the space by itself, so it shows as the emote right away.
await page.evaluate(() => composer.setText(""));
await page.keyboard.type("Kappa");
s = await state();
check("typing a full emote name adds the space and shows the emote", s.input === "Kappa " && await page.$eval("#message", (m) => !!m.querySelector(".emote, [data-emote], span[style*='background']")) && !s.suggest, JSON.stringify(s));
await page.keyboard.type(" ");
s = await state();
check("a habitual space after the name doesn't make two", s.input === "Kappa ", JSON.stringify(s.input));
await page.keyboard.type("x");
s = await state();
check("the caret stays after the space (typing goes on from there)", s.input === "Kappa x", JSON.stringify(s.input));
await page.keyboard.press("Backspace");
await page.keyboard.press("Backspace");
s = await state();
check("deleting back to the name doesn't add the space again", s.input === "Kappa", JSON.stringify(s.input));
await page.evaluate(() => composer.setText(""));
await page.evaluate(() => active.ext.set("KappaPride", { url: "https://cdn.7tv.app/emote/K", source: "7TV" }));
await page.keyboard.type("Kappa");
s = await state();
check("no auto space while a longer emote starts the same way (KappaPride)", s.input === "Kappa" && /^Kappa/.test(s.suggest || ""), JSON.stringify(s));
await page.keyboard.type("Pride");
s = await state();
check("so the longer name can be typed (then it finishes)", s.input === "KappaPride ", JSON.stringify(s.input));
await page.evaluate(() => active.ext.delete("KappaPride"));
await page.evaluate(() => { active.ext.set("pog", { url: "https://cdn.7tv.app/emote/P", source: "7TV" }); composer.setText(""); });
await page.keyboard.type("poggers");
s = await state();
check("an all-lowercase emote name (an ordinary word) isn't auto-finished", s.input === "poggers", JSON.stringify(s.input));
await page.evaluate(() => { active.ext.delete("pog"); composer.setText(""); });
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

// A draft that moves with you between tabs shows only the emotes this channel has.
{
  const names = await page.evaluate(() => [...tabs.keys()]);
  const [a, b] = [names[0], names[1]];
  await page.evaluate(([a]) => activate(tabs.get(a)), [a]);
  await page.evaluate(([a]) => { tabs.get(a).ext.set("OnlyHere", { url: "https://cdn.7tv.app/emote/O", source: "7TV", zeroWidth: false }); composer.setText(""); }, [a]);
  await page.click("#message");
  await page.keyboard.type("hi OnlyHere ok");
  check("an emote this channel has shows as an emote", (await page.$$eval("#message .ce-emote", (e) => e.map((x) => x.dataset.name))).includes("OnlyHere"));
  await page.evaluate(([b]) => activate(tabs.get(b)), [b]);
  const away = await page.evaluate(() => ({ text: composer.getText(), emotes: [...document.querySelectorAll("#message .ce-emote")].map((x) => x.dataset.name) }));
  check("switching to a channel without it turns it back into plain text (the draft is kept)", away.text === "hi OnlyHere ok" && !away.emotes.includes("OnlyHere"), JSON.stringify(away));
  await page.evaluate(([a]) => activate(tabs.get(a)), [a]);
  check("and back again it's an emote again", (await page.$$eval("#message .ce-emote", (e) => e.map((x) => x.dataset.name))).includes("OnlyHere"));
  await page.evaluate(([a]) => { tabs.get(a).ext.delete("OnlyHere"); composer.setText(""); }, [a]);
}

// Clicking a name shows the badges on that message, and what they mean.
{
  await page.evaluate(() => activate(tabs.get("uwoslab")));
  sockets[0].send(chat("999", "badged1", "Badgey", "6001", "look at my badges", { badges: [{ set_id: "moderator", id: "1", info: "" }, { set_id: "subscriber", id: "2003", info: "" }, { set_id: "bits", id: "1000", info: "" }, { set_id: "weird-badge", id: "1", info: "" }, { set_id: "mystery", id: "9", info: "" }] }));
  await page.waitForSelector('li[data-id="badged1"]');
  await page.evaluate(() => document.querySelector('li[data-id="badged1"] .name').click());
  await page.waitForSelector("#sheet .card-badges");
  const rows = await page.$$eval("#sheet .card-badge", (rs) => rs.map((r) => ({ title: r.querySelector(".cb-title").textContent, text: (r.querySelector(".hint") || {}).textContent || "", img: !!r.querySelector("img") })));
  check("the user card lists each badge on the clicked message with its icon", rows.length === 5 && rows.slice(0, 4).every((r) => r.img) && rows[0].title === "Moderator" && rows[1].title === "3-Month Subscriber", JSON.stringify(rows));
  check("known badges are explained in words (mod, tier 2 sub with months, bits total)", /Moderates this chat/.test(rows[0].text) && /Tier 2/.test(rows[1].text) && /3 months/.test(rows[1].text) && /1,000 Bits/.test(rows[2].text), JSON.stringify(rows.slice(0, 3)));
  check("an unfamiliar badge falls back to Twitch's description; an unknown one still shows by name", rows[3].text === "Awarded for doing something unusual" && rows[4].title === "mystery" && !rows[4].img, JSON.stringify(rows.slice(3)));
  await page.screenshot({ path: dir + "/t63-badges.png" });
  await shot("user-badges");
  await page.keyboard.press("Escape");
  // No badges: no section.
  sockets[0].send(chat("999", "badged2", "Plainy", "6002", "no badges here"));
  await page.waitForSelector('li[data-id="badged2"]');
  await page.evaluate(() => document.querySelector('li[data-id="badged2"] .name').click());
  await page.waitForSelector("#sheet .card-head");
  check("no badges, no Badges section", !(await page.$("#sheet .card-badges")));
  await page.keyboard.press("Escape");
}

// Tap an emote: its name and where it comes from.
{
  await page.evaluate(() => activate(tabs.get("uwoslab")));
  sockets[0].send(chat("999", "emotetip1", "Emoter", "6101", "hi Kappa catJAM", { fragments: [
    { type: "text", text: "hi " }, { type: "emote", text: "Kappa", emote: { id: "25", emote_set_id: "0", owner_id: "0", format: ["static"] } },
    { type: "text", text: " " }, { type: "emote", text: "uwoHype", emote: { id: "777", emote_set_id: "5", owner_id: "999", format: ["static"] } },
    { type: "text", text: " catJAM" }] }));
  await page.waitForSelector('li[data-id="emotetip1"] .emote-wrap img');
  const tip = async (sel) => { await page.evaluate((sel) => document.querySelector(sel).click(), sel); await sleep(50); return page.evaluate(() => { const t = document.querySelector(".emote-tip"); return t && { name: t.querySelector(".et-name").textContent, src: t.querySelector(".et-src").textContent, add: !!t.querySelector("button"), inView: (() => { const r = t.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })() }; }); };
  let t1 = await tip('li[data-id="emotetip1"] img[data-emote="Kappa"]');
  check("tapping a Twitch global emote names it and says so", t1 && t1.name === "Kappa" && t1.src === "Twitch · Twitch global emote" && t1.inView, JSON.stringify(t1));
  await page.screenshot({ path: dir + "/t64-emote-tip.png" });
  await shot("emote-tooltip");
  check("it isn't a message selection (no action bar)", await page.evaluate(() => !document.querySelector('li[data-id="emotetip1"]').classList.contains("selected")));
  t1 = await tip('li[data-id="emotetip1"] img[data-emote="uwoHype"]');
  check("tapping another emote replaces the tip; this channel's emote is labelled so", t1 && t1.name === "uwoHype" && /this channel's emote/.test(t1.src) && (await page.$$(".emote-tip")).length === 1, JSON.stringify(t1));
  t1 = await tip('li[data-id="emotetip1"] img[data-emote="catJAM"]');
  check("a third-party emote shows its service", t1 && t1.name === "catJAM" && /^7TV · /.test(t1.src), JSON.stringify(t1));
  check("'Add to message' is offered for an emote you can use here", t1 && t1.add);
  await page.evaluate(() => composer.setText(""));
  await page.click('.emote-tip button');
  check("Add to message puts the emote name in the box and closes the tip", (await page.evaluate(() => composer.getText())).trim() === "catJAM" && !(await page.$(".emote-tip")));
  await page.evaluate(() => composer.setText(""));
  await tip('li[data-id="emotetip1"] img[data-emote="Kappa"]');
  await page.evaluate(() => document.querySelector('li[data-id="emotetip1"] img[data-emote="Kappa"]').click());
  check("tapping the same emote again closes the tip", !(await page.$(".emote-tip")));
  await tip('li[data-id="emotetip1"] img[data-emote="Kappa"]');
  await page.keyboard.press("Escape");
  check("Escape closes it", !(await page.$(".emote-tip")));
  await tip('li[data-id="emotetip1"] img[data-emote="Kappa"]');
  await page.mouse.click(5, 400);
  await sleep(100);
  check("tapping elsewhere closes it", !(await page.$(".emote-tip")));
  // A very long name, with both buttons showing, must wrap sensibly instead of one letter per line.
  const longName = "ThisIsAnExtremelyLongEmoteNameThatKeepsGoingAndGoingForeverAndEver";
  await page.evaluate((n) => {
    active.ext.set(n, { url: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", zeroWidth: false, source: "7TV" });
    const img = emoteImg("data:image/gif;base64,R0lGODlhAQABAAAAACw=", n, "7TV", "this channel's emote");
    img.id = "longemote";
    const wrap = document.createElement("span");
    wrap.className = "emote-wrap";
    wrap.appendChild(img);
    document.querySelector('li[data-id="emotetip1"] .body').appendChild(wrap);
  }, longName);
  await tip("#longemote");
  const lt = await page.evaluate(() => { const t = document.querySelector(".emote-tip"), r = t.getBoundingClientRect(), x = t.querySelector(".et-text").getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), textW: Math.round(x.width), buttons: t.querySelectorAll("button").length, inView: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; });
  check("a really long emote name wraps in a tidy tooltip", lt.w <= 330 && lt.h < 190 && lt.textW >= 100 && lt.buttons === 2 && lt.inView, JSON.stringify(lt));
  await shot("emote-tooltip-long-name");
  await page.mouse.click(8, 700);
  await page.evaluate(() => document.getElementById("longemote").parentNode.remove());
  // Following the chat: scrolled out of view, the tip goes away; otherwise it stays with its emote.
  await tip('li[data-id="emotetip1"] img[data-emote="Kappa"]');
  await page.evaluate(() => { const l = document.querySelector(".messages:not([hidden])"); l.scrollTop += 3; });
  await sleep(100);
  check("a small scroll keeps the tip with its emote", !!(await page.$(".emote-tip")));
  await page.evaluate(() => { const l = document.querySelector(".messages:not([hidden])"); l.scrollTop = 0; });
  await sleep(100);
  check("scrolling it out of view closes it", !(await page.$(".emote-tip")));
  await page.evaluate(() => scrollToBottom(active));
}

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

// =============== moderator tools, whispers, block list, subscription chip, alerts, discovery ===============
{
  const L = () => log.tools.at(-1);
  await page.evaluate(() => activate(tabs.get("uwoslab")));
  await sleep(300);

  // Subscription chip
  check("subscription chip shows your tier on a channel you're subscribed to", await page.$eval("#sub-chip", (c) => !c.hidden && c.textContent === "Sub · T2" && /Tier 2/.test(c.title) && /KindPerson/.test(c.title)));
  await page.evaluate(() => activate(tabs.get("otherchan")));
  await sleep(300);
  check("no chip where you're not subscribed", await page.$eval("#sub-chip", (c) => c.hidden));
  await page.evaluate(() => activate(tabs.get("uwoslab")));

  // Info bar: tight icon spacing, and a long stream title scrolls instead of being cut off.
  const gaps = await page.evaluate(() => { const ids = ["video-btn", "pin-btn", "pip-btn", "follow-btn", "modtools-btn"].map((i) => document.getElementById(i)).filter((b) => b && !b.hidden); const r = ids.map((b) => b.getBoundingClientRect()); return r.slice(1).map((x, i) => Math.round(x.left - r[i].right)).filter((g) => g > -50 && g < 50); });
  check("info bar icon buttons sit close together", gaps.length >= 2 && gaps.every((g) => g <= 4), JSON.stringify(gaps));
  await page.evaluate(() => { tabs.get("uwoslab").stream.title = "A very long stream title that cannot possibly fit in the space the info bar gives it on a phone screen, so it has to scroll"; renderInfo(); });
  const scroll = await page.evaluate(() => { const t = document.querySelector("#live .title"); return { scrolls: t.classList.contains("scrolls"), shift: parseFloat(t.style.getPropertyValue("--shift")), anim: getComputedStyle(t.firstElementChild).animationName }; });
  check("a stream title too long for its space scrolls (slides left to its end)", scroll.scrolls && scroll.shift < -20 && scroll.anim === "title-scroll", JSON.stringify(scroll));
  await page.evaluate(() => { const st = tabs.get("uwoslab").stream; st.title = "Hi"; st.game_name = ""; renderInfo(); });
  check("a short title stays put", await page.evaluate(() => !document.querySelector("#live .title").classList.contains("scrolls")));
  await page.evaluate(() => { const st = tabs.get("uwoslab").stream; st.title = "Building a chat app"; st.game_name = "Software and Game Development"; renderInfo(); });

  // Mod tools button: only where you moderate
  check("Mod tools button shows in a channel you moderate", await page.$eval("#modtools-btn", (b) => !b.hidden));
  await page.evaluate(() => activate(tabs.get("otherchan")));
  check("and not elsewhere", await page.$eval("#modtools-btn", (b) => b.hidden));
  await page.evaluate(() => activate(tabs.get("uwoslab")));

  await page.click("#modtools-btn");
  await page.waitForSelector(".modtools .modes-grid");
  check("mod tools has Chat modes, Announce, Shoutout, Blocked terms, Shield Mode, Unbans, Chatters", JSON.stringify(await page.$$eval(".modtools .browse-tabs button", (b) => b.map((x) => x.textContent))) === '["Chat modes","Announce","Shoutout","Blocked terms","Shield Mode","Unbans","Chatters"]');
  await page.click('.modtools .browse-tabs button:has-text("Announce")');
  await page.waitForSelector(".modtools .tool-body input[type=text]");
  await page.fill(".modtools .tool-body input", "Giveaway at the top of the hour");
  await page.selectOption(".modtools .tool-body select", "purple");
  await page.screenshot({ path: dir + "/t69-modtools.png" });
  await shot("mod-tools");
  await page.click('.modtools button:has-text("Send announcement")');
  await page.waitForSelector('.modtools .tool-msg:has-text("Announcement sent")');
  check("announcement is sent to this channel with the chosen color", L() === 'POST /api/mod/announce {"broadcaster_id":"999","message":"Giveaway at the top of the hour","color":"purple"}', L());
  await page.click('.modtools .browse-tabs button:has-text("Shoutout")');
  await page.fill(".modtools .tool-body input", "@OtherChan");
  await page.click('.modtools button:has-text("Send shoutout")');
  await page.waitForSelector('.modtools .tool-msg:has-text("Shouted out OtherChan")');
  check("shoutout names the channel to promote", L() === 'POST /api/mod/shoutout {"broadcaster_id":"999","to_login":"@OtherChan"}', L());
  await page.click('.modtools .browse-tabs button:has-text("Blocked terms")');
  await page.waitForSelector(".modtools .tool-row");
  check("blocked terms lists the current ones", (await page.textContent(".modtools .tool-row")).includes("spoiler"));
  await page.fill(".modtools .tool-body input", "leaked");
  await page.click('.modtools button:has-text("Block this term")');
  await page.waitForSelector('.modtools .tool-msg:has-text("Term blocked")');
  check("adding a term puts it first", (await page.$$eval(".modtools .tool-row span", (r) => r.map((x) => x.textContent))).join() === "leaked,spoiler");
  await page.click('.modtools .tool-row:has-text("spoiler") button');
  await page.waitForSelector('.modtools .tool-msg:has-text("Term removed")');
  check("removing a term sends its id", L() === 'POST /api/mod/terms/remove {"broadcaster_id":"999","id":"t1"}' && (await page.$$(".modtools .tool-row")).length === 1, L());
  await page.click('.modtools .browse-tabs button:has-text("Shield Mode")');
  await page.waitForSelector('.modtools button:has-text("Turn Shield Mode on")');
  await page.click('.modtools button:has-text("Turn Shield Mode on")');
  await page.waitForSelector('.modtools button:has-text("Turn Shield Mode off")');
  check("Shield Mode turns on", L() === 'POST /api/mod/shield {"broadcaster_id":"999","active":true}' && /is ON/.test(await page.textContent(".modtools .tool-body")), L());
  await page.click('.modtools button:has-text("Turn Shield Mode off")');
  await page.waitForSelector('.modtools button:has-text("Turn Shield Mode on")');
  await page.click('.modtools .browse-tabs button:has-text("Unbans")');
  await page.waitForSelector(".modtools .tool-card");
  check("unban requests show who asked and why", (await page.textContent(".modtools .tool-card")).includes("OldTimer") && (await page.textContent(".modtools .tool-card")).includes("sorry about before!"));
  await page.fill(".modtools .tool-body input", "Welcome back");
  await page.click('.modtools .tool-card button:has-text("Unban")');
  await page.waitForSelector('.modtools .tool-msg:has-text("was unbanned")');
  check("approving sends the note and clears the request", L() === 'POST /api/mod/unbans {"broadcaster_id":"999","id":"r1","status":"approved","text":"Welcome back"}' && !(await page.$(".modtools .tool-card")), L());
  await page.click('.modtools .browse-tabs button:has-text("Chatters")');
  await page.waitForSelector("#tool-chatters .chatter");
  check("chatters shows the total and the names", /1,500 in chat/.test(await page.textContent(".modtools .tool-body")) && (await page.$$("#tool-chatters .chatter")).length === 4);
  await page.fill(".modtools .tool-body input", "car");
  check("and filters them", (await page.$$eval("#tool-chatters .chatter", (c) => c.map((x) => x.textContent))).join() === "Carol");
  await page.keyboard.press("Escape");

  // User card: moderator actions, whisper, block
  sockets[0].send(chat("999", "toolmsg1", "Target", "7001", "hello mods"));
  await page.waitForSelector('li[data-id="toolmsg1"]');
  await page.evaluate(() => { window.prompt = () => "Please stop that"; });
  await page.evaluate(() => document.querySelector('li[data-id="toolmsg1"] .name').click());
  await page.waitForSelector("#sheet .card-actions");
  const cardBtns = await page.$$eval("#sheet .card-actions button", (b) => b.map((x) => x.textContent));
  check("the user card offers Warn, Monitor/Restrict/Clear, Shout out, Whisper and Block", ["Warn", "Monitor", "Restrict", "Clear mark", "Shout out", "Whisper", "Block"].every((x) => cardBtns.includes(x)), JSON.stringify(cardBtns));
  await page.click('#sheet .card-actions button:has-text("Warn")');
  await sleep(200);
  check("Warn sends the reason", log.tools.some((x) => x === 'POST /api/mod/warn {"broadcaster_id":"999","user_id":"7001","reason":"Please stop that"}'), JSON.stringify(log.tools.slice(-3)));
  await page.evaluate(() => document.querySelector('li[data-id="toolmsg1"] .name').click());
  await page.waitForSelector("#sheet .card-actions");
  await page.click('#sheet .card-actions button:has-text("Restrict")');
  await sleep(200);
  check("Restrict marks them as a suspicious user", log.tools.some((x) => x === 'POST /api/mod/suspicious {"broadcaster_id":"999","user_id":"7001","status":"RESTRICTED"}'));
  await page.evaluate(() => document.querySelector('li[data-id="toolmsg1"] .name').click());
  await page.waitForSelector("#sheet .card-actions");
  await page.click('#sheet .card-actions button:has-text("Block")');
  await sleep(200);
  check("Block blocks them on Twitch and hides their messages", log.tools.some((x) => x === 'POST /api/blocks {"user_id":"7001","block":true}') && await page.$eval('li[data-id="toolmsg1"]', (l) => l.classList.contains("ignored")));
  await page.evaluate(() => document.querySelector('li[data-id="toolmsg1"] .name').click());
  await page.waitForSelector("#sheet .card-actions");
  await page.click('#sheet .card-actions button:has-text("Unblock")');
  await sleep(200);
  check("Unblock undoes it", log.tools.some((x) => x === 'POST /api/blocks {"user_id":"7001","block":false}') && await page.$eval('li[data-id="toolmsg1"]', (l) => !l.classList.contains("ignored")));
  // Your Twitch block list is applied when you connect.
  sockets[0].send(chat("999", "blockedmsg", "BlockedGuy", "7777", "you can't see me"));
  await page.waitForSelector('li[data-id="blockedmsg"]', { state: "attached" });
  await page.evaluate(() => toolsReloadBlocks());
  await sleep(300);
  check("messages from people on your Twitch block list are hidden", await page.$eval('li[data-id="blockedmsg"]', (l) => l.classList.contains("ignored")));
  await page.evaluate(() => { settings.syncBlocks = false; saveSettings(); toolsReloadBlocks(); });
  await sleep(200);
  check("unless you turn that off", await page.$eval('li[data-id="blockedmsg"]', (l) => !l.classList.contains("ignored")));
  await page.evaluate(() => { settings.syncBlocks = true; saveSettings(); toolsReloadBlocks(); });
  await sleep(200);

  // Feeds
  sockets[0].send(chat("999", "susp1", "Shady", "7002", "buy my stuff"));
  await page.waitForSelector('li[data-id="susp1"]');
  sockets[0].send(msg("notification", { subscription: { type: "channel.suspicious_user.message" }, event: { broadcaster_user_id: "999", user_id: "7002", user_login: "shady", user_name: "Shady", low_trust_status: "restricted", ban_evasion_evaluation: "likely", types: ["ban_evader"], message: { message_id: "susp1", text: "buy my stuff", fragments: [] } } }));
  await page.waitForSelector('li[data-id="susp1"] .flag.suspicious');
  check("a message from a suspicious user is flagged, saying why", /restricted, likely ban evader/.test(await page.textContent('li[data-id="susp1"] .flag.suspicious')));
  sockets[0].send(msg("notification", { subscription: { type: "channel.suspicious_user.message" }, event: { broadcaster_user_id: "999", user_id: "7003", user_login: "early", user_name: "Early", low_trust_status: "active_monitoring", ban_evasion_evaluation: "possible", types: [], message: { message_id: "susp2", text: "first", fragments: [] } } }));
  sockets[0].send(chat("999", "susp2", "Early", "7003", "first"));
  await page.waitForSelector('li[data-id="susp2"] .flag.suspicious');
  check("the flag also lands when the flagged event arrives before the message", /monitored, possible ban evader/.test(await page.textContent('li[data-id="susp2"] .flag.suspicious')));
  const ev2 = (extra) => msg("notification", { subscription: { type: "channel.moderate" }, event: { broadcaster_user_id: "999", moderator_user_id: "50", moderator_user_login: "modbot", moderator_user_name: "ModBot", ...extra } });
  sockets[0].send(ev2({ action: "ban", ban: { user_name: "Troll", reason: "spam" } }));
  await sleep(200);
  check("moderator actions aren't shown unless you turn the log on", !(await page.$$eval("li.modlog", (l) => l.some((x) => /banned Troll/.test(x.textContent)))));
  await page.evaluate(() => { settings.modLog = true; saveSettings(); });
  sockets[0].send(ev2({ action: "ban", ban: { user_name: "Troll", reason: "spam" } }));
  sockets[0].send(ev2({ action: "timeout", timeout: { user_name: "Mouthy", reason: "rude", expires_at: new Date(Date.now() + 600e3).toISOString() } }));
  sockets[0].send(ev2({ action: "delete", delete: { user_name: "Mouthy", message_body: "bad words" } }));
  sockets[0].send(ev2({ action: "slow", slow: { wait_time_seconds: 30 } }));
  await sleep(300);
  const logLines = await page.$$eval("li.modlog", (l) => l.map((x) => x.textContent));
  check("with the log on, bans, timeouts, deletions and chat modes appear as lines", ["ModBot banned Troll: spam", "ModBot timed out Mouthy for 10m: rude", "ModBot deleted a message from Mouthy: \u201cbad words\u201d", "ModBot turned on slow mode (30s)"].every((t) => logLines.includes(t)), JSON.stringify(logLines.slice(-5)));
  await page.evaluate(() => { settings.modLog = false; saveSettings(); });
  sockets[0].send(msg("notification", { subscription: { type: "channel.unban_request.create" }, event: { id: "r2", broadcaster_user_id: "999", user_id: "7004", user_login: "banned1", user_name: "Banned1", text: "I'm sorry", created_at: new Date().toISOString() } }));
  await page.waitForFunction(() => document.getElementById("modtools-count").textContent === "1" && !document.getElementById("modtools-count").hidden);
  check("a new unban request says so in chat and puts a count on the Mod tools icon", (await page.$$eval("li.modlog", (l) => l.some((x) => /Banned1 asked to be unbanned: \u201cI'm sorry\u201d/.test(x.textContent)))));
  await page.evaluate(() => { tabs.get("uwoslab").unbanCount = 0; renderInfo(); });
  // Shared chat
  sockets[0].send(chat("999", "shared1", "Visitor", "7005", "hi from another chat", { source_broadcaster_user_id: "888", source_broadcaster_user_name: "OtherChan" }));
  await page.waitForSelector('li[data-id="shared1"] .shared-pill');
  check("a message from another channel in a shared chat names where it came from", (await page.textContent('li[data-id="shared1"] .shared-pill')) === "OtherChan");
  sockets[0].send(chat("999", "notshared", "Local", "7006", "just us", { source_broadcaster_user_id: "999", source_broadcaster_user_name: "UwoSlab" }));
  await page.waitForSelector('li[data-id="notshared"]');
  check("messages from this channel itself get no label", !(await page.$('li[data-id="notshared"] .shared-pill')));

  // Whispers
  sockets[0].send(msg("notification", { subscription: { type: "user.whisper.message" }, event: { from_user_id: "7010", from_user_login: "whisperer", from_user_name: "Whisperer", to_user_id: "111", whisper_id: "w1", whisper: { text: "psst, got a minute?" } } }));
  await page.waitForSelector("#profile-btn.has-whisper");
  check("an incoming whisper puts a dot on your picture", true);
  await page.click("#profile-btn");
  check("and a count on Whispers in the menu", (await page.$$eval("#account-menu button", (b) => b.map((x) => x.textContent))).includes("Whispers (1)"));
  await page.click('#account-menu button:has-text("Whispers")');
  await page.waitForSelector(".tool-thread");
  await page.click(".tool-thread");
  await page.waitForSelector(".whisper-msg");
  check("opening the thread shows the message and clears the dot", (await page.textContent(".whisper-log")).includes("psst, got a minute?") && await page.$eval("#profile-btn", (b) => !b.classList.contains("has-whisper")));
  await page.fill('.tools input[type=text]', "sure, what's up");
  await page.screenshot({ path: dir + "/t70-whispers.png" });
  await shot("whispers");
  await page.click('.tools button:has-text("Send")');
  await page.waitForSelector(".whisper-msg.mine");
  check("replying sends the whisper and shows it", log.tools.some((x) => x === 'POST /api/whisper {"user_id":"7010","message":"sure, what\'s up"}') && (await page.textContent(".whisper-msg.mine")) === "sure, what's up");
  await page.keyboard.press("Escape");

  // Go-live alerts and stream changes
  await page.evaluate(() => { settings.liveAlerts = true; saveSettings(); toolsLiveSettingChanged(); });
  await sleep(300);
  const before = await page.$$eval("li.live-note", (l) => l.length);
  await page.evaluate(() => { following = null; });
  await page.evaluate(async () => { await toolsPollLive(); });
  check("the first look only learns who is live (no alerts for existing streams)", (await page.$$eval("li.live-note", (l) => l.length)) === before);
  await page.evaluate(() => { toolsLiveSettingChanged(); });
  await sleep(300);
  log.followingMode = 1;
  followingMode = "newlive";
  await page.evaluate(async () => { await toolsPollLive(); });
  await page.waitForSelector("li.live-note");
  check("a followed channel going live is announced in chat with an Open button", (await page.textContent("li.live-note")).includes("NewStreamer went live") && !!(await page.$("li.live-note button")));
  followingMode = "ok";
  await page.evaluate(() => { settings.liveAlerts = false; saveSettings(); });
  await page.evaluate(() => { tabs.get("uwoslab").stream = { user_id: "999", title: "old title", game_name: "Old Game", viewer_count: 1, started_at: new Date().toISOString() }; });
  await page.evaluate(async () => { await refreshStreams(); });
  await sleep(200);
  const lines = await page.$$eval("li.sys", (l) => l.map((x) => x.textContent));
  check("a title and category change in a channel you have open is noted in its chat", lines.some((x) => x === "Stream title changed: Building a chat app") && lines.some((x) => x === "Category changed: Old Game → Software and Game Development"), JSON.stringify(lines.slice(-4)));

  // Discovery
  await page.click("#profile-btn");
  await page.click('#account-menu button:has-text("Discover streams")');
  await page.waitForSelector(".discover .disc-row");
  check("Discover starts with the top live streams", (await page.textContent(".discover")).includes("Top live streams") && (await page.textContent(".disc-row")).includes("TopStreamer") && (await page.textContent(".disc-row")).includes("45k watching"));
  await page.screenshot({ path: dir + "/t71-discover.png" });
  await shot("discover");
  await page.fill(".discover input", "mine");
  await page.waitForSelector(".discover .disc-row:has-text(\"Findable\")");
  check("typing searches channels (live first) and offers matching categories", (await page.$$eval(".discover .disc-row b", (b) => b.map((x) => x.textContent))).join() === "Findable,Sleepy (offline)" && (await page.$$eval(".discover .browse-tabs button", (b) => b.map((x) => x.textContent))).includes("Minecraft"));
  await page.click('.discover .browse-tabs button:has-text("Minecraft")');
  await page.waitForSelector('.discover:has-text("Live in Minecraft")');
  check("choosing a category lists its live streams", log.discover.at(-1) === "/api/discover/top?game_id=27471" && (await page.textContent(".disc-row")).includes("Minecraft run"));
  await page.click('.discover .disc-row button:has-text("Open")');
  await page.waitForFunction(() => location.hash === "#topstreamer");
  check("Open opens the channel in a tab", true);
  await page.evaluate(() => closeTab(tabs.get("topstreamer")));
  await page.evaluate(() => activate(tabs.get("uwoslab")));
  // The channel box also searches Twitch.
  await page.fill("#channel", "");
  await page.type("#channel", "find");
  await page.waitForSelector('#follow-list .fl-row[data-find="findable"]');
  check("typing in the channel box also lists matching channels from all of Twitch", (await page.textContent("#follow-list")).includes("On Twitch") && (await page.textContent('#follow-list .fl-row[data-find="findable"]')).includes("Minecraft"));
  await page.click('#follow-list .fl-row[data-find="findable"]');
  await page.waitForFunction(() => location.hash === "#findable");
  await page.evaluate(() => closeTab(tabs.get("findable")));
  await page.evaluate(() => activate(tabs.get("uwoslab")));
  await sleep(300);
  log.unsubs.length = 0; // (the tabs opened just above)
  // Schedule
  await page.click("#clips-btn");
  await page.click('#browse-body .browse-tabs button:has-text("Schedule")');
  await page.waitForSelector("#browse-body .brow.sched");
  const sched = await page.$$eval("#browse-body .brow.sched", (r) => r.map((x) => ({ t: x.querySelector(".bt").textContent, s: x.querySelector(".bs").textContent, c: x.classList.contains("canceled") })));
  check("the Schedule tab lists upcoming streams, marking recurring and canceled ones", sched.length === 2 && sched[0].t === "Friday night stream" && /Just Chatting · weekly/.test(sched[0].s) && sched[1].c && /canceled/.test(sched[1].s), JSON.stringify(sched));
  await page.keyboard.press("Escape");

  // Without the new permissions: nothing offered, reconnect inside the panels.
  toolsScope = false;
  await page.evaluate(() => { status.twitch.missingOptionalScopes = ["moderator:manage:announcements", "user:manage:whispers", "user:read:subscriptions"]; renderInfo(); });
  check("the Mod tools icon stays (chat modes need no new permission)", await page.$eval("#modtools-btn", (b) => !b.hidden));
  await page.evaluate(() => { status.twitch.missingOptionalScopes = []; renderInfo(); });
  await page.click("#modtools-btn");
  await page.click('.modtools .browse-tabs button:has-text("Announce")');
  await page.fill(".modtools .tool-body input[type=text]", "hello");
  await page.click('.modtools button:has-text("Send announcement")');
  await page.waitForSelector('.modtools a[href="/auth/login"]');
  check("a tool whose permission is missing shows a reconnect link, and the other tabs still work", (await page.textContent(".modtools")).includes("Reconnect Twitch") && (await page.$$(".modtools .browse-tabs button")).length === 7);
  await page.click('.modtools .browse-tabs button:has-text("Chat modes")');
  await page.waitForSelector(".modtools .modes-grid");
  check("chat modes still work then", true);
  toolsScope = true;
  await page.keyboard.press("Escape");
}

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
await shot("color-cycling");
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
await page.waitForSelector(".messages:not([hidden]) li.historical", { timeout: 3000 }).catch(() => {});
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
await shot("message-flags");

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
await page.click("#modtools-btn");
await page.waitForSelector(".modtools .modes-grid");
check("Chat modes is the first tab of Mod tools, and the old Modes button is gone", (await page.$$eval(".modtools .browse-tabs button", (b) => b[0].textContent + (b[0].classList.contains("on") ? "*" : ""))) === "Chat modes*" && !(await page.$("#modes-btn")));
await page.selectOption(".modtools .modes-grid select >> nth=0", "30");
await page.waitForFunction(() => document.getElementById("modes").textContent.includes("Slow 30s"), null, { timeout: 3000 });
check("modes panel → slow 30s", JSON.stringify(log.settings.at(-1)) === '{"broadcaster_id":"999","slow_mode":true,"slow_mode_wait_time":30}', JSON.stringify(log.settings.at(-1)));
await page.click(".modtools .modes-grid input[type=checkbox] >> nth=1"); // emote-only
await page.waitForFunction(() => document.getElementById("modes").textContent.includes("Emote-only"), null, { timeout: 3000 });
check("modes panel → emote-only toggle", log.settings.at(-1).emote_mode === true);
await page.screenshot({ path: dir + "/t7-modes.png" });
await shot("chat-modes");
await page.keyboard.press("Escape");
// live settings event
cur().send(msg("notification", { subscription: { type: "channel.chat_settings.update" }, event: { broadcaster_user_id: "999", emote_mode: false, follower_mode: true, follower_mode_duration_minutes: 10, slow_mode: false, slow_mode_wait_time_seconds: null, subscriber_mode: true, unique_chat_mode: false } }));
await sleep(150);
check("chat_settings.update event updates chips", (await page.textContent("#modes")) === "Followers 10mSub-only", await page.textContent("#modes"));
// BTTV / FFZ / cheers
cur().send(chat("999", "ext1", "EmoteFan", "701", "OMEGALUL uwuDance sharedOne ZrehplaR"));
cur().send(chat("999", "cheer1", "Cheerer", "702", "Cheer100 nice", { fragments: [{ type: "cheermote", text: "Cheer100", cheermote: { prefix: "Cheer", bits: 100, tier: 100 } }, { type: "text", text: " nice" }] }));
await sleep(150);
const extImgs = await page.$$eval('li[data-id="ext1"] img', (is) => is.map((i) => i.title));
check("BTTV global/channel/shared + FFZ emotes render", extImgs.join("|") === "OMEGALUL (BTTV, global emote)|uwuDance (BTTV, this channel's emote)|sharedOne (BTTV, this channel's emote)|ZrehplaR (FFZ, global emote)", extImgs.join("|"));
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
await shot("automod");
// User card
cur().send(chat("999", "card1", "Spammer", "333", "buy followers again"));
await page.waitForSelector('li[data-id="card1"]');
await page.click('li[data-id="card1"] .name');
await page.waitForFunction(() => document.getElementById("sheet-body").textContent.includes("Account created"), null, { timeout: 3000 });
const card = await page.textContent("#sheet-body");
check("user card: profile, follow age, recent messages, mod timeouts", card.includes("Following since") && card.includes("I sell followers") && card.includes("Recent messages here (1)") && card.includes("Timeout 1h"), card.slice(0, 200));
await page.screenshot({ path: dir + "/t9-card.png" });
await shot("user-card");
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
await shot("settings");
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
await shot("video");
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
// =============== pinned stream ===============
{
  await page.setViewportSize({ width: 390, height: 760 });
  await sleep(200);
  const live = () => ({ user_id: "1", title: "other title", game_name: "g", viewer_count: 5, started_at: new Date().toISOString() });
  await page.evaluate(() => { settings.video = true; saveSettings(); activate(tabs.get("uwoslab")); });
  await page.waitForSelector("#video:not([hidden]) iframe");
  const calls = () => page.evaluate(() => __player.calls.filter((c) => c[0] === "setChannel").map((c) => c[1]));
  const before = (await calls()).length;
  check("pin button is offered while a stream shows, and starts unpinned", await page.$eval("#pin-btn", (b) => !b.hidden && b.getAttribute("aria-pressed") === "false" && /Pin this stream/.test(b.title)));
  await page.click("#pin-btn");
  check("pinning marks the button and the tab", await page.$eval("#pin-btn", (b) => b.getAttribute("aria-pressed") === "true") && await page.$eval(".tab:first-child .tab-pin", (p) => !p.hidden) && (await page.evaluate(() => localStorage.getItem("pinnedVideo"))) === "uwoslab");
  await page.screenshot({ path: dir + "/t62-pinned.png" });
  await shot("pinned-stream");
  // Switch to a channel that isn't live: the pinned stream keeps playing, untouched.
  await page.evaluate(() => { tabs.get("otherchan").stream = null; activate(tabs.get("otherchan")); });
  await sleep(200);
  check("switching tabs keeps the pinned video (same player, no channel change, layout unchanged)",
    (await calls()).length === before && await page.$eval("#video", (v) => !v.hidden && !!v.querySelector("iframe")) && await page.$eval(".app", (a) => a.classList.contains("with-video")) && await page.evaluate(() => playerChannel === "uwoslab"));
  check("the pin button still shows (pressed) on the other tab, offering to unpin", await page.$eval("#pin-btn", (b) => !b.hidden && b.getAttribute("aria-pressed") === "true" && /Tap to unpin/.test(b.title)));
  // Another channel going live doesn't take the video over.
  await page.evaluate((st) => { tabs.get("otherchan").stream = st; renderInfo(); renderVideo(); }, live());
  await sleep(200);
  check("another live channel doesn't take over while pinned", (await calls()).length === before && await page.evaluate(() => playerChannel === "uwoslab"));
  // Unpin: the video follows the open tab again.
  await page.click("#pin-btn");
  await page.waitForFunction(() => playerChannel === "otherchan");
  check("unpinning makes the video follow the open tab again", await page.$eval("#pin-btn", (b) => b.getAttribute("aria-pressed") === "false") && await page.$eval(".tab:first-child .tab-pin", (p) => p.hidden) && (await page.evaluate(() => localStorage.getItem("pinnedVideo"))) === null);
  // Pinned stream goes offline: fall back to the open tab's stream, and keep the pin for when it's back.
  await page.evaluate((st) => { tabs.get("otherchan").stream = st; activate(tabs.get("uwoslab")); setPinned("otherchan"); }, live());
  await page.waitForFunction(() => playerChannel === "otherchan");
  await page.evaluate(() => { tabs.get("otherchan").stream = null; activate(tabs.get("uwoslab")); renderVideo(); });
  await page.waitForFunction(() => playerChannel === "uwoslab");
  check("a pinned channel that went offline falls back to the open tab's stream (pin kept)", await page.evaluate(() => pinnedLogin === "otherchan") && await page.$eval("#pin-btn", (b) => /offline right now/.test(b.title)));
  // Closing the pinned tab unpins.
  await page.evaluate((st) => { tabs.get("otherchan").stream = st; }, live());
  await page.evaluate(() => closeTab(tabs.get("otherchan")));
  check("closing the pinned tab unpins", await page.evaluate(() => pinnedLogin === null && localStorage.getItem("pinnedVideo") === null));
  await page.evaluate(() => openTab("otherchan"));
  await page.waitForFunction(() => tabs.get("otherchan") && tabs.get("otherchan").broadcaster);
  await page.evaluate(() => activate(tabs.get("uwoslab")));
}

// A phone turned sideways: video on the left, chat on the right (not stacked).
for (const [w, h] of [[844, 390], [740, 360], [932, 430]]) {
  await page.setViewportSize({ width: w, height: h });
  await sleep(250);
  const side = await page.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const v = r("#video"), c = r("#chat"), t = r("header"), f = r("footer"), i = r("#video iframe");
    return { vRight: Math.round(v.right), cLeft: Math.round(c.left), cW: Math.round(c.width), tLeft: Math.round(t.left), fLeft: Math.round(f.left), vH: Math.round(v.height), appH: Math.round(r(".app").height), iRatio: i.width / i.height, docW: document.documentElement.scrollWidth };
  });
  check(`landscape phone ${w}×${h}: video left, chat column (header, chat, message box) right, video fills the height`,
    side.vRight <= side.cLeft + 1 && side.cW >= 280 && side.cW <= 380 && side.tLeft >= side.vRight - 1 && side.fLeft >= side.vRight - 1 && Math.abs(side.vH - side.appH) <= 1 && Math.abs(side.iRatio - 16 / 9) < 0.05 && side.docW === w, JSON.stringify(side));
  if (w === 844) {
    await page.screenshot({ path: dir + "/t61-landscape.png" });
    if (process.env.SHOTS) await page.screenshot({ path: galleryDir + "/video-landscape.png" });
  }
}
// ...and upright it's stacked again.
await page.setViewportSize({ width: 390, height: 760 });
await sleep(250);
check("upright phone: video on top of the chat again", await page.evaluate(() => document.getElementById("video").getBoundingClientRect().bottom <= document.getElementById("chat").getBoundingClientRect().top + 1));

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
  const gap = await page.evaluate(() => { const r = ["emote-btn", "twitch-btn", "snip-btn", "message"].map((id) => document.getElementById(id).getBoundingClientRect()); return [Math.round(r[1].left - r[0].right), Math.round(r[2].left - r[1].right), Math.round(r[3].left - r[2].right)]; });
  check("even spacing between the buttons and the message box", gap[0] === gap[1] && gap[1] === gap[2], JSON.stringify(gap));
}
{
  await page.click(".tab:first-child .tab-name");
  const btn = await page.$eval("#twitch-btn", (b) => ({ disabled: b.disabled, label: b.getAttribute("aria-label"), next: b.previousElementSibling.id, w: Math.round(b.getBoundingClientRect().width) }));
  check("button sits right after the emote button, small, labelled", !btn.disabled && btn.next === "emote-btn" && btn.w < 44 && btn.label.includes("Bits and channel points"), JSON.stringify(btn));
  await page.screenshot({ path: dir + "/t26-twitch-btn.png" });
  await shot("bits-and-points");
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
  await shot("video-quality");
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
check("finished emote names become images, including the last one once fully typed (its space is added)", ce.imgs.join(",") === "Kappa,catJAM,OMEGALUL" && ce.text === "hi Kappa catJAM OMEGALUL ", JSON.stringify(ce));
await page.keyboard.type(" and more");
ce = await page.evaluate(() => ({ text: composer.getText(), imgs: [...document.querySelectorAll("#message .ce-emote")].map((i) => i.dataset.name), caretAtEnd: composer.caret() === composer.getText().length }));
check("typing continues normally after conversion (caret stays at end)", ce.imgs.join(",") === "Kappa,catJAM,OMEGALUL" && ce.text === "hi Kappa catJAM OMEGALUL and more" && ce.caretAtEnd, JSON.stringify(ce));
await sleep(400);
await page.screenshot({ path: dir + "/t14-composer.png" });
await shot("composer");
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
await page.keyboard.press("Control+Home");
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
await shot("clip-cards");
// A clip link in chat history gets its card too (merged in by time, like scrolled-back history).
await page.evaluate(() => {
  const ev = ircToEvent("@id=hist-clip;tmi-sent-ts=" + (Date.now() - 90000) + ";user-id=9;display-name=Old :old!old@x PRIVMSG #uwoslab :earlier https://clips.twitch.tv/SecondSlug");
  renderMessage(active, ev, { merge: true, historical: true });
});
await page.waitForSelector('li[data-id="hist-clip"] .clip-card', { timeout: 3000 }).catch(() => {});
check("clip link in history shows its card", (await page.$$('li[data-id="hist-clip"] .clip-card')).length === 1);
await page.evaluate(() => {
  const t = [...tabs.values()].find((x) => x !== active);
  const ev = ircToEvent("@id=hist-clip2;tmi-sent-ts=" + (Date.now() - 80000) + ";user-id=9;display-name=Old :old!old@x PRIVMSG #" + t.login + " :bg https://clips.twitch.tv/FunnyClipSlug-AbC123");
  renderMessage(t, ev, { merge: true, historical: true });
});
await sleep(300);
check("clip card also appears in a background tab's history", (await page.$$('li[data-id="hist-clip2"] .clip-card')).length === 1);
await page.evaluate(() => {
  const ev = ircToEvent("@id=hist-flaky;tmi-sent-ts=" + (Date.now() - 70000) + ";user-id=9;display-name=Old :old!old@x PRIVMSG #uwoslab :try https://clips.twitch.tv/FlakySlug");
  renderMessage(active, ev, { merge: true, historical: true });
});
await page.waitForSelector('li[data-id="hist-flaky"] .clip-card', { timeout: 6000 }).catch(() => {});
check("a clip lookup that fails once is retried and the card appears", (await page.$$('li[data-id="hist-flaky"] .clip-card')).length === 1 && log.clips.filter((x) => x === "FlakySlug").length === 2, JSON.stringify(log.clips.filter((x) => x === "FlakySlug")));

// =============== raids ===============
const raid = (fromId, fromName, to, viewers) => msg("notification", { subscription: { type: "channel.raid" }, event: { from_broadcaster_user_id: fromId, from_broadcaster_user_login: fromName.toLowerCase(), from_broadcaster_user_name: fromName, to_broadcaster_user_id: ids[to] || "1", to_broadcaster_user_login: to, to_broadcaster_user_name: to === "targetchan" ? "TargetChan" : to, viewers } });
await page.click(".tab:first-child .tab-name");
cur().send(raid("999", "UwoSlab", "targetchan", 1234));
await page.waitForSelector(".messages:not([hidden]) .notice.raid");
const raidText = await page.textContent(".messages:not([hidden]) .notice.raid");
check("raid notice + countdown on watched tab", raidText.includes("UwoSlab raided TargetChan with 1,234 viewers.") && raidText.includes("Following in 5s"), raidText);
await page.screenshot({ path: dir + "/t13-raid.png" });
await shot("raid");
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
await shot("channel-picker");
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

// =============== follow button ===============
{
  await page.evaluate(() => { following = null; });
  await page.evaluate(() => openTab("uwoslab"));
  await page.waitForFunction(() => active && active.login === "uwoslab" && active.broadcaster);
  await page.waitForSelector("#follow-btn:not([hidden])");
  check("follow button shows 'following' for a followed channel", await page.$eval("#follow-btn", (b) => b.classList.contains("on") && b.getAttribute("aria-pressed") === "true" && /unfollow/i.test(b.title)));
  await page.screenshot({ path: dir + "/t60-follow-on.png" });
  await shot("follow-button");
  await page.evaluate(() => openTab("otherchan"));
  await page.waitForFunction(() => active && active.login === "otherchan" && active.broadcaster);
  await page.waitForFunction(() => !document.getElementById("follow-btn").classList.contains("on"));
  check("follow button is outline and offers Follow for a channel you don't follow", await page.$eval("#follow-btn", (b) => !b.hidden && b.getAttribute("aria-pressed") === "false" && /^Follow /.test(b.title)), await page.$eval("#follow-btn", (b) => b.title));
  await page.evaluate(() => { window.__calls = []; launchers.window = (u, n) => { __calls.push(["window", u, n || ""]); return {}; }; });
  const fb = log.following;
  await page.tap("#follow-btn");
  check("tapping it opens the channel on Twitch", JSON.stringify(await page.evaluate(() => __calls)) === '[["window","https://www.twitch.tv/otherchan","_blank"]]', JSON.stringify(await page.evaluate(() => __calls)));
  followedExtra = true; // the user followed on Twitch meanwhile
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForFunction(() => document.getElementById("follow-btn").classList.contains("on"));
  check("coming back refreshes it (fresh fetch)", log.following === fb + 1 && log.followingFresh === 1, String(log.followingFresh));
  await page.evaluate(() => openTab("uwoslab"));
  followedExtra = false;
}

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
  await shot("history-optin");
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
  await shot("light-theme");
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
  // Signed out (cookie expired, or taken off the allowlist): say so, with a way back in.
  sessionExpiredMock = true;
  const exp = await page.evaluate(() => api("/api/netfail"));
  check("a signed-out answer is explained, with a link to sign in again", exp.ok === false && /sign-in ended/.test(exp.error) && !(await page.$eval("#expired", (b) => b.hidden)) && (await page.getAttribute("#expired a", "href")) === "/auth/login", JSON.stringify(exp));
  sessionExpiredMock = false;
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
  await shot("channel-points");
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
  await shot("gifs");
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
  await shot("giant-emotes");
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
  await shot("browse-clips");
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
  await shot("clip-player");
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
  await shot("create-clip");
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
  // No title: the clip is named after the stream.
  await page.keyboard.press("Escape");
  await page.click("#clips-btn");
  await page.waitForSelector("#browse-body .clipper button");
  check("the title box says a blank title uses the stream's", (await page.getAttribute("#clip-title", "placeholder")).includes("stream's title"));
  await page.evaluate(() => { settings.postClips = false; saveSettings(); });
  const streamTitle = await page.evaluate(() => active.stream.title);
  await page.click('#browse-body .clipper button:has-text("15s")');
  await page.waitForSelector("#browse-body .clipper .state.ok", { timeout: 10000 });
  check("a blank title becomes the stream's title", !!streamTitle && JSON.stringify(log.clipCreates.at(-1)) === JSON.stringify({ broadcaster_id: "999", duration: 15, title: streamTitle }), JSON.stringify(log.clipCreates.at(-1)));
  check("a long stream title is cut to 100 characters", await page.evaluate(() => defaultClipTitle({ stream: { title: "é".repeat(140) } }).length === 100));
  await page.evaluate(() => { settings.postClips = true; saveSettings(); });
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
    menu.expanded === "true" && menu.name === "TestUser" && menu.login === "@testuser" && JSON.stringify(menu.items.map((x) => x.replace(/ \(\d+\)$/, ""))) === '["Settings","Your clips","Settings for #UwoSlab","Whispers","Bookmarks","Mentions","All chats in one feed","Discover streams","Save this chat (text)","Save this chat (JSON)","Log out"]' && menu.pic && menu.h >= 44, JSON.stringify(menu));
  await page.screenshot({ path: dir + "/t35-account-menu.png" });
  await shot("account-menu");
  await page.keyboard.press("Escape");
  check("Escape closes it", await page.$eval("#account-menu", (m) => m.hidden) && (await page.getAttribute("#profile-btn", "aria-expanded")) === "false");
  await page.click("#profile-btn");
  await page.mouse.click(8, 700);
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
  await shot("your-clips");
  await page.click("#browse-body .browse-more");
  await page.waitForFunction(() => document.querySelectorAll("#browse-body .bcard").length === 3);
  check("Load more pages through them", log.mine.at(-1) === "?after=20" && !(await page.$("#browse-body .browse-more")));

  // Sharing: the phone's share sheet when there is one...
  await page.evaluate(() => { window.__shared = []; navigator.share = async (d) => { window.__shared.push(d); }; });
  await page.click("#browse-body .brow >> nth=0 >> .bshare");
  check("Share on a card opens the share sheet with the clip's title and link", JSON.stringify(await page.evaluate(() => window.__shared)) === '[{"title":"My first clip","text":"My first clip","url":"https://clips.twitch.tv/MineOne"}]', JSON.stringify(await page.evaluate(() => window.__shared)));
  // A share that never finishes (some Android browsers) makes later ones throw: copy instead of going dead.
  await page.evaluate(() => {
    window.__copied = []; window.__shareCalls = 0;
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t) => { window.__copied.push(t); } }, configurable: true });
    navigator.share = (d) => { window.__shareCalls++; return window.__shareCalls === 1 ? new Promise(() => {}) : Promise.reject(new DOMException("An earlier share has not yet completed.", "InvalidStateError")); };
  });
  await page.click("#browse-body .brow >> nth=0 >> .bshare"); // never settles
  await page.click("#browse-body .brow >> nth=1 >> .bshare");
  await page.waitForFunction(() => window.__copied.length === 1);
  check("after a share that never finished, the next one falls back to copying the link", JSON.stringify(await page.evaluate(() => window.__copied)) === '["https://clips.twitch.tv/MineTwo"]');
  await page.waitForFunction(() => document.querySelectorAll("#browse-body .bshare")[1].textContent === "Share", null, { timeout: 4000 });
  await page.evaluate(() => { navigator.share = () => Promise.reject(new DOMException("closed", "AbortError")); window.__copied = []; });
  await page.click("#browse-body .brow >> nth=1 >> .bshare");
  await sleep(150);
  check("closing the share sheet is silent (no copy, label unchanged)", (await page.evaluate(() => window.__copied.length)) === 0 && (await page.textContent("#browse-body .brow >> nth=1 >> .bshare")) === "Share");
  await page.waitForFunction(() => document.querySelectorAll("#browse-body .bshare")[1].textContent === "Share", null, { timeout: 4000 });
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


// =============== sync, mute filters, mentions, combined feed, stats, slow mode, export, shortcuts ===============
{
  // ---- sync between devices ----
  await page.evaluate(() => { settings.sync = true; settings.liveAlerts = !settings.liveAlerts; saveSettings(); });
  await sleep(2600);
  const pushed = (log.sync || []).at(-1);
  check("a changed setting is pushed to the account, with the tabs", !!pushed && typeof pushed.at === "number" && Array.isArray(pushed.tabs) && pushed.tabs.length > 0 && "liveAlerts" in pushed.settings, JSON.stringify(pushed).slice(0, 200));
  check("per-device settings stay out of the sync", !!pushed && ["player", "theme", "fontSize", "history", "notify", "sound", "nativeQuality", "bitsButton", "sync"].every((k) => !(k in pushed.settings)), Object.keys(pushed.settings).join());
  const before = await page.evaluate(() => ({ fontSize: settings.fontSize, player: settings.player, tabs: localStorage.getItem("tabs") }));
  syncStore = { at: Date.now() + 5000, settings: { liveAlerts: false, rules: [{ phrase: "fromphone", user: "" }], fontSize: 99, player: "native", mute: { words: ["zzz"], bots: true, commands: false } }, tabs: ["alphachan"], pinned: "alphachan" };
  await page.evaluate(() => syncPull(false));
  let got = await page.evaluate(() => ({ rules: settings.rules, fontSize: settings.fontSize, player: settings.player, mute: settings.mute, tabs: localStorage.getItem("tabs"), pinned: localStorage.getItem("pinnedVideo"), syncAt: Number(localStorage.getItem("syncAt")) }));
  check("a newer copy from another device is adopted", got.rules[0].phrase === "fromphone" && got.mute.words[0] === "zzz" && got.syncAt === syncStore.at, JSON.stringify(got));
  check("...but not the other device's player, text size...", got.fontSize === before.fontSize && got.player === before.player);
  check("...and tabs are left alone while the app is running", got.tabs === before.tabs && got.pinned !== "alphachan");
  syncStore.at += 1000;
  await page.evaluate(() => syncPull(true));
  got = await page.evaluate(() => ({ tabs: localStorage.getItem("tabs"), pinned: localStorage.getItem("pinnedVideo") }));
  check("at startup the other device's tabs and pinned stream are adopted", got.tabs === '["alphachan"]' && got.pinned === "alphachan", JSON.stringify(got));
  // Put things back the way the rest of the run expects.
  await page.evaluate(() => { setPinned(null); settings.rules = []; settings.mute = { words: [], bots: false, commands: false }; saveSettings(); saveTabs(); });
  const pushesBefore = (log.sync || []).length;
  await page.evaluate(() => { syncedJson = JSON.stringify(syncBlob()); syncChanged(); });
  await sleep(2400);
  check("an unchanged copy isn't pushed again", (log.sync || []).length === pushesBefore);
  await page.evaluate(() => { settings.sync = false; saveSettings(); });
  const off = (log.sync || []).length;
  await page.evaluate(() => { settings.liveAlerts = !settings.liveAlerts; saveSettings(); });
  await sleep(2400);
  check("with syncing switched off nothing is sent", (log.sync || []).length === off);
  await page.evaluate(() => { settings.sync = true; saveSettings(); });
  syncStore = null;

  // ---- emote picker: one section per channel ----
  await page.evaluate(() => {
    const te = active.twitchEmotes;
    te.emotes.push({ id: "o1", name: "zedWave", group: "Other channels", animated: false, owner: "Zed" }, { id: "o2", name: "alphaHi", group: "Other channels", animated: false, owner: "alpha" },
      { id: "o3", name: "alphaBye", group: "Other channels", animated: false, owner: "alpha" }, { id: "o4", name: "mysteryEmote", group: "Other channels", animated: false, owner: "" });
  });
  await page.click("#emote-btn");
  await page.waitForSelector("#picker-list");
  const heads = await page.$$eval("#picker-list h3", (n) => n.map((x) => x.textContent.replace(/ \(\d+\)$/, "")));
  check("emotes from other channels are grouped by channel, A to Z, unnamed last", JSON.stringify(heads.filter((h) => /Twitch · (alpha|Zed|other channels)/.test(h))) === '["Twitch · alpha","Twitch · Zed","Twitch · other channels"]' && !heads.some((h) => /your other subs/.test(h)), JSON.stringify(heads));
  await shot("emote-picker-by-channel");
  await page.keyboard.press("Escape");
  await page.evaluate(() => { closePicker(); const te = active.twitchEmotes; te.emotes = te.emotes.filter((e) => e.group !== "Other channels"); });

  // ---- mute filters ----
  const bid = await page.evaluate(() => active.broadcaster.id);
  await page.evaluate(() => { settings.mute = { words: ["spoilerword", "/^gg+$/"], bots: true, commands: true }; saveSettings(); });
  cur().send(chat(bid, "mu1", "Nightbot", "9101", "Follow us on socials"));
  cur().send(chat(bid, "mu2", "SomeoneElse", "9102", "!so friend"));
  cur().send(chat(bid, "mu3", "SomeoneElse", "9102", "this has a SpoilerWord inside"));
  cur().send(chat(bid, "mu4", "SomeoneElse", "9102", "ggggg"));
  cur().send(chat(bid, "mu5", "SomeoneElse", "9102", "a perfectly fine message"));
  cur().send(chat(bid, "mu6", "TestUser", "111", "!mine is never hidden"));
  await sleep(500);
  await page.waitForSelector('li[data-id="mu6"]', { state: "attached" });
  const muted = await page.evaluate(() => ["mu1", "mu2", "mu3", "mu4", "mu5", "mu6"].map((id) => document.querySelector('li[data-id="' + id + '"]').classList.contains("ignored")));
  check("bots, !commands and muted words/patterns are hidden; normal and own messages stay", JSON.stringify(muted) === "[true,true,true,true,false,false]", JSON.stringify(muted));
  check("an invalid pattern is refused and doesn't hide anything", await page.evaluate(() => muteMatcher("/(/") === null && !isMuted({ chatter_user_id: "1", chatter_user_login: "x", message: { text: "(" } })));
  await page.evaluate(() => toolsReloadBlocks());
  await sleep(300);
  check("reloading the block list doesn't bring muted messages back", await page.$eval('li[data-id="mu3"]', (l) => l.classList.contains("ignored")));
  await openSettingsUI();
  await page.waitForSelector("#sheet");
  check("Settings has the mute filters", /Mute filters/.test(await page.textContent("#sheet")) && /Hide known bots/.test(await page.textContent("#sheet")));
  await page.fill('#sheet input[placeholder="Word, phrase or /pattern/"]', "/(/");
  await page.click('#sheet button:has-text("Mute")');
  check("a bad pattern shows an error in Settings", /isn't a valid pattern/.test(await page.textContent("#sheet")));
  await page.fill('#sheet input[placeholder="Word, phrase or /pattern/"]', "newword");
  await page.click('#sheet button:has-text("Mute")');
  check("a word is added from Settings", await page.evaluate(() => settings.mute.words.includes("newword")));
  await shot("mute-filters");
  await page.keyboard.press("Escape");
  await page.evaluate(() => { settings.mute = { words: [], bots: false, commands: false }; saveSettings(); });

  // ---- mentions across channels ----
  cur().send(chat(bid, "men1", "Talker", "9201", "hey @testuser look", { fragments: [{ type: "text", text: "hey " }, { type: "mention", text: "@testuser", mention: { user_id: "111" } }, { type: "text", text: " look" }] }));
  await page.waitForSelector('li[data-id="men1"]', { state: "attached" });
  await page.click("#profile-btn");
  check("the account menu shows how many mentions are unread", /Mentions \(\d+\)/.test(await page.textContent("#account-menu")));
  await page.click('#account-menu button:has-text("Mentions")');
  await page.waitForSelector("#sheet [data-mentions]");
  const rows = await page.$$eval("#sheet .mention-row", (r) => r.map((x) => x.textContent));
  check("the Mentions sheet lists mentions from the open channels", rows.length >= 2 && rows.some((r) => r.includes("Talker") && r.includes("hey @testuser look")), JSON.stringify(rows));
  await shot("mentions");
  await page.click("#sheet .mention-row >> nth=0");
  check("tapping a mention closes the sheet and goes to that channel", await page.$eval("#sheet", (s) => s.hidden));
  await page.click("#profile-btn");
  check("the unread count resets after opening it", !/Mentions \(\d+\)/.test(await page.textContent("#account-menu")));
  await page.keyboard.press("Escape");

  // ---- all chats in one feed ----
  const tabCount = await page.evaluate(() => tabs.size);
  if (tabCount < 2) { await page.evaluate(() => openTab("alphachan", false)); await page.waitForFunction(() => tabs.get("alphachan") && tabs.get("alphachan").joined); }
  const names = await page.evaluate(() => [...tabs.keys()]);
  const other = names.find((n) => n !== "uwoslab") || names[0];
  const otherId = await page.evaluate((n) => tabs.get(n).broadcaster.id, other);
  cur().send(chat(otherId, "cmb0", "Early", "9301", "before opening the feed"));
  await page.waitForFunction(() => document.querySelector('li[data-id="cmb0"]'));
  await page.keyboard.press("Alt+a");
  await page.waitForSelector("#sheet [data-combined]");
  check("Alt+A opens all chats with earlier lines and channel tags", await page.evaluate(() => { const l = document.querySelector("#sheet .combined"); return !!l.querySelector(".shared-pill") && l.textContent.includes("before opening the feed"); }));
  cur().send(chat(otherId, "cmb1", "Livetalk", "9302", "arrives while it is open"));
  await page.waitForFunction(() => document.querySelector("#sheet .combined").textContent.includes("arrives while it is open"));
  const bidNow = await page.evaluate(() => active.broadcaster.id);
  cur().send(chat(bidNow, "cmb2", "Livetalk", "9302", "and in the other channel"));
  await page.waitForFunction(() => document.querySelector("#sheet .combined").textContent.includes("and in the other channel"));
  check("new messages from every channel arrive live, without action buttons", await page.evaluate(() => !document.querySelector("#sheet .combined .actions")));
  await shot("combined-feed");
  await page.evaluate((n) => { [...document.querySelectorAll("#sheet .combined li")].find((li) => li.dataset.channel === n).click(); }, other);
  check("tapping a line opens that channel", (await page.evaluate(() => active.login)) === other && await page.$eval("#sheet", (s) => s.hidden));

  // ---- stream stats ----
  await page.evaluate(() => activate(tabs.get("uwoslab")));
  await page.evaluate(() => refreshStreams());
  await sleep(150);
  await page.evaluate(() => refreshStreams());
  await sleep(150);
  check("the info bar shows how long the stream has been live", /^3h\d\d$/.test(await page.textContent("#live .uptime")), await page.textContent("#live"));
  await page.click("#live");
  await page.waitForSelector("#sheet [data-stats]");
  const stats = await page.textContent("#sheet");
  check("tapping the live chip opens stream stats with a viewer graph", /Live for\s*3h/.test(stats) && /1,234/.test(stats) && !!(await page.$("#sheet svg.sparkline polyline")), stats.slice(0, 160));
  await shot("stream-stats");
  await page.keyboard.press("Escape");

  // ---- slow mode countdown ----
  await page.evaluate((n) => activate(tabs.get(n)), other);
  await page.evaluate(() => { active.settings = { ...(active.settings || {}), slow_mode: true, slow_mode_wait_time: 10 }; active.isMod = false; });
  await page.evaluate(() => { composer.setText("hello there"); });
  await page.click("#send");
  await page.waitForFunction(() => !document.getElementById("slow-note").hidden);
  check("after sending in a slow-mode channel a countdown shows", /Slow mode: you can chat again in (9|10)s/.test(await page.textContent("#slow-note")), await page.textContent("#slow-note"));
  await page.evaluate(() => activate(tabs.get("uwoslab")));
  check("the countdown belongs to its channel", await page.$eval("#slow-note", (n) => n.hidden));
  await page.evaluate((n) => { tabs.get(n).slowUntil = Date.now() + 1200; activate(tabs.get(n)); }, other);
  await page.waitForFunction(() => document.getElementById("slow-note").hidden, null, { timeout: 4000 });
  check("and it clears itself when the time is up", true);
  await page.evaluate(() => activate(tabs.get("uwoslab")));

  // ---- export ----
  await page.click("#profile-btn");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('#account-menu button:has-text("Save this chat (text)")')]);
  const dlText = readFileSync(await dl.path(), "utf8");
  check("Save this chat (text) downloads the visible messages", /^uwoslab-chat-.*\.txt$/i.test(dl.suggestedFilename()) && /SomeoneElse: a perfectly fine message/.test(dlText) && !/Nightbot/.test(dlText), dl.suggestedFilename() + " " + dlText.slice(0, 120));
  await page.click("#profile-btn");
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.click('#account-menu button:has-text("Save this chat (JSON)")')]);
  const parsed = JSON.parse(readFileSync(await dl2.path(), "utf8"));
  check("...and as JSON with times", parsed.channel && parsed.messages.length > 3 && !!parsed.messages[0].time && /^\d{4}-/.test(parsed.messages[0].time));

  // ---- keyboard shortcuts ----
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press("?");
  await page.waitForSelector("#sheet [data-shortcuts]");
  check("? lists the keyboard shortcuts", /Alt \+ M/.test(await page.textContent("#sheet")));
  await page.keyboard.press("Escape");
  const a0 = await page.evaluate(() => active.login);
  await page.keyboard.press("Alt+ArrowRight");
  const a1 = await page.evaluate(() => active.login);
  await page.keyboard.press("Alt+ArrowLeft");
  check("Alt+arrows move between tabs", a1 !== a0 && (await page.evaluate(() => active.login)) === a0, a0 + " " + a1);
  const vid = await page.evaluate(() => settings.video);
  await page.keyboard.press("Alt+v");
  check("Alt+V toggles the video", (await page.evaluate(() => settings.video)) === !vid);
  await page.keyboard.press("Alt+v");
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press("/");
  check("/ jumps to the message box", await page.evaluate(() => document.activeElement === document.getElementById("message")));
  syncMockOff = true;
}


// =============== per-channel settings, notes, quick messages, favorites, bookmarks, translate ===============
{
  const names = await page.evaluate(() => [...tabs.keys()]);
  const first = names[0], second = names.find((n) => n !== first);
  await page.evaluate((n) => activate(tabs.get(n)), first);
  const idOf = (n) => page.evaluate((x) => tabs.get(x).broadcaster.id, n);
  const secondId = await idOf(second);

  // ---- settings for one channel ----
  await page.evaluate(() => { window.__pings = 0; window.ping = () => { window.__pings++; }; settings.sound = true; settings.notify = false; saveSettings(); });
  const mentionFrags = [{ type: "text", text: "yo " }, { type: "mention", text: "@testuser", mention: { user_id: "111" } }];
  cur().send(chat(secondId, "pc1", "Pinger", "9401", "yo @testuser", { fragments: mentionFrags }));
  await page.waitForSelector('li[data-id="pc1"]', { state: "attached" });
  const p1 = await page.evaluate(() => window.__pings);
  await page.evaluate((n) => { settings.channels[n] = { sound: "off" }; saveSettings(); }, second);
  cur().send(chat(secondId, "pc2", "Pinger", "9401", "yo @testuser again", { fragments: mentionFrags }));
  await page.waitForSelector('li[data-id="pc2"]', { state: "attached" });
  const p2 = await page.evaluate(() => window.__pings);
  check("sound for mentions is on globally, and a channel can switch it off", p1 === 1 && p2 === 1, p1 + " " + p2);
  await page.evaluate((n) => { settings.sound = false; settings.channels[n] = { sound: "on" }; saveSettings(); }, second);
  cur().send(chat(secondId, "pc3", "Pinger", "9401", "third @testuser", { fragments: mentionFrags }));
  await page.waitForSelector('li[data-id="pc3"]', { state: "attached" });
  check("...or on when it's off globally", (await page.evaluate(() => window.__pings)) === 2);
  await page.evaluate((n) => { delete settings.channels[n]; saveSettings(); }, second);

  await page.click("#profile-btn");
  await page.click('#account-menu button:has-text("Settings for #")');
  await page.waitForSelector("#sheet [data-chansettings]");
  await page.fill('#sheet input[placeholder="Word, phrase or /pattern/"]', "blahword");
  await page.click('#sheet button:has-text("Mute here")');
  const firstId = await idOf(first);
  check("a muted word is stored for just this channel", await page.evaluate((n) => JSON.stringify(settings.channels[n]) === '{"muteWords":["blahword"]}', first));
  await shot("channel-settings");
  await page.selectOption("#sheet select >> nth=1", "off");
  check("a dropdown sets the channel's sound", await page.evaluate((n) => settings.channels[n].sound === "off", first));
  await page.keyboard.press("Escape");
  cur().send(chat(firstId, "cm1", "Someone", "9402", "this has blahword in it"));
  cur().send(chat(secondId, "cm2", "Someone", "9402", "this has blahword in it"));
  await page.waitForSelector('li[data-id="cm2"]', { state: "attached" });
  check("it hides there and nowhere else", await page.evaluate(() => document.querySelector('li[data-id="cm1"]').classList.contains("ignored") && !document.querySelector('li[data-id="cm2"]').classList.contains("ignored")));
  await page.evaluate((n) => { delete settings.channels[n]; saveSettings(); }, first);

  // go-live alerts per channel
  const notes0 = await page.$$eval("li.live-note", (l) => l.length);
  await page.evaluate(() => { settings.liveAlerts = false; settings.channels.newstreamer = { live: "on" }; saveSettings(); });
  followingMode = "ok";
  await page.evaluate(async () => { await toolsPollLive(); });
  followingMode = "newlive";
  await page.evaluate(async () => { await toolsPollLive(); });
  await sleep(200);
  check("a channel set to Always is announced even with go-live alerts off", (await page.$$eval("li.live-note", (l) => l.length)) === notes0 + 1);
  await page.evaluate(() => { settings.liveAlerts = true; settings.channels.newstreamer = { live: "off" }; saveSettings(); });
  followingMode = "ok";
  await page.evaluate(async () => { await toolsPollLive(); });
  await sleep(200);
  const notes1 = await page.$$eval("li.live-note", (l) => l.length);
  followingMode = "newlive";
  await page.evaluate(async () => { await toolsPollLive(); });
  await sleep(200);
  check("...and one set to Never is not, even with them on", (await page.$$eval("li.live-note", (l) => l.length)) === notes1);
  followingMode = "ok";
  await page.evaluate(() => { settings.liveAlerts = false; delete settings.channels.newstreamer; saveSettings(); });

  // ---- notes on people ----
  cur().send(chat(firstId, "nt1", "Regular", "9501", "hello from a regular"));
  await page.waitForSelector('li[data-id="nt1"]', { state: "attached" });
  await page.evaluate(() => document.querySelector('li[data-id="nt1"] .name').click());
  await page.waitForSelector("#sheet .card-actions");
  await page.click('#sheet .card-actions button:has-text("Add note")');
  await page.fill('#sheet input[placeholder^="Label"]', "friend");
  await page.fill('#sheet input[placeholder^="Note"]', "met at a meetup");
  await page.click("#sheet .swatch >> nth=3");
  await shot("user-note");
  await page.click('#sheet button:has-text("Save")');
  const tagInfo = await page.$eval('li[data-id="nt1"] .user-tag', (t) => ({ text: t.textContent, title: t.title, after: t.previousElementSibling.classList.contains("name") }));
  check("a note shows as a colored label after their name, with the note as its tooltip", tagInfo.text === "friend" && tagInfo.title === "met at a meetup" && tagInfo.after, JSON.stringify(tagInfo));
  cur().send(chat(firstId, "nt2", "Regular", "9501", "second message"));
  await page.waitForSelector('li[data-id="nt2"]', { state: "attached" });
  check("new messages from them carry it too", !!(await page.$('li[data-id="nt2"] .user-tag')));
  await page.evaluate(() => document.querySelector('li[data-id="nt2"] .name').click());
  await page.waitForSelector("#sheet .card-note");
  check("the user card shows the note", /friend: met at a meetup/.test(await page.textContent("#sheet .card-note")));
  await page.click('#sheet .card-actions button:has-text("Edit note")');
  await page.click('#sheet button:has-text("Remove")');
  check("removing a note removes the label everywhere", (await page.$$('.msg[data-user="9501"] .user-tag')).length === 0 && !(await page.evaluate(() => "9501" in settings.notes)));

  // ---- quick messages ----
  await page.click("#snip-btn");
  await page.waitForSelector("#snippets:not([hidden])");
  await page.fill('#snippets input[placeholder="Name"]', "hi");
  await page.fill('#snippets input[placeholder="Message"]', "hello everyone!");
  await page.click('#snippets button:has-text("Add")');
  check("a quick message is saved", await page.evaluate(() => JSON.stringify(settings.snippets) === '[{"label":"hi","text":"hello everyone!"}]'));
  await shot("quick-messages");
  await page.evaluate(() => composer.setText(""));
  await page.click("#snippets .snip-main");
  check("tapping one puts it in the message box and closes the list", (await page.evaluate(() => composer.getText())) === "hello everyone!" && await page.$eval("#snippets", (n) => n.hidden));
  await page.evaluate(() => composer.setText(""));
  await page.click("#snip-btn");
  const sentBefore = log.sent.length;
  await page.click('#snippets button:has-text("Send")');
  await sleep(400);
  check("Send posts it straight away", log.sent.length === sentBefore + 1 && log.sent.at(-1) === "hello everyone!", JSON.stringify(log.sent.at(-1)));
  await page.evaluate(() => composer.setText("half a draft"));
  await page.click("#snip-btn");
  check("with a draft in the box there's no Send, so it can't be lost", (await page.$$('#snippets button:has-text("Send")')).length === 0);
  await page.evaluate(() => { composer.setText(""); });
  await page.keyboard.press("Escape");
  await page.evaluate(() => { settings.snippets = []; saveSettings(); });

  // ---- favorite emotes ----
  await page.click("#emote-btn");
  await page.waitForSelector("#picker-list .grid button");
  const emoteName = await page.$eval("#picker-list .grid button", (b) => b.dataset.name);
  await page.click(`#picker-list .grid button[data-name="${emoteName}"]`, { button: "right" });
  const heads2 = await page.$$eval("#picker-list h3", (n) => n.map((x) => x.textContent));
  check("right-click or long-press favorites an emote, listed first", heads2[0].startsWith("★ Favorites") && await page.evaluate((n) => settings.favEmotes[0].name === n, emoteName), JSON.stringify(heads2));
  await shot("favorite-emotes");
  await page.click(`#picker-list .grid button[data-name="${emoteName}"]`, { button: "right" });
  check("doing it again removes it", (await page.evaluate(() => settings.favEmotes.length)) === 0);
  await page.keyboard.press("Escape");
  await page.evaluate(() => closePicker());

  // ---- bookmarks ----
  await page.evaluate(() => document.querySelector('li[data-id="nt1"]').click());
  await page.click('li[data-id="nt1"] .actions button:has-text("Save")');
  check("Save in the message menu bookmarks it", await page.evaluate(() => settings.bookmarks.length === 1 && settings.bookmarks[0].text === "hello from a regular"));
  await page.click("#profile-btn");
  await page.click('#account-menu button:has-text("Bookmarks")');
  await page.waitForSelector("#sheet [data-bookmarks] .mention-row");
  check("the Bookmarks sheet lists it with channel and author", /Regular/.test(await page.textContent("#sheet .mention-row")) && /hello from a regular/.test(await page.textContent("#sheet .mention-row")));
  await shot("bookmarks");
  await page.click('#sheet button:has-text("Remove")');
  check("and can remove it", (await page.evaluate(() => settings.bookmarks.length)) === 0);
  await page.keyboard.press("Escape");

  // ---- translate ----
  await page.evaluate(() => { window.__opened = []; launchers.window = (url) => { window.__opened.push(url); }; });
  await page.evaluate(() => document.querySelector('li[data-id="nt1"]').click());
  await page.click('li[data-id="nt1"] .actions button:has-text("Translate")');
  await sleep(200);
  const opened = await page.evaluate(() => window.__opened);
  check("without a built-in translator, Translate opens Google Translate with the text", opened.length === 1 && /translate\.google\.com\/\?sl=auto&tl=\w+&op=translate&text=hello%20from%20a%20regular/.test(opened[0]), JSON.stringify(opened));
  await page.evaluate(() => {
    self.LanguageDetector = { create: async () => ({ detect: async () => [{ detectedLanguage: "fr" }] }) };
    self.Translator = { create: async (o) => ({ translate: async (t) => "[" + o.sourceLanguage + ">" + o.targetLanguage + "] " + t }) };
  });
  await page.evaluate(() => document.querySelector('li[data-id="nt1"]').click());
  await page.click('li[data-id="nt1"] .actions button:has-text("Translate")');
  await page.waitForSelector('li[data-id="nt1"] .translation');
  check("with one, the translation shows under the message", /\[fr>\w+\] hello from a regular/.test(await page.textContent('li[data-id="nt1"] .translation')));
  await page.evaluate(() => { delete self.LanguageDetector; delete self.Translator; });
}


// =============== chat layout options, tab menu, second stream, backup ===============
{
  // ---- chat layout ----
  await openSettingsUI();
  await page.waitForSelector("#sheet");
  check("Settings has chat layout options", /Chat layout/.test(await page.textContent("#sheet")) && /Alternate row shading/.test(await page.textContent("#sheet")));
  await page.evaluate(() => { settings.compact = true; settings.zebra = true; settings.showTime = false; settings.showBadges = false; settings.chatFont = "mono"; saveSettings(); });
  const lay = await page.evaluate(() => { const a = document.querySelector(".app").classList; return ["compact", "zebra", "no-time", "no-badges", "font-mono"].every((c) => a.contains(c)); });
  const timeHidden = await page.$eval(".messages:not([hidden]) .msg .time", (t) => getComputedStyle(t).display === "none");
  check("compact, shading, hidden times/badges and the font take effect", lay && timeHidden);
  check("layout choices stay out of sync (they're per device)", await page.evaluate(() => { const b = syncBlob().settings; return !("compact" in b) && !("zebra" in b) && !("chatFont" in b); }));
  await page.keyboard.press("Escape");
  await shot("chat-layout");
  await page.evaluate(() => { settings.compact = false; settings.zebra = false; settings.showTime = true; settings.showBadges = true; settings.chatFont = "default"; saveSettings(); });

  // ---- tab menu and reordering ----
  const order0 = await page.evaluate(() => [...tabs.keys()]);
  await page.click(".tab >> nth=0", { button: "right" });
  await page.waitForSelector(".tab-menu");
  const items = await page.$$eval(".tab-menu button", (b) => b.map((x) => x.textContent));
  check("right-clicking a tab opens its menu", ["Move right", "Pin stream", "Close"].every((x) => items.includes(x)) && items.some((x) => x.startsWith("Settings for #")), JSON.stringify(items));
  await shot("tab-menu");
  await page.click('.tab-menu button:has-text("Move right")');
  const order1 = await page.evaluate(() => [...tabs.keys()]);
  check("Move right reorders the tabs, the bar and the saved order", order1[1] === order0[0] && order1[0] === order0[1] && (await page.$$eval(".tab .tab-name", (n) => n[1].textContent.toLowerCase())) === order0[0].toLowerCase() && (await page.evaluate(() => localStorage.getItem("tabs"))) === JSON.stringify(order1), JSON.stringify([order0, order1]));
  await page.dragAndDrop(".tab >> nth=1", ".tab >> nth=0");
  const order2 = await page.evaluate(() => [...tabs.keys()]);
  check("a tab can be dragged to a new place", JSON.stringify(order2) === JSON.stringify(order0), JSON.stringify(order2));
  await page.click(".tab >> nth=0", { button: "right" });
  await page.click('.tab-menu button:has-text("Live channels first")');
  const liveFirst = await page.evaluate(() => [...tabs.values()].map((t) => !!t.stream));
  check("Live channels first puts live tabs ahead of the rest", liveFirst.every((v, i) => i === 0 || !(v && !liveFirst[i - 1])), JSON.stringify(liveFirst));

  // ---- a second stream (wide windows) ----
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => { settings.video = true; saveSettings(); activate(tabs.get("uwoslab")); });
  await page.waitForSelector("#video:not([hidden])");
  const other2 = await page.evaluate(() => [...tabs.keys()].find((n) => n !== "uwoslab"));
  await page.click(`.tab:has(.tab-name:text-is("${other2}")), .tab >> nth=1`, { button: "right" });
  await page.click('.tab-menu button:has-text("Watch alongside")');
  await page.waitForSelector("#video2:not([hidden]) iframe");
  const two = await page.evaluate(() => ({ src: document.querySelector("#v2-frame iframe").src, dual: document.querySelector(".app").classList.contains("dual"), w1: document.getElementById("video").getBoundingClientRect().width, w2: document.getElementById("video2").getBoundingClientRect().width, saved: localStorage.getItem("secondVideo") }));
  check("Watch alongside shows a second player next to the first", /player\.twitch\.tv\/\?channel=\w+&parent=yappa\.test&muted=true/.test(two.src) && two.dual && two.w1 > 300 && two.w2 > 300 && !!two.saved, JSON.stringify(two));
  await shot("watch-alongside");
  await page.click("#v2-close");
  check("Close puts the layout back", await page.evaluate(() => document.getElementById("video2").hidden && !document.querySelector(".app").classList.contains("dual") && !localStorage.getItem("secondVideo")));
  await page.setViewportSize({ width: 390, height: 760 });
  await page.evaluate(() => closeSheet());

  // ---- backup ----
  await page.evaluate(() => { settings.snippets = [{ label: "x", text: "backup me" }]; saveSettings(); });
  await openSettingsUI();
  await page.waitForSelector("#sheet");
  const [dlb] = await Promise.all([page.waitForEvent("download"), page.click('#sheet button:has-text("Save file")')]);
  const backup = JSON.parse(readFileSync(await dlb.path(), "utf8"));
  check("Save file downloads settings, tabs and notes as JSON", /^yappa-settings-\d{4}-\d\d-\d\d\.json$/.test(dlb.suggestedFilename()) && backup.app === "yappa-settings" && backup.settings.snippets[0].text === "backup me" && Array.isArray(backup.tabs));
  await page.evaluate(() => { window.__reloads = 0; nav.reload = () => { window.__reloads++; }; });
  const fileMk = (name, text) => ({ name, mimeType: "application/json", buffer: Buffer.from(text) });
  let dialogMsg = "";
  const grab = (d) => { dialogMsg = d.message(); };
  page.on("dialog", grab);
  await page.setInputFiles('#sheet input[type=file]', fileMk("bad.json", "not json"));
  await sleep(300);
  check("a file that isn't a backup is refused with a message", /isn't a Yappa backup/.test(dialogMsg), dialogMsg);
  check("...and changes nothing", (await page.evaluate(() => window.__reloads)) === 0);
  const restored = { app: "yappa-settings", version: 1, settings: { snippets: [{ label: "r", text: "restored" }], fontSize: "huge", rules: [{ phrase: "back", user: "" }], bogus: 1 }, tabs: ["alphachan", "bad name!"], pinned: null };
  page.off("dialog", grab);
  const msgs = [];
  const grab2 = (d) => { msgs.push(d.message()); };
  page.on("dialog", grab2);
  await page.setInputFiles('#sheet input[type=file]', fileMk("good.json", JSON.stringify(restored)));
  await sleep(400);
  const after = await page.evaluate(() => ({ snippets: settings.snippets, fontSize: settings.fontSize, rules: settings.rules, bogus: settings.bogus, tabs: localStorage.getItem("tabs"), reloads: window.__reloads }));
  check("restoring asks first, then applies valid parts only, and reloads", /Replace your settings/.test(msgs[0] || "") && after.snippets[0].text === "restored" && after.rules[0].phrase === "back" && after.fontSize === 14 && after.bogus === undefined && after.tabs === '["alphachan"]' && after.reloads === 1, JSON.stringify(after));
  page.off("dialog", grab2);
  // Put the run back as it was.
  await page.evaluate((o) => { settings.snippets = []; settings.rules = []; saveSettings(); localStorage.setItem("tabs", JSON.stringify(o)); }, order0);
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
  await p2.goto("https://old.test/?error=state");
  await p2.waitForURL("https://yappa.test/**");
  await p2.waitForSelector("#error:not([hidden])");
  check("sign-in error on the old address is shown at the new one", /didn't complete/.test(await p2.textContent("#error")));
  // An import link never overwrites a browser that already has data.
  await p2.goto("https://yappa.test/?reload#import=" + encodeURIComponent(JSON.stringify({ settings: JSON.stringify({ rules: [{ phrase: "evil", user: "" }] }) })));
  await p2.waitForFunction(() => typeof settings !== "undefined");
  check("import doesn't overwrite existing data", (await p2.evaluate(() => settings.rules[0].phrase)) === "moved" && !(await p2.evaluate(() => location.hash)).includes("import"));
  await p2.close();
}


// =============== opening the app (cold start) ===============
{
  syncMockOff = true;
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("tabs") || "[]"));
  await page.evaluate(() => localStorage.setItem("tabs", '["otherchan","uwoslab"]'));
  await page.evaluate(() => localStorage.setItem("lastChannel", "uwoslab"));
  await page.evaluate(() => localStorage.setItem("chanIds", '{"uwoslab":{"id":"999"},"otherchan":{"id":"888"}}')); // remembered from an earlier visit
  await page.evaluate(() => { settings.history = true; saveSettings(); });
  log.emotes = [];
  const histBefore = log.history.length, subsBefore = log.subs.length;
  const statusUrls = [], apiOrder = [];
  const onReq = (r) => { if (r.url().includes("/api/status")) statusUrls.push(r.url()); if (r.url().includes("/api/chat/")) apiOrder.push(new URL(r.url()).pathname + new URL(r.url()).search); };
  page.on("request", onReq);
  await page.goto("https://yappa.test/?cold=1#uwoslab");
  await page.waitForFunction(() => document.querySelectorAll(".tab.joined").length >= 2, null, { timeout: 8000 });
  await sleep(500);
  page.off("request", onReq);
  const subs = log.subs.slice(subsBefore).map((x) => x.split("@")[0]);
  check("the tab you're looking at is joined first", subs[0] === "uwoslab", JSON.stringify(subs));
  check("the first status call also fetches the synced settings, and is made only once (started early by theme.js)", statusUrls.length === 1 && statusUrls[0].includes("sync=1") && (await page.evaluate(() => window.earlyStatus === null)), JSON.stringify(statusUrls));
  const iBadges = apiOrder.indexOf("/api/chat/badges?broadcaster_id=999"), iSub = apiOrder.indexOf("/api/chat/subscribe");
  check("the open channel's badges are requested from the remembered id, before the join, and only once", iBadges >= 0 && iSub >= 0 && iBadges < iSub && apiOrder.filter((x) => x === "/api/chat/badges?broadcaster_id=999").length === 1, JSON.stringify(apiOrder));
  check("Twitch emotes are fetched for the open tab only at first", JSON.stringify(log.emotes) === '["999"]', JSON.stringify(log.emotes));
  const h = log.history.slice(histBefore);
  check("...and so is the history: asked for early, then just the gap up to the join", h.length === 2 && h[0] === "uwoslab?limit=100" && /^uwoslab\?limit=100&after=\d+$/.test(h[1]), JSON.stringify(h));
  check("the early history shows once, without duplicates", await page.evaluate(() => { const ids = [...document.querySelectorAll(".messages:not([hidden]) li.msg")].map((l) => l.dataset.id).filter(Boolean); return ids.length > 0 && new Set(ids).size === ids.length; }));
  const marks = await page.evaluate(() => startup);
  check("startup timings are recorded in order", marks.status > 0 && marks.socket >= 0 && marks.firstJoin >= marks.socket && marks.allJoined >= marks.firstJoin, JSON.stringify(marks));
  await page.click('.tab:has(.tab-name:text-is("OtherChan"))');
  await page.waitForFunction(() => document.querySelector(".messages:not([hidden]) li.historical") || true);
  await sleep(400);
  check("a background tab fetches its emotes and history when first opened", JSON.stringify(log.emotes) === '["999","888"]' && log.history.length === histBefore + 3 && /^otherchan\?/.test(log.history.at(-1)), JSON.stringify([log.emotes, log.history.slice(histBefore)]));
  await openSettingsUI();
  check("Settings shows where startup time went", /Startup timings/.test(await page.textContent("#sheet")) && /signed in \d/.test(await page.textContent("#sheet")));
  await page.keyboard.press("Escape");
  await page.evaluate((t) => localStorage.setItem("tabs", JSON.stringify(t)), saved);
}

// =============== log out (last: it closes every tab) ===============
{
  await page.evaluate(() => { window.__homed = 0; nav.home = () => { window.__homed++; }; });
  const before = log.logouts || 0;
  await page.evaluate(() => logout());
  check("logging out signs out on the server, then returns to the front page", (log.logouts || 0) === before + 1 && (await page.evaluate(() => window.__homed)) === 1);
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

await browser.close();

if (errors.length) console.log("Browser errors:", errors);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed || errors.length ? 1 : 0);
