import { APP_NAME, THEME_COLOR, versioned } from "./static";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function renderPage(user: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>${APP_NAME}</title>
<meta name="theme-color" content="${THEME_COLOR}">
<!-- Access protects the manifest too, so the browser must send cookies when fetching it. -->
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<link rel="icon" type="image/png" sizes="32x32" href="${versioned("/icons/favicon-32.png")}">
<link rel="apple-touch-icon" href="${versioned("/icons/apple-touch-icon.png")}">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Chat">
<link rel="stylesheet" href="${versioned("/app.css")}">
</head>
<body>
<div class="app">
  <div class="top">
    <header>
      <h1>Chat</h1>
      <form id="join-form">
        <input id="channel" placeholder="Open a channel" autocomplete="off" spellcheck="false" aria-label="Channel">
        <button class="ghost" type="submit">Open</button>
      </form>
      <div class="cycler" id="cycler" hidden title="Your current chat color">
        <div class="swatch" id="swatch"></div>
        <code id="color">—</code>
        <button class="ghost" id="cycle">Cycle color</button>
      </div>
      <div class="account" id="account" hidden>
        <span id="login"></span> · <button class="link" id="logout">disconnect</button>
      </div>
    </header>
    <nav class="tabs" id="tabs" aria-label="Open channels" hidden></nav>
    <div id="banners">
      <div class="banner error" id="error" hidden></div>
      <div class="banner info" id="reauth" hidden>Twitch needs extra permissions to read and send chat. <a href="/auth/login">Reconnect Twitch</a></div>
      <div class="banner info" id="reauth-optional" hidden><a href="/auth/login">Reconnect Twitch</a> to enable your Twitch emotes and mod tools.</div>
      <div class="banner info" id="cycle-status" hidden></div>
    </div>
  </div>

  <div class="chat" id="chat" hidden>
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
      <input id="message" placeholder="Open a channel to chat" autocomplete="off" autocapitalize="off" maxlength="500" disabled aria-label="Message">
      <button type="submit" id="send" disabled>Chat</button>
    </form>
    <div id="send-error" hidden></div>
  </footer>
</div>
<div hidden id="access-user">${escapeHtml(user)}</div>
<script src="${versioned("/app.js")}"></script>
</body>
</html>`;
}
