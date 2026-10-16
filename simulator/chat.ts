/**
 * A grain's chat in the simulator, played as a wallet plays it (Saltix 22-grain-chats, 24-app-studio): the user's grain
 * alias registered at the development relay (`npm run dev`, /relay), requests signed by the grain key and sealed to the
 * server's checked key, and every message checked before it is drawn — from the server key's address, the key one the
 * registry names (or a certificate of the owner's within 31 days), not revoked, in bounds, timely, signed. Unasked
 * messages count against 10 a day (100 when the account is on the app's team) and show only while allowed. A private
 * app gets a member proof signed by the simulator's account key with every request, and so does the app whose team the
 * account is on (its console, 24-app-studio §4); every request names the page's language as Saltix names its own;
 * the numbers the app reports are shown as reported, once checked. When the account is on the app's team, the pane says
 * hello as a team's wallet does (22-grain-chats §3a): on loading the chat and on joining the team, at most one in flight,
 * again after `HELLO_RETRY_MS` without a welcome; a welcome is checked and logged, never drawn in the chat, and unasked
 * messages are then allowed. A developer tool: the alias uses `register` on a connection of its own, and the history
 * lives in this page.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { derive, fromHex, toHex } from "../packages/server/src/bytes";
import { accountId, encodeAddress } from "../packages/server/src/address";
import {
  encodeAddressRecord, fromBase64Url, messagingKeyOf, signAddressRecord, signKeyBinding, signMailboxAck, toBase64Url,
} from "../packages/server/src/records";
import { messagingPublic, openFrame, sealFrame } from "../packages/server/src/seal";
import {
  CHAT_UNASKED_PER_DAY, CHAT_UNASKED_TEAM_PER_DAY, HELLO_RETRY_MS, type ActionKind, type ChainParams, type ChatArgs, type ChatMessage,
  type ChatValue, type SignedChatMessage, type SignedChatWelcome, type SignedGrainChatSpec, chatCertHolds, chatMessageProblem,
  chatWelcomeProblem, commandOf, decodeChatDocument, decodeChatFrame, encodeChatFrame, newChatId, requestFitProblem, signChatHello,
  signChatRequest, signedChatSpecProblem,
} from "../packages/server/src/chat";
import { type FileRef, fileRefProblem, openFile, sealFile } from "../packages/server/src/file";
import { type InvoiceKeyCert, decodeCert, invoiceProblem } from "../packages/server/src/invoice";
import { MEMBER_PROOF_LIFE_MS, onTeam, signMemberProof } from "../packages/server/src/member";
import { type SignedGrainStats, grainStatsProblem } from "../packages/server/src/stats";
import type { DeviceKey } from "../packages/server/src/keys";
import { argOf } from "../packages/server/src/chat-card";
import { type TapState, el, pick, renderCard, renderForm, renderSpecCard } from "./chat-ui";
import { isDestructive } from "../packages/server/src/card-standard";

export interface ChatHost {
  slug(): string;
  owner(): DeviceKey | null;
  language(): string;
  /** The simulator's grain secret (12-grains §5.1). */
  secret(): Uint8Array;
  /** The simulator's account key (Ed25519 secret): it signs member proofs for private apps. */
  account(): Uint8Array;
  log(line: string): void;
  /** Open the grain's screen with `start`. */
  open(start: string): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const DAY = 86_400_000;

interface DevInfo {
  chain: ChainParams;
  relay: string | null;
  /** The server keys the development registry names. */
  servers: string[];
  /** Who may use the example grain, as the development registry has it. */
  access: { owner: string; public: boolean; members: Array<{ account: string; roles: number }> } | null;
}

export function setupChat(host: ChatHost): { open(cert?: string, spec?: string): Promise<void> } {
  const pane = $("chat-log");
  let chain: ChainParams | null = null;
  let spec: SignedGrainChatSpec | null = null;
  let cert: InvoiceKeyCert | null = null;
  /** The server keys the registry names, as last read. */
  let servers: string[] = [];
  /** Whether the registry says the app is private, and whether this account is on its team: a wallet sends a member
   *  proof only then. */
  let privateApp = false;
  let teamMember = false;
  let ws: WebSocket | null = null;
  let registered = false;
  const keys = new Map<string, Uint8Array | null>();
  const keyWaits = new Map<string, Array<(k: Uint8Array | null) => void>>();
  const slots = new Map<string, (answer: { id?: string; detail?: string }) => void>();
  /** Requests sent: id → when they expire. */
  const sent = new Map<string, number>();
  const drawn = new Map<string, HTMLElement>();
  /** Cards drawn, by message id, with what they say above them: a tap redraws its card. */
  const cards = new Map<string, { message: ChatMessage; mark: string }>();
  /** The last tap on each card (22-grain-chats §5a), and which card and control each request was tapped on. */
  const taps = new Map<string, TapState>();
  const tapped = new Map<string, { card: string; key: string }>();
  /** A form opened from a card: the control it was opened from. */
  let formTap: { card: string; key: string } | null = null;
  const unasked: number[] = [];
  /** The hello in flight (its id and when it went), and the server key that welcomed this wallet. */
  let hello: { id: string; at: number } | null = null;
  let welcomedBy: string | null = null;
  let current: ReturnType<typeof renderForm> | null = null;
  let currentCommand = "";
  let via: string | null = null;

  const grainKey = () => derive("Saltix grain key v1", host.secret(), new TextEncoder().encode(host.slug()));
  const messagingSecret = () => derive("Saltix grain messaging key v1", host.secret(), new TextEncoder().encode(host.slug()));
  const me = () => encodeAddress("devnet", accountId(ed25519.getPublicKey(grainKey())));
  /** The chat's address: the certificate's key when there is one, else the first key the registry names (§1). */
  const serverKey = () => (cert ? cert.key : servers[0] ?? null);
  const serverAddress = () => {
    const key = serverKey();
    return key ? encodeAddress("devnet", accountId(fromHex(key, 32))) : null;
  };
  const note = (text: string, kind = "note") => pane.append(el("div", { className: kind, textContent: text }));
  const myAccount = () => toHex(accountId(ed25519.getPublicKey(host.account())));

  function adopt(next: SignedGrainChatSpec, nextCert: InvoiceKeyCert | null, source: string): boolean {
    const owner = host.owner();
    if (!owner) return note("Set the owner key (load the manifest) to check the chat spec.", "bad"), false;
    const problem = signedChatSpecProblem(next, host.slug(), owner, servers);
    if (problem) return note(`${source}: spec refused (${problem})`, "bad"), false;
    if (spec && next.spec.version < spec.spec.version) return note(`${source}: spec v${next.spec.version} refused, v${spec.spec.version} is held`, "bad"), false;
    if (nextCert && !chatCertHolds(nextCert, host.slug(), owner, next.spec, Date.now())) return note(`${source}: the server key's certificate is refused`, "bad"), false;
    if (!nextCert && servers.length === 0) return note(`${source}: no certificate, and the registry names no server key`, "bad"), false;
    spec = next;
    cert = nextCert;
    const by = next.server === null ? "signed by the owner key" : "signed by a server key the registry names";
    $("chat-card").replaceChildren(renderSpecCard(next.spec, host.language(), by));
    const select = $<HTMLSelectElement>("chat-command");
    select.replaceChildren(el("option", { value: "", textContent: "Pick a command…" }), ...next.spec.commands.map((c) => el("option", { value: c.name, textContent: pick(c.title, host.language()) })));
    host.log(`chat: spec v${next.spec.version} of ${next.spec.slug} taken (${source})`);
    return true;
  }

  async function connect(relayPath: string): Promise<void> {
    ws?.close();
    registered = false;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${relayPath}`;
    const socket = new WebSocket(url);
    ws = socket;
    await new Promise<void>((resolve, reject) => {
      socket.onerror = () => reject(new Error(`no relay at ${url}`));
      socket.onmessage = (event) => {
        const f = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (f.type === "hello") {
          const secret = grainKey();
          const sts = Number(f.sts);
          const binding = signKeyBinding(secret, messagingPublic(messagingSecret()), sts);
          const record = signAddressRecord(secret, binding, fromBase64Url(String(f.relay)), fromBase64Url(String(f.nonce)), sts);
          socket.send(JSON.stringify({ type: "register", record: toBase64Url(encodeAddressRecord(record)) }));
        } else if (f.type === "registered") {
          registered = true;
          host.log(`chat: the grain alias ${me()} is registered at the relay`);
          resolve();
        } else onFrame(f);
      };
    });
  }

  function keyOf(address: string): Promise<Uint8Array | null> {
    if (keys.has(address)) return Promise.resolve(keys.get(address)!);
    return new Promise((resolve) => {
      const waiting = keyWaits.get(address);
      if (waiting) return waiting.push(resolve);
      keyWaits.set(address, [resolve]);
      ws!.send(JSON.stringify({ type: "get_key", pubkey: address }));
    });
  }

  function onFrame(f: Record<string, unknown>): void {
    if (f.type === "key_response") {
      const address = String(f.pubkey);
      const key = messagingKeyOf(address, f.record as string | null, Date.now(), "devnet");
      keys.set(address, key);
      keyWaits.get(address)?.forEach((r) => r(key));
      keyWaits.delete(address);
    } else if (f.type === "file_slot" || (f.type === "error" && f.message === "file_refused")) {
      slots.get(String(f.ref))?.({ id: f.id as string | undefined, detail: f.detail as string | undefined });
    } else if (f.type === "message") void onMessage(f);
  }

  async function onMessage(f: Record<string, unknown>): Promise<void> {
    const from = String(f.from);
    const key = await keyOf(from);
    const plain = key && openFrame(fromBase64Url(String(f.payload)), key, messagingSecret());
    // Whatever reaches the alias leaves the mailbox, chat or not.
    if (typeof f.msgId === "string" && f.ephemeral !== true) {
      ws?.send(JSON.stringify({ type: "message_ack", to: from, msgId: f.msgId, proof: toBase64Url(signMailboxAck(grainKey(), f.msgId, Date.now())) }));
    }
    if (!plain) return host.log("chat: a frame that does not open, dropped");
    let frame;
    try {
      frame = decodeChatFrame(plain);
    } catch {
      return host.log("chat: not a chat frame, dropped");
    }
    if ("spec" in frame) {
      const key = frame.spec.cert?.key ?? serverKey();
      if (key && from === encodeAddress("devnet", accountId(fromHex(key, 32)))) adopt(frame.spec.spec, frame.spec.cert, "pushed in the chat");
      return;
    }
    if ("stats" in frame) {
      if (from === serverAddress()) showStats(frame.stats, "in the chat");
      return;
    }
    if ("welcome" in frame) return welcomed(frame.welcome, from);
    if (!("message" in frame) || !spec || !chain) return host.log("chat: dropped (not a message, or no spec held)");
    show(frame.message, from);
  }

  /** The numbers the app reports, shown as reported and only once checked: a registered key's, at most 2 days old. */
  function showStats(signed: SignedGrainStats, source: string): void {
    const problem = grainStatsProblem(signed, { genesis: chain!.genesis, slug: host.slug(), servers, now: Date.now() });
    const box = $("chat-stats");
    if (problem) {
      box.textContent = `Reported numbers (${source}) refused: ${problem}`;
      return;
    }
    const s = signed.stats;
    box.textContent = `Reported by the app: users today ${s.users_1d}, this month ${s.users_30d}; requests in 30 days ${s.requests_30d} ` +
      `(${new Date(s.at).toLocaleTimeString()}, ${source})`;
  }

  function show(m: SignedChatMessage, from: string): void {
    const problem = chatMessageProblem(m, { chain: chain!, ownerKey: host.owner()!, servers, spec: spec!.spec, from, now: Date.now() });
    if (problem) return note(`A message was refused: ${problem}`, "bad");
    const msg = m.message;
    const answers = msg.answers !== null && (sent.get(msg.answers) ?? 0) > Date.now();
    if (!answers) {
      // Unasked: shown while allowed, within 10 a day, or 100 to the app's team (notifications included).
      const recent = unasked.filter((at) => at > Date.now() - DAY);
      const limit = teamMember ? CHAT_UNASKED_TEAM_PER_DAY : CHAT_UNASKED_PER_DAY;
      if (!$<HTMLInputElement>("chat-unasked").checked) return host.log("chat: an unasked message, dropped (not allowed)");
      if (recent.length >= limit) return host.log(`chat: an unasked message, dropped (${limit} today already)`);
      unasked.splice(0, unasked.length, ...recent, Date.now());
    }
    // An answer to a tap: its control shows a check (or the refused mark) on the card it was tapped on, or on this card
    // when it takes that card's place (a poll's new counts).
    // A "working" status is not the answer yet: the control keeps waiting for the message that replaces it.
    const tap = msg.answers !== null ? tapped.get(msg.answers) : undefined;
    const status = msg.blocks.find((b) => "status" in b);
    const state = status && "status" in status ? status.status.state : null;
    if (tap && state !== 0) {
      tapped.delete(msg.answers!);
      taps.set(msg.replaces === tap.card ? msg.id : tap.card, { key: tap.key, phase: state !== null && state >= 2 ? "refused" : "done" });
      if (msg.replaces !== tap.card) redraw(tap.card);
    }
    const mark = `from ${host.slug()}, verified${answers ? "" : teamMember ? " · to the team" : " · unasked"}`;
    cards.set(msg.id, { message: msg, mark });
    const bubble = draw(msg.id);
    const earlier = msg.replaces ? drawn.get(msg.replaces) : undefined;
    if (earlier) earlier.replaceWith(bubble);
    else pane.append(bubble);
    drawn.set(msg.id, bubble);
    pane.scrollTop = pane.scrollHeight;
  }

  const handlers = {
    download: (file: FileRef) => download(file),
    invoiceProblem: (hex: string) => invoiceProblem(hex, host.slug(), host.owner()!, chain!.genesis),
    tap: (key: string, kind: ActionKind, card: string, edit: boolean) => void tapOn(key, kind, card, edit),
    open: (start: string) => host.open(start),
  };

  /** The card `id` as it stands, by the card standard at the chat pane's width. */
  function draw(id: string): HTMLElement {
    const c = cards.get(id)!;
    return renderCard(c.message, c.mark, handlers, taps.get(id) ?? null, Math.min(400, pane.clientWidth - 24));
  }

  function redraw(id: string): void {
    const old = drawn.get(id);
    if (!old || !cards.has(id)) return;
    const next = draw(id);
    old.replaceWith(next);
    drawn.set(id, next);
  }

  /**
   * A tap on a card's control (22-grain-chats §4, §5a): a reply goes at once; a run (or a poll's option) goes at once
   * when its arguments fill the command's form, after "Send?" when the command is confirm or destructive, and opens the
   * form otherwise or on a long press (here, a right click). The control waits for the answer, a minute at most.
   */
  async function tapOn(key: string, kind: ActionKind, card: string, edit: boolean): Promise<void> {
    if ("open" in kind || "publish" in kind) return;
    let id: string | null;
    if ("reply" in kind) id = await sendRequest("", [], kind.reply.text, card);
    else {
      const c = spec && commandOf(spec.spec, kind.run.command);
      if (!c) return note(`The spec has no command ${kind.run.command}.`, "bad");
      const fits = requestFitProblem({ slug: host.slug(), id: "00".repeat(16), at: 0, expires_at: 1, via: null, command: c.name, args: kind.run.args, text: "", member: null, lang: "" }, spec!.spec) === null;
      if (edit || !fits) {
        formTap = { card, key };
        return pickCommand(c.name, kind.run.args, card);
      }
      if ((c.confirm || isDestructive(c.name)) && !confirm(`Send "${pick(c.title, host.language())}"?`)) return;
      id = await sendRequest(c.name, kind.run.args, "", card, true);
    }
    if (id) waitFor(id, card, key);
  }

  function waitFor(request: string, card: string, key: string): void {
    tapped.set(request, { card, key });
    taps.set(card, { key, phase: "waiting" });
    redraw(card);
    setTimeout(() => {
      const t = taps.get(card);
      if (tapped.has(request) && t?.key === key && t.phase === "waiting") {
        taps.set(card, { key, phase: "late" });
        redraw(card);
      }
    }, 60_000);
  }

  async function download(file: FileRef): Promise<Uint8Array> {
    if (file.relay !== null) throw new Error("a file at another relay: a browser fetches it through its own relay (09-relay §10.5), which the development relay does not do");
    const response = await fetch(`/_file/${file.id}`);
    if (response.status === 404) throw new Error("the file is gone");
    return openFile(new Uint8Array(await response.arrayBuffer()), file);
  }

  /** Seal and upload a file the user picked next to the relay: its reference. */
  async function upload(file: File): Promise<FileRef> {
    const sealed = await sealFile(new Uint8Array(await file.arrayBuffer()));
    const ref = toHex(crypto.getRandomValues(new Uint8Array(8)));
    const answer = await new Promise<{ id?: string; detail?: string }>((resolve) => {
      slots.set(ref, resolve);
      ws!.send(JSON.stringify({ type: "file_new", size: sealed.ciphertext.length, ref }));
    });
    slots.delete(ref);
    if (!answer.id) throw new Error(`the relay refused the file: ${answer.detail}`);
    for (let off = 0; off < sealed.ciphertext.length; off += 1 << 20) {
      const piece = sealed.ciphertext.subarray(off, off + (1 << 20));
      const r = await fetch(`/_file/${answer.id}`, { method: "PUT", headers: { "x-offset": String(off) }, body: piece as BodyInit });
      if (!r.ok) throw new Error(`the relay answered ${r.status}`);
    }
    if (!(await fetch(`/_file/${answer.id}/done`, { method: "POST" })).ok) throw new Error("the relay did not finish the file");
    const f: FileRef = { relay: null, id: answer.id, key: sealed.key, iv: sealed.iv, hash: sealed.hash, size: sealed.size, name: file.name.replace(/[/\\]/g, "_"), mime: file.type || "application/octet-stream" };
    const problem = fileRefProblem(f);
    if (problem) throw new Error(`file: ${problem}`);
    return f;
  }

  /** This account's member proof for the grain key, as a team's or a private app's member's wallet signs it. */
  function memberProof(now: number) {
    return signMemberProof({
      slug: host.slug(), account: myAccount(), grain_key: toHex(ed25519.getPublicKey(grainKey())), expires_at: now + MEMBER_PROOF_LIFE_MS - 60_000,
    }, host.account(), chain!.genesis);
  }

  /** Say hello (22-grain-chats §3a) when the account is on the app's team: one in flight, again after `HELLO_RETRY_MS`
   *  without a welcome, none once welcomed by the key the chat writes to. Nothing of it is drawn in the chat. */
  async function sayHello(): Promise<void> {
    if (!teamMember || !spec || !chain || !registered || !serverKey()) return;
    const now = Date.now();
    if (welcomedBy === serverKey()) return;
    if (hello && now - hello.at < HELLO_RETRY_MS) return;
    const to = serverAddress()!;
    const key = await keyOf(to);
    if (!key) return host.log("chat: no hello, the server is not registered at the relay");
    const signed = signChatHello({ slug: host.slug(), id: newChatId(), at: now, member: memberProof(now), lang: host.language() }, grainKey(), chain.genesis);
    ws!.send(JSON.stringify({ type: "message", to, payload: toBase64Url(sealFrame(encodeChatFrame({ hello: signed }), key, messagingSecret())), msgId: newChatId() }));
    hello = { id: signed.hello.id, at: now };
    host.log("chat: hello sent: this account is on the app's team, so its wallet introduces itself to the app");
  }

  /** A welcome, taken only from the chat's server key, for the hello in flight, at most 5 minutes ahead and signed. */
  function welcomed(w: SignedChatWelcome, from: string): void {
    const problem = hello === null ? "unasked" : chatWelcomeProblem(w, {
      chain: chain!, slug: host.slug(), hello: hello.id, ownerKey: host.owner()!, servers, spec: spec?.spec ?? null, from, now: Date.now(),
    });
    if (problem) return host.log(`chat: a welcome dropped (${problem})`);
    hello = null;
    welcomedBy = serverKey();
    // The team asked to hear from its own app: its unasked messages are allowed by default (22-grain-chats §4).
    $<HTMLInputElement>("chat-unasked").checked = true;
    host.log("chat: welcomed: the app's console reaches this account without it writing first");
  }

  /** Send a request: its id, or null when it did not go. `asked`: the card's tap asked "Send?" already. */
  async function sendRequest(command: string, args: ChatArgs, text: string, viaId: string | null, asked = false): Promise<string | null> {
    if (!spec || !chain || !registered || !serverKey()) return note("Load the chat first.", "bad"), null;
    const now = Date.now();
    // A private app's member proves its account with every request, and so does the app's team to a public app, so that
    // the app reaches it in its console (24-app-studio §2a, §4); a public app's users never send one.
    const member = (privateApp || teamMember) && $<HTMLInputElement>("chat-proof").checked ? memberProof(now) : null;
    // The page's language, as Saltix sends its display language with every request (22-grain-chats §3).
    const request = { slug: host.slug(), id: newChatId(), at: now, expires_at: now + DAY, via: viaId, command, args, text, member, lang: host.language() };
    const problem = requestFitProblem(request, spec.spec);
    if (problem) return note(`Not sent: ${problem}`, "bad"), null;
    const c = commandOf(spec.spec, command);
    if (!asked && c?.confirm && !confirm(`Send "${pick(c.title, host.language())}"?`)) return null;
    const to = serverAddress()!;
    const key = await keyOf(to);
    if (!key) return note("The server is not registered at the relay.", "bad"), null;
    const frame = encodeChatFrame({ request: signChatRequest(request, grainKey(), chain.genesis) });
    ws!.send(JSON.stringify({ type: "message", to, payload: toBase64Url(sealFrame(frame, key, messagingSecret())), msgId: newChatId() }));
    sent.set(request.id, request.expires_at);
    const value = (v: ChatValue) => ("file" in v ? v.file.name : String(argOf(v)));
    const shown = command ? `${pick(c!.title, host.language())} ${args.map(([n, v]) => `${n}: ${value(v)}`).join(", ")}` : text;
    pane.append(el("div", { className: "msg out", textContent: shown }));
    pane.scrollTop = pane.scrollHeight;
    return request.id;
  }

  function pickCommand(name: string, prefill: ChatArgs = [], viaId: string | null = null): void {
    const c = spec && commandOf(spec.spec, name);
    $<HTMLSelectElement>("chat-command").value = c ? name : "";
    currentCommand = c ? name : "";
    via = viaId;
    if (viaId === null) formTap = null;
    current = c ? renderForm(c, host.language(), prefill) : null;
    $("chat-form").replaceChildren(...(current ? [current.form, el("button", { textContent: "Send", onclick: () => void sendForm() })] : []));
  }

  async function sendForm(): Promise<void> {
    if (!current || !spec) return;
    const read = await current.read();
    if (typeof read === "string") return note(`Fill in "${read}" as the form says.`, "bad");
    try {
      for (const [name, file] of current.files) read.push([name, { file: await upload(file) }]);
    } catch (e) {
      return note((e as Error).message, "bad");
    }
    read.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const from = formTap;
    const id = await sendRequest(currentCommand, read, "", via);
    if (id && from && via === from.card) waitFor(id, from.card, from.key);
    pickCommand("");
  }

  $<HTMLSelectElement>("chat-command").onchange = (e) => pickCommand((e.target as HTMLSelectElement).value);
  $<HTMLButtonElement>("chat-send-text").onclick = () => {
    const input = $<HTMLInputElement>("chat-text");
    if (input.value.trim()) void sendRequest("", [], input.value, null);
    input.value = "";
  };

  /** What the development registry says of the grain: its server keys and who may use it. */
  async function readRegistry(): Promise<DevInfo> {
    const dev = await (await fetch("/api/dev")).json() as DevInfo;
    chain = dev.chain;
    servers = dev.servers;
    const a = dev.access;
    privateApp = a?.public === false;
    teamMember = a !== null && onTeam(a, myAccount());
    $("chat-access").textContent = a === null ? "" : a.public ? "Public app: anyone may use it." :
      `Private app: its owner and ${a.members.length} member(s)${a.members.some((m) => m.account === myAccount()) ? ", this account among them" : ""}.`;
    $<HTMLInputElement>("chat-private").checked = a?.public === false;
    $<HTMLInputElement>("chat-member").checked = a?.members.some((m) => m.account === myAccount()) ?? false;
    return dev;
  }

  async function open(certHex?: string, specHex?: string): Promise<void> {
    try {
      const dev = await readRegistry();
      const doc = specHex
        ? { spec: decodeChatDocument({ spec: specHex }).spec, cert: certHex ? decodeCert(certHex) : null, stats: null }
        : decodeChatDocument(await (await fetch("/.well-known/saltix-grain-chat")).json());
      if (!adopt(doc.spec, doc.cert, "the well-known document")) return;
      if (doc.stats) showStats(doc.stats, "the well-known document");
      if (!dev.relay) return note("The chat runs on a node's relays (CHAT_NODE): try it in a debug Saltix.", "bad");
      if (!registered) await connect(dev.relay);
      await sayHello();
    } catch (e) {
      note(`The chat did not load: ${(e as Error).message}`, "bad");
    }
  }

  /** Make the example private or public in the development registry, with this account a member or not. */
  async function setAccess(): Promise<void> {
    const open = !$<HTMLInputElement>("chat-private").checked;
    const members = $<HTMLInputElement>("chat-member").checked ? [myAccount()] : [];
    await fetch("/api/dev/access", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ public: open, members }) });
    await readRegistry();
    host.log(`chat: the development registry makes the app ${open ? "public" : `private, ${members.length ? "this account a member" : "this account not a member"}`}`);
    // Joined the team: the wallet introduces itself.
    await sayHello();
  }
  $<HTMLInputElement>("chat-private").onchange = () => void setAccess();
  $<HTMLInputElement>("chat-member").onchange = () => void setAccess();
  $<HTMLButtonElement>("chat-load").onclick = () => void open();
  return { open };
}

