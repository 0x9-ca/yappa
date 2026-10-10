/**
 * Relays a live stream's master playlist from Twitch's usher, so the page can read which
 * qualities exist. The page can't fetch it itself: usher sends CORS headers only to twitch.tv
 * origins. Only this small text file (a few KB) passes through the Worker. The page still gets
 * the playback token from Twitch and plays the video directly, so no video ever goes through here.
 * Unofficial and opt-in like the rest of the native player: any failure just means no quality menu.
 */
const USHER = "https://usher.ttvnw.net/api/channel/hls/";
const MAX_PLAYLIST = 200_000;

export type MasterResult = { ok: true; playlist: string } | { ok: false; status: number; error: string };

const bad = (error: string): MasterResult => ({ ok: false, status: 400, error });

export async function relayMaster(input: { login?: unknown; sig?: unknown; token?: unknown }): Promise<MasterResult> {
  const login = typeof input.login === "string" ? input.login.toLowerCase() : "";
  if (!/^[a-z0-9_]{1,25}$/.test(login)) return bad("Bad channel name.");
  const { sig, token } = input;
  if (typeof sig !== "string" || !/^[0-9a-f]{20,128}$/i.test(sig)) return bad("Bad playback signature.");
  if (typeof token !== "string" || token.length > 8192) return bad("Bad playback token.");
  try {
    // The token is signed by Twitch and names its channel; refuse one made for another channel.
    const parsed = JSON.parse(token) as { channel?: unknown };
    if (String(parsed.channel).toLowerCase() !== login) return bad("That token is for another channel.");
  } catch {
    return bad("Bad playback token.");
  }

  const params = new URLSearchParams({
    sig,
    token,
    allow_source: "true",
    allow_audio_only: "true",
    fast_bwe: "true",
    p: String(Math.floor(Math.random() * 1e7)),
    player: "twitchweb",
    playlist_include_framerate: "true",
    supported_codecs: "avc1",
  });
  let res: Response;
  try {
    res = await fetch(`${USHER}${login}.m3u8?${params}`, {
      headers: { Accept: "application/vnd.apple.mpegurl, */*" },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.error("usher unreachable", (err as Error).message);
    return { ok: false, status: 502, error: "Couldn't reach Twitch's playlist server." };
  }
  if (!res.ok) {
    console.error("usher answered", res.status);
    return { ok: false, status: 502, error: `Twitch's playlist server answered ${res.status}.` };
  }
  const playlist = await res.text();
  if (playlist.length > MAX_PLAYLIST || !playlist.startsWith("#EXTM3U")) {
    return { ok: false, status: 502, error: "Twitch sent an unexpected playlist." };
  }
  return { ok: true, playlist };
}
