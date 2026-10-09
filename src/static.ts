import appCss from "./client/app.css";
import appJs from "./client/app.js";
import swJs from "./client/sw.js";
import themeJs from "./client/theme.js";
import appleTouchIcon from "./client/icons/apple-touch-icon.png";
import favicon32 from "./client/icons/favicon-32.png";
import icon192 from "./client/icons/icon-192.png";
import icon512 from "./client/icons/icon-512.png";
import iconMaskable512 from "./client/icons/icon-maskable-512.png";

const IMMUTABLE = "private, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

export const APP_NAME = "Yappa";
export const THEME_COLOR = "#18181b";

/** Short FNV-1a hash, used to bust caches when an asset changes. */
function hash(data: string | ArrayBuffer): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193);
  return (h >>> 0).toString(36);
}

const icons = {
  "/icons/icon-192.png": icon192,
  "/icons/icon-512.png": icon512,
  "/icons/icon-maskable-512.png": iconMaskable512,
  "/icons/apple-touch-icon.png": appleTouchIcon,
  "/icons/favicon-32.png": favicon32,
};

/** Path including a ?v= content hash, for long-lived caching. */
export function versioned(path: keyof typeof icons | "/app.css" | "/app.js" | "/theme.js"): string {
  const body = path === "/app.css" ? appCss : path === "/app.js" ? appJs : path === "/theme.js" ? themeJs : icons[path];
  return `${path}?v=${hash(body)}`;
}

const manifest = JSON.stringify({
  id: "/",
  name: APP_NAME,
  short_name: APP_NAME,
  description: "Twitch chat with tabs, 7TV emotes, mod tools and chat color cycling.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "any",
  background_color: "#0e0e10",
  theme_color: THEME_COLOR,
  icons: [
    { src: versioned("/icons/icon-192.png"), sizes: "192x192", type: "image/png", purpose: "any" },
    { src: versioned("/icons/icon-512.png"), sizes: "512x512", type: "image/png", purpose: "any" },
    { src: versioned("/icons/icon-maskable-512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
});

export const staticFiles: Record<string, { body: string | ArrayBuffer; type: string; cache: string }> = {
  "/app.css": { body: appCss, type: "text/css; charset=utf-8", cache: IMMUTABLE },
  "/app.js": { body: appJs, type: "text/javascript; charset=utf-8", cache: IMMUTABLE },
  "/theme.js": { body: themeJs, type: "text/javascript; charset=utf-8", cache: IMMUTABLE },
  // The service worker must keep a stable URL and always be revalidated.
  "/sw.js": { body: swJs, type: "text/javascript; charset=utf-8", cache: REVALIDATE },
  "/manifest.webmanifest": { body: manifest, type: "application/manifest+json", cache: REVALIDATE },
  "/favicon.ico": { body: favicon32, type: "image/png", cache: REVALIDATE },
  ...Object.fromEntries(Object.entries(icons).map(([p, b]) => [p, { body: b, type: "image/png", cache: IMMUTABLE }])),
};
