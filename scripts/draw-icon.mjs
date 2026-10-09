import { chromium } from "playwright-core";
import fs from "fs";
const out = process.argv[2];
const browser = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell" });
const page = await browser.newPage();
await page.setContent("<canvas id=c></canvas>");
// size: output px; inset: fraction of the canvas the artwork may use (maskable keeps it in the safe zone);
// rounded: corner radius as a fraction (0 = full bleed square)
const draw = (size, inset, rounded) => page.evaluate(({ size, inset, rounded }) => {
  const c = document.getElementById("c");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const S = size;
  g.clearRect(0, 0, S, S);

  // Background: deep near-black with a purple glow.
  g.save();
  const r = rounded * S;
  g.beginPath();
  g.roundRect(0, 0, S, S, r);
  g.clip();
  const bg = g.createRadialGradient(S * 0.5, S * 0.42, S * 0.05, S * 0.5, S * 0.5, S * 0.75);
  bg.addColorStop(0, "#3b1d78");
  bg.addColorStop(0.55, "#1a1030");
  bg.addColorStop(1, "#0b0a10");
  g.fillStyle = bg;
  g.fillRect(0, 0, S, S);
  g.restore();

  // Artwork box (centered, scaled by inset).
  const A = S * inset, ox = (S - A) / 2, oy = (S - A) / 2;
  const X = (f) => ox + f * A, Y = (f) => oy + f * A;

  // Speech bubble: rounded rect body + tail at bottom-left.
  const bubble = () => {
    const p = new Path2D();
    const x0 = X(0.08), y0 = Y(0.1), x1 = X(0.92), y1 = Y(0.76), rr = A * 0.17;
    p.moveTo(x0 + rr, y0);
    p.lineTo(x1 - rr, y0); p.quadraticCurveTo(x1, y0, x1, y0 + rr);
    p.lineTo(x1, y1 - rr); p.quadraticCurveTo(x1, y1, x1 - rr, y1);
    p.lineTo(X(0.42), y1);
    p.lineTo(X(0.2), Y(0.93));          // tail tip
    p.lineTo(X(0.26), y1);
    p.lineTo(x0 + rr, y1); p.quadraticCurveTo(x0, y1, x0, y1 - rr);
    p.lineTo(x0, y0 + rr); p.quadraticCurveTo(x0, y0, x0 + rr, y0);
    p.closePath();
    return p;
  };

  // Glow behind the bubble.
  g.save();
  g.shadowColor = "rgba(190, 120, 255, 0.55)";
  g.shadowBlur = A * 0.08;
  g.fillStyle = "#000";
  g.fill(bubble());
  g.restore();

  // Full-spectrum conic fill = "every color".
  // Hide the conic centre under a crossing of the "#" strokes (top-left crossing, after the slant).
  const gap0 = A * 0.105;
  const cx = X(0.5) - 0.82 * gap0, cy = Y(0.43) - gap0;
  const cg = g.createConicGradient(-Math.PI / 2, cx, cy);
  const hues = [0, 45, 90, 150, 200, 250, 290, 330, 360];
  hues.forEach((h, i) => cg.addColorStop(i / (hues.length - 1), "hsl(" + h + ", 95%, 60%)"));
  g.fillStyle = cg;
  g.fill(bubble());

  // Soft white sheen at the top of the bubble.
  g.save();
  g.clip(bubble());
  const sheen = g.createLinearGradient(0, Y(0.1), 0, Y(0.5));
  sheen.addColorStop(0, "rgba(255,255,255,0.35)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = sheen;
  g.fillRect(X(0), Y(0), A, A * 0.5);
  g.restore();

  // "#" knocked out of the bubble (shows the background through it).
  g.save();
  g.clip(bubble());
  g.globalCompositeOperation = "destination-out";
  g.translate(X(0.5), Y(0.43));
  g.transform(1, 0, -0.18, 1, 0, 0);   // italic slant
  const w = A * 0.075, L = A * 0.44, gap = A * 0.105;
  g.lineCap = "round";
  g.lineWidth = w;
  g.beginPath();
  g.moveTo(-gap, -L / 2); g.lineTo(-gap, L / 2);
  g.moveTo(gap, -L / 2); g.lineTo(gap, L / 2);
  g.moveTo(-L / 2, -gap); g.lineTo(L / 2, -gap);
  g.moveTo(-L / 2, gap); g.lineTo(L / 2, gap);
  g.stroke();
  g.restore();

  // Re-draw the background inside the knockout so "#" isn't transparent on full-bleed icons.
  g.save();
  g.globalCompositeOperation = "destination-over";
  g.beginPath();
  g.roundRect(0, 0, S, S, r);
  g.fillStyle = "#120d1f";
  g.fill();
  g.restore();

  return c.toDataURL("image/png");
}, { size, inset, rounded });

const save = async (name, size, inset, rounded) => {
  const url = await draw(size, inset, rounded);
  fs.writeFileSync(out + "/" + name, Buffer.from(url.split(",")[1], "base64"));
};
await save("icon-512.png", 512, 0.82, 0.22);
await save("icon-192.png", 192, 0.82, 0.22);
await save("icon-maskable-512.png", 512, 0.62, 0);   // safe zone is the centre 80% circle
await save("apple-touch-icon.png", 180, 0.78, 0);      // iOS rounds corners itself
await save("favicon-32.png", 32, 0.98, 0.2);
await save("preview-1024.png", 1024, 0.82, 0.22);
await browser.close();
