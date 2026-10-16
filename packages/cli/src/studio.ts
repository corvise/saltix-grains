// The app studio's calls from the command line (Saltix 24-app-studio): a grain's server keys and category
// (`ConfigureGrain`), public or private with its members (`SetGrainAccess`), a rating (`RateGrain`), a username bound to
// it (`BindHandle`), and its developer keys. Signed with a key file on test networks; or done in the owner's Saltix (My
// apps), which the tool then waits for in the registry.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  type GrainCall, type Handle, type RegisteredGrain, type NodeLike, AppKey, CATEGORIES, accountId, categoryOf, decodeAddress, displayHandle,
  fromHex, grainCallProblem, grainGet, nodeCall, parseHandle, parseRoles, roleNames, toHex, serverKeyOk,
} from "@saltix/grain-server";
import { publicKeyOf, readKey } from "./project.js";
import { type Sent, type Signing, submit } from "./registry.js";

export const APP_KEY_FILE = "app.key";
/** Where tools read a developer key from when no file is named. */
export const APP_KEY_ENV = "SALTIX_APP_KEY";

const ownAccount = (secret: Uint8Array) => toHex(accountId(fromHex(publicKeyOf(secret), 32)));

/** A grain the key file's account owns and that is live: what the owner's calls need. */
async function ownGrain(node: NodeLike, slug: string, secret: Uint8Array): Promise<RegisteredGrain> {
  const g = await grainGet(node, slug);
  if (g === null) throw new Error(`${slug}: not registered`);
  if (g.owner !== ownAccount(secret)) throw new Error(`${slug}: registered by another owner (${g.owner})`);
  if (g.retired !== null) throw new Error(`${slug}: retired at slot ${g.retired}`);
  if (g.servers === undefined) throw new Error("the node predates the app studio (24-app-studio): it shows no server keys");
  return g;
}

function checked(call: GrainCall, sender?: string): GrainCall {
  const problem = grainCallProblem(call, sender);
  if (problem) throw new Error(problem);
  return call;
}

/** A server key given as its hex, or as a key file (`grain cert init`'s `server.key`) whose public key it is. */
export function serverKeyOf(text: string): string {
  if (/^[0-9a-f]{64}$/i.test(text) && !existsSync(text)) {
    const key = text.toLowerCase();
    if (!serverKeyOk(key)) throw new Error(`--server ${text}: not a valid Ed25519 public key`);
    return key;
  }
  return publicKeyOf(readKey(text));
}

/** The call that names `servers` and `category` for `slug`. Without a category the registry's stays. */
export async function configureCall(node: NodeLike, slug: string, servers: string[], category: string | undefined, owner?: Uint8Array): Promise<GrainCall> {
  const g = owner ? await ownGrain(node, slug, owner) : await grainGet(node, slug);
  if (g === null) throw new Error(`${slug}: not registered`);
  const c = category === undefined ? g.category ?? 0 : categoryOf(category);
  if (c === null) throw new Error(`--category ${category}: 0 to 9, or ${CATEGORIES.join(", ")}`);
  return checked({ configure: { slug, servers, category: c } });
}

/** Members from `<address or account hex>:<roles>`. */
export function membersOf(texts: string[]): Array<{ account: string; roles: number }> {
  return texts.map((text) => {
    const at = text.lastIndexOf(":");
    if (at < 0) throw new Error(`--member ${text}: <address>:<roles>`);
    const who = text.slice(0, at);
    const roles = parseRoles(text.slice(at + 1));
    if (roles === null) throw new Error(`--member ${text}: roles 1–7, or user, developer, viewer joined by +`);
    const decoded = decodeAddress(who);
    const account = decoded ? toHex(decoded.id) : /^[0-9a-f]{64}$/.test(who) ? who : null;
    if (account === null) throw new Error(`--member ${text}: an address or an account id in hex`);
    return { account, roles };
  });
}

/** The call that makes `slug` public or private with `members`, the key file's account its owner. */
export async function accessCall(node: NodeLike, slug: string, open: boolean, members: Array<{ account: string; roles: number }>, owner?: Uint8Array): Promise<GrainCall> {
  const g = owner ? await ownGrain(node, slug, owner) : await grainGet(node, slug);
  if (g === null) throw new Error(`${slug}: not registered`);
  return checked({ access: { slug, public: open, members } }, g.owner);
}

/** The call that rates `slug` (1–5, or 0 to withdraw) by the key file's account, which is not its owner. */
export async function rateCall(node: NodeLike, slug: string, score: number, review: string, rater: Uint8Array): Promise<GrainCall> {
  const g = await grainGet(node, slug);
  if (g === null) throw new Error(`${slug}: not registered`);
  if (g.owner === ownAccount(rater)) throw new Error(`${slug}: an owner does not rate its own grain`);
  if (g.retired !== null && score !== 0) throw new Error(`${slug}: retired; a rating can only be withdrawn (--score 0)`);
  return checked({ rate: { slug, score, review } });
}

interface HandleRecord { owner: string; app: string | null; display: string }

/** What the registry holds for a handle: its owner and the app it opens. */
export async function handleGet(node: NodeLike, handle: Handle): Promise<HandleRecord | null> {
  return (await nodeCall<{ handle: HandleRecord | null }>(node, "handle_get", handle)).handle;
}

/** The call that points `handle` at `slug` (the key file's account holds both), or clears it with null. */
export async function bindCall(node: NodeLike, typed: string, slug: string | null, holder: Uint8Array): Promise<GrainCall> {
  const handle = parseHandle(typed);
  if (handle === null) throw new Error(`${typed}: not a name (@anna) or a number (+0 777 1234)`);
  const record = await handleGet(node, handle);
  const mine = ownAccount(holder);
  if (record === null || record.owner !== mine) throw new Error(`${displayHandle(handle)}: not this account's`);
  if (slug === null && record.app === null) throw new Error(`${displayHandle(handle)}: opens no app`);
  if (slug !== null) await ownGrain(node, slug, holder);
  return checked({ bind: { handle, slug } });
}

/** Sign `call` with the key file and send it; with `waitMs`, until the registry holds what it makes (a rating is not
 *  watched). */
export async function sendCall(call: GrainCall, secret: Uint8Array, s: Signing, waitMs = 0): Promise<{ sent: Sent; landed: boolean | null }> {
  const sent = await submit(call, secret, s);
  if (waitMs <= 0 || "rate" in call) return { sent, landed: null };
  return { sent, landed: await waitForRegistry(s.node, call, waitMs) };
}

/** Whether the registry's record of `slug` is what `call` makes it. */
export async function holds(node: NodeLike, call: GrainCall): Promise<boolean> {
  if ("configure" in call) {
    const g = await grainGet(node, call.configure.slug);
    return g !== null && JSON.stringify(g.servers ?? []) === JSON.stringify(call.configure.servers) && g.category === call.configure.category;
  }
  if ("access" in call) {
    const g = await grainGet(node, call.access.slug);
    const sorted = (m: Array<{ account: string; roles: number }>) => JSON.stringify([...m].sort((a, b) => a.account.localeCompare(b.account)));
    return g !== null && g.public === call.access.public && sorted(g.members ?? []) === sorted(call.access.members);
  }
  if ("bind" in call) {
    const h = await handleGet(node, call.bind.handle);
    return h !== null && h.app === call.bind.slug;
  }
  return false;
}

/** Wait until the registry holds what `call` makes it, at most `ms`: the transaction landed, or the owner did it in
 *  Saltix. */
export async function waitForRegistry(node: NodeLike, call: GrainCall, ms: number, every = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await holds(node, call)) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, every));
  }
}

/** What the owner does in Saltix for `call`, in words. */
export function inSaltix(call: GrainCall): string {
  if ("configure" in call) {
    const c = call.configure;
    const keys = c.servers.length === 0 ? "revoke every developer key" : `name the server keys ${c.servers.map((k) => k.slice(0, 16) + "…").join(", ")}`;
    return `In the owner's Saltix: My apps → ${c.slug} → Developer key: ${keys}; category ${CATEGORIES[c.category]}.`;
  }
  if ("access" in call) {
    const a = call.access;
    const members = a.members.map((m) => `${m.account.slice(0, 16)}… (${roleNames(m.roles).join("+")})`).join(", ") || "none";
    return `In the owner's Saltix: My apps → ${a.slug} → ${a.public ? "make it public" : "make it private"}; members: ${members}.`;
  }
  if ("bind" in call) {
    const b = call.bind;
    return `In the holder's Saltix: ${displayHandle(b.handle)} → ${b.slug === null ? "open no app" : `open the app ${b.slug}`}.`;
  }
  if ("rate" in call) return `In Saltix: Marketplace → ${call.rate.slug} → Rate.`;
  return "In the owner's Saltix: My apps.";
}

/** A developer key from `file`, or the environment's `SALTIX_APP_KEY`, or `stdin` text; never from the command line,
 *  where it would stay in the shell's history. */
export function readAppKey(file: string | undefined, env: NodeJS.ProcessEnv = process.env, stdin?: string): AppKey {
  const fromEnv = env[APP_KEY_ENV]?.trim() ? env[APP_KEY_ENV] : undefined;
  const text = file !== undefined ? readFileSync(file, "utf8") : fromEnv ?? stdin;
  if (text === undefined || text.trim() === "") {
    throw new Error(`no developer key: set ${APP_KEY_ENV}, pass --file, or pipe it in (never type it as an argument: shells keep their history)`);
  }
  return AppKey.parse(text);
}

/** What a developer key says, and what the registry says of it: the public parts only. */
export async function describeAppKey(key: AppKey, node: NodeLike | null): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...key.describe() };
  if (!node) return out;
  const status = await nodeCall<{ network: string; genesis: string }>(node, "node_status");
  out.network_answering = `${status.network} ${status.genesis.slice(0, 16)}`;
  if (!key.isFor(status.network, status.genesis)) {
    out.registered = false;
    out.why = "the network answering is another: was it reset? Make a new developer key in Saltix";
    return out;
  }
  const grain = await grainGet(node, key.slug);
  const servers = grain?.servers ?? [];
  out.registered = grain !== null && grain.retired === null && servers.includes(key.publicKey);
  if (grain === null) out.why = "no such grain in the registry";
  else if (grain.retired !== null) out.why = "the grain is retired";
  else if (!servers.includes(key.publicKey)) out.why = servers.length === 0 ? "the owner revoked the grain's keys" : "the owner replaced this key";
  else if (servers[0] !== key.publicKey) out.note = "wallets write to the first key the registry names: requests go to that key's server";
  if (grain) out.access = grain.public === false ? `private, ${grain.members?.length ?? 0} members` : "public";
  return out;
}

/** Write a developer key to an owner-only file, never to the terminal: for a server key file and a network, as Saltix
 *  makes one. */
export function writeAppKey(path: string, key: AppKey): void {
  if (existsSync(path)) throw new Error(`${path} exists already`);
  writeFileSync(path, key.reveal() + "\n", { mode: 0o600 });
}
