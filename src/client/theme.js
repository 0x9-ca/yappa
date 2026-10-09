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
})();
