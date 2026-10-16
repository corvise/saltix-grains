// What a chat server remembers between frames (Saltix 22-grain-chats §3, §4): the requests it took, until they expire,
// so each is answered once; the unasked messages it sent each user in the last 24 hours; the spec version each user
// was last sent; what the app reports about its use (24-app-studio §6a): when each user last sent a request, for
// 30 days and no longer, and how many requests came in each hour of those 30 days; and where the grain's team is
// (24-app-studio §4): each member's address in the grain, as their proof showed it, while they are on the team; and the
// highest spec version the server served with its spec's hash (22-grain-chats §2), so a spec changed under it is refused.
// `memoryChatStore` forgets on restart; `fileChatStore` keeps it in a file of its own.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface ChatStore {
  /** Take request `id` of `user` (an address): true the first time, false while it is remembered. It is remembered
   *  until `expiresAt` (Unix ms), after which the request is refused as expired anyway. */
  take(user: string, id: string, expiresAt: number, now: number): boolean | Promise<boolean>;
  /** Forget a request taken but not answered (its handling failed before an answer went out), so it is taken again
   *  when its frame comes again. */
  forget(user: string, id: string): void | Promise<void>;
  /** Count one unasked message to `user` at `now` if fewer than `limit` went out in the 24 hours before: whether it
   *  did. */
  spend(user: string, now: number, limit: number): boolean | Promise<boolean>;
  /** The highest spec version sent to `user`, or null. */
  specSent(user: string): number | null | Promise<number | null>;
  setSpecSent(user: string, version: number): void | Promise<void>;
  /** Count a request `user` sent at `now`, for the numbers the app reports. A store without it leaves the counting to
   *  the server's memory, which a restart empties. */
  seen?(user: string, now: number): void | Promise<void>;
  /** The numbers at `now`, after forgetting every user and hour older than 30 days. */
  usage?(now: number): ChatUsage | Promise<ChatUsage>;
  /** The team's addresses in the grain by account (hex), as their proofs showed them (a hello's or a request's). A store
   *  without `team` and `setTeam` leaves them to the server's memory: after a restart, each member reaches the console
   *  again once their wallet says hello again or they write to the app. */
  team?(): Record<string, string> | Promise<Record<string, string>>;
  /** Keep `account`'s address in the grain, or forget it (`null`: no longer on the team). */
  setTeam?(account: string, address: string | null): void | Promise<void>;
  /** The highest spec version the server served, with its spec's hash, or null. A store without `served` and
   *  `setServed` cannot tell a spec changed under its version after a restart (`ChatServer` checks it at start). */
  served?(): ServedSpec | null | Promise<ServedSpec | null>;
  /** Keep `spec` as the highest served. */
  setServed?(spec: ServedSpec): void | Promise<void>;
}

/** A spec the server served: its version, and the hash (hex) that tells two specs of one version apart. */
export interface ServedSpec {
  version: number;
  hash: string;
}

/** Distinct users who sent a request in the last day and the last 30 days, and the requests of the last 30 days. */
export interface ChatUsage {
  users_1d: number;
  users_30d: number;
  requests_30d: number;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** The window the numbers cover: 30 days. Nothing about a user is kept longer for them. */
export const USAGE_WINDOW_MS = 30 * DAY_MS;

/** What `UsageWindow` keeps: each user's last request (Unix ms), and the requests of each hour (by hours since 1970). */
export interface UsageState {
  users: Record<string, number>;
  hours: Record<string, number>;
}

const U32_MAX = 0xffffffff;

/**
 * The counting behind the numbers an app reports (24-app-studio §6a): a user is remembered by the time of their last
 * request only, and only while it is within 30 days; requests are counted by the hour, with no one's name on them.
 * `users_1d ≤ users_30d ≤ requests_30d` always holds: every user counted has a request in an hour still counted.
 */
export class UsageWindow {
  constructor(readonly state: UsageState = { users: {}, hours: {} }) {}

  seen(user: string, now: number): void {
    this.state.users[user] = Math.max(this.state.users[user] ?? 0, now);
    const hour = String(Math.floor(now / HOUR_MS));
    this.state.hours[hour] = (this.state.hours[hour] ?? 0) + 1;
  }

  /** Forget users and hours older than the window at `now`: whether anything was forgotten. */
  forget(now: number): boolean {
    let dropped = false;
    const since = now - USAGE_WINDOW_MS;
    for (const [user, at] of Object.entries(this.state.users)) {
      if (at <= since) {
        delete this.state.users[user];
        dropped = true;
      }
    }
    const firstHour = Math.floor(since / HOUR_MS);
    for (const hour of Object.keys(this.state.hours)) {
      if (Number(hour) < firstHour) {
        delete this.state.hours[hour];
        dropped = true;
      }
    }
    return dropped;
  }

  usage(now: number): ChatUsage {
    this.forget(now);
    const times = Object.values(this.state.users);
    const users30 = times.length;
    const users1 = times.filter((at) => at > now - DAY_MS).length;
    const requests = Object.values(this.state.hours).reduce((a, b) => a + b, 0);
    return { users_1d: Math.min(users1, U32_MAX), users_30d: Math.min(users30, U32_MAX), requests_30d: Math.max(requests, users30) };
  }
}

interface State {
  taken: Record<string, number>;
  unasked: Record<string, number[]>;
  specs: Record<string, number>;
  usage: UsageState;
  team: Record<string, string>;
  served: ServedSpec | null;
}

class Store implements ChatStore {
  private sweeps = 0;
  private forgotAt = 0;
  private readonly window: UsageWindow;
  constructor(protected state: State, private readonly saved: () => void = () => {}) {
    this.window = new UsageWindow(state.usage);
  }

  seen(user: string, now: number): void {
    this.window.seen(user, now);
    // Forgetting walks every user: once a minute is enough while requests come; the server's sweep does it otherwise.
    if (now - this.forgotAt >= 60_000 || now < this.forgotAt) {
      this.window.forget(now);
      this.forgotAt = now;
    }
    this.saved();
  }

  usage(now: number): ChatUsage {
    const dropped = this.window.forget(now);
    const usage = this.window.usage(now);
    if (dropped) this.saved();
    return usage;
  }

  take(user: string, id: string, expiresAt: number, now: number): boolean {
    if (++this.sweeps % 256 === 0) this.sweep(now);
    const k = `${user}:${id}`;
    const until = this.state.taken[k];
    if (until !== undefined && until > now) return false;
    this.state.taken[k] = expiresAt;
    this.saved();
    return true;
  }

  forget(user: string, id: string): void {
    delete this.state.taken[`${user}:${id}`];
    this.saved();
  }

  spend(user: string, now: number, limit: number): boolean {
    const recent = (this.state.unasked[user] ?? []).filter((at) => at > now - DAY_MS);
    if (recent.length >= limit) {
      this.state.unasked[user] = recent;
      return false;
    }
    this.state.unasked[user] = [...recent, now];
    this.saved();
    return true;
  }

  specSent(user: string): number | null {
    return this.state.specs[user] ?? null;
  }

  team(): Record<string, string> {
    return { ...this.state.team };
  }

  setTeam(account: string, address: string | null): void {
    if (address === null) delete this.state.team[account];
    else this.state.team[account] = address;
    this.saved();
  }

  setSpecSent(user: string, version: number): void {
    this.state.specs[user] = version;
    this.saved();
  }

  served(): ServedSpec | null {
    return this.state.served ? { ...this.state.served } : null;
  }

  setServed(spec: ServedSpec): void {
    this.state.served = { version: spec.version, hash: spec.hash };
    this.saved();
  }

  private sweep(now: number): void {
    for (const [k, until] of Object.entries(this.state.taken)) if (until <= now) delete this.state.taken[k];
    for (const [user, times] of Object.entries(this.state.unasked)) {
      const recent = times.filter((at) => at > now - DAY_MS);
      if (recent.length === 0) delete this.state.unasked[user];
      else this.state.unasked[user] = recent;
    }
  }
}

/** A store in memory: a restart forgets which requests were answered (a request answered just before it, whose
 *  acknowledgement had not left, may be answered again). */
export function memoryChatStore(): ChatStore {
  return new Store({ taken: {}, unasked: {}, specs: {}, usage: { users: {}, hours: {} }, team: {}, served: null });
}

/** What a file keeps as the served spec, if it reads as one. */
function servedOf(value: unknown): ServedSpec | null {
  const v = value as Partial<ServedSpec> | null | undefined;
  return v && Number.isSafeInteger(v.version) && typeof v.hash === "string" && /^[0-9a-f]{64}$/.test(v.hash)
    ? { version: v.version!, hash: v.hash }
    : null;
}

/** A store kept in the JSON file `path` (owner-only), written whole on every change: enough for a small grain. A
 *  larger one implements `ChatStore` over its own database. */
export function fileChatStore(path: string): ChatStore {
  let state: State = { taken: {}, unasked: {}, specs: {}, usage: { users: {}, hours: {} }, team: {}, served: null };
  if (existsSync(path)) {
    const read = JSON.parse(readFileSync(path, "utf8")) as Partial<State>;
    state = {
      taken: read.taken ?? {}, unasked: read.unasked ?? {}, specs: read.specs ?? {},
      usage: { users: read.usage?.users ?? {}, hours: read.usage?.hours ?? {} }, team: read.team ?? {}, served: servedOf(read.served),
    };
  }
  return new Store(state, () => {
    writeFileSync(path + ".tmp", JSON.stringify(state), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  });
}
