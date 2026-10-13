/**
 * What gets synced between a user's devices: the app's settings, the open tabs and the pinned
 * stream. Per-device things (player choice, theme, text size, notification permission) stay
 * out; the client decides which keys go in. The server only checks the shape and size.
 */

export interface SyncBlob {
  /** When it was last changed (ms, from the device's clock); the newest write wins. */
  at: number;
  settings: Record<string, unknown>;
  tabs: string[];
  pinned: string | null;
}

export const MAX_SYNC_BYTES = 60_000;
const CHANNEL = /^[a-z0-9_]{1,25}$/;

export function parseSync(body: unknown): SyncBlob | string {
  if (!body || typeof body !== "object") return "Bad sync data.";
  const b = body as Record<string, unknown>;
  if (typeof b.at !== "number" || !Number.isFinite(b.at) || b.at < 0) return "Bad sync time.";
  if (!b.settings || typeof b.settings !== "object" || Array.isArray(b.settings)) return "Bad settings.";
  if (!Array.isArray(b.tabs) || b.tabs.length > 100 || !b.tabs.every((t) => typeof t === "string" && CHANNEL.test(t))) return "Bad tab list.";
  if (b.pinned != null && !(typeof b.pinned === "string" && CHANNEL.test(b.pinned))) return "Bad pinned stream.";
  if (JSON.stringify(b.settings).length > MAX_SYNC_BYTES) return "Settings are too large to sync.";
  return { at: Math.floor(b.at), settings: b.settings as Record<string, unknown>, tabs: b.tabs as string[], pinned: (b.pinned as string | null) ?? null };
}
