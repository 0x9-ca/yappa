"use strict";

const $ = (id) => document.getElementById(id);
const show = (id, on) => { $(id).hidden = !on; };
const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";
const MAX_MESSAGES = 500;
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
let stvGlobal = new Map();     // 7TV emote name -> { url, zeroWidth }
let lastSocketMsgAt = 0;       // any frame (incl. keepalives) proves the socket is alive
let keepaliveMs = 15000;
let resumedAt = Date.now();    // when the page last became visible / unfrozen
let reconnectTimer = null;
let hiddenUnread = 0;

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
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try { return await res.json(); } catch { return { ok: false, error: "Request failed (" + res.status + ")" }; }
}

function setError(msg) { $("error").textContent = msg || ""; show("error", !!msg); }
const qsError = new URLSearchParams(location.search).get("error");
if (qsError) { setError(qsError); history.replaceState(null, "", "/" + location.hash); }

function normalizeChannel(v) {
  return String(v || "").trim().replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "").replace(/^[#@]/, "").split(/[/?#]/)[0].toLowerCase();
}

// ---------- status / color cycling ----------

async function refreshStatus() {
  let s;
  try { s = await api("/api/status"); } catch { return; }
  const first = status === null;
  status = s;
  const tw = s.twitch;
  me = tw ? { userId: tw.userId, login: tw.login } : null;
  show("connect", !tw);
  show("chat", !!tw);
  show("footer", !!tw);
  show("account", !!tw);
  show("cycler", !!tw);
  show("tabs", !!tw && tabs.size > 0);
  show("reauth", !!tw && tw.missingScopes.length > 0);
  const missingOptional = tw && tw.missingScopes.length === 0 ? tw.missingOptionalScopes || [] : [];
  show("reauth-optional", missingOptional.length > 0);
  if (tw) $("login").textContent = tw.login;

  renderCycle(s.cycle);
  if (first && tw && tw.missingScopes.length === 0) restoreTabs(null);
}

function renderCycle(cycle) {
  cycle = cycle || { enabled: false, changes: 0 };
  $("swatch").style.background = cycle.lastColor || "transparent";
  $("color").textContent = cycle.lastColor ? cycle.lastColor + " - " + cycle.changes : "—";
  $("cycle").textContent = cycle.enabled ? "Stop cycling" : "Cycle color";
  $("cycle").className = cycle.enabled ? "stop" : "ghost";
  $("cycler").title = cycle.enabled ? "Your color changes every time you send a message" : "Your current chat color";
  const note = cycle.lastError ? (cycle.enabled ? "Color cycling error: " : "Color cycling turned off: ") + cycle.lastError : "";
  $("cycle-status").textContent = note;
  show("cycle-status", !!note && !!me);
}

$("cycle").addEventListener("click", async () => {
  setError("");
  const enabled = !(status && status.cycle && status.cycle.enabled);
  $("cycle").disabled = true;
  const r = await api("/api/cycle", { enabled });
  $("cycle").disabled = false;
  if (!r.ok) setError(r.error);
  refreshStatus();
});

$("logout").addEventListener("click", async () => {
  for (const t of [...tabs.values()]) closeTab(t, { keepSaved: true });
  dropSocket();
  await api("/auth/logout", {});
  status = null;
  refreshStatus();
});

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
      login: name, broadcaster: null, isMod: null, subIds: [], badges: {}, stv: new Map(),
      twitchEmotes: null, unread: 0, mentioned: false, joined: false, chatters: new Map(), loadedExtras: false,
      seen: new Set(), lastTs: 0,
      list: el("ul", "messages"), tabEl: null,
    };
    tab.list.hidden = true;
    tab.list.setAttribute("aria-live", "polite");
    tab.list.addEventListener("scroll", () => { if (tab === active && nearBottom(tab)) show("more", false); });
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
  btn.append(dot, name, mod, unread);
  btn.addEventListener("click", () => activate(tab));
  const close = el("button", "tab-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close " + tab.login);
  close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(tab); });
  wrap.append(btn, close);
  $("tabs").appendChild(wrap);
  tab.tabEl = { wrap, name, mod, unread };
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
    else { history.replaceState(null, "", "/"); updateComposer(); }
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

  ws.onclose = () => {
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
  };
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
  if (Date.now() - lastSocketMsgAt > keepaliveMs + 5000) sock.close();
}, 2000);

function onResume() {
  resumedAt = Date.now();
  if (document.hidden) return;
  hiddenUnread = 0;
  updateTitle();
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
  updateTabEl(tab);
  // Messages we missed (or, on first join, recent history) get inserted above this line.
  const marker = sysLine(tab, (rejoin ? "Reconnected to #" : "Joined #") + r.broadcaster.name + "." + (r.isMod && !rejoin ? " You're a moderator here." : ""));
  if (tab === active) updateComposer();
  if (!tab.loadedExtras) {
    tab.loadedExtras = true;
    await loadTabExtras(tab);
  }
  backfill(tab, marker, range);
}

/**
 * Twitch has no chat history API, so fetch recent messages from the public
 * recent-messages service (as Chatterino and other clients do) and insert any we
 * haven't shown: the gap while disconnected, or recent history on first join.
 */
async function backfill(tab, marker, { since, until }) {
  let lines = [];
  try {
    const r = await fetch("https://recent-messages.robotty.de/api/v2/recent-messages/" + encodeURIComponent(tab.login) + "?limit=100");
    if (r.ok) lines = (await r.json()).messages || [];
  } catch {}
  if (!tabs.has(tab.login) || !marker.isConnected) return;
  const firstJoin = !since;
  let added = 0;
  let firstAdded = null;
  for (const line of lines) {
    const ev = ircToEvent(line);
    // Newer than `until` arrives live over EventSub; already-seen ids are skipped in renderMessage.
    if (!ev || ev.ts <= since || ev.ts > until || tab.seen.has(ev.message_id)) continue;
    renderMessage(tab, ev, { before: marker, historical: firstJoin });
    firstAdded = firstAdded || marker.previousElementSibling;
    added++;
  }
  if (firstJoin && firstAdded) insertBefore(tab, el("li", "sys", "— recent messages —"), firstAdded);
  else if (!firstJoin && added) marker.textContent += " Caught up on " + added + " missed message" + (added === 1 ? "" : "s") + ".";
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
    historical: true,
  };
}

async function loadTabExtras(tab) {
  const id = tab.broadcaster.id;
  const [badges, stv, emotes] = await Promise.all([
    api("/api/chat/badges?broadcaster_id=" + encodeURIComponent(id)),
    load7tvChannel(id),
    api("/api/chat/emotes?broadcaster_id=" + encodeURIComponent(id)),
  ]);
  tab.badges = badges || {};
  tab.stv = stv;
  tab.twitchEmotes = emotes;
  if (stv.size) sysLine(tab, "Loaded " + stv.size + " 7TV channel emotes.");
  if (tab === active && !$("picker").hidden) renderPicker();
}

function tabForBroadcaster(id) {
  for (const t of tabs.values()) if (t.broadcaster && t.broadcaster.id === id) return t;
  return null;
}

function updateComposer() {
  const on = !!(active && active.joined && sock);
  $("message").disabled = !on;
  $("send").disabled = !on;
  $("emote-btn").disabled = !on;
  $("message").placeholder = on
    ? "Send a message" + (active.isMod ? " (mod: /ban /timeout /unban /clear)" : "")
    : (active ? "Connecting…" : "Open a channel to chat");
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

// ---------- 7TV ----------

function parse7tv(emotes) {
  const m = new Map();
  for (const e of emotes || []) {
    const host = e.data && e.data.host;
    if (!host) continue;
    m.set(e.name, { url: "https:" + host.url + "/2x.webp", zeroWidth: (e.flags & 1) === 1 });
  }
  return m;
}

async function load7tvGlobal() {
  try {
    const r = await fetch("https://7tv.io/v3/emote-sets/global");
    if (r.ok) stvGlobal = parse7tv((await r.json()).emotes);
  } catch {}
}

async function load7tvChannel(twitchId) {
  try {
    const r = await fetch("https://7tv.io/v3/users/twitch/" + encodeURIComponent(twitchId));
    if (r.ok) return parse7tv(((await r.json()).emote_set || {}).emotes);
  } catch {}
  return new Map();
}

function find7tv(tab, word) { return tab.stv.get(word) || stvGlobal.get(word); }

// ---------- rendering ----------

const nearBottom = (tab) => tab.list.scrollHeight - tab.list.scrollTop - tab.list.clientHeight < 60;
$("more").addEventListener("click", () => {
  if (active) active.list.scrollTop = active.list.scrollHeight;
  show("more", false);
});

function insertBefore(tab, node, ref) {
  const stick = tab !== active || nearBottom(tab);
  tab.list.insertBefore(node, ref);
  if (stick) tab.list.scrollTop = tab.list.scrollHeight;
}

function append(tab, node, countsAsUnread) {
  const list = tab.list;
  const stick = tab !== active || nearBottom(tab);
  list.appendChild(node);
  while (list.children.length > MAX_MESSAGES) list.firstChild.remove();
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

function isDark(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.06;
}

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

function appendText(tab, parent, text) {
  // Swap whitespace-separated words that match 7TV emote names.
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    const e = /\s/.test(part) ? null : find7tv(tab, part);
    if (e) appendEmote(parent, emoteImg(e.url, part, "7TV"), e.zeroWidth);
    else if (parent.lastChild && parent.lastChild.nodeType === 3) parent.lastChild.textContent += part;
    else parent.appendChild(document.createTextNode(part));
  }
}

function renderFragments(tab, parent, fragments, skipPrefix) {
  let skip = skipPrefix;
  for (const f of fragments || []) {
    if (f.type === "emote" && f.emote) {
      appendEmote(parent, emoteImg("https://static-cdn.jtvnw.net/emoticons/v2/" + f.emote.id + "/default/dark/2.0", f.text, "Twitch"), false);
    } else if (f.type === "mention") {
      if (skip && f.mention) { skip = false; continue; } // reply prefix "@user "
      parent.appendChild(el("span", "mention", f.text));
    } else {
      let t = f.text;
      if (skip && /^\s/.test(t)) { t = t.replace(/^\s+/, ""); skip = false; }
      appendText(tab, parent, t);
    }
  }
}

function timeLabel(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function nameNode(ev) {
  const color = userColor(ev);
  const name = el("span", "name" + (isDark(color) ? " dark" : ""), ev.chatter_user_name);
  name.style.color = color;
  name.title = color + (ev.color ? "" : " (no color set; default)");
  return name;
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
  li.appendChild(nameNode(ev));
  const mine = me && ev.chatter_user_id === me.userId;
  if (mine) li.appendChild(el("span", "hex", ev.color || "default"));
  li.appendChild(document.createTextNode(": "));
  const body = el("span", "body");
  renderFragments(tab, body, ev.message.fragments, !!ev.reply);
  li.appendChild(body);

  const mentioned = me && (ev.message.fragments || []).some((f) => (f.type === "mention" && f.mention && f.mention.user_id === me.userId) || f.mentionsMe);
  if (mentioned) li.classList.add("mentioned");

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
  if (ev.first || ev.message_type === "user_intro" || firstMsgIds.has(ev.message_id)) addFlag(li, "first", "First-time chatter");

  if (opts.before) {
    insertBefore(tab, li, opts.before);
    if (!opts.historical && tab !== active) { tab.unread++; updateTabEl(tab); }
  } else {
    append(tab, li, true);
  }
  if (mentioned && tab !== active && !opts.historical) { tab.mentioned = true; updateTabEl(tab); }
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
  const tab = tabForBroadcaster(ev.broadcaster_user_id);
  if (!tab) return;
  if (ts) ev.ts = ts;
  const list = tab.list;
  switch (type) {
    case "channel.chat.message": return renderMessage(tab, ev);
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
  const li = e.target.closest(".msg");
  const wasSelected = li && li.classList.contains("selected");
  document.querySelectorAll(".msg.selected").forEach((n) => n.classList.remove("selected"));
  if (li && !wasSelected && !e.target.closest(".actions")) li.classList.add("selected");
});

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
  if (tab) for (const [name, e] of tab.stv) push(name, e.url, "7TV");
  for (const [name, e] of stvGlobal) push(name, e.url, "7TV");
  return out;
}

// ---------- emote picker ----------

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
  const stv = (m) => [...m].map(([name, e]) => ({ name, url: e.url }));
  const tw = (group) => tab && tab.twitchEmotes && tab.twitchEmotes.ok
    ? tab.twitchEmotes.emotes.filter((e) => e.group === group).map((e) => ({ name: e.name, url: twitchEmoteUrl(e) }))
    : [];

  if (!q) add("Recent", recentEmotes());
  add("Twitch · this channel", tw("This channel"));
  if (tab) add("7TV · this channel", stv(tab.stv));
  add("Twitch · your other subs", tw("Other channels"));
  add("Twitch · global", tw("Twitch global"));
  add("7TV · global", stv(stvGlobal));
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
  const input = $("message");
  const v = input.value;
  const start = input.selectionStart ?? v.length;
  const end = input.selectionEnd ?? v.length;
  const before = v.slice(0, start), after = v.slice(end);
  const text = (before && !/\s$/.test(before) ? " " : "") + name + (/^\s/.test(after) ? "" : " ");
  if ((before + text + after).length > 500) return;
  input.value = before + text + after;
  const pos = before.length + text.length;
  input.setSelectionRange(pos, pos);
  if (!coarse) input.focus();
}

$("emote-btn").addEventListener("click", () => ($("picker").hidden ? openPicker() : closePicker()));
$("emote-search").addEventListener("input", renderPicker);
$("emote-search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closePicker(); $("message").focus(); }
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
  const input = $("message");
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos);
  const m = /(\S+)$/.exec(before);
  if (!m) return null;
  // Only complete when the cursor is at the end of the word.
  if (/^\S/.test(input.value.slice(pos))) return null;
  return { text: m[1], start: pos - m[1].length, end: pos };
}

function computeSuggestions(word) {
  if (!active) return [];
  if (word.startsWith("@")) {
    const q = word.slice(1).toLowerCase();
    const names = [...active.chatters.values()].reverse();
    const out = [];
    for (const n of names) {
      if (n.toLowerCase().startsWith(q) && !out.includes(n)) out.push(n);
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
  const input = $("message");
  const v = input.value;
  const after = v.slice(w.end);
  const insert = s.name + (/^\s/.test(after) ? "" : " ");
  input.value = v.slice(0, w.start) + insert + after;
  const pos = w.start + insert.length;
  input.setSelectionRange(pos, pos);
  if (s.url) rememberEmote(s.name, s.url);
  closeSuggest();
  input.focus();
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
  if (e.key === "ArrowUp" && !$("message").value && lastSent) { $("message").value = lastSent; e.preventDefault(); }
  if (e.key === "Escape") { if (!$("picker").hidden) closePicker(); else setReply(null); }
});

document.addEventListener("pointerdown", (e) => {
  if (!$("picker").hidden && !e.target.closest("#picker, #emote-btn")) closePicker();
  if (!$("suggest").hidden && !e.target.closest("#suggest, #message")) closeSuggest();
});

// ---------- sending ----------

function setReply(r) {
  replyTo = r;
  show("replying", !!r);
  if (r) {
    $("replying-text").textContent = "Replying to @" + r.user + ": " + r.text;
    $("message").focus();
  }
}
$("reply-cancel").addEventListener("click", () => setReply(null));

$("send-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("message");
  const text = input.value.trim();
  const tab = active;
  if (!text || !tab || !tab.broadcaster) return;
  closeSuggest();
  if (runCommand(tab, text)) {
    lastSent = text;
    input.value = "";
    return;
  }
  $("send").disabled = true;
  show("send-error", false);
  const r = await api("/api/chat/send", {
    broadcaster_id: tab.broadcaster.id,
    message: text,
    reply_parent_message_id: replyTo ? replyTo.id : undefined,
  });
  updateComposer();
  if (r.ok) {
    lastSent = text;
    input.value = "";
    setReply(null);
    closePicker();
    if (status && status.cycle && status.cycle.enabled) refreshStatus(); // show the new color now
  } else {
    $("send-error").textContent = r.error;
    show("send-error", true);
  }
  input.focus();
});

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

load7tvGlobal();
refreshStatus();
setInterval(refreshStatus, 5000);
