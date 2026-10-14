// What a chat server remembers between frames (Saltix 22-grain-chats §3, §4): the requests it took, until they expire,
// so each is answered once; the unasked messages it sent each user in the last 24 hours; and the spec version each
// user was last sent. `memoryChatStore` forgets on restart; `fileChatStore` keeps it in a file of its own.
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
}

const DAY_MS = 86_400_000;

interface State {
  taken: Record<string, number>;
  unasked: Record<string, number[]>;
  specs: Record<string, number>;
}

class Store implements ChatStore {
  private sweeps = 0;
  constructor(protected state: State, private readonly saved: () => void = () => {}) {}

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

  setSpecSent(user: string, version: number): void {
    this.state.specs[user] = version;
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
  return new Store({ taken: {}, unasked: {}, specs: {} });
}

/** A store kept in the JSON file `path` (owner-only), written whole on every change: enough for a small grain. A
 *  larger one implements `ChatStore` over its own database. */
export function fileChatStore(path: string): ChatStore {
  let state: State = { taken: {}, unasked: {}, specs: {} };
  if (existsSync(path)) {
    const read = JSON.parse(readFileSync(path, "utf8")) as Partial<State>;
    state = { taken: read.taken ?? {}, unasked: read.unasked ?? {}, specs: read.specs ?? {} };
  }
  return new Store(state, () => {
    writeFileSync(path + ".tmp", JSON.stringify(state), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  });
}
