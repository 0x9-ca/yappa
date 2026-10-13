// Renders scripts/social-preview.html to the GitHub social preview image (1280x640 PNG).
// Usage: node scripts/draw-social.mjs [out.png]   (default docs/social-preview.png)
// Set SHOTS_FONTS=<dir holding Roboto-Regular/Medium/Bold/ExtraBold .woff2> to render in Roboto
// (otherwise the browser's fallback font is used).
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const out = process.argv[2] || fileURLToPath(new URL("../docs/social-preview.png", import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell" });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
if (process.env.SHOTS_FONTS) {
  const dir = process.env.SHOTS_FONTS;
  const face = (w, file) => `@font-face{font-family:Roboto;font-weight:${w};src:url(data:font/woff2;base64,${readFileSync(dir + "/" + file).toString("base64")}) format("woff2")}`;
  await page.addInitScript((css) => {
    const add = () => { const st = document.createElement("style"); st.textContent = css; (document.head || document.documentElement).appendChild(st); };
    if (document.documentElement) add(); else document.addEventListener("DOMContentLoaded", add);
  }, [face(400, "Roboto-Regular.woff2"), face(500, "Roboto-Medium.woff2"), face(700, "Roboto-Bold.woff2"), face(800, "Roboto-Black.woff2")].join("\n"));
}
await page.goto(new URL("./social-preview.html", import.meta.url).href);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out });
await browser.close();
console.log("wrote " + out);
