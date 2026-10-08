import { DurableObject } from "cloudflare:workers";
import {
  SCOPES,
  TwitchError,
  createWebSocketSubscription,
  exchangeCode,
  getBadges,
  getUser,
  isLive,
  refreshToken,
  revokeToken,
  sendChatMessage,
  setChatColor,
  validateToken,
} from "./twitch";

const TICK_MS = 10_000;
// Twitch requires apps to re-validate held tokens at least hourly.
const VALIDATE_EVERY_MS = 55 * 60_000;
// Stream status can briefly flicker; require several offline checks in a row.
const OFFLINE_TICKS_BEFORE_STOP = 3;
const ERROR_TICKS_BEFORE_STOP = 6;
const CHAT_EVENTS = [
  "channel.chat.message",
  "channel.chat.notification",
  "channel.chat.message_delete",
  "channel.chat.clear",
  "channel.chat.clear_user_messages",
];

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  validatedAt: number;
  userId: string;
  login: string;
  scopes?: string[];
}

interface Run {
  id: string;
  channel: string;
  running: boolean;
  startedAt: number;
  stoppedAt?: number;
  stoppedReason?: string;
  lastColor?: string;
  lastTickAt?: number;
  changes: number;
  offlineStreak: number;
  errorStreak: number;
  lastError?: string;
}

export interface Status {
  twitch: { login: string; userId: string; missingScopes: string[] } | null;
  run: Omit<Run, "id" | "offlineStreak" | "errorStreak"> | null;
}

function randomHexColor(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  return "#" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** One instance per Access user. Holds Twitch tokens and drives the color loop via alarms. */
export class ColorLoop extends DurableObject<Env> {
  private async getTokens(): Promise<Tokens | undefined> {
    return this.ctx.storage.get<Tokens>("tokens");
  }

  private async getRun(): Promise<Run | undefined> {
    return this.ctx.storage.get<Run>("run");
  }

  async status(): Promise<Status> {
    let [tokens, run] = await Promise.all([this.getTokens(), this.getRun()]);
    if (tokens && !tokens.scopes) tokens = await this.backfillScopes(tokens);
    let publicRun: Status["run"] = null;
    if (run) {
      const { id, offlineStreak, errorStreak, ...rest } = run;
      publicRun = rest;
    }
    return {
      twitch: tokens
        ? {
            login: tokens.login,
            userId: tokens.userId,
            missingScopes: SCOPES.filter((s) => !tokens.scopes?.includes(s)),
          }
        : null,
      run: publicRun,
    };
  }

  /** Tokens saved by older code lack the scope list; ask Twitch for it. */
  private async backfillScopes(tokens: Tokens): Promise<Tokens> {
    try {
      const info = await this.withToken((t) => validateToken(t.accessToken));
      const current = await this.getTokens();
      if (!current) return tokens;
      const next = { ...current, scopes: info.scopes, validatedAt: Date.now() };
      await this.ctx.storage.put("tokens", next);
      return next;
    } catch {
      return tokens;
    }
  }

  async connectTwitch(code: string, redirectUri: string): Promise<void> {
    const tok = await exchangeCode(this.env, code, redirectUri);
    const info = await validateToken(tok.access_token);
    await this.ctx.storage.put<Tokens>("tokens", {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: Date.now() + tok.expires_in * 1000,
      validatedAt: Date.now(),
      userId: info.user_id,
      login: info.login,
      scopes: info.scopes,
    });
  }

  /** Subscribes the browser's EventSub WebSocket session to a channel's chat events. */
  async chatSubscribe(
    channel: string,
    sessionId: string,
  ): Promise<{ ok: true; broadcaster: { id: string; login: string; name: string } } | { ok: false; error: string }> {
    try {
      return await this.withToken(async (t) => {
        const user = await getUser(this.env, t.accessToken, channel);
        if (!user) return { ok: false as const, error: `No Twitch channel named ${channel}.` };
        const condition = { broadcaster_user_id: user.id, user_id: t.userId };
        await Promise.all(
          CHAT_EVENTS.map((type) => createWebSocketSubscription(this.env, t.accessToken, type, condition, sessionId)),
        );
        return { ok: true as const, broadcaster: { id: user.id, login: user.login, name: user.display_name } };
      });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async chatSend(
    broadcasterId: string,
    message: string,
    replyParentId?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = await this.withToken((t) =>
        sendChatMessage(this.env, t.accessToken, broadcasterId, t.userId, message, replyParentId),
      );
      return res.is_sent ? { ok: true } : { ok: false, error: res.drop_reason?.message ?? "Message was not sent." };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async chatBadges(broadcasterId: string): Promise<Record<string, { url: string; title: string }>> {
    try {
      return await this.withToken((t) => getBadges(this.env, t.accessToken, broadcasterId));
    } catch {
      return {};
    }
  }

  async disconnectTwitch(): Promise<void> {
    await this.stop("Twitch disconnected");
    const tokens = await this.getTokens();
    await this.ctx.storage.delete("tokens");
    if (tokens) await revokeToken(this.env, tokens.accessToken).catch(() => {});
  }

  async start(channel: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!(await this.getTokens())) return { ok: false, error: "Connect your Twitch account first." };

    try {
      const live = await this.withToken((t) => isLive(this.env, t.accessToken, channel));
      if (!live) return { ok: false, error: `${channel} is not live right now.` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }

    await this.ctx.storage.put<Run>("run", {
      id: crypto.randomUUID(),
      channel,
      running: true,
      startedAt: Date.now(),
      changes: 0,
      offlineStreak: 0,
      errorStreak: 0,
    });
    await this.ctx.storage.setAlarm(Date.now());
    return { ok: true };
  }

  async stop(reason = "Stopped by you"): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    const run = await this.getRun();
    if (run?.running) {
      await this.ctx.storage.put<Run>("run", {
        ...run,
        running: false,
        stoppedAt: Date.now(),
        stoppedReason: reason,
      });
    }
  }

  async alarm(): Promise<void> {
    const run = await this.getRun();
    if (!run?.running) return;

    // Schedule the next tick up front so a thrown error can't kill the loop.
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);

    const update: Partial<Run> = { lastTickAt: Date.now() };
    let stopReason: string | undefined;

    try {
      const live = await this.withToken((t) => isLive(this.env, t.accessToken, run.channel));
      if (!live) {
        update.offlineStreak = run.offlineStreak + 1;
        if (update.offlineStreak >= OFFLINE_TICKS_BEFORE_STOP) stopReason = `${run.channel} went offline`;
      } else {
        update.offlineStreak = 0;
        const color = randomHexColor();
        await this.withToken((t) => setChatColor(this.env, t.accessToken, t.userId, color));
        update.lastColor = color;
        update.changes = run.changes + 1;
      }
      update.errorStreak = 0;
      update.lastError = undefined;
    } catch (err) {
      update.lastError = (err as Error).message;
      update.errorStreak = run.errorStreak + 1;
      // 400 from Update User Chat Color usually means no Turbo/Prime (hex not allowed);
      // 401 after a refresh attempt means the grant was revoked. Neither will recover.
      if (err instanceof TwitchError && (err.status === 400 || err.status === 401)) {
        stopReason = update.lastError;
      } else if (update.errorStreak >= ERROR_TICKS_BEFORE_STOP) {
        stopReason = `Too many errors in a row: ${update.lastError}`;
      }
    }

    // Re-read: the user may have stopped or restarted while we were awaiting Twitch.
    const current = await this.getRun();
    if (!current?.running || current.id !== run.id) return;

    console.log(
      JSON.stringify({ tick: run.channel, color: update.lastColor, offlineStreak: update.offlineStreak, error: update.lastError, stopReason }),
    );

    const next: Run = { ...current, ...update };
    if (stopReason) {
      next.running = false;
      next.stoppedAt = Date.now();
      next.stoppedReason = stopReason;
      await this.ctx.storage.deleteAlarm();
    }
    await this.ctx.storage.put<Run>("run", next);
  }

  /**
   * Runs fn with a fresh access token: refreshes ahead of expiry, re-validates
   * hourly, and retries once after a refresh if Twitch says 401.
   */
  private async withToken<T>(fn: (t: Tokens) => Promise<T>): Promise<T> {
    let tokens = await this.getTokens();
    if (!tokens) throw new TwitchError(401, "Twitch account not connected");

    if (tokens.expiresAt - Date.now() < 60_000) {
      tokens = await this.refresh(tokens);
    } else if (Date.now() - tokens.validatedAt > VALIDATE_EVERY_MS) {
      try {
        await validateToken(tokens.accessToken);
        tokens = { ...tokens, validatedAt: Date.now() };
        await this.ctx.storage.put("tokens", tokens);
      } catch (err) {
        if (!(err instanceof TwitchError && err.status === 401)) throw err;
        tokens = await this.refresh(tokens);
      }
    }

    try {
      return await fn(tokens);
    } catch (err) {
      if (!(err instanceof TwitchError && err.status === 401)) throw err;
      return fn(await this.refresh(tokens));
    }
  }

  private async refresh(tokens: Tokens): Promise<Tokens> {
    let tok;
    try {
      tok = await refreshToken(this.env, tokens.refreshToken);
    } catch (err) {
      if (err instanceof TwitchError && (err.status === 400 || err.status === 401)) {
        await this.ctx.storage.delete("tokens");
        throw new TwitchError(401, "Twitch authorization expired or was revoked; reconnect your account.");
      }
      throw err;
    }
    const next: Tokens = {
      ...tokens,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: Date.now() + tok.expires_in * 1000,
      validatedAt: Date.now(),
    };
    await this.ctx.storage.put("tokens", next);
    return next;
  }
}
