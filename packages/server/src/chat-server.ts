// A grain's chat server (Saltix 22-grain-chats §8): it talks with users through the relays under the server key,
// takes their requests as the spec says (§3), routes each to a handler by command, and answers with cards it signs
// (§4). Requests are answered once each; the app writes unasked within the daily budget; a newer spec reaches users.
import type { IncomingMessage, ServerResponse } from "node:http";
import { ed25519 } from "@noble/curves/ed25519";
import { accountId, decodeAddress, encodeAddress } from "./address.js";
import { fromHex, toHex } from "./bytes.js";
import {
  CHAT_CERT_LIFE_MS, CHAT_FRAME_MAGIC, CHAT_UNASKED_PER_DAY, MAX_FRAME_BYTES, type ChainParams, type ChatDocument, type ChatMessage,
  type ChatRequest, type GrainChatSpec, type SignedChatRequest, type SignedGrainChatSpec, chatCertHolds, chatDocumentOf,
  chatRequestProblem, chatSpecProblem, commandOf, decodeChatFrame, decodeSignedChatSpec, encodeChatFrame, newChatId,
  signChatMessage, signedChatSpecProblem,
} from "./chat.js";
import { type Args, Card, argOf } from "./chat-card.js";
import { type ChatStore, memoryChatStore } from "./chat-store.js";
import type { FileRef } from "./file.js";
import type { InvoiceKeyCert } from "./invoice.js";
import type { DeviceKey } from "./keys.js";
import { type GrainNotification, signNotification } from "./notification.js";
import { RelayClient, type RelayEndpoint, type RelayFrame } from "./relay.js";
import { uploadFile } from "./upload.js";

/** Where a grain serves its chat spec and the server key's certificate (§2). */
export const CHAT_DOCUMENT_PATH = "/.well-known/saltix-grain-chat";

export type ChatLog = (level: "info" | "warn" | "error", event: string, meta?: Record<string, unknown>) => void;

export interface ChatServerOptions {
  /** The grain's slug: the spec and the certificate must be its. */
  slug: string;
  /** The chat spec the owner key signed (`grain chat-spec`): the object, or the hex of its Borsh. */
  spec: SignedGrainChatSpec | string;
  /** The server key's Ed25519 secret: it signs every message. It never leaves the process. */
  secret: Uint8Array;
  /** The owner key's certificate for the server key (`grain cert`): at most 31 days long for chat. */
  cert: InvoiceKeyCert;
  /** The network: its genesis hash (hex) and kind. */
  chain: ChainParams;
  /** The manifest's `owner_key`: with it the spec's signature and the certificate are checked as a wallet checks them
   *  before the server starts. */
  ownerKey?: DeviceKey;
  /** Your node's wallet interface (plain HTTP): relays come from its `relay_list`, with their pinned certificates. */
  node?: string;
  /** Or the relays' endpoints. */
  endpoints?: RelayEndpoint[];
  /** Or a connection made with `ackKept: "by_handler"` under the same key (`ChatServer` takes its frames). */
  relay?: RelayClient;
  /** What survives a restart: the requests answered, the unasked budget, the spec versions sent. In memory by
   *  default. */
  store?: ChatStore;
  /** Events worth logging: names and numbers, never keys, secrets or what users wrote. */
  log?: ChatLog;
  /** The clock, Unix ms (tests). */
  now?: () => number;
}

/** A message the server sent: what `replace` updates. */
export interface ChatSent {
  /** The user's address in the grain. */
  user: string;
  id: string;
  /** The request it answers, or null for an unasked one. */
  answers: string | null;
  /** When that request expires: until then an update answers it too, after that it is unasked. */
  expiresAt: number | null;
}

/** Thrown by a handler: the user gets a `refused` status with this text (at most 200 characters). */
export class ChatRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatRefusal";
  }
}

/** `notify`, `notification` or a late `replace` past `CHAT_UNASKED_PER_DAY` unasked messages to one user in 24 hours. */
export class ChatBudgetSpent extends Error {
  constructor() {
    super(`the unasked budget for this user is spent: at most ${CHAT_UNASKED_PER_DAY} a day, notifications included`);
    this.name = "ChatBudgetSpent";
  }
}

/** What a handler answers with: a card, or nothing when it answered itself (`ask.answer`). */
export type ChatHandler<A extends Args = Args> = (ask: ChatAsk<A>) => Card | void | Promise<Card | void>;

/** A request the server took: who asked, what, and how to answer. */
export class ChatAsk<A extends Args = Args> {
  /** The user's address in the grain (kind 0 of their grain key). */
  readonly user: string;
  /** The user's grain key, hex: the same as `grain.login` gives the page. */
  readonly key: string;
  readonly request: ChatRequest;
  /** The command, or "" for text alone. */
  readonly command: string;
  /** The arguments, checked against the spec: see `ArgValue` for their types. */
  readonly args: A;
  readonly text: string;
  /** The message whose action this request runs, or null. */
  readonly via: string | null;
  private progress: ChatSent | null = null;
  /** Whether the request was answered. */
  answered = false;

  constructor(private readonly server: ChatServer, user: string, signed: SignedChatRequest) {
    this.user = user;
    this.key = signed.key;
    this.request = signed.request;
    this.command = signed.request.command;
    this.text = signed.request.text;
    this.via = signed.request.via;
    this.args = Object.fromEntries(signed.request.args.map(([name, value]) => [name, argOf(value)])) as A;
  }

  /** A `working` status at once; the answer replaces it in place. */
  async working(text = ""): Promise<ChatSent> {
    this.progress = await this.server.send(this.user, new Card().status("working", text), this.answering(this.progress));
    return this.progress;
  }

  /** The answer: it replaces the `working` status, if one went out. Once. */
  async answer(card: Card): Promise<ChatSent> {
    if (this.answered) throw new Error("a request is answered once");
    this.answered = true;
    return this.server.send(this.user, card, this.answering(this.progress));
  }

  /** A `refused` status with `text`, as the answer. */
  refuse(text: string): Promise<ChatSent> {
    return this.answer(new Card().status("refused", text));
  }

  private answering(replaces: ChatSent | null) {
    return { answers: this.request.id, expiresAt: this.request.expires_at, replaces: replaces?.id ?? null };
  }
}

const DAY_MS = 86_400_000;
const SEND_TRIES = 3;

/**
 * A grain's chat (Saltix 22-grain-chats) on the relays, under the server key:
 *
 * ```ts
 * const chat = await ChatServer.start({ slug: "access", spec, secret, cert, chain: { genesis, network: "testnet" }, node });
 * chat.command("key", async (ask) => card().secret("Key", await mint(ask.args.site)).status("done", "Opens the site once"));
 * chat.text((ask) => card().text("Pick a command below."));
 * ```
 *
 * - Every request is checked (§3): it came from its key's address, the signature holds on this chain, it lives, and
 *   it fits the spec. One that fails the first three is dropped (nothing in it can be trusted, or nobody waits for
 *   it); one that does not fit gets a `refused` status, as does a command with no handler.
 * - Each request is answered at most once: its `(key, id)` is remembered until it expires, and a kept frame leaves
 *   the mailbox only once it is answered, so a request that came while the server was down or busy comes again.
 * - Messages are kept in the user's mailbox. An answer may replace a `working` status in place (`ask.working()`).
 * - Unasked messages (`notify`, `notification`, a `replace` after the request expired) are at most
 *   `CHAT_UNASKED_PER_DAY` per user in any 24 hours; past that they throw `ChatBudgetSpent`.
 * - A user who was not yet sent this spec's version gets it (`ChatFrame::Spec`) before the answer.
 */
export class ChatServer {
  /** The server's address at the relays: users' wallets write to it. */
  readonly address: string;
  readonly relay: RelayClient;
  private signed: SignedGrainChatSpec;
  private certificate: InvoiceKeyCert;
  private readonly handlers = new Map<string, ChatHandler<Args>>();
  private textHandler: ChatHandler<Args> | null = null;
  /** Requests being answered, by `key:id`: the acknowledgements of every frame that brought them. */
  private readonly inflight = new Map<string, Array<() => void>>();
  private readonly store: ChatStore;
  private readonly log: ChatLog;
  private readonly now: () => number;

  private constructor(private readonly options: ChatServerOptions, relay: RelayClient, signed: SignedGrainChatSpec) {
    this.relay = relay;
    this.signed = signed;
    this.certificate = options.cert;
    this.store = options.store ?? memoryChatStore();
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.address = encodeAddress(options.chain.network, accountId(ed25519.getPublicKey(options.secret)));
    relay.on("frame", (frame: RelayFrame) => {
      this.onFrame(frame).catch((e: Error) => this.log("error", "chat_frame_failed", { reason: e.message }));
    });
  }

  /** Check the spec and the certificate, connect to the relays and take requests. */
  static async start(options: ChatServerOptions): Promise<ChatServer> {
    const signed = typeof options.spec === "string" ? decodeSignedChatSpec(options.spec) : options.spec;
    const now = (options.now ?? Date.now)();
    const problem = ChatServer.problem(options, signed, options.cert, now);
    if (problem) throw new Error(problem);
    const relay = options.relay ?? await RelayClient.connect({
      node: options.node, endpoints: options.endpoints, secret: options.secret, network: options.chain.network, ackKept: "by_handler",
      log: (level, event, meta) => options.log?.(level, event, meta),
    });
    const server = new ChatServer(options, relay, signed);
    const daysLeft = (options.cert.expires_at - now) / DAY_MS;
    server.log(daysLeft < 3 ? "warn" : "info", "chat_started", { slug: options.slug, version: signed.spec.version, cert_days_left: Math.floor(daysLeft) });
    return server;
  }

  /** Why a wallet would not take this spec and certificate from this server at `now`, or null. */
  private static problem(o: ChatServerOptions, signed: SignedGrainChatSpec, cert: InvoiceKeyCert, now: number): string | null {
    const bounds = chatSpecProblem(signed.spec);
    if (bounds) return `chat spec: ${bounds}`;
    if (signed.spec.slug !== o.slug) return `chat spec: for ${signed.spec.slug}, not ${o.slug}`;
    if (o.ownerKey) {
      const p = signedChatSpecProblem(signed, o.slug, o.ownerKey);
      if (p) return `chat spec: ${p} (is it signed by the manifest's owner key?)`;
    }
    if (cert.slug !== o.slug) return `certificate: for ${cert.slug}, not ${o.slug}`;
    if (cert.key !== toHex(ed25519.getPublicKey(o.secret))) return "certificate: not for this server key";
    if (cert.expires_at <= now) return "certificate: expired (grain cert issues a new one)";
    if (cert.expires_at > now + CHAT_CERT_LIFE_MS) return "certificate: ends more than 31 days ahead, which wallets refuse in chats";
    if (signed.spec.revoked.includes(cert.key)) return "certificate: the spec revokes this server key";
    if (o.ownerKey && !chatCertHolds(cert, o.slug, o.ownerKey, signed.spec, now)) return "certificate: not signed by the manifest's owner key";
    return null;
  }

  /** The spec users are served now. */
  get spec(): GrainChatSpec {
    return this.signed.spec;
  }

  /** What `/.well-known/saltix-grain-chat` serves now: `{spec, cert}` in hex. */
  document(): ChatDocument {
    return chatDocumentOf(this.signed, this.certificate);
  }

  /** Serve the document at `CHAT_DOCUMENT_PATH` in a Node `http` server: true when it answered the request. */
  serveDocument(req: IncomingMessage, res: ServerResponse): boolean {
    return serveChatDocument(req, res, () => this.document());
  }

  /** A newer spec signed by the owner key (a version not below the current one): users get it on their next request. */
  setSpec(spec: SignedGrainChatSpec | string): void {
    const signed = typeof spec === "string" ? decodeSignedChatSpec(spec) : spec;
    if (signed.spec.version < this.signed.spec.version) throw new Error("a wallet refuses a lower version than it holds");
    const problem = ChatServer.problem(this.options, signed, this.certificate, this.now());
    if (problem) throw new Error(problem);
    this.signed = signed;
    this.log("info", "chat_spec_set", { version: signed.spec.version });
  }

  /** A new certificate for the server key (before the old one ends). */
  setCert(cert: InvoiceKeyCert): void {
    const problem = ChatServer.problem(this.options, this.signed, cert, this.now());
    if (problem) throw new Error(problem);
    this.certificate = cert;
    this.log("info", "chat_cert_set", { days_left: Math.floor((cert.expires_at - this.now()) / DAY_MS) });
  }

  /** Handle `name`, a command of the spec. Its arguments are checked before the handler runs. */
  command<A extends Args = Args>(name: string, handler: ChatHandler<A>): this {
    if (!commandOf(this.signed.spec, name)) throw new Error(`the chat spec has no command ${name}`);
    this.handlers.set(name, handler as unknown as ChatHandler<Args>);
    return this;
  }

  /** Handle requests of text alone (1–2 000 characters). Without it they are refused. */
  text(handler: ChatHandler<{}>): this {
    this.textHandler = handler as ChatHandler<Args>;
    return this;
  }

  /** Upload `bytes` as a file next to the server's relay, for a card's `file` block. */
  upload(bytes: Uint8Array, options: { name: string; mime: string }): Promise<FileRef> {
    return uploadFile(this.relay, bytes, { ...options, log: (level, event, meta) => this.log(level, event, meta) });
  }

  /** Write to `user` (an address in the grain, or a grain key in hex) unasked: within the daily budget. */
  async notify(user: string, card: Card): Promise<ChatSent> {
    const address = this.userAddress(user);
    await this.spend(address);
    return this.send(address, card, { answers: null, expiresAt: null, replaces: null });
  }

  /** Update `sent` in place: it answers its request while that lives, and counts as unasked after. */
  async replace(sent: ChatSent, card: Card): Promise<ChatSent> {
    const live = sent.answers !== null && sent.expiresAt !== null && this.now() < sent.expiresAt;
    if (!live) await this.spend(sent.user);
    return this.send(sent.user, card, live ? { answers: sent.answers, expiresAt: sent.expiresAt, replaces: sent.id } : { answers: null, expiresAt: null, replaces: sent.id });
  }

  /** A grain notification (12-grains §5.5) signed by the server key, shown with the grain closed: within the same
   *  daily budget as unasked messages. */
  async notification(user: string, n: Omit<GrainNotification, "slug" | "at">): Promise<void> {
    const address = this.userAddress(user);
    await this.spend(address);
    const signed = signNotification({ ...n, slug: this.options.slug, at: this.now() }, this.options.secret, this.options.chain.genesis, this.certificate);
    await this.deliver(address, signed);
  }

  /** Send `user` the current spec and certificate (`ChatFrame::Spec`). */
  async pushSpec(user: string): Promise<void> {
    const address = this.userAddress(user);
    await this.deliver(address, encodeChatFrame({ spec: { spec: this.signed, cert: this.certificate } }));
    await this.store.setSpecSent(address, this.signed.spec.version);
    this.log("info", "chat_spec_pushed", { version: this.signed.spec.version });
  }

  close(): void {
    if (!this.options.relay) this.relay.close();
  }

  /** Sign and send `card` to `address`. */
  async send(address: string, card: Card, how: { answers: string | null; expiresAt: number | null; replaces: string | null }): Promise<ChatSent> {
    const now = this.now();
    const cert = this.certificate;
    if (cert.expires_at <= now) throw new Error("the server key's certificate has expired: issue a new one (grain cert) and pass it to setCert");
    const message: ChatMessage = {
      slug: this.options.slug, id: newChatId(), at: now, answers: how.answers, replaces: how.replaces, blocks: card.blocks,
      actions: card.actions((name) => commandOf(this.signed.spec, name)),
    };
    const frame = encodeChatFrame({ message: signChatMessage(message, this.options.secret, this.options.chain.genesis, cert) });
    if (frame.length > MAX_FRAME_BYTES) throw new RangeError(`the message is ${frame.length} bytes, a frame carries ${MAX_FRAME_BYTES}: send a larger report as a file (upload)`);
    await this.deliver(address, frame);
    return { user: address, id: message.id, answers: how.answers, expiresAt: how.expiresAt };
  }

  private async deliver(address: string, plaintext: Uint8Array): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.relay.send(address, plaintext, { keep: true });
        return;
      } catch (e) {
        if (attempt >= SEND_TRIES) {
          this.log("error", "chat_send_failed", { reason: (e as Error).message });
          throw e;
        }
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  private async spend(address: string): Promise<void> {
    if (!(await this.store.spend(address, this.now(), CHAT_UNASKED_PER_DAY))) {
      this.log("warn", "chat_budget_spent", {});
      throw new ChatBudgetSpent();
    }
  }

  /** An address of a user in the grain, from it or from the grain key (hex). */
  private userAddress(user: string): string {
    if (/^[0-9a-f]{64}$/.test(user)) return encodeAddress(this.options.chain.network, accountId(fromHex(user, 32)));
    const decoded = decodeAddress(user);
    if (!decoded || decoded.kind !== 0 || decoded.network !== this.options.chain.network) throw new TypeError("a user is a personal address of this network, or a grain key in hex");
    return user;
  }

  private async onFrame(f: RelayFrame): Promise<void> {
    let frame;
    try {
      frame = decodeChatFrame(f.payload);
    } catch {
      const chat = CHAT_FRAME_MAGIC.every((b, i) => f.payload[i] === b);
      this.log("warn", chat ? "chat_frame_malformed" : "chat_frame_other", { bytes: f.payload.length });
      f.ack();
      return;
    }
    if (!("request" in frame)) {
      this.log("warn", "chat_frame_dropped", { kind: "message" in frame ? "message" : "spec" });
      f.ack();
      return;
    }
    const signed = frame.request;
    const now = this.now();
    const problem = chatRequestProblem(signed, { chain: this.options.chain, spec: this.signed.spec, from: f.from, now });
    // Not from its key, not signed, not alive, or another grain's: nobody to answer, or nobody waiting.
    if (problem === "sender" || problem === "signature" || problem === "time" || problem === "slug") {
      this.log("warn", "chat_request_dropped", { reason: problem });
      f.ack();
      return;
    }
    const k = `${signed.key}:${signed.request.id}`;
    const pending = this.inflight.get(k);
    if (pending) {
      pending.push(f.ack); // the same request again while it is answered: it leaves the mailbox with the answer
      return;
    }
    const acks = [f.ack];
    this.inflight.set(k, acks);
    let taken = false;
    let ask: ChatAsk | null = null;
    try {
      if (!(await this.store.take(f.from, signed.request.id, signed.request.expires_at, now))) {
        this.log("info", "chat_request_repeated", {});
        acks.forEach((ack) => ack());
        return;
      }
      taken = true;
      const sent = await this.store.specSent(f.from);
      if (sent === null || sent < this.signed.spec.version) await this.pushSpec(f.from);
      ask = new ChatAsk(this, f.from, signed);
      await this.answer(ask, problem);
      acks.forEach((ack) => ack());
    } catch (e) {
      // Not answered: the frame stays in the mailbox and comes again, to be taken again. Answered (a later step
      // failed): it is done.
      if (ask?.answered) acks.forEach((ack) => ack());
      else if (taken) await this.store.forget(f.from, signed.request.id);
      throw e;
    } finally {
      this.inflight.delete(k);
    }
  }

  private async answer(ask: ChatAsk, problem: string | null): Promise<void> {
    const started = this.now();
    const command = ask.command || "(text)";
    if (problem) {
      this.log("info", "chat_request_refused", { command, reason: problem });
      await ask.refuse(refusalText(problem));
      return;
    }
    const handler = ask.command === "" ? this.textHandler : this.handlers.get(ask.command);
    if (!handler) {
      this.log("warn", "chat_request_refused", { command, reason: "no_handler" });
      await ask.refuse(ask.command === "" ? "This chat takes its commands, not text." : "This command is not served yet.");
      return;
    }
    try {
      const result = await handler(ask);
      if (result instanceof Card && !ask.answered) await ask.answer(result);
      else if (!ask.answered) this.log("warn", "chat_unanswered", { command });
    } catch (e) {
      if (ask.answered) {
        this.log("error", "chat_handler_failed", { command, reason: (e as Error).message, after: "answer" });
        return;
      }
      if (e instanceof ChatRefusal) {
        await ask.refuse(e.message.slice(0, 200));
        this.log("info", "chat_request_refused", { command, reason: "handler" });
        return;
      }
      this.log("error", "chat_handler_failed", { command, reason: (e as Error).message });
      await ask.answer(new Card().status("failed", "Something went wrong. Try again later."));
      return;
    }
    this.log("info", "chat_request", { command, ms: this.now() - started });
  }
}

function refusalText(problem: string): string {
  if (problem === "unknown_command") return "This chat has no such command. Its list may have changed: pick one again.";
  if (problem.startsWith("argument:")) return `"${problem.slice(9).slice(0, 24)}" is missing or not a value this command takes.`;
  return "This request does not fit the chat's commands.";
}

/** The response that serves `doc` at `/.well-known/saltix-grain-chat` in any HTTP framework: status, headers, body. */
export function chatDocumentResponse(doc: ChatDocument): { status: number; headers: Record<string, string>; body: string } {
  return {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "max-age=300", "access-control-allow-origin": "*" },
    body: JSON.stringify(doc),
  };
}

/** Answer a `GET` of `CHAT_DOCUMENT_PATH` in a Node `http` server with `doc`: true when it was that request. */
export function serveChatDocument(req: IncomingMessage, res: ServerResponse, doc: ChatDocument | (() => ChatDocument)): boolean {
  const path = (req.url ?? "").split("?")[0];
  if (path !== CHAT_DOCUMENT_PATH || (req.method !== "GET" && req.method !== "HEAD")) return false;
  const r = chatDocumentResponse(typeof doc === "function" ? doc() : doc);
  res.writeHead(r.status, r.headers).end(req.method === "HEAD" ? undefined : r.body);
  return true;
}
