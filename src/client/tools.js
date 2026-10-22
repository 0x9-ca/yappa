// Moderator tools, whispers, your Twitch block list, the subscription chip, go-live alerts and
// discovery. Loaded after app.js: it shares app.js's globals (el, btn, api, openSheet, tabs,
// settings, ...) and talks to it through the `window.tools*` hooks at the bottom.
"use strict";

(() => {

// ---------- shared bits ----------

const sheetShows = (marker) => { const c = $("sheet-body").firstElementChild; return !!(c && c.dataset[marker]) && !$("sheet").hidden; };

function textBox(value, max, placeholder, onInput) {
  const i = document.createElement("input");
  i.type = "text";
  i.value = value;
  i.maxLength = max;
  i.placeholder = placeholder;
  i.autocomplete = "off";
  i.addEventListener("input", () => onInput(i.value));
  return i;
}

function reconnectNote(what) {
  const p = el("p", "hint");
  const a = el("a", null, "Reconnect Twitch");
  a.href = "/auth/login";
  p.append(a, " to allow " + what + ".");
  return p;
}

/** A desktop/phone notification, from the service worker where the browser requires it. */
function systemNotify(title, body, tag, tabLogin) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const opts = { body, tag, icon: "/icons/icon-192.png", data: tabLogin ? { tab: tabLogin } : undefined };
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, opts)).catch(() => {});
  } else {
    try { const n = new Notification(title, opts); n.onclick = () => { window.focus(); if (tabLogin) openTab(tabLogin); }; } catch {}
  }
}

const say = (text, kind) => { if (active) sysLine(active, text, kind); };

// ---------- moderator tools (sheet) ----------

const COLORS = [["primary", "Channel color"], ["blue", "Blue"], ["green", "Green"], ["orange", "Orange"], ["purple", "Purple"]];
const SLOW_OPTIONS = [0, 3, 5, 10, 20, 30, 60, 120];
const FOLLOW_OPTIONS = [[-1, "Off"], [0, "Any follower"], [10, "10 min"], [30, "30 min"], [60, "1 hour"], [1440, "1 day"], [10080, "1 week"], [43200, "1 month"], [129600, "3 months"]];

const mt = {
  channel: null, tab: "modes", err: "", note: "", busy: false, needs: {}, filter: "",
  terms: null, shield: null, unbans: null, chatters: null, banned: null,
  form: { announce: "", color: "primary", shout: "", term: "", unbanNote: "" },
};

function openMod() {
  const tab = active;
  if (!tab || !tab.isMod || !tab.broadcaster) return;
  mt.channel = tab;
  mt.err = mt.note = "";
  mt.needs = {};
  mt.terms = mt.shield = mt.unbans = mt.chatters = mt.banned = null;
  renderMod();
  loadMod(mt.tab);
}

async function loadMod(which, after) {
  const path = { terms: "/api/mod/terms", shield: "/api/mod/shield", unbans: "/api/mod/unbans", chatters: "/api/mod/chatters", banned: "/api/mod/banned" }[which];
  if (!path || !mt.channel) return;
  const r = await api(path + "?broadcaster_id=" + encodeURIComponent(mt.channel.broadcaster.id) + (after ? "&after=" + encodeURIComponent(after) : ""));
  if (r.needsScope) mt.needs[which === "unbans" || which === "terms" || which === "shield" || which === "chatters" || which === "banned" ? mt.tab : which] = true;
  else if (!r.ok) mt.err = r.error;
  else if (which === "banned") mt.banned = { list: [...(after && mt.banned ? mt.banned.list : []), ...r.bans], cursor: r.cursor, q: (mt.banned && mt.banned.q) || "" };
  else if (which === "terms") mt.terms = r.terms;
  else if (which === "shield") mt.shield = r.active;
  else if (which === "unbans") { mt.unbans = r.requests; mt.channel.unbanCount = r.requests.length; window.toolsRenderInfo(active); }
  else mt.chatters = { total: r.total, names: r.names };
  if (sheetShows("modtools")) renderMod();
}

/** Runs one request, then shows what came of it. */
async function modDo(path, body, after) {
  if (mt.busy) return;
  mt.busy = true;
  mt.err = mt.note = "";
  renderMod();
  const r = await api(path, body);
  mt.busy = false;
  if (r.needsScope) mt.needs[mt.tab] = true;
  else if (!r.ok) mt.err = r.error;
  else after(r);
  if (sheetShows("modtools")) renderMod();
}

/** Chat modes: the same switches as Twitch's own chat settings. */
function modesPanel(body) {
  const tab = mt.channel, st = tab.settings || {};
  const select = (options, value, onChange) => dropdown(options, value, (v) => onChange(Number(v)));
  const toggle = (checked, onChange) => {
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = !!checked;
    c.addEventListener("change", () => onChange(c.checked));
    return c;
  };
  const update = async (patch) => {
    const r = await api("/api/chat/settings", { broadcaster_id: tab.broadcaster.id, ...patch });
    if (r.ok) { if (r.settings) tab.settings = r.settings; mt.err = ""; }
    else mt.err = "Couldn't change chat modes: " + r.error;
    if (tab === active) renderInfo();
    if (sheetShows("modtools")) renderMod();
  };
  const grid = el("div", "modes-grid");
  grid.append(
    el("span", null, "Slow mode"),
    select(SLOW_OPTIONS.map((v) => [v, v ? v + "s" : "Off"]), st.slow_mode ? st.slow_mode_wait_time || 30 : 0, (v) => update(v ? { slow_mode: true, slow_mode_wait_time: v } : { slow_mode: false })),
    el("span", null, "Followers-only"),
    select(FOLLOW_OPTIONS, st.follower_mode ? st.follower_mode_duration || 0 : -1, (v) => update(v < 0 ? { follower_mode: false } : { follower_mode: true, follower_mode_duration: v })),
    el("span", null, "Subscribers-only"), toggle(st.subscriber_mode, (on) => update({ subscriber_mode: on })),
    el("span", null, "Emote-only"), toggle(st.emote_mode, (on) => update({ emote_mode: on })),
    el("span", null, "Unique chat (no repeats)"), toggle(st.unique_chat_mode, (on) => update({ unique_chat_mode: on })),
  );
  body.appendChild(grid);
}

window.toolsModesChanged = (tab) => { if (tab === mt.channel && mt.tab === "modes" && sheetShows("modtools")) renderMod(); };

function modPanel(body) {
  const id = mt.channel.broadcaster.id, f = mt.form;
  if (mt.tab === "modes") {
    modesPanel(body);
  } else if (mt.tab === "announce") {
    body.append(
      el("p", "hint", "Highlighted in chat for everyone, in the color you pick."),
      textBox(f.announce, 500, "Announcement", (t) => { f.announce = t; }),
      el("label", "tool-label", "Color "),
    );
    body.lastChild.appendChild(dropdown(COLORS, f.color, (v) => { f.color = v; }));
    body.appendChild(btn("Send announcement", () => modDo("/api/mod/announce", { broadcaster_id: id, message: f.announce, color: f.color }, () => { f.announce = ""; mt.note = "Announcement sent."; }), "small"));
  } else if (mt.tab === "shout") {
    body.append(
      el("p", "hint", "Point chat at another channel. Twitch limits how often shoutouts can be sent."),
      textBox(f.shout, 50, "Channel to shout out", (t) => { f.shout = t; }),
      btn("Send shoutout", () => modDo("/api/mod/shoutout", { broadcaster_id: id, to_login: f.shout }, (r) => { f.shout = ""; mt.note = "Shouted out " + r.target + "."; }), "small"),
    );
  } else if (mt.tab === "terms") {
    if (mt.terms === null) { body.appendChild(el("div", "hint", "Loading…")); return; }
    body.append(
      el("p", "hint", "Messages containing these words or phrases are held back. " + mt.terms.length + " blocked."),
      textBox(f.term, 500, "Add a word or phrase", (t) => { f.term = t; }),
      btn("Block this term", () => modDo("/api/mod/terms", { broadcaster_id: id, text: f.term }, (r) => { mt.terms.unshift(r.term); f.term = ""; mt.note = "Term blocked."; }), "small"),
    );
    const list = el("div", "tool-list");
    for (const t of mt.terms) {
      const row = el("div", "tool-row");
      row.append(el("span", null, t.text), btn("Remove", () => modDo("/api/mod/terms/remove", { broadcaster_id: id, id: t.id }, () => { mt.terms = mt.terms.filter((x) => x.id !== t.id); mt.note = "Term removed."; }), "small ghost"));
      list.appendChild(row);
    }
    body.appendChild(list);
  } else if (mt.tab === "banned") {
    if (mt.banned === null) { body.appendChild(el("div", "hint", "Loading…")); return; }
    const b = mt.banned;
    body.appendChild(el("p", "hint", b.list.length + " banned or timed out" + (b.cursor ? " so far (more to load)" : "") + ". Timeouts drop off by themselves when they run out."));
    const find = textBox(b.q, 50, "Find someone in the list", (v) => { b.q = v; renderBanList(); });
    find.id = "ban-find";
    body.appendChild(find);
    const list = el("div", "tool-list");
    list.id = "ban-list";
    body.appendChild(list);
    const renderBanList = () => {
      const qq = b.q.trim().toLowerCase().replace(/^@/, "");
      const shown = b.list.filter((x) => !qq || x.login.includes(qq) || x.name.toLowerCase().includes(qq));
      list.replaceChildren(...(shown.length ? shown.map((x) => {
        const row = el("div", "tool-row ban-row");
        const info = el("div", "ban-info");
        info.appendChild(el("b", null, x.name));
        const until = x.expiresAt ? "Timed out until " + new Date(x.expiresAt).toLocaleString() : "Banned";
        info.appendChild(el("div", "hint", until + (x.by ? " by " + x.by : "") + " · " + new Date(x.bannedAt).toLocaleDateString()));
        if (x.reason) info.appendChild(el("div", "hint", "“" + x.reason + "”"));
        row.append(info, btn("Unban", () => modDo("/api/chat/mod", { broadcaster_id: id, action: "unban", user_id: x.userId, login: x.login }, () => { b.list = b.list.filter((y) => y.userId !== x.userId); mt.note = "Unbanned " + x.name + "."; }), "small"));
        return row;
      }) : [el("div", "hint", b.list.length ? "Nobody in the list matches." : "Nobody is banned.")]));
    };
    renderBanList();
    if (b.cursor) body.appendChild(btn("Load more", () => loadMod("banned", b.cursor), "small ghost"));
  } else if (mt.tab === "shield") {
    if (mt.shield === null) { body.appendChild(el("div", "hint", "Loading…")); return; }
    body.append(
      el("p", "hint", "Shield Mode applies the channel's pre-set restrictions at once (for raids of trolls and the like)."),
      el("p", null, "Shield Mode is " + (mt.shield ? "ON" : "off") + "."),
      btn(mt.shield ? "Turn Shield Mode off" : "Turn Shield Mode on", () => modDo("/api/mod/shield", { broadcaster_id: id, active: !mt.shield }, (r) => { mt.shield = r.active; mt.note = r.active ? "Shield Mode is on." : "Shield Mode is off."; }), mt.shield ? "small" : "small stop"),
    );
  } else if (mt.tab === "unbans") {
    if (mt.unbans === null) { body.appendChild(el("div", "hint", "Loading…")); return; }
    if (!mt.unbans.length) { body.appendChild(el("div", "hint", "No pending unban requests.")); return; }
    body.append(textBox(f.unbanNote, 500, "Note to send with your answer (optional)", (t) => { f.unbanNote = t; }));
    for (const r of mt.unbans) {
      const card = el("div", "tool-card");
      card.append(el("b", null, r.name), el("span", "hint", " · " + since(r.createdAt) + " ago"), el("div", null, r.text || "(no message)"));
      const row = el("div", "tool-actions");
      for (const [status, label] of [["approved", "Unban"], ["denied", "Deny"]]) {
        row.appendChild(btn(label, () => modDo("/api/mod/unbans", { broadcaster_id: id, id: r.id, status, text: f.unbanNote }, () => {
          mt.unbans = mt.unbans.filter((x) => x.id !== r.id);
          mt.channel.unbanCount = mt.unbans.length;
          mt.note = status === "approved" ? r.name + " was unbanned." : "Request denied.";
          window.toolsRenderInfo(active);
        }), status === "denied" ? "small stop" : "small"));
      }
      card.appendChild(row);
      body.appendChild(card);
    }
  } else if (mt.tab === "chatters") {
    if (mt.chatters === null) { body.appendChild(el("div", "hint", "Loading…")); return; }
    const q = mt.filter.toLowerCase();
    const names = mt.chatters.names.filter((n) => !q || n.toLowerCase().includes(q));
    body.append(
      el("p", "hint", mt.chatters.total.toLocaleString() + " in chat" + (mt.chatters.total > mt.chatters.names.length ? " (first " + mt.chatters.names.length.toLocaleString() + " shown)" : "") + ". Viewers who aren't signed in don't appear."),
      textBox(mt.filter, 50, "Find someone", (t) => { mt.filter = t; renderChatterList(); }),
    );
    const list = el("div", "tool-chatters");
    list.id = "tool-chatters";
    body.appendChild(list);
    renderChatterList(body);
  }
}

function renderChatterList(scope) {
  const list = (scope || document).querySelector("#tool-chatters");
  if (!list || !mt.chatters) return;
  const q = mt.filter.toLowerCase();
  const names = mt.chatters.names.filter((n) => !q || n.toLowerCase().includes(q)).slice(0, 300);
  list.replaceChildren(...(names.length ? names.map((n) => el("span", "chatter", n)) : [el("span", "hint", "Nobody matches.")]));
}

function renderMod() {
  const root = el("div", "tools modtools");
  root.dataset.modtools = "1";
  root.appendChild(el("h2", null, "Mod tools: #" + mt.channel.broadcaster.name));
  const tabs = el("div", "browse-tabs");
  const unbanN = mt.channel.unbanCount || 0;
  for (const [id, label] of [["modes", "Chat modes"], ["announce", "Announce"], ["shout", "Shoutout"], ["terms", "Blocked terms"], ["banned", "Banned"], ["shield", "Shield Mode"], ["unbans", "Unbans" + (unbanN ? " (" + unbanN + ")" : "")], ["chatters", "Chatters"]]) {
    tabs.appendChild(btn(label, () => { mt.tab = id; mt.err = mt.note = ""; renderMod(); loadMod(id); }, mt.tab === id ? "on" : ""));
  }
  root.appendChild(tabs);
  if (mt.err) root.appendChild(el("div", "tool-msg err", mt.err));
  else if (mt.note) root.appendChild(el("div", "tool-msg", mt.note));
  const body = el("div", "tool-body");
  if (mt.needs[mt.tab]) body.appendChild(reconnectNote("this moderator tool"));
  else modPanel(body);
  if (mt.busy) body.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  root.appendChild(body);
  $("sheet-body").replaceChildren(root);
  show("sheet", true);
  if (mt.tab === "chatters" && mt.chatters) renderChatterList(root);
}

$("modtools-btn").addEventListener("click", openMod);

// ---------- user card extras ----------

window.toolsUserCardActions = (tab, u) => {
  const out = [];
  const bid = tab.broadcaster && tab.broadcaster.id;
  const isMe = me && u.id === me.userId;
  const isBroadcaster = bid && u.id === bid;
  if (tab.isMod && bid && !isMe && !isBroadcaster) {
    if (hasScope("moderator:manage:warnings")) {
      out.push(btn("Warn", async () => {
        const reason = prompt("Warning for " + u.name + " (they must acknowledge it before they can chat again):");
        if (!reason || !reason.trim()) return;
        closeSheet();
        const r = await api("/api/mod/warn", { broadcaster_id: bid, user_id: u.id, reason });
        say(r.ok ? "Warned " + u.name + "." : "Couldn't warn " + u.name + ": " + r.error, r.ok ? undefined : "err");
      }, "small"));
    }
    if (hasScope("moderator:manage:suspicious_users")) {
      for (const [label, status, said] of [["Monitor", "ACTIVE_MONITORING", "is now monitored"], ["Restrict", "RESTRICTED", "is now restricted"], ["Clear mark", "NONE", "is no longer marked"]]) {
        out.push(btn(label, async () => {
          closeSheet();
          const r = await api("/api/mod/suspicious", { broadcaster_id: bid, user_id: u.id, status });
          say(r.ok ? u.name + " " + said + "." : "Couldn't change " + u.name + "'s status: " + r.error, r.ok ? undefined : "err");
        }, "small"));
      }
    }
  }
  if (tab.isMod && bid && u.login && !isMe && hasScope("moderator:manage:shoutouts")) {
    out.push(btn("Shout out", async () => {
      closeSheet();
      const r = await api("/api/mod/shoutout", { broadcaster_id: bid, to_login: u.login });
      say(r.ok ? "Shouted out " + r.target + "." : "Couldn't send the shoutout: " + r.error, r.ok ? undefined : "err");
    }, "small"));
  }
  const note = settings.notes && settings.notes[u.id];
  if (note && (note.note || note.label)) out.push(el("div", "card-note", (note.label ? note.label + ": " : "") + (note.note || "")));
  out.push(btn(note ? "Edit note" : "Add note", () => openNoteEditor(tab, u), "small"));
  if (!isMe && hasScope("user:manage:whispers")) out.push(btn("Whisper", () => { closeSheet(); openWhisper({ id: u.id, login: u.login, name: u.name }); }, "small"));
  if (!isMe && hasScope("user:manage:blocked_users")) {
    const blocked = blockedIds.has(u.id);
    out.push(btn(blocked ? "Unblock" : "Block", async () => {
      if (!blocked && !confirm("Block " + u.name + " on Twitch? They can't whisper you or interact with you anywhere on Twitch.")) return;
      closeSheet();
      const r = await api("/api/blocks", { user_id: u.id, block: !blocked });
      if (!r.ok) { say("Couldn't " + (blocked ? "unblock " : "block ") + u.name + ": " + r.error, "err"); return; }
      if (blocked) blockedIds.delete(u.id); else blockedIds.add(u.id);
      applyBlocked();
      say((blocked ? "Unblocked " : "Blocked ") + u.name + ".");
    }, blocked ? "small" : "small stop"));
  }
  return out;
};

// ---------- feeds from EventSub ----------

const fmtSecs = (n) => (n >= 86400 ? Math.round(n / 86400) + "d" : n >= 3600 ? Math.round(n / 3600) + "h" : n >= 60 ? Math.round(n / 60) + "m" : n + "s");

function describeMod(ev) {
  const who = ev.moderator_user_name || ev.moderator_user_login || "A moderator";
  const a = ev.action;
  const o = ev[a] || {};
  const target = o.user_name || o.user_login || "someone";
  switch (a) {
    case "ban": return who + " banned " + target + (o.reason ? ": " + o.reason : "");
    case "timeout": return who + " timed out " + target + (o.expires_at ? " for " + fmtSecs(Math.max(1, Math.round((Date.parse(o.expires_at) - Date.now()) / 1000))) : "") + (o.reason ? ": " + o.reason : "");
    case "unban": return who + " unbanned " + target;
    case "untimeout": return who + " ended " + target + "'s timeout";
    case "delete": return who + " deleted a message from " + target + (o.message_body ? ": “" + o.message_body.slice(0, 100) + "”" : "");
    case "clear": return who + " cleared the chat";
    case "warn": return who + " warned " + target + (o.reason ? ": " + o.reason : "");
    case "vip": return who + " made " + target + " a VIP";
    case "unvip": return who + " removed " + target + "'s VIP";
    case "mod": return who + " made " + target + " a moderator";
    case "unmod": return who + " removed " + target + " as a moderator";
    case "raid": return who + " started a raid on " + target;
    case "unraid": return who + " canceled the raid";
    case "slow": return who + " turned on slow mode (" + o.wait_time_seconds + "s)";
    case "slowoff": return who + " turned off slow mode";
    case "followers": return who + " turned on followers-only" + (o.follow_duration_minutes ? " (" + o.follow_duration_minutes + " min)" : "");
    case "followersoff": return who + " turned off followers-only";
    case "subscribers": return who + " turned on subscribers-only";
    case "subscribersoff": return who + " turned off subscribers-only";
    case "emoteonly": return who + " turned on emote-only";
    case "emoteonlyoff": return who + " turned off emote-only";
    case "uniquechat": return who + " turned on unique chat";
    case "uniquechatoff": return who + " turned off unique chat";
    case "approve_unban_request": return who + " approved an unban request" + (o.user_name ? " from " + o.user_name : "");
    case "deny_unban_request": return who + " denied an unban request" + (o.user_name ? " from " + o.user_name : "");
    case "add_blocked_term": case "add_permitted_term": case "remove_blocked_term": case "remove_permitted_term": return who + ": " + String(a).replace(/_/g, " ");
    default: return a ? who + ": " + String(a).replace(/_/g, " ") : "";
  }
}

const SUSPICIOUS_WORDS = { active_monitoring: "monitored", restricted: "restricted" };

function suspiciousLabel(ev) {
  const bits = [];
  if (SUSPICIOUS_WORDS[ev.low_trust_status]) bits.push(SUSPICIOUS_WORDS[ev.low_trust_status]);
  if (ev.ban_evasion_evaluation === "likely") bits.push("likely ban evader");
  else if (ev.ban_evasion_evaluation === "possible") bits.push("possible ban evader");
  if ((ev.types || []).includes("banned_in_shared_channel")) bits.push("banned in a shared channel");
  return "Suspicious user" + (bits.length ? " (" + bits.join(", ") + ")" : "");
}

window.toolsHandleEvent = (type, ev, tab, ts) => {
  if (type === "channel.suspicious_user.message") {
    const id = ev.message && ev.message.message_id;
    if (!id) return;
    const label = suspiciousLabel(ev);
    tab.suspicious = tab.suspicious || new Map();
    tab.suspicious.set(id, label);
    if (tab.suspicious.size > 200) tab.suspicious.delete(tab.suspicious.keys().next().value);
    const li = tab.list.querySelector('.msg[data-id="' + CSS.escape(id) + '"]');
    if (li) addFlag(li, "suspicious", label);
  } else if (type === "channel.moderate") {
    if (settings.modLog) { const text = describeMod(ev); if (text) sysLine(tab, text, "modlog"); }
  } else if (type === "channel.unban_request.create") {
    tab.unbanCount = (tab.unbanCount || 0) + 1;
    sysLine(tab, (ev.user_name || ev.user_login) + " asked to be unbanned" + (ev.text ? ": “" + ev.text.slice(0, 200) + "”" : "."), "modlog");
    if (document.hidden || tab !== active) systemNotify("Unban request in #" + (tab.broadcaster ? tab.broadcaster.name : tab.login), (ev.user_name || ev.user_login) + (ev.text ? ": " + ev.text : ""), "unban-" + ev.id, tab.login);
    if (tab === active) window.toolsRenderInfo(tab);
  } else if (type === "user.whisper.message") {
    incomingWhisper(ev, ts);
  }
};

// ---------- whispers ----------

const wh = { threads: new Map(), unread: 0 }; // userId -> { id, login, name, msgs: [{ mine, text, ts }], unread }

function whisperThread(u) {
  let t = wh.threads.get(u.id);
  if (!t) { t = { id: u.id, login: u.login, name: u.name, msgs: [], unread: 0 }; wh.threads.set(u.id, t); }
  return t;
}

function updateWhisperDot() {
  $("profile-btn").classList.toggle("has-whisper", wh.unread > 0);
}

function incomingWhisper(ev, ts) {
  const t = whisperThread({ id: ev.from_user_id, login: ev.from_user_login, name: ev.from_user_name });
  t.msgs.push({ mine: false, text: (ev.whisper && ev.whisper.text) || "", ts: ts || Date.now() });
  if (t.msgs.length > 100) t.msgs.shift();
  const viewing = sheetShows("whispers") && wh.open === t.id;
  if (!viewing) { t.unread++; wh.unread++; updateWhisperDot(); }
  if (viewing) renderWhispers();
  if (document.hidden || !viewing) systemNotify("Whisper from " + t.name, (ev.whisper && ev.whisper.text) || "", "whisper-" + ev.whisper_id, null);
  if (settings.sound && !viewing) ping();
}

function openWhispers() {
  wh.open = null;
  renderWhispers();
}

function openWhisper(u) {
  const t = whisperThread(u);
  wh.open = t.id;
  wh.unread -= t.unread;
  t.unread = 0;
  updateWhisperDot();
  renderWhispers();
}

let whisperDraft = "";
let whisperErr = "";

function renderWhispers() {
  const root = el("div", "tools");
  root.dataset.whispers = "1";
  root.appendChild(el("h2", null, "Whispers"));
  const t = wh.open && wh.threads.get(wh.open);
  if (!hasScope("user:manage:whispers")) {
    root.appendChild(reconnectNote("sending and receiving whispers"));
  } else if (!t) {
    root.appendChild(el("p", "hint", "Private messages between you and one other person. Twitch requires a verified phone number on your account to send them, and they aren't saved here: closing the app clears them."));
    const list = el("div", "tool-list");
    const threads = [...wh.threads.values()].sort((a, b) => (b.msgs.at(-1)?.ts || 0) - (a.msgs.at(-1)?.ts || 0));
    for (const th of threads) {
      const row = btn("", () => openWhisper(th), "ghost tool-thread");
      row.append(el("b", null, th.name), el("span", "hint", " " + ((th.msgs.at(-1) || {}).text || "").slice(0, 60)));
      if (th.unread) row.appendChild(el("span", "unread", String(th.unread)));
      list.appendChild(row);
    }
    if (!threads.length) list.appendChild(el("div", "hint", "No whispers yet. Tap someone's name in chat, then Whisper."));
    root.appendChild(list);
  } else {
    root.appendChild(btn("← All whispers", openWhispers, "small ghost"));
    root.appendChild(el("h3", null, t.name));
    const log = el("div", "whisper-log");
    for (const m of t.msgs) log.appendChild(el("div", "whisper-msg" + (m.mine ? " mine" : ""), m.text));
    if (!t.msgs.length) log.appendChild(el("div", "hint", "No messages yet."));
    root.appendChild(log);
    if (whisperErr) root.appendChild(el("div", "tool-msg err", whisperErr));
    const input = textBox(whisperDraft, 500, "Whisper to " + t.name, (v) => { whisperDraft = v; });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") send.click(); });
    const send = btn("Send", async () => {
      const text = whisperDraft.trim();
      if (!text) return;
      send.disabled = true;
      const r = await api("/api/whisper", { user_id: t.id, message: text });
      if (!r.ok) { whisperErr = r.error; } else { whisperErr = ""; whisperDraft = ""; t.msgs.push({ mine: true, text, ts: Date.now() }); }
      if (sheetShows("whispers")) renderWhispers();
    }, "small");
    const row = el("div", "tool-option");
    row.append(input, send);
    root.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }
  $("sheet-body").replaceChildren(root);
  show("sheet", true);
}

window.toolsAccountItems = (item) => {
  const out = [];
  if (active) out.push(item("Settings for #" + (active.broadcaster ? active.broadcaster.name : active.login), () => openChannelSettings(active)));
  if (hasScope("user:manage:whispers")) out.push(item("Whispers" + (wh.unread ? " (" + wh.unread + ")" : ""), openWhispers));
  out.push(item("Bookmarks" + ((settings.bookmarks || []).length ? " (" + settings.bookmarks.length + ")" : ""), openBookmarks));
  out.push(item("Mentions" + (mentionsUnread ? " (" + Math.min(mentionsUnread, 99) + ")" : ""), openMentions));
  if (tabs.size > 1) out.push(item("All chats in one feed", openCombined));
  out.push(item(document.querySelector(".app").classList.contains("focus") ? "Leave focus mode" : "Focus mode", () => setFocus(!document.querySelector(".app").classList.contains("focus"))));
  out.push(item("Quick switcher", openSwitcher));
  out.push(item("Discover streams", openDiscover));
  if (active && active.list.querySelector(".msg")) {
    out.push(item("Save this chat (text)", () => exportChat("txt")));
    out.push(item("Save this chat (JSON)", () => exportChat("json")));
  }
  if (!coarse) out.push(item("Keyboard shortcuts", openShortcuts));
  return out;
};

window.toolsOnSession = (sid) => {
  if (hasScope("user:read:whispers")) api("/api/whispers/subscribe", { session_id: sid });
  setTimeout(loadBlocks, 3000); // not needed to show chat; leave the first seconds to joining channels
};

// ---------- your Twitch block list ----------

function applyBlocked() {
  document.querySelectorAll(".msg[data-user]").forEach((n) => n.classList.toggle("ignored", isHidden(n.dataset.user) || !!n.dataset.muted));
}

async function loadBlocks() {
  if (!hasScope("user:read:blocked_users") || settings.syncBlocks === false) return;
  const r = await api("/api/blocks");
  if (!r.ok) return;
  blockedIds.clear();
  for (const u of r.users) blockedIds.add(u.id);
  applyBlocked();
}
window.toolsReloadBlocks = () => { blockedIds.clear(); applyBlocked(); loadBlocks(); };

// ---------- info bar: subscription chip, mod tools button ----------

const subCache = new Map(); // broadcaster id -> { at, sub }
const TIER = { "1000": "Tier 1", "2000": "Tier 2", "3000": "Tier 3" };

function renderSub(tab) {
  const chip = $("sub-chip");
  const c = tab && tab.broadcaster && subCache.get(tab.broadcaster.id);
  if (!c || !c.sub) { chip.hidden = true; return; }
  const tier = TIER[c.sub.tier] || "";
  chip.hidden = false;
  chip.textContent = "Sub" + (tier ? " · " + tier.replace("Tier ", "T") : "");
  chip.title = "You're subscribed to " + tab.broadcaster.name + (tier ? " (" + tier + ")" : "") + (c.sub.isGift ? ", a gift" + (c.sub.gifter ? " from " + c.sub.gifter : "") : "") + ".";
}

async function refreshSub(tab) {
  if (!hasScope("user:read:subscriptions") || !tab.broadcaster || (me && tab.broadcaster.id === me.userId)) return;
  const hit = subCache.get(tab.broadcaster.id);
  if (hit && Date.now() - hit.at < 10 * 60000) return;
  subCache.set(tab.broadcaster.id, { at: Date.now(), sub: null }); // one lookup at a time
  const r = await api("/api/sub?broadcaster_id=" + encodeURIComponent(tab.broadcaster.id));
  if (!r.ok) { subCache.delete(tab.broadcaster.id); return; }
  subCache.set(tab.broadcaster.id, { at: Date.now(), sub: r.sub });
  if (tab === active) renderSub(tab);
}

window.toolsRenderInfo = (tab) => {
  const b = $("modtools-btn"), count = $("modtools-count");
  const mod = !!(tab && tab.isMod && tab.broadcaster);
  b.hidden = !mod;
  count.hidden = !(mod && tab.unbanCount);
  count.textContent = mod && tab.unbanCount ? String(Math.min(tab.unbanCount, 99)) : "";
  b.title = b.ariaLabel = "Mod tools" + (mod && tab.unbanCount ? ": " + tab.unbanCount + " unban request" + (tab.unbanCount === 1 ? "" : "s") : "");
  renderSub(tab);
  if (tab) refreshSub(tab);
};

// ---------- go-live alerts ----------

let liveSeen = null;

const liveMode = (login) => (settings.channels && settings.channels[login] && settings.channels[login].live) || "default";

async function pollLive() {
  if (!me || !hasScope("user:read:follows")) return;
  if (!settings.liveAlerts && !Object.values(settings.channels || {}).some((c) => c.live === "on")) return;
  const r = await api("/api/following");
  if (!r.ok) return;
  following = r;
  followingAt = Date.now();
  const seen = liveSeen;
  liveSeen = new Set(r.live.map((c) => c.id));
  if (!seen) return; // the first look only learns who's already live
  for (const c of r.live) if (!seen.has(c.id)) announceLive(c);
}

function announceLive(c) {
  const mode = liveMode(c.login);
  if (mode === "off" || (mode !== "on" && !settings.liveAlerts)) return;
  systemNotify(c.name + " is live", (c.game ? c.game + " · " : "") + c.title, "live-" + c.id, c.login);
  if (!active) return;
  const li = el("li", "sys live-note");
  li.append(c.name + " went live" + (c.game ? " (" + c.game + ")" : "") + ": " + c.title + " ");
  li.appendChild(btn("Open", () => openTab(c.login), "small"));
  append(active, li, false);
}

setInterval(pollLive, 120000);
window.toolsPollLive = pollLive; // (the tests drive it directly)
window.toolsLiveSettingChanged = () => {
  liveSeen = null;
  if (settings.liveAlerts) {
    if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    pollLive();
  }
};

// ---------- discovery ----------

const ds = { q: "", game: null, gameName: "", channels: [], streams: [], cats: [], cursor: null, loading: false, err: "", mode: "top", req: 0 };

function openDiscover() {
  ds.q = ""; ds.game = null; ds.gameName = ""; ds.mode = "top"; ds.channels = ds.streams = ds.cats = []; ds.cursor = null; ds.err = "";
  renderDiscover();
  loadDiscover(true);
}

let discoverTimer = null;

async function loadDiscover(reset) {
  const mode = ds.mode;
  const req = ++ds.req;
  if (reset) { ds.channels = []; ds.streams = []; ds.cursor = null; }
  ds.loading = true; ds.err = "";
  renderDiscover();
  if (mode === "search") {
    const [chans, cats] = await Promise.all([
      api("/api/discover/search?q=" + encodeURIComponent(ds.q) + (ds.cursor ? "&after=" + encodeURIComponent(ds.cursor) : "")),
      reset ? api("/api/discover/categories?q=" + encodeURIComponent(ds.q)) : Promise.resolve(null),
    ]);
    if (req !== ds.req) return;
    ds.loading = false;
    if (!chans.ok) ds.err = chans.error; else { ds.channels.push(...chans.channels); ds.cursor = chans.cursor; }
    if (cats && cats.ok) ds.cats = cats.categories;
  } else {
    const r = await api("/api/discover/top" + (ds.game || ds.cursor ? "?" : "") + [ds.game ? "game_id=" + ds.game : "", ds.cursor ? "after=" + encodeURIComponent(ds.cursor) : ""].filter(Boolean).join("&"));
    if (req !== ds.req) return;
    ds.loading = false;
    if (!r.ok) ds.err = r.error; else { ds.streams.push(...r.streams); ds.cursor = r.cursor; }
  }
  if (sheetShows("discover")) renderDiscover();
}

function renderDiscover() {
  const root = el("div", "tools discover");
  root.dataset.discover = "1";
  root.appendChild(el("h2", null, "Discover streams"));
  const box = textBox(ds.q, 100, "Search channels and categories", (t) => {
    ds.q = t;
    clearTimeout(discoverTimer);
    discoverTimer = setTimeout(() => {
      ds.game = null; ds.gameName = "";
      ds.mode = ds.q.trim() ? "search" : "top";
      loadDiscover(true);
    }, 350);
  });
  root.appendChild(box);
  if (ds.mode === "search" && ds.cats.length) {
    const chips = el("div", "browse-tabs");
    for (const c of ds.cats.slice(0, 6)) chips.appendChild(btn(c.name, () => { ds.mode = "top"; ds.game = c.id; ds.gameName = c.name; ds.q = ""; loadDiscover(true); }, "small ghost"));
    root.appendChild(chips);
  }
  if (ds.mode === "top") {
    const head = el("div", "tool-head");
    head.appendChild(el("b", null, ds.game ? "Live in " + ds.gameName : "Top live streams"));
    if (ds.game) head.appendChild(btn("All categories", () => { ds.game = null; ds.gameName = ""; loadDiscover(true); }, "small ghost"));
    root.appendChild(head);
  }
  const rows = ds.mode === "search" ? ds.channels : ds.streams;
  for (const x of rows) {
    const row = el("div", "disc-row");
    if (x.thumbnail) { const img = document.createElement("img"); img.src = x.thumbnail; img.alt = ""; img.loading = "lazy"; row.appendChild(img); }
    const meta = el("div", "disc-meta");
    meta.append(el("b", null, x.name + (x.live === false ? " (offline)" : "")), el("div", "hint", (x.game ? x.game + " · " : "") + (x.title || "")));
    if (x.viewers != null) meta.appendChild(el("div", "hint", compactCount(x.viewers) + " watching"));
    row.append(meta, btn("Open", () => { closeSheet(); openTab(x.login); }, "small"));
    root.appendChild(row);
  }
  if (ds.loading) root.appendChild(el("div", "hint", "Loading…"));
  else if (ds.err) root.appendChild(el("div", "tool-msg err", ds.err));
  else if (!rows.length) root.appendChild(el("div", "hint", ds.mode === "search" ? "No channels found." : "Nothing live right now."));
  else if (ds.cursor) root.appendChild(btn("Load more", () => loadDiscover(false), "small ghost"));
  $("sheet-body").replaceChildren(root);
  show("sheet", true);
  if (document.activeElement === document.body && !coarse) box.focus();
}

// Typing in the channel box also searches Twitch for channels you don't follow.
let findTimer = null;
window.toolsFollowExtra = (q, box) => {
  clearTimeout(findTimer);
  if (q.length < 2) return;
  findTimer = setTimeout(async () => {
    const r = await api("/api/discover/search?q=" + encodeURIComponent(q));
    if (!r.ok || !r.channels.length || $("follow-list").hidden || $("channel").value.trim().replace(/^[#@]/, "").toLowerCase() !== q) return;
    box.appendChild(el("div", "fl-head", "On Twitch"));
    for (const c of r.channels.slice(0, 6)) {
      const b = el("button", "fl-row" + (c.live ? " live" : ""));
      b.type = "button";
      b.dataset.find = c.login;
      b.append(el("span", c.live ? "dot" : "dot off"), el("span", "fl-name", c.name), el("span", "fl-sub", c.live ? (c.game || "") : "offline"));
      b.addEventListener("click", () => { closeFollowList(); $("channel").value = ""; openTab(c.login); });
      box.appendChild(b);
    }
  }, (window.__timing || {}).find || 350);
};

// ---------- mentions across channels ----------

const mentionLog = []; // newest first; kept in memory only
let mentionsUnread = 0; // added since the sheet was last opened
const MAX_MENTIONS = 200;

window.toolsMention = (tab, ev, kind) => {
  mentionLog.unshift({
    login: tab.login, channel: tab.broadcaster ? tab.broadcaster.name : tab.login, id: ev.message_id,
    user: ev.chatter_user_name, color: ev.color || "", text: ev.message.text, ts: ev.ts || Date.now(), kind,
  });
  if (mentionLog.length > MAX_MENTIONS) mentionLog.pop();
  mentionsUnread++;
  if (sheetShows("mentions")) { mentionsUnread = 0; renderMentions(); }
};

function openMentions() {
  mentionsUnread = 0;
  renderMentions();
}

function renderMentions() {
  const root = el("div", "tools");
  root.dataset.mentions = "1";
  root.appendChild(el("h2", null, "Mentions"));
  root.appendChild(el("p", "hint", "Messages that @mention you or match a highlight rule, from every open channel since you opened Yappa. Tap one to go to that chat."));
  const list = el("div", "tool-list");
  for (const m of mentionLog) {
    const row = el("button", "mention-row");
    row.type = "button";
    const head = el("div", "mr-head");
    const who = el("b", null, m.user);
    if (m.color) who.style.color = m.color;
    head.append(el("span", "shared-pill", m.channel), who, el("span", "hint", " " + timeLabel(m.ts) + (m.kind === "highlight" ? " · highlight" : "")));
    row.append(head, el("div", "mr-text", m.text));
    row.addEventListener("click", () => { closeSheet(); openTab(m.login); });
    list.appendChild(row);
  }
  if (!mentionLog.length) list.appendChild(el("div", "hint", "Nothing yet."));
  root.appendChild(list);
  $("sheet-body").replaceChildren(root);
  show("sheet", true);
}

// ---------- all chats in one feed ----------

const COMBINED_PER_TAB = 25, COMBINED_MAX = 300;
let combinedList = null;

function combinedLine(tab, li) {
  const c = li.cloneNode(true);
  c.querySelectorAll(".actions, .clip-card").forEach((n) => n.remove());
  c.classList.remove("selected", "filtered");
  const pill = el("span", "shared-pill", tab.broadcaster ? tab.broadcaster.name : tab.login);
  c.insertBefore(pill, c.querySelector(".time") ? c.querySelector(".time").nextSibling : c.firstChild);
  c.dataset.channel = tab.login;
  return c;
}

function openCombined() {
  const root = el("div", "tools");
  root.dataset.combined = "1";
  root.appendChild(el("h2", null, "All chats"));
  root.appendChild(el("p", "hint", "Every open channel in one feed, newest at the bottom. Read-only: tap a line to go to that chat."));
  const list = el("ul", "messages combined");
  list.style.setProperty("--chat-font", settings.fontSize + "px");
  list.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-channel]");
    if (li) { closeSheet(); openTab(li.dataset.channel); }
  });
  const lines = [];
  for (const t of tabs.values()) {
    for (const li of [...t.list.querySelectorAll(".msg:not(.ignored)")].slice(-COMBINED_PER_TAB)) lines.push([Number(li.dataset.ts) || 0, t, li]);
  }
  lines.sort((a, b) => a[0] - b[0]);
  for (const [, t, li] of lines) list.appendChild(combinedLine(t, li));
  if (!lines.length) list.appendChild(el("li", "sys", "Nothing yet. New messages from your open channels will show up here."));
  root.appendChild(list);
  combinedList = list;
  $("sheet-body").replaceChildren(root);
  show("sheet", true);
  list.scrollTop = list.scrollHeight;
}

window.toolsMirror = (tab, li, ev) => {
  if (ev) autoTranslate(tab, li, ev);
  if (!sheetShows("combined") || !combinedList || !combinedList.isConnected) return;
  const stick = combinedList.scrollHeight - combinedList.scrollTop - combinedList.clientHeight < 40;
  const placeholder = combinedList.querySelector("li.sys");
  if (placeholder) placeholder.remove();
  combinedList.appendChild(combinedLine(tab, li));
  while (combinedList.children.length > COMBINED_MAX) combinedList.firstChild.remove();
  if (stick) combinedList.scrollTop = combinedList.scrollHeight;
};

// ---------- stream stats: uptime and viewers over time ----------

const CONTENT_LABELS = {
  DebatedSocialAndPoliticalIssuesAndCurrentEvents: "Politics and sensitive social issues",
  DrugsIntoxication: "Drugs, intoxication or excessive tobacco use",
  Gambling: "Gambling",
  MatureGame: "Mature-rated game",
  ProfanityVulgarity: "Significant profanity or vulgarity",
  SexualThemes: "Sexual themes",
  ViolentGraphic: "Violent and graphic depictions",
};

function languageName(code) {
  try { return new Intl.DisplayNames([navigator.language || "en"], { type: "language" }).of(code) || code; } catch { return code; }
}

/** The channel info sheet: what the channel says about itself, plus live numbers while it's streaming. */
function openChannelInfo() {
  const tab = active;
  if (!tab || !tab.broadcaster) return;
  const st = tab.stream;
  const name = tab.broadcaster.name || tab.login;
  const root = el("div", "tools chan-info");
  root.dataset.stats = "1";
  root.dataset.chaninfo = "1";
  const head = el("div", "ci-head");
  const avatar = document.createElement("img");
  avatar.className = "ci-avatar";
  avatar.alt = "";
  avatar.hidden = true;
  const names = el("div", "ci-names");
  names.append(el("h2", null, name), el("div", "hint", "@" + tab.login));
  head.append(avatar, names);
  root.appendChild(head);
  const actions = el("div", "card-actions");
  actions.append(btn("Clips and VODs", () => { closeSheet(); $("clips-btn").click(); }, "small"), btn("Open on Twitch", () => launchers.window(twitchLinks(tab.login).web, "_blank"), "small ghost"));
  root.appendChild(actions);
  root.appendChild(el("p", "ci-title", st ? st.title : "Offline right now."));
  const extra = el("div", "chan-extra");
  extra.appendChild(el("div", "hint", "Loading channel info…"));
  root.appendChild(extra);
  if (st) {
    const samples = tab.viewerSamples || [];
    const peak = samples.reduce((m, s) => Math.max(m, s[1]), st.viewer_count);
    const facts = el("div", "stat-facts");
    for (const [k, v] of [["Live for", since(st.started_at)], ["Viewers now", st.viewer_count.toLocaleString()], ["Peak while you watched", peak.toLocaleString()], ["Category", st.game_name || "None"]]) {
      const f = el("div", "stat");
      f.append(el("div", "hint", k), el("b", null, v));
      facts.appendChild(f);
    }
    root.appendChild(facts);
    root.appendChild(el("h3", null, "Viewers since you opened this channel"));
    root.appendChild(sparkline(samples));
  }
  $("sheet-body").replaceChildren(root);
  show("sheet", true);
  api("/api/channel/info?broadcaster_id=" + encodeURIComponent(tab.broadcaster.id)).then((r) => {
    if (!root.isConnected) return;
    extra.replaceChildren();
    if (!r || !r.ok) { extra.appendChild(el("div", "hint", r && r.error ? r.error : "Couldn't load the channel info.")); return; }
    const c = r.channel;
    if (c.avatar) { avatar.src = c.avatar; avatar.hidden = false; }
    const facts = [];
    if (!st && c.game) facts.push(["Last category", c.game]);
    if (c.language) facts.push(["Language", languageName(c.language)]);
    if (c.type) facts.push(["Account", c.type[0].toUpperCase() + c.type.slice(1)]);
    if (c.createdAt) facts.push(["On Twitch since", new Date(c.createdAt).toLocaleDateString()]);
    if (facts.length) {
      const grid = el("div", "stat-facts");
      for (const [k, v] of facts) { const f = el("div", "stat"); f.append(el("div", "hint", k), el("b", null, v)); grid.appendChild(f); }
      extra.appendChild(grid);
    }
    if (c.tags.length) { const tags = el("div", "ci-tags"); for (const g of c.tags) tags.appendChild(el("span", "chip", g)); extra.appendChild(tags); }
    const flags = [...c.labels.map((l) => CONTENT_LABELS[l] || l), ...(c.branded ? ["Paid promotion"] : [])];
    if (flags.length) { const f = el("div", "ci-flags"); for (const x of flags) f.appendChild(el("span", "chip warn", x)); extra.appendChild(f); }
    if (c.about) { extra.appendChild(el("h3", null, "About")); extra.appendChild(el("p", "ci-about", c.about)); }
  });
}

function sparkline(samples) {
  const NS = "http://www.w3.org/2000/svg";
  const W = 300, H = 70;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.setAttribute("class", "sparkline");
  svg.setAttribute("role", "img");
  if (samples.length < 2) {
    svg.setAttribute("aria-label", "Not enough data yet");
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", "0"); t.setAttribute("y", "40"); t.setAttribute("fill", "currentColor");
    t.textContent = "Collecting… (a point is added every minute)";
    svg.appendChild(t);
    return svg;
  }
  const t0 = samples[0][0], t1 = samples[samples.length - 1][0];
  const lo = Math.min(...samples.map((s) => s[1])), hi = Math.max(...samples.map((s) => s[1]));
  const span = Math.max(hi - lo, 1);
  const pts = samples.map((s) => ((s[0] - t0) / Math.max(t1 - t0, 1) * (W - 4) + 2).toFixed(1) + "," + (H - 6 - (s[1] - lo) / span * (H - 12)).toFixed(1));
  svg.setAttribute("aria-label", "Viewers from " + lo.toLocaleString() + " to " + hi.toLocaleString() + " over " + Math.round((t1 - t0) / 60000) + " minutes");
  const line = document.createElementNS(NS, "polyline");
  line.setAttribute("points", pts.join(" "));
  line.setAttribute("fill", "none"); line.setAttribute("stroke", "var(--accent)"); line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-linejoin", "round"); line.setAttribute("stroke-linecap", "round");
  svg.appendChild(line);
  return svg;
}

$("live").addEventListener("click", () => { if (active && active.broadcaster) openChannelInfo(); });

// ---------- slow mode countdown ----------

// Informational only: VIPs and some other roles are exempt and we can't tell, so it never blocks sending.
let slowTimer = null;
const slowNote = $("slow-note");

function slowTick() {
  const tab = active;
  const left = tab && tab.slowUntil ? Math.ceil((tab.slowUntil - Date.now()) / 1000) : 0;
  if (left > 0) {
    slowNote.textContent = "Slow mode: you can chat again in " + left + "s";
    slowNote.hidden = false;
  } else {
    slowNote.hidden = true;
    if (tab) tab.slowUntil = 0;
    clearInterval(slowTimer);
    slowTimer = null;
  }
}

function slowEnsureTicking() {
  if (slowTimer) return;
  slowTimer = setInterval(slowTick, 500);
  slowTick();
}

window.toolsSent = (tab) => {
  const wait = tab.settings && tab.settings.slow_mode ? tab.settings.slow_mode_wait_time || 30 : 0;
  if (!wait || tab.isMod || (me && tab.broadcaster && tab.broadcaster.id === me.userId)) return;
  tab.slowUntil = Date.now() + wait * 1000;
  if (tab === active) slowEnsureTicking();
};
window.toolsActivated = (tab) => {
  slowNote.hidden = true;
  if (tab && tab.slowUntil > Date.now()) slowEnsureTicking();
};

// ---------- export a chat ----------

function exportChat(format) {
  const tab = active;
  if (!tab) return;
  const rows = [...tab.list.querySelectorAll(".msg:not(.ignored)")].map((li) => ({
    time: Number(li.dataset.ts) || 0,
    user: (li.querySelector(".name") || {}).textContent || "",
    text: (li.querySelector(".body") || {}).innerText || (li.querySelector(".body") || {}).textContent || "",
  }));
  const channel = tab.broadcaster ? tab.broadcaster.name : tab.login;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const body = format === "json"
    ? JSON.stringify({ channel, exported: new Date().toISOString(), messages: rows.map((r) => ({ ...r, time: new Date(r.time).toISOString() })) }, null, 2)
    : rows.map((r) => "[" + new Date(r.time).toLocaleString() + "] " + r.user + ": " + r.text).join("\n") + "\n";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type: format === "json" ? "application/json" : "text/plain" }));
  a.download = channel + "-chat-" + stamp + "." + (format === "json" ? "json" : "txt");
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  sysLine(tab, "Saved " + rows.length + " message" + (rows.length === 1 ? "" : "s") + " as " + a.download + ".");
}
window.toolsExport = exportChat;

// ---------- keyboard shortcuts ----------

function openShortcuts() {
  const root = el("div", "tools");
  root.dataset.shortcuts = "1";
  root.appendChild(el("h2", null, "Keyboard shortcuts"));
  const list = el("div", "shortcut-list");
  for (const [keys, what] of [
    ["Alt + 1 … 9", "Go to that tab"], ["Alt + ←  /  →", "Previous / next tab"], ["Alt + W", "Close this tab"],
    ["Alt + V", "Show or hide the video"], ["Alt + F", "Focus mode: just the chat and tabs"], ["Alt + M", "Mentions"], ["Alt + A", "All chats in one feed"],
    ["Ctrl + K  (⌘ K)", "Quick switcher: tabs, channels, settings, actions"], ["/", "Jump to the message box"], ["?", "This list"], ["Esc", "Close a sheet or menu"],
  ]) {
    const r = el("div", "row");
    r.append(el("kbd", null, keys), el("span", null, what));
    list.appendChild(r);
  }
  root.appendChild(list);
  $("sheet-body").replaceChildren(root);
  show("sheet", true);
}

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey) return;
  const typing = e.target.closest && e.target.closest("input, textarea, [contenteditable='true']");
  if (e.altKey) { // (Alt+digits and Alt+W are in app.js)
    const list = [...tabs.values()];
    const i = active ? list.indexOf(active) : -1;
    if (e.key === "ArrowLeft" && list.length > 1) { activate(list[(i - 1 + list.length) % list.length]); e.preventDefault(); }
    else if (e.key === "ArrowRight" && list.length > 1) { activate(list[(i + 1) % list.length]); e.preventDefault(); }
    else if (e.code === "KeyV") { $("video-btn").click(); e.preventDefault(); }
    else if (e.code === "KeyF") { setFocus(!document.querySelector(".app").classList.contains("focus")); e.preventDefault(); }
    else if (e.code === "KeyM") { openMentions(); e.preventDefault(); }
    else if (e.code === "KeyA") { openCombined(); e.preventDefault(); }
    return;
  }
  if (typing) return;
  if (e.key === "/" && active) { composer.focus(); e.preventDefault(); }
  else if (e.key === "?") { openShortcuts(); e.preventDefault(); }
});

// ---------- settings for one channel ----------

const CHAN_CHOICES = [["default", "Same as Settings"], ["on", "Always"], ["off", "Never"]];

function setChan(login, patch) {
  const cur = { ...(settings.channels[login] || {}), ...patch };
  for (const k of Object.keys(cur)) {
    const v = cur[k];
    if (v === "default" || v === undefined || (Array.isArray(v) && !v.length)) delete cur[k];
  }
  if (Object.keys(cur).length) settings.channels[login] = cur; else delete settings.channels[login];
  saveSettings();
}

let chanRowIds = 0;
function openChannelSettings(tab) {
  if (!tab) return;
  const login = tab.login;
  const name = tab.broadcaster ? tab.broadcaster.name : login;
  const row = (label, hint, control) => {
    const r = el("div", "row");
    const l = el("label");
    const name = el("div", null, label);
    name.id = "chan-set-" + (++chanRowIds);
    l.append(name, el("div", "hint", hint));
    if (control.matches && control.matches("input, select")) control.setAttribute("aria-labelledby", name.id);
    r.append(l, control);
    return r;
  };
  const cs = settings.channels[login] || {};
  const words = el("div", "rules");
  const renderWords = () => {
    words.replaceChildren();
    const list = (settings.channels[login] || {}).muteWords || [];
    if (!list.length) words.appendChild(el("div", "hint", "None."));
    list.forEach((w, i) => {
      const line = el("div", "row");
      line.append(el("label", null, w), btn("Remove", () => { setChan(login, { muteWords: list.filter((_, j) => j !== i) }); renderWords(); }, "ghost small"));
      words.appendChild(line);
    });
  };
  renderWords();
  const err = el("div", "hint");
  const input = textBox("", 100, "Word, phrase or /pattern/", () => {});
  input.autocapitalize = "off";
  const add = btn("Mute here", () => {
    const w = input.value.trim();
    if (!w) return;
    if (!muteMatcher(w)) { err.textContent = "That isn't a valid pattern."; return; }
    err.textContent = "";
    const list = (settings.channels[login] || {}).muteWords || [];
    if (!list.includes(w)) setChan(login, { muteWords: [...list, w] });
    input.value = "";
    renderWords();
  }, "small");
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add.click(); } });
  const root = el("div", "tools");
  root.dataset.chansettings = "1";
  root.append(
    el("h2", null, "Settings for #" + name),
    el("p", "hint", "Overrides for this channel only. They sync with your other settings."),
    row("Notifications", "Mentions and highlights while you're elsewhere.", dropdown(CHAN_CHOICES, cs.notify || "default", (v) => setChan(login, { notify: v }))),
    row("Sound", "The chime for mentions and highlights.", dropdown(CHAN_CHOICES, cs.sound || "default", (v) => setChan(login, { sound: v }))),
    row("Go-live alert", "When this channel starts streaming (it must be one you follow).", dropdown(CHAN_CHOICES, cs.live || "default", (v) => { setChan(login, { live: v }); pollLive(); })),
    row("Translate foreign messages",
      hasTranslator()
        ? "Messages in another language get a translation line under them, using your browser's built-in translator (nothing is sent anywhere). Short messages are skipped."
        : "Your browser has no built-in translator (recent Chrome versions do), so this can't be turned on here. You can still translate a single message from its menu.",
      (() => {
        const c = document.createElement("input");
        c.type = "checkbox";
        c.checked = !!cs.autoTranslate && hasTranslator();
        c.disabled = !hasTranslator();
        c.addEventListener("change", () => setChan(login, { autoTranslate: c.checked ? true : undefined }));
        return c;
      })()),
    el("h3", null, "Muted only in this channel"),
    words, input, add, err,
    btn("Reset this channel", () => { delete settings.channels[login]; saveSettings(); openChannelSettings(tab); }, "ghost small"),
  );
  $("sheet-body").replaceChildren(root);
  show("sheet", true);
}

// ---------- private notes and labels on people ----------

function openNoteEditor(tab, u) {
  const cur = (settings.notes || {})[u.id] || {};
  const draft = { label: cur.label || "", color: cur.color || NOTE_COLORS[4], note: cur.note || "" };
  const root = el("div", "tools");
  root.dataset.noteeditor = "1";
  root.append(el("h2", null, "Note on " + u.name), el("p", "hint", "Only you see this. It shows after their name in every chat and syncs to your other devices."));
  root.appendChild(textBox(draft.label, 16, "Label, e.g. regular, mod friend, spammer", (v) => { draft.label = v; }));
  const sw = el("div", "swatches");
  for (const c of NOTE_COLORS) {
    const b = el("button", "swatch" + (c === draft.color ? " on" : ""));
    b.type = "button";
    b.style.background = c;
    b.setAttribute("aria-label", "Color " + c);
    b.addEventListener("click", () => { draft.color = c; sw.querySelectorAll(".swatch").forEach((x) => x.classList.toggle("on", x === b)); });
    sw.appendChild(b);
  }
  root.appendChild(sw);
  root.appendChild(textBox(draft.note, 200, "Note (optional)", (v) => { draft.note = v; }));
  const msg = el("div", "tool-msg err");
  const save = btn("Save", () => {
    const label = draft.label.trim(), note = draft.note.trim();
    if (!label && !note) { remove.click(); return; }
    if (!settings.notes[u.id] && Object.keys(settings.notes).length >= 300) { msg.textContent = "You've reached 300 notes; remove one first."; return; }
    settings.notes[u.id] = { login: u.login || "", label, color: draft.color, note };
    saveSettings();
    refreshUserTags(u.id);
    closeSheet();
  }, "small");
  const remove = btn("Remove", () => { delete settings.notes[u.id]; saveSettings(); refreshUserTags(u.id); closeSheet(); }, "ghost small");
  const bar = el("div", "card-actions");
  bar.append(save);
  if (cur.label || cur.note) bar.append(remove);
  root.append(bar, msg);
  $("sheet-body").replaceChildren(root);
  show("sheet", true);
}

// ---------- quick messages ----------

const snippetsBox = $("snippets");

function closeSnippets() { snippetsBox.hidden = true; }

function insertSnippet(text) {
  const v = composer.getText();
  const add = (v && !/\s$/.test(v) ? " " : "") + text;
  if ((v + add).length > 500) return;
  composer.setText(v + add, (v + add).length);
  if (!coarse) composer.focus();
}

function renderSnippets() {
  const list = settings.snippets || [];
  const draft = composer.getText().trim();
  const box = el("div", "snip-list");
  if (!list.length) box.appendChild(el("div", "hint", "Save messages you type often (greetings, !commands, emote strings). Tap one to put it in the message box."));
  list.forEach((s, i) => {
    const row = el("div", "snip-row");
    const main = el("button", "snip-main");
    main.type = "button";
    main.append(el("b", null, s.label), el("span", "hint", s.text));
    main.addEventListener("click", () => { insertSnippet(s.text); closeSnippets(); });
    row.appendChild(main);
    if (!draft) row.appendChild(btn("Send", () => { closeSnippets(); composer.setText(s.text); $("send-form").requestSubmit(); }, "small"));
    row.appendChild(btn("✕", () => { settings.snippets = list.filter((_, j) => j !== i); saveSettings(); renderSnippets(); }, "ghost small snip-del"));
    box.appendChild(row);
  });
  const form = el("div", "snip-form");
  const label = textBox("", 20, "Name", () => {});
  const text = textBox("", 500, "Message", () => {});
  const addBtn = btn("Add", () => {
    const l = label.value.trim(), x = text.value.trim();
    if (!x) { text.focus(); return; }
    if (list.length >= 30) return;
    settings.snippets = [...list, { label: l || x.slice(0, 20), text: x }];
    saveSettings();
    renderSnippets();
  }, "small");
  text.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addBtn.click(); } });
  form.append(label, text, addBtn);
  snippetsBox.replaceChildren(box, form);
}

$("snip-btn").addEventListener("click", () => {
  if (!snippetsBox.hidden) { closeSnippets(); return; }
  closePicker();
  closeSuggest();
  renderSnippets();
  snippetsBox.hidden = false;
});
$("emote-btn").addEventListener("click", closeSnippets);
document.addEventListener("pointerdown", (e) => { if (!snippetsBox.hidden && !e.target.closest("#snippets, #snip-btn")) closeSnippets(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSnippets(); });

// ---------- bookmarks ----------

window.toolsBookmark = (tab, ev) => {
  const list = settings.bookmarks || [];
  const had = list.some((b) => b.id === ev.message_id);
  if (had) settings.bookmarks = list.filter((b) => b.id !== ev.message_id);
  else settings.bookmarks = [{
    id: ev.message_id, login: tab.login, channel: tab.broadcaster ? tab.broadcaster.name : tab.login,
    user: ev.chatter_user_name, color: ev.color || "", text: ev.message.text, ts: ev.ts || Date.now(),
  }, ...list].slice(0, 100);
  saveSettings();
  sysLine(tab, had ? "Removed the bookmark." : "Saved " + ev.chatter_user_name + "'s message to Bookmarks (account menu).");
};

function openBookmarks() {
  const root = el("div", "tools");
  root.dataset.bookmarks = "1";
  root.append(el("h2", null, "Bookmarks"), el("p", "hint", "Messages you saved with Save in the message menu. They sync to your other devices."));
  const list = el("div", "tool-list");
  for (const m of settings.bookmarks || []) {
    const wrap = el("div", "bm-row");
    const row = el("button", "mention-row");
    row.type = "button";
    const head = el("div", "mr-head");
    const who = el("b", null, m.user);
    if (m.color) who.style.color = m.color;
    head.append(el("span", "shared-pill", m.channel), who, el("span", "hint", " " + new Date(m.ts).toLocaleString()));
    row.append(head, el("div", "mr-text", m.text));
    row.addEventListener("click", () => { closeSheet(); openTab(m.login); });
    wrap.append(row, btn("Remove", () => { settings.bookmarks = settings.bookmarks.filter((b) => b.id !== m.id); saveSettings(); openBookmarks(); }, "ghost small"));
    list.appendChild(wrap);
  }
  if (!(settings.bookmarks || []).length) list.appendChild(el("div", "hint", "Nothing saved yet."));
  root.appendChild(list);
  $("sheet-body").replaceChildren(root);
  show("sheet", true);
}

// ---------- translate a message ----------

const translateLang = () => (navigator.language || "en").split("-")[0].toLowerCase();

const hasTranslator = () => "Translator" in self && "LanguageDetector" in self;
let detectorP = null, detectorOf = null, translatorsOf = null;
const translators = new Map(); // "fr>en" -> promise of a translator (creating one can download a language pack)

/** Uses the browser's own on-device translator where it has one; otherwise null. */
async function translateOnDevice(text, target) {
  if (!hasTranslator()) return null;
  if (detectorOf !== self.LanguageDetector) { detectorP = null; detectorOf = self.LanguageDetector; } // (kept for the page, unless the browser's API object changes)
  if (translatorsOf !== self.Translator) { translators.clear(); translatorsOf = self.Translator; }
  if (!detectorP) { detectorP = self.LanguageDetector.create(); detectorP.catch(() => { detectorP = null; }); } // (a failure isn't remembered)
  const guess = (await (await detectorP).detect(text))[0];
  if (!guess || !guess.detectedLanguage || guess.detectedLanguage === "und") return null;
  if (guess.detectedLanguage === target) return { same: true };
  const key = guess.detectedLanguage + ">" + target;
  if (!translators.has(key)) {
    const made = self.Translator.create({ sourceLanguage: guess.detectedLanguage, targetLanguage: target });
    translators.set(key, made);
    made.catch(() => translators.delete(key));
  }
  const tr = await translators.get(key);
  return { text: await tr.translate(text), from: guess.detectedLanguage };
}

// A channel can have foreign-language messages translated as they arrive (one at a time, skipping short ones).
let translateQueue = Promise.resolve(), translatePending = 0;
function autoTranslate(tab, li, ev) {
  if (!chanSetting(tab.login).autoTranslate || !hasTranslator() || ev.historical || (me && ev.chatter_user_id === me.userId)) return;
  const text = (ev.message.fragments || []).filter((f) => f.type === "text").map((f) => f.text).join(" ").replace(/https?:\/\/\S+/g, " ").replace(/@\w+/g, " ").replace(/\s+/g, " ").trim();
  if ((text.match(/\p{L}/gu) || []).length < 8 || translatePending >= 20) return;
  translatePending++;
  translateQueue = translateQueue.then(async () => {
    try {
      const r = await translateOnDevice(text, translateLang());
      if (!r || r.same || !li.isConnected || li.querySelector(".translation")) return;
      const out = el("div", "translation", "(" + r.from + " → " + translateLang() + ") " + r.text);
      const body = li.querySelector(".body");
      const stick = tab === active && sticking(tab);
      const put = () => { if (body) body.after(out); else li.appendChild(out); };
      if (stick) { put(); scrollToBottom(tab); } else keepScroll(tab, put);
    } catch {} finally { translatePending--; }
  });
}

window.toolsTranslate = async (tab, ev, li) => {
  const text = ev.message.text, target = translateLang();
  const old = li.querySelector(".translation");
  if (old) { old.remove(); return; }
  let r = null;
  try { r = await translateOnDevice(text, target); } catch { r = null; }
  if (!r) {
    // No on-device translator: hand the text to Google Translate in a new tab (only when asked).
    launchers.window("https://translate.google.com/?sl=auto&tl=" + encodeURIComponent(target) + "&op=translate&text=" + encodeURIComponent(text), "_blank");
    return;
  }
  const out = el("div", "translation", r.same ? "Already in your language (" + target + ")." : "(" + r.from + " → " + target + ") " + r.text);
  const body = li.querySelector(".body");
  if (body) body.after(out); else li.appendChild(out);
};

// ---------- tab menu (right-click or long-press a tab) ----------

let tabMenu = null;
function closeTabMenu() { if (tabMenu) tabMenu.remove(); tabMenu = null; }

function openTabMenu(tab, anchor) {
  closeTabMenu();
  const keys = [...tabs.keys()];
  const i = keys.indexOf(tab.login);
  const name = tab.broadcaster ? tab.broadcaster.name : tab.login;
  const menu = el("div", "tab-menu");
  menu.setAttribute("role", "menu");
  const item = (label, fn, cls) => {
    const b = el("button", cls, label);
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.addEventListener("click", () => { closeTabMenu(); fn(); });
    menu.appendChild(b);
  };
  if (i > 0) item("Move left", () => moveTab(tab, i - 1));
  if (i < keys.length - 1) item("Move right", () => moveTab(tab, i + 1));
  if (keys.length > 1) item("Live channels first", () => {
    const live = keys.filter((l) => tabs.get(l).stream), rest = keys.filter((l) => !tabs.get(l).stream);
    [...live, ...rest].forEach((l, n) => moveTab(tabs.get(l), n));
  });
  item(pinnedLogin === tab.login ? "Unpin stream" : "Pin stream", () => setPinned(pinnedLogin === tab.login ? null : tab.login));
  if (wide.matches) item(secondLogin === tab.login ? "Stop watching alongside" : "Watch alongside", () => setSecond(secondLogin === tab.login ? null : tab.login));
  item("Settings for #" + name, () => openChannelSettings(tab));
  if (keys.length > 1) item("Close other tabs", () => { for (const t of [...tabs.values()]) if (t !== tab) closeTab(t); });
  item("Close", () => closeTab(tab), "danger");
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8) + "px";
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + "px";
  tabMenu = menu;
}

$("tabs").addEventListener("contextmenu", (e) => {
  const w = e.target.closest(".tab");
  const tab = w && [...tabs.values()].find((t) => t.tabEl && t.tabEl.wrap === w);
  if (!tab) return;
  e.preventDefault();
  openTabMenu(tab, w);
});
document.addEventListener("pointerdown", (e) => { if (tabMenu && !e.target.closest(".tab-menu")) closeTabMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeTabMenu(); });

// ---------- a second stream beside the first (wide windows) ----------

let secondLogin = safeGet("secondVideo") || null;
const wide = matchMedia("(min-width: 1000px)");

function setSecond(login) {
  secondLogin = login;
  if (login) safeSet("secondVideo", login); else { try { localStorage.removeItem("secondVideo"); } catch {} }
  renderSecond();
}

function renderSecond() {
  const box = $("video2"), frame = $("v2-frame");
  const on = !!(secondLogin && settings.video && wide.matches && !$("video").hidden);
  document.querySelector(".app").classList.toggle("dual", on);
  box.hidden = !on;
  if (!on) { frame.replaceChildren(); delete frame.dataset.channel; return; }
  $("v2-name").textContent = "#" + secondLogin;
  if (frame.dataset.channel === secondLogin) return;
  frame.dataset.channel = secondLogin;
  const f = document.createElement("iframe");
  f.src = "https://player.twitch.tv/?channel=" + encodeURIComponent(secondLogin) + "&parent=" + encodeURIComponent(location.hostname) + "&muted=true&autoplay=true";
  f.allow = "autoplay; fullscreen; picture-in-picture";
  f.allowFullscreen = true;
  f.title = secondLogin + "'s stream";
  frame.replaceChildren(f);
}

window.toolsVideoChanged = renderSecond;
wide.addEventListener("change", renderSecond);
$("v2-close").addEventListener("click", () => setSecond(null));

// ---------- link previews: X/Twitter posts, and (opt-in) pictures ----------

const X_LINK = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status(?:es)?\/(\d{1,25})(?:[/?#]|$)/i;
const IMAGE_LINK = /\.(?:png|jpe?g|gif|webp)$/i;
const xCards = new Map(); // post id -> promise of its card (null when unavailable)

function fetchXCard(id) {
  let p = xCards.get(id);
  if (!p) {
    p = api("/api/preview/x?id=" + id).then((r) => (r && r.ok ? r.card : null));
    if (xCards.size > 100) xCards.delete(xCards.keys().next().value);
    xCards.set(id, p);
    p.then((c) => { if (!c) setTimeout(() => xCards.delete(id), 60000); }); // a failure is tried again later
  }
  return p;
}

// imgur.com/a/<id>, or imgur.com/gallery/<title-slug>-<id> (the id is what follows the last hyphen).
const IMGUR_LINK = /^https?:\/\/(?:www\.|m\.)?imgur\.com\/(?:a|gallery)\/(?:[^/?#]*-)?([A-Za-z0-9]{5,10})(?:[/?#]|$)/i;
const imgurCards = new Map(); // album id -> promise of its card (null when unavailable)

function fetchImgurCard(id) {
  let p = imgurCards.get(id);
  if (!p) {
    p = api("/api/preview/imgur?id=" + id).then((r) => (r && r.ok ? r.card : null));
    if (imgurCards.size > 100) imgurCards.delete(imgurCards.keys().next().value);
    imgurCards.set(id, p);
    p.then((c) => { if (!c) setTimeout(() => imgurCards.delete(id), 60000); });
  }
  return p;
}

const onImgur = (u) => { try { const x = new URL(u); return x.protocol === "https:" && x.hostname === "i.imgur.com"; } catch { return false; } };

function imgurCardEl(card) {
  const a = el("a", "x-card im-card");
  a.href = card.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer nofollow";
  a.append(el("div", "im-title", card.title || "Imgur album"), el("div", "xc-note", card.count + (card.count === 1 ? " picture" : " pictures") + " · imgur.com"));
  if (card.sensitive) {
    a.appendChild(el("div", "xc-note", "Mature content hidden."));
    return a;
  }
  const row = el("div", "im-thumbs"); // (the first picture is large, the rest sit in a row under it)
  for (const t of card.thumbs) {
    if (!onImgur(t.url)) continue;
    const box = el("span", "im-thumb");
    const img = document.createElement("img");
    img.src = t.url;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => box.remove());
    box.appendChild(img);
    if (t.video) box.appendChild(el("span", "xc-play", "▶"));
    row.appendChild(box);
  }
  if (row.childElementCount) a.appendChild(row);
  return a;
}

const onXCdn = (u) => { try { const x = new URL(u); return x.protocol === "https:" && /(^|\.)twimg\.com$/.test(x.hostname); } catch { return false; } };

function xCardEl(card) {
  const pv = settings.previews || {};
  const pictures = pv.media !== false;
  const a = el("a", "x-card");
  a.href = card.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer nofollow";
  const head = el("div", "xc-head");
  if (pictures && card.author.avatar && onXCdn(card.author.avatar)) {
    const av = document.createElement("img");
    av.src = card.author.avatar;
    av.alt = "";
    av.referrerPolicy = "no-referrer";
    av.className = "xc-avatar";
    head.appendChild(av);
  }
  const who = el("div", "xc-who");
  who.append(el("b", null, card.author.name + (card.author.verified ? " ✓" : "")), el("span", null, "@" + card.author.handle));
  head.append(who, el("span", "xc-x", "X"));
  a.append(head, el("div", "xc-text", card.text));
  if (card.media && card.sensitive) {
    a.appendChild(el("div", "xc-note", "Sensitive media hidden."));
  } else if (card.media && pictures && onXCdn(card.media.url)) {
    const box = el("div", "xc-media");
    const img = document.createElement("img");
    img.src = card.media.url;
    img.alt = card.media.kind === "photo" ? "Picture in the post" : "Still from the post's " + card.media.kind;
    img.referrerPolicy = "no-referrer";
    img.loading = "lazy";
    img.addEventListener("error", () => box.remove());
    box.appendChild(img);
    if (card.media.kind !== "photo") box.appendChild(el("span", "xc-play", card.media.kind === "gif" ? "GIF" : "▶"));
    a.appendChild(box);
    if (card.moreMedia) a.appendChild(el("div", "xc-note", "+" + card.moreMedia + " more"));
  }
  const stats = [];
  if (card.likes != null) stats.push("♥ " + compactCount(card.likes));
  if (card.retweets != null) stats.push("↻ " + compactCount(card.retweets));
  if (card.replies != null) stats.push("↩ " + compactCount(card.replies));
  if (card.createdAt) stats.push(new Date(card.createdAt).toLocaleDateString());
  if (stats.length) a.appendChild(el("div", "xc-foot", stats.join("  ·  ")));
  return a;
}

function placePreview(tab, li, node) {
  if (!li.isConnected) return;
  const before = li.querySelector(".actions");
  if (tab === active && sticking(tab)) { li.insertBefore(node, before); scrollToBottom(tab); }
  else keepScroll(tab, () => li.insertBefore(node, before));
}

window.toolsLinkPreviews = (tab, li, body) => {
  const pv = settings.previews || {};
  const links = [...body.querySelectorAll("a.link")].map((a) => a.href);
  if (pv.x !== false) {
    const ids = [...new Set(links.map((h) => (X_LINK.exec(h) || [])[1]).filter(Boolean))].slice(0, 2);
    for (const id of ids) fetchXCard(id).then((card) => { if (card && li.isConnected) placePreview(tab, li, xCardEl(card)); });
  }
  if (pv.images === true) {
    const albums = [...new Set(links.map((h) => (IMGUR_LINK.exec(h) || [])[1]).filter(Boolean))].slice(0, 2);
    for (const id of albums) fetchImgurCard(id).then((card) => { if (card && li.isConnected) placePreview(tab, li, imgurCardEl(card)); });
  }
  if (pv.images === true) {
    const imgs = [...new Set(links.filter((h) => { try { const u = new URL(h); return u.protocol === "https:" && IMAGE_LINK.test(u.pathname) && !X_LINK.test(h); } catch { return false; } }))].slice(0, 2);
    for (const src of imgs) {
      const box = el("a", "img-preview");
      box.href = src;
      box.target = "_blank";
      box.rel = "noopener noreferrer nofollow";
      const img = document.createElement("img"); // (not lazy: it's loaded before it joins the page, so a broken one never shows)
      img.referrerPolicy = "no-referrer";
      img.alt = "Picture from the link";
      img.addEventListener("load", () => placePreview(tab, li, box), { once: true }); // only shown once it has actually loaded
      img.src = src;
      box.appendChild(img);
    }
  }
};

// ---------- /user: look anyone up by name ----------

window.toolsLookupUser = async (tab, name) => {
  const r = await api("/api/lookup/user?login=" + encodeURIComponent(name.toLowerCase()));
  if (!r || !r.ok) { sysLine(tab, "Couldn't look up " + name + ": " + ((r && r.error) || "try again"), "err"); return; }
  openUserCard(tab, { id: r.user.id, login: r.user.login, name: r.user.name, color: "", badges: [] });
};

// ---------- Settings → Diagnostics ----------

const SCOPE_INFO = {
  "user:read:chat": "reading chat", "user:write:chat": "sending messages", "user:manage:chat_color": "chat color cycling",
  "user:read:emotes": "your Twitch emotes in the picker", "user:read:follows": "followed channels, the follow heart, go-live alerts",
  "user:read:subscriptions": "the subscription chip", "user:read:blocked_users": "reading your block list", "user:manage:blocked_users": "blocking and unblocking",
  "user:read:whispers": "receiving whispers", "user:manage:whispers": "sending whispers", "clips:edit": "creating clips",
  "user:read:moderated_channels": "knowing which channels you moderate", "moderator:manage:chat_messages": "deleting messages",
  "moderator:manage:banned_users": "timeouts, bans and the banned list", "moderator:manage:chat_settings": "chat modes",
  "moderator:manage:automod": "the AutoMod queue", "moderator:read:followers": "follow age on user cards",
  "moderator:manage:announcements": "announcements", "moderator:manage:shoutouts": "shoutouts", "moderator:manage:warnings": "warnings",
  "moderator:manage:blocked_terms": "blocked terms", "moderator:manage:shield_mode": "Shield Mode",
  "moderator:read:suspicious_users": "suspicious-user flags", "moderator:manage:suspicious_users": "marking suspicious users",
  "moderator:manage:unban_requests": "unban requests", "moderator:read:chatters": "the chatters list",
};

window.toolsDiagnostics = () => {
  const box = el("div", "diag");
  box.appendChild(el("div", "hint", "Loading…"));
  api("/api/diag").then((r) => {
    box.replaceChildren();
    if (!r || !r.ok) { box.appendChild(el("div", "hint", "Couldn't load the diagnostics" + (r && r.error ? ": " + r.error : "."))); return; }
    const facts = [["Server version", r.version.id.slice(0, 8) + ", deployed " + new Date(r.version.at).toLocaleString()]];
    const tw = r.twitch;
    let missing = [];
    if (tw) {
      const granted = new Set(tw.scopes);
      missing = Object.keys(SCOPE_INFO).filter((s) => !granted.has(s));
      const mins = Math.round((tw.expiresAt - Date.now()) / 60000);
      facts.push(["Signed in to Twitch as", "@" + tw.login],
        ["Twitch token", (mins > 0 ? "good for about " + mins + " more minutes (renewed automatically)" : "being renewed") + "; last checked " + since(new Date(tw.validatedAt).toISOString()) + " ago"],
        ["Permissions", (Object.keys(SCOPE_INFO).length - missing.length) + " of " + Object.keys(SCOPE_INFO).length + " granted" + (missing.length ? "; " + missing.length + " missing" : "")]);
    } else facts.push(["Twitch", "Not connected"]);
    facts.push(["Browser", navigator.userAgent], ["Window", innerWidth + "×" + innerHeight + (matchMedia("(pointer: coarse)").matches ? ", touch" : "")],
      ["Notifications", typeof Notification === "undefined" ? "not supported" : Notification.permission]);
    const grid = el("div", "diag-grid");
    for (const [k, v] of facts) { grid.append(el("div", "hint", k), el("div", "diag-v", v)); }
    box.appendChild(grid);
    if (missing.length) {
      box.appendChild(el("h3", null, "Permissions not granted"));
      const ul = el("ul", "diag-missing");
      for (const s of missing) ul.appendChild(el("li", null, SCOPE_INFO[s] + " (" + s + ")"));
      box.appendChild(ul);
      const a = el("a", "btn", "Reconnect Twitch");
      a.href = "/auth/login";
      box.appendChild(a);
    }
    box.appendChild(el("h3", null, "Recent problems"));
    const errs = el("ul", "diag-errors");
    for (const e of apiErrors) errs.appendChild(el("li", null, new Date(e.at).toLocaleTimeString() + "  " + e.path + "  " + (e.status || "no connection") + (e.message ? "  " + e.message : "")));
    if (!apiErrors.length) errs.appendChild(el("li", "hint", "None since the page opened."));
    box.appendChild(errs);
    const copy = btn("Copy diagnostics", async () => {
      const text = ["Yappa diagnostics", ...facts.map(([k, v]) => k + ": " + v), "Missing permissions: " + (missing.join(", ") || "none"),
        "Recent problems:", ...apiErrors.map((e) => "  " + new Date(e.at).toISOString() + " " + e.path + " " + e.status + " " + e.message), "Startup: " + startupSummary()].join("\n");
      let said = "Copied!";
      try { await navigator.clipboard.writeText(text); } catch { said = "Couldn't copy"; }
      copy.textContent = said;
      setTimeout(() => { copy.textContent = "Copy diagnostics"; }, TEST_TIMING.sayMs || 1500);
    }, "small");
    box.appendChild(copy);
  });
  return box;
};

// ---------- quick switcher (Ctrl/Cmd+K) ----------

const SETTINGS_SECTIONS = [["color", "Chat color"], ["chat", "Chat"], ["alerts", "Alerts and highlights"], ["filters", "Filters and moderation"], ["video", "Video"], ["look", "Appearance"], ["account", "Account and devices"], ["diag", "Diagnostics"]];

/** How well `q` matches `text` (letters in order, starts of words and early matches count more), or -1. */
function fuzzyScore(q, text) {
  if (!q) return 0;
  const s = text.toLowerCase();
  const direct = s.indexOf(q);
  if (direct >= 0) return 100 - direct + (direct === 0 || /[\s#:@]/.test(s[direct - 1]) ? 40 : 0) - (s.length - q.length) * 0.1;
  let at = -1, score = 0, last = -2;
  for (const c of q) {
    at = s.indexOf(c, at + 1);
    if (at < 0) return -1;
    score += (at === last + 1 ? 6 : 1) + (at === 0 || /[\s#:@]/.test(s[at - 1]) ? 4 : 0);
    last = at;
  }
  return score;
}

function switcherEntries() {
  const out = [];
  const seen = new Set();
  for (const t of tabs.values()) {
    const name = t.broadcaster ? t.broadcaster.name : t.login;
    seen.add(t.login);
    out.push({ kind: "Tab", label: "#" + name, sub: t.stream ? "live · " + compactCount(t.stream.viewer_count) : t === active ? "current tab" : "open", run: () => activate(t), boost: 30 });
  }
  const fl = typeof following !== "undefined" && following && following.ok ? following : null;
  if (fl) {
    const live = new Set(fl.live.map((c) => c.login));
    for (const c of fl.channels) if (!seen.has(c.login)) { seen.add(c.login); out.push({ kind: "Channel", label: "#" + c.name, sub: live.has(c.login) ? "live now · open it" : "open it", run: () => openTab(c.login), boost: live.has(c.login) ? 15 : 10 }); }
  }
  const act = (label, run, keywords = "") => out.push({ kind: "Action", label, sub: "", keywords, run, boost: 0 });
  act("Settings", () => openSettings(), "preferences options");
  for (const [id, title] of SETTINGS_SECTIONS) act("Settings: " + title, () => openSettings(id));
  act("Mentions", openMentions, "highlights");
  act("Bookmarks", openBookmarks, "saved messages");
  if (tabs.size > 1) act("All chats in one feed", openCombined, "combined merged");
  act("Discover streams", openDiscover, "browse top live categories search");
  act("Your clips", () => openBrowse({ mine: true }));
  if (hasScope("user:manage:whispers")) act("Whispers", openWhispers, "messages dm");
  if (active && active.broadcaster) {
    act("Channel info", openChannelInfo, "about tags uptime viewers stats");
    act("Clips and VODs for #" + active.broadcaster.name, () => $("clips-btn").click(), "videos past broadcasts");
    act("Settings for #" + active.broadcaster.name, () => openChannelSettings(active), "channel overrides mute");
    if (active.isMod) act("Mod tools", openMod, "moderator ban timeout banned terms shield");
    if (active.list.querySelector(".msg")) { act("Save this chat (text)", () => exportChat("txt"), "export download"); act("Save this chat (JSON)", () => exportChat("json"), "export download"); }
  }
  act(document.querySelector(".app").classList.contains("focus") ? "Leave focus mode" : "Focus mode", () => setFocus(!document.querySelector(".app").classList.contains("focus")), "reading hide composer info bar distraction free");
  act("Show or hide the video", () => $("video-btn").click(), "stream player");
  act("Keyboard shortcuts", openShortcuts, "keys help");
  return out;
}

let switcher = null;

function closeSwitcher() {
  if (!switcher) return;
  const { node, opener } = switcher;
  node.remove();
  switcher = null;
  if (opener && opener.isConnected && opener !== document.body) try { opener.focus(); } catch {}
}

function openSwitcher() {
  if (switcher || !me) return;
  closeAccountMenu?.();
  const node = el("div", "switcher-backdrop");
  const box = el("div", "switcher");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Quick switcher");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Go to a tab, channel, setting or action…";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Search tabs, channels, settings and actions");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", "switcher-list");
  const list = el("ul", "switcher-list");
  list.id = "switcher-list";
  list.setAttribute("role", "listbox");
  box.append(input, list);
  node.appendChild(box);
  document.body.appendChild(node);
  switcher = { node, opener: document.activeElement };
  const entries = switcherEntries();
  let shown = [], index = 0;
  const render = () => {
    const raw = input.value.trim();
    const q = raw.toLowerCase();
    shown = entries
      .map((e) => ({ e, s: fuzzyScore(q.replace(/^#/, ""), (e.label + " " + (e.keywords || "")).toLowerCase().replace(/^#/, "")) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s + b.e.boost - (a.s + a.e.boost))
      .slice(0, 9)
      .map((x) => x.e);
    const handle = raw.replace(/^[#@]/, "");
    if (/^[A-Za-z0-9_]{1,25}$/.test(handle) && !tabs.has(handle.toLowerCase())) {
      shown.push({ kind: "Channel", label: "Open channel " + handle.toLowerCase(), sub: "any Twitch channel", run: () => openTab(handle) });
      shown.push({ kind: "User", label: "Look up @" + handle.toLowerCase(), sub: "profile and follow age", run: () => active && toolsLookupUser(active, handle) });
    }
    index = Math.min(index, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((e, i) => {
      const li = el("li", "sw-row" + (i === index ? " on" : ""));
      li.id = "sw-" + i;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === index));
      li.append(el("span", "sw-kind", e.kind), el("span", "sw-label", e.label), el("span", "sw-sub hint", e.sub || ""));
      li.addEventListener("pointerdown", (ev) => { ev.preventDefault(); run(i); });
      return li;
    }));
    if (!shown.length) list.appendChild(el("li", "hint sw-none", "Nothing matches."));
    input.setAttribute("aria-activedescendant", shown.length ? "sw-" + index : "");
  };
  const run = (i) => { const e = shown[i]; if (!e) return; closeSwitcher(); e.run(); };
  input.addEventListener("input", () => { index = 0; render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { index = Math.min(shown.length - 1, index + 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { index = Math.max(0, index - 1); render(); e.preventDefault(); }
    else if (e.key === "Enter") { run(index); e.preventDefault(); }
    else if (e.key === "Escape") { closeSwitcher(); e.preventDefault(); e.stopPropagation(); }
  });
  node.addEventListener("pointerdown", (e) => { if (e.target === node) closeSwitcher(); });
  render();
  input.focus();
  // The followed channels may not be loaded yet; add them when they arrive.
  loadFollowing().then(() => {
    if (!switcher || switcher.node !== node) return;
    entries.splice(0, entries.length, ...switcherEntries());
    render();
  });
}

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (switcher) closeSwitcher(); else openSwitcher();
  }
}, true);

// ---------- focus mode: just the tabs and the chat ----------

function setFocus(on) {
  const app = document.querySelector(".app");
  app.classList.toggle("focus", on);
  $("focus-exit").hidden = !on;
  if (on) { closePicker(); closeSuggest(); closeSnippets(); }
  if (active) { scrollToBottom(active); }
}
$("focus-exit").addEventListener("click", () => setFocus(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.querySelector(".app").classList.contains("focus") && $("sheet").hidden && !switcher && $("account-menu").hidden) setFocus(false);
});

})();
