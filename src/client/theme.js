// Applies the saved theme before the page first paints (app.js only loads at the end of
// the page, which would flash the dark theme first). app.js keeps it up to date after that.
"use strict";
(function () {
  var theme = "dark";
  try { theme = JSON.parse(localStorage.getItem("settings") || "{}").theme || "dark"; } catch (e) {}
  if (theme === "system") theme = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta && theme === "light") meta.content = "#ffffff";
  // On the app page (not the sign-in page), ask who's signed in right now: the answer is on its
  // way while the rest of the page and its scripts load. app.js picks it up (refreshStatus).
  if (document.documentElement.hasAttribute("data-app")) {
    try { window.earlyStatus = fetch("/api/status?sync=1"); window.earlyStatus.catch(function () {}); } catch (e) {}
  }
})();
