import { DurableObject } from "cloudflare:workers";
import {
  OPTIONAL_SCOPES,
  SCOPES,
  TwitchError,
  addBlockedTerm,
  banUser,
  checkSubscription,
  getBlockedTerms,
  getBlockedUsers,
  getChatters,
  getShieldMode,
  getUnbanRequests,
  removeBlockedTerm,
  resolveUnbanRequest,
  sendAnnouncement,
  sendShoutout,
  sendWhisper,
  setBlocked,
  setShieldMode,
  setSuspicious,
  warnUser,
  createClip,
  createWebSocketSubscription,
  deleteChatMessages,
  deleteSubscription,
  getChatSettings,
  getFollowedAt,
  getUserById,
  getDisplayNames,
  manageHeldMessage,
  updateChatSettings,
  getUser,
  getModeratedChannelIds,
  getFollowedChannels,
  getFollowedStreams,
  getUserEmotes,
  refreshToken,
  revokeToken,
  sendChatMessage,
  setChatColor,
  unbanUser,
  validateToken,
} from "./twitch";
import { clipFailure } from "./browse";
import { slimTerm, slimUnban, toolFailure } from "./tools";
import type { SubStatus, Term, UnbanRequest } from "./tools";
import type { SyncBlob } from "./sync";

// Twitch requires apps to re-validate held tokens at least hourly.
const VALIDATE_EVERY_MS = 55 * 60_000;
const CHAT_EVENTS = [
  "channel.chat.message",
  "channel.chat.notification",
  "channel.chat.message_delete",
  "channel.chat.clear",
  "channel.chat.clear_user_messages",
  "channel.chat_settings.update",
];
// Moderator-only; condition uses moderator_user_id rather than user_id.
const AUTOMOD_EVENTS = ["automod.message.hold", "automod.message.update"];

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  validatedAt: number;
  userId: string;
  login: string;
  scopes?: string[];
}

/** "Change my chat color every time I send a message." */
interface Cycle {
  enabled: boolean;
  lastColor?: string;
  changes: number;
  lastError?: string;
}

export interface Status {
  twitch: {
    login: string;
    userId: string;
    displayName: string;
    avatar: string | null;
    missingScopes: string[];
    missingOptionalScopes: string[];
  } | null;
  cycle: Cycle;
}

/** Who the connected account is, for the account menu. Cached: it rarely changes. */
interface Profile {
  userId: string;
  displayName: string;
  avatar: string | null;
  at: number;
}

const PROFILE_TTL_MS = 24 * 3600_000;
const MAX_CLIP_HISTORY = 500;

interface Following {
  channels: { id: string; login: string; name: string }[];
  live: { id: string; login: string; name: string; title: string; game: string; viewers: number; startedAt: string }[];
}

function randomHexColor(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  return "#" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** One instance per Access user. Holds Twitch tokens and the color-cycling setting. */
export class ColorLoop extends DurableObject<Env> {
  /** Channel owners' display names, for grouping emotes. */
  private ownerNames = new Map<string, string>();
  private moderated: { at: number; ids: Set<string> } | undefined;
  /** The refresh in progress, shared so concurrent requests don't spend the refresh token twice. */
  private refreshing: Promise<Tokens> | undefined;
  /** Recent message ids that already advanced the color (from any device running the app). */
  private colored = new Set<string>();
  /** Followed channels, briefly cached: the list is fetched whenever the channel box is focused. */
  private following: { at: number; data: Following } | undefined;

  private async getTokens(): Promise<Tokens | undefined> {
    return this.ctx.storage.get<Tokens>("tokens");
  }

  private async getCycle(): Promise<Cycle> {
    return (await this.ctx.storage.get<Cycle>("cycle")) ?? { enabled: false, changes: 0 };
  }

  /**
   * Restarts this object if the calling Worker runs newer code. A deploy doesn't always
   * restart a busy Durable Object, which would leave it without newly added methods.
   */
  async syncVersion(callerTimestamp: string): Promise<void> {
    if (Date.parse(callerTimestamp) > Date.parse(this.env.CF_VERSION_METADATA.timestamp)) {
      this.ctx.abort("A newer Worker version is deployed");
    }
  }

  async status(): Promise<Status> {
    const [tokens, cycle] = await Promise.all([this.getTokens(), this.getCycle()]);
    const profile = tokens ? await this.getProfile(tokens) : null;
    return {
      twitch: tokens
        ? {
            login: tokens.login,
            userId: tokens.userId,
            displayName: profile?.displayName ?? tokens.login,
            avatar: profile?.avatar ?? null,
            missingScopes: SCOPES.filter((s) => !tokens.scopes?.includes(s)),
            missingOptionalScopes: OPTIONAL_SCOPES.filter((s) => !tokens.scopes?.includes(s)),
          }
        : null,
      cycle,
    };
  }

  /** The account's display name and picture, refreshed at most daily. Never fails the caller. */
  private async getProfile(tokens: Tokens): Promise<Profile | undefined> {
    const stored = await this.ctx.storage.get<Profile>("profile");
    if (stored && stored.userId === tokens.userId && Date.now() - stored.at < PROFILE_TTL_MS) return stored;
    try {
      const u = await this.withToken((t) => getUserById(this.env, t.accessToken, tokens.userId));
      if (!u) return stored;
      const fresh: Profile = { userId: tokens.userId, displayName: u.display_name, avatar: u.profile_image_url || null, at: Date.now() };
      await this.ctx.storage.put("profile", fresh);
      return fresh;
    } catch {
      return stored?.userId === tokens.userId ? stored : undefined; // try again next time
    }
  }

  /** Keeps the tokens from a completed sign-in (the Worker already exchanged the code and validated them). */
  async storeTokens(tok: { access_token: string; refresh_token: string; expires_in: number }, info: { user_id: string; login: string; scopes: string[] }): Promise<void> {
    this.moderated = undefined;
    this.following = undefined;
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

  /**
   * Subscribes the browser's EventSub WebSocket session to a channel's chat events.
   * isMod is null when we lack the scope to find out.
   */
  async chatSubscribe(
    channel: string,
    sessionId: string,
    opts: { modLog?: boolean } = {},
  ): Promise<
    | {
        ok: true;
        broadcaster: { id: string; login: string; name: string };
        isMod: boolean | null;
        subscriptionIds: string[];
        automod: boolean;
        settings: unknown;
        /** Which extra moderator feeds are on for this channel. */
        feeds: { suspicious: boolean; unbans: boolean; modLog: boolean };
      }
    | { ok: false; error: string }
  > {
    try {
      return await this.withToken(async (t) => {
        const user = await getUser(this.env, t.accessToken, channel);
        if (!user) return { ok: false as const, error: `No Twitch channel named ${channel}.` };
        const condition = { broadcaster_user_id: user.id, user_id: t.userId };
        const [created, isMod, settings] = await Promise.all([
          Promise.allSettled(
            CHAT_EVENTS.map((type) => createWebSocketSubscription(this.env, t.accessToken, type, condition, sessionId)),
          ),
          this.isModerator(t, user.id),
          getChatSettings(this.env, t.accessToken, user.id).catch(() => null),
        ]);
        const subscriptionIds = created.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
        const failed = created.find((r) => r.status === "rejected");
        if (failed) {
          // Don't leave half a channel subscribed (they count against the session's limit).
          await Promise.all(subscriptionIds.map((id) => deleteSubscription(this.env, t.accessToken, id).catch(() => {})));
          throw failed.reason;
        }
        // Outgoing raids from this channel (no special permission needed).
        try {
          subscriptionIds.push(
            await createWebSocketSubscription(this.env, t.accessToken, "channel.raid", { from_broadcaster_user_id: user.id }, sessionId),
          );
        } catch {}
        // AutoMod queue for channels we moderate (best effort: an old token may lack the scope).
        let automod = false;
        if (isMod && t.scopes?.includes("moderator:manage:automod")) {
          try {
            const modCondition = { broadcaster_user_id: user.id, moderator_user_id: t.userId };
            subscriptionIds.push(
              ...(await Promise.all(
                AUTOMOD_EVENTS.map((type) =>
                  createWebSocketSubscription(this.env, t.accessToken, type, modCondition, sessionId, "2"),
                ),
              )),
            );
            automod = true;
          } catch {}
        }
        // More moderator feeds, each best effort (a login from before they existed lacks the scope).
        const feeds = { suspicious: false, unbans: false, modLog: false };
        if (isMod) {
          const modCondition = { broadcaster_user_id: user.id, moderator_user_id: t.userId };
          const feed = async (key: keyof typeof feeds, type: string, version: string, scopes: string[]) => {
            if (!scopes.some((sc) => t.scopes?.includes(sc))) return;
            try {
              subscriptionIds.push(await createWebSocketSubscription(this.env, t.accessToken, type, modCondition, sessionId, version));
              feeds[key] = true;
            } catch {}
          };
          await Promise.all([
            feed("suspicious", "channel.suspicious_user.message", "1", ["moderator:read:suspicious_users", "moderator:manage:suspicious_users"]),
            feed("unbans", "channel.unban_request.create", "1", ["moderator:manage:unban_requests"]),
            ...(opts.modLog ? [feed("modLog", "channel.moderate", "2", ["moderator:manage:banned_users", "moderator:manage:chat_messages", "moderator:manage:chat_settings"])] : []),
          ]);
        }
        return {
          ok: true as const,
          broadcaster: { id: user.id, login: user.login, name: user.display_name },
          isMod,
          subscriptionIds,
          automod,
          settings,
          feeds,
        };
      });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Incoming whispers for this browser session (one subscription per socket, not per channel). */
  async whisperSubscribe(sessionId: string): Promise<{ ok: boolean; id?: string }> {
    const tokens = await this.getTokens();
    if (!tokens?.scopes?.includes("user:read:whispers")) return { ok: false };
    try {
      const id = await this.withToken((t) => createWebSocketSubscription(this.env, t.accessToken, "user.whisper.message", { user_id: t.userId }, sessionId));
      return { ok: true, id };
    } catch {
      return { ok: false };
    }
  }

  private async isModerator(t: Tokens, broadcasterId: string): Promise<boolean | null> {
    if (broadcasterId === t.userId) return true;
    if (!t.scopes?.includes("user:read:moderated_channels")) return null;
    if (!this.moderated || Date.now() - this.moderated.at > 5 * 60_000) {
      try {
        const ids = await getModeratedChannelIds(this.env, t.accessToken, t.userId);
        this.moderated = { at: Date.now(), ids: new Set(ids) };
      } catch {
        return null;
      }
    }
    return this.moderated.ids.has(broadcasterId);
  }

  async chatUnsubscribe(ids: string[]): Promise<void> {
    await this.withToken((t) => Promise.all(ids.map((id) => deleteSubscription(this.env, t.accessToken, id)))).catch(
      () => {},
    );
  }

  /** Moderator actions. Target users can be given by id or login. */
  async chatMod(
    broadcasterId: string,
    action: "delete" | "clear" | "ban" | "timeout" | "unban",
    target: { userId?: string; login?: string; messageId?: string; duration?: number; reason?: string },
  ): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
    try {
      return await this.withToken(async (t) => {
        if (action === "delete") {
          if (!target.messageId) return { ok: false as const, error: "Missing message." };
          await deleteChatMessages(this.env, t.accessToken, broadcasterId, t.userId, target.messageId);
          return { ok: true as const, message: "Message deleted." };
        }
        if (action === "clear") {
          await deleteChatMessages(this.env, t.accessToken, broadcasterId, t.userId);
          return { ok: true as const, message: "Chat cleared." };
        }
        let userId = target.userId;
        let name = target.login ?? "user";
        if (!userId && target.login) {
          const u = await getUser(this.env, t.accessToken, target.login);
          if (!u) return { ok: false as const, error: `No user named ${target.login}.` };
          userId = u.id;
          name = u.display_name;
        }
        if (!userId) return { ok: false as const, error: "Missing user." };
        if (action === "unban") {
          await unbanUser(this.env, t.accessToken, broadcasterId, t.userId, userId);
          return { ok: true as const, message: `Unbanned ${name}.` };
        }
        const duration = action === "timeout" ? Math.round(Math.min(1_209_600, Math.max(1, target.duration ?? 600))) : undefined;
        await banUser(this.env, t.accessToken, broadcasterId, t.userId, userId, duration, target.reason);
        return { ok: true as const, message: duration ? `Timed out ${name} for ${duration}s.` : `Banned ${name}.` };
      });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async chatSend(
    broadcasterId: string,
    message: string,
    replyParentId?: string,
  ): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
    try {
      const res = await this.withToken((t) =>
        sendChatMessage(this.env, t.accessToken, broadcasterId, t.userId, message, replyParentId),
      );
      if (!res.is_sent) return { ok: false, error: res.drop_reason?.message ?? "Message was not sent." };
      // Pick the next color now, so Twitch has applied it well before the next message.
      if (this.markColored(res.message_id) && (await this.getCycle()).enabled) await this.changeColor();
      return { ok: true, messageId: res.message_id };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Twitch emotes the user can use in this channel, slimmed down for the picker. */
  async chatEmotes(
    broadcasterId: string,
  ): Promise<{ ok: true; emotes: { id: string; name: string; group: string; animated: boolean; owner?: string }[] } | { ok: false; error: string; needsScope?: boolean }> {
    const tokens = await this.getTokens();
    if (!tokens?.scopes?.includes("user:read:emotes")) return { ok: false, error: "Missing user:read:emotes", needsScope: true };
    try {
      const list = await this.withToken((t) => getUserEmotes(this.env, t.accessToken, t.userId, broadcasterId));
      const seen = new Set<string>();
      const emotes = [];
      for (const e of list) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        const group =
          e.owner_id === broadcasterId
            ? "This channel"
            : e.emote_type === "globals" || e.owner_id === "0"
              ? "Twitch global"
              : e.emote_type === "subscriptions" || e.emote_type === "follower"
                ? "Other channels"
                : "Other";
        emotes.push({ id: e.id, name: e.name, group, animated: e.format.includes("animated"), owner: group === "Other channels" ? e.owner_id : undefined });
      }
      // Other channels' emotes are listed per channel, so look up whose they are (names rarely change: remembered).
      const unknown = [...new Set(emotes.map((e) => e.owner).filter((o): o is string => !!o && !this.ownerNames.has(o)))];
      if (unknown.length) {
        const names = await this.withToken((t) => getDisplayNames(this.env, t.accessToken, unknown)).catch(() => new Map<string, string>());
        for (const [id, name] of names) this.ownerNames.set(id, name);
      }
      return { ok: true, emotes: emotes.map((e) => (e.owner ? { ...e, owner: this.ownerNames.get(e.owner) ?? "" } : e)) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Profile + follow date for the user card. followedAt is undefined when we can't know. */
  async userCard(
    broadcasterId: string,
    userId: string,
  ): Promise<{ ok: true; user: unknown; followedAt?: string | null } | { ok: false; error: string }> {
    try {
      return await this.withToken(async (t) => {
        const canSeeFollows = t.scopes?.includes("moderator:read:followers") && (await this.isModerator(t, broadcasterId));
        const [user, followedAt] = await Promise.all([
          getUserById(this.env, t.accessToken, userId),
          canSeeFollows ? getFollowedAt(this.env, t.accessToken, broadcasterId, userId).catch(() => undefined) : undefined,
        ]);
        if (!user) return { ok: false as const, error: "User not found." };
        return { ok: true as const, user, followedAt };
      });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async automodAction(messageId: string, allow: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.withToken((t) => manageHeldMessage(this.env, t.accessToken, t.userId, messageId, allow ? "ALLOW" : "DENY"));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async updateSettings(
    broadcasterId: string,
    patch: Record<string, unknown>,
  ): Promise<{ ok: true; settings: unknown } | { ok: false; error: string }> {
    try {
      const settings = await this.withToken((t) => updateChatSettings(this.env, t.accessToken, broadcasterId, t.userId, patch));
      return { ok: true, settings };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * The user chatted from somewhere else (e.g. the official app): next color, if cycling.
   * Every open copy of the app reports the same message, so each id only counts once.
   */
  async cycleBump(messageId?: string): Promise<Cycle> {
    if ((!messageId || this.markColored(messageId)) && (await this.getCycle()).enabled) await this.changeColor();
    return this.getCycle();
  }

  /** Records that a message advanced the color; false if it already had. */
  private markColored(messageId: string): boolean {
    if (this.colored.has(messageId)) return false;
    this.colored.add(messageId);
    if (this.colored.size > 500) this.colored.delete(this.colored.values().next().value!);
    return true;
  }

  /**
   * Creates a clip of the channel's live stream as the user (needs the clips:edit permission).
   * Asynchronous on Twitch's side: the caller polls for the clip with the returned id.
   */
  async createClip(
    broadcasterId: string,
    opts: { title?: string; duration?: number },
  ): Promise<{ ok: true; id: string; editUrl: string } | { ok: false; error: string; needsScope?: boolean }> {
    const tokens = await this.getTokens();
    if (!tokens?.scopes?.includes("clips:edit")) return { ok: false, error: "Missing clips:edit", needsScope: true };
    try {
      const r = await this.withToken((t) => createClip(this.env, t.accessToken, broadcasterId, opts));
      // Twitch can't list the clips someone made, so keep our own list (newest first).
      const ids = await this.clipHistory(tokens.userId);
      await this.ctx.storage.put("clips", { userId: tokens.userId, ids: [r.id, ...ids.filter((id) => id !== r.id)].slice(0, MAX_CLIP_HISTORY) });
      return { ok: true, id: r.id, editUrl: r.edit_url };
    } catch (err) {
      if (err instanceof TwitchError) {
        // The message is "Create Clip failed (404): detail"; keep only the detail.
        return { ok: false, error: clipFailure(err.status, err.message.replace(/^[^:]*(?:\(\d+\))?:?\s*/, "")) };
      }
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Moderator and personal tools. The scope is checked first so the page can offer a reconnect;
   * Twitch itself decides whether this account may moderate the channel (moderator_id is always
   * the signed-in user). `what` words the errors ("send the announcement").
   */
  private async tool<T extends object>(
    what: string,
    scope: string,
    fn: (t: Tokens) => Promise<T>,
  ): Promise<({ ok: true } & T) | { ok: false; error: string; needsScope?: boolean }> {
    const tokens = await this.getTokens();
    if (!tokens?.scopes?.includes(scope)) return { ok: false, error: "Reconnect Twitch to allow this.", needsScope: true };
    try {
      return { ok: true, ...(await this.withToken(fn)) };
    } catch (err) {
      if (err instanceof TwitchError) {
        return { ok: false, error: toolFailure(what, err.status, err.message.replace(/^[^:]*(?:\(\d+\))?:?\s*/, "")), needsScope: err.status === 401 || undefined };
      }
      return { ok: false, error: (err as Error).message };
    }
  }

  announce(broadcasterId: string, message: string, color: string) {
    return this.tool("send the announcement", "moderator:manage:announcements", async (t) => {
      await sendAnnouncement(this.env, t.accessToken, broadcasterId, t.userId, message, color);
      return {};
    });
  }

  shoutout(broadcasterId: string, toLogin: string) {
    return this.tool("send the shoutout", "moderator:manage:shoutouts", async (t): Promise<{ target: string }> => {
      const to = await getUser(this.env, t.accessToken, toLogin);
      if (!to) throw new TwitchError(404, "Send Shoutout failed (404): no such channel");
      await sendShoutout(this.env, t.accessToken, broadcasterId, to.id, t.userId);
      return { target: to.display_name };
    });
  }

  warn(broadcasterId: string, userId: string, reason: string) {
    return this.tool("warn them", "moderator:manage:warnings", async (t) => {
      await warnUser(this.env, t.accessToken, broadcasterId, t.userId, userId, reason);
      return {};
    });
  }

  blockedTerms(broadcasterId: string) {
    return this.tool("load the blocked terms", "moderator:manage:blocked_terms", async (t): Promise<{ terms: Term[] }> => ({
      terms: (await getBlockedTerms(this.env, t.accessToken, broadcasterId, t.userId)).map(slimTerm),
    }));
  }

  addTerm(broadcasterId: string, text: string) {
    return this.tool("add the term", "moderator:manage:blocked_terms", async (t): Promise<{ term: Term }> => ({
      term: slimTerm(await addBlockedTerm(this.env, t.accessToken, broadcasterId, t.userId, text)),
    }));
  }

  removeTerm(broadcasterId: string, id: string) {
    return this.tool("remove the term", "moderator:manage:blocked_terms", async (t) => {
      await removeBlockedTerm(this.env, t.accessToken, broadcasterId, t.userId, id);
      return {};
    });
  }

  shield(broadcasterId: string) {
    return this.tool("read Shield Mode", "moderator:manage:shield_mode", async (t): Promise<{ active: boolean }> => ({
      active: await getShieldMode(this.env, t.accessToken, broadcasterId, t.userId),
    }));
  }

  setShield(broadcasterId: string, active: boolean) {
    return this.tool("change Shield Mode", "moderator:manage:shield_mode", async (t): Promise<{ active: boolean }> => ({
      active: await setShieldMode(this.env, t.accessToken, broadcasterId, t.userId, active),
    }));
  }

  suspicious(broadcasterId: string, userId: string, status: "ACTIVE_MONITORING" | "RESTRICTED" | "NONE") {
    return this.tool("change their status", "moderator:manage:suspicious_users", async (t) => {
      await setSuspicious(this.env, t.accessToken, broadcasterId, t.userId, userId, status);
      return {};
    });
  }

  unbanRequests(broadcasterId: string) {
    return this.tool("load unban requests", "moderator:manage:unban_requests", async (t): Promise<{ requests: UnbanRequest[] }> => ({
      requests: (await getUnbanRequests(this.env, t.accessToken, broadcasterId, t.userId)).map(slimUnban),
    }));
  }

  resolveUnban(broadcasterId: string, id: string, status: "approved" | "denied", text?: string) {
    return this.tool("answer the request", "moderator:manage:unban_requests", async (t) => {
      await resolveUnbanRequest(this.env, t.accessToken, broadcasterId, t.userId, id, status, text);
      return {};
    });
  }

  chatters(broadcasterId: string) {
    return this.tool("load the chatters", "moderator:read:chatters", async (t): Promise<{ total: number; names: string[] }> => getChatters(this.env, t.accessToken, broadcasterId, t.userId));
  }

  /** Whether you subscribe to a channel (sub: null when you don't, or it has no subscriptions). */
  subscription(broadcasterId: string) {
    return this.tool("check your subscription", "user:read:subscriptions", async (t): Promise<{ sub: SubStatus | null }> => {
      const s = await checkSubscription(this.env, t.accessToken, broadcasterId, t.userId);
      return { sub: s ? { tier: s.tier, isGift: s.is_gift, gifter: s.gifter_name ?? null } : null };
    });
  }

  blockedUsers() {
    return this.tool("load your block list", "user:read:blocked_users", async (t): Promise<{ users: { id: string; login: string; name: string }[] }> => ({
      users: (await getBlockedUsers(this.env, t.accessToken, t.userId)).map((u) => ({ id: u.user_id, login: u.user_login, name: u.display_name })),
    }));
  }

  block(userId: string, block: boolean) {
    return this.tool(block ? "block them" : "unblock them", "user:manage:blocked_users", async (t) => {
      await setBlocked(this.env, t.accessToken, userId, block);
      return {};
    });
  }

  whisper(userId: string, message: string) {
    return this.tool("send the whisper", "user:manage:whispers", async (t) => {
      await sendWhisper(this.env, t.accessToken, t.userId, userId, message);
      return {};
    });
  }

  /** Clip ids made through Yappa by this account (a different account's history doesn't count). */
  private async clipHistory(userId: string): Promise<string[]> {
    const stored = await this.ctx.storage.get<{ userId: string; ids: string[] }>("clips");
    return stored && stored.userId === userId ? stored.ids : [];
  }

  /** One page of the ids of clips made through Yappa, newest first. */
  async myClips(offset: number, limit: number): Promise<{ ids: string[]; total: number }> {
    const tokens = await this.getTokens();
    const history = tokens ? await this.clipHistory(tokens.userId) : [];
    return { ids: history.slice(offset, offset + limit), total: history.length };
  }

  /** Channels the user follows, and which of them are live (for the channel picker). */
  async followed(fresh = false): Promise<({ ok: true } & Following) | { ok: false; error: string; needsScope?: boolean }> {
    const tokens = await this.getTokens();
    if (!tokens?.scopes?.includes("user:read:follows")) return { ok: false, error: "Missing user:read:follows", needsScope: true };
    if (!fresh && this.following && Date.now() - this.following.at < 2 * 60_000) return { ok: true, ...this.following.data };
    try {
      const data = await this.withToken(async (t) => {
        const [channels, live] = await Promise.all([
          getFollowedChannels(this.env, t.accessToken, t.userId),
          getFollowedStreams(this.env, t.accessToken, t.userId),
        ]);
        return {
          channels: channels.map((c) => ({ id: c.broadcaster_id, login: c.broadcaster_login, name: c.broadcaster_name })),
          live: live.map((s) => ({
            id: s.user_id, login: s.user_login, name: s.user_name, title: s.title, game: s.game_name,
            viewers: s.viewer_count, startedAt: s.started_at,
          })),
        };
      });
      this.following = { at: Date.now(), data };
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Settings, open tabs and the pinned stream, as last saved from any of the user's devices. */
  async getSync(): Promise<SyncBlob | null> {
    return (await this.ctx.storage.get<SyncBlob>("sync")) ?? null;
  }

  /** Newest write wins: an older blob (a device that's been offline) doesn't overwrite a newer one. */
  async putSync(blob: SyncBlob): Promise<{ ok: true; stored: boolean; current: SyncBlob }> {
    const current = await this.getSync();
    if (current && current.at > blob.at) return { ok: true, stored: false, current };
    await this.ctx.storage.put("sync", blob);
    return { ok: true, stored: true, current: blob };
  }

  async disconnectTwitch(): Promise<void> {
    await this.ctx.storage.delete("profile");
    this.following = undefined;
    this.moderated = undefined;
    await this.setCycle(false);
    const tokens = await this.getTokens();
    await this.ctx.storage.delete("tokens");
    if (tokens) await revokeToken(this.env, tokens.accessToken).catch(() => {});
  }

  /** Turning cycling on picks a color immediately, so the very next message is already new. */
  async setCycle(enabled: boolean): Promise<Cycle> {
    const cycle = { ...(await this.getCycle()), enabled, lastError: undefined };
    await this.ctx.storage.put("cycle", cycle);
    if (enabled) await this.changeColor();
    return this.getCycle();
  }

  private async changeColor(): Promise<void> {
    const color = randomHexColor();
    let error: string | undefined;
    try {
      await this.withToken((t) => setChatColor(this.env, t.accessToken, t.userId, color));
    } catch (err) {
      error = (err as Error).message;
    }
    const cycle = await this.getCycle();
    if (error) {
      // 400 usually means no Turbo/Prime (hex colors not allowed); 401 means the grant
      // was revoked. Neither fixes itself, so switch cycling off and say why.
      const permanent = /\((400|401)\)/.test(error);
      await this.ctx.storage.put("cycle", { ...cycle, lastError: error, enabled: permanent ? false : cycle.enabled });
      return;
    }
    await this.ctx.storage.put("cycle", { ...cycle, lastColor: color, changes: cycle.changes + 1, lastError: undefined });
  }

  /** Clears the timer-based loop from earlier versions, which may still have an alarm set. */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete("run");
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

  /** Single-flight: requests that need a refresh at the same time share one. */
  private refresh(tokens: Tokens): Promise<Tokens> {
    this.refreshing ??= this.doRefresh(tokens).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(tokens: Tokens): Promise<Tokens> {
    // Another request may already have refreshed since `tokens` was read.
    const stored = await this.getTokens();
    if (stored && stored.accessToken !== tokens.accessToken && stored.expiresAt - Date.now() > 60_000) return stored;
    tokens = stored ?? tokens;
    let tok;
    try {
      tok = await refreshToken(this.env, tokens.refreshToken);
    } catch (err) {
      if (err instanceof TwitchError && (err.status === 400 || err.status === 401)) {
        // Only forget the grant if nobody replaced it meanwhile (e.g. a reconnect).
        if ((await this.getTokens())?.refreshToken === tokens.refreshToken) await this.ctx.storage.delete("tokens");
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
