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
const DEFAULT_SETTINGS = { notify: false, sound: false, rules: [], fontSize: 14, hidden: [], video: true, followRaids: true, history: null, theme: "dark" };
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
function saveSettings() { safeSet("settings", JSON.stringify(settings)); applySettings(); }
function applySettings() {
  document.querySelector(".app").style.setProperty("--chat-font", settings.fontSize + "px");
  applyTheme();
}

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

function escapeText(t) {
  const d = document.createElement("div");
  d.textContent = t;
  return d.innerHTML;
}

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

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
  try { return await res.json(); } catch { return { ok: false, error: "Request failed (" + res.status + ")", retry: res.status >= 500 }; }
}

function setError(msg) { $("error").textContent = msg || ""; show("error", !!msg); }
const qsError = new URLSearchParams(location.search).get("error");
if (qsError) { setError(qsError); history.replaceState(null, "", "/" + location.hash); }

function normalizeChannel(v) {
  return String(v || "").trim().replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "").replace(/^[#@]/, "").split(/[/?#]/)[0].toLowerCase();
}

// ---------- status / color cycling ----------

// The color controls live in the Settings sheet, which detaches them when it closes,
// so keep direct references rather than looking them up by id.
const cyclerEl = $("cycler"), swatchEl = $("swatch"), colorEl = $("color"), cycleBtn = $("cycle");

async function refreshStatus() {
  const s = await api("/api/status");
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
  if (tw) $("settings-btn").title = "Settings (signed in to Twitch as " + tw.login + ")";

  renderCycle(s.cycle);
  if (first && tw && tw.missingScopes.length === 0) restoreTabs(null);
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

async function logout() {
  for (const t of [...tabs.values()]) closeTab(t, { keepSaved: true });
  dropSocket();
  await api("/auth/logout", {});
  status = null;
  refreshStatus();
}

// ---------- tabs ----------

function saveTabs() {
  safeSet("tabs", JSON.stringify([...tabs.keys()]));
  if (active) safeSet("lastChannel", active.login);
}

function restoreTabs(cycling) {
  let saved = [];
  try { saved = JSON.parse(safeGet("tabs") || "[]"); } catch {}
  if (!Array.isArray(saved)) saved = [];
  const fromHash = normalizeChannel(location.hash.slice(1));
  const legacy = safeGet("lastChannel");
  const names = [...saved, fromHash, cycling, saved.length ? null : legacy].map(normalizeChannel).filter(Boolean);
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
      seen: new Set(), lastTs: 0,
      list: el("ul", "messages"), tabEl: null,
    };
    tab.list.hidden = true;
    tab.list.setAttribute("aria-live", "polite");
    tab.list.addEventListener("scroll", () => {
      if (tab === active && nearBottom(tab)) show("more", false);
      if (tab.list.scrollTop < 400) loadOlder(tab); // near the top: fetch earlier history
    });
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
  btn.append(dot, name, live, mod, unread);
  btn.addEventListener("click", () => activate(tab));
  const close = el("button", "tab-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close " + tab.login);
  close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(tab); });
  wrap.append(btn, close);
  $("tabs").appendChild(wrap);
  tab.tabEl = { wrap, name, mod, unread, live };
  updateTabEl(tab);
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
  tab.list.scrollTop = tab.list.scrollHeight;
  show("more", false);
  if (prev) { setReply(null); closePicker(); closeSuggest(); }
  $("channel").value = "";
  history.replaceState(null, "", "#" + tab.login);
  saveTabs();
  updateComposer();
  renderInfo();
  renderVideo();
  show("modes-panel", false);
  applyFilter();
  if (!$("picker").hidden) renderPicker();
}

function closeTab(tab, opts = {}) {
  if (!tabs.has(tab.login)) return;
  tabs.delete(tab.login);
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
      if (migrating) {
        if (old && old !== ws) { old.retired = true; old.close(); }
      } else {
        for (const t of tabs.values()) subscribeTab(t);
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

async function subscribeTab(tab) {
  const sid = sessionId;
  if (!sid || tab.joining === sid) return;
  tab.joining = sid;
  const r = await api("/api/chat/subscribe", { channel: tab.login, session_id: sid });
  tab.joining = null;
  if (!tabs.has(tab.login)) {
    if (r.ok) api("/api/chat/unsubscribe", { ids: r.subscriptionIds });
    return;
  }
  if (sid !== sessionId) return; // the socket changed; the new welcome resubscribes
  if (!r.ok) {
    sysLine(tab, "Couldn't join #" + tab.login + ": " + r.error, "err");
    if (r.retry) setTimeout(() => { if (tabs.has(tab.login) && !tab.joined) subscribeTab(tab); }, 10000);
    return;
  }
  retries = 0;
  const rejoin = !!tab.broadcaster;
  // Pin the backfill window now: live messages arriving meanwhile must not narrow it.
  const range = { since: rejoin ? tab.lastTs : 0, until: Date.now() };
  tab.broadcaster = r.broadcaster;
  tab.isMod = r.isMod;
  tab.subIds = r.subscriptionIds || [];
  tab.joined = true;
  tab.settings = r.settings || tab.settings || null;
  tab.automod = !!r.automod;
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
  if (settings.history === true) backfill(tab, { ...range, marker });
  else if (settings.history == null) askHistory(tab);
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
  const first = [...tab.list.children].find((n) => n.dataset.recv);
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
      const stick = tab !== active || nearBottom(tab);
      keepScroll(tab, () => { added += mergeHistory(tab, lines, { since, until, historical: false }); });
      if (stick) tab.list.scrollTop = tab.list.scrollHeight;
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
  const stick = tab !== active || nearBottom(tab);
  mergeHistory(tab, lines, { until, historical: true });
  tab.historyBefore = Math.min(...lines.map(receivedAt).filter(Boolean)) || 0;
  tab.historyDone = lines.length < HISTORY_PAGE || !tab.historyBefore;
  placeHistoryDivider(tab);
  if (stick) tab.list.scrollTop = tab.list.scrollHeight;
  fillScreen(tab);
}

/** Keeps loading pages until the visible list can scroll (else you can't scroll up for more). */
function fillScreen(tab) {
  if (tab === active && !tab.list.hidden && tab.list.scrollHeight <= tab.list.clientHeight + 400) loadOlder(tab).then(() => {
    if (!tab.historyDone && !tab.olderRetryAt) fillScreen(tab);
  });
}

/** Scrolled near the top: fetch the next page of older history. */
async function loadOlder(tab) {
  if (settings.history !== true || tab.loadingOlder || tab.historyDone || !tab.historyBefore) return;
  if (Date.now() < (tab.olderRetryAt || 0)) return;
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
  if (on) for (const t of tabs.values()) if (t.joined) backfill(t, { since: 0, until: Date.now() });
}

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
      ranges.push([a, b, id]);
    }
  }
  ranges.sort((x, y) => x[0] - y[0]);
  const chars = Array.from(text);
  const fragments = [];
  let pos = 0;
  for (const [a, b, id] of ranges) {
    if (a > pos) fragments.push({ type: "text", text: chars.slice(pos, a).join("") });
    fragments.push({ type: "emote", text: chars.slice(a, b + 1).join(""), emote: { id } });
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
    historical: true,
  };
}

async function loadTabExtras(tab) {
  const id = tab.broadcaster.id;
  const [badges, ext, emotes, cheermotes] = await Promise.all([
    api("/api/chat/badges?broadcaster_id=" + encodeURIComponent(id)),
    loadExtChannel(id),
    api("/api/chat/emotes?broadcaster_id=" + encodeURIComponent(id)),
    api("/api/chat/cheermotes?broadcaster_id=" + encodeURIComponent(id)),
  ]);
  tab.badges = badges || {};
  tab.ext = ext;
  tab.twitchEmotes = emotes;
  tab.cheermotes = new Map((Array.isArray(cheermotes) ? cheermotes : []).map((c) => [c.prefix.toLowerCase(), c]));
  const counts = EXT_SOURCES.map((src) => [src, [...ext.values()].filter((e) => e.source === src).length]).filter(([, n]) => n);
  if (counts.length) sysLine(tab, "Channel emotes: " + counts.map(([src, n]) => n + " " + src).join(" · ") + ".");
  if (tab === active && !$("picker").hidden) renderPicker();
}

function tabForBroadcaster(id) {
  for (const t of tabs.values()) if (t.broadcaster && t.broadcaster.id === id) return t;
  return null;
}

function updateComposer() {
  const on = !!(active && active.joined && sock);

  $("send").disabled = !on;
  $("emote-btn").disabled = !on;
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
  appendEmote(parent, emoteImg(c.url, text, "Cheer"), false);
  const amount = el("b", "cheer-bits", String(bits));
  amount.style.color = c.color;
  parent.appendChild(amount);
}

// ---------- rendering ----------

const nearBottom = (tab) => tab.list.scrollHeight - tab.list.scrollTop - tab.list.clientHeight < 60;
$("more").addEventListener("click", () => {
  if (active) active.list.scrollTop = active.list.scrollHeight;
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
  if (list.children.length <= MAX_MESSAGES) return;
  while (list.children.length > MAX_MESSAGES) {
    const n = list.firstChild;
    if (n.dataset.id) tab.seen.delete(n.dataset.id); // so a reload from history isn't skipped
    n.remove();
  }
  const first = [...list.children].find((n) => n.dataset.ts && n.dataset.ts !== "0");
  if (first && settings.history === true) {
    tab.historyBefore = Number(first.dataset.recv || first.dataset.ts);
    tab.historyDone = false;
    placeHistoryDivider(tab);
  }
}

function append(tab, node, countsAsUnread) {
  const list = tab.list;
  const stick = tab !== active || nearBottom(tab);
  if (!node.dataset.ts) node.dataset.ts = String(Date.now());
  list.appendChild(node);
  if (tab === active && filterText) filterNode(node);
  // Only trim at the bottom, so history you've scrolled up to load stays put while you read it.
  if (stick) trimList(tab);
  if (countsAsUnread && document.hidden) { hiddenUnread++; updateTitle(); }
  if (tab === active) {
    if (stick) list.scrollTop = list.scrollHeight;
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

function emoteImg(src, name, source) {
  const img = document.createElement("img");
  img.src = src;
  img.alt = name;
  img.title = name + " (" + source + ")";
  img.loading = "lazy";
  return img;
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
    if (e) appendEmote(parent, emoteImg(e.url, part, e.source), e.zeroWidth);
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

const clipCache = new Map(); // id -> Promise<clip | null>
function fetchClip(id) {
  if (!clipCache.has(id)) {
    clipCache.set(id, api("/api/chat/clip?id=" + encodeURIComponent(id)).then((r) => {
      if (!r.ok) clipCache.delete(id); // retry later if it was an error, not a missing clip
      return r.ok ? r.clip : null;
    }));
  }
  return clipCache.get(id);
}

function fmtDuration(secs) {
  const s = Math.round(secs);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

/** Adds a thumbnail + metadata card under a message for each Twitch clip it links (max 2). */
function attachClipCards(tab, li, body) {
  const ids = [...new Set([...body.querySelectorAll("a.link")].map((a) => clipIdFrom(a.href)).filter(Boolean))].slice(0, 2);
  for (const id of ids) {
    fetchClip(id).then((clip) => {
      if (!clip || !li.isConnected || !/^https:\/\//.test(clip.url)) return;
      const stick = tab === active && nearBottom(tab);
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
      li.insertBefore(card, li.querySelector(".actions"));
      if (stick) tab.list.scrollTop = tab.list.scrollHeight;
    });
  }
}

function renderFragments(tab, parent, fragments, skipPrefix, hasBits) {
  let skip = skipPrefix;
  for (const f of fragments || []) {
    if (f.type === "cheermote" && f.cheermote) {
      appendCheer(tab, parent, f.cheermote.prefix, f.cheermote.bits, f.text);
    } else if (f.type === "emote" && f.emote) {
      appendEmote(parent, emoteImg("https://static-cdn.jtvnw.net/emoticons/v2/" + f.emote.id + "/default/dark/2.0", f.text, "Twitch"), false);
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

function timeLabel(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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
  const nm = nameNode(ev);
  nm.addEventListener("click", (e) => {
    e.stopPropagation();
    openUserCard(tab, { id: ev.chatter_user_id, login: ev.chatter_user_login, name: ev.chatter_user_name, color: nm.style.color });
  });
  li.appendChild(nm);
  const mine = me && ev.chatter_user_id === me.userId;
  li.appendChild(document.createTextNode(": "));
  const body = el("span", "body");
  renderFragments(tab, body, ev.message.fragments, !!ev.reply, !!ev.bits);
  li.appendChild(body);

  const mentioned = me && (ev.message.fragments || []).some((f) => (f.type === "mention" && f.mention && f.mention.user_id === me.userId) || f.mentionsMe);
  if (mentioned) li.classList.add("mentioned");
  const highlighted = !mentioned && !mine && matchesHighlight(ev);
  if (highlighted) li.classList.add("highlighted");
  if ((mentioned || highlighted) && !mine && !opts.historical && !opts.merge && !li.classList.contains("ignored")) alertFor(tab, ev);
  if (mine && !opts.historical && !opts.merge) maybeBumpColor(ev.message_id);

  const actions = el("div", "actions");
  actions.appendChild(actionButton("Reply", () => setReply({ id: ev.message_id, user: ev.chatter_user_name, text: ev.message.text })));
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

  if (opts.merge) {
    insertByTime(tab, li, ev.ts);
    if (!opts.historical && !mine && tab !== active) { tab.unread++; updateTabEl(tab); }
  } else {
    if (ev.ts) li.dataset.ts = String(ev.ts);
    append(tab, li, !li.classList.contains("ignored") && !mine);
  }
  if (mentioned && tab !== active && !opts.historical && !li.classList.contains("ignored")) { tab.mentioned = true; updateTabEl(tab); }
  return li;
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
      if (tab === active) { renderInfo(); if (!$("modes-panel").hidden) renderModesPanel(); }
      return;
    case "automod.message.hold": return renderHeld(tab, ev);
    case "automod.message.update": return resolveHeld(tab, ev);
    case "channel.chat.notification": return renderNotification(tab, ev);
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

// Touch devices have no hover, so tapping a message toggles its action bar.
$("chat").addEventListener("click", (e) => {
  if (e.target.closest("a")) return; // links open in a new tab; don't also select the message
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
  if (tab.twitchEmotes && tab.twitchEmotes.ok) {
    const e = tab.twitchEmotes.emotes.find((x) => x.name === name);
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
    const tab = active;
    tab.twitchEmotes = null;
    renderPicker();
    api("/api/chat/emotes?broadcaster_id=" + encodeURIComponent(tab.broadcaster.id)).then((r) => {
      tab.twitchEmotes = r;
      if (tab === active && !$("picker").hidden) renderPicker();
    });
  }
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

  if (!q) add("Recent", recentHere(tab));
  add("Twitch · this channel", tw("This channel"));
  if (tab) for (const src of EXT_SOURCES) add(src + " · this channel", ext(tab.ext, src));
  add("Twitch · your other subs", tw("Other channels"));
  add("Twitch · global", tw("Twitch global"));
  for (const src of EXT_SOURCES) add(src + " · global", ext(extGlobal, src));
  add("Twitch · other", tw("Other"));

  let note = "";
  const te = tab && tab.twitchEmotes;
  if (tab && tab.broadcaster && !te) note = "Loading your Twitch emotes…";
  else if (te && te.needsScope) note = '<a href="/auth/login">Reconnect Twitch</a> to include your Twitch emotes.';
  else if (te && !te.ok) note = "Couldn't load Twitch emotes: " + escapeText(te.error || "unknown error");
  $("picker-note").innerHTML = note;
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
$("emote-search").addEventListener("input", renderPicker);
$("emote-search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closePicker(); composer.focus(); }
  if (e.key === "Enter") {
    e.preventDefault();
    const first = $("picker-list").querySelector(".grid button");
    if (first) first.click();
  }
});
$("picker-list").addEventListener("click", (e) => {
  const b = e.target.closest(".grid button");
  if (!b) return;
  insertEmote(b.dataset.name);
  rememberEmote(b.dataset.name, b.dataset.url);
});

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

$("message").addEventListener("input", updateSuggest);
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
  const pending = api("/api/chat/send", {
    broadcaster_id: tab.broadcaster.id,
    message: text,
    reply_parent_message_id: replyTo ? replyTo.id : undefined,
  });
  inflightSends.add(pending);
  const r = await pending;
  inflightSends.delete(pending);
  sending = false;
  if (r.ok && r.messageId) sentIds.add(r.messageId);
  updateComposer();
  if (r.ok) {
    lastSent = text;
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
  if (!Array.isArray(list)) return;
  const byId = new Map(list.map((st) => [st.user_id, st]));
  for (const t of tabs.values()) {
    if (!t.broadcaster) continue;
    t.stream = byId.get(t.broadcaster.id) || null;
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
  const box = videoBox;
  const tab = active;
  const want = !!(settings.video && me && tab && tab.stream);
  if (!want && pipWindow) pipWindow.close(); // returns the player here (see openPip)
  document.querySelector(".app").classList.toggle("with-video", want && !pipWindow);
  $("pip-btn").hidden = !(want && "documentPictureInPicture" in window);
  $("video-btn").setAttribute("aria-pressed", String(!!settings.video));
  $("video-btn").title = settings.video ? "Hide the stream" + (tab && !tab.stream ? " (offline right now)" : "") : "Show the stream";
  if (!want) {
    box.hidden = true;
    if (player) try { player.pause(); } catch {}
    return;
  }
  const wasHidden = box.hidden;
  if (!pipWindow) box.hidden = false;
  const channel = tab.login;
  if (player) {
    // Only (re)start playback on a change, so a stream you paused stays paused.
    const changed = playerChannel !== channel;
    if (changed) { player.setChannel(channel); playerChannel = channel; }
    if (changed || wasHidden) try { player.play(); } catch {}
    return;
  }
  try { await loadEmbedScript(); } catch (err) { if (active) sysLine(active, err.message, "err"); return; }
  if (player || active !== tab || box.hidden) return;
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
  for (const n of box.querySelectorAll(".player-host, iframe")) n.style.cssText = "display:block;width:100%;height:100%;border:0;aspect-ratio:auto";
  w.document.body.appendChild(box);
  box.hidden = false;
  $("pip-btn").setAttribute("aria-pressed", "true");
  document.querySelector(".app").classList.remove("with-video");
  w.addEventListener("pagehide", () => {
    pipWindow = null;
    box.classList.remove("in-pip");
    box.style.cssText = "";
    for (const n of box.querySelectorAll(".player-host, iframe")) n.style.cssText = "";
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

function renderInfo() {
  const tab = active;
  if (!tab || !tab.broadcaster) { show("infobar", false); show("modes-panel", false); return; }
  show("infobar", true);
  const live = $("live");
  live.replaceChildren();
  const st = tab.stream;
  if (st) {
    live.className = "live on";
    live.append(el("span", "dot"), el("b", null, compactCount(st.viewer_count)), el("span", "title", (st.game_name ? st.game_name + " · " : "") + st.title));
    live.title = st.title + "\n" + (st.game_name || "No category") + " · " + st.viewer_count.toLocaleString() + " viewers · live for " + since(st.started_at);
  } else {
    live.className = "live";
    live.textContent = "Offline";
    live.title = "";
  }
  $("modes").replaceChildren(...modeLabels(tab.settings).map((l) => el("span", "chip", l)));
  show("modes-btn", !!tab.isMod);
}

$("modes-btn").addEventListener("click", () => {
  const panel = $("modes-panel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderModesPanel();
});

const SLOW_OPTIONS = [0, 3, 5, 10, 20, 30, 60, 120];
const FOLLOW_OPTIONS = [[-1, "Off"], [0, "Any follower"], [10, "10 min"], [30, "30 min"], [60, "1 hour"], [1440, "1 day"], [10080, "1 week"], [43200, "1 month"], [129600, "3 months"]];

function renderModesPanel() {
  const tab = active;
  const panel = $("modes-panel");
  const st = (tab && tab.settings) || {};
  const title = el("div", "panel-title");
  title.append(el("span", null, "Chat modes for #" + tab.broadcaster.name), el("span"));
  const close = el("button", "icon-btn", "×");
  close.type = "button";
  close.addEventListener("click", () => show("modes-panel", false));
  title.lastChild.replaceWith(close);

  const select = (options, value, onChange) => {
    const sel = document.createElement("select");
    for (const [v, label] of options) {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = label;
      if (v === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => onChange(Number(sel.value)));
    return sel;
  };
  const toggle = (checked, onChange) => {
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = !!checked;
    c.addEventListener("change", () => onChange(c.checked));
    return c;
  };
  const update = async (patch) => {
    const r = await api("/api/chat/settings", { broadcaster_id: tab.broadcaster.id, ...patch });
    if (r.ok) { if (r.settings) tab.settings = r.settings; }
    else sysLine(tab, "Couldn't change chat modes: " + r.error, "err");
    if (tab === active) { renderInfo(); renderModesPanel(); }
  };

  panel.replaceChildren(
    title,
    el("span", null, "Slow mode"),
    select(SLOW_OPTIONS.map((v) => [v, v ? v + "s" : "Off"]), st.slow_mode ? st.slow_mode_wait_time || 30 : 0,
      (v) => update(v ? { slow_mode: true, slow_mode_wait_time: v } : { slow_mode: false })),
    el("span", null, "Followers-only"),
    select(FOLLOW_OPTIONS, st.follower_mode ? st.follower_mode_duration || 0 : -1,
      (v) => update(v < 0 ? { follower_mode: false } : { follower_mode: true, follower_mode_duration: v })),
    el("span", null, "Subscribers-only"), toggle(st.subscriber_mode, (on) => update({ subscriber_mode: on })),
    el("span", null, "Emote-only"), toggle(st.emote_mode, (on) => update({ emote_mode: on })),
    el("span", null, "Unique chat (no repeats)"), toggle(st.unique_chat_mode, (on) => update({ unique_chat_mode: on })),
  );
}

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
  for (const t of tabs.values()) for (const n of t.list.children) if (t !== active || !filterText) n.classList.remove("filtered");
  if (!active || !filterText) { $("search-count").textContent = ""; return; }
  let shown = 0;
  for (const n of active.list.children) { filterNode(n); if (!n.classList.contains("filtered")) shown++; }
  $("search-count").textContent = shown + " match" + (shown === 1 ? "" : "es");
  active.list.scrollTop = active.list.scrollHeight;
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
  actions.appendChild(btn(hidden ? "Show their messages" : "Hide their messages", () => { setHidden(u, !hidden); closeSheet(); }));
  const login = u.login || u.name;
  const hl = userRule(login);
  actions.appendChild(btn(hl ? "Stop highlighting" : "Highlight their messages", () => {
    if (hl) settings.rules = settings.rules.filter((r) => r !== hl);
    else settings.rules.push({ phrase: "", user: normLogin(login) });
    saveSettings();
    closeSheet();
    if (active) sysLine(active, (hl ? "No longer highlighting " : "Highlighting messages from ") + u.name + ".");
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
  openSheet(head, meta, desc, actions, el("h3", null, "Recent messages here (" + theirs.length + ")"), theirs.length ? msgs : el("div", "hint", "None in this session."));

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

function isHidden(id) { return settings.hidden.some((h) => h.id === id); }

function setHidden(u, hide) {
  settings.hidden = settings.hidden.filter((h) => h.id !== u.id);
  if (hide) settings.hidden.push({ id: u.id, name: u.name });
  saveSettings();
  document.querySelectorAll('.msg[data-user="' + CSS.escape(u.id) + '"]').forEach((n) => n.classList.toggle("ignored", hide));
  if (active) sysLine(active, (hide ? "Hiding" : "Showing") + " messages from " + u.name + ".");
}

// ---------- highlights, notifications, sound ----------

/** Whole-word/phrase, case-insensitive. */
function containsPhrase(text, phrase) {
  const esc = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp("(^|[^\\p{L}\\p{N}_])" + esc + "($|[^\\p{L}\\p{N}_])", "iu").test(text || "");
}

/** What to type to @mention someone: their display name, unless it isn't their login (localized names). */
function mentionName(login, name) {
  return login && (!name || name.toLowerCase() !== login) ? login : name;
}

function normLogin(u) { return String(u || "").trim().replace(/^@/, "").toLowerCase(); }

/** Highlight rules: a phrase, a user, or a phrase only when that user says it. */
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
  if (settings.sound) ping();
  if (!settings.notify || typeof Notification === "undefined" || Notification.permission !== "granted") return;
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

$("settings-btn").addEventListener("click", openSettings);

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

  const seg = el("div", "seg");
  for (const [label, px] of [["S", 13], ["M", 14], ["L", 16], ["XL", 18]]) {
    const b = btn(label, () => { settings.fontSize = px; saveSettings(); seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); });
    if (settings.fontSize === px) b.classList.add("on");
    seg.appendChild(b);
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
    if (!settings.hidden.length) { hiddenList.appendChild(el("div", "hint", "Nobody. Tap a name in chat to hide someone.")); return; }
    for (const h of settings.hidden) {
      hiddenList.appendChild(row(h.name, btn("Show", () => { setHidden(h, false); renderHidden(); })));
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
    el("h3", null, "Appearance"),
    themeSeg,
    el("h3", null, "Chat text size"),
    seg,
    el("h3", null, "Hidden users"),
    hiddenList,
  );
}

// ---------- mobile viewport ----------

// Mobile keyboards shrink only the visual viewport (and iOS scrolls it), so size and
// position the app to whatever is actually visible.
const vv = window.visualViewport;
if (vv) {
  const app = document.querySelector(".app");
  const fit = () => {
    const stick = active && nearBottom(active);
    app.style.setProperty("--app-height", vv.height + "px");
    app.style.transform = vv.offsetTop ? "translateY(" + vv.offsetTop + "px)" : "";
    if (stick) active.list.scrollTop = active.list.scrollHeight;
  };
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
  fit();
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

applySettings();
try { localStorage.removeItem("dismissedPins"); } catch {} // left over from the removed pinned-message feature
loadExtGlobal();
refreshStatus();
// Everything that changes the status from here refreshes it (sending, the cycle toggle,
// reconnecting, coming back to the app), so this only catches changes made on another
// device or Twitch revoking access. Poll rarely, and only while visible.
setInterval(() => { if (!document.hidden) refreshStatus(); }, 5 * 60000);
