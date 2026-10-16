// `@saltix/grain-server/testing`: an app's chat under test, end to end on one computer. `testChat` starts the app's chat
// server from a development key (never a real one) against a development relay and registry (`./dev.js`), and gives
// wallets that talk to it as Saltix does: a request typed by the spec and signed by the user's grain key, sealed frames,
// a member's proof for the owner and the team, every card and spec checked as a wallet checks it.
//
//   import { testChat } from "@saltix/grain-server/testing";
//   const t = await testChat({ spec: new URL("../chat.json", import.meta.url), setup: handlers });
//   const reply = await t.ask("plan", { minutes: 30n, level: "hard" }, { lang: "ru" });
//   assert.deepEqual(reply.fields, { Minutes: "30", Sets: "6" });
//   assert.equal((await t.as("owner").ask("stats")).status?.state, "done");
//   await t.close();
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { accountId, encodeAddress } from "./address.js";
import { AppKey } from "./app-key.js";
import { derive, toHex } from "./bytes.js";
import { type ArgValue, argsFor } from "./chat-card.js";
import {
  type Block, type ChatFrame, type ChatMessage, type GrainChatSpec, type SignedChatMessage, type SignedChatWelcome, STATUS, type StatusState,
  chatMessageProblem, chatSpecFromJson, chatWelcomeProblem, commandOf, decodeChatFrame, encodeChatFrame, newChatId, signChatHello,
  signChatRequest, signedChatSpecProblem,
} from "./chat.js";
import { type ChatLog, ChatServer, type ChatServerOptions } from "./chat-server.js";
import { type DevMember, type DevRegistry, type DevRelay, createDevRegistry, createDevRelay } from "./dev.js";
import { MEMBER_PROOF_LIFE_MS, signMemberProof } from "./member.js";
import { ROLES } from "./registry.js";
import { RelayClient } from "./relay.js";

/** A role on an app's team or among a private app's users (24-app-studio §2a). */
export type TestRole = keyof typeof ROLES;

export interface TestChatOptions {
  /** The chat spec: a path or file URL of `chat.json`, its JSON, or a `GrainChatSpec`. Its slug is the app's; the
   *  development key signs it at start, as a registered server key does. */
  spec: string | URL | GrainChatSpec | Record<string, unknown>;
  /** Register the app's handlers on the server the harness started (`(chat) => { chat.command(…) }`). */
  setup?: (chat: ChatServer) => void | Promise<void>;
  /** Or start the server yourself from the options the harness gives (a development key, the relay, the registry). */
  start?: (options: ChatServerOptions) => Promise<ChatServer>;
  /** Public (the default) or private: only its owner and members use a private app. */
  access?: "public" | "private";
  /** The app's members besides its owner, by a name tests use (`t.as(name)`): their roles. */
  members?: Record<string, readonly TestRole[]>;
  /** More options for `ChatServer.start`: `store`, `version`, `reportErrors`, `redact`, `now`… (not the key). */
  options?: Partial<Omit<ChatServerOptions, "appKey" | "secret" | "cert">>;
  /** How long `ask` waits for an answer, ms (5 000). */
  timeoutMs?: number;
}

/** A status block as a reply carries it. */
export interface TestStatus {
  state: StatusState;
  text: string;
}

/** The answer to a request, checked as a wallet checks it: the signed message, and its blocks read for tests. */
export interface ChatReply {
  /** The signed message, as the wallet got it. */
  signed: SignedChatMessage;
  message: ChatMessage;
  blocks: Block[];
  /** Every text block, joined by a line break. */
  text: string;
  /** Every fields block's rows, label to value. */
  fields: Record<string, string>;
  /** The last status block, or null. */
  status: TestStatus | null;
  /** Secrets by label. */
  secrets: Record<string, string>;
  actions: ChatMessage["actions"];
  /** The `working` statuses the answer replaced, in order. */
  working: ChatMessage[];
}

export interface AskOptions {
  /** The language the user's Saltix shows ("en" by default; "" when the app does not say). */
  lang?: string;
  /** The message whose action this request runs. */
  via?: string;
  /** Text with the command (a command's text field), or the text of a text-only request. */
  text?: string;
  /** How long to wait for the answer, ms. */
  timeoutMs?: number;
}

/** A wallet of one person in the app: their grain key, and their account's member proof when they are the owner or a
 *  member. */
export interface TestUser {
  /** Who: "owner", a member's name, or "stranger" (and other names `as` made up: users with no proof). */
  readonly name: string;
  /** The user's grain key (hex): what `ask.key` is. */
  readonly key: string;
  /** Their address in the app: what `ask.user` is, and what `chat.notify` takes. */
  readonly address: string;
  /** Their account (hex) when they are the owner or a member, else null. */
  readonly account: string | null;
  /** Send `command` with `args` (typed by the spec: a number as a bigint or an integer, a duration in seconds…) and
   *  wait for its answer. */
  ask(command: string, args?: Record<string, ArgValue>, options?: AskOptions): Promise<ChatReply>;
  /** Send text alone and wait for its answer. */
  say(text: string, options?: Omit<AskOptions, "text">): Promise<ChatReply>;
  /** The owner's or a team member's wallet introducing itself (22-grain-chats §3a): the server's welcome, checked. */
  hello(options?: { timeoutMs?: number }): Promise<SignedChatWelcome>;
  /** Every message this wallet got so far, checked, in order (answers and unasked ones). */
  readonly messages: ChatReply[];
  /** Messages that answer no request: `chat.notify`, the team's cards, reports. Waits until there are `count`. */
  unasked(count?: number, options?: { timeoutMs?: number }): Promise<ChatReply[]>;
  /** Register at the relay now (it does on first use): so `chat.notify` reaches a wallet that has sent nothing. */
  connect(): Promise<void>;
}

export interface TestChat {
  /** The app's chat server under test. */
  readonly chat: ChatServer;
  /** The development relay and registry it runs on: change the registry (`setAccess`, `setServers`, `retire`), then
   *  `await chat.checkRegistry()` for the server to read it now (it reads a new block within seconds, as from a node). */
  readonly relay: DevRelay;
  readonly registry: DevRegistry;
  /** The development key the server runs from: never a real one. */
  readonly appKey: AppKey;
  /** Everything the server logged: `{level, event, meta}`. */
  readonly logs: Array<{ level: string; event: string; meta: Record<string, unknown> }>;
  /** The default user: a stranger, with no member proof. */
  ask: TestUser["ask"];
  say: TestUser["say"];
  /** A wallet: "owner", a member named in `members`, or any other name for a user with no proof (made once a name). */
  as(name: string): TestUser;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const roleBits = (roles: readonly TestRole[]) => roles.reduce((bits, r) => bits | ROLES[r], 0);

/** The spec from a path, a URL, its JSON or itself. */
function specOf(spec: TestChatOptions["spec"]): GrainChatSpec {
  if (typeof spec === "string" || spec instanceof URL) return chatSpecFromJson(JSON.parse(readFileSync(spec, "utf8")));
  if ("commands" in spec && Array.isArray(spec.commands) && "revoked" in spec) return spec as GrainChatSpec;
  return chatSpecFromJson(spec);
}

/** `signed` as a reply, its blocks read. */
function replyOf(signed: SignedChatMessage, working: ChatMessage[]): ChatReply {
  const m = signed.message;
  const texts: string[] = [];
  const fields: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  let status: TestStatus | null = null;
  const states = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k])) as Record<number, StatusState>;
  for (const b of m.blocks) {
    if ("text" in b) texts.push(b.text.text);
    else if ("fields" in b) for (const [label, value] of b.fields.rows) fields[label] = value;
    else if ("secret" in b) secrets[b.secret.label] = b.secret.value;
    else if ("status" in b) status = { state: states[b.status.state]!, text: b.status.text };
  }
  return { signed, message: m, blocks: m.blocks, text: texts.join("\n"), fields, status, secrets, actions: m.actions, working };
}

/**
 * Start the app's chat for a test: a development relay and registry of its own (a fresh network, the slug the spec's),
 * the server run from a development key the registry names, the owner and `members` with accounts of their own. Call
 * `close()` after (`t.after(() => chat.close())`).
 */
export async function testChat(o: TestChatOptions): Promise<TestChat> {
  const spec = specOf(o.spec);
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const relay = await createDevRelay();
  const serverSecret = new Uint8Array(randomBytes(32));
  const ownerSecret = new Uint8Array(randomBytes(32));
  const memberSecrets = new Map(Object.keys(o.members ?? {}).map((name) => [name, new Uint8Array(randomBytes(32))]));
  const accountOf = (secret: Uint8Array) => toHex(accountId(ed25519.getPublicKey(secret)));
  const members: DevMember[] = Object.entries(o.members ?? {}).map(([name, roles]) => ({ account: accountOf(memberSecrets.get(name)!), roles: roleBits(roles) }));
  if (o.members && "owner" in o.members) throw new TypeError("members: the owner is there already (t.as(\"owner\"))");
  const registry = createDevRegistry({
    slug: spec.slug, ownerSecret, servers: [toHex(ed25519.getPublicKey(serverSecret))], public: o.access !== "private", members,
    relays: [relay.endpoint()],
  });
  const appKey = AppKey.of(registry.network, registry.genesis, spec.slug, serverSecret);
  const logs: TestChat["logs"] = [];
  const log: ChatLog = (level, event, meta = {}) => logs.push({ level, event, meta });
  const options: ChatServerOptions = { log, ...o.options, appKey, spec, wallet: registry, endpoints: [relay.endpoint()] };
  let chat: ChatServer;
  try {
    chat = o.start ? await o.start(options) : await ChatServer.start(options);
    await o.setup?.(chat);
  } catch (e) {
    await relay.close();
    throw e;
  }
  const chain = { genesis: registry.genesis, network: registry.network };
  const ownerKey = { ed25519: toHex(ed25519.getPublicKey(ownerSecret)) };
  const wallets = new Map<string, TestUser>();
  const clients: Array<Promise<RelayClient>> = [];

  /** A person's wallet: its keys at once, its connection to the relay on first use. */
  function wallet(name: string): TestUser {
    const grainSecret = new Uint8Array(randomBytes(32));
    const accountSecret = name === "owner" ? ownerSecret : memberSecrets.get(name) ?? null;
    const messagingSecret = derive("Saltix grain messaging key v1", grainSecret, new TextEncoder().encode(spec.slug));
    let connecting: Promise<RelayClient> | null = null;
    const connected = () => {
      if (connecting) return connecting;
      connecting = RelayClient.connect({ endpoints: [relay.endpoint()], secret: grainSecret, messagingSecret, network: chain.network, log: () => {} })
        .then((client) => {
          client.on("frame", onFrame);
          return client;
        });
      clients.push(connecting);
      return connecting;
    };
    const key = toHex(ed25519.getPublicKey(grainSecret));
    const address = encodeAddress(chain.network, accountId(ed25519.getPublicKey(grainSecret)));
    const messages: ChatReply[] = [];
    const welcomes: SignedChatWelcome[] = [];
    const replaced = new Map<string, ChatMessage[]>();
    const problems: string[] = [];
    let held: GrainChatSpec | null = null;
    const waiting: Array<() => void> = [];
    const wake = () => waiting.splice(0).forEach((w) => w());
    const servers = () => registry.grain.servers ?? [];

    function onFrame({ from, payload }: { from: string; payload: Uint8Array }): void {
      let frame: ChatFrame;
      try {
        frame = decodeChatFrame(payload);
      } catch {
        return; // not a chat frame: a notification, say
      }
      if (from !== chat.address) problems.push(`a frame from ${from}, not the app's server`);
      else if ("spec" in frame) {
        const p = signedChatSpecProblem(frame.spec.spec, spec.slug, ownerKey, servers());
        if (p) problems.push(`a spec a wallet would refuse: ${p}`);
        else if (held && frame.spec.spec.spec.version < held.version) problems.push(`a spec of version ${frame.spec.spec.spec.version}, below ${held.version} held`);
        else if (!held || frame.spec.spec.spec.version > held.version) held = frame.spec.spec.spec;
      } else if ("message" in frame) {
        const p = chatMessageProblem(frame.message, { chain, ownerKey, servers: servers(), spec: held ?? chat.spec, from, now: Date.now() });
        if (p) problems.push(`a card a wallet would not show: ${p}`);
        else {
          const m = frame.message.message;
          const before = m.replaces ? replaced.get(m.replaces) ?? [] : [];
          const earlier = messages.find((r) => r.message.id === m.replaces);
          const chain_ = earlier ? [...before, earlier.message] : before;
          replaced.set(m.id, chain_);
          messages.push(replyOf(frame.message, chain_));
        }
      } else if ("welcome" in frame) {
        welcomes.push(frame.welcome);
      }
      wake();
    }

    /** Wait until `test()` holds, at most `ms`; a problem a wallet would have fails at once. */
    async function until<T>(test: () => T | null | undefined, ms: number, what: string): Promise<T> {
      const end = Date.now() + ms;
      for (;;) {
        if (problems.length > 0) throw new Error(problems.join("; "));
        const found = test();
        if (found !== null && found !== undefined) return found;
        if (Date.now() > end) throw new Error(`${what} within ${ms} ms (server log: ${logs.map((l) => l.event).join(", ") || "nothing"})`);
        await new Promise<void>((r) => {
          waiting.push(r);
          setTimeout(r, 50);
        });
      }
    }

    const proof = () => accountSecret === null ? null : signMemberProof(
      { slug: spec.slug, account: accountOf(accountSecret), grain_key: key, expires_at: Date.now() + MEMBER_PROOF_LIFE_MS - 60_000 },
      accountSecret, chain.genesis,
    );

    async function send(command: string, args: Record<string, ArgValue>, opts: AskOptions): Promise<ChatReply> {
      const typed = command === "" ? [] : (() => {
        const c = commandOf(held ?? chat.spec, command);
        if (!c) throw new TypeError(`the chat spec has no command ${command}`);
        return argsFor(c, args);
      })();
      const now = Date.now();
      const request = signChatRequest({
        slug: spec.slug, id: newChatId(), at: now, expires_at: now + 86_400_000, via: opts.via ?? null, command, args: typed,
        text: opts.text ?? "", member: proof(), lang: opts.lang ?? "en",
      }, grainSecret, chain.genesis);
      await (await connected()).send(chat.address, encodeChatFrame({ request }), { keep: true });
      const id = request.request.id;
      const answer = (r: ChatReply) => r.message.answers === id && r.status?.state !== "working";
      return until(() => messages.find(answer), opts.timeoutMs ?? timeoutMs, `no answer to ${command ? `/${command}` : "the text"}`);
    }

    return {
      name, key, address, messages, account: accountSecret === null ? null : accountOf(accountSecret),
      ask: (command, args = {}, opts = {}) => {
        if (command === "") throw new TypeError("a command's name; say() sends text alone");
        return send(command, args, opts);
      },
      say: (text, opts = {}) => send("", {}, { ...opts, text }),
      async hello(opts = {}) {
        const p = proof();
        if (p === null) throw new TypeError(`${name} is not on the app's team: only the owner and members say hello`);
        const hello = signChatHello({ slug: spec.slug, id: newChatId(), at: Date.now(), member: p, lang: "en" }, grainSecret, chain.genesis);
        await (await connected()).send(chat.address, encodeChatFrame({ hello }), { keep: true });
        const welcome = await until(() => welcomes.find((w) => w.welcome.hello === hello.hello.id), opts.timeoutMs ?? timeoutMs, "no welcome");
        const problem = chatWelcomeProblem(welcome, {
          chain, slug: spec.slug, hello: hello.hello.id, ownerKey, servers: servers(), spec: held ?? chat.spec, from: chat.address, now: Date.now(),
        });
        if (problem) throw new Error(`a welcome a wallet would refuse: ${problem}`);
        return welcome;
      },
      unasked: (count = 1, opts = {}) => until(() => {
        const found = messages.filter((r) => r.message.answers === null);
        return found.length >= count ? found : null;
      }, opts.timeoutMs ?? timeoutMs, `fewer than ${count} unasked messages`),
      async connect() {
        await connected();
      },
    };
  }

  const as = (name: string): TestUser => {
    if (!wallets.has(name)) wallets.set(name, wallet(name));
    return wallets.get(name)!;
  };

  return {
    chat, relay, registry, appKey, logs, as,
    ask: (command, args, opts) => as("stranger").ask(command, args, opts),
    say: (text, opts) => as("stranger").say(text, opts),
    async close() {
      chat.close();
      for (const c of await Promise.allSettled(clients)) if (c.status === "fulfilled") c.value.close();
      await relay.close();
    },
  };
}
