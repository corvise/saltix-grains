// A grain's chat server (Saltix 22-grain-chats §8, 24-app-studio): it talks with users through the relays under the
// server key, takes their requests as the spec says (§3) — a private grain's from its owner and members only —, routes
// each to a handler by command, and answers with cards it signs (§4). Requests are answered once each; the app writes
// unasked within the daily budget; a newer spec reaches users; the numbers it reports are signed hourly. The grain's
// team (24-app-studio §4) is known from the registry and reached in its console, where errors are reported.
//
// Its key speaks for the grain in either of two ways: registered (the grain's registry record names it; a developer
// key carries it, and is the server's whole configuration), or certified by the owner key for at most 31 days.
import type { IncomingMessage, ServerResponse } from "node:http";
import { ed25519 } from "@noble/curves/ed25519";
import { accountId, decodeAddress, encodeAddress } from "./address.js";
import { AppKey } from "./app-key.js";
import { fromHex, toBase64, toHex } from "./bytes.js";
import {
  CHAT_CERT_LIFE_MS, CHAT_FRAME_MAGIC, CHAT_UNASKED_PER_DAY, CHAT_UNASKED_TEAM_PER_DAY, MAX_FRAME_BYTES, type ChainParams,
  type ChatDocument, type ChatMessage, type ChatRequest, type GrainChatSpec, type SignedChatRequest, type SignedGrainChatSpec,
  chatCertHolds, chatDocumentOf, chatMessageBoundsProblem, chatRequestProblem, chatSpecProblem, commandOf, decodeChatFrame,
  decodeSignedChatSpec, encodeChatFrame, newChatId, signChatMessage, signChatSpecAsServer, signedChatSpecProblem,
} from "./chat.js";
import { type Args, Card, argOf } from "./chat-card.js";
import { type ChatStore, type ChatUsage, UsageWindow, memoryChatStore } from "./chat-store.js";
import type { FileRef } from "./file.js";
import type { InvoiceKeyCert } from "./invoice.js";
import type { DeviceKey } from "./keys.js";
import {
  type GrainAccess, type MemberProblem, TEAM_ROLES, admits, needsController, needsTeamController, onTeam, rolesOf, teamMemberOf,
} from "./member.js";
import { ChainView, PUBLIC_RELAYS, RelayGateways, type WalletInterface, nodeInterface, relaysOf } from "./network.js";
import { type GrainNotification, signNotification } from "./notification.js";
import { ROLES, type RegisteredGrain } from "./registry.js";
import { RelayClient, type RelayEndpoint, type RelayFrame } from "./relay.js";
import { type ErrorFacts, REPORT_FOLD_MS, type ReportContext, errorFacts, errorFingerprint, reportCard, scrubSecrets } from "./report.js";
import { STATS_EVERY_MS, type SignedGrainStats, signGrainStats } from "./stats.js";
import { uploadFile } from "./upload.js";

/** Where a grain serves its chat spec, the server key's certificate and the numbers it reports (§2). */
export const CHAT_DOCUMENT_PATH = "/.well-known/saltix-grain-chat";

export type ChatLog = (level: "info" | "warn" | "error", event: string, meta?: Record<string, unknown>) => void;

/** How often the server asks the registry whether it still names its key, by default: 5 minutes. */
export const REGISTRY_CHECK_MS = 5 * 60_000;
const SWEEP_MS = 10 * 60_000;
const UNASKED = { answers: null, expiresAt: null, replaces: null } as const;
const DAY_MS = 86_400_000;
const SEND_TRIES = 3;

export interface ChatServerOptions {
  /**
   * The developer key Saltix gave for the grain (`saltix-app:1:…`, 24-app-studio §3): its whole configuration. The
   * server reads the slug, the network and the server key from it, finds the network's public relays and its node
   * through them, and checks that the registry names the key. Keep it out of code and logs: an environment variable or
   * an owner-only file.
   */
  appKey?: string | AppKey;
  /** The chat spec: signed by the owner key (`grain chat-spec`; the object, or the hex of its Borsh), or unsigned, which
   *  a registered server key signs at start while every command is free. Its slug is the grain's. */
  spec: SignedGrainChatSpec | GrainChatSpec | string;
  /** Without a developer key: the grain's slug. */
  slug?: string;
  /** Without a developer key: the server key's Ed25519 secret. It signs every message and never leaves the process. */
  secret?: Uint8Array;
  /** The owner key's certificate for the server key (`grain cert`): at most 31 days long for chat. Without one, the key
   *  must be one the grain's registry record names. */
  cert?: InvoiceKeyCert;
  /** The network: its genesis hash (hex) and kind. Read from the node when there is one (and checked against this). */
  chain?: ChainParams;
  /** The manifest's `owner_key`: the spec's signature and a certificate are checked with it as a wallet checks them.
   *  Read from the registry when there is one. */
  ownerKey?: DeviceKey;
  /** Your node's wallet interface (plain HTTP): the registry and relays come from it. */
  node?: string;
  /** The relays' endpoints to start from: with a developer key, instead of the network's public relays. */
  endpoints?: RelayEndpoint[];
  /** Or a connection made with `ackKept: "by_handler"` under the same key (`ChatServer` takes its frames). */
  relay?: RelayClient;
  /** Or the node's wallet interface however it is reached (tests, a gateway of your own). */
  wallet?: WalletInterface;
  /** What survives a restart: the requests answered, the unasked budget, the spec versions sent, the numbers reported.
   *  In memory by default. */
  store?: ChatStore;
  /** Events worth logging: names and numbers, never keys, secrets or what users wrote. */
  log?: ChatLog;
  /** The clock, Unix ms (tests). */
  now?: () => number;
  /** How often to ask the registry whether it still names the server key (default 5 minutes). */
  checkEveryMs?: number;
  /** Called once if the server stops because the registry no longer names its key. */
  onStop?: (reason: ChatStopReason) => void;
  /** Your app's version (`1.4.2`, a commit): the error reports the team gets name it. */
  version?: string;
  /**
   * Report every error a handler throws, other than a `ChatRefusal`, to the grain's team (`report`): on by default. The
   * user still gets a `failed` status; the owner and developers get a card for an AI agent in the app's console. It
   * needs the registry (a developer key, or `node`).
   */
  reportErrors?: boolean;
  /** What error reports and logs must never carry besides developer keys and long hex: your own tokens, as text (8
   *  characters or more) or patterns. */
  redact?: ReadonlyArray<string | RegExp>;
}

/** Why a server with a registered key stopped: the registry dropped the key from the grain's record (`revoked`: no key
 *  left; `replaced`: other keys), retired the grain, or has no such grain. */
export type ChatStopReason = "revoked" | "replaced" | "retired" | "unregistered";

/** Whether the registry's `grain` names `key` (hex) as a live grain's server key: null, or why not. */
export function registeredKeyStatus(grain: RegisteredGrain | null, key: string): ChatStopReason | null {
  if (grain === null) return "unregistered";
  if (grain.retired !== null) return "retired";
  const servers = grain.servers ?? [];
  if (servers.includes(key)) return null;
  return servers.length === 0 ? "revoked" : "replaced";
}

const STOPPED: Record<ChatStopReason, string> = {
  revoked: "the registry names no server key for the grain (none was configured, or the owner revoked them)",
  replaced: "the owner replaced this server key",
  retired: "the grain is retired",
  unregistered: "the registry has no such grain",
};

/** The server key is not one the registry names for the grain (at start), or stopped being one. */
export class ChatKeyNotRegistered extends Error {
  constructor(public readonly reason: ChatStopReason, slug: string) {
    super(`the registry does not name this server key for ${slug}: ${STOPPED[reason]}. ` +
      `Make a new developer key in Saltix (My apps → ${slug} → Developer key) and start with it.`);
    this.name = "ChatKeyNotRegistered";
  }
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

/** `notify`, `notification` or a late `replace` past `CHAT_UNASKED_PER_DAY` unasked messages to one user in 24 hours
 *  (`CHAT_UNASKED_TEAM_PER_DAY` to a member of the grain's team). */
export class ChatBudgetSpent extends Error {
  constructor(readonly limit: number = CHAT_UNASKED_PER_DAY) {
    super(`the unasked budget for this user is spent: at most ${limit} a day, notifications included`);
    this.name = "ChatBudgetSpent";
  }
}

/** A role on the grain's team (24-app-studio §2a, §4): its owner, or a member who develops or views it. */
export type TeamRole = "owner" | "developer" | "viewer";

/** Whom `notifyTeam` and `report` write to unless told: the owner and the developers. */
export const DEFAULT_TEAM_ROLES: readonly TeamRole[] = ["owner", "developer"];

/** A member of the grain's team, as the registry names it now. */
export interface TeamMember {
  /** The account id, hex. */
  account: string;
  /** Whether it is the grain's owner (who has every role). */
  owner: boolean;
  /** A bit set of `ROLES`. */
  roles: number;
  /** Their address in the grain, from the proof their wallet sent with a request; null until they have written to the
   *  app once, and the app cannot reach them before. */
  address: string | null;
}

/** What `notifyTeam` did: messages sent, members it cannot reach yet (they have not written to the app), members whose
 *  day's budget is spent, and sends that failed. */
export interface TeamDelivery {
  sent: number;
  unreachable: number;
  spent: number;
  failed: number;
}

/** What `report` did: folded into an earlier report of the same error (sent nothing), or sent as `notifyTeam` says. */
export interface ReportOutcome extends TeamDelivery {
  folded: boolean;
}

/** Whether `m` plays one of `roles`. The owner plays "owner" only, whatever bits its roles have. */
function plays(m: TeamMember, roles: readonly TeamRole[]): boolean {
  if (m.owner) return roles.includes("owner");
  return (roles.includes("developer") && (m.roles & ROLES.developer) !== 0) || (roles.includes("viewer") && (m.roles & ROLES.viewer) !== 0);
}

const accessOf = (g: RegisteredGrain): GrainAccess => ({ owner: g.owner, public: g.public !== false, members: g.members ?? [] });

/** An error being folded: the facts of the last report, when it went, and how many came since. */
interface Folding {
  facts: ErrorFacts;
  sentAt: number;
  folded: number;
  context: ReportContext | undefined;
  roles: readonly TeamRole[] | undefined;
}

/** Distinct errors a server folds at once; past it, the oldest is forgotten. */
const MAX_FOLDING = 256;
const NO_DELIVERY: TeamDelivery = { sent: 0, unreachable: 0, spent: 0, failed: 0 };

/** What a handler answers with: a card, or nothing when it answered itself (`ask.answer`). */
export type ChatHandler<A extends Args = Args> = (ask: ChatAsk<A>) => Card | void | Promise<Card | void>;

/** A private grain's member who asked: the account its proof names, and its roles (24-app-studio §2a). */
export interface ChatMember {
  /** The account id, hex. */
  account: string;
  /** A bit set of `ROLES` (the owner has every role). */
  roles: number;
}

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
  /**
   * The language the user's Saltix shows ("en", "ru", "pt-br": 2–8 of `[a-z-]`), or "" when the app does not say.
   * Answer in it when you can, and in English otherwise; it says nothing else about the user.
   */
  readonly lang: string;
  /** The message whose action this request runs, or null. */
  readonly via: string | null;
  /**
   * Who asked, when the request carried a member proof that checks: in a private grain, a member's account and roles;
   * in a public one, only a member of the grain's team, whose wallet proves itself to its own app (24-app-studio §4).
   * Null for everyone else: a public grain never knows its users.
   */
  readonly member: ChatMember | null;
  /** Whether the request came from the grain's team (its owner, a developer or a viewer): gate admin commands on it. */
  readonly fromTeam: boolean;
  private progress: ChatSent | null = null;
  /** Whether the request was answered. */
  answered = false;

  constructor(private readonly server: ChatServer, user: string, signed: SignedChatRequest, member: ChatMember | null = null) {
    this.user = user;
    this.key = signed.key;
    this.request = signed.request;
    this.command = signed.request.command;
    this.text = signed.request.text;
    this.lang = signed.request.lang;
    this.via = signed.request.via;
    this.member = member;
    this.fromTeam = member !== null && (member.roles & TEAM_ROLES) !== 0;
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

  /** A `failed` status with `text`, as the answer. */
  fail(text: string): Promise<ChatSent> {
    return this.answer(new Card().status("failed", text));
  }

  private answering(replaces: ChatSent | null) {
    return { answers: this.request.id, expiresAt: this.request.expires_at, replaces: replaces?.id ?? null };
  }
}

/** What the server is: its slug, key and how the key speaks for the grain, the network, and where it reads the chain. */
interface Setup {
  slug: string;
  secret: Uint8Array;
  key: string;
  cert: InvoiceKeyCert | null;
  chain: ChainParams;
  ownerKey: DeviceKey | null;
  view: ChainView | null;
  grain: RegisteredGrain | null;
}

const MEMBER_REFUSALS: Record<MemberProblem, string> = {
  missing: "This app is private: only its owner and members can use it.",
  not_member: "This app is private: only its owner and members can use it.",
  mismatch: "Your membership proof is for another app or another key. Open the app again.",
  expired: "Your membership proof has expired. Open the app again.",
  signer: "Your membership proof is signed by a key that no longer speaks for your account.",
  signature: "Your membership proof does not check.",
};

/**
 * A grain's chat (Saltix 22-grain-chats) on the relays, under the server key. From a developer key:
 *
 * ```ts
 * const chat = await ChatServer.start({ appKey: process.env.SALTIX_APP_KEY!, spec, store: fileChatStore("chat.json") });
 * chat.command("key", async (ask) => card().secret("Key", await mint(ask.args.site)).status("done", "Opens the site once"));
 * chat.text((ask) => card().text("Pick a command below."));
 * ```
 *
 * - Every request is checked (§3): it came from its key's address, the signature holds on this chain, it lives, and
 *   it fits the spec. One that fails the first three is dropped (nothing in it can be trusted, or nobody waits for
 *   it); one that does not fit gets a `refused` status, as does a command with no handler.
 * - A private grain (24-app-studio §2a) takes a request only with a member proof its owner or a user or developer
 *   signed with a key that speaks for the account now; anyone else gets a refusal and nothing more. Membership is read
 *   from the registry and the accounts' keys, cached per tip.
 * - Each request is answered at most once: its `(key, id)` is remembered until it expires, and a kept frame leaves
 *   the mailbox only once it is answered, so a request that came while the server was down or busy comes again.
 * - Messages are kept in the user's mailbox. An answer may replace a `working` status in place (`ask.working()`).
 * - Unasked messages (`notify`, `notification`, a `replace` after the request expired) are at most
 *   `CHAT_UNASKED_PER_DAY` per user in any 24 hours; past that they throw `ChatBudgetSpent`.
 * - A user who was not yet sent this spec's version gets it (`ChatFrame::Spec`) before the answer, and the numbers the
 *   app reports (`ChatFrame::Stats`) once a day.
 * - With a registered key, the server asks the registry every few minutes, and at every new beacon block a request
 *   comes in, whether it still names the key; once it does not, the server stops answering and says so in its log.
 * - The grain's team (its owner, developers and viewers, 24-app-studio §4) is read from the registry (`team`). A member's
 *   wallet proves itself with every request to its own app, so the server learns where their chat (the app's console)
 *   is. `notifyTeam` writes to them, within 100 unasked messages a day each, and `report` sends an error as a card for
 *   an AI agent; handlers' errors are reported by default (`reportErrors`).
 */
export class ChatServer {
  /** The server's address at the relays: users' wallets write to it. */
  readonly address: string;
  readonly relay: RelayClient;
  /** The grain's slug. */
  readonly slug: string;
  /** The server key, hex. */
  readonly key: string;
  /** The network. */
  readonly chain: ChainParams;
  private signed: SignedGrainChatSpec;
  private certificate: InvoiceKeyCert | null;
  private readonly secret: Uint8Array;
  private readonly ownerKey: DeviceKey | null;
  private readonly view: ChainView | null;
  private record: RegisteredGrain | null;
  private readonly handlers = new Map<string, ChatHandler<Args>>();
  private textHandler: ChatHandler<Args> | null = null;
  /** Requests being answered, by `key:id`: the acknowledgements of every frame that brought them. */
  private readonly inflight = new Map<string, Array<() => void>>();
  private readonly store: ChatStore;
  private readonly window = new UsageWindow();
  private readonly log: ChatLog;
  private readonly now: () => number;
  private stats: SignedGrainStats | null = null;
  /** When each user was last sent the numbers, for a day at most. */
  private readonly statsSent = new Map<string, number>();
  private readonly timers: NodeJS.Timeout[] = [];
  private stopReason: ChatStopReason | null = null;
  private readonly onFrameListener: (frame: RelayFrame) => void;
  /** The team's addresses by account, when the store keeps none. */
  private readonly teamMemory = new Map<string, string>();
  /** Errors reported in the last hour, by fingerprint. */
  private readonly folding = new Map<string, Folding>();
  /** What reports and logs never carry: the options' `redact`, and the server secret's base64 forms (hex goes anyway). */
  private readonly redactions: ReadonlyArray<string | RegExp>;

  private constructor(private readonly options: ChatServerOptions, setup: Setup, relay: RelayClient, signed: SignedGrainChatSpec) {
    this.relay = relay;
    this.signed = signed;
    this.slug = setup.slug;
    this.key = setup.key;
    this.chain = setup.chain;
    this.secret = setup.secret;
    this.certificate = setup.cert;
    this.ownerKey = setup.ownerKey;
    this.view = setup.view;
    this.record = setup.grain;
    this.store = options.store ?? memoryChatStore();
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.redactions = [...(options.redact ?? []), toBase64(setup.secret), toBase64(setup.secret, true)];
    this.address = encodeAddress(setup.chain.network, accountId(fromHex(setup.key, 32)));
    this.onFrameListener = (frame: RelayFrame) => {
      this.onFrame(frame).catch((e: Error) => this.log("error", "chat_frame_failed", { reason: e.message }));
    };
    relay.on("frame", this.onFrameListener);
  }

  /**
   * Read the configuration, check the spec and the key as a wallet will (the registry names the key, or the owner key
   * certified it), connect to the relays and take requests. Throws `ChatKeyNotRegistered` when the registry does not
   * name a developer key, and an `AppKeyError` for a text that is not one.
   */
  static async start(options: ChatServerOptions): Promise<ChatServer> {
    const now = (options.now ?? Date.now)();
    const log = options.log ?? (() => {});
    const appKey = options.appKey === undefined ? null : typeof options.appKey === "string" ? AppKey.parse(options.appKey) : options.appKey;
    if (appKey && options.secret) throw new Error("pass the developer key or a secret, not both");
    if (appKey && options.cert) throw new Error("a developer key is a registered server key: it takes no certificate");
    if (appKey && options.slug !== undefined && options.slug !== appKey.slug) throw new Error(`the developer key is ${appKey.slug}'s, not ${options.slug}'s`);
    const secret = appKey ? appKey.secret() : options.secret;
    const slug = appKey ? appKey.slug : options.slug;
    if (!secret || secret.length !== 32) throw new Error("the server key: a developer key (appKey), or a 32-byte secret");
    if (!slug) throw new Error("slug: the grain's (or a developer key, which names it)");
    const key = toHex(ed25519.getPublicKey(secret));
    const cert = options.cert ?? null;

    // The node's wallet interface: given, your node, or the network's relays (a developer key's network, or the
    // pinned wss:// endpoints given). A certified key with only a development relay reads no registry.
    let wallet: WalletInterface | null = options.wallet ?? (options.node ? nodeInterface(options.node) : null);
    let gateways: RelayGateways | null = null;
    if (!wallet) {
      gateways = new RelayGateways([...(options.endpoints ?? []), ...(appKey && !options.endpoints ? PUBLIC_RELAYS[appKey.network] : [])]);
      if (gateways.endpoints.length > 0) wallet = gateways;
      else if (appKey) throw new Error(`no public relays are known for ${appKey.network}: pass node (your node's wallet interface) or endpoints`);
    }
    if (!cert && !wallet) throw new Error("a server key without a certificate must be one the registry names: pass a developer key, or node");
    const view = wallet ? new ChainView(wallet, options.now) : null;

    let chain = options.chain ?? null;
    let grain: RegisteredGrain | null = null;
    if (view) {
      const status = await view.nodeStatus(true);
      if (appKey && !appKey.isFor(status.network, status.genesis)) {
        throw new Error(`the developer key is for ${appKey.network} ${appKey.genesis}…, but the network answering is ${status.network} ` +
          `${status.genesis.slice(0, 16)}…: was the network reset? Make a new developer key in Saltix, or pass node for your own network`);
      }
      if (chain && (chain.genesis !== status.genesis || chain.network !== status.network)) {
        throw new Error(`chain: the node is on ${status.network} ${status.genesis}, not ${chain.network} ${chain.genesis}`);
      }
      chain = { genesis: status.genesis, network: status.network as ChainParams["network"] };
      grain = await view.grain(slug, true);
      if (!cert) {
        const refused = registeredKeyStatus(grain, key);
        if (refused) throw new ChatKeyNotRegistered(refused, slug);
        if (grain!.servers![0] !== key) {
          log("warn", "chat_not_first_key", {
            hint: "wallets write to the first server key the registry names: this key signs, but requests go to the first key's server",
          });
        }
      }
    } else {
      log("warn", "chat_registry_unread", { hint: "without a node a private grain's members are not checked: pass node" });
    }
    if (!chain) throw new Error("chain: the network's genesis hash and kind, or a node to read them from");
    const ownerKey = options.ownerKey ?? grain?.manifest?.manifest.owner_key ?? null;
    const setup: Setup = { slug, secret, key, cert, chain, ownerKey, view, grain };

    const signed = ChatServer.signedSpec(options.spec, setup);
    const problem = ChatServer.problem(setup, signed, cert, now);
    if (problem) throw new Error(problem);
    if (options.relay && options.relay.address !== encodeAddress(chain.network, accountId(fromHex(key, 32)))) {
      throw new Error("relay: a connection under another key");
    }
    const relay = options.relay ?? await RelayClient.connect({
      endpoints: options.endpoints ?? (gateways ? gateways.endpoints : []),
      discover: wallet ? async () => {
        const found = await relaysOf(wallet!);
        gateways?.add(found);
        return found;
      } : undefined,
      secret, network: chain.network, ackKept: "by_handler",
      log: (level, event, meta) => log(level, event, meta),
    });
    const server = new ChatServer(options, setup, relay, signed);
    server.started(now);
    return server;
  }

  /** The spec as the server serves it: signed, or signed now by the registered key. */
  private static signedSpec(spec: ChatServerOptions["spec"], s: Setup): SignedGrainChatSpec {
    if (typeof spec === "string") return decodeSignedChatSpec(spec);
    if ("signature" in spec) return spec;
    if (s.cert) throw new Error("chat spec: unsigned; a certified key does not sign specs (grain chat-spec signs it with the owner key)");
    return signChatSpecAsServer(spec, s.secret);
  }

  /** Why a wallet would not take this spec and key from this server at `now`, or null. */
  private static problem(s: Setup, signed: SignedGrainChatSpec, cert: InvoiceKeyCert | null, now: number): string | null {
    const bounds = chatSpecProblem(signed.spec);
    if (bounds) return `chat spec: ${bounds}`;
    if (signed.spec.slug !== s.slug) return `chat spec: for ${signed.spec.slug}, not ${s.slug}`;
    if (signed.server !== null && signed.server !== s.key && !s.grain) return "chat spec: signed by another server key";
    if (s.ownerKey || signed.server !== null) {
      const p = signedChatSpecProblem(signed, s.slug, s.ownerKey ?? { ed25519: "00".repeat(32) }, s.grain?.servers ?? (cert ? [] : [s.key]));
      if (p) return `chat spec: ${p} (${signed.server === null ? "is it signed by the manifest's owner key?" : "is it signed by a server key the registry names?"})`;
    }
    if (!cert) return signed.spec.revoked.includes(s.key) ? "chat spec: the spec revokes this server key" : null;
    if (cert.slug !== s.slug) return `certificate: for ${cert.slug}, not ${s.slug}`;
    if (cert.key !== s.key) return "certificate: not for this server key";
    if (cert.expires_at <= now) return "certificate: expired (grain cert issues a new one)";
    if (cert.expires_at > now + CHAT_CERT_LIFE_MS) return "certificate: ends more than 31 days ahead, which wallets refuse in chats";
    if (signed.spec.revoked.includes(cert.key)) return "certificate: the spec revokes this server key";
    if (s.ownerKey && !chatCertHolds(cert, s.slug, s.ownerKey, signed.spec, now)) return "certificate: not signed by the manifest's owner key";
    return null;
  }

  private started(now: number): void {
    const meta: Record<string, unknown> = {
      slug: this.slug, version: this.signed.spec.version, key: this.key.slice(0, 16), network: this.chain.network,
      access: this.record ? (this.record.public ?? true) ? "public" : "private" : "unknown",
    };
    if (this.certificate) {
      const daysLeft = (this.certificate.expires_at - now) / DAY_MS;
      meta.cert_days_left = Math.floor(daysLeft);
      this.log(daysLeft < 3 ? "warn" : "info", "chat_started", meta);
    } else {
      meta.registered = true;
      this.log("info", "chat_started", meta);
    }
    if (this.view) {
      const every = this.options.checkEveryMs ?? REGISTRY_CHECK_MS;
      this.timers.push(setInterval(() => void this.checkRegistry(), every));
    }
    if (!this.certificate) void this.publishStats().catch((e: Error) => this.log("warn", "chat_stats_failed", { reason: e.message }));
    this.timers.push(setInterval(() => void this.sweep(), SWEEP_MS));
    for (const t of this.timers) t.unref?.();
  }

  /** The spec users are served now. */
  get spec(): GrainChatSpec {
    return this.signed.spec;
  }

  /** The grain's registry record as last read, or null without a node. */
  get grain(): RegisteredGrain | null {
    return this.record;
  }

  /** Why the server stopped (the registry no longer names its key), or null while it runs. */
  get stopped(): ChatStopReason | null {
    return this.stopReason;
  }

  /** What `/.well-known/saltix-grain-chat` serves now: `{spec, cert?, stats?}` in hex. A chat-only grain has no origin:
   *  its users get the same in the chat. */
  document(): ChatDocument {
    return chatDocumentOf(this.signed, this.certificate, this.stats);
  }

  /** Serve the document at `CHAT_DOCUMENT_PATH` in a Node `http` server: true when it answered the request. */
  serveDocument(req: IncomingMessage, res: ServerResponse): boolean {
    return serveChatDocument(req, res, () => this.document());
  }

  /** A newer spec (a version not below the current one): signed by the owner key, or unsigned for a registered key to
   *  sign. Users get it on their next request. */
  setSpec(spec: SignedGrainChatSpec | GrainChatSpec | string): void {
    const setup = this.setup();
    const signed = ChatServer.signedSpec(spec, setup);
    if (signed.spec.version < this.signed.spec.version) throw new Error("a wallet refuses a lower version than it holds");
    const problem = ChatServer.problem(setup, signed, this.certificate, this.now());
    if (problem) throw new Error(problem);
    this.signed = signed;
    this.log("info", "chat_spec_set", { version: signed.spec.version });
  }

  /** A new certificate for a certified server key (before the old one ends). */
  setCert(cert: InvoiceKeyCert): void {
    if (!this.certificate) throw new Error("the server key is registered: it takes no certificate");
    const problem = ChatServer.problem(this.setup(), this.signed, cert, this.now());
    if (problem) throw new Error(problem);
    this.certificate = cert;
    this.log("info", "chat_cert_set", { days_left: Math.floor((cert.expires_at - this.now()) / DAY_MS) });
  }

  private setup(): Setup {
    return {
      slug: this.slug, secret: this.secret, key: this.key, cert: this.certificate, chain: this.chain, ownerKey: this.ownerKey,
      view: this.view, grain: this.record,
    };
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
    this.running();
    const address = this.userAddress(user);
    await this.spend(address);
    const signed = signNotification({ ...n, slug: this.slug, at: this.now() }, this.secret, this.chain.genesis, this.certificate ?? undefined);
    await this.deliver(address, signed);
  }

  /** Send `user` the current spec, with the certificate when the key has one (`ChatFrame::Spec`). */
  async pushSpec(user: string): Promise<void> {
    this.running();
    const address = this.userAddress(user);
    await this.deliver(address, encodeChatFrame({ spec: { spec: this.signed, cert: this.certificate } }));
    await this.store.setSpecSent(address, this.signed.spec.version);
    this.log("info", "chat_spec_pushed", { version: this.signed.spec.version });
  }

  /**
   * The numbers the app reports (24-app-studio §6a), signed by the registered key at most once an hour: distinct users
   * who sent a request in the last day and 30 days, and the requests of 30 days. Null for a certified key, whose
   * numbers no wallet shows.
   */
  async publishStats(): Promise<SignedGrainStats | null> {
    if (this.certificate) return null;
    const now = this.now();
    if (this.stats && now - this.stats.stats.at < STATS_EVERY_MS && now >= this.stats.stats.at) return this.stats;
    const usage: ChatUsage = await (this.store.usage ? this.store.usage(now) : this.window.usage(now));
    this.stats = signGrainStats({ slug: this.slug, at: now, ...usage }, this.secret, this.chain.genesis);
    this.log("info", "chat_stats", { ...usage });
    return this.stats;
  }

  /** The numbers last published, or null. */
  get reported(): SignedGrainStats | null {
    return this.stats;
  }

  /**
   * Ask the registry now whether it still names the server key (it is asked every few minutes anyway, and at each new
   * beacon block a request comes in), and read the grain's access. Once the key is not named, the server stops.
   */
  async checkRegistry(): Promise<ChatStopReason | null> {
    if (!this.view || this.stopReason) return this.stopReason;
    try {
      this.record = await this.view.grain(this.slug, true);
    } catch (e) {
      this.log("warn", "chat_registry_unreachable", { reason: (e as Error).message });
      return null;
    }
    return this.judgeKey();
  }

  private judgeKey(): ChatStopReason | null {
    if (this.certificate || this.stopReason) return this.stopReason;
    const reason = registeredKeyStatus(this.record, this.key);
    if (reason) this.stop(reason);
    return reason;
  }

  /** Stop answering: the registry no longer names the key, so wallets refuse what it signs. */
  private stop(reason: ChatStopReason): void {
    this.stopReason = reason;
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    this.relay.off("frame", this.onFrameListener);
    if (!this.options.relay) this.relay.close();
    this.log("error", "chat_stopped", {
      reason, slug: this.slug, key: this.key.slice(0, 16),
      hint: `${STOPPED[reason]}: this server stopped answering. Make a new developer key in Saltix (My apps → ${this.slug} → Developer key) and restart with it.`,
    });
    this.options.onStop?.(reason);
  }

  private running(): void {
    if (this.stopReason) throw new ChatKeyNotRegistered(this.stopReason, this.slug);
  }

  close(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    this.relay.off("frame", this.onFrameListener);
    if (!this.options.relay) this.relay.close();
  }

  /** Sign and send `card` to `address`. */
  async send(address: string, card: Card, how: { answers: string | null; expiresAt: number | null; replaces: string | null }): Promise<ChatSent> {
    this.running();
    const now = this.now();
    const cert = this.certificate;
    if (cert && cert.expires_at <= now) throw new Error("the server key's certificate has expired: issue a new one (grain cert) and pass it to setCert");
    const message = this.message(card, how);
    const frame = encodeChatFrame({ message: signChatMessage(message, this.secret, this.chain.genesis, cert) });
    if (frame.length > MAX_FRAME_BYTES) throw new RangeError(`the message is ${frame.length} bytes, a frame carries ${MAX_FRAME_BYTES}: send a larger report as a file (upload)`);
    await this.deliver(address, frame);
    return { user: address, id: message.id, answers: how.answers, expiresAt: how.expiresAt };
  }

  /** `card` as a message of this chat, dated now. */
  private message(card: Card, how: { answers: string | null; replaces: string | null }): ChatMessage {
    return {
      slug: this.slug, id: newChatId(), at: this.now(), answers: how.answers, replaces: how.replaces, blocks: card.blocks,
      actions: card.actions((name) => commandOf(this.signed.spec, name)),
    };
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
    const limit = await this.unaskedLimit(address);
    if (!(await this.store.spend(address, this.now(), limit))) {
      this.log("warn", "chat_budget_spent", { limit });
      throw new ChatBudgetSpent(limit);
    }
  }

  /** The unasked budget of `address` a wallet holds the app to: the team's when it is a member's on the team now. */
  private async unaskedLimit(address: string): Promise<number> {
    if (!this.view) return CHAT_UNASKED_PER_DAY;
    const known = await this.knownTeam();
    const account = Object.keys(known).find((a) => known[a] === address);
    if (account === undefined) return CHAT_UNASKED_PER_DAY;
    try {
      const g = await this.view.grain(this.slug);
      return g && onTeam(accessOf(g), account) ? CHAT_UNASKED_TEAM_PER_DAY : CHAT_UNASKED_PER_DAY;
    } catch {
      return CHAT_UNASKED_PER_DAY;
    }
  }

  /**
   * The grain's team as the registry names it now (cached per beacon tip): its owner, then the members with the
   * developer or viewer role, each with their address in the grain once their wallet's proof showed it. A member the
   * registry no longer names is forgotten here. Throws without a registry to read (a certified key with no node).
   */
  async team(): Promise<TeamMember[]> {
    if (!this.view) throw new Error("the team is read from the registry: start the server from a developer key, or pass node");
    const g = await this.view.grain(this.slug);
    if (!g) return [];
    const access = accessOf(g);
    const known = await this.knownTeam();
    for (const account of Object.keys(known)) {
      if (onTeam(access, account)) continue;
      await this.setTeamAddress(account, null);
      delete known[account];
    }
    const members = access.members.filter((m) => (m.roles & TEAM_ROLES) !== 0);
    return [
      { account: g.owner, owner: true, roles: ROLES.user | ROLES.developer | ROLES.viewer, address: known[g.owner] ?? null },
      ...members.map((m) => ({ account: m.account, owner: false, roles: m.roles, address: known[m.account] ?? null })),
    ];
  }

  /**
   * Write `card` unasked to each member of the team who plays one of `roles` (by default the owner and the
   * developers): in the app's console, within `CHAT_UNASKED_TEAM_PER_DAY` messages a day each. A member who has not
   * written to the app yet cannot be reached and is skipped, as is one whose day's budget is spent; a send that fails
   * is counted and the others still go. The log says how many, never to whom. Throws for a card out of bounds.
   */
  async notifyTeam(card: Card, options: { roles?: readonly TeamRole[] } = {}): Promise<TeamDelivery> {
    this.running();
    const roles = options.roles ?? DEFAULT_TEAM_ROLES;
    if (roles.length === 0 || roles.some((r) => r !== "owner" && r !== "developer" && r !== "viewer")) {
      throw new TypeError(`roles: some of ${["owner", "developer", "viewer"].join(", ")}`);
    }
    const problem = chatMessageBoundsProblem(this.message(card, UNASKED));
    if (problem) throw new TypeError(`chat message: ${problem}`);
    const result = { ...NO_DELIVERY };
    for (const m of await this.team()) {
      if (!plays(m, roles)) continue;
      if (m.address === null) {
        result.unreachable++;
        continue;
      }
      if (!(await this.store.spend(m.address, this.now(), CHAT_UNASKED_TEAM_PER_DAY))) {
        result.spent++;
        continue;
      }
      try {
        await this.send(m.address, card, UNASKED);
        result.sent++;
      } catch (e) {
        if (e instanceof ChatKeyNotRegistered) throw e;
        result.failed++;
      }
    }
    this.log(result.failed > 0 || (result.sent === 0 && result.unreachable > 0) ? "warn" : "info", "chat_team_notified", {
      ...result, ...(result.sent === 0 && result.unreachable > 0 ? { hint: "no one on the team has written to the app yet: it reaches each member once they have" } : {}),
    });
    return result;
  }

  /**
   * Report `error` to the team (`notifyTeam`, by default the owner and the developers) as a card made for an AI agent
   * to read: a `failed` status with the error, fields for where it happened (the command, the request, your app's
   * version, the time in UTC, the context's further keys), and the stack. Developer keys, hex of 64 characters or
   * more, the server secret and the options' `redact` are scrubbed out first. The same error (name, message and top
   * frame) is reported once an hour: the ones in between are counted, and the count goes in the next card, or within
   * 10 minutes after the hour (`flushReports`). It never throws: what it could not do goes to the log.
   */
  async report(error: unknown, options: { context?: ReportContext; roles?: readonly TeamRole[] } = {}): Promise<ReportOutcome> {
    try {
      const now = this.now();
      const facts = errorFacts(error, this.redactions);
      const key = errorFingerprint(facts);
      const known = this.folding.get(key);
      if (known && now >= known.sentAt && now - known.sentAt < REPORT_FOLD_MS) {
        known.folded++;
        known.context = options.context;
        known.roles = options.roles;
        this.log("info", "chat_error_folded", { times: known.folded });
        return { folded: true, ...NO_DELIVERY };
      }
      const folded = known && known.folded > 0 ? { times: known.folded + 1, since: known.sentAt } : null;
      this.folding.delete(key);
      if (this.folding.size >= MAX_FOLDING) this.folding.delete(this.folding.keys().next().value!);
      this.folding.set(key, { facts, sentAt: now, folded: 0, context: options.context, roles: options.roles });
      const delivery = await this.notifyTeam(this.errorCard(facts, options.context, folded, now), { roles: options.roles });
      this.log("info", "chat_error_reported", { ...delivery });
      return { folded: false, ...delivery };
    } catch (e) {
      this.log("warn", "chat_report_failed", { reason: scrubSecrets((e as Error).message, this.redactions) });
      return { folded: false, ...NO_DELIVERY };
    }
  }

  /** Send the counts of errors folded within an hour that has passed, one card each: how many reports it sent. The
   *  server does it every 10 minutes; call it before stopping to lose none. */
  async flushReports(): Promise<number> {
    const now = this.now();
    let cards = 0;
    for (const [key, r] of [...this.folding]) {
      if (now >= r.sentAt && now - r.sentAt < REPORT_FOLD_MS) continue;
      if (r.folded === 0) {
        this.folding.delete(key);
        continue;
      }
      const card = this.errorCard(r.facts, r.context, { times: r.folded, since: r.sentAt }, now);
      this.folding.set(key, { ...r, sentAt: now, folded: 0 });
      try {
        await this.notifyTeam(card, { roles: r.roles });
        cards++;
      } catch (e) {
        this.log("warn", "chat_report_failed", { reason: scrubSecrets((e as Error).message, this.redactions) });
      }
    }
    return cards;
  }

  private errorCard(facts: ErrorFacts, context: ReportContext | undefined, folded: { times: number; since: number } | null, at: number): Card {
    const version = context?.version ?? this.options.version;
    return reportCard(facts, {
      slug: this.slug, at, specVersion: this.signed.spec.version, folded, extra: this.redactions,
      context: { ...context, ...(version !== undefined ? { version } : {}) },
    });
  }

  /** A handler's error to the team, unless the options turn it off or there is no registry to find the team in. */
  private reportHandlerError(e: unknown, ask: ChatAsk): void {
    if (this.options.reportErrors === false || !this.view) return;
    void this.report(e, { context: { command: ask.command ? `/${ask.command}` : "(text)", request: ask.request.id } });
  }

  private async knownTeam(): Promise<Record<string, string>> {
    return this.store.team ? { ...(await this.store.team()) } : Object.fromEntries(this.teamMemory);
  }

  private async setTeamAddress(account: string, address: string | null): Promise<void> {
    if (this.store.setTeam) await this.store.setTeam(account, address);
    else if (address === null) this.teamMemory.delete(account);
    else this.teamMemory.set(account, address);
  }

  /** Keep where `account`'s chat is: the address of the grain key its proof showed. */
  private async remember(account: string, key: string): Promise<void> {
    const address = this.userAddress(key);
    if ((await this.knownTeam())[account] === address) return;
    await this.setTeamAddress(account, address);
    this.log("info", "chat_team_reachable", {});
  }

  /**
   * The team member whose proof `check` carries, remembered with their address; null when it carries none that checks
   * for an account on the team. A proof from anyone else costs the node nothing; a node that does not answer leaves the
   * proof unread, and refuses nothing.
   */
  private async learnTeam(access: GrainAccess, check: Parameters<typeof needsTeamController>[1]): Promise<string | null> {
    const proof = check.proof;
    if (!proof) return null;
    if (!needsTeamController(access, check)) {
      this.log("info", "chat_team_proof_ignored", { reason: onTeam(access, proof.proof.account) ? "proof" : "not_team" });
      return null;
    }
    let controller;
    try {
      controller = await this.view!.controller(proof.proof.account);
    } catch (e) {
      this.log("warn", "chat_team_unchecked", { reason: (e as Error).message });
      return null;
    }
    const account = teamMemberOf(access, { ...check, controller });
    if (account === null) {
      this.log("info", "chat_team_proof_ignored", { reason: "signer" });
      return null;
    }
    await this.remember(account, check.requestKey);
    return account;
  }

  /** An address of a user in the grain, from it or from the grain key (hex). */
  private userAddress(user: string): string {
    if (/^[0-9a-f]{64}$/.test(user)) return encodeAddress(this.chain.network, accountId(fromHex(user, 32)));
    const decoded = decodeAddress(user);
    if (!decoded || decoded.kind !== 0 || decoded.network !== this.chain.network) throw new TypeError("a user is a personal address of this network, or a grain key in hex");
    return user;
  }

  /** Forget what the numbers no longer cover, publish them when an hour has passed, forget who was sent them a day ago. */
  private async sweep(): Promise<void> {
    const now = this.now();
    for (const [user, at] of this.statsSent) if (now - at >= DAY_MS || at > now) this.statsSent.delete(user);
    try {
      await this.publishStats();
    } catch (e) {
      this.log("warn", "chat_stats_failed", { reason: (e as Error).message });
    }
    if (!this.stopReason) await this.flushReports();
  }

  /**
   * Whether the request's sender may use the grain (24-app-studio §2a): anyone in a public grain; in a private one a
   * member whose proof `admits` takes. A grain the registry does not hold, or a server without a node, is public. Either
   * way, a proof from the grain's team says where that member's chat is (§4): a public grain knows its team, and only
   * its team.
   */
  private async admit(signed: SignedChatRequest, now: number): Promise<{ member: ChatMember | null } | { refused: MemberProblem }> {
    if (!this.view) return { member: null };
    this.record = await this.view.grain(this.slug);
    if (this.judgeKey()) throw new ChatKeyNotRegistered(this.stopReason!, this.slug);
    const g = this.record;
    if (!g) return { member: null };
    const access = accessOf(g);
    const check = { genesis: this.chain.genesis, slug: this.slug, requestKey: signed.key, proof: signed.request.member, now };
    if (access.public) {
      const account = await this.learnTeam(access, check);
      return { member: account === null ? null : { account, roles: rolesOf(access, account) } };
    }
    const controller = needsController(access, check) ? await this.view.controller(signed.request.member!.proof.account) : null;
    const problem = admits(access, { ...check, controller });
    if (problem) {
      // A viewer is on the team, though it does not use a private grain: its console still gets reports.
      if (problem === "not_member") await this.learnTeam(access, check);
      return { refused: problem };
    }
    const account = signed.request.member!.proof.account;
    if (onTeam(access, account)) await this.remember(account, signed.key);
    return { member: { account, roles: rolesOf(access, account) } };
  }

  private async onFrame(f: RelayFrame): Promise<void> {
    if (this.stopReason) return;
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
      this.log("warn", "chat_frame_dropped", { kind: Object.keys(frame)[0] });
      f.ack();
      return;
    }
    const signed = frame.request;
    const now = this.now();
    const problem = chatRequestProblem(signed, { chain: this.chain, spec: this.signed.spec, from: f.from, now });
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
      let admitted;
      try {
        admitted = await this.admit(signed, now);
      } catch (e) {
        if (e instanceof ChatKeyNotRegistered) {
          // Stopped: the frame stays in the mailbox, unanswered by this key.
          await this.store.forget(f.from, signed.request.id);
          taken = false;
          return;
        }
        this.log("warn", "chat_member_unchecked", { reason: (e as Error).message });
        ask = new ChatAsk(this, f.from, signed);
        await ask.fail("This app could not check its members just now. Try again in a minute.");
        acks.forEach((ack) => ack());
        return;
      }
      if ("refused" in admitted) {
        // A refusal and nothing more: no command runs, no spec or file is sent.
        this.log("info", "chat_request_refused", { command: signed.request.command || "(text)", reason: `member:${admitted.refused}` });
        ask = new ChatAsk(this, f.from, signed);
        await ask.refuse(MEMBER_REFUSALS[admitted.refused]);
        acks.forEach((ack) => ack());
        return;
      }
      await (this.store.seen ? this.store.seen(f.from, now) : this.window.seen(f.from, now));
      const sent = await this.store.specSent(f.from);
      if (sent === null || sent < this.signed.spec.version) await this.pushSpec(f.from);
      await this.pushStats(f.from, now);
      ask = new ChatAsk(this, f.from, signed, admitted.member);
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

  /** The numbers to `user`, at most once a day (`ChatFrame::Stats`): a chat-only grain's users have no other way. */
  private async pushStats(user: string, now: number): Promise<void> {
    if (!this.stats) return;
    const last = this.statsSent.get(user);
    if (last !== undefined && now - last < DAY_MS && now >= last) return;
    await this.deliver(user, encodeChatFrame({ stats: this.stats }));
    this.statsSent.set(user, now);
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
      if (e instanceof ChatRefusal && !ask.answered) {
        await ask.refuse(e.message.slice(0, 200));
        this.log("info", "chat_request_refused", { command, reason: "handler" });
        return;
      }
      const reason = scrubSecrets(e instanceof Error ? e.message : String(e), this.redactions);
      this.log("error", "chat_handler_failed", { command, reason, ...(ask.answered ? { after: "answer" } : {}) });
      this.reportHandlerError(e, ask);
      if (!ask.answered) await ask.answer(new Card().status("failed", "Something went wrong. Try again later."));
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
