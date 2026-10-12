import { APP_NAME, THEME_COLOR, versioned } from "./static";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Defense in depth for a page that renders other people's chat: only our own script and
 * the Twitch player's may run, and nobody may frame the app.
 */
export const PAGE_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "script-src 'self' https://player.twitch.tv; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

/** The step-by-step guide to running your own copy, linked from the sign-in page. */
export const SELF_HOSTING_URL = "https://github.com/0x9-ca/yappa/blob/main/docs/SELF-HOSTING.md";

const LOGIN_MESSAGES: Record<string, string> = {
  denied: "That Twitch account isn't allowed to use this app.",
  state: "The sign-in didn't complete (it may have taken too long). Try again.",
  failed: "Twitch sign-in failed. Try again.",
  cancelled: "Sign-in was cancelled.",
};

/** What signed-out visitors see: no app, no data, just the way in. `error` is one of LOGIN_MESSAGES' keys. */
export function renderLogin(error?: string | null): string {
  const message = error ? LOGIN_MESSAGES[error] : undefined;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${APP_NAME}</title>
<meta name="theme-color" content="${THEME_COLOR}">
<link rel="icon" type="image/png" sizes="32x32" href="${versioned("/icons/favicon-32.png")}">
<script src="${versioned("/theme.js")}"></script>
<link rel="stylesheet" href="${versioned("/app.css")}">
</head>
<body>
<div class="connect" style="min-height:100vh">
  <div>
    <h1 style="margin:0 0 12px;font-size:20px">${APP_NAME}</h1>
    ${message ? `<p class="banner error" role="alert">${escapeHtml(message)}</p>` : ""}
    <p>A private Twitch chat client. Sign in with Twitch to continue.</p>
    <a class="btn" href="/auth/login">Sign in with Twitch</a>
    <p style="font-size:13px"><a href="${SELF_HOSTING_URL}" target="_blank" rel="noopener noreferrer">Want your own? Self-hosting guide</a></p>
  </div>
</div>
</body>
</html>`;
}

export function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>${APP_NAME}</title>
<meta name="theme-color" content="${THEME_COLOR}">
<script src="${versioned("/theme.js")}"></script>
<!-- Access protects the manifest too, so the browser must send cookies when fetching it. -->
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<link rel="icon" type="image/png" sizes="32x32" href="${versioned("/icons/favicon-32.png")}">
<link rel="apple-touch-icon" href="${versioned("/icons/apple-touch-icon.png")}">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${APP_NAME}">
<link rel="stylesheet" href="${versioned("/app.css")}">
</head>
<body>
<div class="app">
  <div class="top">
    <header>
      <h1><img src="${versioned("/icons/icon-192.png")}" alt="${APP_NAME}" width="30" height="30"></h1>
      <form id="join-form">
        <input id="channel" placeholder="Open a channel" autocomplete="off" spellcheck="false" aria-label="Channel">
        <button class="ghost" type="submit">Open</button>
      </form>
      <div class="account" id="account" hidden>
        <button class="avatar-btn" id="profile-btn" type="button" aria-haspopup="menu" aria-expanded="false" title="Account" aria-label="Account menu">
          <span class="avatar-letter" id="avatar-letter"></span>
          <img id="avatar-img" alt="" referrerpolicy="no-referrer" hidden>
        </button>
      </div>
      <div class="follow-list" id="follow-list" role="listbox" aria-label="Channels you follow" hidden></div>
      <div class="account-menu" id="account-menu" role="menu" aria-label="Account" hidden></div>
    </header>
    <nav class="tabs" id="tabs" aria-label="Open channels" hidden></nav>
    <div id="banners">
      <div class="banner error" id="error" hidden></div>
      <div class="banner error" id="expired" hidden>Your sign-in has ended. <a href="/auth/login">Sign in again</a></div>
      <div class="banner info" id="reauth" hidden>Twitch needs extra permissions to read and send chat. <a href="/auth/login">Reconnect Twitch</a></div>
      <div class="banner info" id="reauth-optional" hidden><a href="/auth/login">Reconnect Twitch</a> to enable your Twitch emotes, followed channels, clipping and mod tools.</div>
      <div class="banner info" id="cycle-status" hidden></div>
    </div>
  </div>

  <div class="video" id="video" data-hls-src="${versioned("/hls.js")}" hidden></div>
  <div class="chat" id="chat" hidden>
    <div class="infobar" id="infobar" hidden>
      <span class="live" id="live"></span>
      <span class="modes" id="modes"></span>
      <button class="icon-btn" id="video-btn" type="button" title="Show or hide the stream" aria-label="Show or hide the stream" aria-pressed="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="13" rx="2"/><path d="m8 2 4 4 4-4"/></svg>
      </button>
      <button class="icon-btn" id="pin-btn" type="button" aria-pressed="false" hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 3h6l-1 7 3 3v2H7v-2l3-3z"/></svg>
      </button>
      <button class="icon-btn" id="pip-btn" type="button" title="Picture-in-picture" aria-label="Picture-in-picture" hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="11" width="8" height="6" rx="1" fill="currentColor"/></svg>
      </button>
      <button class="icon-btn" id="follow-btn" type="button" aria-pressed="false" hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/></svg>
      </button>
      <button class="icon-btn" id="clips-btn" type="button" title="Clips and VODs" aria-label="Clips and VODs">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4l2 5M14 4l2 5"/></svg>
      </button>
      <button class="icon-btn" id="search-btn" type="button" title="Search chat" aria-label="Search chat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      </button>
      <button class="ghost small" id="quality-btn" type="button" aria-haspopup="menu" aria-expanded="false" title="Video quality" hidden>Auto</button>
      <button class="ghost small" id="modes-btn" type="button" hidden>Modes</button>
    </div>
    <div class="quality-menu" id="quality-menu" role="menu" aria-label="Video quality" hidden></div>
    <div class="searchbar" id="searchbar" hidden>
      <input id="search" placeholder="Filter: words, or from:name" autocomplete="off" spellcheck="false" aria-label="Filter chat">
      <span class="search-count" id="search-count"></span>
      <button class="icon-btn" id="search-close" type="button" aria-label="Close search">×</button>
    </div>
    <div class="panel" id="modes-panel" hidden></div>
    <div class="empty-chat" id="empty-chat">Open a channel above to start chatting.</div>
    <button class="more" id="more" hidden>More messages below</button>
  </div>
  <div class="connect" id="connect" hidden>
    <div>
      <p>Connect your Twitch account to read and send chat.</p>
      <a class="btn" href="/auth/login">Connect Twitch</a>
    </div>
  </div>

  <footer id="footer" hidden>
    <div class="replying" id="replying" hidden><span id="replying-text"></span><button class="link" id="reply-cancel">cancel</button></div>
    <div class="popover picker" id="picker" hidden>
      <input id="emote-search" placeholder="Search emotes" autocomplete="off" spellcheck="false" aria-label="Search emotes">
      <div class="note" id="picker-note" hidden></div>
      <div class="scroll" id="picker-list"></div>
    </div>
    <div class="popover suggest" id="suggest" role="listbox" hidden></div>
    <form id="send-form">
      <button type="button" class="ghost" id="emote-btn" aria-label="Emotes" title="Emotes" disabled>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9.5h.01M15 9.5h.01" stroke-width="3"/></svg>
      </button>
      <button type="button" class="ghost" id="twitch-btn" aria-label="Bits and channel points (opens Twitch)" title="Bits and channel points: open on Twitch" disabled>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M6 3h12l4 6-10 12L2 9z"/><path d="M2 9h20"/></svg>
      </button>
      <div id="message" class="composer" contenteditable="false" role="textbox" aria-label="Message" aria-disabled="true"
        data-placeholder="Open a channel to chat" autocapitalize="off" autocorrect="off" spellcheck="true" enterkeyhint="send"></div>
      <button type="submit" id="send" disabled>Chat</button>
    </form>
    <div id="send-error" hidden></div>
  </footer>
</div>
<div class="sheet-backdrop" id="sheet" hidden>
  <div class="sheet" role="dialog" aria-modal="true">
    <button class="icon-btn sheet-close" id="sheet-close" type="button" aria-label="Close">×</button>
    <div id="sheet-body"></div>
  </div>
</div>
<!-- A channel's clips and VODs, and creating clips. Built by app.js. -->
<div class="sheet-backdrop" id="browse-modal" hidden>
  <div class="sheet wide tall" role="dialog" aria-modal="true" aria-labelledby="browse-title">
    <button class="icon-btn sheet-close" id="browse-close" type="button" aria-label="Close">×</button>
    <h2 id="browse-title"></h2>
    <div id="browse-body"></div>
  </div>
</div>
<!-- Twitch's chat embed (experimental). Closing only hides it: the iframes stay loaded so you
     stay signed in, since reloading one repeats Twitch's sign-in and storage-permission steps. -->
<div class="sheet-backdrop" id="embed-modal" hidden>
  <div class="sheet wide" role="dialog" aria-modal="true" aria-labelledby="embed-title">
    <button class="icon-btn sheet-close" id="embed-close" type="button" aria-label="Minimize" title="Minimize (keeps you signed in)">×</button>
    <h2 id="embed-title"></h2>
    <div id="embed-frames"></div>
    <div class="row embed-actions"><button class="ghost small" id="embed-reload" type="button">Reload</button><button class="small" id="embed-go" type="button"></button></div>
  </div>
</div>
<!-- Parked here while Settings is closed; the settings sheet shows it. -->
<div hidden id="stash">
  <div class="cycler" id="cycler" title="Your current chat color">
    <div class="swatch" id="swatch"></div>
    <code id="color">—</code>
    <button class="ghost" id="cycle" type="button">Cycle color</button>
  </div>
</div>
<script src="${versioned("/app.js")}"></script>
</body>
</html>`;
}
