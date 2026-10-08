function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function renderPage(user: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat Color Cycler</title>
<style>
  :root { --bg:#0e0e10; --panel:#18181b; --text:#efeff1; --muted:#adadb8; --accent:#9147ff; --danger:#eb0400; }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.5 system-ui, sans-serif; background:var(--bg); color:var(--text); }
  main { max-width:480px; margin:48px auto; padding:0 16px; }
  .panel { background:var(--panel); border-radius:8px; padding:24px; }
  h1 { font-size:20px; margin:0 0 16px; }
  p { margin:0 0 12px; }
  .muted { color:var(--muted); font-size:14px; }
  .error { color:#ff8080; font-size:14px; }
  form { display:flex; gap:8px; margin:16px 0; }
  input { flex:1; min-width:0; padding:10px 12px; border-radius:6px; border:1px solid #3a3a3d; background:#0e0e10; color:var(--text); font-size:16px; }
  button, a.btn { display:inline-block; padding:10px 16px; border:0; border-radius:6px; background:var(--accent); color:#fff; font-size:15px; font-weight:600; cursor:pointer; text-decoration:none; }
  button.stop { background:var(--danger); }
  button.link { background:none; color:var(--muted); padding:0; font-weight:400; font-size:14px; text-decoration:underline; }
  .swatch { display:flex; align-items:center; gap:12px; margin:16px 0; }
  .swatch div { width:48px; height:48px; border-radius:8px; border:1px solid #3a3a3d; transition:background .4s; }
  .swatch code { font-size:18px; }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<main>
  <div class="panel">
    <h1>Chat Color Cycler</h1>
    <p class="error" id="error" hidden></p>

    <section id="connect" hidden>
      <p>Connect your Twitch account to continue.</p>
      <a class="btn" href="/auth/login">Connect Twitch</a>
    </section>

    <section id="idle" hidden>
      <p>Which channel? Your color changes every 10 seconds while it's live.</p>
      <form id="start-form">
        <input id="channel" name="channel" placeholder="channel name" autocomplete="off" required>
        <button type="submit">Start</button>
      </form>
      <p class="muted" id="last-run" hidden></p>
    </section>

    <section id="running" hidden>
      <p>Cycling colors while <strong id="run-channel"></strong> is live.</p>
      <div class="swatch"><div id="swatch"></div><code id="color">…</code></div>
      <p class="muted" id="run-stats"></p>
      <button class="stop" id="stop">Stop</button>
    </section>

    <p class="muted" id="account" style="margin-top:24px" hidden>
      Twitch: <strong id="login"></strong> ·
      <button class="link" id="logout">disconnect</button>
      <br>Access: ${escapeHtml(user)}
    </p>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const show = (id, on) => { $(id).hidden = !on; };

function setError(msg) { $("error").textContent = msg || ""; show("error", !!msg); }

const qsError = new URLSearchParams(location.search).get("error");
if (qsError) { setError(qsError); history.replaceState(null, "", "/"); }

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return res.json().catch(() => ({ ok: false, error: "Request failed (" + res.status + ")" }));
}

async function refresh() {
  let s;
  try { s = await (await fetch("/api/status")).json(); } catch { return; }
  const run = s.run;
  show("connect", !s.twitch);
  show("account", !!s.twitch);
  show("idle", !!s.twitch && !(run && run.running));
  show("running", !!s.twitch && !!(run && run.running));
  if (s.twitch) $("login").textContent = s.twitch.login;

  if (run && run.running) {
    $("run-channel").textContent = run.channel;
    $("color").textContent = run.lastColor || "starting…";
    $("swatch").style.background = run.lastColor || "transparent";
    $("run-stats").textContent = run.changes + " changes" + (run.lastError ? " · last error: " + run.lastError : "");
  } else if (run && run.stoppedReason) {
    $("last-run").textContent = "Last run on " + run.channel + ": " + run.stoppedReason +
      " (" + run.changes + " changes, " + new Date(run.stoppedAt).toLocaleTimeString() + ")";
    show("last-run", true);
  }
}

$("start-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("");
  const r = await post("/api/start", { channel: $("channel").value });
  if (!r.ok) setError(r.error);
  refresh();
});
$("stop").addEventListener("click", async () => { await post("/api/stop"); refresh(); });
$("logout").addEventListener("click", async () => { await post("/auth/logout"); refresh(); });

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
}
