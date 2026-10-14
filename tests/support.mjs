// Shared by the two test files: builds the Worker's code into bundles Node can import
// (with the Durable Object runtime faked) and a tiny pass/fail counter.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const outDir = fileURLToPath(new URL("./output", import.meta.url)); // screenshots + bundles (git-ignored)

/** The pure modules plus the whole Worker, bundled for Node. */
export async function loadBundles() {
  mkdirSync(outDir, { recursive: true });
  await build({
    stdin: {
      contents: [
        'export { renderPage, PAGE_HEADERS } from "./src/page.ts";',
        'export { renderMoved } from "./src/moved.ts";',
        'export * as toolsLib from "./src/tools.ts";',
        'export { relayMaster } from "./src/usher.ts";',
        'export { parseClipsQuery, parseVideosQuery, parseCreateClip, parseDuration, videoThumb, slimClip, slimVideo, clipFailure } from "./src/browse.ts";',
        'export { staticFiles } from "./src/static.ts";',
        'export { slimTweet, parseXId, twimgUrl } from "./src/previews.ts";',
      ].join("\n"),
      resolveDir: root, sourcefile: "entry.ts", loader: "ts",
    },
    bundle: true, format: "esm", outfile: outDir + "/page.bundle.mjs", logLevel: "warning",
    loader: { ".css": "text", ".js": "text", ".png": "base64" },
  });
  // The Worker itself (sign-in, sessions, allowlist), with the Durable Object runtime faked so it runs in Node.
  await build({
    stdin: { contents: 'export { default } from "./src/index.ts"; export { signSession, isAllowed } from "./src/session.ts";', resolveDir: root, loader: "ts" },
    bundle: true, format: "esm", outfile: outDir + "/worker.bundle.mjs", logLevel: "warning",
    loader: { ".css": "text", ".js": "text", ".png": "base64" },
    plugins: [{ name: "fake-cloudflare-workers", setup(b) {
      b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "cf-workers", namespace: "fake" }));
      b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export class DurableObject {}", loader: "js" }));
    } }],
  });
  const stamp = "?" + Date.now();
  return { worker: await import(outDir + "/worker.bundle.mjs" + stamp), lib: await import(outDir + "/page.bundle.mjs" + stamp) };
}
