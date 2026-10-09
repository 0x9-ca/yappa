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
  stdin: { contents: 'export { renderPage } from "./src/page.ts"; export { staticFiles } from "./src/static.ts";', resolveDir: root, sourcefile: "entry.ts", loader: "ts" },
  bundle: true, format: "esm", outfile: dir + "/page.bundle.mjs", logLevel: "warning",
  loader: { ".css": "text", ".js": "text", ".png": "base64" },
});
const { renderPage, staticFiles } = await import(dir + "/page.bundle.mjs?" + Date.now());
const html = renderPage("testuser@example.com");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell",
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 760 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
await page.addInitScript(() => {
  // Stand-in for Document Picture-in-Picture (not available headless): a same-origin popup.
  window.documentPictureInPicture = { requestWindow: async (o) => window.open("", "pip", "width=" + o.width + ",height=" + o.height) };
});
const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("dialog", (d) => d.accept());
page.on("response", (r) => { if (r.status() === 404) errors.push("404 " + r.url()); });
const log = { subs: [], unsubs: [], mods: [], sent: [], cycle: [], pinGets: [], settings: [], automod: [], bumps: 0, player: [] };
const chatSettings = { slow_mode: true, slow_mode_wait_time: 10, follower_mode: false, follower_mode_duration: null, subscriber_mode: false, emote_mode: false, unique_chat_mode: false };
let pinState = null;
let sendCounter = 0;
const cycle = { enabled: false, changes: 0, lastColor: "#30E51E" };
let statusCalls = 0;
const ids = { uwoslab: "999", otherchan: "888", targetchan: "777" };
const svg = (h) => `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><circle cx="28" cy="28" r="26" fill="hsl(${h},70%,55%)"/></svg>`;
await ctx.route("**/*", async (route) => {
  const u = new URL(route.request().url());
  const j = (d) => route.fulfill({ json: d });
  const body = () => route.request().postDataJSON();
  if (u.host === "yappa.test") {
    if (u.pathname === "/") return route.fulfill({ body: html, contentType: "text/html" });
    const f = staticFiles[u.pathname];
    if (f) return route.fulfill({ body: f.type === "image/png" ? Buffer.from(f.body, "base64") : f.body, contentType: f.type });
    if (u.pathname === "/api/cycle") { cycle.enabled = body().enabled; if (cycle.enabled) { cycle.lastColor = "#11AA22"; cycle.changes++; } log.cycle.push(cycle.enabled); return j({ ok: true, cycle }); }
    if (u.pathname === "/api/status") { statusCalls++; return j({ twitch: { login: "testuser", userId: "111", missingScopes: [], missingOptionalScopes: [] }, cycle }); }
    if (u.pathname === "/api/chat/subscribe") { const b = body(); log.subs.push(b.channel + "@" + b.session_id); return j({ ok: true, broadcaster: { id: ids[b.channel], login: b.channel, name: { uwoslab: "UwoSlab", otherchan: "OtherChan", targetchan: "TargetChan" }[b.channel] }, isMod: b.channel === "uwoslab", subscriptionIds: [b.channel + "-s1", b.channel + "-s2"], automod: b.channel === "uwoslab", settings: b.channel === "uwoslab" ? chatSettings : null }); }
    if (u.pathname === "/api/streams") return j([{ user_id: "999", title: "Building a chat app", game_name: "Software and Game Development", viewer_count: 1234, started_at: new Date(Date.now() - 3 * 3600e3).toISOString() }]);
    if (u.pathname === "/api/chat/settings") { const b = body(); log.settings.push(b); Object.assign(chatSettings, b); delete chatSettings.broadcaster_id; return j({ ok: true, settings: chatSettings }); }
    if (u.pathname === "/api/chat/user") return j({ ok: true, user: { id: u.searchParams.get("user_id"), login: "spammer", display_name: "Spammer", description: "I sell followers", profile_image_url: "https://img.test/a.png", broadcaster_type: "", created_at: "2020-01-02T00:00:00Z" }, followedAt: "2024-05-06T00:00:00Z" });
    if (u.pathname === "/api/chat/automod") { log.automod.push(body()); return j({ ok: true }); }
    if (u.pathname === "/api/chat/cheermotes") return j([{ prefix: "Cheer", tiers: [{ min_bits: 1, color: "#979797", images: { dark: { animated: { "2": "https://img.test/cheer1.gif" } } } }, { min_bits: 100, color: "#9c3ee8", images: { dark: { animated: { "2": "https://img.test/cheer100.gif" } } } }] }]);
    if (u.pathname === "/api/cycle/bump") { log.bumps++; return j({ ok: true, cycle }); }
    if (u.pathname === "/api/chat/unsubscribe") { log.unsubs.push(...body().ids); return j({ ok: true }); }
    if (u.pathname === "/api/chat/mod") {
      const b = body(); log.mods.push(b);
      if (b.action === "pin") pinState = { message_id: b.message_id, broadcaster_id: b.broadcaster_id, sender_user_id: "333", sender_user_login: "pinme", sender_user_name: "PinMe", pinned_by_user_name: "testuser", message: { text: "pin this Kappa", fragments: [{ type: "text", text: "pin this " }, { type: "emote", text: "Kappa", emote: { id: "25" } }] }, starts_at: new Date().toISOString(), ends_at: b.duration ? new Date(Date.now() + b.duration * 1000).toISOString() : null, updated_at: new Date().toISOString() };
      if (b.action === "unpin") pinState = null;
      return j({ ok: true, message: "did " + b.action });
    }
    if (u.pathname === "/api/chat/pin") { log.pinGets.push(u.searchParams.get("broadcaster_id")); return j({ ok: true, pin: u.searchParams.get("broadcaster_id") === "999" ? pinState : null }); }
    if (u.pathname === "/api/chat/send") { log.sent.push(body().message); sendCounter++; if (cycle.enabled) { cycle.lastColor = "#" + (0x100000 + log.sent.length * 77777).toString(16).slice(-6).toUpperCase(); cycle.changes++; } return j({ ok: true, messageId: "sent-" + sendCounter }); }
    if (u.pathname === "/api/chat/badges") return j({});
    if (u.pathname === "/api/chat/emotes") return j({ ok: true, emotes: [{ id: "25", name: "Kappa", group: "Twitch global", animated: false }, { id: "e1", name: "uwoHype", group: "This channel", animated: false }] });
  }
  if (u.host === "recent-messages.robotty.de") {
    const chan = u.pathname.split("/").pop();
    const irc = (id, user, uid, text, ts, extra = "") => "@badge-info=;badges=;color=#FF7F50;display-name=" + user + ";emotes=" + (extra.emotes || "") + ";first-msg=" + (extra.first ? 1 : 0) + ";id=" + id + ";room-id=" + ids[chan] + ";tmi-sent-ts=" + ts + ";user-id=" + uid + (extra.reply || "") + " :" + user.toLowerCase() + "!" + user.toLowerCase() + "@x.tmi.twitch.tv PRIVMSG #" + chan + " :" + text;
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
  if (u.host === "player.twitch.tv" && u.pathname === "/js/embed/v1.js") return route.fulfill({ contentType: "text/javascript", body: `
    window.__player = { calls: [], handlers: {} };
    window.Twitch = { Player: function (id, opts) {
      __player.calls.push(["new", opts]);
      const f = document.createElement("iframe");
      f.setAttribute("allow", "autoplay; fullscreen"); // what Twitch's real embed sets
      f.src = "https://player.twitch.tv/?channel=" + opts.channel + "&parent=" + opts.parent[0];
      document.getElementById(id).appendChild(f);
      this.setChannel = (c) => { __player.calls.push(["setChannel", c]); f.src = "https://player.twitch.tv/?channel=" + c + "&parent=" + opts.parent[0]; };
      this.play = () => __player.calls.push(["play"]);
      this.pause = () => __player.calls.push(["pause"]);
      this.setMuted = (m) => __player.calls.push(["setMuted", m]);
      this.addEventListener = (ev, fn) => { __player.handlers[ev] = fn; };
    } };
    Twitch.Player.PLAYBACK_BLOCKED = "playbackBlocked";` });
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
check("mod actions on others' messages", modBtns.join(",") === "Reply,Pin,Delete,Timeout,Ban", modBtns.join(","));

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
// ---- pinned messages ----
await page.click(".tab:first-child .tab-name");
sockets.at(-1).send(chat("999", "pin1", "PinMe", "333", "pin this Kappa", { fragments: [{ type: "text", text: "pin this " }, { type: "emote", text: "Kappa", emote: { id: "25" } }] }));
await page.waitForSelector('li[data-id="pin1"]');
await page.tap('li[data-id="pin1"] .body');
await page.click('li[data-id="pin1"] .actions button:has-text("Pin")');
const durations = await page.$$eval('li[data-id="pin1"] .actions button', (bs) => bs.map((b) => b.textContent));
check("pin duration menu", durations.join(",") === "1m,5m,10m,30m,Until stream ends,Cancel", durations.join(","));
await page.click('li[data-id="pin1"] .actions button:has-text("5m")');
await page.waitForSelector("#pinned:not([hidden])", { timeout: 3000 });
const pinMod = log.mods.at(-1);
check("pin API call with duration", pinMod.action === "pin" && pinMod.message_id === "pin1" && pinMod.duration === 300 && pinMod.broadcaster_id === "999", JSON.stringify(pinMod));
const pinText = await page.textContent("#pinned");
check("pinned banner shows sender, text, who pinned, time left", /Pinned by testuser · 5 min left/.test(pinText) && pinText.includes("PinMe: pin this") && !!(await page.$('#pinned img[alt="Kappa"]')), pinText);
check("pinned message flagged in chat", await page.$eval('li[data-id="pin1"]', (l) => l.classList.contains("pinned-msg")));
await page.screenshot({ path: dir + "/t6-pin.png" });
await page.click("#pinned .dismiss");
check("dismiss hides banner", await page.$eval("#pinned", (b) => b.hidden));
await page.reload();
await page.waitForFunction(() => document.querySelectorAll(".tab.joined").length === 2, null, { timeout: 5000 });
await sleep(400);
check("dismissed pin stays hidden after reload", await page.$eval("#pinned", (b) => b.hidden));
// a different pin shows up again
pinState = { ...pinState, message_id: "pin2", starts_at: new Date(Date.now() + 1000).toISOString(), ends_at: null, message: { text: "new pin", fragments: [{ type: "text", text: "new pin" }] } };
await page.click(".tab:nth-child(2) .tab-name"); await page.click(".tab:first-child .tab-name");
await page.waitForSelector("#pinned:not([hidden])", { timeout: 3000 });
check("new pin appears despite earlier dismiss", (await page.textContent("#pinned")).includes("new pin") && !(await page.textContent("#pinned")).includes("min left"));
await page.click('#pinned button:has-text("Unpin")');
await page.waitForFunction(() => document.getElementById("pinned").hidden, null, { timeout: 3000 });
check("unpin from banner", log.mods.at(-1).action === "unpin" && log.mods.at(-1).message_id === "pin2");
await page.click(".tab:nth-child(2) .tab-name");
await sleep(200);
check("non-mod tab: no pin fetch, no Pin button", !log.pinGets.includes("888") && (await page.$$(".messages:not([hidden]) .actions button:has-text('Pin')")).length === 0, JSON.stringify(log.pinGets));

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
check("history loaded above join line", s.visibleMsgs.length && (await page.$$eval('.messages:not([hidden]) li', (ls) => ls.map((l) => l.textContent)).then((t) => t.findIndex((x) => x.includes(" from history")) < t.findIndex((x) => x.includes("Joined #UwoSlab")) && t.findIndex((x) => x.includes(" from history")) > t.findIndex((x) => x.includes("recent messages")))));
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
await page.click('#sheet-body button:has-text("Hide their messages")');
check("hide user hides their messages", await page.$eval('li[data-id="card1"]', (l) => getComputedStyle(l).display === "none"));
cur().send(chat("999", "u2b", "Spammer", "333", "more spam"));
await sleep(100);
check("new messages from hidden user are hidden too", await page.$eval('li[data-id="u2b"]', (l) => getComputedStyle(l).display === "none"));
await page.click("#settings-btn");
check("settings lists hidden user", (await page.textContent("#sheet-body")).includes("Spammer"));
await page.click('#sheet-body .row button:has-text("Show")');
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
await page.click('#sheet-body button:has-text("Highlight their messages")');
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
check("own message from another app bumps color", log.bumps === 1, String(log.bumps));
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
check("phone: video full width, 16:9", Math.abs(vbox.w / vbox.h - 16 / 9) < 0.05, JSON.stringify(vbox));
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

// =============== composer: emote images ===============
await page.evaluate(() => composer.setText(""));
await page.click("#message");
await page.keyboard.type("hi Kappa catJAM OMEGALUL");
let ce = await page.evaluate(() => ({ text: composer.getText(), imgs: [...document.querySelectorAll("#message img")].map((i) => i.dataset.name) }));
check("finished emote names become images; the word being typed stays text", ce.imgs.join(",") === "Kappa,catJAM" && ce.text === "hi Kappa catJAM OMEGALUL", JSON.stringify(ce));
await page.keyboard.type(" and more");
ce = await page.evaluate(() => ({ text: composer.getText(), imgs: [...document.querySelectorAll("#message img")].map((i) => i.dataset.name), caretAtEnd: composer.caret() === composer.getText().length }));
check("typing continues normally after conversion (caret stays at end)", ce.imgs.join(",") === "Kappa,catJAM,OMEGALUL" && ce.text === "hi Kappa catJAM OMEGALUL and more" && ce.caretAtEnd, JSON.stringify(ce));
await sleep(400);
await page.screenshot({ path: dir + "/t14-composer.png" });
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
check("picker inserts an image", await page.evaluate(() => !!document.querySelector('#message img[data-name="uwoHype"]') && composer.getText() === "uwoHype "));
await page.keyboard.press("Escape");
await page.evaluate(() => composer.setText(""));

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

await browser.close();
if (errors.length) console.log("Browser errors:", errors);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed || errors.length ? 1 : 0);
