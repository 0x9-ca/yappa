/**
 * Served at "/" on an old hostname. Browser storage (tabs, settings, highlight rules,
 * hidden users) is per-origin, so carry it over in the URL fragment, which never reaches
 * a server; the app imports it on first load at the new address (see app.js).
 */
export const MIGRATED_KEYS = ["settings", "tabs", "lastChannel", "recentEmotes"];

export function renderMoved(appHost: string): string {
  const target = JSON.stringify(`https://${appHost}/`);
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Yappa has moved</title>
<style>body{background:#0e0e10;color:#efeff1;font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;text-align:center}a{color:#bf94ff}</style>
<p>Yappa has moved to <a id="go" href=${target}>${appHost}</a>.</p>
<script>
  var data = {};
  try { ${JSON.stringify(MIGRATED_KEYS)}.forEach(function (k) { var v = localStorage.getItem(k); if (v != null) data[k] = v; }); } catch (e) {}
  // Keep the query: it can carry a sign-in error (e.g. Twitch redirected to the old address).
  var url = ${target} + location.search + (Object.keys(data).length ? "#import=" + encodeURIComponent(JSON.stringify(data)) : location.hash);
  document.getElementById("go").href = url;
  location.replace(url);
</script>`;
}
