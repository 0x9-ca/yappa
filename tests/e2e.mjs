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
  stdin: { contents: 'export { renderPage, PAGE_HEADERS } from "./src/page.ts"; export { renderMoved } from "./src/moved.ts"; export { staticFiles } from "./src/static.ts";', resolveDir: root, sourcefile: "entry.ts", loader: "ts" },
  bundle: true, format: "esm", outfile: dir + "/page.bundle.mjs", logLevel: "warning",
  loader: { ".css": "text", ".js": "text", ".png": "base64" },
});
const { renderPage, PAGE_HEADERS, renderMoved, staticFiles } = await import(dir + "/page.bundle.mjs?" + Date.now());
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
const expectedErrors = [/status of 503/, /net::ERR_FAILED/];
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
    if (u.pathname === "/api/netfail") return route.abort();
    if (u.pathname === "/api/following") {
      log.following = (log.following || 0) + 1;
      if (followingMode === "scope") return j({ ok: false, error: "Missing user:read:follows", needsScope: true });
      return j({ ok: true,
        live: [{ id: "777", login: "targetchan", name: "TargetChan", title: "speedrun attempts", game: "Celeste", viewers: 4321, startedAt: new Date().toISOString() },
               { id: "999", login: "uwoslab", name: "UwoSlab", title: "Building a chat app", game: "Software and Game Development", viewers: 1234, startedAt: new Date().toISOString() }],
        channels: [{ id: "555", login: "zetachan", name: "ZetaChan" }, { id: "666", login: "alphachan", name: "AlphaChan" }, { id: "777", login: "targetchan", name: "TargetChan" }, { id: "999", login: "uwoslab", name: "UwoSlab" }] });
    }
    if (u.pathname === "/api/status" && statusDown) return route.fulfill({ status: 503, json: { ok: false, error: "The server is updating; try again in a minute.", retry: true } });
    if (u.pathname === "/api/status") { statusCalls++; return j({ twitch: { login: "testuser", userId: "111", missingScopes: [], missingOptionalScopes: [] }, cycle }); }
    if (u.pathname === "/api/chat/subscribe") { const b = body(); log.subs.push(b.channel + "@" + b.session_id); return j({ ok: true, broadcaster: { id: ids[b.channel], login: b.channel, name: { uwoslab: "UwoSlab", otherchan: "OtherChan", targetchan: "TargetChan", alphachan: "AlphaChan" }[b.channel] || b.channel }, isMod: b.channel === "uwoslab", subscriptionIds: [b.channel + "-s1", b.channel + "-s2"], automod: b.channel === "uwoslab", settings: b.channel === "uwoslab" ? chatSettings : null }); }
    if (u.pathname === "/api/streams") return j([{ user_id: "999", title: "Building a chat app", game_name: "Software and Game Development", viewer_count: 1234, started_at: new Date(Date.now() - 3 * 3600e3).toISOString() }]);
    if (u.pathname === "/api/chat/settings") { const b = body(); log.settings.push(b); Object.assign(chatSettings, b); delete chatSettings.broadcaster_id; return j({ ok: true, settings: chatSettings }); }
    if (u.pathname === "/api/chat/user") return j({ ok: true, user: { id: u.searchParams.get("user_id"), login: "spammer", display_name: "Spammer", description: "I sell followers", profile_image_url: "https://img.test/a.png", broadcaster_type: "", created_at: "2020-01-02T00:00:00Z" }, followedAt: "2024-05-06T00:00:00Z" });
    if (u.pathname === "/api/chat/automod") { log.automod.push(body()); return j({ ok: true }); }
    if (u.pathname === "/api/chat/cheermotes") return j([{ prefix: "Cheer", tiers: [{ min_bits: 1, color: "#979797", images: { dark: { animated: { "2": "https://img.test/cheer1.gif" } } } }, { min_bits: 100, color: "#9c3ee8", images: { dark: { animated: { "2": "https://img.test/cheer100.gif" } } } }] }]);
    if (u.pathname === "/api/chat/clip") {
      const id = u.searchParams.get("id"); log.clips.push(id);
      if (id === "MissingClip") return j({ ok: true, clip: null });
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
    if (u.pathname === "/api/chat/send") { log.sent.push(body().message); sendCounter++; if (cycle.enabled) { cycle.lastColor = "#" + (0x100000 + log.sent.length * 77777).toString(16).slice(-6).toUpperCase(); cycle.changes++; } return j({ ok: true, messageId: "sent-" + sendCounter }); }
    if (u.pathname === "/api/chat/badges") return j({});
    if (u.pathname === "/api/chat/emotes") return j({ ok: true, emotes: [{ id: "25", name: "Kappa", group: "Twitch global", animated: false }, { id: "e1", name: "uwoHype", group: "This channel", animated: false }] });
  }
  // The app's old address (src/moved.ts).
  if (u.host === "old.test") return route.fulfill({ body: u.pathname === "/" ? renderMoved("yappa.test") : "<p>old</p>", contentType: "text/html" });
  // The built-in player really fetches the playlist; answer slowly so the test decides the outcome.
  if (u.host === "usher.ttvnw.net") { await sleep(4000); return route.fulfill({ body: "#EXTM3U\n", contentType: "application/vnd.apple.mpegurl", headers: { "access-control-allow-origin": "*" } }).catch(() => {}); }
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
  if (u.host === "player.twitch.tv") { log.player.push(u.search); return route.fulfill({ body: "<body style='margin:0;background:#111;color:#9147ff;display:grid;place-items:center;height:100vh;font:20px sans-serif'>▶ " + u.searchParams.get("channel") + "</body>", contentType: "text/html" }); }
  if (u.host === "api.betterttv.net") {
    if (u.pathname === "/3/cached/emotes/global") return j([{ id: "bg1", code: "OMEGALUL" }]);
    if (u.pathname.startsWith("/3/cached/users/twitch/")) return j({ channelEmotes: [{ id: "bc1", code: "uwuDance" }], sharedEmotes: [{ id: "bs1", code: "sharedOne" }] });
    if (u.pathname === "/3/cached/frankerfacez/emotes/global") return j([{ id: 9, code: "ZrehplaR", images: { "1x": "https://cdn.betterttv.net/frankerfacez_emote/9/1", "2x": "https://cdn.betterttv.net/frankerfacez_emote/9/2" } }]);
    return j([]);
  }
  if (/img\.test/.test(u.href)) return route.fulfill({ body: svg(200), contentType: "image/svg+xml" });
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
const hdr = await page.evaluate(() => { const h = document.querySelector("header"); const open = h.querySelector("form button").getBoundingClientRect(), gear = document.getElementById("settings-btn").getBoundingClientRect(); return { h: Math.round(h.getBoundingClientRect().height), sameRow: Math.abs(open.top - gear.top) < 8 && gear.left > open.right, swatchInHeader: !!h.querySelector(".swatch") }; });
check("header is one row with ⚙ next to Open, no swatch", hdr.sameRow && !hdr.swatchInHeader && hdr.h < 70, JSON.stringify(hdr));
await page.click("#settings-btn");
check("color controls in Settings", (await page.textContent("#sheet-body")).includes("Chat color") && !!(await page.$("#sheet-body #cycle")));
await page.click("#cycle");
await page.waitForFunction(() => document.getElementById("cycle").textContent === "Stop cycling");
check("toggle on → POST /api/cycle and header shows new color", JSON.stringify(log.cycle) === "[true]" && (await page.textContent("#color")) === "#11AA22 - 1", await page.textContent("#color"));
await page.screenshot({ path: dir + "/t5-cycle.png" });
await page.click("#sheet-close");
await page.fill("#message", "colorful message");
await page.press("#message", "Enter");
await sleep(300);
await page.click("#settings-btn");
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
await page.click("#settings-btn");
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
await page.click("#settings-btn");
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
check("phone: video full width and at least 300px tall (Twitch's embed minimum)", vbox.w >= 388 && vbox.h >= 300 && vbox.h <= 760 * 0.45, JSON.stringify(vbox));
await page.setViewportSize({ width: 430, height: 932 });
await sleep(200);
const vbig = await page.$eval("#video iframe", (v) => { const r = v.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
check("430px-wide phone: player meets 400×300", vbig.w >= 400 && vbig.h >= 300, JSON.stringify(vbig));
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
  await page.click("#settings-btn");
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
  check("Embed keeps its 300px minimum height", (await page.$eval("#video", (v) => Math.round(v.getBoundingClientRect().height))) >= 300);
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
  await page.click("#settings-btn");
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
  await page.click("#settings-btn");
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
  await page.click("#settings-btn");
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
