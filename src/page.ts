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

export function renderPage(user: string): string {
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
      <h1>${APP_NAME}</h1>
      <form id="join-form">
        <input id="channel" placeholder="Open a channel" autocomplete="off" spellcheck="false" aria-label="Channel">
        <button class="ghost" type="submit">Open</button>
      </form>
      <div class="account" id="account" hidden>
        <button class="icon-btn" id="settings-btn" type="button" title="Settings" aria-label="Settings">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
        </button>
      </div>
      <div class="follow-list" id="follow-list" role="listbox" aria-label="Channels you follow" hidden></div>
    </header>
    <nav class="tabs" id="tabs" aria-label="Open channels" hidden></nav>
    <div id="banners">
      <div class="banner error" id="error" hidden></div>
      <div class="banner info" id="reauth" hidden>Twitch needs extra permissions to read and send chat. <a href="/auth/login">Reconnect Twitch</a></div>
      <div class="banner info" id="reauth-optional" hidden><a href="/auth/login">Reconnect Twitch</a> to enable your Twitch emotes, followed channels and mod tools.</div>
      <div class="banner info" id="cycle-status" hidden></div>
    </div>
  </div>

  <div class="video" id="video" hidden></div>
  <div class="chat" id="chat" hidden>
    <div class="infobar" id="infobar" hidden>
      <span class="live" id="live"></span>
      <span class="modes" id="modes"></span>
      <button class="icon-btn" id="video-btn" type="button" title="Show or hide the stream" aria-label="Show or hide the stream" aria-pressed="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="13" rx="2"/><path d="m8 2 4 4 4-4"/></svg>
      </button>
      <button class="icon-btn" id="pip-btn" type="button" title="Picture-in-picture" aria-label="Picture-in-picture" hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="11" width="8" height="6" rx="1" fill="currentColor"/></svg>
      </button>
      <button class="icon-btn" id="search-btn" type="button" title="Search chat" aria-label="Search chat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      </button>
      <button class="ghost small" id="modes-btn" type="button" hidden>Modes</button>
    </div>
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
<!-- Parked here while Settings is closed; the settings sheet shows it. -->
<div hidden id="stash">
  <div class="cycler" id="cycler" title="Your current chat color">
    <div class="swatch" id="swatch"></div>
    <code id="color">—</code>
    <button class="ghost" id="cycle" type="button">Cycle color</button>
  </div>
</div>
<div hidden id="access-user">${escapeHtml(user)}</div>
<script src="${versioned("/app.js")}"></script>
</body>
</html>`;
}
