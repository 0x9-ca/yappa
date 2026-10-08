function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function renderPage(user: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>Twitch Chat</title>
<style>
  :root {
    --bg:#0e0e10; --panel:#18181b; --line:#2f2f35; --text:#efeff1; --muted:#adadb8;
    --accent:#9147ff; --accent-hover:#772ce8; --danger:#eb0400; --mention:#5c1618; --notice:#1f1a2e;
  }
  * { box-sizing:border-box; }
  /* The document never scrolls; only the message list does. */
  html, body { position:fixed; inset:0; overflow:hidden; overscroll-behavior:none; }
  body { margin:0; font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
  button, input { font:inherit; }
  button, a.btn { padding:7px 12px; border:0; border-radius:6px; background:var(--accent); color:#fff; font-weight:600; cursor:pointer; text-decoration:none; white-space:nowrap; }
  button:hover, a.btn:hover { background:var(--accent-hover); }
  button:disabled { opacity:.5; cursor:default; }
  button.ghost { background:#2f2f35; color:var(--text); }
  button.ghost:hover { background:#3a3a3d; }
  button.stop { background:var(--danger); }
  button.link { background:none; padding:0; color:var(--muted); font-weight:400; text-decoration:underline; }
  input { padding:7px 10px; border-radius:6px; border:1px solid #3a3a3d; background:var(--bg); color:var(--text); min-width:0; }
  input:focus { outline:2px solid var(--accent); outline-offset:-1px; border-color:transparent; }
  [hidden] { display:none !important; }

  .app { display:grid; grid-template-rows:auto minmax(0,1fr) auto; height:var(--app-height, 100dvh); padding-bottom:env(safe-area-inset-bottom); max-width:900px; margin:0 auto; border-inline:1px solid var(--line); background:var(--panel); }
  .top { position:sticky; top:0; z-index:10; background:var(--panel); }
  header { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; padding:10px 12px; border-bottom:1px solid var(--line); }
  header h1 { font-size:15px; margin:0; }
  header form { display:flex; gap:6px; flex:1 1 220px; }
  header form input { flex:1; }
  .cycler { display:flex; align-items:center; gap:8px; }
  .swatch { width:22px; height:22px; border-radius:5px; border:1px solid #3a3a3d; transition:background .3s; }
  .cycler code { font-size:12px; color:var(--muted); min-width:58px; }
  .account { color:var(--muted); font-size:12px; }

  .banner { padding:8px 12px; font-size:13px; border-bottom:1px solid var(--line); }
  .banner.error { background:#3a1214; color:#ffb3b3; }
  .banner.info { background:#22183a; }
  .banner a { color:#bf94ff; }

  .chat { position:relative; overflow:hidden; }
  #messages { list-style:none; margin:0; padding:8px 0; height:100%; overflow-y:auto; overscroll-behavior:contain; }
  .msg { padding:3px 12px; word-wrap:break-word; position:relative; }
  .msg:hover { background:#ffffff0a; }
  .msg .time { color:var(--muted); font-size:11px; margin-right:4px; font-variant-numeric:tabular-nums; }
  .msg .badge { width:18px; height:18px; vertical-align:-4px; margin-right:3px; }
  .msg .name { font-weight:700; }
  .msg .name.dark { text-shadow:0 0 1px #fff, 0 0 3px #ffffff80; }
  .msg .hex { font:11px ui-monospace, monospace; color:var(--muted); margin-left:4px; }
  .emote-wrap { display:inline-grid; vertical-align:middle; margin:-4px 0; }
  .emote-wrap > img { grid-area:1/1; justify-self:center; align-self:center; height:28px; }
  .msg .mention { font-weight:700; }
  .msg.mentioned { background:var(--mention); }
  .msg.deleted .body { color:var(--muted); font-style:italic; }
  .msg.cleared { opacity:.4; }
  .msg .reply-ctx { font-size:12px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .msg .reply-btn { position:absolute; right:8px; top:2px; display:none; padding:2px 8px; font-size:12px; }
  .msg:hover .reply-btn { display:block; }
  .sys { padding:4px 12px; color:var(--muted); font-size:13px; font-style:italic; }
  .notice { padding:6px 12px; margin:4px 0; background:var(--notice); border-left:3px solid var(--accent); }
  .notice .sysmsg { font-weight:600; }
  .more { position:absolute; left:50%; bottom:10px; transform:translateX(-50%); box-shadow:0 2px 8px #0008; }

  footer { position:sticky; bottom:0; z-index:10; background:var(--panel); border-top:1px solid var(--line); padding:8px 12px 12px; }
  footer .replying { display:flex; justify-content:space-between; gap:8px; font-size:12px; color:var(--muted); margin-bottom:6px; }
  footer .replying span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  footer form { display:flex; gap:8px; }
  footer form input { flex:1; padding:9px 10px; }
  #send-error { color:#ff8080; font-size:12px; margin-top:6px; }
  #emote-btn { padding:7px 9px; display:grid; place-items:center; }
  #emote-btn svg { width:18px; height:18px; }
  .picker { position:absolute; left:8px; right:8px; bottom:calc(100% + 6px); max-height:min(380px, calc(var(--app-height, 100dvh) * 0.55)); display:flex; flex-direction:column; background:#1f1f23; border:1px solid var(--line); border-radius:8px; box-shadow:0 8px 24px #000a; z-index:20; }
  .picker > input { margin:8px; }
  .picker .note { padding:0 10px 6px; font-size:12px; color:var(--muted); }
  .picker .note a { color:#bf94ff; }
  .picker .scroll { overflow-y:auto; overscroll-behavior:contain; padding:0 8px 8px; }
  .picker h3 { position:sticky; top:0; margin:0; padding:6px 2px 4px; font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); background:#1f1f23; }
  .picker .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(42px, 1fr)); gap:2px; margin-bottom:6px; }
  .picker .grid button { height:42px; padding:4px; background:none; border-radius:6px; display:grid; place-items:center; }
  .picker .grid button:hover, .picker .grid button:focus-visible { background:#ffffff1a; }
  .picker .grid img { max-height:30px; max-width:38px; }
  .picker .empty { padding:16px; text-align:center; color:var(--muted); }

  .connect { display:grid; place-items:center; text-align:center; padding:24px; }
  .connect p { color:var(--muted); max-width:320px; }
</style>
</head>
<body>
<div class="app">
  <div class="top">
  <header>
    <h1>Chat</h1>
    <form id="join-form">
      <input id="channel" placeholder="channel" autocomplete="off" spellcheck="false" aria-label="Channel">
      <button class="ghost" type="submit">Join</button>
    </form>
    <div class="cycler" id="cycler" hidden title="Your current chat color">
      <div class="swatch" id="swatch"></div>
      <code id="color">—</code>
      <button class="ghost" id="cycle">Cycle color</button>
    </div>
    <div class="account" id="account" hidden>
      <span id="login"></span> · <button class="link" id="logout">disconnect</button>
    </div>
  </header>

  <div id="banners">
    <div class="banner error" id="error" hidden></div>
    <div class="banner info" id="reauth" hidden>Twitch needs extra permissions to read and send chat. <a href="/auth/login">Reconnect Twitch</a></div>
    <div class="banner info" id="cycle-status" hidden></div>
  </div>
  </div>

  <div class="chat" id="chat" hidden>
    <ul id="messages" aria-live="polite"></ul>
    <button class="more" id="more" hidden>More messages below</button>
  </div>
  <div class="connect" id="connect" hidden>
    <div>
      <p>Connect your Twitch account to read and send chat.</p>
      <a class="btn" href="/auth/login">Connect Twitch</a>
    </div>
  </div>

  <footer id="footer" hidden>
    <div class="replying" id="replying" hidden><span id="replying-text"></span><button class="link" id="reply-cancel">cancel</button></div>
    <div class="picker" id="picker" hidden>
      <input id="emote-search" placeholder="Search emotes" autocomplete="off" spellcheck="false" aria-label="Search emotes">
      <div class="note" id="picker-note" hidden></div>
      <div class="scroll" id="picker-list"></div>
    </div>
    <form id="send-form">
      <button type="button" class="ghost" id="emote-btn" aria-label="Emotes" title="Emotes" disabled>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9.5h.01M15 9.5h.01" stroke-width="3"/></svg>
      </button>
      <input id="message" placeholder="Join a channel to chat" autocomplete="off" maxlength="500" disabled aria-label="Message">
      <button type="submit" id="send" disabled>Chat</button>
    </form>
    <div id="send-error" hidden></div>
  </footer>
</div>
<div hidden id="access-user">${escapeHtml(user)}</div>
<script>
const $ = (id) => document.getElementById(id);
const show = (id, on) => { $(id).hidden = !on; };
const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";
const MAX_MESSAGES = 500;
const DEFAULT_COLORS = ["#FF0000","#0000FF","#008000","#B22222","#FF7F50","#9ACD32","#FF4500","#2E8B57","#DAA520","#D2691E","#5F9EA0","#1E90FF","#FF69B4","#8A2BE2","#00FF7F"];

let status = null;
let me = null;               // { userId, login }
let channel = null;          // login we're joined to
let broadcaster = null;      // { id, login, name }
let badges = {};
let sock = null;             // active EventSub socket
let joinGen = 0;             // bumps on each join; stale sockets shut themselves down
let retries = 0;
let replyTo = null;
let lastSent = "";
let stvGlobal = new Map();   // 7TV emote name -> { url, zeroWidth }
let stvChannel = new Map();

function setError(msg) { $("error").textContent = msg || ""; show("error", !!msg); }
const qsError = new URLSearchParams(location.search).get("error");
if (qsError) { setError(qsError); history.replaceState(null, "", "/" + location.hash); }

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try { return await res.json(); } catch { return { ok: false, error: "Request failed (" + res.status + ")" }; }
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
  show("reauth", !!tw && tw.missingScopes.length > 0);
  if (tw) $("login").textContent = tw.login;

  const run = s.run;
  const running = !!(run && run.running);
  $("swatch").style.background = run && run.lastColor ? run.lastColor : "transparent";
  $("color").textContent = run && run.lastColor ? run.lastColor : "—";
  $("cycle").textContent = running ? "Stop cycling" : "Cycle color";
  $("cycle").className = running ? "stop" : "ghost";
  let note = "";
  if (running) note = "Cycling your color every 10s while " + run.channel + " is live · " + run.changes + " changes" + (run.lastError ? " · last error: " + run.lastError : "");
  else if (run && run.stoppedReason && Date.now() - run.stoppedAt < 10 * 60000) note = "Color cycling stopped: " + run.stoppedReason;
  $("cycle-status").textContent = note;
  show("cycle-status", !!note && !!tw);

  if (first && tw && tw.missingScopes.length === 0) {
    const initial = location.hash.slice(1) || (running ? run.channel : null) || safeGet("lastChannel");
    if (initial) join(initial);
  }
}

$("cycle").addEventListener("click", async () => {
  setError("");
  const running = status && status.run && status.run.running;
  if (running) await api("/api/stop", {});
  else {
    const target = channel || $("channel").value;
    if (!target) return setError("Join a channel first.");
    const r = await api("/api/start", { channel: target });
    if (!r.ok) setError(r.error);
  }
  refreshStatus();
});

$("logout").addEventListener("click", async () => {
  leave();
  await api("/auth/logout", {});
  status = null;
  refreshStatus();
});

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

// ---------- EventSub WebSocket ----------

$("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("channel").value.trim();
  if (v) join(v);
});

function normalizeChannel(v) {
  return v.trim().replace(/^https?:\\/\\/(www\\.)?twitch\\.tv\\//i, "").replace(/^[#@]/, "").split(/[\\/?#]/)[0].toLowerCase();
}

function leave() {
  joinGen++;
  if (sock) { sock.retired = true; sock.close(); }
  sock = null;
  broadcaster = null;
  setComposer(false);
}

function join(name) {
  name = normalizeChannel(name);
  if (!name) return;
  leave();
  channel = name;
  retries = 0;
  stvChannel = new Map();
  twitchEmotes = null;
  $("channel").value = name;
  location.hash = name;
  safeSet("lastChannel", name);
  $("messages").replaceChildren();
  sysLine("Connecting to #" + name + "…");
  openSocket(EVENTSUB_URL, joinGen, false);
}

function openSocket(url, gen, migrating) {
  const ws = new WebSocket(url);
  let keepaliveMs = 15000;
  const arm = () => {
    clearTimeout(ws.keepalive);
    ws.keepalive = setTimeout(() => ws.close(), keepaliveMs + 5000);
  };

  ws.onmessage = (e) => {
    if (gen !== joinGen) { ws.retired = true; ws.close(); return; }
    const msg = JSON.parse(e.data);
    const type = msg.metadata.message_type;
    if (type === "session_welcome") {
      keepaliveMs = (msg.payload.session.keepalive_timeout_seconds || 10) * 1000;
      const old = sock;
      sock = ws;
      if (migrating && old && old !== ws) { old.retired = true; old.close(); }
      if (!migrating) subscribe(msg.payload.session.id, gen);
    } else if (type === "session_reconnect") {
      openSocket(msg.payload.session.reconnect_url, gen, true);
    } else if (type === "notification") {
      handleEvent(msg.payload.subscription.type, msg.payload.event);
    } else if (type === "revocation") {
      sysLine("Twitch revoked " + msg.payload.subscription.type + " (" + msg.payload.subscription.status + ").");
    }
    arm();
  };

  ws.onclose = () => {
    clearTimeout(ws.keepalive);
    if (ws.retired || gen !== joinGen) return;
    if (migrating && sock !== ws) return; // failed migration; old socket is still serving
    sock = null;
    setComposer(false);
    const delay = Math.min(30000, 1000 * 2 ** retries++);
    sysLine("Disconnected. Reconnecting in " + Math.round(delay / 1000) + "s…");
    setTimeout(() => { if (gen === joinGen) openSocket(EVENTSUB_URL, gen, false); }, delay);
  };
  arm();
}

async function subscribe(sessionId, gen) {
  const r = await api("/api/chat/subscribe", { channel, session_id: sessionId });
  if (gen !== joinGen) return;
  if (!r.ok) {
    sysLine("Couldn't join #" + channel + ": " + r.error);
    const name = channel;
    leave();
    if (r.retry) setTimeout(() => { if (gen + 1 === joinGen && channel === name) join(name); }, 10000);
    return;
  }
  retries = 0;
  const firstJoin = !broadcaster;
  broadcaster = r.broadcaster;
  setComposer(true);
  sysLine("Joined #" + broadcaster.name + ".");
  if (firstJoin) {
    load7tvChannel(broadcaster.id, gen);
    const b = await api("/api/chat/badges?broadcaster_id=" + encodeURIComponent(broadcaster.id));
    if (gen === joinGen) badges = b || {};
  }
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

async function load7tvChannel(twitchId, gen) {
  let m = new Map();
  try {
    const r = await fetch("https://7tv.io/v3/users/twitch/" + encodeURIComponent(twitchId));
    if (r.ok) m = parse7tv(((await r.json()).emote_set || {}).emotes);
  } catch {}
  if (gen !== joinGen) return;
  stvChannel = m;
  sysLine(m.size ? "Loaded " + m.size + " 7TV channel emotes." : "No 7TV emotes for this channel.");
}

function find7tv(word) { return stvChannel.get(word) || stvGlobal.get(word); }

function setComposer(on) {
  $("emote-btn").disabled = !on;
  if (!on) closePicker();
  $("message").disabled = !on;
  $("send").disabled = !on;
  $("message").placeholder = on ? "Send a message" : (channel ? "Connecting…" : "Join a channel to chat");
  if (!on) setReply(null);
}

// ---------- rendering ----------

const list = $("messages");
const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 60;
list.addEventListener("scroll", () => { if (nearBottom()) show("more", false); });
$("more").addEventListener("click", () => { list.scrollTop = list.scrollHeight; show("more", false); });

function append(node) {
  const stick = nearBottom();
  list.appendChild(node);
  while (list.children.length > MAX_MESSAGES) list.firstChild.remove();
  if (stick) list.scrollTop = list.scrollHeight;
  else show("more", true);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function sysLine(text) { append(el("li", "sys", text)); }

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

function appendText(parent, text) {
  // Swap whitespace-separated words that match 7TV emote names.
  for (const part of text.split(/(\\s+)/)) {
    if (!part) continue;
    const e = /\\s/.test(part) ? null : find7tv(part);
    if (e) appendEmote(parent, emoteImg(e.url, part, "7TV"), e.zeroWidth);
    else if (parent.lastChild && parent.lastChild.nodeType === 3) parent.lastChild.textContent += part;
    else parent.appendChild(document.createTextNode(part));
  }
}

function renderFragments(parent, fragments, skipPrefix) {
  let skip = skipPrefix;
  for (const f of fragments || []) {
    if (f.type === "emote" && f.emote) {
      appendEmote(parent, emoteImg("https://static-cdn.jtvnw.net/emoticons/v2/" + f.emote.id + "/default/dark/2.0", f.text, "Twitch"), false);
    } else if (f.type === "mention") {
      if (skip && f.mention) { skip = false; continue; } // reply prefix "@user "
      parent.appendChild(el("span", "mention", f.text));
    } else {
      let t = f.text;
      if (skip && /^\\s/.test(t)) { t = t.replace(/^\\s+/, ""); skip = false; }
      appendText(parent, t);
    }
  }
}

function timeLabel() {
  return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function nameNode(ev) {
  const color = userColor(ev);
  const name = el("span", "name" + (isDark(color) ? " dark" : ""), ev.chatter_user_name);
  name.style.color = color;
  name.title = color + (ev.color ? "" : " (no color set; default)");
  return name;
}

function renderMessage(ev) {
  const li = el("li", "msg");
  li.dataset.id = ev.message_id;
  li.dataset.user = ev.chatter_user_id;

  if (ev.reply) {
    li.appendChild(el("div", "reply-ctx", "↪ Replying to @" + ev.reply.parent_user_name + ": " + ev.reply.parent_message_body));
  }
  li.appendChild(el("span", "time", timeLabel()));
  for (const b of ev.badges || []) {
    const info = badges[b.set_id + "/" + b.id];
    if (!info) continue;
    const img = el("img", "badge");
    img.src = info.url;
    img.alt = img.title = info.title;
    li.appendChild(img);
  }
  li.appendChild(nameNode(ev));
  if (me && ev.chatter_user_id === me.userId) li.appendChild(el("span", "hex", ev.color || "default"));
  li.appendChild(document.createTextNode(": "));
  const body = el("span", "body");
  renderFragments(body, ev.message.fragments, !!ev.reply);
  li.appendChild(body);

  if (me && (ev.message.fragments || []).some((f) => f.type === "mention" && f.mention && f.mention.user_id === me.userId)) {
    li.classList.add("mentioned");
  }

  const rb = el("button", "ghost reply-btn", "Reply");
  rb.addEventListener("click", () => setReply({ id: ev.message_id, user: ev.chatter_user_name, text: ev.message.text }));
  li.appendChild(rb);
  append(li);
}

function renderNotification(ev) {
  const li = el("li", "notice");
  li.dataset.user = ev.chatter_user_id || "";
  li.appendChild(el("div", "sysmsg", ev.system_message || ev.notice_type));
  if (ev.message && ev.message.text) {
    const body = el("div");
    body.appendChild(nameNode(ev));
    body.appendChild(document.createTextNode(": "));
    renderFragments(body, ev.message.fragments, false);
    li.appendChild(body);
  }
  append(li);
}

function handleEvent(type, ev) {
  switch (type) {
    case "channel.chat.message": return renderMessage(ev);
    case "channel.chat.notification": return renderNotification(ev);
    case "channel.chat.message_delete": {
      const li = list.querySelector('[data-id="' + CSS.escape(ev.message_id) + '"]');
      if (li) { li.classList.add("deleted"); li.querySelector(".body").textContent = "<message deleted>"; }
      return;
    }
    case "channel.chat.clear_user_messages":
      list.querySelectorAll('[data-user="' + CSS.escape(ev.target_user_id) + '"]').forEach((n) => n.classList.add("cleared"));
      return;
    case "channel.chat.clear":
      list.querySelectorAll(".msg, .notice").forEach((n) => n.classList.add("cleared"));
      return sysLine("Chat was cleared by a moderator.");
  }
}

// ---------- emote picker ----------

let twitchEmotes = null;     // null = not loaded; otherwise the /api/chat/emotes response
let twitchEmotesFor = null;
const TWITCH_GROUPS = ["This channel", "Other channels", "Twitch global", "Other"];
const coarse = matchMedia("(pointer: coarse)").matches;

function twitchEmoteUrl(e) {
  return "https://static-cdn.jtvnw.net/emoticons/v2/" + e.id + "/" + (e.animated ? "animated" : "static") + "/dark/2.0";
}

function escapeText(t) {
  const d = document.createElement("div");
  d.textContent = t;
  return d.innerHTML;
}

function recentEmotes() {
  try { return JSON.parse(localStorage.getItem("recentEmotes") || "[]"); } catch { return []; }
}

function rememberEmote(name, url) {
  const list = [{ name, url }, ...recentEmotes().filter((e) => e.name !== name)].slice(0, 24);
  safeSet("recentEmotes", JSON.stringify(list));
}

async function openPicker() {
  show("picker", true);
  if (!coarse) $("emote-search").focus();
  renderPicker();
  if (broadcaster && twitchEmotesFor !== broadcaster.id) {
    const id = broadcaster.id;
    twitchEmotesFor = id;
    twitchEmotes = null;
    const r = await api("/api/chat/emotes?broadcaster_id=" + encodeURIComponent(id));
    if (!broadcaster || broadcaster.id !== id) return;
    twitchEmotes = r;
    if (!r.ok && !r.needsScope) twitchEmotesFor = null; // allow a retry next open
    if (!$("picker").hidden) {
      renderPicker();
      if (r.retry) setTimeout(() => { if (!$("picker").hidden && twitchEmotesFor === null) openPicker(); }, 10000);
    }
  }
}

function closePicker() {
  show("picker", false);
  $("emote-search").value = "";
}

function renderPicker() {
  const q = $("emote-search").value.trim().toLowerCase();
  const match = (name) => !q || name.toLowerCase().includes(q);
  const sections = [];
  const add = (title, items) => {
    items = items.filter((e) => match(e.name));
    if (items.length) sections.push([title, items]);
  };
  const stv = (m) => [...m].map(([name, e]) => ({ name, url: e.url }));
  const tw = (group) => twitchEmotes && twitchEmotes.ok
    ? twitchEmotes.emotes.filter((e) => e.group === group).map((e) => ({ name: e.name, url: twitchEmoteUrl(e) }))
    : [];

  if (!q) add("Recent", recentEmotes());
  add("Twitch · this channel", tw("This channel"));
  add("7TV · this channel", stv(stvChannel));
  add("Twitch · your other subs", tw("Other channels"));
  add("Twitch · global", tw("Twitch global"));
  add("7TV · global", stv(stvGlobal));
  add("Twitch · other", tw("Other"));

  let note = "";
  if (twitchEmotes === null && broadcaster) note = "Loading your Twitch emotes…";
  else if (twitchEmotes && twitchEmotes.needsScope) note = '<a href="/auth/login">Reconnect Twitch</a> to include your Twitch emotes.';
  else if (twitchEmotes && !twitchEmotes.ok) note = "Couldn't load Twitch emotes: " + escapeText(twitchEmotes.error || "unknown error");
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
  const text = (before && !/\\s$/.test(before) ? " " : "") + name + (/^\\s/.test(after) ? "" : " ");
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
document.addEventListener("pointerdown", (e) => {
  if (!$("picker").hidden && !e.target.closest("#picker, #emote-btn")) closePicker();
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

$("message").addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" && !$("message").value && lastSent) { $("message").value = lastSent; e.preventDefault(); }
  if (e.key === "Escape") { if (!$("picker").hidden) closePicker(); else setReply(null); }
});

$("send-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("message");
  const text = input.value.trim();
  if (!text || !broadcaster) return;
  $("send").disabled = true;
  show("send-error", false);
  const r = await api("/api/chat/send", {
    broadcaster_id: broadcaster.id,
    message: text,
    reply_parent_message_id: replyTo ? replyTo.id : undefined,
  });
  $("send").disabled = !broadcaster;
  if (r.ok) {
    lastSent = text;
    input.value = "";
    setReply(null);
    closePicker();
  } else {
    $("send-error").textContent = r.error;
    show("send-error", true);
  }
  input.focus();
});

window.addEventListener("hashchange", () => {
  const h = normalizeChannel(location.hash.slice(1));
  if (h && h !== channel && me) join(h);
});

// Mobile keyboards shrink only the visual viewport (and iOS scrolls it), so size and
// position the app to whatever is actually visible.
const vv = window.visualViewport;
if (vv) {
  const app = document.querySelector(".app");
  const fit = () => {
    const stick = nearBottom();
    app.style.setProperty("--app-height", vv.height + "px");
    app.style.transform = vv.offsetTop ? "translateY(" + vv.offsetTop + "px)" : "";
    if (stick) list.scrollTop = list.scrollHeight;
  };
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
  fit();
}

load7tvGlobal();
refreshStatus();
setInterval(refreshStatus, 5000);
</script>
</body>
</html>`;
}
