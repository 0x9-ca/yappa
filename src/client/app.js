"use strict";

const $ = (id) => document.getElementById(id);
const show = (id, on) => { $(id).hidden = !on; };
const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";
const MAX_MESSAGES = 1000;      // per tab, trimmed only while you're at the bottom
const HISTORY_PAGE = 100;       // history messages per request (the service recommends 50–100)
const MAX_TABS = 20;
const DEFAULT_COLORS = ["#FF0000", "#0000FF", "#008000", "#B22222", "#FF7F50", "#9ACD32", "#FF4500", "#2E8B57", "#DAA520", "#D2691E", "#5F9EA0", "#1E90FF", "#FF69B4", "#8A2BE2", "#00FF7F"];
const coarse = matchMedia("(pointer: coarse)").matches;
const APP_TITLE = document.title; // set server-side from the app name

let status = null;
let pinnedLogin = null;         // channel whose stream stays in the video box when you switch tabs
let me = null;                 // { userId, login }
const tabs = new Map();        // login -> tab
let active = null;             // active tab
let sock = null;               // the one EventSub socket shared by all tabs
let sessionId = null;
let sockGen = 0;               // bumps whenever we deliberately drop the socket
let retries = 0;
let replyTo = null;
let lastSent = "";
let extGlobal = new Map();     // 7TV/BTTV/FFZ global emotes: name -> { url, zeroWidth, source }
let lastSocketMsgAt = 0;       // any frame (incl. keepalives) proves the socket is alive
let keepaliveMs = 15000;
let resumedAt = Date.now();    // when the page last became visible / unfrozen
let reconnectTimer = null;
let hiddenUnread = 0;
let lastStatusAt = 0;
const sentIds = new Set();     // message ids sent from this app (for color cycling from elsewhere)
const inflightSends = new Set();
let sending = false;

// Arriving from the app's old address with that browser's data (see src/moved.ts). Only
// fills a fresh browser, so a crafted link can't overwrite what's already here.
(() => {
  const m = /^#import=(.*)$/.exec(location.hash);
  if (!m) return;
  try {
    const data = JSON.parse(decodeURIComponent(m[1]));
    if (safeGet("settings") == null && safeGet("tabs") == null) {
      for (const k of ["settings", "tabs", "lastChannel", "recentEmotes"]) {
        if (typeof data[k] === "string" && data[k].length < 100000) safeSet(k, data[k]);
      }
    }
  } catch {}
  history.replaceState(null, "", "/" + location.search);
})();

// history: null until the user answers the opt-in prompt (the service's guidelines ask for consent).
const DEFAULT_SETTINGS = { notify: false, sound: false, rules: [], fontSize: 14, hidden: [], video: true, followRaids: true, history: null, theme: "dark", player: "embed", bitsButton: "twitch", gifs: true, nativeQuality: "auto", postClips: true, modLog: false, liveAlerts: false, streamChanges: true, syncBlocks: true, mute: { words: [], bots: false, commands: false }, channels: {}, notes: {}, snippets: [], favEmotes: [], bookmarks: [],
  showTime: true, showBadges: true, compact: false, zebra: false, chatFont: "default" };
let settings = loadSettings();
function loadSettings() {
  let s;
  // structuredClone: the defaults' arrays must not be shared with (and mutated through) settings.
  try { s = { ...structuredClone(DEFAULT_SETTINGS), ...JSON.parse(safeGet("settings") || "{}") }; } catch { s = structuredClone(DEFAULT_SETTINGS); }
  // Older versions stored comma-separated highlight words; turn them into rules.
  if (typeof s.highlights === "string") {
    if (!s.rules.length) s.rules = s.highlights.split(",").map((w) => w.trim()).filter(Boolean).map((phrase) => ({ phrase, user: "" }));
    delete s.highlights;
  }
  return s;
}
function saveSettings() { safeSet("settings", JSON.stringify(settings)); applySettings(); syncChanged(); }
function applySettings() {
  const app = document.querySelector(".app");
  app.style.setProperty("--chat-font", settings.fontSize + "px");
  app.classList.toggle("compact", !!settings.compact);
  app.classList.toggle("zebra", !!settings.zebra);
  app.classList.toggle("no-time", settings.showTime === false);
  app.classList.toggle("no-badges", settings.showBadges === false);
  app.classList.toggle("font-mono", settings.chatFont === "mono");
  app.classList.toggle("font-serif", settings.chatFont === "serif");
  applyTheme();
}

// ---------- sync between devices ----------

// Settings, open tabs and the pinned stream follow the account (the Durable Object keeps one copy;
// the newest change wins). What belongs to the device stays here: how video plays, the theme,
// text size, notification permission, and whether the history service was agreed to.
const DEVICE_SETTINGS = ["notify", "sound", "fontSize", "theme", "player", "nativeQuality", "bitsButton", "history", "sync", "showTime", "showBadges", "compact", "zebra", "chatFont"];
let syncTimer = null, syncedJson = "", lastPullAt = 0;
const syncTime = () => Number(safeGet("syncAt")) || 0;

function syncBlob() {
  const shared = {};
  for (const [k, v] of Object.entries(settings)) if (!DEVICE_SETTINGS.includes(k)) shared[k] = v;
  let list = [];
  try { list = JSON.parse(safeGet("tabs") || "[]"); } catch {}
  return { settings: shared, tabs: Array.isArray(list) ? list.filter((t) => typeof t === "string").slice(0, 100) : [], pinned: safeGet("pinnedVideo") || null };
}

/** Something syncable may have changed: send it shortly, if it really differs from what was last synced. */
function syncChanged() {
  if (settings.sync === false || !me) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncPush, 2000);
}

async function syncPush() {
  if (settings.sync === false || !me) return;
  const blob = syncBlob();
  const json = JSON.stringify(blob);
  if (json === syncedJson) return;
  const at = Date.now();
  const r = await api("/api/sync", { ...blob, at });
  if (!r || !r.ok) return; // offline or mid-deploy: the next change tries again
  if (r.stored) { safeSet("syncAt", String(at)); syncedJson = json; } else applySync(r.current, false);
}

function applySync(remote, initial) {
  const keep = {};
  for (const k of DEVICE_SETTINGS) if (k in settings) keep[k] = settings[k];
  const shared = {};
  for (const [k, v] of Object.entries(remote.settings || {})) if (!DEVICE_SETTINGS.includes(k)) shared[k] = v;
  settings = { ...structuredClone(DEFAULT_SETTINGS), ...shared, ...keep };
  safeSet("settings", JSON.stringify(settings));
  applySettings();
  // Tabs and the pinned stream are only adopted at startup; reshuffling tabs under you mid-chat would be worse.
  if (initial) {
    safeSet("tabs", JSON.stringify(remote.tabs || []));
    if (remote.pinned) { safeSet("pinnedVideo", remote.pinned); pinnedLogin = remote.pinned; }
    else { try { localStorage.removeItem("pinnedVideo"); } catch {} pinnedLogin = null; }
  }
  safeSet("syncAt", String(remote.at));
  syncedJson = initial ? JSON.stringify(syncBlob()) : "";
}

/** Compares the account's copy (null: none yet) with this device's and moves whichever is newer. */
function adoptSync(remote, initial) {
  if (settings.sync === false || !me) return;
  lastPullAt = Date.now();
  if (!remote) { syncChanged(); return; } // the first device to sync seeds the account's copy
  if (remote.at > syncTime()) applySync(remote, initial);
  else if (remote.at === syncTime()) syncedJson = JSON.stringify(syncBlob());
  else syncChanged(); // this device has changes that never got sent
}

async function syncPull(initial) {
  if (settings.sync === false || !me) return;
  const r = await api("/api/sync");
  if (r && r.ok) adoptSync(r.sync, initial);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() - lastPullAt > 30000) syncPull(false);
});

// ---------- startup timings (shown at the bottom of Settings, to see where opening the app spends its time) ----------

const startup = {};
function startupMark(name) { if (!(name in startup)) startup[name] = Math.round(performance.now()); }

// ---------- theme ----------

const prefersLight = matchMedia("(prefers-color-scheme: light)");
const isLightTheme = () => document.documentElement.dataset.theme === "light";

/** Sets <html data-theme> ("system" follows the device) and re-colors names for it. */
function applyTheme() {
  const want = settings.theme === "system" ? (prefersLight.matches ? "light" : "dark") : settings.theme === "light" ? "light" : "dark";
  const changed = document.documentElement.dataset.theme !== want; // theme.js set it at load
  document.documentElement.dataset.theme = want;
  document.querySelector('meta[name="theme-color"]').content = want === "light" ? "#ffffff" : "#18181b";
  if (changed) for (const n of document.querySelectorAll(".name[data-color]")) paintName(n, n.dataset.color);
}
prefersLight.addEventListener("change", () => { if (settings.theme === "system") applyTheme(); });

// ---------- utilities ----------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
pinnedLogin = safeGet("pinnedVideo") || null;

async function api(path, body) {
  let res;
  try {
    res = await fetch(path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch {
    // Offline, or the phone just woke up: callers treat this like any failed request.
    return { ok: false, error: "Network error; check your connection.", retry: true };
  }
  let data;
  try { data = await res.json(); } catch { data = { ok: false, error: "Request failed (" + res.status + ")", retry: res.status >= 500 }; }
  // 401 + signedOut: the sign-in cookie expired, or this account was taken off the allowlist.
  if (res.status === 401 && data && data.signedOut) {
    show("expired", true);
    return { ok: false, error: "Your sign-in ended. Sign in again." };
  }
  if (!$("expired").hidden) show("expired", false); // signed in again (e.g. in another tab)
  return data;
}

function setError(msg) { $("error").textContent = msg || ""; show("error", !!msg); }
// Sign-in failures come back as a short code (never free text from the URL).
const SIGN_IN_ERRORS = {
  denied: "That Twitch account isn't allowed to use this app.",
  state: "The sign-in didn't complete (it may have taken too long). Try again.",
  failed: "Twitch sign-in failed. Try again.",
  cancelled: "Sign-in was cancelled.",
};
const qsError = new URLSearchParams(location.search).get("error");
if (qsError) { setError(SIGN_IN_ERRORS[qsError] || ""); history.replaceState(null, "", "/" + location.hash); }

function normalizeChannel(v) {
  return String(v || "").trim().replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "").replace(/^[#@]/, "").split(/[/?#]/)[0].toLowerCase();
}

// ---------- status / color cycling ----------

// The color controls live in the Settings sheet, which detaches them when it closes,
// so keep direct references rather than looking them up by id.
const cyclerEl = $("cycler"), swatchEl = $("swatch"), colorEl = $("color"), cycleBtn = $("cycle");

async function refreshStatus() {
  const s = await api("/api/status" + (status === null ? "?sync=1" : ""));
  // A failed request (offline, mid-deploy) says nothing about the account; keep the UI as is.
  if (!s || !("twitch" in s)) return;
  const first = status === null;
  status = s;
  lastStatusAt = Date.now();
  const tw = s.twitch;
  me = tw ? { userId: tw.userId, login: tw.login } : null;
  show("connect", !tw);
  show("chat", !!tw);
  show("footer", !!tw);
  show("account", !!tw);
  show("tabs", !!tw && tabs.size > 0);
  show("reauth", !!tw && tw.missingScopes.length > 0);
  const missingOptional = tw && tw.missingScopes.length === 0 ? tw.missingOptionalScopes || [] : [];
  show("reauth-optional", missingOptional.length > 0);
  renderAccount();

  renderCycle(s.cycle);
  if (first) startupMark("status");
  if (first && tw && tw.missingScopes.length === 0) {
    // The first status answer carries the account's synced copy: adopt its tabs before opening any.
    if ("sync" in s) adoptSync(s.sync, true);
    restoreTabs();
  }
}

function renderCycle(cycle) {
  cycle = cycle || { enabled: false, changes: 0 };
  swatchEl.style.background = cycle.lastColor || "transparent";
  colorEl.textContent = cycle.lastColor ? cycle.lastColor + " - " + cycle.changes : "—";
  cycleBtn.textContent = cycle.enabled ? "Stop cycling" : "Cycle color";
  cycleBtn.className = cycle.enabled ? "stop" : "ghost";
  cyclerEl.title = cycle.enabled ? "Your color changes every time you send a message" : "Your current chat color";
  const note = cycle.lastError ? (cycle.enabled ? "Color cycling error: " : "Color cycling turned off: ") + cycle.lastError : "";
  $("cycle-status").textContent = note;
  show("cycle-status", !!note && !!me);
}

cycleBtn.addEventListener("click", async () => {
  setError("");
  const enabled = !(status && status.cycle && status.cycle.enabled);
  cycleBtn.disabled = true;
  const r = await api("/api/cycle", { enabled });
  cycleBtn.disabled = false;
  if (!r.ok) setError(r.error);
  refreshStatus();
});

/** Navigation seam (the tests replace it). */
const nav = { home: () => location.replace("/"), reload: () => location.reload() };

async function logout() {
  for (const t of [...tabs.values()]) closeTab(t, { keepSaved: true });
  hideChatEmbed(); // (closing each tab already dropped its loaded chat)
  dropSocket();
  await api("/auth/logout", {});
  nav.home(); // the sign-in cookie is gone: the front page now offers to sign in

}

// ---------- tabs ----------

function saveTabs() {
  safeSet("tabs", JSON.stringify([...tabs.keys()]));
  if (active) safeSet("lastChannel", active.login);
  syncChanged();
}

function restoreTabs() {
  let saved = [];
  try { saved = JSON.parse(safeGet("tabs") || "[]"); } catch {}
  if (!Array.isArray(saved)) saved = [];
  const fromHash = normalizeChannel(location.hash.slice(1));
  const legacy = safeGet("lastChannel");
  const names = [...saved, fromHash, saved.length ? null : legacy].map(normalizeChannel).filter(Boolean);
  for (const n of names) openTab(n, false);
  const pick = (fromHash && tabs.get(fromHash)) || tabs.get(normalizeChannel(legacy)) || tabs.values().next().value;
  if (pick) activate(pick);
  renderEmptyState();
}

function openTab(name, focus = true) {
  name = normalizeChannel(name);
  if (!/^[a-z0-9_]{1,25}$/.test(name)) { setError("Enter a valid channel name."); return null; }
  let tab = tabs.get(name);
  if (!tab) {
    if (tabs.size >= MAX_TABS) { setError("You can have up to " + MAX_TABS + " tabs open."); return null; }
    tab = {
      login: name, broadcaster: null, isMod: null, subIds: [], badges: {}, ext: new Map(), cheermotes: null,
      twitchEmotes: null, unread: 0, mentioned: false, joined: false, chatters: new Map(), loadedExtras: false,
      seen: new Set(), lastTs: 0, follow: true, lastTop: 0, holding: false,
      list: el("ul", "messages"), tabEl: null,
    };
    tab.list.hidden = true;
    tab.list.setAttribute("aria-live", "polite");
    tab.list.addEventListener("scroll", () => {
      const top = tab.list.scrollTop;
      // Our own scrolls only ever go down, so a decrease means the user scrolled up.
      if (atBottom(tab)) tab.follow = true;
      else if (top < tab.lastTop - 1) tab.follow = false;
      tab.lastTop = top;
      if (tab === active && tab.follow) show("more", false);
      if (top < 400) loadOlder(tab); // near the top: fetch earlier history
    });
    // A finger on the chat (about to select or copy) pauses following until it lifts.
    tab.list.addEventListener("pointerdown", () => { tab.holding = true; });
    // Emotes and thumbnails load after insertion and grow the list; stay at the bottom.
    tab.list.addEventListener("load", () => { if (tab === active && sticking(tab)) scrollToBottom(tab); }, true);
    $("chat").insertBefore(tab.list, $("more"));
    tabs.set(name, tab);
    buildTabEl(tab);
    sysLine(tab, "Connecting to #" + name + "…");
    saveTabs();
    if (sessionId) subscribeTab(tab);
    else ensureSocket();
    ircJoin(name);
  }
  if (focus) activate(tab);
  renderEmptyState();
  return tab;
}

function buildTabEl(tab) {
  const wrap = el("div", "tab");
  const btn = el("button");
  btn.type = "button";
  btn.title = "#" + tab.login;
  const dot = el("span", "dot");
  dot.title = "Connecting…";
  const name = el("span", "tab-name", tab.login);
  const mod = el("span", "mod-pill", "MOD");
  mod.hidden = true;
  const unread = el("span", "unread");
  unread.hidden = true;
  const live = el("span", "live-pill");
  live.hidden = true;
  const pin = el("span", "tab-pin");
  pin.hidden = true;
  pin.title = "This stream is pinned";
  btn.append(dot, name, live, pin, mod, unread);
  btn.addEventListener("click", () => activate(tab));
  const close = el("button", "tab-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close " + tab.login);
  close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(tab); });
  wrap.append(btn, close);
  // Drag a tab to reorder (mouse; on touch use the tab menu: long-press a tab).
  wrap.draggable = true;
  wrap.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", tab.login); e.dataTransfer.effectAllowed = "move"; });
  wrap.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
  wrap.addEventListener("drop", (e) => {
    e.preventDefault();
    const from = tabs.get(e.dataTransfer.getData("text/plain"));
    if (from && from !== tab) moveTab(from, [...tabs.keys()].indexOf(tab.login));
  });
  $("tabs").appendChild(wrap);
  tab.tabEl = { wrap, name, mod, unread, live, pin };
  updateTabEl(tab);
}

/** Puts a tab at a position in the bar (and in the saved order). */
function moveTab(tab, index) {
  const order = [...tabs.keys()].filter((l) => l !== tab.login);
  order.splice(Math.max(0, Math.min(index, order.length)), 0, tab.login);
  const all = new Map(tabs);
  tabs.clear();
  for (const l of order) tabs.set(l, all.get(l));
  for (const t of tabs.values()) $("tabs").appendChild(t.tabEl.wrap);
  saveTabs();
}

function updateTabEl(tab) {
  const t = tab.tabEl;
  if (!t) return;
  t.wrap.classList.toggle("active", tab === active);
  t.wrap.classList.toggle("joined", tab.joined);
  t.wrap.classList.toggle("mentioned", tab.mentioned);
  t.name.textContent = tab.broadcaster ? tab.broadcaster.name : tab.login;
  t.mod.hidden = !tab.isMod;
  t.live.hidden = !tab.stream;
  t.pin.hidden = pinnedLogin !== tab.login;
  t.live.textContent = tab.stream ? compactCount(tab.stream.viewer_count) : "";
  t.wrap.title = tab.stream ? tab.stream.title + " — " + (tab.stream.game_name || "No category") + " · " + tab.stream.viewer_count.toLocaleString() + " viewers" : "";
  t.unread.hidden = tab.unread === 0;
  t.unread.textContent = tab.unread > 99 ? "99+" : String(tab.unread);
}

function activate(tab) {
  if (active === tab) return;
  const prev = active;
  active = tab;
  for (const t of tabs.values()) {
    t.list.hidden = t !== tab;
    updateTabEl(t);
  }
  tab.unread = 0;
  tab.mentioned = false;
  updateTabEl(tab);
  tab.tabEl.wrap.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  scrollToBottom(tab);
  show("more", false);
  if (prev) { setReply(null); closePicker(); closeSuggest(); }
  $("channel").value = "";
  history.replaceState(null, "", "#" + tab.login);
  saveTabs();
  updateComposer();
  ensureTwitchEmotes(tab);
  if (tab.pendingHistory) { const p = tab.pendingHistory; tab.pendingHistory = null; backfill(tab, p); }
  window.toolsActivated?.(tab);
  composer.refresh(); // the draft carries over, but only this channel's emotes may show as emotes
  renderInfo();
  renderVideo();
  applyFilter();
  if (!$("picker").hidden) renderPicker();
}

function closeTab(tab, opts = {}) {
  if (!tabs.has(tab.login)) return;
  tabs.delete(tab.login);
  if (pinnedLogin === tab.login && !opts.keepSaved) setPinned(null); // (logging out keeps the pin for when you're back)
  dropChatEmbed(tab.login);
  tab.list.remove();
  tab.tabEl.wrap.remove();
  if (tab.subIds.length) api("/api/chat/unsubscribe", { ids: tab.subIds });
  if (active === tab) {
    active = null;
    const next = tabs.values().next().value;
    if (next) activate(next);
    else { history.replaceState(null, "", "/"); updateComposer(); renderInfo(); renderVideo(); }
  }
  if (!opts.keepSaved) saveTabs();
  ircPart(tab.login);
  if (tabs.size === 0) dropSocket();
  show("tabs", tabs.size > 0);
  renderEmptyState();
}

function renderEmptyState() {
  show("tabs", !!me && tabs.size > 0);
  show("empty-chat", tabs.size === 0);
}

$("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  setError("");
  const v = $("channel").value.trim();
  if (v && openTab(v)) $("channel").value = "";
});

// ---------- followed channels (dropdown under the channel box) ----------

let following = null;          // last /api/following result
let followingAt = 0;
let followItems = [];          // rows currently listed: { login, ... }
let followIndex = -1;          // keyboard highlight

let followingLoad = null;      // the request in flight, shared

function loadFollowing() {
  if (following && following.ok && Date.now() - followingAt < 60000) return Promise.resolve();
  followingLoad = followingLoad || api("/api/following").then((r) => {
    // Keep a good list over a failed refresh.
    if (r.ok || !following || !following.ok) { following = r; followingAt = Date.now(); }
  }).finally(() => { followingLoad = null; });
  return followingLoad;
}

function openFollowList() {
  if (!me) return;
  renderFollowList();
  loadFollowing().then(() => { if (!$("follow-list").hidden) renderFollowList(); });
}

function closeFollowList() {
  show("follow-list", false);
  followIndex = -1;
}

function renderFollowList() {
  const box = $("follow-list");
  const q = $("channel").value.trim().replace(/^[#@]/, "").toLowerCase();
  const match = (c) => !q || c.login.includes(q) || c.name.toLowerCase().includes(q);
  box.replaceChildren();
  box.hidden = false;
  followItems = [];
  if (!following) { box.appendChild(el("div", "fl-note", "Loading channels you follow…")); return; }
  if (!following.ok) {
    const note = el("div", "fl-note");
    if (following.needsScope) {
      const a = el("a", null, "Reconnect Twitch");
      a.href = "/auth/login";
      note.append(a, " to see channels you follow here.");
    } else note.textContent = "Couldn't load channels you follow: " + following.error;
    box.appendChild(note);
    return;
  }
  const liveIds = new Set(following.live.map((l) => l.id));
  const live = following.live.filter(match).sort((a, b) => b.viewers - a.viewers);
  const offline = following.channels.filter((c) => !liveIds.has(c.id) && match(c))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const section = (title, list, row) => {
    if (!list.length) return;
    box.appendChild(el("div", "fl-head", title));
    for (const c of list) {
      const b = row(c);
      b.type = "button";
      b.setAttribute("role", "option");
      b.dataset.index = String(followItems.length);
      if (tabs.has(c.login)) b.appendChild(el("span", "fl-open", "open"));
      followItems.push(c);
      box.appendChild(b);
    }
  };
  section("Live now", live, (c) => {
    const b = el("button", "fl-row live");
    const text = el("span", "fl-text");
    text.append(el("span", "fl-name", c.name), el("span", "fl-sub", (c.game || "No category") + " · " + c.title));
    b.append(el("span", "dot"), text, el("span", "fl-viewers", compactCount(c.viewers)));
    b.title = c.title;
    return b;
  });
  // Offline channels can number in the thousands; list enough to scroll through.
  const shown = offline.slice(0, q ? 50 : 200);
  section(live.length ? "Offline" : "Channels you follow", shown, (c) => {
    const b = el("button", "fl-row");
    b.append(el("span", "dot off"), el("span", "fl-name", c.name));
    return b;
  });
  if (!followItems.length) {
    box.appendChild(el("div", "fl-note", q ? "No followed channel matches. Press Enter to open #" + q + "." : "You don't follow any channels yet."));
  }
  if (followIndex >= followItems.length) followIndex = followItems.length - 1;
  highlightFollow();
  window.toolsFollowExtra?.(q, box); // plus a search of Twitch for channels you don't follow
}

function highlightFollow() {
  const rows = $("follow-list").querySelectorAll(".fl-row");
  rows.forEach((r, i) => r.classList.toggle("hl", i === followIndex));
  if (followIndex >= 0) rows[followIndex].scrollIntoView?.({ block: "nearest" });
}

function pickFollow(i) {
  const c = followItems[i];
  if (!c) return;
  closeFollowList();
  $("channel").value = "";
  $("channel").blur();
  setError("");
  openTab(c.login);
}

$("channel").addEventListener("focus", openFollowList);
$("channel").addEventListener("input", () => { followIndex = -1; renderFollowList(); });
$("channel").addEventListener("keydown", (e) => {
  if ($("follow-list").hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = followItems.length;
    if (!n) return;
    // Cycles through the rows and back to "nothing highlighted" (-1), where Enter opens what was typed.
    const next = followIndex + (e.key === "ArrowDown" ? 1 : -1);
    followIndex = next >= n ? -1 : next < -1 ? n - 1 : next;
    highlightFollow();
  } else if (e.key === "Enter" && followIndex >= 0) {
    e.preventDefault();
    pickFollow(followIndex);
  } else if (e.key === "Escape") {
    closeFollowList();
    $("channel").blur();
  }
});
// click, not pointerdown: on a phone, pointerdown is also how scrolling the list starts.
$("follow-list").addEventListener("click", (e) => {
  const row = e.target.closest(".fl-row");
  if (row) pickFollow(Number(row.dataset.index));
});
document.addEventListener("pointerdown", (e) => {
  if (!$("follow-list").hidden && !e.target.closest("#follow-list, #channel")) closeFollowList();
});
$("join-form").addEventListener("submit", () => closeFollowList());

// Keyboard: Alt+1..9 switches tabs, Ctrl+W-like close isn't available in browsers, so Alt+W closes.
document.addEventListener("keydown", (e) => {
  if (!e.altKey) return;
  if (/^[1-9]$/.test(e.key)) {
    const t = [...tabs.values()][Number(e.key) - 1];
    if (t) { activate(t); e.preventDefault(); }
  } else if (e.key === "w" && active) {
    closeTab(active);
    e.preventDefault();
  }
});

window.addEventListener("hashchange", () => {
  if (location.hash.startsWith("#import=")) { history.replaceState(null, "", "#" + (active ? active.login : "")); return; }
  const h = normalizeChannel(location.hash.slice(1));
  if (h && me && (!active || h !== active.login)) openTab(h);
});

// ---------- EventSub WebSocket (shared by all tabs) ----------

function ensureSocket() {
  if (!sock && tabs.size > 0) openSocket(EVENTSUB_URL, sockGen, false);
}

function dropSocket() {
  sockGen++;
  if (sock) { sock.retired = true; sock.close(); }
  sock = null;
  sessionId = null;
  for (const t of tabs.values()) { t.joined = false; t.subIds = []; updateTabEl(t); }
  updateComposer();
}

function openSocket(url, gen, migrating) {
  const ws = new WebSocket(url);
  if (!migrating) sock = ws;
  lastSocketMsgAt = Date.now();

  ws.onmessage = (e) => {
    if (gen !== sockGen) { ws.retired = true; ws.close(); return; }
    if (ws === sock) lastSocketMsgAt = Date.now();
    const msg = JSON.parse(e.data);
    const type = msg.metadata.message_type;
    if (type === "session_welcome") {
      keepaliveMs = (msg.payload.session.keepalive_timeout_seconds || 10) * 1000;
      const old = sock;
      sock = ws;
      lastSocketMsgAt = Date.now();
      sessionId = msg.payload.session.id;
      startupMark("socket");
      if (migrating) {
        if (old && old !== ws) { old.retired = true; old.close(); }
      } else {
        subscribeAll();
        window.toolsOnSession?.(sessionId);
      }
    } else if (type === "session_reconnect") {
      openSocket(msg.payload.session.reconnect_url, gen, true);
    } else if (type === "notification") {
      handleEvent(msg.payload.subscription.type, msg.payload.event, Date.parse(msg.metadata.message_timestamp));
    } else if (type === "revocation") {
      const tab = tabForBroadcaster(msg.payload.subscription.condition && msg.payload.subscription.condition.broadcaster_user_id);
      if (tab) sysLine(tab, "Twitch revoked " + msg.payload.subscription.type + " (" + msg.payload.subscription.status + ").", "err");
    }
  };

  ws.onclose = () => socketLost(ws, gen, migrating);
}

function socketLost(ws, gen, migrating) {
  if (ws.retired || gen !== sockGen) return;
  if (migrating && sock !== ws) return; // failed migration; the old socket is still serving
  sock = null;
  sessionId = null;
  for (const t of tabs.values()) {
    t.joined = false;
    t.subIds = []; // subscriptions die with the session
    updateTabEl(t);
  }
  updateComposer();
  if (tabs.size === 0) return;
  // Reconnect right away if the user is looking; otherwise back off.
  const delay = document.hidden ? Math.min(30000, 1000 * 2 ** retries) : (retries ? Math.min(30000, 1000 * 2 ** (retries - 1)) : 0);
  retries++;
  if (active) sysLine(active, delay ? "Disconnected. Reconnecting in " + Math.round(delay / 1000) + "s…" : "Disconnected. Reconnecting…");
  scheduleReconnect(gen, delay);
}

function scheduleReconnect(gen, delay) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (gen === sockGen && !sock) openSocket(EVENTSUB_URL, gen, false);
  }, delay);
}

// Twitch sends a keepalive at least every keepaliveMs, so silence means the socket is dead
// (common after a phone sleeps or a background tab is frozen). Wait a moment after the page
// wakes up, because frames queued while frozen are delivered right after resuming.
setInterval(() => {
  if (!sock || !sessionId) return;
  if (Date.now() - resumedAt < 3000) return;
  if (Date.now() - lastSocketMsgAt > keepaliveMs + 5000) {
    // On a dead connection close() waits for a closing handshake that never comes, so
    // don't wait for onclose: retire the socket and reconnect now.
    const ws = sock;
    socketLost(ws, sockGen, false);
    ws.retired = true;
    ws.close();
  }
}, 2000);

function onResume() {
  resumedAt = Date.now();
  if (document.hidden) return;
  hiddenUnread = 0;
  updateTitle();
  if (Date.now() - lastStatusAt > 10000) refreshStatus();
  // Skip any pending back-off: the user is here now.
  if (!sock && tabs.size > 0 && me) {
    retries = 0;
    clearTimeout(reconnectTimer);
    openSocket(EVENTSUB_URL, sockGen, false);
  }
}
document.addEventListener("visibilitychange", onResume);
document.addEventListener("resume", onResume);
window.addEventListener("pageshow", onResume);
window.addEventListener("online", onResume);
window.addEventListener("focus", onResume);

function updateTitle() {
  document.title = (hiddenUnread ? "(" + (hiddenUnread > 99 ? "99+" : hiddenUnread) + ") " : "") + APP_TITLE;
  if (navigator.setAppBadge) {
    (hiddenUnread ? navigator.setAppBadge(hiddenUnread) : navigator.clearAppBadge()).catch(() => {});
  }
}

let joinRetryMs = 5000;
/** Joins every tab on a new socket: the open one first, then the rest a few at a time (each join is ~10 Twitch calls). */
async function subscribeAll() {
  const sid = sessionId;
  const queue = [...tabs.values()].sort((a, b) => (b === active) - (a === active));
  const worker = async () => {
    while (queue.length && sid === sessionId) await subscribeTab(queue.shift());
  };
  await Promise.all([worker(), worker(), worker()]);
}

async function subscribeTab(tab) {
  const sid = sessionId;
  if (!sid || tab.joining === sid) return;
  tab.joining = sid;
  const r = await api("/api/chat/subscribe", { channel: tab.login, session_id: sid, mod_log: !!settings.modLog });
  tab.joining = null;
  if (!tabs.has(tab.login)) {
    if (r.ok) api("/api/chat/unsubscribe", { ids: r.subscriptionIds });
    return;
  }
  if (sid !== sessionId) return; // the socket changed; the new welcome resubscribes
  if (!r.ok) {
    sysLine(tab, "Couldn't join #" + tab.login + ": " + r.error, "err");
    // Network blips, Twitch 5xx/429 and "the server is updating" pass; a wrong channel name or
    // a missing permission won't, so those aren't retried.
    const transient = r.retry || /\((429|5\d\d)\)/.test(r.error || "");
    tab.joinTries = (tab.joinTries || 0) + 1;
    if (transient && tab.joinTries <= 4) {
      setTimeout(() => { if (tabs.has(tab.login) && !tab.joined) subscribeTab(tab); }, Math.min(60000, joinRetryMs * 2 ** (tab.joinTries - 1)));
    }
    return;
  }
  tab.joinTries = 0;
  retries = 0;
  startupMark("firstJoin");
  if ([...tabs.values()].every((t) => t === tab || t.joined)) startupMark("allJoined");
  const rejoin = !!tab.broadcaster;
  // Pin the backfill window now: live messages arriving meanwhile must not narrow it.
  const range = { since: rejoin ? tab.lastTs : 0, until: Date.now() };
  tab.broadcaster = r.broadcaster;
  tab.isMod = r.isMod;
  tab.subIds = r.subscriptionIds || [];
  tab.joined = true;
  tab.settings = r.settings || tab.settings || null;
  tab.automod = !!r.automod;
  tab.feeds = r.feeds || {};
  updateTabEl(tab);
  // Messages we missed (or, on first join, recent history) get inserted above this line.
  const marker = sysLine(tab, (rejoin ? "Reconnected to #" : "Joined #") + r.broadcaster.name + "." +
    (r.isMod && !rejoin ? " You're a moderator here" + (r.automod ? "; AutoMod queue is on." : ".") : ""));
  if (tab === active) { updateComposer(); renderInfo(); }
  refreshStreamsSoon();
  if (!tab.loadedExtras) {
    tab.loadedExtras = true;
    await loadTabExtras(tab);
  }
  if (settings.history === true) {
    // A tab you aren't looking at fetches its first page of history when you first open it
    // (a reconnect gap is still filled at once).
    if (!rejoin && tab !== active) tab.pendingHistory = { ...range, marker };
    else backfill(tab, { ...range, marker });
  } else if (settings.history == null) askHistory(tab);
}

/**
 * Twitch has no chat history API, so (if the user opted in) fetch recent messages from the
 * public recent-messages service, as Chatterino and other clients do. Requests are small
 * pages of HISTORY_PAGE: the newest page on first load, more as you scroll up (loadOlder),
 * and after a reconnect just the gap. Each message is merged in by timestamp, so history
 * slots in around whatever is already on screen; already-shown ids are skipped.
 */
async function fetchHistory(tab, { after, before }) {
  const params = new URLSearchParams({ limit: String(HISTORY_PAGE) });
  // Both compare against the service's receive time, not the send time.
  if (after) params.set("after", String(after));
  if (before) params.set("before", String(before));
  try {
    const r = await fetch("https://recent-messages.robotty.de/api/v2/recent-messages/" + encodeURIComponent(tab.login) + "?" + params);
    if (r.ok) return (await r.json()).messages || [];
  } catch {}
  return null;
}

/** The service's receive time for a raw line (what before/after compare against). */
function receivedAt(line) {
  const m = /(?:^@|;)rm-received-ts=(\d+)/.exec(line);
  return m ? Number(m[1]) : 0;
}

/** Merges raw history lines into a tab; returns how many were new. */
function mergeHistory(tab, lines, { since = 0, until = Infinity, historical }) {
  let added = 0;
  for (const line of lines) {
    const ev = ircToEvent(line);
    // Newer than `until` arrives live over EventSub.
    if (!ev || !ev.ts || ev.ts <= since || ev.ts > until) continue;
    const li = renderMessage(tab, ev, { merge: true, historical });
    if (!li) continue; // already shown
    li.dataset.recv = String(receivedAt(line) || ev.ts);
    if (ev.deleted) addFlag(li, "deleted", "Deleted by a moderator");
    added++;
  }
  return added;
}

/** Keeps what you're reading still while messages are inserted above it. */
function keepScroll(tab, fn) {
  const list = tab.list;
  const top = list.getBoundingClientRect().top;
  let anchor = null;
  for (const n of list.children) if (n.getBoundingClientRect().bottom > top) { anchor = n; break; }
  const was = anchor ? anchor.getBoundingClientRect().top : 0;
  fn();
  // Works whether or not the browser already did its own scroll anchoring.
  if (anchor && anchor.isConnected) list.scrollTop += anchor.getBoundingClientRect().top - was;
}

/** One divider above the oldest loaded history, saying whether more can be loaded. */
function placeHistoryDivider(tab) {
  let d = tab.list.querySelector(".history-divider");
  let first = tab.list.firstElementChild;
  while (first && !first.dataset.recv) first = first.nextElementSibling;
  if (!first) { if (d) d.remove(); return; }
  if (!d) d = el("li", "sys history-divider");
  d.textContent = tab.historyDone
    ? "— start of chat history —"
    : "↑ scroll up for older messages";
  d.dataset.ts = first.dataset.ts;
  if (d.nextElementSibling !== first) tab.list.insertBefore(d, first);
}

async function backfill(tab, { since, until, marker }) {
  if (settings.history !== true) return;
  if (since) {
    // After a reconnect: page backwards through the gap until it's covered.
    let before = 0, added = 0;
    for (let page = 0; page < 8; page++) {
      const lines = await fetchHistory(tab, { after: since - 30000, before });
      if (!lines || !tabs.has(tab.login) || settings.history !== true) break;
      const stick = sticking(tab);
      keepScroll(tab, () => { added += mergeHistory(tab, lines, { since, until, historical: false }); });
      if (stick) scrollToBottom(tab);
      if (lines.length < HISTORY_PAGE) break;
      before = Math.min(...lines.map(receivedAt).filter(Boolean));
      if (!before) break;
    }
    if (added && marker && marker.isConnected) marker.textContent += " Caught up on " + added + " missed message" + (added === 1 ? "" : "s") + ".";
    return;
  }
  // First load: the newest page; scrolling up loads more.
  const lines = await fetchHistory(tab, {});
  if (!lines || !tabs.has(tab.login) || settings.history !== true) return;
  const stick = sticking(tab);
  if (tab === active) startupMark("history");
  mergeHistory(tab, lines, { until, historical: true });
  tab.historyBefore = Math.min(...lines.map(receivedAt).filter(Boolean)) || 0;
  tab.historyDone = lines.length < HISTORY_PAGE || !tab.historyBefore;
  placeHistoryDivider(tab);
  if (stick) scrollToBottom(tab);
  fillScreen(tab);
}

/** Keeps loading pages until the visible list can scroll (else you can't scroll up for more). */
function fillScreen(tab) {
  // Only continue after a page actually loaded: a call that returns early (history switched
  // off, another load already running) must not re-enter, or this spins without yielding.
  if (tab === active && !tab.list.hidden && tab.list.scrollHeight <= tab.list.clientHeight + 400) loadOlder(tab).then((loaded) => {
    if (loaded && !tab.historyDone) fillScreen(tab);
  });
}

/** Scrolled near the top: fetch the next page of older history. Resolves true if a page was added. */
async function loadOlder(tab) {
  if (settings.history !== true || tab.loadingOlder || tab.historyDone || !tab.historyBefore) return false;
  if (Date.now() < (tab.olderRetryAt || 0)) return false;
  tab.loadingOlder = true;
  const spinner = el("li", "sys history-loading", "Loading earlier messages…");
  spinner.dataset.ts = "0";
  keepScroll(tab, () => tab.list.insertBefore(spinner, tab.list.firstChild));
  const lines = await fetchHistory(tab, { before: tab.historyBefore });
  keepScroll(tab, () => {
    spinner.remove();
    if (!lines) { tab.olderRetryAt = Date.now() + 10000; return; }
    mergeHistory(tab, lines, { historical: true });
    tab.historyBefore = Math.min(tab.historyBefore, ...lines.map(receivedAt).filter(Boolean));
    tab.historyDone = lines.length < HISTORY_PAGE;
    placeHistoryDivider(tab);
  });
  tab.loadingOlder = false;
  return !!lines;
}

/** The service's guidelines: ask before using it, say what it does, and link to it. */
function historyInfo() {
  const p = el("span");
  const a = el("a", "link", "recent-messages.robotty.de");
  a.href = "https://recent-messages.robotty.de/";
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  p.append("Twitch doesn't keep chat history, so Yappa can load the last " + HISTORY_PAGE +
    " messages when you open a channel (scroll up for more, back about 24 hours), and fill in messages you missed while disconnected. " +
    "They come from ", a, ", a free service run by a community developer, which sees which channels you open.");
  return p;
}

function askHistory(tab) {
  if (settings.history != null || document.querySelector(".history-ask")) return;
  const target = active || tab;
  const li = el("li", "notice history-ask");
  li.appendChild(el("div", "sysmsg", "Load chat history?"));
  const text = el("div", "ask-text");
  text.append(historyInfo(), " You can change this in Settings.");
  const row = el("div", "raid-actions");
  row.append(btn("Load history", () => setHistory(true), "small"), btn("No thanks", () => setHistory(false), "small ghost"));
  li.append(text, row);
  append(target, li, false);
}

function setHistory(on) {
  settings.history = on;
  saveSettings();
  document.querySelectorAll(".history-ask").forEach((n) => n.remove());
  // Opting in mid-session: merge each open channel's history into what's already shown.
  if (on) for (const t of tabs.values()) if (t.joined) { t.pendingHistory = null; backfill(t, { since: 0, until: Date.now() }); }
}

const IRC_MESSAGE_TYPES = {
  "highlighted-message": "channel_points_highlighted",
  "skip-subs-mode-message": "channel_points_sub_only",
  "gigantified-emote-message": "power_ups_gigantified_emote", // seen in real chat; not in Twitch's IRC docs
};

// "@a=b;c=d :nick!nick@host PRIVMSG #chan :text" -> an object shaped like an EventSub chat event.
function ircToEvent(line) {
  const m = /^@(\S+) :([^!\s]+)!\S+ PRIVMSG #(\S+) :([\s\S]*)$/.exec(line);
  if (!m) return null;
  const tags = {};
  for (const kv of m[1].split(";")) {
    const i = kv.indexOf("=");
    const k = i < 0 ? kv : kv.slice(0, i);
    const v = i < 0 ? "" : kv.slice(i + 1);
    tags[k] = v.replace(/\\(s|:|\\|r|n)/g, (_, c) => ({ s: " ", ":": ";", "\\": "\\", r: "\r", n: "\n" })[c]);
  }
  let text = m[4];
  const action = /^\u0001ACTION (.*)\u0001$/.exec(text);
  if (action) text = action[1];

  // Emote ranges are code-point indices: "25:0-4,12-16/1902:6-10".
  const ranges = [];
  for (const part of (tags.emotes || "").split("/")) {
    const [id, spans] = part.split(":");
    if (!id || !spans) continue;
    for (const span of spans.split(",")) {
      const [a, b] = span.split("-").map(Number);
      ranges.push([a, b, id, null]);
    }
  }
  // GIFs (Tier 2+ subscribers) are listed the same way: "start-end|id|url,start-end|id|url".
  // URLs aren't escaped, so only split at a comma that starts another "start-end|" entry.
  for (const entry of (tags.gifs || "").split(/,(?=\d+-\d+\|)/)) {
    const g = /^(\d+)-(\d+)\|([^|]*)\|([\s\S]+)$/.exec(entry);
    if (g) ranges.push([Number(g[1]), Number(g[2]), g[3], { id: g[3], url: g[4] }]);
  }
  ranges.sort((x, y) => x[0] - y[0]);
  const chars = Array.from(text);
  const fragments = [];
  let pos = 0;
  for (const [a, b, id, gif] of ranges) {
    if (a > pos) fragments.push({ type: "text", text: chars.slice(pos, a).join("") });
    const covered = chars.slice(a, b + 1).join("");
    fragments.push(gif ? { type: "gif", text: covered, gif } : { type: "emote", text: covered, emote: { id } });
    pos = b + 1;
  }
  if (pos < chars.length) fragments.push({ type: "text", text: chars.slice(pos).join("") });

  // Mark @mentions of me so highlighting works like it does for live messages.
  if (me) {
    const re = new RegExp("(^|\\s)@" + me.login + "\\b", "i");
    for (const f of fragments) if (f.type === "text" && re.test(f.text)) f.mentionsMe = true;
  }

  const reply = tags["reply-parent-msg-id"]
    ? { parent_message_id: tags["reply-parent-msg-id"], parent_user_name: tags["reply-parent-display-name"], parent_message_body: tags["reply-parent-msg-body"] }
    : null;
  if (reply && fragments[0] && fragments[0].type === "text") {
    fragments[0].text = fragments[0].text.replace(/^@\S+\s/, ""); // Twitch prefixes replies with "@parent "
  }
  return {
    message_id: tags.id,
    ts: Number(tags["tmi-sent-ts"]) || 0,
    chatter_user_id: tags["user-id"],
    chatter_user_login: m[2],
    chatter_user_name: tags["display-name"] || m[2],
    color: tags.color || "",
    badges: (tags.badges || "").split(",").filter(Boolean).map((b) => { const [set_id, id] = b.split("/"); return { set_id, id }; }),
    message: { text, fragments },
    reply,
    first: tags["first-msg"] === "1",
    bits: Number(tags.bits) || 0,
    deleted: tags["rm-deleted"] === "1", // removed by a moderator before we loaded it
    // The IRC names for what EventSub calls message_type / channel_points_custom_reward_id.
    message_type: IRC_MESSAGE_TYPES[tags["msg-id"]] || "text",
    channel_points_custom_reward_id: tags["custom-reward-id"] || null,
    historical: true,
  };
}

async function loadTabExtras(tab) {
  const id = tab.broadcaster.id;
  // The account's Twitch emotes are a long paged list (seconds, not milliseconds), so they load
  // separately (ensureTwitchEmotes): chat and history must not wait for them.
  const [badges, ext, cheermotes] = await Promise.all([
    api("/api/chat/badges?broadcaster_id=" + encodeURIComponent(id)),
    loadExtChannel(id),
    api("/api/chat/cheermotes?broadcaster_id=" + encodeURIComponent(id)),
  ]);
  // The server answers {ok: false} (not an empty list) when Twitch couldn't be reached; ask
  // again at the next (re)join instead of living without badges or cheermotes all session.
  const badgesFailed = !!(badges && badges.ok === false);
  const failed = badgesFailed || !Array.isArray(cheermotes);
  tab.badges = badgesFailed || !badges ? {} : badges;
  tab.ext = ext;
  tab.cheermotes = new Map((Array.isArray(cheermotes) ? cheermotes : []).map((c) => [c.prefix.toLowerCase(), c]));
  if (failed) tab.loadedExtras = false;
  const counts = EXT_SOURCES.map((src) => [src, [...ext.values()].filter((e) => e.source === src).length]).filter(([, n]) => n);
  if (counts.length && !tab.emotesLogged) { tab.emotesLogged = true; sysLine(tab, "Channel emotes: " + counts.map(([src, n]) => n + " " + src).join(" · ") + "."); }
  if (tab === active && !$("picker").hidden) renderPicker();
  if (tab === active) composer.refresh(); // emotes typed before this channel's list arrived
  if (tab === active) ensureTwitchEmotes(tab);
}

/** Loads the account's Twitch emotes for a tab once, when the tab is in view or the picker needs them. */
function ensureTwitchEmotes(tab) {
  if (!tab || !tab.broadcaster || tab.twitchEmotes || tab.twitchEmotesLoading) return;
  tab.twitchEmotesLoading = true;
  api("/api/chat/emotes?broadcaster_id=" + encodeURIComponent(tab.broadcaster.id)).then((r) => {
    tab.twitchEmotesLoading = false;
    if (!tabs.has(tab.login)) return;
    tab.twitchEmotes = r;
    if (tab === active && !$("picker").hidden) renderPicker();
    if (tab === active) composer.refresh();
  });
}

function tabForBroadcaster(id) {
  for (const t of tabs.values()) if (t.broadcaster && t.broadcaster.id === id) return t;
  return null;
}

function updateComposer() {
  const on = !!(active && active.joined && sock);

  $("send").disabled = !on;
  $("emote-btn").disabled = !on;
  $("twitch-btn").disabled = !active;
  $("snip-btn").disabled = !on;   // only needs a channel, not a live connection
  composer.setEnabled(on, on
    ? "Send a message" + (active.isMod ? " (mod: /ban /timeout /unban /clear)" : "")
    : (active ? "Connecting…" : "Open a channel to chat"));
  if (!on) { closePicker(); closeSuggest(); }
}

// ---------- anonymous read-only IRC, only for first-time-chatter flags ----------

// EventSub chat events don't say whether a message is someone's first in the channel, but
// Twitch IRC tags do (first-msg=1). An anonymous "justinfan" login can read but never send.
let irc = null;
let ircRetries = 0;
const firstMsgIds = new Set();

function ircConnect() {
  if (irc || tabs.size === 0) return;
  const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  irc = ws;
  ws.onopen = () => {
    ircRetries = 0;
    ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
    ws.send("PASS SCHMOOPIIE\r\n");
    ws.send("NICK justinfan" + Math.floor(10000 + Math.random() * 89999) + "\r\n");
    for (const login of tabs.keys()) ws.send("JOIN #" + login + "\r\n");
  };
  ws.onmessage = (e) => {
    for (const line of String(e.data).split("\r\n")) {
      if (!line) continue;
      if (line.startsWith("PING")) { ws.send("PONG" + line.slice(4) + "\r\n"); continue; }
      if (!line.startsWith("@") || !line.includes(" PRIVMSG #")) continue;
      const tags = line.slice(1, line.indexOf(" "));
      if (!/(^|;)first-msg=1(;|$)/.test(tags)) continue;
      const id = /(?:^|;)id=([^;]+)/.exec(tags);
      if (id) markFirst(id[1]);
    }
  };
  ws.onclose = () => {
    if (irc !== ws) return;
    irc = null;
    if (tabs.size) setTimeout(ircConnect, Math.min(30000, 1000 * 2 ** ircRetries++));
  };
}

function ircSend(line) {
  if (irc && irc.readyState === WebSocket.OPEN) irc.send(line + "\r\n");
}

function ircJoin(login) {
  if (irc) ircSend("JOIN #" + login); // if still connecting, onopen joins every tab
  else ircConnect();
}

function ircPart(login) {
  ircSend("PART #" + login);
  if (tabs.size === 0 && irc) { const ws = irc; irc = null; ws.close(); }
}

function markFirst(id) {
  firstMsgIds.add(id);
  if (firstMsgIds.size > 2000) firstMsgIds.delete(firstMsgIds.values().next().value);
  // IRC and EventSub race; whichever arrives second applies the highlight.
  const li = document.querySelector('.msg[data-id="' + CSS.escape(id) + '"]');
  if (li) addFlag(li, "first", "First-time chatter");
}

/** Highlights a message with a labelled flag (first-time chatter, deleted, …). */
function addFlag(li, kind, label) {
  li.classList.add(kind);
  if (li.querySelector(".flag." + kind)) return;
  const flag = el("div", "flags");
  flag.appendChild(el("span", "flag " + kind, label));
  li.insertBefore(flag, li.firstChild);
}

// ---------- third-party emotes: 7TV, BTTV, FFZ ----------

const EXT_SOURCES = ["7TV", "BTTV", "FFZ"]; // priority when names collide

async function getJson(url) {
  try {
    const r = await fetch(url);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function stvEmotes(list) {
  return (list || []).filter((e) => e.data && e.data.host).map((e) => ({
    name: e.name, url: "https:" + e.data.host.url + "/2x.webp", zeroWidth: (e.flags & 1) === 1, source: "7TV",
  }));
}
function bttvEmotes(list) {
  return (list || []).map((e) => ({ name: e.code, url: "https://cdn.betterttv.net/emote/" + e.id + "/2x.webp", zeroWidth: false, source: "BTTV" }));
}
function ffzEmotes(list) {
  return (list || []).map((e) => ({ name: e.code, url: e.images["2x"] || e.images["1x"], zeroWidth: false, source: "FFZ" }));
}

/** Merges provider lists into one map, earlier providers winning name collisions. */
function mergeExt(...lists) {
  const m = new Map();
  for (const list of lists) for (const e of list) if (!m.has(e.name)) m.set(e.name, e);
  return m;
}

async function loadExtGlobal() {
  const [stv, bttv, ffz] = await Promise.all([
    getJson("https://7tv.io/v3/emote-sets/global"),
    getJson("https://api.betterttv.net/3/cached/emotes/global"),
    getJson("https://api.betterttv.net/3/cached/frankerfacez/emotes/global"),
  ]);
  extGlobal = mergeExt(stvEmotes(stv && stv.emotes), bttvEmotes(bttv), ffzEmotes(ffz));
}

async function loadExtChannel(twitchId) {
  const id = encodeURIComponent(twitchId);
  const [stv, bttv, ffz] = await Promise.all([
    getJson("https://7tv.io/v3/users/twitch/" + id),
    getJson("https://api.betterttv.net/3/cached/users/twitch/" + id),
    getJson("https://api.betterttv.net/3/cached/frankerfacez/users/twitch/" + id),
  ]);
  return mergeExt(
    stvEmotes(stv && stv.emote_set && stv.emote_set.emotes),
    bttvEmotes(bttv ? [...(bttv.channelEmotes || []), ...(bttv.sharedEmotes || [])] : []),
    ffzEmotes(ffz),
  );
}

function findExt(tab, word) { return tab.ext.get(word) || extGlobal.get(word); }

// ---------- cheermotes ----------

/** Picks the image and color for e.g. Cheer100 from the channel's cheermote tiers. */
function cheerFor(tab, prefix, bits) {
  const cm = tab.cheermotes && tab.cheermotes.get(prefix.toLowerCase());
  if (!cm) return null;
  let tier = null;
  for (const t of cm.tiers) if (bits >= t.min_bits && (!tier || t.min_bits > tier.min_bits)) tier = t;
  if (!tier) return null;
  const imgs = tier.images.dark.animated;
  return { url: imgs["2"] || imgs["1.5"] || imgs["1"], color: tier.color };
}

function appendCheer(tab, parent, prefix, bits, text) {
  const c = cheerFor(tab, prefix, bits);
  if (!c) { parent.appendChild(document.createTextNode(text)); return; }
  appendEmote(parent, emoteImg(c.url, text, "Cheer", "Bits cheer emote"), false);
  const amount = el("b", "cheer-bits", String(bits));
  amount.style.color = c.color;
  parent.appendChild(amount);
}

// ---------- rendering ----------

// Chat follows new messages only while you're at the very bottom. Any scroll up stops that,
// so what you're reading (or copying) doesn't move; so does a finger on the chat or text
// selected in it. Scrolling back to the bottom, or "More messages below", resumes.
const atBottom = (tab) => tab.list.scrollHeight - tab.list.scrollTop - tab.list.clientHeight <= 4;

function sticking(tab) {
  if (tab !== active) return true;
  if (!tab.follow || tab.holding) return false;
  const sel = getSelection();
  return !(sel && !sel.isCollapsed && tab.list.contains(sel.anchorNode));
}

function scrollToBottom(tab) {
  tab.list.scrollTop = tab.list.scrollHeight;
  tab.follow = true;
  tab.lastTop = tab.list.scrollTop;
}

function releaseHold() {
  for (const t of tabs.values()) t.holding = false;
}
window.addEventListener("pointerup", releaseHold);
window.addEventListener("pointercancel", releaseHold);

$("more").addEventListener("click", () => {
  if (active) scrollToBottom(active);
  show("more", false);
});

/**
 * Inserts a message where its timestamp belongs. Every list item carries data-ts and
 * lists stay in time order, which is what lets history merge in around live chat.
 * The caller handles scrolling (history inserts many at once).
 */
function insertByTime(tab, node, ts) {
  node.dataset.ts = String(ts);
  let ref = null;
  for (let n = tab.list.lastElementChild; n && Number(n.dataset.ts || 0) > ts; n = n.previousElementSibling) ref = n;
  tab.list.insertBefore(node, ref);
  if (tab === active && filterText) filterNode(node);
}

/** Drops the oldest items past MAX_MESSAGES; scrolling up can load them again from history. */
function trimList(tab) {
  const list = tab.list;
  if (list.childElementCount <= MAX_MESSAGES) return;
  while (list.childElementCount > MAX_MESSAGES) {
    const n = list.firstElementChild;
    if (n.dataset.id) tab.seen.delete(n.dataset.id); // so a reload from history isn't skipped
    n.remove();
  }
  if (settings.history !== true) return;
  for (let n = list.firstElementChild; n; n = n.nextElementSibling) {
    if (n.dataset.ts && n.dataset.ts !== "0") {
      tab.historyBefore = Number(n.dataset.recv || n.dataset.ts);
      tab.historyDone = false;
      placeHistoryDivider(tab);
      return;
    }
  }
}

function append(tab, node, countsAsUnread) {
  const list = tab.list;
  const stick = sticking(tab);
  if (!node.dataset.ts) node.dataset.ts = String(Date.now());
  list.appendChild(node);
  if (tab === active && filterText) filterNode(node);
  // Only trim at the bottom, so history you've scrolled up to load stays put while you read it.
  if (stick) trimList(tab);
  if (countsAsUnread && document.hidden) { hiddenUnread++; updateTitle(); }
  if (tab === active) {
    if (stick) scrollToBottom(tab);
    else show("more", true);
  } else {
    list.scrollTop = list.scrollHeight;
    if (countsAsUnread) { tab.unread++; updateTabEl(tab); }
  }
}

function sysLine(tab, text, kind) {
  const li = el("li", "sys" + (kind ? " " + kind : ""), text);
  append(tab, li, false);
  return li;
}

function userColor(ev) {
  if (ev.color) return ev.color;
  let h = 0;
  for (const c of ev.chatter_user_id || "") h = (h * 31 + c.charCodeAt(0)) | 0;
  return DEFAULT_COLORS[Math.abs(h) % DEFAULT_COLORS.length];
}

function isDark(hex) { return luminance(hex) < 0.06; }

/** `detail` is where it belongs ("this channel's emote", "global"), shown when you tap the emote. */
function emoteImg(src, name, source, detail) {
  const img = document.createElement("img");
  img.src = src;
  img.alt = name;
  img.title = name + " (" + source + (detail ? ", " + detail : "") + ")";
  img.loading = "lazy";
  img.dataset.emote = name;
  img.dataset.source = source;
  if (detail) img.dataset.detail = detail;
  return img;
}

/** Where a Twitch emote comes from. EventSub names the owner; history lines don't, so fall back to the account's emote list. */
function twitchEmoteDetail(tab, f) {
  const owner = f.emote && f.emote.owner_id;
  if (owner && tab.broadcaster && owner === tab.broadcaster.id) return "this channel's emote";
  if (owner === "0") return "Twitch global emote";
  const te = tab.twitchEmotes && tab.twitchEmotes.ok ? tab.twitchEmotes.emotes.find((x) => x.name === f.text) : null;
  if (owner) return te && te.owner ? te.owner + "'s emote" : "another channel's emote";
  if (te && te.owner) return te.owner + "'s emote";
  if (te && te.group) return /global/i.test(te.group) ? "Twitch global emote" : /this channel/i.test(te.group) ? "this channel's emote" : te.group;
  return "";
}

function appendEmote(parent, img, zeroWidth) {
  // Zero-width emotes overlay the previous emote if it's directly before them (ignoring spaces).
  let prev = parent.lastChild;
  if (zeroWidth && prev && prev.nodeType === 3 && !prev.textContent.trim()) prev = prev.previousSibling;
  if (zeroWidth && prev && prev.classList && prev.classList.contains("emote-wrap")) {
    if (parent.lastChild !== prev) parent.lastChild.remove();
    prev.appendChild(img);
    return;
  }
  const wrap = el("span", "emote-wrap");
  wrap.appendChild(img);
  parent.appendChild(wrap);
}

function appendText(tab, parent, text, hasBits) {
  // Swap whitespace-separated words that match 7TV/BTTV/FFZ emote names (and, for
  // messages with Bits, cheer words like Cheer100).
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    if (hasBits && !/\s/.test(part)) {
      const m = /^([a-z]+)(\d+)$/i.exec(part);
      if (m && cheerFor(tab, m[1], Number(m[2]))) { appendCheer(tab, parent, m[1], Number(m[2]), part); continue; }
    }
    const e = /\s/.test(part) ? null : findExt(tab, part);
    const link = !e && !/\s/.test(part) ? parseLink(part) : null;
    if (link) {
      appendLink(parent, link);
      continue;
    }
    if (e) appendEmote(parent, emoteImg(e.url, part, e.source, tab.ext.has(part) ? "this channel's emote" : "global emote"), e.zeroWidth);
    else if (parent.lastChild && parent.lastChild.nodeType === 3) parent.lastChild.textContent += part;
    else parent.appendChild(document.createTextNode(part));
  }
}

// ---------- links + Twitch clip cards ----------

// A full http(s) URL, or a bare domain like twitch.tv/foo (as Twitch's own chat links them).
const LINK_RE = /^(?:https?:\/\/\S+|(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?::\d+)?(?:[/?#]\S*)?)$/i;

// Bare domains only link with a real, common TLD, so chat like "hi.there" stays text.
const BARE_TLDS = new Set(("com net org io gg tv me co uk us ca de fr nl eu au nz jp kr ru br it es se no fi pl ch at be dk ie in " +
  "app dev xyz info ly gl to fm sh ai live link gov edu club online site store shop news wiki art page blog games stream").split(" "));

function parseLink(word) {
  // Leave trailing punctuation out of the link, and a ")" unless the URL opened one.
  let core = word, trail = "";
  while (/[.,!?:;'"\])]$/.test(core)) {
    const ch = core.slice(-1);
    if (ch === ")" && (core.match(/\(/g) || []).length >= (core.match(/\)/g) || []).length) break;
    trail = ch + trail;
    core = core.slice(0, -1);
  }
  if (!core || !LINK_RE.test(core)) return null;
  try {
    const bare = !/^https?:\/\//i.test(core);
    const u = new URL(bare ? "https://" + core : core);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (bare && !BARE_TLDS.has(u.hostname.split(".").pop().toLowerCase())) return null;
    return { href: u.href, text: core, trail };
  } catch { return null; }
}

function appendLink(parent, link) {
  const a = el("a", "link", link.text);
  a.href = link.href;
  a.target = "_blank";
  a.rel = "noopener noreferrer nofollow";
  parent.appendChild(a);
  if (link.trail) parent.appendChild(document.createTextNode(link.trail));
}

/** Clip slug from clips.twitch.tv/<slug> or twitch.tv/<channel>/clip/<slug>, else null. */
function clipIdFrom(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  let id = null;
  if (host === "clips.twitch.tv") id = parts[0] === "embed" ? u.searchParams.get("clip") : parts[0];
  else if (/^(www\.|m\.)?twitch\.tv$/.test(host) && parts[1] === "clip") id = parts[2];
  return id && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : null;
}

const clipCache = new Map(); // id -> { promise: Promise<clip | null>, expires }
const CLIP_RETRY_MS = [2000, 6000, 15000]; // after a failed lookup (Twitch busy, server updating, offline)
const CLIP_MISSING_MS = 60000; // a clip Twitch doesn't know yet (brand new) or any more is looked up again after this
let clipLookups = 0;
const clipQueue = [];

/** At most a few clip lookups at once: a page of history can link dozens of clips. */
function queuedClipLookup(id) {
  return new Promise((resolve) => {
    const run = () => {
      clipLookups++;
      api("/api/chat/clip?id=" + encodeURIComponent(id)).then(resolve).finally(() => {
        clipLookups--;
        const next = clipQueue.shift();
        if (next) next();
      });
    };
    if (clipLookups < 4) run(); else clipQueue.push(run);
  });
}

/** The clip, null if Twitch has none by that id, undefined if the lookup kept failing. */
async function lookupClip(id) {
  for (let attempt = 0; ; attempt++) {
    const r = await queuedClipLookup(id);
    if (r.ok) return r.clip;
    if (attempt >= CLIP_RETRY_MS.length) return undefined;
    await new Promise((res) => setTimeout(res, CLIP_RETRY_MS[attempt]));
  }
}

function fetchClip(id) {
  const hit = clipCache.get(id);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const entry = { expires: Infinity };
  entry.promise = lookupClip(id).then((clip) => {
    if (clip === undefined) { clipCache.delete(id); return null; } // gave up: try again on the next message
    if (clip === null) entry.expires = Date.now() + CLIP_MISSING_MS;
    return clip;
  });
  clipCache.set(id, entry);
  return entry.promise;
}

function fmtDuration(secs) {
  const s = Math.round(secs);
  const sec = String(s % 60).padStart(2, "0");
  if (s >= 3600) return Math.floor(s / 3600) + ":" + String(Math.floor(s / 60) % 60).padStart(2, "0") + ":" + sec;
  return Math.floor(s / 60) + ":" + sec;
}

/** A thumbnail + details card for a clip, linking to it on Twitch. */
function clipCardEl(clip) {
  const card = el("a", "clip-card");
  card.href = clip.url;
  card.target = "_blank";
  card.rel = "noopener noreferrer";
  const thumb = el("span", "thumb");
  const img = document.createElement("img");
  img.src = clip.thumbnail;
  img.alt = "";
  img.loading = "lazy";
  thumb.append(img, el("span", "dur", fmtDuration(clip.duration)));
  const meta = el("span", "clip-meta");
  meta.append(
    el("span", "clip-title", clip.title),
    el("span", null, clip.broadcaster + (clip.game ? " · " + clip.game : "")),
    el("span", null, "Clipped by " + clip.creator + " · " + compactCount(clip.views) + " views · " + since(clip.createdAt) + " ago"),
  );
  card.append(thumb, meta);
  return card;
}

/** Adds a thumbnail + metadata card under a message for each Twitch clip it links (max 2). */
function attachClipCards(tab, li, body) {
  const ids = [...new Set([...body.querySelectorAll("a.link")].map((a) => clipIdFrom(a.href)).filter(Boolean))].slice(0, 2);
  for (const id of ids) {
    fetchClip(id).then((clip) => {
      if (!clip || !li.isConnected || !/^https:\/\//.test(clip.url)) return;
      const stick = tab === active && sticking(tab);
      const card = clipCardEl(clip);
      if (stick) {
        li.insertBefore(card, li.querySelector(".actions"));
        scrollToBottom(tab);
      } else {
        keepScroll(tab, () => li.insertBefore(card, li.querySelector(".actions")));
      }
    });
  }
}

/**
 * A GIF that a Tier 2+ subscriber sent. `f.text` is Twitch's placeholder ("[Description GIF by
 * Someone]"). Twitch requires the URL to be used exactly as sent, so it's never altered; only
 * https is ever loaded, and the request doesn't tell the GIF host which page asked.
 */
function appendGif(parent, f) {
  const url = f.gif.url;
  const label = f.text || "GIF";
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) { parent.appendChild(document.createTextNode(label)); return; }
  if (settings.gifs === false) {
    const a = el("a", "link", label);
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer nofollow";
    parent.appendChild(a);
    return;
  }
  const img = document.createElement("img");
  img.className = "chat-gif";
  img.src = url;
  img.alt = img.title = label;
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  img.addEventListener("load", () => img.classList.add("loaded"));
  parent.appendChild(img);
}

function renderFragments(tab, parent, fragments, skipPrefix, hasBits, gigantify) {
  let skip = skipPrefix;
  // "Gigantify an Emote" (a Bits Power-up): Twitch marks the message and enlarges its last emote.
  // That rule isn't in Twitch's docs; it matches how the messages look in practice.
  let giantAt = -1;
  if (gigantify) (fragments || []).forEach((f, k) => { if (f.type === "emote" && f.emote) giantAt = k; });
  for (const [k, f] of (fragments || []).entries()) {
    if (f.type === "cheermote" && f.cheermote) {
      appendCheer(tab, parent, f.cheermote.prefix, f.cheermote.bits, f.text);
    } else if (f.type === "emote" && f.emote) {
      const giant = k === giantAt;
      const img = emoteImg("https://static-cdn.jtvnw.net/emoticons/v2/" + f.emote.id + "/default/dark/" + (giant ? "4.0" : "2.0"), f.text, giant ? "Twitch, gigantified" : "Twitch", twitchEmoteDetail(tab, f));
      if (giant) img.classList.add("giant");
      appendEmote(parent, img, false);
    } else if (f.type === "gif" && f.gif) {
      appendGif(parent, f);
    } else if (f.type === "mention") {
      if (skip && f.mention) { skip = false; continue; } // reply prefix "@user "
      parent.appendChild(el("span", "mention", f.text));
    } else {
      let t = f.text;
      if (skip && /^\s/.test(t)) { t = t.replace(/^\s+/, ""); skip = false; }
      appendText(tab, parent, t, hasBits);
    }
  }
}

const timeFormat = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
function timeLabel(ts) {
  return timeFormat.format(ts || Date.now());
}

function nameNode(ev) {
  const color = userColor(ev);
  const name = el("span", "name", ev.chatter_user_name);
  paintName(name, color);
  name.title = color + (ev.color ? "" : " (no color set; default)");
  return name;
}

/** Colors a name for the current theme, remembering the chatter's real color for re-themes. */
function paintName(node, color) {
  node.dataset.color = color;
  node.style.color = readableColor(color);
  node.classList.toggle("dark", !isLightTheme() && isDark(color));
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * On the light theme, darkens bright names (yellow, lime…) just enough to read on white
 * (about 3:1 contrast). The dark theme keeps the real color; very dark names get a glow there.
 */
function readableColor(hex) {
  if (!isLightTheme() || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  let n = parseInt(hex.slice(1), 16);
  let [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
  for (let i = 0; i < 30 && luminance("#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)) > 0.3; i++) {
    r = Math.floor(r * 0.92); g = Math.floor(g * 0.92); b = Math.floor(b * 0.92);
  }
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

function actionButton(label, onClick, danger) {
  const b = el("button", danger ? "danger" : null, label);
  b.type = "button";
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    b.closest(".msg")?.classList.remove("selected");
    onClick();
  });
  return b;
}

function renderMessage(tab, ev, opts = {}) {
  if (ev.message_id) {
    if (tab.seen.has(ev.message_id)) return;
    tab.seen.add(ev.message_id);
    if (tab.seen.size > 2000) tab.seen.delete(tab.seen.values().next().value);
  }
  if (ev.ts && ev.ts > tab.lastTs) tab.lastTs = ev.ts;
  const li = el("li", "msg" + (opts.historical ? " historical" : ""));
  li.dataset.id = ev.message_id;
  li.dataset.user = ev.chatter_user_id;
  li.dataset.login = ev.chatter_user_login || "";
  if (isHidden(ev.chatter_user_id)) li.classList.add("ignored");
  else if (isMuted(ev, tab.login)) { li.classList.add("ignored"); li.dataset.muted = "1"; }
  if (ev.chatter_user_login) tab.chatters.set(ev.chatter_user_login, ev.chatter_user_name);
  if (tab.chatters.size > 1000) tab.chatters.delete(tab.chatters.keys().next().value);

  if (ev.reply) {
    li.appendChild(el("div", "reply-ctx", "↪ Replying to @" + ev.reply.parent_user_name + ": " + ev.reply.parent_message_body));
  }
  li.appendChild(el("span", "time", timeLabel(ev.ts)));
  for (const b of ev.badges || []) {
    const info = tab.badges[b.set_id + "/" + b.id];
    if (!info) continue;
    const img = el("img", "badge");
    img.src = info.url;
    img.alt = img.title = info.title;
    li.appendChild(img);
  }
  // Shared chat: a message from another channel taking part says where it came from.
  if (ev.source_broadcaster_user_id && ev.source_broadcaster_user_id !== ev.broadcaster_user_id) {
    const from = el("span", "shared-pill", ev.source_broadcaster_user_name || "shared chat");
    from.title = "Sent in " + (ev.source_broadcaster_user_name || "another channel") + "'s chat (shared chat)";
    li.appendChild(from);
  }
  const nm = nameNode(ev);
  nm.addEventListener("click", (e) => {
    e.stopPropagation();
    openUserCard(tab, { id: ev.chatter_user_id, login: ev.chatter_user_login, name: ev.chatter_user_name, color: nm.style.color, badges: ev.badges || [] });
  });
  li.appendChild(nm);
  const tag = userTag(ev.chatter_user_id);
  if (tag) li.appendChild(tag);
  const mine = me && ev.chatter_user_id === me.userId;
  li.appendChild(document.createTextNode(": "));
  const body = el("span", "body");
  renderFragments(tab, body, ev.message.fragments, !!ev.reply, !!ev.bits, ev.message_type === "power_ups_gigantified_emote");
  li.appendChild(body);

  const mentioned = me && (ev.message.fragments || []).some((f) => (f.type === "mention" && f.mention && f.mention.user_id === me.userId) || f.mentionsMe);
  if (mentioned) li.classList.add("mentioned");
  const highlighted = !mentioned && !mine && matchesHighlight(ev);
  if (highlighted) li.classList.add("highlighted");
  if ((mentioned || highlighted) && !mine && !opts.historical && !opts.merge && !li.classList.contains("ignored")) {
    alertFor(tab, ev);
    window.toolsMention?.(tab, ev, mentioned ? "mention" : "highlight");
  }
  if (mine && !opts.historical && !opts.merge) maybeBumpColor(ev.message_id);

  const actions = el("div", "actions");
  actions.appendChild(actionButton("Reply", () => setReply({ id: ev.message_id, user: ev.chatter_user_name, text: ev.message.text })));
  actions.appendChild(actionButton("Save", () => window.toolsBookmark?.(tab, ev)));
  actions.appendChild(actionButton("Translate", () => window.toolsTranslate?.(tab, ev, li)));
  const target = !mine && tab.broadcaster && ev.chatter_user_id !== tab.broadcaster.id;
  if (tab.isMod && target) {
    actions.appendChild(actionButton("Delete", () => modAction(tab, { action: "delete", message_id: ev.message_id })));
    actions.appendChild(actionButton("Timeout", () => modAction(tab, { action: "timeout", user_id: ev.chatter_user_id, login: ev.chatter_user_login, duration: 600 })));
    actions.appendChild(actionButton("Ban", () => {
      if (confirm("Ban " + ev.chatter_user_name + " from #" + tab.broadcaster.name + "?")) {
        modAction(tab, { action: "ban", user_id: ev.chatter_user_id, login: ev.chatter_user_login });
      }
    }, true));
  }
  li.appendChild(actions);
  if (!li.classList.contains("ignored")) attachClipCards(tab, li, body);
  if (ev.first || ev.message_type === "user_intro" || firstMsgIds.has(ev.message_id)) addFlag(li, "first", "First-time chatter");
  const points = pointsLabel(ev);
  if (points) addFlag(li, "points", points);
  const sus = tab.suspicious && tab.suspicious.get(ev.message_id);
  if (sus) addFlag(li, "suspicious", sus);

  if (opts.merge) {
    insertByTime(tab, li, ev.ts);
    if (!opts.historical && !mine && tab !== active) { tab.unread++; updateTabEl(tab); }
  } else {
    if (ev.ts) li.dataset.ts = String(ev.ts);
    append(tab, li, !li.classList.contains("ignored") && !mine);
  }
  if (mentioned && tab !== active && !opts.historical && !li.classList.contains("ignored")) { tab.mentioned = true; updateTabEl(tab); }
  if (!opts.historical && !opts.merge && !li.classList.contains("ignored")) window.toolsMirror?.(tab, li);
  return li;
}

/**
 * Channel points redemptions that show up in chat. They're the only ones a viewer can see:
 * the redemption events themselves need the broadcaster's own permission. So this covers
 * "Highlight My Message", "Send a Message in Sub-Only Mode" and rewards that ask for text,
 * without the reward's name or cost.
 */
function pointsLabel(ev) {
  if (ev.message_type === "channel_points_highlighted") return "Highlighted message · channel points";
  if (ev.message_type === "channel_points_sub_only") return "Sub-only mode message · channel points";
  if (ev.channel_points_custom_reward_id) return "Redeemed a channel points reward";
  return null;
}

function renderNotification(tab, ev) {
  const li = el("li", "notice");
  li.dataset.user = ev.chatter_user_id || "";
  li.appendChild(el("div", "sysmsg", ev.system_message || ev.notice_type));
  if (ev.message && ev.message.text) {
    const body = el("div");
    body.appendChild(nameNode(ev));
    body.appendChild(document.createTextNode(": "));
    renderFragments(tab, body, ev.message.fragments, false);
    li.appendChild(body);
  }
  append(tab, li, true);
}

function handleEvent(type, ev, ts) {
  if (type === "user.whisper.message") return window.toolsHandleEvent?.(type, ev, null, ts);
  if (type === "channel.raid") return handleRaid(tabForBroadcaster(ev.from_broadcaster_user_id), ev);
  const tab = tabForBroadcaster(ev.broadcaster_user_id);
  if (!tab) return;
  if (ts) ev.ts = ts;
  const list = tab.list;
  switch (type) {
    case "channel.chat.message": return renderMessage(tab, ev);
    case "channel.chat_settings.update":
      tab.settings = {
        slow_mode: ev.slow_mode, slow_mode_wait_time: ev.slow_mode_wait_time_seconds,
        follower_mode: ev.follower_mode, follower_mode_duration: ev.follower_mode_duration_minutes,
        subscriber_mode: ev.subscriber_mode, emote_mode: ev.emote_mode, unique_chat_mode: ev.unique_chat_mode,
      };
      if (tab === active) { renderInfo(); window.toolsModesChanged?.(tab); }
      return;
    case "automod.message.hold": return renderHeld(tab, ev);
    case "automod.message.update": return resolveHeld(tab, ev);
    case "channel.chat.notification": return renderNotification(tab, ev);
    case "channel.suspicious_user.message":
    case "channel.moderate":
    case "channel.unban_request.create": return window.toolsHandleEvent?.(type, ev, tab, ts);
    case "channel.chat.message_delete": {
      const li = list.querySelector('.msg[data-id="' + CSS.escape(ev.message_id) + '"]');
      if (li) addFlag(li, "deleted", "Deleted by a moderator");
      return;
    }
    case "channel.chat.clear_user_messages":
      list.querySelectorAll('.msg[data-user="' + CSS.escape(ev.target_user_id) + '"]').forEach((n) => addFlag(n, "deleted", "Removed: user timed out or banned"));
      return sysLine(tab, ev.target_user_name + " was timed out or banned.");
    case "channel.chat.clear":
      list.querySelectorAll(".msg").forEach((n) => addFlag(n, "deleted", "Removed: chat cleared"));
      return sysLine(tab, "Chat was cleared by a moderator.");
  }
}

// ---------- emote tooltip: tap an emote for its name and where it comes from ----------

let emoteTip = null; // { node, img }

function hideEmoteTip() {
  if (emoteTip) emoteTip.node.remove();
  emoteTip = null;
}

function showEmoteTip(img) {
  if (emoteTip && emoteTip.img === img) { hideEmoteTip(); return; } // tap again to close
  hideEmoteTip();
  const name = img.dataset.emote, source = img.dataset.source, detail = img.dataset.detail;
  const tip = el("div", "emote-tip");
  tip.setAttribute("role", "tooltip");
  const pic = document.createElement("img");
  pic.src = img.src;
  pic.alt = "";
  const text = el("div", "et-text");
  text.append(el("div", "et-name", name), el("div", "et-src", source + (detail ? " · " + detail : "")));
  tip.append(pic, text);
  const usable = active && source !== "Cheer" && emoteInChannel(active, name);
  if (usable) {
    const add = btn("Add to message", () => { hideEmoteTip(); insertEmote(name); }, "small");
    tip.appendChild(add);
    tip.appendChild(btn(isFavorite(name) ? "★ Unfavorite" : "☆ Favorite", () => { toggleFavorite(name, img.src); hideEmoteTip(); }, "small"));
  }
  document.body.appendChild(tip);
  emoteTip = { node: tip, img };
  placeEmoteTip();
}

/** Below the emote if it fits, else above; kept inside the screen. Goes away if the emote scrolled out of view. */
function placeEmoteTip() {
  if (!emoteTip) return;
  const { node, img } = emoteTip;
  const r = img.getBoundingClientRect(), list = img.closest(".messages");
  const box = list ? list.getBoundingClientRect() : { top: 0, bottom: innerHeight };
  if (!img.isConnected || r.bottom < box.top || r.top > box.bottom) { hideEmoteTip(); return; }
  const t = node.getBoundingClientRect();
  const top = r.bottom + 8 + t.height <= innerHeight - 8 ? r.bottom + 8 : Math.max(8, r.top - 8 - t.height);
  const left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), innerWidth - t.width - 8);
  node.style.top = top + "px";
  node.style.left = left + "px";
}

document.addEventListener("pointerdown", (e) => { if (emoteTip && !emoteTip.node.contains(e.target) && e.target !== emoteTip.img) hideEmoteTip(); }, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideEmoteTip(); });
// Chat scrolls by itself as messages arrive: follow the emote rather than closing.
document.addEventListener("scroll", () => placeEmoteTip(), true);
window.addEventListener("resize", placeEmoteTip);

// Touch devices have no hover, so tapping a message toggles its action bar.
$("chat").addEventListener("click", (e) => {
  if (e.target.closest("a")) return; // links open in a new tab; don't also select the message
  const emote = e.target.closest(".msg .body .emote-wrap img[data-emote]");
  if (emote) { showEmoteTip(emote); return; } // an emote tap explains the emote instead of selecting the message
  const li = e.target.closest(".msg");
  const wasSelected = li && li.classList.contains("selected");
  document.querySelectorAll(".msg.selected").forEach((n) => n.classList.remove("selected"));
  if (li && !wasSelected && !e.target.closest(".actions")) li.classList.add("selected");
});

// ---------- raids ----------

const RAID_FOLLOW_SECONDS = 5;
let raidTimer = null;

/** The channel in a tab raided out. Follow it (like Twitch does) if it's the one being watched. */
function handleRaid(tab, ev) {
  if (!tab) return;
  const target = ev.to_broadcaster_user_login;
  const li = el("li", "notice raid");
  li.appendChild(el("div", "sysmsg", ev.from_broadcaster_user_name + " raided " + ev.to_broadcaster_user_name +
    " with " + Number(ev.viewers || 0).toLocaleString() + " viewer" + (ev.viewers === 1 ? "" : "s") + "."));
  const row = el("div", "raid-actions");
  row.appendChild(btn("Go to #" + target, () => { cancelRaidFollow(); openTab(target); }, "small"));
  li.appendChild(row);

  const follow = tab === active && settings.followRaids;
  // Build the countdown before inserting the notice so chat scrolls to show all of it.
  const note = el("span", "raid-note");
  const stay = btn("Stay here", () => { cancelRaidFollow(); note.textContent = "Staying."; stay.remove(); }, "small ghost");
  if (follow) row.append(note, stay);
  append(tab, li, true);

  if (tab !== active) { tab.mentioned = true; updateTabEl(tab); return; }
  if (!follow) return;

  // Countdown, cancellable; switching tabs yourself also cancels.
  cancelRaidFollow();
  let left = RAID_FOLLOW_SECONDS;
  const tick = () => {
    if (active !== tab) { cancelRaidFollow(); note.textContent = ""; stay.remove(); return; }
    if (left <= 0) {
      raidTimer = null;
      stay.remove();
      note.textContent = "Followed the raid.";
      openTab(target);
      return;
    }
    note.textContent = "Following in " + left + "s…";
    left--;
    raidTimer = setTimeout(tick, 1000);
  };
  tick();
}

function cancelRaidFollow() {
  clearTimeout(raidTimer);
  raidTimer = null;
}

// ---------- moderation ----------

async function modAction(tab, req) {
  if (!tab.broadcaster) return;
  const r = await api("/api/chat/mod", { ...req, broadcaster_id: tab.broadcaster.id });
  sysLine(tab, r.ok ? r.message : "Mod action failed: " + r.error, r.ok ? "ok" : "err");
}

function parseDuration(s) {
  const m = /^(\d+)([smhdw]?)$/i.exec(s || "");
  if (!m) return null;
  const mult = { "": 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
}

/** Returns true if the text was a command we handled (and should not be sent as chat). */
function runCommand(tab, text) {
  if (!text.startsWith("/")) return false;
  const [cmd, ...args] = text.slice(1).split(/\s+/);
  const user = args[0] ? args[0].replace(/^@/, "") : "";
  const needUser = (usage) => { if (!user) { sysLine(tab, "Usage: " + usage, "err"); return false; } return true; };
  switch (cmd.toLowerCase()) {
    case "ban":
      if (needUser("/ban <user> [reason]")) modAction(tab, { action: "ban", login: user, reason: args.slice(1).join(" ") });
      return true;
    case "unban":
    case "untimeout":
      if (needUser("/" + cmd + " <user>")) modAction(tab, { action: "unban", login: user });
      return true;
    case "timeout": {
      if (!needUser("/timeout <user> [duration e.g. 600, 10m, 1h] [reason]")) return true;
      let duration = 600, rest = args.slice(1);
      const d = parseDuration(rest[0]);
      if (d) { duration = d; rest = rest.slice(1); }
      modAction(tab, { action: "timeout", login: user, duration, reason: rest.join(" ") });
      return true;
    }
    case "clear":
      if (confirm("Clear all of #" + tab.broadcaster.name + "'s chat?")) modAction(tab, { action: "clear" });
      return true;
    case "help":
      sysLine(tab, "Commands: /ban <user> [reason] · /unban <user> · /timeout <user> [10m] [reason] · /untimeout <user> · /clear");
      return true;
    default:
      sysLine(tab, "Unknown command /" + cmd + ". Try /help.", "err");
      return true;
  }
}

// ---------- emote sources (shared by picker + autocomplete) ----------

const TWITCH_GROUPS = ["This channel", "Other channels", "Twitch global", "Other"];

function twitchEmoteUrl(e) {
  return "https://static-cdn.jtvnw.net/emoticons/v2/" + e.id + "/" + (e.animated ? "animated" : "static") + "/dark/2.0";
}

function allEmotes(tab) {
  const out = [];
  const seen = new Set();
  const push = (name, url, source) => { if (!seen.has(name)) { seen.add(name); out.push({ name, url, source }); } };
  if (tab && tab.twitchEmotes && tab.twitchEmotes.ok) {
    for (const g of TWITCH_GROUPS) for (const e of tab.twitchEmotes.emotes) if (e.group === g) push(e.name, twitchEmoteUrl(e), "Twitch");
  }
  if (tab) for (const [name, e] of tab.ext) push(name, e.url, e.source);
  for (const [name, e] of extGlobal) push(name, e.url, e.source);
  return out;
}

// ---------- emote picker ----------

/** An emote usable in this tab by that name ({ name, url }), Twitch first, else null. */
function emoteInChannel(tab, name) {
  if (!tab) return null;
  const te = tab.twitchEmotes;
  if (te && te.ok) {
    // Looked up for every word you type, so index the list by name once.
    te.byName = te.byName || new Map(te.emotes.map((x) => [x.name, x]));
    const e = te.byName.get(name);
    if (e) return { name, url: twitchEmoteUrl(e) };
  }
  const ext = findExt(tab, name);
  return ext ? { name, url: ext.url } : null;
}

/**
 * Recent emotes that work here, drawn with this channel's image. Third-party emotes
 * (7TV/BTTV/FFZ) belong to channels, and some Twitch ones (follower emotes) do too. If
 * your Twitch emote list didn't load, Twitch recents stay, since there's no way to check.
 */
function recentHere(tab) {
  const twitchKnown = !!(tab && tab.twitchEmotes && tab.twitchEmotes.ok);
  return recentEmotes()
    .map((e) => emoteInChannel(tab, e.name) || (!twitchKnown && /static-cdn\.jtvnw\.net/.test(e.url) ? e : null))
    .filter(Boolean);
}

/** Favorite emotes that this channel can use. */
function favHere(tab) {
  const twitchKnown = !!(tab && tab.twitchEmotes && tab.twitchEmotes.ok);
  return (settings.favEmotes || [])
    .map((e) => emoteInChannel(tab, e.name) || (!twitchKnown && /static-cdn\.jtvnw\.net/.test(e.url) ? e : null))
    .filter(Boolean);
}

const isFavorite = (name) => (settings.favEmotes || []).some((e) => e.name === name);

/** Adds or removes a favorite; returns whether it is one now. */
function toggleFavorite(name, url) {
  const list = settings.favEmotes || [];
  if (isFavorite(name)) settings.favEmotes = list.filter((e) => e.name !== name);
  else settings.favEmotes = [...list, { name, url }].slice(-60);
  saveSettings();
  if (!$("picker").hidden) renderPicker();
  return isFavorite(name);
}

function recentEmotes() {
  try { return JSON.parse(safeGet("recentEmotes") || "[]"); } catch { return []; }
}

function rememberEmote(name, url) {
  const list = [{ name, url }, ...recentEmotes().filter((e) => e.name !== name)].slice(0, 24);
  safeSet("recentEmotes", JSON.stringify(list));
}

function openPicker() {
  closeSuggest();
  show("picker", true);
  if (!coarse) $("emote-search").focus();
  renderPicker();
  // Retry a failed Twitch emote load when the picker is reopened.
  if (active && active.broadcaster && active.twitchEmotes && !active.twitchEmotes.ok && !active.twitchEmotes.needsScope) {
    active.twitchEmotes = null;
    renderPicker();
  }
  ensureTwitchEmotes(active);
}

function closePicker() {
  show("picker", false);
  $("emote-search").value = "";
}

function renderPicker() {
  const tab = active;
  const q = $("emote-search").value.trim().toLowerCase();
  const match = (name) => !q || name.toLowerCase().includes(q);
  const sections = [];
  const add = (title, items) => {
    items = items.filter((e) => match(e.name));
    if (items.length) sections.push([title, items]);
  };
  const ext = (m, src) => [...m].filter(([, e]) => e.source === src).map(([name, e]) => ({ name, url: e.url }));
  const tw = (group) => tab && tab.twitchEmotes && tab.twitchEmotes.ok
    ? tab.twitchEmotes.emotes.filter((e) => e.group === group).map((e) => ({ name: e.name, url: twitchEmoteUrl(e) }))
    : [];

  add("★ Favorites", favHere(tab));
  if (!q) add("Recent", recentHere(tab));
  add("Twitch · this channel", tw("This channel"));
  if (tab) for (const src of EXT_SOURCES) add(src + " · this channel", ext(tab.ext, src));
  // One section per channel the emotes come from (alphabetical); any whose owner couldn't be named share one.
  const others = tab && tab.twitchEmotes && tab.twitchEmotes.ok ? tab.twitchEmotes.emotes.filter((e) => e.group === "Other channels") : [];
  const byOwner = new Map();
  for (const e of others) {
    const k = e.owner || "";
    if (!byOwner.has(k)) byOwner.set(k, []);
    byOwner.get(k).push({ name: e.name, url: twitchEmoteUrl(e) });
  }
  for (const k of [...byOwner.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, undefined, { sensitivity: "base" })))) {
    add(k ? "Twitch · " + k : "Twitch · other channels", byOwner.get(k));
  }
  add("Twitch · global", tw("Twitch global"));
  for (const src of EXT_SOURCES) add(src + " · global", ext(extGlobal, src));
  add("Twitch · other", tw("Other"));

  let note = null;
  const te = tab && tab.twitchEmotes;
  if (tab && tab.broadcaster && !te) note = "Loading your Twitch emotes…";
  else if (te && te.needsScope) {
    const a = el("a", null, "Reconnect Twitch");
    a.href = "/auth/login";
    note = [a, " to include your Twitch emotes."];
  } else if (te && !te.ok) note = "Couldn't load Twitch emotes: " + (te.error || "unknown error");
  $("picker-note").replaceChildren(...[].concat(note || []));
  show("picker-note", !!note);

  const list = $("picker-list");
  list.replaceChildren();
  if (!sections.length) {
    list.appendChild(el("div", "empty", q ? "No emotes match “" + q + "”." : "No emotes yet."));
    return;
  }
  for (const [title, items] of sections) {
    list.appendChild(el("h3", null, title + " (" + items.length + ")"));
    const grid = el("div", "grid");
    for (const e of items) {
      const b = el("button");
      b.type = "button";
      b.title = e.name;
      b.dataset.name = e.name;
      b.dataset.url = e.url;
      const img = document.createElement("img");
      img.src = e.url;
      img.alt = e.name;
      img.loading = "lazy";
      b.appendChild(img);
      grid.appendChild(b);
    }
    list.appendChild(grid);
  }
  if (!q && !(settings.favEmotes || []).length) list.appendChild(el("div", "hint fav-hint", "Tip: long-press (or right-click) an emote to favorite it."));
}

function insertEmote(name) {
  const v = composer.getText();
  const start = composer.caret();
  const before = v.slice(0, start), after = v.slice(start);
  const text = (before && !/\s$/.test(before) ? " " : "") + name + (/^\s/.test(after) ? "" : " ");
  if ((before + text + after).length > 500) return;
  const pos = before.length + text.length;
  composer.setText(before + text + after, pos);
  if (!coarse) composer.focus();
}

$("emote-btn").addEventListener("click", () => ($("picker").hidden ? openPicker() : closePicker()));

// Rebuilding the grid (thousands of buttons) on every keystroke is slow on phones.
let pickerTimer = null;
$("emote-search").addEventListener("input", () => { clearTimeout(pickerTimer); pickerTimer = setTimeout(renderPicker, 120); });
$("emote-search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closePicker(); composer.focus(); }
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(pickerTimer);
    renderPicker(); // so Enter picks from what was just typed
    const first = $("picker-list").querySelector(".grid button");
    if (first) first.click();
  }
});
// Long-press (touch) or right-click an emote to favorite it.
$("picker-list").addEventListener("contextmenu", (e) => {
  const b = e.target.closest(".grid button");
  if (!b) return;
  e.preventDefault();
  toggleFavorite(b.dataset.name, b.dataset.url);
});

$("picker-list").addEventListener("click", (e) => {
  const b = e.target.closest(".grid button");
  if (!b) return;
  insertEmote(b.dataset.name);
  rememberEmote(b.dataset.name, b.dataset.url);
});

// ---------- Bits and channel points: hand off to Twitch ----------

// Twitch's API can't cheer or redeem channel points, and its chat embed doesn't offer them
// either, so this opens Twitch itself (signed in as you): the pop-out chat in a small window
// on desktop, the Twitch app on phones (falling back to the website if the app doesn't open).
const launchers = {
  // Opens blank first so the new page can't reach back to us through window.opener.
  window(url, name, features) {
    const w = window.open("", name, features);
    if (!w) return null;
    try { w.opener = null; } catch {}
    w.location.href = url;
    return w;
  },
  app(url) { location.href = url; },
};
let appFallbackMs = 2000;

function twitchLinks(login) {
  return {
    web: "https://www.twitch.tv/" + login,
    popout: "https://www.twitch.tv/popout/" + login + "/chat?popout=",
    app: "twitch://stream/" + login,
  };
}

function openOnTwitch(tab, touch = coarse) {
  const links = twitchLinks(tab.login);
  if (!touch) {
    // A small pop-out window; if the browser blocks it, a normal tab.
    if (!launchers.window(links.popout, "twitch-popout", "popup,width=420,height=720")) launchers.window(links.web, "_blank");
    return;
  }
  // Try the app. If this page is still in front shortly after (the app isn't installed, or
  // the browser didn't hand over), open the website instead.
  let left = false;
  const gone = () => { left = true; };
  const events = ["pagehide", "blur", "visibilitychange"];
  for (const ev of events) window.addEventListener(ev, gone, { once: true });
  launchers.app(links.app);
  setTimeout(() => {
    for (const ev of events) window.removeEventListener(ev, gone);
    if (left || document.hidden) return;
    if (!launchers.window(links.web, "_blank") && active) {
      // Blocked (not a direct tap any more): leave a link to tap.
      const li = el("li", "sys");
      const a = el("a", "link", links.web.replace("https://", ""));
      a.href = links.web;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      li.append("Couldn't open the Twitch app: ", a);
      append(active, li, false);
    }
  }, appFallbackMs);
}

$("twitch-btn").addEventListener("click", () => {
  if (!active) return;
  if (settings.bitsButton === "embed") openChatEmbed(active); else openOnTwitch(active);
});

// Experimental: Twitch's official chat embed in a window here. Twitch has said the embed
// doesn't offer Bits or channel points (old forum posts), and it only shows you signed in if
// the browser shares your twitch.tv login with it, so the window offers the real thing too.
// (The pop-out page itself can't be framed: it sends X-Frame-Options: SAMEORIGIN.)
function chatEmbedUrl(login) {
  const params = new URLSearchParams({ parent: location.hostname });
  if (!isLightTheme()) params.set("darkpopout", "");
  return "https://www.twitch.tv/embed/" + encodeURIComponent(login) + "/chat?" + params.toString().replace(/darkpopout=($|&)/, "darkpopout$1");
}

const embedFrames = new Map(); // channel login -> iframe, oldest first; kept loaded while minimized
const EMBED_KEEP = 3;           // each loaded chat uses memory and a connection, so keep only a few

/** Firefox walls off Twitch's login inside embedded frames; the fix is a per-site setting. */
const chatEmbedTip = (userAgent) => /Firefox\//.test(userAgent)
  ? " Firefox: if Twitch keeps asking you to sign in or allow storage, turn off Enhanced Tracking Protection for this site (shield icon in the address bar)."
  : "";

function openChatEmbed(tab) {
  const login = tab.login;
  let frame = embedFrames.get(login);
  if (frame) {
    embedFrames.delete(login); // move to the newest position
  } else {
    frame = document.createElement("iframe");
    frame.className = "chat-embed";
    frame.title = "Twitch chat for " + login;
    frame.src = chatEmbedUrl(login);
    $("embed-frames").appendChild(frame);
  }
  embedFrames.set(login, frame);
  while (embedFrames.size > EMBED_KEEP) dropChatEmbed(embedFrames.keys().next().value);
  for (const [l, f] of embedFrames) f.hidden = l !== login;
  $("embed-title").textContent = "Twitch chat: " + (tab.broadcaster ? tab.broadcaster.name : login);
  $("embed-go").textContent = coarse ? "Open the app" : "Open pop-out";
  $("embed-go").onclick = () => { hideChatEmbed(); openOnTwitch(tab); };
  $("embed-reload").onclick = () => { dropChatEmbed(login); openChatEmbed(tab); };
  show("embed-modal", true);
}

function hideChatEmbed() { show("embed-modal", false); }

/** Throws a loaded chat away (the channel's tab was closed, or it's the least recently used). */
function dropChatEmbed(login) {
  const frame = embedFrames.get(login);
  if (frame) frame.remove();
  embedFrames.delete(login);
}

$("embed-close").addEventListener("click", hideChatEmbed);
$("embed-modal").addEventListener("click", (e) => { if (e.target === $("embed-modal")) hideChatEmbed(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("embed-modal").hidden) hideChatEmbed(); });
// ---------- autocomplete ----------

let suggestions = [];
let suggestIndex = 0;
let suggestWord = null;        // { start, end } of the word being completed
let suggestStrong = false;     // Enter accepts (":"/"@" prefix or arrow-key choice); otherwise Enter sends

function currentWord() {
  const value = composer.getText();
  const pos = composer.caret();
  const before = value.slice(0, pos);
  const m = /(\S+)$/.exec(before);
  if (!m) return null;
  // Only complete when the cursor is at the end of the word.
  if (/^\S/.test(value.slice(pos))) return null;
  return { text: m[1], start: pos - m[1].length, end: pos };
}

function computeSuggestions(word) {
  if (!active) return [];
  if (word.startsWith("@")) {
    const q = word.slice(1).toLowerCase();
    const out = [];
    for (const [login, name] of [...active.chatters].reverse()) {
      if (!login.startsWith(q) && !name.toLowerCase().startsWith(q)) continue;
      const n = mentionName(login, name);
      if (!out.includes(n)) out.push(n);
      if (out.length >= 8) break;
    }
    return out.map((n) => ({ name: "@" + n, user: n }));
  }
  // ":kek" searches anywhere in the name; a bare word only completes prefixes, so normal
  // typing doesn't trigger the list on every word.
  const colon = word.startsWith(":");
  const q = word.replace(/^:/, "").toLowerCase();
  if (q.length < (colon ? 2 : 3)) return [];
  const prefix = [], contains = [];
  for (const e of allEmotes(active)) {
    const n = e.name.toLowerCase();
    if (n.startsWith(q)) { if (n !== q || colon) prefix.push(e); }
    else if (colon && n.includes(q)) contains.push(e);
  }
  const byLen = (a, b) => a.name.length - b.name.length;
  return [...prefix.sort(byLen), ...contains.sort(byLen)].slice(0, 8);
}

function updateSuggest() {
  const w = currentWord();
  suggestions = w ? computeSuggestions(w.text) : [];
  suggestWord = w;
  suggestStrong = !!w && /^[:@]/.test(w.text);
  suggestIndex = 0;
  renderSuggest();
}

function renderSuggest() {
  const box = $("suggest");
  if (!suggestions.length) { box.hidden = true; return; }
  closePicker();
  box.replaceChildren();
  suggestions.forEach((s, i) => {
    const row = el("div", "row" + (i === suggestIndex ? " hl" : ""));
    row.dataset.index = String(i);
    if (s.user) row.appendChild(el("span", "avatar", "@"));
    else row.appendChild(emoteImg(s.url, s.name, s.source));
    row.appendChild(el("span", null, s.user || s.name));
    row.appendChild(el("span", "src", s.user ? "chatter" : s.source));
    box.appendChild(row);
  });
  box.appendChild(el("div", "hint", coarse ? "Tap to insert" : (suggestStrong ? "Tab or Enter" : "Tab") + " to insert · ↑↓ to choose · Esc to close"));
  box.hidden = false;
  const hl = box.querySelector(".row.hl");
  if (hl) hl.scrollIntoView?.({ block: "nearest" });
}

function closeSuggest() {
  suggestions = [];
  show("suggest", false);
}

function acceptSuggestion(i) {
  const s = suggestions[i];
  const w = suggestWord;
  if (!s || !w) return;
  const v = composer.getText();
  const after = v.slice(w.end);
  const insert = s.name + (/^\s/.test(after) ? "" : " ");
  composer.setText(v.slice(0, w.start) + insert + after, w.start + insert.length);
  if (s.url) rememberEmote(s.name, s.url);
  closeSuggest();
  composer.focus();
}

/**
 * Typing a whole emote name finishes it: add the space that turns the text into the emote.
 * Not when a longer emote starts with the same letters (you may be typing KappaPride), not for
 * all-lowercase names (they're ordinary words: "pog" would split "poggers"), and only when
 * typing: deleting back to a name, or pasting one, leaves the text alone.
 */
function autoFinishEmote(e) {
  if (e.inputType !== "insertText" && e.inputType !== "insertCompositionText") return;
  const w = currentWord();
  if (!w || w.text.length < 3 || /^[:@]/.test(w.text) || /^[a-z]+$/.test(w.text)) return;
  const all = allEmotes(active);
  const match = all.find((x) => x.name === w.text);
  if (!match) return;
  const lower = w.text.toLowerCase();
  if (all.some((x) => x.name.length > w.text.length && x.name.toLowerCase().startsWith(lower))) return;
  const v = composer.getText();
  composer.setText(v.slice(0, w.end) + " " + v.slice(w.end), w.end + 1);
  autoSpaceAt = w.end + 1;
  rememberEmote(match.name, match.url);
  closeSuggest();
}

// Someone who types a space after the name anyway (out of habit) must not end up with two.
let autoSpaceAt = -1; // caret position right after the space we added, while nothing else was typed
$("message").addEventListener("beforeinput", (e) => {
  if (e.inputType === "insertText" && e.data === " " && autoSpaceAt >= 0 && composer.caret() === autoSpaceAt) {
    e.preventDefault();
    autoSpaceAt = -1;
  }
});
$("message").addEventListener("input", (e) => {
  autoSpaceAt = -1;
  updateSuggest();
  if (active) autoFinishEmote(e);
});
$("message").addEventListener("click", updateSuggest);
$("message").addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== $("message")) closeSuggest(); }, 150));
$("suggest").addEventListener("pointerdown", (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  e.preventDefault(); // keep focus (and the mobile keyboard) on the input
  acceptSuggestion(Number(row.dataset.index));
});

$("message").addEventListener("keydown", (e) => {
  const open = !$("suggest").hidden && suggestions.length;
  if (open) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      suggestIndex = (suggestIndex + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length;
      suggestStrong = true;
      renderSuggest();
      e.preventDefault();
      return;
    }
    if (e.key === "Tab" || (e.key === "Enter" && suggestStrong)) { acceptSuggestion(suggestIndex); e.preventDefault(); return; }
    if (e.key === "Enter") closeSuggest(); // fall through to sending
    if (e.key === "Escape") { closeSuggest(); e.preventDefault(); return; }
  } else if (e.key === "Tab" && !e.shiftKey) {
    // Tab-complete even below the 2-character popup threshold.
    const w = currentWord();
    if (w) {
      const q = w.text.replace(/^:/, "").toLowerCase();
      const hit = w.text.startsWith("@") ? computeSuggestions(w.text)[0] : allEmotes(active).find((x) => x.name.toLowerCase().startsWith(q));
      if (hit) { suggestions = [hit]; suggestWord = w; acceptSuggestion(0); e.preventDefault(); return; }
    }
  }
  if (e.key === "ArrowUp" && !composer.getText() && lastSent) { composer.setText(lastSent); e.preventDefault(); }
  // Enter sends (there are no multi-line chat messages).
  if (e.key === "Enter" && !e.defaultPrevented) { e.preventDefault(); if (!e.isComposing) $("send-form").requestSubmit(); }
  if (e.key === "Escape") { if (!$("picker").hidden) closePicker(); else setReply(null); }
});

document.addEventListener("pointerdown", (e) => {
  if (!$("picker").hidden && !e.target.closest("#picker, #emote-btn")) closePicker();
  if (!$("suggest").hidden && !e.target.closest("#suggest, #message")) closeSuggest();
});

// ---------- composer (message box) ----------

// A contenteditable box: plain text, except finished emote names (followed by a space)
// are shown as images. The text model is always the plain string, so what's sent is
// exactly what was typed. An emote stays real text in a <span> whose letters are hidden
// and whose background is the image. Phone keyboards predict the next word from the text
// before the caret, and an <img> would hide the emote name from them.
const composer = (() => {
  const box = $("message");
  const MAX = 500;
  let composing = false;
  let pendingCaret = null; // where the caret goes when the box next gets focus

  const plainOf = (node) => {
    let out = "";
    for (const n of node.childNodes) {
      if (n.nodeType === 3) out += n.data;
      else if (n.nodeName === "IMG") out += n.dataset.name || "";
      else if (n.nodeName !== "BR") out += plainOf(n);
    }
    return out;
  };
  const getText = () => plainOf(box).replace(/ /g, " ");

  function caret() {
    const sel = getSelection();
    if (!sel.rangeCount || !box.contains(sel.anchorNode)) return pendingCaret ?? getText().length;
    const r = sel.getRangeAt(0);
    const pre = document.createRange();
    pre.selectNodeContents(box);
    pre.setEnd(r.endContainer, r.endOffset);
    return plainOf(pre.cloneContents()).length;
  }

  function placeCaret(index) {
    const sel = getSelection();
    const r = document.createRange();
    for (const n of box.childNodes) {
      const len = n.nodeType === 3 ? n.data.length : (n.dataset && n.dataset.name ? n.dataset.name.length : 0);
      if (index <= len) {
        if (n.nodeType === 3) r.setStart(n, index);
        else r.setStartAfter(n);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        return;
      }
      index -= len;
    }
    r.selectNodeContents(box);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function lookup(word) {
    const e = emoteInChannel(active, word);
    return e ? e.url : null;
  }

  // Desired tokens: emote names followed by whitespace become images.
  function tokens(text) {
    const out = [];
    const re = /(\S+)(?=\s)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      const url = lookup(m[1]);
      if (!url) continue;
      if (m.index > last) out.push(["t", text.slice(last, m.index)]);
      out.push(["e", m[1], url]);
      last = m.index + m[1].length;
    }
    if (last < text.length) out.push(["t", text.slice(last)]);
    return out;
  }

  const norm = (t) => t.replace(/\u00a0/g, " ");
  /** Whether an existing node already shows the given token. */
  function same(node, [type, value]) {
    if (type === "t") return node.nodeType === 3 && norm(node.data) === value;
    return node.nodeType === 1 && node.classList.contains("ce-emote") && node.dataset.name === value && node.textContent === value;
  }

  const emoteWidths = new Map(); // url -> px width at the box's emote height
  function emoteNode(name, url) {
    const span = document.createElement("span");
    span.className = "ce-emote";
    span.dataset.name = name;
    span.title = name;
    span.textContent = name;
    span.style.backgroundImage = 'url("' + url.replace(/["\\]/g, encodeURIComponent) + '")';
    // Wide emotes (many 7TV ones) keep their shape once the image's size is known.
    const known = emoteWidths.get(url);
    if (known) span.style.width = known + "px";
    else {
      const probe = new Image();
      probe.onload = () => {
        if (!probe.naturalHeight) return;
        const w = Math.min(96, Math.round(24 * probe.naturalWidth / probe.naturalHeight));
        emoteWidths.set(url, w);
        span.style.width = w + "px";
      };
      probe.src = url;
    }
    return span;
  }

  /**
   * Brings the box in line with the text's tokens. Nodes that already match are left alone
   * and only the rest is rebuilt, so ordinary typing is never disturbed. Since emotes stay
   * text, the characters a phone keyboard sees don't change either.
   */
  function render(force) {
    let text = getText();
    let pos = caret();
    if (text.length > MAX) { text = text.slice(0, MAX); pos = Math.min(pos, MAX); force = true; }
    const want = tokens(text);
    const have = [...box.childNodes];
    let i = 0;
    if (!force) while (i < want.length && i < have.length && same(have[i], want[i])) i++;
    if (i === want.length && i === have.length) return;
    if (!text) { box.replaceChildren(); return; } // drop stray <br> so the placeholder shows
    for (const n of have.slice(i)) n.remove();
    box.append(...want.slice(i).map(([type, value, url]) => (type === "t" ? document.createTextNode(value) : emoteNode(value, url))));
    if (document.activeElement === box) placeCaret(pos);
  }

  function setText(text, pos) {
    box.replaceChildren(document.createTextNode(text.slice(0, MAX)));
    render(true);
    const at = Math.min(pos == null ? text.length : pos, MAX);
    // Don't grab focus (on phones that would pop the keyboard); remember the spot instead.
    if (document.activeElement === box) placeCaret(at);
    else pendingCaret = at;
  }

  box.addEventListener("compositionstart", () => { composing = true; });
  box.addEventListener("compositionend", () => { composing = false; render(); });
  box.addEventListener("input", (e) => { pendingCaret = null; if (!composing && !e.isComposing) render(); });
  // Plain text only, on one line.
  box.addEventListener("paste", (e) => {
    e.preventDefault();
    const t = (e.clipboardData.getData("text/plain") || "").replace(/\s*\n\s*/g, " ");
    const text = getText(), pos = caret();
    setText(text.slice(0, pos) + t + text.slice(pos), pos + t.length);
    updateSuggest();
  });
  box.addEventListener("drop", (e) => e.preventDefault());

  return {
    el: box,
    getText,
    setText,
    caret,
    refresh: () => render(true),
    focus: () => {
      const at = pendingCaret ?? caret();
      box.focus();
      placeCaret(at);
      pendingCaret = null;
    },
    setEnabled(on, placeholder) {
      box.contentEditable = on ? "true" : "false";
      box.setAttribute("aria-disabled", String(!on));
      box.dataset.placeholder = placeholder;
    },
  };
})();

// ---------- sending ----------

function setReply(r) {
  replyTo = r;
  show("replying", !!r);
  if (r) {
    $("replying-text").textContent = "Replying to @" + r.user + ": " + r.text;
    composer.focus();
  }
}
$("reply-cancel").addEventListener("click", () => setReply(null));

/**
 * Sends a chat message as you, through the Worker. Remembers the message id (and that a send
 * is in flight) so a message sent from here isn't mistaken for one sent from another app,
 * which would advance the color cycle a second time.
 */
async function sendChat(tab, message, replyId) {
  const pending = api("/api/chat/send", {
    broadcaster_id: tab.broadcaster.id,
    message,
    reply_parent_message_id: replyId,
  });
  inflightSends.add(pending);
  const r = await pending;
  inflightSends.delete(pending);
  if (r.ok && r.messageId) {
    sentIds.add(r.messageId);
    if (sentIds.size > 200) sentIds.delete(sentIds.values().next().value);
  }
  return r;
}

$("send-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = composer.getText().trim();
  const tab = active;
  // Enter calls requestSubmit(), which works even while the button is disabled.
  if (!text || !tab || !tab.broadcaster || sending) return;
  closeSuggest();
  if (runCommand(tab, text)) {
    lastSent = text;
    composer.setText("");
    return;
  }
  $("send").disabled = true;
  sending = true;
  show("send-error", false);
  const r = await sendChat(tab, text, replyTo ? replyTo.id : undefined);
  sending = false;
  updateComposer();
  if (r.ok) {
    lastSent = text;
    window.toolsSent?.(tab);
    if (composer.getText().trim() === text) composer.setText(""); // keep anything typed meanwhile
    setReply(null);
    closePicker();
    if (status && status.cycle && status.cycle.enabled) refreshStatus(); // show the new color now
  } else {
    $("send-error").textContent = r.error;
    show("send-error", true);
  }
  composer.focus();
});

// ---------- live status ----------

function compactCount(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
}

function since(iso) {
  const ms = Date.now() - Date.parse(iso);
  const d = Math.floor(ms / 86400000), h = Math.floor(ms / 3600000) % 24, m = Math.floor(ms / 60000) % 60;
  if (d >= 365) { const y = Math.floor(d / 365), mo = Math.floor((d % 365) / 30); return y + "y" + (mo ? " " + mo + "mo" : ""); }
  if (d >= 30) return Math.floor(d / 30) + "mo";
  if (d) return d + "d" + (h ? " " + h + "h" : "");
  return h ? h + "h " + m + "m" : m + "m";
}

let streamsTimer = null;
/** Many tabs join at once after a reconnect; look up their live status in one request. */
function refreshStreamsSoon() {
  clearTimeout(streamsTimer);
  streamsTimer = setTimeout(refreshStreams, 300);
}
async function refreshStreams() {
  clearTimeout(streamsTimer);
  streamsTimer = setTimeout(refreshStreams, 60000);
  const ids = [...tabs.values()].filter((t) => t.broadcaster).map((t) => t.broadcaster.id);
  if (!ids.length || document.hidden) return;
  const list = await api("/api/streams?ids=" + ids.join(","));
  if (!Array.isArray(list)) return; // a failed lookup says nothing about who's live: keep what we had
  const byId = new Map(list.map((st) => [st.user_id, st]));
  for (const t of tabs.values()) {
    if (!t.broadcaster) continue;
    const before = t.stream;
    t.stream = byId.get(t.broadcaster.id) || null;
    if (t.stream) { // a point per poll, for the viewer graph
      const samples = t.viewerSamples = t.viewerSamples && t.viewerSamples.startedAt === t.stream.started_at ? t.viewerSamples : Object.assign([], { startedAt: t.stream.started_at });
      samples.push([Date.now(), t.stream.viewer_count]);
      if (samples.length > 240) samples.shift();
    } else t.viewerSamples = null;
    if (settings.streamChanges !== false && before && t.stream) {
      if (before.title !== t.stream.title) sysLine(t, "Stream title changed: " + t.stream.title);
      if ((before.game_name || "") !== (t.stream.game_name || "")) sysLine(t, "Category changed: " + (before.game_name || "none") + " → " + (t.stream.game_name || "none"));
    }
    updateTabEl(t);
  }
  renderInfo();
  renderVideo();
}

// ---------- stream player ----------

// One Twitch player (official embed API) for the tab in view, shown while that channel is
// live. Switching tabs calls setChannel() instead of reloading, so once you unmute, sound
// stays on. Browsers block autoplay with sound until the page has had a tap/click; if the
// player reports that, fall back to muted autoplay so the stream still starts.
let player = null;
let playerChannel = null;
const videoBox = $("video"); // lives in the PiP window's document while that's open
let embedScript = null;

function loadEmbedScript() {
  embedScript = embedScript || new Promise((resolve, reject) => {
    const sc = document.createElement("script");
    sc.src = "https://player.twitch.tv/js/embed/v1.js";
    sc.onload = resolve;
    sc.onerror = () => { embedScript = null; reject(new Error("Couldn't load the Twitch player")); };
    document.head.appendChild(sc);
  });
  return embedScript;
}

function canPlaySound() {
  return !!(navigator.userActivation && navigator.userActivation.hasBeenActive);
}

async function renderVideo() {
  try { await renderVideoNow(); } finally { renderQuality(); window.toolsVideoChanged?.(); }
}

// ---------- pinned stream ----------

// The video normally follows the open tab. Pinning keeps one channel's stream playing while you
// switch tabs to chat elsewhere (the pinned channel needs to be live; if it isn't, the open tab's
// stream shows as usual). `pinnedLogin` is declared with the other state at the top.

function pinnedTab() {
  const t = pinnedLogin && tabs.get(pinnedLogin);
  return t || null;
}

/** The tab whose stream the video box shows. */
function videoTab() {
  const p = pinnedTab();
  return p && p.stream ? p : active;
}

function setPinned(login) {
  pinnedLogin = login;
  if (login) safeSet("pinnedVideo", login); else { try { localStorage.removeItem("pinnedVideo"); } catch {} }
  for (const t of tabs.values()) updateTabEl(t);
  renderVideo();
  syncChanged();
}

function renderPinBtn() {
  const btn = $("pin-btn");
  const p = pinnedTab();
  // Offered while a stream shows (so you can pin it), and always while something is pinned (so you can unpin).
  const show_ = !!(p || (settings.video && me && active && active.stream));
  btn.hidden = !show_;
  btn.setAttribute("aria-pressed", String(!!p));
  const name = p && p.broadcaster ? p.broadcaster.name : p ? p.login : "";
  btn.title = btn.ariaLabel = p
    ? "Pinned: " + name + "'s stream stays when you switch tabs" + (p.stream ? "" : " (offline right now, showing this tab's stream)") + ". Tap to unpin."
    : "Pin this stream: keep it playing when you switch tabs";
}

$("pin-btn").addEventListener("click", () => {
  if (pinnedTab()) setPinned(null);
  else if (active && active.stream) setPinned(active.login);
});

async function renderVideoNow() {
  const box = videoBox;
  const tab = videoTab();
  const want = !!(settings.video && me && tab && tab.stream);
  if (!want && pipWindow) pipWindow.close(); // returns the player here (see openPip)
  document.querySelector(".app").classList.toggle("with-video", want && !pipWindow);
  $("pip-btn").hidden = !(want && "documentPictureInPicture" in window);
  $("video-btn").setAttribute("aria-pressed", String(!!settings.video));
  $("video-btn").title = settings.video ? "Hide the stream" + (tab && !tab.stream ? " (offline right now)" : "") : "Show the stream";
  renderPinBtn();
  if (!want) {
    box.hidden = true;
    if (player) try { player.pause(); } catch {}
    if (native) native.video.pause();
    return;
  }
  const wasHidden = box.hidden;
  if (!pipWindow) box.hidden = false;
  const channel = tab.login;
  if (useNative()) {
    if (player) teardownEmbed();
    return renderNative(box, channel, wasHidden);
  }
  if (native) teardownNative();
  if (player) {
    // Only (re)start playback on a change, so a stream you paused stays paused.
    const changed = playerChannel !== channel;
    if (changed) { player.setChannel(channel); playerChannel = channel; }
    if (changed || wasHidden) try { player.play(); } catch {}
    return;
  }
  // Don't retry on every refresh (live status polls every minute); the panel has a Try again button.
  if (embedBlocked) { showEmbedBlocked(box); return; }
  try { await loadEmbedScript(); } catch { embedBlocked = true; if (videoTab() === tab && !box.hidden) showEmbedBlocked(box); return; }
  if (player || videoTab() !== tab || box.hidden) return;
  const host = el("div", "player-host");
  host.id = "player-host";
  box.replaceChildren(host);
  // Twitch's iframe only allows "autoplay; fullscreen". Add picture-in-picture so the
  // browser's own PiP (media controls, Android leaving a fullscreen video) is permitted.
  const setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (this.tagName === "IFRAME" && name === "allow" && !/picture-in-picture/.test(value)) value += "; picture-in-picture";
    return setAttr.call(this, name, value);
  };
  try {
    player = new Twitch.Player("player-host", {
      width: "100%",
      height: "100%",
      channel,
      parent: [location.hostname], // Twitch requires the embedding site's hostname
      autoplay: true,
      muted: !canPlaySound(),
    });
  } finally {
    Element.prototype.setAttribute = setAttr;
  }
  playerChannel = channel;
  player.addEventListener(Twitch.Player.PLAYBACK_BLOCKED, () => {
    player.setMuted(true);
    player.play();
  });
}

let embedBlocked = false; // the embed script failed to load (see showEmbedBlocked)

/**
 * The embed script didn't load: usually Firefox's Enhanced Tracking Protection (Strict) or an
 * ad blocker blocking player.twitch.tv. Say so in the video box instead of leaving it black.
 */
function showEmbedBlocked(box) {
  if (box.querySelector(".video-error")) return;
  const panel = el("div", "video-error");
  panel.append(
    el("div", "ve-title", "Twitch's player couldn't load"),
    el("div", "ve-text", "Something is blocking player.twitch.tv on this site, often Firefox's tracking protection or an ad blocker. " +
      "Allow it for this site and try again" + (canPlayBuiltInHls() ? ", or try the native player (unofficial)." : ".")),
  );
  const actions = el("div", "ve-actions");
  actions.append(btn("Try again", () => { embedBlocked = false; embedScript = null; box.replaceChildren(); renderVideo(); }, "small"));
  if (canPlayBuiltInHls()) actions.append(btn("Use native player", () => setPlayer("native"), "small ghost"));
  panel.appendChild(actions);
  box.replaceChildren(panel);
}

const canPlayBuiltInHls = () => !!document.createElement("video").canPlayType("application/vnd.apple.mpegurl");

function teardownEmbed() {
  player = null;
  playerChannel = null;
  videoBox.replaceChildren();
}

// ---------- native player (HLS), opt-in ----------

// Plays the stream's HLS playlist in a plain <video>, which (unlike the embed) may autoplay
// muted on phones. Twitch has no public API for playlists: this asks Twitch's internal
// GraphQL API for a playback token under the ID of Twitch's own website, as tools like
// Streamlink do. That is unofficial and can break at any time, so it's opt-in, and any
// failure falls back to the embed for the rest of the session. Everything happens in the
// browser: the token is tied to the IP that requested it, and the Worker never sees video.
const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
let native = null;          // { video, hls, channel }
let nativeGen = 0;          // bumps on every load/teardown, to drop stale async results
let nativeFailed = false;   // this session: fell back to the embed
let hlsScript = null;

const useNative = () => settings.player === "native" && !nativeFailed;

/** Twitch's playback token for a live channel (what usher needs to hand out a playlist). */
async function playbackToken(login) {
  const res = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: { "Client-Id": TWITCH_WEB_CLIENT_ID, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: 'query($login: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: "embed"}) { value signature } }',
      variables: { login },
    }),
  });
  if (!res.ok) throw new Error("playback token request failed (" + res.status + ")");
  const body = await res.json();
  const t = body.data && body.data.streamPlaybackAccessToken;
  if (!t || !t.value) throw new Error((body.errors && body.errors[0] && body.errors[0].message) || "no playback token");
  let info = {};
  try { info = JSON.parse(t.value); } catch {}
  if (info.authorization && info.authorization.forbidden) throw new Error("Twitch won't play this stream here (" + (info.authorization.reason || "forbidden") + ")");
  return { sig: t.signature, token: t.value };
}

/**
 * The master playlist address: the player picks a quality itself (adaptive). Audio-only is
 * deliberately not offered here, since an adaptive player might choose it on a slow connection.
 */
function usherUrl(login, tok) {
  const params = new URLSearchParams({
    sig: tok.sig, token: tok.token, allow_source: "true", fast_bwe: "true",
    p: String(Math.floor(Math.random() * 1e7)), player: "twitchweb", playlist_include_framerate: "true", supported_codecs: "avc1",
  });
  return "https://usher.ttvnw.net/api/channel/hls/" + encodeURIComponent(login) + ".m3u8?" + params;
}

async function hlsUrl(login) { return usherUrl(login, await playbackToken(login)); }

// ---------- native player: choosing the quality ----------

// A <video> using the browser's built-in HLS picks its own quality and web pages can't tell it
// otherwise. To choose one, we play that quality's own playlist address, which means reading the
// master playlist, and Twitch doesn't let pages read it (CORS), so the Worker relays that one
// small text file (src/usher.ts). The video itself never goes through the Worker.

/** The renditions a master playlist offers, best first ({ group, name, height, fps, bandwidth, url }). */
function parseMaster(text) {
  const attrs = (line) => {
    const out = {};
    for (const m of line.slice(line.indexOf(":") + 1).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2].replace(/^"|"$/g, "");
    return out;
  };
  const lines = text.split(/\r?\n/);
  const names = new Map(); // GROUP-ID -> display name, from the #EXT-X-MEDIA lines
  const list = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-MEDIA:")) {
      const a = attrs(lines[i]);
      if (a.TYPE === "VIDEO" && a["GROUP-ID"]) names.set(a["GROUP-ID"], a.NAME || a["GROUP-ID"]);
    } else if (lines[i].startsWith("#EXT-X-STREAM-INF:")) {
      const a = attrs(lines[i]);
      let url = "";
      for (let j = i + 1; j < lines.length; j++) if (lines[j] && !lines[j].startsWith("#")) { url = lines[j].trim(); i = j; break; }
      if (!/^https:\/\//.test(url)) continue;
      const group = a.VIDEO || "";
      list.push({
        group, name: names.get(group) || group || "Stream", url,
        height: Number((/x(\d+)$/.exec(a.RESOLUTION || "") || [])[1]) || 0,
        fps: Number(a["FRAME-RATE"]) || 0, bandwidth: Number(a.BANDWIDTH) || 0,
      });
    }
  }
  return list.sort((x, y) => y.bandwidth - x.bandwidth); // audio-only comes out last
}

/**
 * Which rendition to play for a saved choice: the exact one if this channel offers it, else the
 * best that's no taller (so "720p60" on a channel with only 480p gets 480p), else Auto (null).
 */
function pickVariant(list, pref) {
  if (!list.length || !pref || pref === "auto") return null;
  const exact = list.find((v) => v.group === pref);
  if (exact || pref === "audio_only") return exact || null;
  const want = pref === "chunked" ? Infinity : Number((/^(\d+)p/.exec(pref) || [])[1]) || 0;
  if (!want) return null;
  const video = list.filter((v) => v.group !== "audio_only");
  return video.find((v) => v.height <= want) || video[video.length - 1] || null;
}

const qualityText = (v) => (v.group === "audio_only" ? "Audio only" : v.name);
const qualityShort = (v) => (v.group === "audio_only" ? "Audio" : v.group === "chunked" ? "Source" : v.name);

/** Asks the Worker for the master playlist and parses it. Never throws: { list, error }. */
async function fetchVariants(login, tok) {
  const r = await api("/api/hls/master", { login, sig: tok.sig, token: tok.token });
  if (!r.ok || typeof r.playlist !== "string") return { list: [], error: r.error || "unknown error" };
  return { list: parseMaster(r.playlist), error: null };
}

/**
 * Everything needed to start the stream: a token, the master URL and the quality list. With Auto
 * the stream starts at once and the list arrives later (`variantsP`); a chosen quality needs the
 * list to know its address, so wait for it, but not for long.
 */
async function prepareStream(login) {
  const tok = await playbackToken(login);
  const master = usherUrl(login, tok);
  const variantsP = fetchVariants(login, tok);
  let first = null;
  if ((settings.nativeQuality || "auto") !== "auto") first = await Promise.race([variantsP, new Promise((r) => setTimeout(() => r(null), 4000))]);
  return { master, variants: first ? first.list : [], variantsP };
}

/** Records a prepared stream on the player and returns the address to play. */
function adoptStream(n, prep) {
  n.master = prep.master;
  n.variants = prep.variants;
  const v = pickVariant(prep.variants, settings.nativeQuality);
  n.activeGroup = v ? v.group : "auto";
  prep.variantsP.then(({ list, error }) => {
    if (native !== n || n.master !== prep.master) return; // the stream changed meanwhile
    n.variants = list;
    const pref = settings.nativeQuality || "auto";
    if (error && pref !== "auto" && active) sysLine(active, "Couldn't load the quality list (" + error + "); playing Auto.");
    // We started on Auto because the list was slow; now that it's here, honor the saved choice.
    const want = pickVariant(list, pref);
    if (want && n.activeGroup === "auto") { n.activeGroup = want.group; playUrl(n, want.url); }
    renderQuality();
  });
  renderQuality();
  return v ? v.url : prep.master;
}

/** Switches the rendition being played (the built-in player only). */
function playUrl(n, url) {
  if (n.way !== "built-in") return;
  n.video.src = url;
  n.progressAt = Date.now(); // loading a new playlist isn't a stall
  n.lastTime = 0;
  startNative(n.video);
}

/** The user's pick from the menu: remembered, and applied to this and later streams. */
function chooseQuality(group) {
  const n = native;
  if (!n) return;
  settings.nativeQuality = group;
  saveSettings();
  const v = pickVariant(n.variants, group);
  n.activeGroup = v ? v.group : "auto";
  playUrl(n, v ? v.url : n.master);
  hideQualityMenu();
  renderQuality();
}

function renderQuality() {
  const n = native, btn = $("quality-btn");
  const on = !!(n && n.variants && n.variants.length && !videoBox.hidden);
  btn.hidden = !on;
  if (!on) { hideQualityMenu(); return; }
  const cur = n.variants.find((v) => v.group === n.activeGroup);
  btn.textContent = cur ? qualityShort(cur) : "Auto";
}

function hideQualityMenu() {
  show("quality-menu", false);
  $("quality-btn").setAttribute("aria-expanded", "false");
}

function toggleQualityMenu() {
  const menu = $("quality-menu");
  if (!menu.hidden) { hideQualityMenu(); return; }
  const n = native;
  if (!n || !n.variants.length) return;
  menu.replaceChildren(el("div", "qm-title", "Quality"));
  const option = (group, label) => {
    const b = el("button", n.activeGroup === group ? "on" : null, label);
    b.type = "button";
    b.setAttribute("role", "menuitemradio");
    b.setAttribute("aria-checked", String(n.activeGroup === group));
    b.addEventListener("click", () => chooseQuality(group));
    menu.appendChild(b);
  };
  option("auto", "Auto");
  for (const v of n.variants) option(v.group, qualityText(v));
  menu.style.top = $("infobar").offsetHeight + "px";
  show("quality-menu", true);
  $("quality-btn").setAttribute("aria-expanded", "true");
}

$("quality-btn").addEventListener("click", toggleQualityMenu);
document.addEventListener("pointerdown", (e) => { if (!$("quality-menu").hidden && !e.target.closest("#quality-menu, #quality-btn")) hideQualityMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("quality-menu").hidden) hideQualityMenu(); });

function loadHlsJs() {
  hlsScript = hlsScript || new Promise((resolve, reject) => {
    const sc = document.createElement("script");
    sc.src = videoBox.dataset.hlsSrc;
    sc.onload = resolve;
    sc.onerror = () => { hlsScript = null; reject(new Error("couldn't load hls.js")); };
    document.head.appendChild(sc);
  });
  return hlsScript;
}

async function renderNative(box, channel, wasHidden) {
  if (native && native.channel === channel) {
    if (wasHidden) startNative(native.video); // a stream you paused stays paused otherwise
    return;
  }
  const gen = ++nativeGen;
  if (!native) {
    const video = document.createElement("video");
    video.className = "native-video";
    video.controls = true;     // the browser's own: fullscreen, PiP, volume
    video.playsInline = true;  // iPhone: don't force fullscreen
    video.autoplay = true;
    video.muted = !canPlaySound(); // muted autoplay is allowed everywhere, phones included
    // Remember what the video element did lately, to say in chat if playback stops.
    const note = (what) => {
      if (!native || native.video !== video) return;
      native.events.push(Math.round((Date.now() - native.startedAt) / 1000) + "s " + what);
      if (native.events.length > 8) native.events.shift();
    };
    for (const ev of ["waiting", "stalled", "pause", "emptied", "suspend", "abort"]) video.addEventListener(ev, () => note(ev));
    video.addEventListener("playing", () => { if (native && native.video === video) { native.hasPlayed = true; note("playing"); } });
    // A live stream shouldn't end; if it does, the playlist or token went stale.
    video.addEventListener("ended", () => { note("ended"); if (native && native.video === video) nativeRestart("the stream ended"); });
    video.addEventListener("error", () => {
      if (!native || native.video !== video || native.way !== "built-in") return;
      // An error after it was playing is usually a stale token: reconnect rather than give up.
      if (native.hasPlayed) nativeRestart(mediaErrorText(video.error)); else native.fail(mediaErrorText(video.error));
    });
    box.replaceChildren(video);
    native = {
      video, hls: null, channel: null, way: null, fail: () => {},
      events: [], hasPlayed: false, startedAt: Date.now(), progressAt: Date.now(), lastTime: 0,
      restarting: false, restartTimes: [], timer: setInterval(nativeWatchdog, 2000),
    };
  }
  native.channel = channel;
  Object.assign(native, { hasPlayed: false, events: [], restartTimes: [], progressAt: Date.now(), lastTime: 0, variants: [], master: null, activeGroup: "auto" });
  renderQuality();
  let prep;
  try { prep = await prepareStream(channel); } catch (err) { if (gen === nativeGen) nativeFail("token: " + err.message); return; }
  if (gen !== nativeGen || !native) return;
  playNext(gen, adoptStream(native, prep), playWays(), []);
}

/**
 * The browser's built-in HLS first: Twitch only lets twitch.tv read its playlists (CORS),
 * which blocks hls.js everywhere, but a plain <video src> works in some browsers (tested:
 * Firefox for Android yes, Chrome for Android no). hls.js is the last resort.
 */
function playWays() {
  const ways = [];
  if (native.video.canPlayType("application/vnd.apple.mpegurl")) ways.push("built-in");
  if (window.MediaSource || window.ManagedMediaSource) ways.push("hls.js");
  return ways;
}

const NATIVE_STALL_MS = 10000;  // playing but not advancing for this long = stopped
const NATIVE_MAX_RESTARTS = 3;  // within two minutes, then give up and use the embed

/** Every couple of seconds: has the picture stopped moving while it should be playing? */
function nativeWatchdog() {
  const n = native;
  if (!n || n.restarting || !n.way) return;
  const v = n.video, now = Date.now();
  // Not expected to move: backgrounded (browsers throttle), paused (by you or us), or not started.
  if (document.hidden || v.paused || v.ended || !n.hasPlayed) { n.progressAt = now; n.lastTime = v.currentTime; return; }
  if (v.currentTime !== n.lastTime) { n.lastTime = v.currentTime; n.progressAt = now; return; }
  if (now - n.progressAt >= NATIVE_STALL_MS) nativeRestart("no video for " + Math.round((now - n.progressAt) / 1000) + "s");
}

/** Gets a fresh playback token and playlist and starts over, saying so in chat. */
async function nativeRestart(reason) {
  const n = native;
  if (!n || n.restarting) return;
  const now = Date.now();
  n.restartTimes = n.restartTimes.filter((t) => now - t < 120000);
  if (n.restartTimes.length >= NATIVE_MAX_RESTARTS) { nativeFail("it kept stopping (" + reason + ")"); return; }
  n.restartTimes.push(now);
  n.restarting = true;
  const gen = ++nativeGen; // drops anything still pending from the old attempt
  if (active) {
    sysLine(active, "The native stream stopped (" + reason + "; " + Math.round((now - n.startedAt) / 60000) + " min after it loaded; " +
      (n.events.slice(-4).join(", ") || "no events") + "). Reconnecting…");
  }
  try {
    const prep = await prepareStream(n.channel);
    if (gen !== nativeGen || native !== n) return;
    n.progressAt = now;
    n.lastTime = n.video.currentTime;
    await playNext(gen, adoptStream(n, prep), playWays(), []);
  } catch (err) {
    if (gen === nativeGen && native === n) nativeFail("token: " + err.message);
  } finally {
    n.restarting = false;
  }
}

/** Tries each way to play in turn; when all fail, falls back to the embed with every reason. */
async function playNext(gen, url, ways, reasons) {
  if (gen !== nativeGen || !native) return;
  const way = ways[0];
  if (!way) { nativeFail(reasons.join("; ") || "this browser can't play HLS"); return; }
  stopMedia();
  let failed = false;
  native.way = way;
  native.startedAt = Date.now(); // for "N min after it loaded"
  native.fail = (reason) => {
    if (failed || gen !== nativeGen || !native) return;
    failed = true;
    playNext(gen, url, ways.slice(1), [...reasons, way + ": " + reason]);
  };
  const { video } = native;
  if (way === "built-in") {
    video.src = url;
    startNative(video);
    return;
  }
  try { await loadHlsJs(); } catch (err) { native && native.fail(err.message); return; }
  if (gen !== nativeGen || !native) return;
  if (!window.Hls || !Hls.isSupported()) { native.fail("not supported here"); return; }
  // No web worker: the page's CSP doesn't allow blob: scripts.
  const hls = new Hls({ enableWorker: false });
  native.hls = hls;
  hls.on(Hls.Events.ERROR, (_, data) => {
    if (!data.fatal || !native || native.hls !== hls) return;
    if (native.hasPlayed) nativeRestart(hlsErrorText(data)); else native.fail(hlsErrorText(data));
  });
  hls.loadSource(url);
  hls.attachMedia(video);
  startNative(video);
}

function stopMedia() {
  if (native.hls) { native.hls.destroy(); native.hls = null; }
  native.way = null;
  if (native.video.getAttribute("src")) {
    native.video.removeAttribute("src");
    native.video.load();
  }
}

function hlsErrorText(data) {
  const code = data.response && data.response.code;
  // Status 0 means the browser refused the response, usually missing CORS headers.
  const http = code === 0 ? " (blocked by the browser, likely CORS)" : code ? " (HTTP " + code + ")" : "";
  let host = "";
  try { host = data.url ? " loading " + new URL(data.url).host : ""; } catch {}
  return (data.details || data.type || "playback error") + http + host;
}

function mediaErrorText(err) {
  if (!err) return "unknown error";
  const kind = { 1: "aborted", 2: "network error", 3: "decode error", 4: "source not supported" }[err.code] || "error " + err.code;
  return kind + (err.message ? ": " + err.message : "");
}

function startNative(video) {
  // If sound isn't allowed yet, mute and try again so the stream still starts.
  video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
}

function teardownNative() {
  nativeGen++;
  if (!native) return;
  clearInterval(native.timer);
  stopMedia();
  native.video.remove();
  native = null;
  renderQuality();
}

function nativeFail(reason) {
  if (nativeFailed) return;
  nativeFailed = true;
  teardownNative();
  if (active) sysLine(active, "The native player couldn't play this stream (" + reason + "). Using Twitch's player until you reload.", "err");
  renderVideo();
}

/** Settings: switch players now. */
function setPlayer(kind) {
  settings.player = kind;
  saveSettings();
  nativeFailed = false;
  embedBlocked = false; // choosing a player is also a retry
  if (pipWindow) pipWindow.close();
  teardownNative();
  teardownEmbed();
  renderVideo();
}

// ---------- picture-in-picture (Document PiP: desktop Chrome/Edge) ----------

// Moves the whole player into an always-on-top window; closing it brings the player back.
// The iframe reloads when it changes documents, which for a live stream is a brief rebuffer.
let pipWindow = null;

async function openPip() {
  const box = videoBox;
  if (pipWindow || box.hidden) return;
  let w;
  try {
    w = await documentPictureInPicture.requestWindow({ width: 480, height: 270 });
  } catch (err) {
    if (active) sysLine(active, "Couldn't open picture-in-picture: " + err.message, "err");
    return;
  }
  pipWindow = w;
  // The PiP document is about:blank: use absolute stylesheet URLs, and size the player
  // inline so it fills the window even before (or without) the stylesheet.
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const l = w.document.createElement("link");
    l.rel = "stylesheet";
    l.href = link.href;
    w.document.head.appendChild(l);
  }
  const vp = w.document.createElement("meta");
  vp.name = "viewport";
  vp.content = "width=device-width, initial-scale=1";
  w.document.head.appendChild(vp);
  w.document.title = APP_TITLE;
  w.document.body.style.cssText = "margin:0;background:#000;overflow:hidden";
  box.classList.add("in-pip");
  box.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;min-height:0;max-height:none;aspect-ratio:auto";
  for (const n of box.querySelectorAll(".player-host, iframe, video")) n.style.cssText = "display:block;width:100%;height:100%;border:0;aspect-ratio:auto";
  w.document.body.appendChild(box);
  box.hidden = false;
  $("pip-btn").setAttribute("aria-pressed", "true");
  document.querySelector(".app").classList.remove("with-video");
  w.addEventListener("pagehide", () => {
    pipWindow = null;
    box.classList.remove("in-pip");
    box.style.cssText = "";
    for (const n of box.querySelectorAll(".player-host, iframe, video")) n.style.cssText = "";
    document.querySelector(".app").insertBefore(box, $("chat"));
    $("pip-btn").setAttribute("aria-pressed", "false");
    renderVideo();
  }, { once: true });
}

$("pip-btn").addEventListener("click", () => (pipWindow ? pipWindow.close() : openPip()));

$("video-btn").addEventListener("click", () => {
  settings.video = !settings.video;
  saveSettings();
  renderVideo();
});

// ---------- info bar: live status + chat modes ----------

function modeLabels(st) {
  if (!st) return [];
  const out = [];
  if (st.slow_mode) out.push("Slow " + (st.slow_mode_wait_time || 30) + "s");
  if (st.follower_mode) out.push(st.follower_mode_duration ? "Followers " + fmtMinutes(st.follower_mode_duration) : "Followers-only");
  if (st.subscriber_mode) out.push("Sub-only");
  if (st.emote_mode) out.push("Emote-only");
  if (st.unique_chat_mode) out.push("Unique");
  return out;
}

function fmtMinutes(m) {
  if (m % 43200 === 0) return m / 43200 + "mo";
  if (m % 10080 === 0) return m / 10080 + "w";
  if (m % 1440 === 0) return m / 1440 + "d";
  if (m % 60 === 0) return m / 60 + "h";
  return m + "m";
}

/** A stream title too long for its space scrolls back and forth (slowly) instead of being cut off. */
function fitTitle() {
  const t = document.querySelector("#live .title");
  if (!t) return;
  const inner = t.firstElementChild;
  t.classList.remove("scrolls");
  const over = inner.scrollWidth - t.clientWidth;
  if (over > 2) {
    t.style.setProperty("--shift", -over + "px");
    t.style.setProperty("--dur", Math.max(4, Math.round(over / 25)) + "s");
    t.classList.add("scrolls");
  }
}
new ResizeObserver(() => fitTitle()).observe($("live"));

/** "2h14" / "37m": how long the stream has been live, for the info bar. */
function uptimeLabel(iso) {
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
  return mins >= 60 ? Math.floor(mins / 60) + "h" + String(mins % 60).padStart(2, "0") : mins + "m";
}

function renderInfo() {
  const tab = active;
  if (!tab || !tab.broadcaster) { show("infobar", false); return; }
  show("infobar", true);
  const live = $("live");
  live.replaceChildren();
  const st = tab.stream;
  if (st) {
    live.className = "live on";
    const title = el("span", "title");
    title.appendChild(el("span", "title-text", (st.game_name ? st.game_name + " · " : "") + st.title));
    live.append(el("span", "dot"), el("b", null, compactCount(st.viewer_count)), el("span", "uptime", uptimeLabel(st.started_at)), title);
    live.title = st.title + "\n" + (st.game_name || "No category") + " · " + st.viewer_count.toLocaleString() + " viewers · live for " + since(st.started_at);
  } else {
    live.className = "live";
    live.textContent = "Offline";
    live.title = "";
  }
  $("modes").replaceChildren(...modeLabels(tab.settings).map((l) => el("span", "chip", l)));
  fitTitle();
  renderFollowBtn();
  window.toolsRenderInfo?.(tab);
}

// Twitch has no API to follow or unfollow (it was removed in 2023), so the button shows
// whether you follow the channel (from the followed list) and opens Twitch's page to change it.
let followHandoff = false;

function renderFollowBtn() {
  const tab = active;
  const btn = $("follow-btn");
  const known = tab && tab.broadcaster && me && tab.broadcaster.id !== me.userId && following && following.ok;
  btn.hidden = !known;
  if (!known) { if (tab && tab.broadcaster && me && !following) loadFollowing().then(renderFollowBtn); return; }
  const on = following.channels.some((c) => c.id === tab.broadcaster.id);
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(on));
  const name = tab.broadcaster.name;
  btn.title = btn.ariaLabel = on ? "You follow " + name + ". Open Twitch to unfollow." : "Follow " + name + " on Twitch";
}

$("follow-btn").addEventListener("click", () => {
  if (!active) return;
  followHandoff = true;
  launchers.window(twitchLinks(active.login).web, "_blank");
});

// Coming back from Twitch after following or unfollowing: refresh the status.
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !followHandoff) return;
  followHandoff = false;
  api("/api/following?fresh=1").then((r) => { if (r.ok) { following = r; followingAt = Date.now(); renderFollowBtn(); } });
});

// ---------- AutoMod queue (moderators) ----------

function renderHeld(tab, ev) {
  const li = el("li", "automod");
  li.dataset.automodId = ev.message_id;
  li.dataset.user = ev.user_id;
  li.dataset.login = ev.user_login || "";
  let why = "Held by AutoMod";
  if (ev.automod && ev.automod.category) why += " · " + ev.automod.category + " (level " + ev.automod.level + ")";
  else if (ev.blocked_term) why += " · blocked term";
  li.appendChild(el("div", "am-head", why));
  const body = el("div", "am-body");
  const name = nameNode({ chatter_user_id: ev.user_id, chatter_user_name: ev.user_name, color: "" });
  body.append(name, document.createTextNode(": "));
  renderFragments(tab, body, ev.message && ev.message.fragments, false);
  li.appendChild(body);
  const actions = el("div", "am-actions");
  const decide = async (allow) => {
    actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
    const r = await api("/api/chat/automod", { msg_id: ev.message_id, allow });
    if (!r.ok) {
      actions.querySelectorAll("button").forEach((b) => (b.disabled = false));
      sysLine(tab, "AutoMod action failed: " + r.error, "err");
    }
  };
  const allow = el("button", "allow small", "Allow");
  allow.type = "button";
  allow.addEventListener("click", () => decide(true));
  const deny = el("button", "deny small", "Deny");
  deny.type = "button";
  deny.addEventListener("click", () => decide(false));
  actions.append(allow, deny);
  li.appendChild(actions);
  append(tab, li, true);
  if (tab !== active) { tab.mentioned = true; updateTabEl(tab); }
}

function resolveHeld(tab, ev) {
  const li = tab.list.querySelector('.automod[data-automod-id="' + CSS.escape(ev.message_id) + '"]');
  if (!li) return;
  const by = ev.moderator_user_name ? " by " + ev.moderator_user_name : "";
  const label = { approved: "Allowed" + by, denied: "Denied" + by, expired: "Expired (no decision)" }[ev.status] || ev.status;
  li.classList.add("resolved");
  li.querySelector(".am-actions").replaceChildren(el("span", null, label));
}

// ---------- clips and VODs ----------

// A channel's clips and past broadcasts (public data, via the Worker), played in Twitch's own
// embeds or opened on Twitch, plus creating a clip of the live stream (needs the clips:edit
// permission). Clip creation is asynchronous on Twitch's side, so we poll for the new clip.

const BROWSE_MODES = [["clips", "Clips"], ["archive", "Past broadcasts"], ["highlight", "Highlights"], ["upload", "Uploads"], ["schedule", "Schedule"]];
const CLIP_PERIODS = [["all", "All time"], ["month", "This month"], ["week", "This week"], ["day", "Today"]];
const CLIP_SECONDS = [15, 30, 60];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let clipPollMs = 3000;
let clipping = false;
let browse = null; // the open window: { tab, mode, period, sort, items, cursor, done, loading, error, req, player, scroll, clip }

const hasScope = (scope) => !!(status && status.twitch && !(status.twitch.missingOptionalScopes || []).includes(scope));

/** Opens the window for the active channel, or (mine) for the clips you made through Yappa. */
function openBrowse(opts = {}) {
  const tab = opts.mine ? null : active;
  if (!opts.mine && (!tab || !tab.broadcaster)) return;
  browse = { tab, mine: !!opts.mine, mode: "clips", period: "all", sort: "time", items: [], cursor: null, done: false, loading: false, error: null, req: 0, player: null, scroll: 0, clip: null };
  show("browse-modal", true);
  renderBrowse();
  loadBrowse(true);
}

function closeBrowse() {
  show("browse-modal", false);
  $("browse-body").replaceChildren(); // also stops a playing embed
  browse = null;
}

/** Loads the first page (reset) or the next one for the current tab and filters. */
async function loadBrowse(reset) {
  const b = browse;
  if (!b) return;
  if (!reset && (b.loading || b.done)) return;
  if (reset) { b.items = []; b.cursor = null; b.done = false; }
  b.error = null;
  b.loading = true;
  const req = ++b.req;
  renderBrowse();
  const q = new URLSearchParams();
  let path;
  if (b.mine) {
    path = "/api/my/clips";
  } else if (b.mode === "schedule") {
    path = "/api/schedule";
    q.set("broadcaster_id", b.tab.broadcaster.id);
  } else if (b.mode === "clips") {
    path = "/api/channel/clips";
    q.set("broadcaster_id", b.tab.broadcaster.id);
    q.set("period", b.period);
  } else {
    path = "/api/channel/videos";
    q.set("user_id", b.tab.broadcaster.id);
    q.set("type", b.mode);
    q.set("sort", b.sort);
  }
  if (b.cursor) q.set("after", b.cursor);
  const kind = b.mine || b.mode === "clips" ? "clip" : b.mode === "schedule" ? "segment" : "video";
  const r = await api(path + "?" + q);
  if (browse !== b || b.req !== req) return; // closed, or a newer filter owns the list now
  b.loading = false;
  const list = kind === "clip" ? r.clips : kind === "segment" ? r.segments : r.videos;
  if (!r.ok || !Array.isArray(list)) b.error = r.error || "Couldn't load them.";
  else {
    b.items.push(...list.map((x) => ({ ...x, kind })));
    b.cursor = r.cursor || null;
    b.done = !r.cursor;
  }
  renderBrowse();
}

const embedParams = (extra) => new URLSearchParams({ ...extra, parent: location.hostname, autoplay: "true" });
const clipEmbedUrl = (id) => "https://clips.twitch.tv/embed?" + embedParams({ clip: id });
const videoEmbedUrl = (id) => "https://player.twitch.tv/?" + embedParams({ video: "v" + id });

function browseSubline(item) {
  const bits = [compactCount(item.views) + " views", since(item.createdAt) + " ago"];
  if (item.kind === "clip") {
    if (item.game) bits.push(item.game);
    bits.push("by " + item.creator);
  }
  return bits.join(" · ");
}

/** Shares a clip or VOD link: the phone's share sheet if there is one, else copies it. */
async function shareItem(item, button) {
  const data = { title: item.title || "Twitch", text: item.title || "", url: item.url };
  if (navigator.share) {
    try { await navigator.share(data); return; } catch (err) {
      if (err && err.name === "AbortError") return; // closed the share sheet: nothing to report
      // Anything else (some Android browsers never finish a share that went to another app and
      // then refuse every later one with InvalidStateError) falls back to copying the link.
    }
  }
  const label = button.dataset.label || (button.dataset.label = button.textContent);
  let said;
  try { await navigator.clipboard.writeText(item.url); said = "Copied!"; } catch { said = "Couldn't copy"; }
  button.textContent = said;
  clearTimeout(button.labelTimer);
  button.labelTimer = setTimeout(() => { button.textContent = label; }, 1500);
}

/** One upcoming (or canceled) stream from a channel's schedule. */
function scheduleRow(item) {
  const row = el("div", "brow sched" + (item.canceled ? " canceled" : ""));
  const when = new Date(item.start);
  const meta = el("div", "bmeta");
  meta.append(
    el("span", "bt", item.title || "Stream"),
    el("span", "bs", when.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + (item.category ? " · " + item.category : "") + (item.recurring ? " · weekly" : "") + (item.canceled ? " · canceled" : "")),
  );
  row.appendChild(meta);
  return row;
}

function browseCard(b, item) {
  if (item.kind === "segment") return scheduleRow(item);
  const row = el("div", "brow" + (item.fresh ? " fresh" : ""));
  const card = el("button", "bcard");
  card.type = "button";
  const thumb = el("span", "bthumb");
  if (item.thumbnail) {
    const img = document.createElement("img");
    img.src = item.thumbnail;
    img.alt = "";
    img.loading = "lazy";
    thumb.appendChild(img);
  }
  const secs = item.kind === "clip" ? item.duration : item.seconds;
  if (secs) thumb.appendChild(el("span", "dur", fmtDuration(secs)));
  const meta = el("span", "bmeta");
  meta.append(el("span", "bt", item.title || "(untitled)"), el("span", "bs", browseSubline(item)));
  card.append(thumb, meta);
  card.addEventListener("click", () => { b.scroll = $("browse-modal").querySelector(".sheet").scrollTop; b.player = item; renderBrowse(); });
  const share = btn("Share", () => shareItem(item, share), "ghost small");
  share.classList.add("bshare");
  share.setAttribute("aria-label", "Share " + (item.title || "this"));
  row.append(card, share);
  return row;
}

function dropdown(options, value, onChange) {
  const sel = document.createElement("select");
  for (const [v, label] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    o.selected = v === value;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

function renderPlayer(b) {
  const item = b.player;
  const frame = document.createElement("iframe");
  frame.className = "browse-player";
  frame.title = item.title || "Twitch video";
  frame.allow = "autoplay; fullscreen";
  frame.allowFullscreen = true;
  frame.src = item.kind === "clip" ? clipEmbedUrl(item.id) : videoEmbedUrl(item.id);
  const open = el("a", "btn small", "Open on Twitch");
  open.href = item.url;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  const actions = el("div", "browse-actions");
  const share = btn("Share", () => shareItem(item, share), "small");
  actions.append(
    btn("← Back", () => { b.player = null; renderBrowse(); $("browse-modal").querySelector(".sheet").scrollTop = b.scroll; }, "small"),
    share,
    open,
    btn("Put link in chat box", () => { closeBrowse(); insertEmote(item.url); }, "small"),
  );
  return [frame, el("div", "ptitle", item.title || "(untitled)"), el("div", "psub", browseSubline(item)), actions];
}

/** The "clip the live stream" controls: shown above the list when the channel is live. */
function clipControls(b) {
  const box = el("div", "clipper");
  box.appendChild(el("div", "ch", "Create a clip"));
  if (!b.tab.stream) {
    box.appendChild(el("div", "state", "Clips come from the live stream, so this works while #" + b.tab.broadcaster.name + " is live."));
    return box;
  }
  if (!hasScope("clips:edit")) {
    const a = el("a", null, "Reconnect Twitch");
    a.href = "/auth/login";
    const note = el("div", "state");
    note.append(a, " to let Yappa create clips for you (one-time permission).");
    box.appendChild(note);
    return box;
  }
  const title = document.createElement("input");
  title.type = "text";
  title.placeholder = defaultClipTitle(b.tab) ? "Title (blank: the stream's title)" : "Title (optional)";
  title.maxLength = 100;
  title.id = "clip-title";
  title.setAttribute("aria-label", "Clip title");
  title.value = b.clipTitle || "";
  title.addEventListener("input", () => { b.clipTitle = title.value; });
  const lens = el("div", "lens");
  const busy = b.clip && (b.clip.state === "creating" || b.clip.state === "waiting");
  for (const s of CLIP_SECONDS) {
    const bt = btn("Clip last " + s + "s", () => createClip(b.tab, s, title.value.trim()), "small");
    bt.dataset.seconds = String(s);
    bt.disabled = !!busy;
    lens.appendChild(bt);
  }
  const post = document.createElement("input");
  post.type = "checkbox";
  post.checked = !!settings.postClips;
  post.id = "clip-post";
  post.addEventListener("change", () => { settings.postClips = post.checked; saveSettings(); });
  const postLabel = el("label", "clip-post");
  postLabel.append(post, " Post the link in chat when it's ready");
  box.append(title, lens, postLabel);
  if (b.clip) box.appendChild(el("div", "state " + (b.clip.state === "error" ? "err" : b.clip.state === "done" ? "ok" : ""), b.clip.text));
  return box;
}

function renderBrowse() {
  const b = browse;
  if (!b) return;
  const sheet = $("browse-modal").querySelector(".sheet");
  const scroll = sheet.scrollTop;
  $("browse-title").textContent = b.mine ? "Your clips" : "Clips & VODs: " + b.tab.broadcaster.name;
  const body = $("browse-body");
  if (b.player) { body.replaceChildren(...renderPlayer(b)); sheet.scrollTop = 0; return; }

  const tabs = el("div", "browse-tabs seg");
  for (const [mode, label] of BROWSE_MODES) {
    const t = btn(label, () => { if (b.mode !== mode) { b.mode = mode; loadBrowse(true); } }, "ghost small");
    if (b.mode === mode) t.classList.add("on");
    tabs.appendChild(t);
  }
  const filter = el("div", "browse-filter");
  if (b.mode === "schedule") {
    filter.append("Upcoming streams, in your time zone");
  } else if (b.mode === "clips") {
    filter.append("Most viewed from", dropdown(CLIP_PERIODS, b.period, (v) => { b.period = v; loadBrowse(true); }));
  } else {
    filter.append("Sort", dropdown([["time", "Newest"], ["views", "Most viewed"]], b.sort, (v) => { b.sort = v; loadBrowse(true); }));
  }
  const parts = b.mine
    ? [el("div", "browse-note", "Clips you made with Yappa, newest first. Twitch doesn't let apps list clips made elsewhere, so clips you made on Twitch itself aren't here.")]
    : [clipControls(b), tabs, filter];
  for (const item of b.items) parts.push(browseCard(b, item));
  if (b.loading) parts.push(el("div", "browse-note", "Loading…"));
  else if (b.error) {
    const note = el("div", "browse-note", b.error + " ");
    note.appendChild(btn("Try again", () => loadBrowse(!b.items.length), "small"));
    parts.push(note);
  } else if (!b.items.length) parts.push(el("div", "browse-note", b.mine ? "You haven't made any clips with Yappa yet." : b.mode === "schedule" ? "No streams scheduled." : "Nothing here yet."));
  else if (!b.done) {
    const more = btn("Load more", () => loadBrowse(false), "ghost small");
    more.classList.add("browse-more");
    parts.push(more);
  }
  body.replaceChildren(...parts);
  sheet.scrollTop = scroll;
}

/** Asks Twitch for a clip of the last stretch of the live stream, then waits for it to appear. */
/** What a clip gets named when you give no title: the stream's current title (Twitch allows 100 characters). */
function defaultClipTitle(tab) {
  const t = tab && tab.stream && tab.stream.title;
  return t ? Array.from(t.replace(/\s+/g, " ").trim()).slice(0, 100).join("") : "";
}

async function createClip(tab, seconds, title) {
  if (clipping) return;
  title = title || defaultClipTitle(tab);
  clipping = true;
  const state = (s, text) => { if (browse && browse.tab === tab) { browse.clip = { state: s, text }; renderBrowse(); } };
  state("creating", "Creating a " + seconds + "-second clip…");
  const r = await api("/api/clips/create", { broadcaster_id: tab.broadcaster.id, duration: seconds, title: title || undefined });
  if (!r.ok) {
    clipping = false;
    const why = r.needsScope ? "Reconnect Twitch to allow clipping." : r.error;
    state("error", why);
    if (!browse) sysLine(tab, "Couldn't create the clip: " + why, "err");
    return;
  }
  state("waiting", "Twitch is publishing your clip…");
  // Twitch says to treat a clip that hasn't shown up after about a minute as failed.
  let clip = null;
  for (let i = 0; i < 20 && !clip; i++) {
    await sleep(i === 0 ? Math.min(2000, clipPollMs) : clipPollMs);
    const g = await api("/api/chat/clip?id=" + encodeURIComponent(r.id));
    if (g.ok && g.clip) clip = g.clip;
  }
  clipping = false;
  if (!clip) {
    state("error", "Your clip didn't show up. Twitch may still be processing it, or it failed.");
    sysLine(tab, "The clip didn't show up on Twitch. It may still be processing, or it failed.", "err");
    return;
  }
  clipCache.set(clip.id, Promise.resolve(clip));
  // Post the link to the channel's chat, if that's switched on. Only now, so the link works when it appears.
  let posted = null; // null = not asked to, true = sent, string = why it wasn't
  if (settings.postClips) {
    const sent = await sendChat(tab, clip.url);
    posted = sent.ok ? true : sent.error || "unknown error";
    if (sent.ok && status && status.cycle && status.cycle.enabled) refreshStatus();
  }
  state(posted === null || posted === true ? "done" : "error",
    posted === true ? "Clip created, and its link is posted in chat." : posted === null ? "Clip created!" : "Clip created, but its link wasn't posted: " + posted);
  announceClip(tab, clip, r.editUrl, posted);
  if (browse && browse.tab === tab) {
    if (browse.mode === "clips") browse.items.unshift({ ...clip, kind: "clip", fresh: true });
    renderBrowse();
  }
}

/** Puts the new clip in the chat (so it isn't lost if the window was closed), with what you'd do next. */
function announceClip(tab, clip, editUrl, posted) {
  const li = el("li", "notice clip-made");
  li.appendChild(el("div", "sysmsg", "Clip created" + (posted === true ? " and posted in chat" : "")));
  // The posted message gets its own clip card in chat, so skip a second copy of it here.
  if (posted !== true) li.appendChild(clipCardEl(clip));
  if (typeof posted === "string") li.appendChild(el("div", "sys err", "Couldn't post the link in chat: " + posted));
  const row = el("div", "raid-actions");
  if (editUrl) {
    const edit = el("a", "btn small", "Edit on Twitch");
    edit.href = editUrl;
    edit.target = "_blank";
    edit.rel = "noopener noreferrer";
    row.appendChild(edit);
  }
  row.appendChild(btn("Put link in chat box", () => insertEmote(clip.url), "small"));
  const share = btn("Share", () => shareItem(clip, share), "small ghost");
  row.appendChild(share);
  li.appendChild(row);
  append(tab, li, false);
}

$("clips-btn").addEventListener("click", openBrowse);
$("browse-close").addEventListener("click", closeBrowse);
$("browse-modal").addEventListener("click", (e) => { if (e.target === $("browse-modal")) closeBrowse(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("browse-modal").hidden) closeBrowse(); });

// ---------- search / filter ----------

let filterText = "";

function filterNode(node) {
  if (!filterText) { node.classList.remove("filtered"); return; }
  const from = /^from:@?(\S+)\s*(.*)$/i.exec(filterText);
  const login = (node.dataset && node.dataset.login) || "";
  const text = node.textContent.toLowerCase();
  let ok;
  if (from) ok = login.startsWith(from[1].toLowerCase()) && (!from[2] || text.includes(from[2].toLowerCase()));
  else ok = text.includes(filterText.toLowerCase());
  node.classList.toggle("filtered", !ok);
}

function applyFilter() {
  // Only the visible list: another tab re-filters itself when it's activated.
  if (!active || !filterText) {
    if (active) for (const n of active.list.children) n.classList.remove("filtered");
    $("search-count").textContent = "";
    return;
  }
  let shown = 0;
  for (const n of active.list.children) { filterNode(n); if (!n.classList.contains("filtered")) shown++; }
  $("search-count").textContent = shown + " match" + (shown === 1 ? "" : "es");
  scrollToBottom(active);
}

$("search-btn").addEventListener("click", () => {
  const bar = $("searchbar");
  bar.hidden = !bar.hidden;
  if (!bar.hidden) $("search").focus();
  else { $("search").value = ""; filterText = ""; applyFilter(); }
});
$("search").addEventListener("input", () => { filterText = $("search").value.trim(); applyFilter(); });
$("search").addEventListener("keydown", (e) => { if (e.key === "Escape") $("search-close").click(); });
$("search-close").addEventListener("click", () => { $("search").value = ""; filterText = ""; applyFilter(); show("searchbar", false); });

// ---------- sheet (user cards, settings) ----------

function openSheet(...children) {
  $("sheet-body").replaceChildren(...children);
  show("sheet", true);
}
function closeSheet() { show("sheet", false); $("sheet-body").replaceChildren(); }
$("sheet-close").addEventListener("click", closeSheet);
$("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); });

function btn(label, onClick, cls) {
  const b = el("button", cls || "ghost", label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

// ---------- user cards ----------

const TIMEOUTS = [["1m", 60], ["10m", 600], ["1h", 3600], ["1d", 86400]];

/** What a badge means, in words. Twitch's own description is usually just its title, so the common ones are spelled out. */
function badgeMeaning(tab, setId, id, info) {
  const chan = tab.broadcaster ? tab.broadcaster.name : tab.login;
  const n = Number(id);
  const count = (x) => Number.isFinite(x) ? x.toLocaleString() : id;
  switch (setId) {
    case "broadcaster": return "The owner of this channel.";
    case "moderator": return "Moderates this chat: can delete messages and time out or ban people.";
    case "lead_moderator": return "A lead moderator: moderates this chat and can manage its other moderators.";
    case "vip": return "A VIP: someone the streamer picked to recognise.";
    case "staff": return "Works at Twitch.";
    case "admin": return "A Twitch administrator.";
    case "global_mod": return "A Twitch global moderator: moderates across Twitch.";
    case "partner": return "A verified Twitch Partner.";
    case "turbo": return "Has Twitch Turbo (an ad-free subscription).";
    case "premium": return "Has Prime Gaming, Twitch's perk with Amazon Prime.";
    case "founder": return "One of the first people to subscribe to " + chan + " (a Founder).";
    case "subscriber": {
      const tier = n >= 1000 ? Math.floor(n / 1000) : 1, months = n >= 1000 ? n % 1000 : n;
      return "Subscribed to " + chan + " (Tier " + tier + "). The badge shows " + (months ? months + " month" + (months === 1 ? "" : "s") : "a new subscriber") + " of subscription.";
    }
    case "bits": return "Has cheered " + count(n) + " Bits in " + chan + "'s chat in total.";
    case "bits-leader": return "On the Bits leaderboard for " + chan + ": rank " + id + ".";
    case "sub-gifter": return "Has gifted " + count(n) + " subscription" + (n === 1 ? "" : "s") + " in " + chan + "'s channel.";
    case "sub-gift-leader": return "On the gifted-subs leaderboard for " + chan + ": rank " + id + ".";
    case "hype-train": return "Took part in a Hype Train in this channel.";
    case "predictions": return "Took part in a Channel Points Prediction in this channel.";
    default: {
      const d = info && info.description && info.description !== info.title ? info.description : "";
      return d || "";
    }
  }
}

function badgeRows(tab, badges) {
  const rows = [];
  for (const b of badges) {
    const info = tab.badges[b.set_id + "/" + b.id];
    const row = el("div", "card-badge");
    if (info) {
      const img = el("img", "badge");
      img.src = info.url;
      img.alt = "";
      row.appendChild(img);
    }
    const text = el("div");
    text.appendChild(el("div", "cb-title", info ? info.title : b.set_id.replace(/[-_]+/g, " ")));
    const meaning = badgeMeaning(tab, b.set_id, b.id, info);
    if (meaning) text.appendChild(el("div", "hint", meaning));
    row.appendChild(text);
    rows.push(row);
  }
  return rows;
}

async function openUserCard(tab, u) {
  const head = el("div", "card-head");
  const avatar = document.createElement("img");
  avatar.alt = "";
  const names = el("div");
  const nm = el("div", "card-name", u.name);
  nm.style.color = u.color || "";
  names.append(nm, el("div", "hint", "@" + (u.login || u.name.toLowerCase())));
  head.append(avatar, names);

  const meta = el("div", "card-meta", "Loading…");
  const desc = el("div", "card-desc");

  const actions = el("div", "card-actions");
  actions.appendChild(btn("@ Mention", () => { closeSheet(); insertEmote("@" + mentionName(u.login, u.name)); }));
  const hidden = isHidden(u.id);
  actions.appendChild(btn(hidden ? "Unignore" : "Ignore", () => { setHidden(u, !hidden); closeSheet(); }));
  const login = u.login || u.name;
  const hl = userRule(login);
  actions.appendChild(btn(hl ? "Stop highlighting" : "Highlight", () => {
    if (hl) settings.rules = settings.rules.filter((r) => r !== hl);
    else settings.rules.push({ phrase: "", user: normLogin(login) });
    saveSettings();
    closeSheet();
    if (active) sysLine(active, (hl ? "No longer highlighting " : "Highlighting ") + u.name + ".");
  }));
  const isMe = me && u.id === me.userId;
  const isBroadcaster = tab.broadcaster && u.id === tab.broadcaster.id;
  if (tab.isMod && !isMe && !isBroadcaster) {
    for (const [label, secs] of TIMEOUTS) {
      actions.appendChild(btn("Timeout " + label, () => { modAction(tab, { action: "timeout", user_id: u.id, login: u.login, duration: secs }); closeSheet(); }));
    }
    actions.appendChild(btn("Unban", () => { modAction(tab, { action: "unban", user_id: u.id, login: u.login }); closeSheet(); }));
    actions.appendChild(btn("Ban", () => {
      if (confirm("Ban " + u.name + " from #" + tab.broadcaster.name + "?")) { modAction(tab, { action: "ban", user_id: u.id, login: u.login }); closeSheet(); }
    }, "stop"));
  }

  for (const b of window.toolsUserCardActions?.(tab, u) || []) actions.appendChild(b);

  // Their recent messages in this tab.
  const msgs = el("ul", "card-msgs");
  const theirs = [...tab.list.querySelectorAll('.msg[data-user="' + CSS.escape(u.id) + '"]')].slice(-20).reverse();
  for (const li of theirs) {
    const row = el("li");
    const time = li.querySelector(".time");
    row.appendChild(el("span", "time", time ? time.textContent : ""));
    const body = li.querySelector(".body");
    if (body) row.appendChild(body.cloneNode(true));
    if (li.classList.contains("deleted")) row.appendChild(el("span", "hint", " (deleted)"));
    msgs.appendChild(row);
  }
  const badgeBox = (u.badges || []).length ? el("div", "card-badges") : null;
  if (badgeBox) badgeBox.append(el("h3", null, "Badges"), ...badgeRows(tab, u.badges));
  openSheet(head, meta, ...(badgeBox ? [badgeBox] : []), desc, actions, el("h3", null, "Recent messages here (" + theirs.length + ")"), theirs.length ? msgs : el("div", "hint", "None in this session."));

  const r = await api("/api/chat/user?broadcaster_id=" + encodeURIComponent(tab.broadcaster.id) + "&user_id=" + encodeURIComponent(u.id));
  if (!r.ok) { meta.textContent = r.error; return; }
  avatar.src = r.user.profile_image_url;
  meta.replaceChildren(el("div", null, "Account created " + new Date(r.user.created_at).toLocaleDateString() + " (" + since(r.user.created_at) + " ago)"));
  if (r.followedAt) meta.appendChild(el("div", null, "Following since " + new Date(r.followedAt).toLocaleDateString() + " (" + since(r.followedAt) + ")"));
  else if (r.followedAt === null) meta.appendChild(el("div", null, "Not following"));
  if (r.user.broadcaster_type) meta.appendChild(el("div", null, r.user.broadcaster_type[0].toUpperCase() + r.user.broadcaster_type.slice(1)));
  desc.textContent = r.user.description || "";
}

// ---------- hidden users ----------

const blockedIds = new Set();   // your Twitch block list (filled by tools.js)
function isHidden(id) { return settings.hidden.some((h) => h.id === id) || (settings.syncBlocks !== false && blockedIds.has(id)); }

function setHidden(u, hide) {
  settings.hidden = settings.hidden.filter((h) => h.id !== u.id);
  if (hide) settings.hidden.push({ id: u.id, name: u.name });
  saveSettings();
  document.querySelectorAll('.msg[data-user="' + CSS.escape(u.id) + '"]').forEach((n) => n.classList.toggle("ignored", hide));
  if (active) sysLine(active, (hide ? "Ignoring " : "No longer ignoring ") + u.name + ".");
}

// ---------- highlights, notifications, sound ----------

const phraseRegexes = new Map(); // phrase -> RegExp (checked for every message, so compile once)

/** Whole-word/phrase, case-insensitive. */
function containsPhrase(text, phrase) {
  let re = phraseRegexes.get(phrase);
  if (!re) {
    const esc = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    re = new RegExp("(^|[^\\p{L}\\p{N}_])" + esc + "($|[^\\p{L}\\p{N}_])", "iu");
    if (phraseRegexes.size > 200) phraseRegexes.clear();
    phraseRegexes.set(phrase, re);
  }
  return re.test(text || "");
}

/** What to type to @mention someone: their display name, unless it isn't their login (localized names). */
function mentionName(login, name) {
  return login && (!name || name.toLowerCase() !== login) ? login : name;
}

function normLogin(u) { return String(u || "").trim().replace(/^@/, "").toLowerCase(); }

/** Highlight rules: a phrase, a user, or a phrase only when that user says it. */
/** This channel's own overrides of the global alert and mute settings (see "Settings for this channel"). */
function chanSetting(login) { return (settings.channels && settings.channels[login]) || {}; }

const NOTE_COLORS = ["#ff4d4d", "#ff9f1a", "#f2d600", "#2ecc71", "#3aa0ff", "#b36bff"];

/** Your private label for someone, shown after their name wherever they chat. */
function userTag(id) {
  const n = settings.notes && settings.notes[id];
  if (!n || !(n.label || n.note)) return null;
  const t = el("span", "user-tag", n.label || "note");
  if (n.color) t.style.setProperty("--tag", n.color);
  t.title = n.note || n.label;
  return t;
}

function refreshUserTags(id) {
  document.querySelectorAll('.msg[data-user="' + CSS.escape(id) + '"]').forEach((li) => {
    li.querySelectorAll(".user-tag").forEach((n) => n.remove());
    const t = userTag(id), nm = li.querySelector(".name");
    if (t && nm) nm.after(t);
  });
}

/** Well-known chat bots, hidden by "Hide bots". Names you want gone beyond these go on the ignore list. */
const KNOWN_BOTS = new Set(["nightbot", "streamelements", "streamlabs", "moobot", "fossabot", "wizebot", "soundalerts", "sery_bot", "pokemoncommunitygame"]);
const muteRegexes = new Map();

/** A mute entry is a plain word or phrase (whole words, any case) or /pattern/flags. Null if it isn't valid. */
function muteMatcher(entry) {
  if (muteRegexes.has(entry)) return muteRegexes.get(entry);
  let re = null;
  const m = /^\/(.+)\/([a-z]*)$/.exec(entry);
  try {
    if (m) re = new RegExp(m[1], m[2].replace(/[^imsu]/g, "") || "i");
    else if (entry.trim()) re = new RegExp("(^|[^\\p{L}\\p{N}_])" + entry.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+") + "($|[^\\p{L}\\p{N}_])", "iu");
  } catch { re = null; }
  if (muteRegexes.size > 200) muteRegexes.clear();
  muteRegexes.set(entry, re);
  return re;
}

/** Messages the mute filters hide (never your own). */
function isMuted(ev, channel) {
  const mute = settings.mute;
  if (!mute || (me && ev.chatter_user_id === me.userId)) return false;
  const text = (ev.message && ev.message.text) || "";
  if (mute.bots && KNOWN_BOTS.has(normLogin(ev.chatter_user_login))) return true;
  if (mute.commands && /^\s*!\w/.test(text)) return true;
  return [...(mute.words || []), ...(chanSetting(channel).muteWords || [])].some((w) => { const re = muteMatcher(w); return re && re.test(text); });
}

function matchesHighlight(ev) {
  const login = normLogin(ev.chatter_user_login || ev.chatter_user_name);
  return settings.rules.some((r) =>
    (r.phrase || r.user) &&
    (!r.user || normLogin(r.user) === login) &&
    (!r.phrase || containsPhrase(ev.message.text, r.phrase)));
}

function userRule(login) { return settings.rules.find((r) => !r.phrase && normLogin(r.user) === normLogin(login)); }

let audioCtx = null;
function ping() {
  try {
    audioCtx = audioCtx || new AudioContext();
    const t = audioCtx.currentTime;
    for (const [f, at] of [[880, 0], [1320, 0.09]]) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.15, t + at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.18);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + at);
      o.stop(t + at + 0.2);
    }
  } catch {}
}
// Browsers only allow audio after a user gesture; unlock it on the first one.
document.addEventListener("pointerdown", () => { if (settings.sound && !audioCtx) { try { audioCtx = new AudioContext(); } catch {} } }, { once: true });

function alertFor(tab, ev) {
  const away = document.hidden || tab !== active;
  if (!away) return;
  const cs = chanSetting(tab.login);
  if (cs.sound === "on" || (cs.sound !== "off" && settings.sound)) ping();
  if (!(cs.notify === "on" || (cs.notify !== "off" && settings.notify)) || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const title = ev.chatter_user_name + " in #" + (tab.broadcaster ? tab.broadcaster.name : tab.login);
  const opts = { body: ev.message.text, tag: ev.message_id, icon: "/icons/icon-192.png", data: { tab: tab.login } };
  // Android requires notifications to come from the service worker.
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, opts)).catch(() => {});
  } else {
    try { new Notification(title, opts).onclick = () => { window.focus(); openTab(tab.login); }; } catch {}
  }
}

if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "open-tab" && e.data.tab) openTab(e.data.tab);
  });
}

// ---------- color cycling for messages sent from other apps ----------

// Messages sent from here already advance the color server-side. For our own messages
// that arrive without having been sent from this app (e.g. the official Twitch app),
// ask the server for the next color. Wait for in-flight sends so we can tell them apart.
function maybeBumpColor(messageId) {
  if (!status || !status.cycle || !status.cycle.enabled) return;
  setTimeout(async () => {
    await Promise.all([...inflightSends]);
    if (sentIds.has(messageId)) return;
    const r = await api("/api/cycle/bump", { message_id: messageId });
    if (r.ok && status) { status.cycle = r.cycle; renderCycle(r.cycle); }
  }, 1500);
}

// ---------- settings ----------

// ---------- account menu (your picture in the corner) ----------

/** Shows your Twitch picture (or your initial until it loads, or if it can't) on the account button. */
function renderAccount() {
  const tw = status && status.twitch;
  if (!tw) return;
  const name = tw.displayName || tw.login;
  $("profile-btn").title = "Account: " + name;
  $("avatar-letter").textContent = (name[0] || "?").toUpperCase();
  const img = $("avatar-img");
  img.hidden = true;
  if (tw.avatar) {
    img.onload = () => { img.hidden = false; };
    img.onerror = () => { img.hidden = true; };
    if (img.getAttribute("src") !== tw.avatar) img.src = tw.avatar;
    else img.hidden = !img.complete || !img.naturalWidth;
  }
}

function closeAccountMenu() {
  show("account-menu", false);
  $("profile-btn").setAttribute("aria-expanded", "false");
}

function toggleAccountMenu() {
  const menu = $("account-menu");
  if (!menu.hidden) { closeAccountMenu(); return; }
  const tw = status && status.twitch;
  if (!tw) return;
  const who = el("div", "who");
  const pic = el("span", "pic", ((tw.displayName || tw.login)[0] || "?").toUpperCase());
  if (tw.avatar) {
    const img = document.createElement("img");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => img.remove());
    img.src = tw.avatar;
    pic.appendChild(img);
  }
  const names = el("div", "names");
  names.append(el("span", "dn", tw.displayName || tw.login), el("span", "ln", "@" + tw.login));
  who.append(pic, names);
  const item = (label, onClick, cls) => {
    const b = el("button", cls || null, label);
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.addEventListener("click", () => { closeAccountMenu(); onClick(); });
    return b;
  };
  menu.replaceChildren(
    who,
    item("Settings", openSettings),
    item("Your clips", () => openBrowse({ mine: true })),
    ...(window.toolsAccountItems?.(item) || []),
    item("Log out", () => { if (confirm("Log out? This disconnects your Twitch account from Yappa.")) logout(); }, "danger"),
  );
  show("account-menu", true);
  $("profile-btn").setAttribute("aria-expanded", "true");
}

$("profile-btn").addEventListener("click", toggleAccountMenu);
document.addEventListener("pointerdown", (e) => { if (!$("account-menu").hidden && !e.target.closest("#account-menu, #profile-btn")) closeAccountMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("account-menu").hidden) closeAccountMenu(); });

// ---------- settings backup ----------

const BACKUP_APP = "yappa-settings";

function startupSummary() {
  const labels = [["status", "signed in"], ["socket", "live connection"], ["firstJoin", "first channel joined"], ["history", "history shown"], ["allJoined", "all channels joined"]];
  const parts = labels.filter(([k]) => k in startup).map(([k, l]) => l + " " + (startup[k] / 1000).toFixed(1) + "s");
  return parts.length ? "Since the page started loading: " + parts.join(" · ") + "." : "Not recorded yet.";
}

function backupFile() {
  let tabList = [];
  try { tabList = JSON.parse(safeGet("tabs") || "[]"); } catch {}
  return JSON.stringify({ app: BACKUP_APP, version: 1, exported: new Date().toISOString(), settings, tabs: tabList, pinned: safeGet("pinnedVideo") || null }, null, 2);
}

/** Checks a backup file and returns what to apply, or a reason it can't be used. */
function parseBackup(text) {
  if (typeof text !== "string" || text.length > 400000) return "That file is too large to be a Yappa backup.";
  let b;
  try { b = JSON.parse(text); } catch { return "That isn't a Yappa backup (it isn't valid JSON)."; }
  if (!b || b.app !== BACKUP_APP || !b.settings || typeof b.settings !== "object" || Array.isArray(b.settings)) return "That isn't a Yappa backup.";
  const next = {};
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(k in b.settings)) continue;
    const v = b.settings[k];
    const ok = Array.isArray(def) ? Array.isArray(v) : def && typeof def === "object" ? v && typeof v === "object" && !Array.isArray(v) : def === null ? true : typeof v === typeof def;
    if (ok) next[k] = v;
  }
  const tabList = Array.isArray(b.tabs) ? b.tabs.filter((t) => typeof t === "string" && /^[a-z0-9_]{1,25}$/.test(t)).slice(0, MAX_TABS) : [];
  const pinned = typeof b.pinned === "string" && /^[a-z0-9_]{1,25}$/.test(b.pinned) ? b.pinned : null;
  return { settings: next, tabs: tabList, pinned };
}

function backupControls() {
  const box = el("div", "seg");
  const file = document.createElement("input");
  file.type = "file";
  file.accept = "application/json,.json";
  file.hidden = true;
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    file.value = "";
    if (!f) return;
    const parsed = parseBackup(await f.text());
    if (typeof parsed === "string") { alert(parsed); return; }
    if (!confirm("Replace your settings, notes, bookmarks and tabs with this backup?")) return;
    settings = { ...structuredClone(DEFAULT_SETTINGS), ...parsed.settings };
    safeSet("settings", JSON.stringify(settings));
    safeSet("tabs", JSON.stringify(parsed.tabs));
    if (parsed.pinned) safeSet("pinnedVideo", parsed.pinned); else { try { localStorage.removeItem("pinnedVideo"); } catch {} }
    syncChanged();
    nav.reload();
  });
  box.append(btn("Save file", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([backupFile()], { type: "application/json" }));
    a.download = "yappa-settings-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }), btn("Restore…", () => file.click()), file);
  return box;
}

function openSettings() {
  const row = (labelText, control, hint) => {
    const r = el("div", "row");
    const l = el("label");
    l.append(el("div", null, labelText));
    if (hint) l.appendChild(el("div", "hint", hint));
    r.append(l, control);
    return r;
  };
  const checkbox = (checked, onChange) => {
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = checked;
    c.addEventListener("change", () => onChange(c));
    return c;
  };

  const notifyHint = typeof Notification === "undefined" ? "Not supported in this browser." :
    Notification.permission === "denied" ? "Blocked in your browser settings for this site." :
    "For @mentions, highlight words and AutoMod while you're in another tab or app.";
  const notify = checkbox(settings.notify && typeof Notification !== "undefined" && Notification.permission === "granted", async (c) => {
    if (c.checked && typeof Notification !== "undefined" && Notification.permission !== "granted") {
      const p = await Notification.requestPermission();
      if (p !== "granted") { c.checked = false; return; }
    }
    settings.notify = c.checked;
    saveSettings();
  });
  const sound = checkbox(settings.sound, (c) => {
    settings.sound = c.checked;
    saveSettings();
    if (c.checked) ping();
  });

  // Highlight rules editor
  const rulesList = el("div", "rules");
  const renderRules = () => {
    rulesList.replaceChildren();
    if (!settings.rules.length) { rulesList.appendChild(el("div", "hint", "No rules yet.")); return; }
    settings.rules.forEach((r, i) => {
      const desc = el("label");
      desc.appendChild(el("div", null, r.phrase ? "“" + r.phrase + "”" : "Every message"));
      desc.appendChild(el("div", "hint", r.user ? "only from @" + normLogin(r.user) : "from anyone"));
      const line = el("div", "row");
      line.append(desc, btn("Remove", () => { settings.rules.splice(i, 1); saveSettings(); renderRules(); }, "ghost small"));
      rulesList.appendChild(line);
    });
  };
  renderRules();
  const phraseIn = document.createElement("input");
  phraseIn.type = "text";
  phraseIn.placeholder = "Word or phrase (optional if you pick a user)";
  const userIn = document.createElement("input");
  userIn.type = "text";
  userIn.placeholder = "From user (optional), e.g. somestreamer";
  userIn.autocapitalize = "off";
  const addRule = el("div", "rule-form");
  const addBtn = btn("Add rule", () => {
    const phrase = phraseIn.value.trim(), user = normLogin(userIn.value);
    if (!phrase && !user) { phraseIn.focus(); return; }
    settings.rules.push({ phrase, user });
    saveSettings();
    phraseIn.value = userIn.value = "";
    renderRules();
  }, "small");
  addRule.append(phraseIn, userIn, addBtn);

  // Mute filters
  const muteList = el("div", "rules");
  const renderMute = () => {
    muteList.replaceChildren();
    const words = settings.mute.words;
    if (!words.length) { muteList.appendChild(el("div", "hint", "No muted words yet.")); return; }
    words.forEach((w, i) => {
      const line = el("div", "row");
      const desc = el("label");
      desc.appendChild(el("div", null, w));
      line.append(desc, btn("Remove", () => { settings.mute.words.splice(i, 1); saveSettings(); renderMute(); }, "ghost small"));
      muteList.appendChild(line);
    });
  };
  renderMute();
  const muteIn = document.createElement("input");
  muteIn.type = "text";
  muteIn.placeholder = "Word, phrase or /pattern/";
  muteIn.autocapitalize = "off";
  const muteErr = el("div", "hint");
  const addMute = el("div", "rule-form");
  const addMuteBtn = btn("Mute", () => {
    const w = muteIn.value.trim();
    if (!w) { muteIn.focus(); return; }
    if (!muteMatcher(w)) { muteErr.textContent = "That isn't a valid pattern."; return; }
    muteErr.textContent = "";
    if (!settings.mute.words.includes(w)) settings.mute.words.push(w);
    saveSettings();
    muteIn.value = "";
    renderMute();
  }, "small");
  muteIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addMuteBtn.click(); } });
  addMute.append(muteIn, addMuteBtn);

  const seg = el("div", "seg");
  for (const [label, px] of [["S", 13], ["M", 14], ["L", 16], ["XL", 18]]) {
    const b = btn(label, () => { settings.fontSize = px; saveSettings(); seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); });
    if (settings.fontSize === px) b.classList.add("on");
    seg.appendChild(b);
  }

  const playerSeg = el("div", "seg");
  for (const [label, value] of [["Twitch player", "embed"], ["Native (HLS)", "native"]]) {
    const b = btn(label, () => { setPlayer(value); playerSeg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); });
    if ((settings.player || "embed") === value) b.classList.add("on");
    playerSeg.appendChild(b);
  }

  const bitsSeg = el("div", "seg");
  for (const [label, value] of [["Twitch", "twitch"], ["Chat embed (experimental)", "embed"]]) {
    const b = btn(label, () => { settings.bitsButton = value; saveSettings(); bitsSeg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); });
    if ((settings.bitsButton || "twitch") === value) b.classList.add("on");
    bitsSeg.appendChild(b);
  }

  const themeSeg = el("div", "seg");
  for (const [label, value] of [["Dark", "dark"], ["Light", "light"], ["Match device", "system"]]) {
    const b = btn(label, () => { settings.theme = value; saveSettings(); themeSeg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); });
    if ((settings.theme || "dark") === value) b.classList.add("on");
    themeSeg.appendChild(b);
  }

  const hiddenList = el("div");
  const renderHidden = () => {
    hiddenList.replaceChildren();
    if (!settings.hidden.length) { hiddenList.appendChild(el("div", "hint", "Nobody. Tap a name in chat to ignore someone.")); return; }
    for (const h of settings.hidden) {
      hiddenList.appendChild(row(h.name, btn("Unignore", () => { setHidden(h, false); renderHidden(); })));
    }
  };
  renderHidden();

  const account = el("div", "row");
  const who = el("label");
  who.append(el("div", null, "Signed in to Twitch as " + (me ? me.login : "—")));
  who.appendChild(el("div", "hint", "Reconnect to grant new permissions after an update."));
  const acctBtns = el("div", "seg");
  const reconnect = el("a", "btn", "Reconnect");
  reconnect.href = "/auth/login";
  acctBtns.append(reconnect, btn("Disconnect", () => { if (confirm("Disconnect your Twitch account?")) { closeSheet(); logout(); } }, "stop"));
  account.append(who, acctBtns);

  const historyRow = el("div", "row");
  const historyLabel = el("label");
  historyLabel.append(el("div", null, "Load chat history"), el("div", "hint"));
  historyLabel.lastChild.appendChild(historyInfo());
  historyRow.append(historyLabel, checkbox(settings.history === true, (c) => setHistory(c.checked)));

  const color = el("div", "row");
  const colorLabel = el("label");
  colorLabel.append(el("div", null, "Change my color every message"), el("div", "hint", "A new random color for each message you send. Shows your current color and how many times it has changed."));
  color.append(colorLabel);

  openSheet(
    el("h2", null, "Settings"),
    el("h3", null, "Chat color"),
    color,
    cyclerEl,
    el("h3", null, "Account"),
    account,
    el("h3", null, "Chat history"),
    historyRow,
    el("h3", null, "Raids"),
    row("Follow raids", checkbox(settings.followRaids, (c) => { settings.followRaids = c.checked; saveSettings(); }),
      "When the channel you're watching raids, switch to the raided channel after " + RAID_FOLLOW_SECONDS + " seconds (you can stay)."),
    el("h3", null, "Alerts"),
    row("Notifications", notify, notifyHint),
    row("Sound", sound, "A short chime for mentions and highlights when you're looking elsewhere."),
    el("h3", null, "Highlight rules"),
    el("div", "hint", "Matching messages are highlighted in orange (and alert you, if on). Phrases match whole words, ignoring case."),
    rulesList,
    addRule,
    el("h3", null, "Mute filters"),
    el("div", "hint", "Hide messages instead of highlighting them. Your own are never hidden, and changes apply to new messages."),
    row("Hide known bots", checkbox(!!settings.mute.bots, (c) => { settings.mute.bots = c.checked; saveSettings(); }),
      "Nightbot, StreamElements, Streamlabs, Moobot, Fossabot, WizeBot, SoundAlerts, Sery_Bot and the Pokémon community game bot."),
    row("Hide !commands", checkbox(!!settings.mute.commands, (c) => { settings.mute.commands = c.checked; saveSettings(); }),
      "Messages that start with ! (people triggering bot commands)."),
    el("div", "hint", "Muted words and phrases match whole words, ignoring case. Wrap a regular expression in slashes, like /^gg+$/, to match a pattern."),
    muteList,
    addMute,
    muteErr,
    el("h3", null, "Video player"),
    playerSeg,
    el("div", "hint", "Native plays the stream directly in a plain video player, which can autoplay (muted) on phones. " +
      "Tested: Native works in Firefox for Android but not in Chrome (Twitch only lets its own site load its video in browsers that enforce cross-site rules), and Twitch's player is the other way round. " +
      "This choice is saved per browser. Native also relies on an unofficial Twitch API that can stop working at any time; if it fails, Yappa switches back to Twitch's player for that visit."),
    el("h3", null, "Bits and channel points"),
    bitsSeg,
    el("div", "hint", "What the gem button next to the emote button does. Twitch: opens twitch.tv, as the pop-out chat on computers or the Twitch app on phones. " +
      "Chat embed (experimental): Twitch's chat in a window here, with Bits and channel points. It needs your twitch.tv login to be shared with this site; closing the window keeps it loaded in the background (up to 3 channels) so you stay signed in." + chatEmbedTip(navigator.userAgent)),
    el("h3", null, "Appearance"),
    themeSeg,
    el("h3", null, "Chat text size"),
    seg,
    el("h3", null, "Chat layout"),
    row("Compact", checkbox(!!settings.compact, (c) => { settings.compact = c.checked; saveSettings(); }), "Tighter spacing between messages."),
    row("Alternate row shading", checkbox(!!settings.zebra, (c) => { settings.zebra = c.checked; saveSettings(); }), "Every other line gets a faint background, which helps on fast chats."),
    row("Show times", checkbox(settings.showTime !== false, (c) => { settings.showTime = c.checked; saveSettings(); })),
    row("Show badges", checkbox(settings.showBadges !== false, (c) => { settings.showBadges = c.checked; saveSettings(); })),
    row("Font", dropdown([["default", "Default"], ["mono", "Monospace"], ["serif", "Serif"]], settings.chatFont || "default", (v) => { settings.chatFont = v; saveSettings(); }), "These layout choices are saved per device."),
    el("h3", null, "Clips"),
    row("Post new clips in chat", checkbox(settings.postClips !== false, (c) => { settings.postClips = c.checked; saveSettings(); }),
      "When you create a clip with Yappa (the clapper button in the info bar), send its link to the channel's chat as you."),
    el("h3", null, "GIFs"),
    row("Show GIFs", checkbox(settings.gifs !== false, (c) => { settings.gifs = c.checked; saveSettings(); }),
      "Tier 2 and 3 subscribers can send GIFs. They're big and animated, so turn this off to get a link instead (applies to new messages)."),
    el("h3", null, "Moderation and alerts"),
    row("Show moderator actions in chat", checkbox(!!settings.modLog, (c) => { settings.modLog = c.checked; saveSettings(); }),
      "In channels you moderate, add a line when another moderator bans, times out, deletes, or changes a chat mode. Takes effect for channels you open next."),
    row("Tell me when followed channels go live", checkbox(!!settings.liveAlerts, (c) => { settings.liveAlerts = c.checked; saveSettings(); window.toolsLiveSettingChanged?.(); }),
      "A notification and a line in chat while Yappa is open (it can't notify when the app is closed). Allow notifications when asked."),
    row("Note stream title and category changes", checkbox(settings.streamChanges !== false, (c) => { settings.streamChanges = c.checked; saveSettings(); }),
      "Add a line to a channel's chat when its title or category changes."),
    row("Use my Twitch block list", checkbox(settings.syncBlocks !== false, (c) => { settings.syncBlocks = c.checked; saveSettings(); window.toolsReloadBlocks?.(); }),
      "Hide messages from people you've blocked on Twitch, as Twitch's own chat does."),
    el("h3", null, "Devices"),
    row("Sync across my devices", checkbox(settings.sync !== false, (c) => {
      settings.sync = c.checked;
      saveSettings();
      if (c.checked) syncPull(false);
    }), "Keep settings, open tabs and the pinned stream the same on every device you sign in on (the newest change wins). Video player, theme, text size and notifications stay per device."),
    el("h3", null, "Backup"),
    row("Settings file", backupControls(), "Save everything (settings, tabs, notes, bookmarks, quick messages) to a file, or restore from one. Restoring replaces what's here."),
    el("h3", null, "Ignored users"),
    hiddenList,
    el("h3", null, "Startup timings"),
    el("div", "hint", startupSummary()),
  );
}

// ---------- mobile viewport ----------

// Mobile keyboards shrink only the visual viewport (and iOS scrolls it), so size and
// position the app to whatever is actually visible.
const vv = window.visualViewport;
if (vv) {
  const app = document.querySelector(".app");
  const fit = () => {
    const stick = active && sticking(active);
    app.style.setProperty("--app-height", vv.height + "px");
    app.style.transform = vv.offsetTop ? "translateY(" + vv.offsetTop + "px)" : "";
    if (stick) scrollToBottom(active);
  };
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
  fit();
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

applySettings();
loadExtGlobal();
refreshStatus();
// Everything that changes the status from here refreshes it (sending, the cycle toggle,
// reconnecting, coming back to the app), so this only catches changes made on another
// device or Twitch revoking access. Poll rarely, and only while visible.
setInterval(() => { if (!document.hidden) refreshStatus(); }, 5 * 60000);
