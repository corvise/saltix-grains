// A managed account's key event log checked offline (Saltix 13-accounts §7), for whatever must know which keys speak for
// an account without taking a node's word for it: a Connect page's grant (19-connect §5 rule 5) and a site's Connect
// profile (19-connect §11.3, `checkProfileOwner`). From the origin the address commits to, the network's genesis hash
// and its first policy, every event is replayed against the controller the earlier ones made. The same rules as the
// node's `check_log`; a port of the explorer's `explorer/src/connect/keylog.ts`, held to the same vectors.
//
// Only what moves the controller is read in full: the sender, the account actions and the proof. Any other action of an
// event is a payment whose proof holds the root (it is an event only because the root moved), so it is passed over: the
// proof is found at the end of the event, where the root's signature over the transaction's id must verify. A registry
// call this SDK has never heard of therefore never breaks the check.
//
// Each event is replayed under the controller in force at it (23-upgrades §3): an account starts from its birth
// controller (its kind 0 key, or rule set 1 of its first root), and a `SetController` replaces it. A controller of a
// version this SDK does not know refuses the log as "a newer controller": keys not verified, never a broken account.
import { accountId } from "./address.js";
import { Reader, derive, fromHex, toHex } from "./bytes.js";
import { type DeviceKey, deviceKeyValid, ed25519KeyValid, readDeviceKey, sameDeviceKey, verifyByDeviceKey, verifyEd25519 } from "./keys.js";

const KEY_EVENT_DOMAIN = "Saltix key event v1";
const TX_DOMAIN = "Saltix transaction v3";
const ROOT_DIGEST_DOMAIN = "Saltix root digest v1";
const ROOT_USE_DOMAIN = "Saltix root use v1";
const MAX_DEVICES = 8;
const MIN_DELAY = 600n;
const MAX_DELAY = 2_592_000n;
const MAX_DISPUTE_TIMEOUT = 31_536_000n;
/** A transaction is at most this long (03-ledger §3). */
const MAX_LOG_TX = 16_384;
/** The action tag of an account action (13-accounts §6.2). */
const ACCOUNT_ACTION = 7;

export type DeviceKind = "phone" | "browser" | "service" | "guardian";
const KINDS: DeviceKind[] = ["phone", "browser", "service", "guardian"];

/** A device's daily limit, base units of SALT and µWORK. */
export interface DeviceLimit {
  salt: bigint;
  work: bigint;
}

/** A managed account's policy: seconds a protected action waits, and how long a dispute lasts (13-accounts §5). */
export interface AccountPolicy {
  delay: bigint;
  disputeTimeout: bigint;
}

export interface NewDevice {
  key: DeviceKey;
  kind: DeviceKind;
  limit: DeviceLimit;
}

export type AccountAction =
  | { kind: "add_device"; device: NewDevice }
  | { kind: "remove_device"; key: DeviceKey }
  | { kind: "set_limit"; key: DeviceKey; limit: DeviceLimit }
  | { kind: "replace_root"; rootDigest: Uint8Array }
  | { kind: "set_policy"; policy: AccountPolicy }
  | { kind: "cancel"; id: Uint8Array }
  | { kind: "set_controller"; expectedTip: Uint8Array; controller: ControllerInit };

/** What a `SetController` starts (23-upgrades §3): one case per controller version; rule set 1 is all there is. */
export interface ControllerInit {
  version: 1;
  rootDigest: Uint8Array;
  devices: NewDevice[];
  policy: AccountPolicy;
}

interface DeviceSignature {
  index: number;
  signature: Uint8Array;
}
interface RootUse {
  /** The root's signature scheme: 0, Ed25519, is the only one taken (23-upgrades §4). */
  scheme: number;
  publicKey: Uint8Array;
  nextDigest: Uint8Array;
  signature: Uint8Array;
}
type Proof =
  | { kind: "key"; signature: Uint8Array }
  | { kind: "device"; device: DeviceSignature }
  | { kind: "devices"; first: DeviceSignature; second: DeviceSignature }
  | { kind: "root"; root: RootUse }
  | { kind: "root_and_device"; root: RootUse; device: DeviceSignature };

type Sender = { kind: "key"; key: Uint8Array } | { kind: "account"; id: Uint8Array };

/** A signed transaction as an event carries it: its own bytes (for its id), the sender, an account action or none. */
interface EventTx {
  txBytes: Uint8Array;
  sender: Sender;
  action: AccountAction | null;
  proof: Proof;
}

/** One event: `txs` holds the ways its transaction may split into the transaction and the proof (see above). */
interface KeyEvent {
  account: Uint8Array;
  seq: number;
  prev: Uint8Array;
  slot: bigint;
  body: { kind: "signed"; txs: EventTx[] } | { kind: "matured"; id: Uint8Array };
  id: Uint8Array;
}

/** What a log is checked from: the first root's digest of a kind 5 address, or an upgraded kind 0 account's key. */
export type LogOrigin = { kind: "root"; digest: Uint8Array } | { kind: "key"; key: Uint8Array };

export interface LogDevice {
  key: DeviceKey;
  kind: DeviceKind;
  limit: DeviceLimit;
}

/** What a checked log proves: the controller after its last event. */
export interface CheckedLog {
  origin: LogOrigin;
  /** The version of the controller in force (23-upgrades §3). */
  controllerVersion: number;
  devices: LogDevice[];
  rootDigest: Uint8Array;
  policy: AccountPolicy;
  seq: number;
  tip: Uint8Array;
}

/** A log that does not check, at the event that does not. */
export class LogError extends Error {
  constructor(
    readonly seq: number,
    readonly reason: string,
  ) {
    super(`event ${seq}: ${reason}`);
    this.name = "LogError";
  }
}

const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export const rootDigest = (publicKey: Uint8Array): Uint8Array => derive(ROOT_DIGEST_DOMAIN, publicKey);
/** The account a log's origin starts: kind 5 of the root's digest, or kind 0 of the key. */
export const logOriginAccount = (o: LogOrigin): Uint8Array => (o.kind === "root" ? accountId(o.digest, 5) : accountId(o.key, 0));

/** A policy as `node_status.accounts.policy` gives it (seconds as numbers). */
export const policyOf = (p: { delay: number | bigint; dispute_timeout: number | bigint }): AccountPolicy => ({
  delay: BigInt(p.delay),
  disputeTimeout: BigInt(p.dispute_timeout),
});

// ── Reading ──────────────────────────────────────────────────────────────────

function readLimit(r: Reader): DeviceLimit {
  return { salt: r.u64(), work: r.u64() };
}
function readPolicy(r: Reader): AccountPolicy {
  return { delay: r.u64(), disputeTimeout: r.u64() };
}
function readKind(r: Reader): DeviceKind {
  const k = KINDS[r.u8()];
  if (!k) throw new TypeError("borsh: device kind");
  return k;
}
function readNewDevice(r: Reader): NewDevice {
  return { key: readDeviceKey(r), kind: readKind(r), limit: readLimit(r) };
}

export function readAccountAction(r: Reader): AccountAction {
  const tag = r.u8();
  switch (tag) {
    case 0:
      return { kind: "add_device", device: readNewDevice(r) };
    case 1:
      return { kind: "remove_device", key: readDeviceKey(r) };
    case 2:
      return { kind: "set_limit", key: readDeviceKey(r), limit: readLimit(r) };
    case 3:
      return { kind: "replace_root", rootDigest: r.fixed(32) };
    case 4:
      return { kind: "set_policy", policy: readPolicy(r) };
    case 5:
      return { kind: "cancel", id: r.fixed(32) };
    case 6:
      return { kind: "set_controller", expectedTip: r.fixed(32), controller: readControllerInit(r) };
    default:
      throw new TypeError(`borsh: account action ${tag}`);
  }
}

function readControllerInit(r: Reader): ControllerInit {
  const tag = r.u8();
  if (tag !== 0) throw new TypeError(`a newer controller (version ${tag + 1}): keys not verified, update the SDK`);
  const rootDigest = r.fixed(32);
  const n = r.u32();
  if (n > MAX_DEVICES) throw new TypeError("borsh: too many devices");
  const devices = Array.from({ length: n }, () => readNewDevice(r));
  return { version: 1, rootDigest, devices, policy: readPolicy(r) };
}

const readDeviceSignature = (r: Reader): DeviceSignature => ({ index: r.u8(), signature: r.fixed(64) });
const readRootUse = (r: Reader): RootUse => ({ scheme: r.u8(), publicKey: r.fixed(32), nextDigest: r.fixed(32), signature: r.fixed(64) });

function readProof(r: Reader): Proof {
  const tag = r.u8();
  switch (tag) {
    case 0:
      return { kind: "key", signature: r.fixed(64) };
    case 1:
      return { kind: "device", device: readDeviceSignature(r) };
    case 2:
      return { kind: "devices", first: readDeviceSignature(r), second: readDeviceSignature(r) };
    case 3:
      return { kind: "root", root: readRootUse(r) };
    case 4:
      return { kind: "root_and_device", root: readRootUse(r), device: readDeviceSignature(r) };
    default:
      throw new TypeError(`borsh: proof ${tag}`);
  }
}

/** The proofs that hold the root, by their length: where a payment's proof may start before the event's end. */
const ROOT_PROOFS: [number, number][] = [
  [3, 1 + 129],
  [4, 1 + 129 + 65],
];

function readSigned(r: Reader, bytes: Uint8Array): EventTx[] {
  const start = r.position;
  const senderTag = r.u8();
  let sender: Sender;
  if (senderTag === 0) sender = { kind: "key", key: r.fixed(32) };
  else if (senderTag === 1) sender = { kind: "account", id: r.fixed(32) };
  else throw new TypeError("borsh: sender");
  r.u64(); // nonce
  r.u64(); // fee
  r.u64(); // valid until slot
  const actionTag = r.u8();
  if (actionTag === ACCOUNT_ACTION) {
    const action = readAccountAction(r);
    const txBytes = r.since(start);
    const proof = readProof(r);
    r.end();
    return [{ txBytes, sender, action, proof }];
  }
  // A payment: its proof holds the root and ends the event.
  const out: EventTx[] = [];
  for (const [tag, length] of ROOT_PROOFS) {
    const at = bytes.length - length;
    if (at <= r.position - 1 || bytes[at] !== tag) continue;
    try {
      const proofReader = new Reader(bytes.slice(at));
      const proof = readProof(proofReader);
      proofReader.end();
      out.push({ txBytes: bytes.slice(start, at), sender, action: null, proof });
    } catch {
      /* not this split */
    }
  }
  if (out.length === 0) throw new TypeError("borsh: a payment without the root's proof");
  return out;
}

/** One event as `account_log` gives it (Borsh; hex in the node's answer). */
function decodeEvent(bytes: Uint8Array): KeyEvent {
  const r = new Reader(bytes);
  const account = r.fixed(32);
  const seq = r.u32();
  const prev = r.fixed(32);
  const slot = r.u64();
  const tag = r.u8();
  const id = derive(KEY_EVENT_DOMAIN, bytes);
  if (tag === 0) return { account, seq, prev, slot, body: { kind: "signed", txs: readSigned(r, bytes) }, id };
  if (tag === 1) {
    const matured = r.fixed(32);
    r.end();
    return { account, seq, prev, slot, body: { kind: "matured", id: matured }, id };
  }
  throw new TypeError(`borsh: event body ${tag}`);
}

/** The origin the first event shows: the sender's key of an upgrade, or the root a kind 5 address's first proof holds. */
function originOfEvents(events: KeyEvent[]): LogOrigin | null {
  const first = events[0];
  if (!first || first.body.kind !== "signed") return null;
  const tx = first.body.txs[0]!;
  if (tx.sender.kind === "key") return { kind: "key", key: tx.sender.key };
  const use = rootUseOf(tx.proof);
  return use ? { kind: "root", digest: rootDigest(use.publicKey) } : null;
}

const rootUseOf = (p: Proof): RootUse | null => (p.kind === "root" || p.kind === "root_and_device" ? p.root : null);

// ── The controller ───────────────────────────────────────────────────────────

const policyValid = (p: AccountPolicy): boolean =>
  p.delay >= MIN_DELAY && p.delay <= MAX_DELAY && p.disputeTimeout >= p.delay && p.disputeTimeout <= MAX_DISPUTE_TIMEOUT;
const within = (a: DeviceLimit, b: DeviceLimit): boolean => a.salt <= b.salt && a.work <= b.work;
const zero = (l: DeviceLimit): boolean => l.salt === 0n && l.work === 0n;

/** Refused by the controller; the replay names the event. */
class Refusal extends Error {}

function checkKindLimit(kind: DeviceKind, limit: DeviceLimit): void {
  if (kind === "guardian") throw new Refusal("a guardian cannot be added yet");
  if (kind === "browser" && !zero(limit)) throw new Refusal("a browser's limit is zero");
}

function checkNewDevice(d: NewDevice): void {
  if (!deviceKeyValid(d.key)) throw new Refusal("not a valid device key");
  checkKindLimit(d.kind, d.limit);
}

/** `AccountAction::check`: the rules that need no state. */
function checkAction(a: AccountAction): void {
  if (a.kind === "add_device") checkNewDevice(a.device);
  if (a.kind === "set_policy" && !policyValid(a.policy)) throw new Refusal("policy out of bounds");
  if (a.kind === "set_controller") {
    const init = a.controller;
    if (init.devices.length > MAX_DEVICES) throw new Refusal("too many devices");
    init.devices.forEach((d, i) => {
      checkNewDevice(d);
      if (init.devices.slice(0, i).some((e) => sameDeviceKey(e.key, d.key))) throw new Refusal("a device twice");
    });
    if (!policyValid(init.policy)) throw new Refusal("policy out of bounds");
  }
}

/** Rule set 1 as a `SetController` starts it: that root at index 0, those devices, that policy. */
const started = (init: ControllerInit): Controller =>
  new Controller(init.rootDigest, init.devices.map((d) => ({ key: d.key, kind: d.kind, limit: d.limit })), init.policy);

type Authority = { kind: "quorum" } | { kind: "root" } | { kind: "device"; key: DeviceKey };

class Controller {
  constructor(
    public rootDigest: Uint8Array,
    public devices: LogDevice[],
    public policy: AccountPolicy,
  ) {}

  device(key: DeviceKey): LogDevice | undefined {
    return this.devices.find((d) => sameDeviceKey(d.key, key));
  }

  private deviceSignature(s: DeviceSignature, id: Uint8Array): DeviceKey {
    const d = this.devices[s.index];
    if (!d) throw new Refusal(`no device ${s.index}`);
    if (d.kind === "guardian") throw new Refusal("a guardian proves nothing yet");
    if (!verifyByDeviceKey(d.key, id, toHex(s.signature))) throw new Refusal("a device's signature does not verify");
    return d.key;
  }

  private root(use: RootUse): void {
    if (use.scheme !== 0 || !equal(rootDigest(use.publicKey), this.rootDigest)) throw new Refusal("not the current root");
  }

  authorize(proof: Proof, id: Uint8Array): Authority {
    switch (proof.kind) {
      case "key":
        throw new Refusal("a key proof for a managed account");
      case "device":
        return { kind: "device", key: this.deviceSignature(proof.device, id) };
      case "devices":
        if (proof.first.index >= proof.second.index) throw new Refusal("device signatures out of order");
        this.deviceSignature(proof.first, id);
        this.deviceSignature(proof.second, id);
        return { kind: "quorum" };
      case "root":
        this.root(proof.root);
        return { kind: "root" };
      case "root_and_device":
        this.root(proof.root);
        this.deviceSignature(proof.device, id);
        return { kind: "quorum" };
    }
  }

  strengthens(a: AccountAction, by: Authority): boolean {
    switch (a.kind) {
      case "cancel":
        return true;
      case "remove_device":
        return by.kind === "device" && sameDeviceKey(by.key, a.key);
      case "set_limit": {
        const d = this.device(a.key);
        return !!d && within(a.limit, d.limit);
      }
      case "set_policy":
        return a.policy.delay >= this.policy.delay && a.policy.disputeTimeout >= this.policy.disputeTimeout;
      default:
        return false;
    }
  }

  check(a: AccountAction): void {
    checkAction(a);
    switch (a.kind) {
      case "add_device":
        if (this.devices.length >= MAX_DEVICES) throw new Refusal("too many devices");
        if (this.device(a.device.key)) throw new Refusal("the device is there already");
        return;
      case "remove_device":
        if (!this.device(a.key)) throw new Refusal("no such device");
        return;
      case "set_limit": {
        const d = this.device(a.key);
        if (!d) throw new Refusal("no such device");
        checkKindLimit(d.kind, a.limit);
        return;
      }
      case "cancel":
        // Offline a cancel never reaches here: it strengthens, and what it cancels simply never matures.
        throw new Refusal("no such pending action");
      default:
        return;
    }
  }

  apply(a: AccountAction): void {
    this.check(a);
    switch (a.kind) {
      case "add_device":
        this.devices.push({ key: a.device.key, kind: a.device.kind, limit: a.device.limit });
        return;
      case "remove_device":
        this.devices = this.devices.filter((d) => !sameDeviceKey(d.key, a.key));
        return;
      case "set_limit":
        this.device(a.key)!.limit = a.limit;
        return;
      case "replace_root":
        this.rootDigest = a.rootDigest;
        return;
      case "set_policy":
        this.policy = a.policy;
        return;
      default:
        return;
    }
  }
}

// ── The check ────────────────────────────────────────────────────────────────

function proofLength(p: Proof): number {
  return { key: 65, device: 66, devices: 131, root: 130, root_and_device: 195 }[p.kind];
}

/** The transaction's id, once its stateless proof rules hold (`check_stateless`'s signatures). */
function statelessId(tx: EventTx, genesis: Uint8Array): Uint8Array {
  if (tx.txBytes.length + proofLength(tx.proof) > MAX_LOG_TX) throw new Refusal("too large");
  const id = derive(TX_DOMAIN, genesis, tx.txBytes);
  if (tx.sender.kind === "key") {
    if (tx.proof.kind !== "key") throw new Refusal("proof kind");
    if (!ed25519KeyValid(tx.sender.key) || !verifyEd25519(tx.sender.key, id, tx.proof.signature)) throw new Refusal("signature");
  } else {
    if (tx.proof.kind === "key") throw new Refusal("proof kind");
    const use = rootUseOf(tx.proof);
    if (use) {
      if (use.scheme !== 0) throw new Refusal(`root scheme ${use.scheme} is not taken`);
      const message = derive(ROOT_USE_DOMAIN, id, use.nextDigest);
      if (!verifyEd25519(use.publicKey, message, use.signature) || equal(use.nextDigest, rootDigest(use.publicKey))) {
        throw new Refusal("the root's signature");
      }
    }
  }
  if (tx.action) {
    // A kind 0 key's birth controller takes only its replacement (23-upgrades §3).
    if (tx.sender.kind === "key" && tx.action.kind !== "set_controller") throw new Refusal("account sender");
    checkAction(tx.action);
  }
  return id;
}

/**
 * Check `account`'s log (events' Borsh as `account_log` hands them out, in order) offline from the origin its first event
 * shows, under the network's genesis hash and first `policy`: what it proves, or a `LogError`.
 */
export function checkLog(account: Uint8Array, eventsBytes: Uint8Array[], genesis: Uint8Array, policy: AccountPolicy): CheckedLog {
  let events: KeyEvent[];
  try {
    events = eventsBytes.map(decodeEvent);
  } catch (e) {
    throw new LogError(0, e instanceof Error ? e.message : String(e));
  }
  const origin = originOfEvents(events);
  if (!origin || !equal(logOriginAccount(origin), account)) throw new LogError(1, "does not start the account from its origin");
  let controller: Controller | null = null;
  let seq = 0;
  let tip: Uint8Array = new Uint8Array(32);
  let slot = 0n;
  const registered = new Map<string, AccountAction>();
  for (const event of events) {
    const n = seq + 1;
    const fail = (reason: string): never => {
      throw new LogError(n, reason);
    };
    if (!equal(event.account, account)) fail("names another account");
    if (event.seq !== n || !equal(event.prev, tip) || event.slot < slot) fail("out of order");
    try {
      if (event.body.kind === "matured") {
        const key = toHex(event.body.id);
        const action = registered.get(key);
        if (!action) fail("no pending account action of that transaction");
        registered.delete(key);
        if (!controller) fail("does not start the account from its origin");
        if (action!.kind === "set_controller") {
          // A new controller: what the old one's signers registered never matures.
          checkAction(action!);
          controller = started(action!.controller);
          registered.clear();
        } else {
          controller!.apply(action!);
        }
      } else {
        controller = replaySigned(controller, origin, event.body.txs, genesis, policy, registered, tip);
      }
    } catch (e) {
      if (e instanceof LogError) throw e;
      fail(e instanceof Error ? e.message : String(e));
    }
    seq = n;
    tip = event.id;
    slot = event.slot;
  }
  if (!controller) throw new LogError(0, "no events");
  return { origin, controllerVersion: 1, devices: controller.devices, rootDigest: controller.rootDigest, policy: controller.policy, seq, tip };
}

function replaySigned(
  current: Controller | null,
  origin: LogOrigin,
  txs: EventTx[],
  genesis: Uint8Array,
  policy: AccountPolicy,
  registered: Map<string, AccountAction>,
  tip: Uint8Array,
): Controller {
  // Of the ways the event splits, the one whose proofs hold under the controller: a wrong split never verifies.
  let last: unknown = null;
  for (const tx of txs) {
    const trial = current ? new Controller(current.rootDigest, current.devices.map((d) => ({ ...d })), current.policy) : null;
    const pending = new Map(registered);
    try {
      const next = replayOne(trial, origin, tx, genesis, policy, pending, tip);
      registered.clear();
      for (const [k, v] of pending) registered.set(k, v);
      return next;
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Refusal("no proof holds");
}

function replayOne(
  controller: Controller | null,
  origin: LogOrigin,
  tx: EventTx,
  genesis: Uint8Array,
  policy: AccountPolicy,
  registered: Map<string, AccountAction>,
  tip: Uint8Array,
): Controller {
  const id = statelessId(tx, genesis);
  const senderAccount = tx.sender.kind === "key" ? accountId(tx.sender.key, 0) : tx.sender.id;
  if (!equal(senderAccount, logOriginAccount(origin))) throw new Refusal("names another account");
  const action = tx.action;
  // A change of controller names the log's tip before it (zeros before the first event).
  if (action?.kind === "set_controller" && !equal(action.expectedTip, tip)) throw new Refusal("a stale log tip");
  const first = controller === null;
  if (first) {
    // A kind 0 key's birth controller: its only account action replaces it, at once.
    if (origin.kind === "key" && tx.sender.kind === "key" && action?.kind === "set_controller") return started(action.controller);
    if (origin.kind === "root" && tx.sender.kind === "account") controller = new Controller(origin.digest, [], policy);
    else throw new Refusal("does not start the account from its origin");
  }
  const c = controller!;
  if (tx.sender.kind !== "account") throw new Refusal("does not start the account from its origin");
  const proven = c.authorize(tx.proof, id);
  // The address's first transaction acts as a quorum's (13-accounts §6.1).
  const by: Authority = first ? { kind: "quorum" } : proven;
  const use = rootUseOf(tx.proof);
  if (use) c.rootDigest = use.nextDigest;
  if (!action) {
    if (!use) throw new Refusal("the transaction changes nothing the log records");
    return c;
  }
  if (by.kind === "quorum" || c.strengthens(action, by)) {
    if (action.kind === "set_controller") {
      registered.clear();
      return started(action.controller);
    }
    if (action.kind !== "cancel") c.apply(action);
  } else {
    c.check(action);
    registered.set(toHex(id), action);
  }
  return c;
}

/**
 * Whether `key` speaks for `account` now (13-accounts §5), by its key event log (`events`, each event's Borsh as
 * `account_log` gives it): with no events, it is the account's own Ed25519 key (its personal id is `account`); else the
 * log checks offline and the controller it replays lists `key` as a device, not a guardian. The kind 0 key of an account
 * that upgraded speaks for nothing. Returns why not (`not_the_account`, `upgraded`, `not_a_device`, `guardian`, `log`),
 * or null.
 */
export function keySpeaksFor(
  key: DeviceKey,
  account: Uint8Array,
  events: Uint8Array[],
  genesis: Uint8Array,
  policy: AccountPolicy,
): { problem: KeyProblem; log: CheckedLog | null; detail?: string } {
  const ownKey = "ed25519" in key && equal(accountId(fromHex(key.ed25519, 32), 0), account);
  if (events.length === 0) return { problem: ownKey ? null : "not_the_account", log: null };
  let log: CheckedLog;
  try {
    log = checkLog(account, events, genesis, policy);
  } catch (e) {
    return { problem: "log", log: null, detail: e instanceof Error ? e.message : String(e) };
  }
  return { problem: deviceProblem(key, ownKey, log), log };
}

/** Why a key does not speak for an account by its checked log's devices, or null. */
export function deviceProblem(key: DeviceKey, ownKey: boolean, log: Pick<CheckedLog, "devices">): KeyProblem {
  const device = log.devices.find((d) => sameDeviceKey(d.key, key));
  if (device?.kind === "guardian") return "guardian";
  if (device) return null;
  return ownKey ? "upgraded" : "not_a_device";
}

/** Why a key does not speak for an account (19-connect §5's reasons), or null when it does. */
export type KeyProblem = "not_the_account" | "upgraded" | "not_a_device" | "guardian" | "log" | null;
