#!/usr/bin/env node
// The grain command line (Saltix 12-grains §10).
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AppKey, isChatOnly, verifyManifest, grainGet, grainQuote, parseHandle, nodeCall, checkGrainProfile, profileText, type GrainCall, type Manifest,
} from "@saltix/grain-server";
import { MANIFEST_FILE, KEY_FILE, readManifest, readKey, newKey, lint, signedFor, publicKeyOf, ownerOf } from "./project.js";
import QRCode from "qrcode";
import { retireCall, show, salt, type Sent, type Signing } from "./registry.js";
import { type Signer, addressOf, ownerLine, signerFor } from "./owner.js";
import { SETTLE_MS, sendSettled } from "./send.js";
import { LANDS_IN, type WaitOut, Waiting, rewriteLine } from "./wait.js";
import {
  APP_KEY_ENV, APP_KEY_FILE, accessCall, bindCall, configureCall, describeAppKey, handleGet, inSaltix, membersOf, profileHeld, rateCall, readAppKey,
  serverKeyOf, unchanged, unchangedWords, waitForRegistry, writeAppKey,
} from "./studio.js";
import { type Reach, reachOf } from "./network.js";
import { grantAddress, granted, requestGrant, saltOf, waitForSalt } from "./faucet.js";
import { serve, linkFor, simulatorFor } from "./dev.js";
import { runCheck } from "./check.js";
import { lintPages } from "./pages.js";
import { SPONSOR_KEY_FILE, channel, parseWork, sponsorStatus } from "./sponsor.js";
import { CONNECT_FILE, lintConnect, lintIcon, lintPermissionsUse, placeholderLinks, readConnectFile, templateTexts } from "./connect.js";
import { clearCall, profileCall, profileLinkFor, servedSiteRevision, siteProfile, waitForProfile, wellKnownOf } from "./profile.js";
import { makeBundle, sealed } from "./bundle.js";
import * as template from "./template.js";
import * as chatTemplate from "./chat-template.js";
import { CERT_FILE, CHAT_DOCUMENT_FILE, CHAT_SPEC_FILE, SERVER_KEY_FILE, issueCert, lintChatSpec, readCert, readChatSpec, signedChatDocument } from "./chat.js";
import { UsageError, helpFor, parse } from "./args.js";
import { DevLog, endOnSignals, reasonOf } from "./devlog.js";
import { pair } from "./pair.js";
import { DOCTOR_EXIT, doctor, keyState, settled } from "./status.js";
import {
  type SentRecord, accessDecided, forgetSent, placeholderHosted, publishApp, readPublishState, readiness, recordOf, recordSent,
} from "./publish-flow.js";
import { type Fit, IconError, parseColour, runIcon } from "./icon.js";

const HELP = `grain — make, serve, check, sign, register and retire grains (Saltix 12-grains)

  grain help [command]                     this, or one command's part of it (also: grain <command> --help)
  grain init [dir] [--slug S] [--name N] [--chat | --sign-in]
                                           a new grain: grain.json (its page sealed), connect.json (rewrite it for
                                           the app), owner.key, public/ (a page that works on its own; --sign-in a
                                           page for some people only, which checks first and renders after); --chat
                                           a chat-only one (no page: grain.json, connect.json and chat.json); each
                                           with a package.json whose npm install links the grain command
  grain dev [--port 8090] [--app-key F] [--check [--tap]]
                                           serve public/ with the manifest signed for this computer until Ctrl-C
                                           (a coding agent: in the background, or --check), and the
                                           simulator: your page framed as Saltix frames it, with the wallet's
                                           controls, at the Galaxy Z Fold's 475x751, 704x932 and 932x704, held
                                           to Saltix's rules; a development registry (the team, members) at
                                           /api/dev/rpc for your server, of the developer key's network and
                                           naming its key with --app-key (or SALTIX_APP_KEY). --check drives the
                                           simulator in headless Chrome (Chrome, Chromium or Edge here, or
                                           CHROME_PATH) and exits: the Connect sheet, the page loading without
                                           errors, and at every size in both themes nothing tappable under the
                                           wallet's controls and no sideways scroll; --tap then taps each button
                                           once, and those a tap brings up (at most 30 in all, never a link: an
                                           exception or a request Saltix refuses is an error, a tap that changes
                                           nothing a warning; the page never leaves, and no payment is made);
                                           screenshots and report.json in
                                           .grain/check/; exit 1 when something is wrong
  grain lint [--manifest grain.json]       what stops the manifest and connect.json (the Connect profile) from
                                           being registered, the icon file, and warnings: public/ (a top bar under
                                           the wallet's controls), placeholders, permissions nothing uses; and
                                           its last line, where the last grain publish left it and what is left
                                           (public/ changed since v1: grain publish seals v2; connect.json still
                                           grain init's words), in grain doctor's words
  grain icon <picture> --out icon.png [--fit crop|contain|mark] [--background #rrggbb] [--preview F]
                                           a 512x512 icon to Saltix's standard from any PNG or JPEG: opaque, sRGB,
                                           no metadata, at most 64 KiB (a palette when that is what fits); crop
                                           covers the square, contain shows it whole, mark fits a logo inside the
                                           keyline circle (the default for a picture with transparency); written
                                           to the project's icon.png, grain.json's "icon" names it. Prints its
                                           hash first, the checks, and a preview (.grain/icon-preview.png: the
                                           rounded-square mask at 24, 40, 56 and 96 dp, dark and light)
  grain icon --monogram L [--background #rrggbb] [--out icon.png]
                                           an icon to the same standard with no picture: one or two letters or
                                           digits (A-Z, 0-9) drawn bold inside the keyline circle on a colour
                                           (--background, else one the slug picks), the ink white or dark by
                                           contrast; written to icon.png unless --out, and named in grain.json
  grain icon <icon.png>                    check an icon as wallets do and print its hash; 256x256 is taken with
                                           a warning (also: grain icon --fix <picture> <icon.png>)
  grain sign [--out signed.json]           the signed manifest, for /.well-known/saltix-grain (a page at your own
                                           https origin; grain init's placeholder origin is refused)
  grain bundle [--sources URL[,URL]] [--start index.html] [--connect O[,O]] [--out bundle.zip] [--dir .]
                                           seal public/ into one ZIP; grain.json names its hash and size (grain
                                           publish does this itself; --sources only for hosts of your own)
  grain publish [--key F | --wallet] [--no-wait] [--app-key F] [--hosted] [--out signed.json]
                                           publish the app or a new version straight into the Saltix network, no
                                           hosting: a page's public/ is sealed into a bundle, checked and put
                                           into the network (resumed after a break; with grain pair's app.key
                                           before the owner signs), the account that will own the app said, then
                                           signed in the owner's Saltix by a QR code; a key file signs only when
                                           --key names it (the test network without a phone: a new app it
                                           registers is made private in the same breath) or by itself for an app
                                           it registered; it waits for the chain (about 2-4 minutes, up to 6;
                                           --no-wait returns once the pool took it). Once the registry holds it,
                                           its icon goes up, and it says who can open the app. Run again, it
                                           finishes what is left, never sending a transaction twice; with nothing
                                           changed it says so and sends nothing (the version is raised only when
                                           grain.json or public/ changed). --hosted: a page at your own https
                                           origin instead. The deposit is the node's quote for the slug's length:
                                           100 SALT for 3-5 characters, 30 for 6-7, 10 for 8+
  grain retire --slug S                    close the slug for good; the deposit returns 30 days later
  grain show --slug S [--out F] [--json]   what the registry holds for a slug, in words (its Connect profile
                                           checked), or for a free slug the deposit registering it keeps; --json
                                           the whole record and nothing else; F gets the manifest
  grain profile [--profile connect.json] [--key F | --wallet] [--no-wait] [--clear]
                                           set the grain's Connect profile, what Saltix shows before anyone signs
                                           in: a QR code for the owner's Saltix, or the key file that owns the app
                                           (revision: the registry's + 1); grain init's own words are refused;
                                           --clear removes it
  grain connect-profile --origin URL --name N --category C --key site.key [--profile F] [--revision N] [--out F]
                        [--offline]        a website's Connect profile signed by its operator's key file (or a
                                           device's of the account --owner names), written where the site serves
                                           it (--out .well-known/saltix-connect); its revision goes above the one
                                           the site serves now and the file before (--offline: the file only)
  grain chat-spec [--spec chat.json] [--cert cert.json] [--out chat.signed.json]
                                           lint the chat spec and sign it with the owner key: the document to serve
                                           at /.well-known/saltix-grain-chat ({spec, cert} with --cert)
  grain cert init                          a server key (server.key): it signs the chat's messages, invoices and
                                           notifications on your server
  grain cert [--server server.key | --server-key HEX] [--days 30] [--out cert.json]
                                           the owner key certifies the server key for the grain (31 days at most
                                           for chats: issue a new one before it ends)
  grain configure --slug S --server KEY [--server KEY…] [--category C]
                                           name the grain's server keys (hex, or a key file such as server.key; at
                                           most 4) and its category: both replace the registry's. --revoke-all
                                           names none: every developer key stops at once
  grain access --slug S --public|--private [--member ADDRESS:ROLES…]
                                           who may use the grain: anyone, or its owner and members (roles user,
                                           developer, viewer joined by +; at most 64); both replace the registry's
  grain rate --slug S --score 1-5 [--review TEXT] --key rater.key
                                           rate someone else's grain (0 withdraws your rating); public, by account
  grain bind --handle @name --slug S       (or --clear) point a username you hold at your grain: @name opens
                                           its chat
  grain pair [--slug S] [--name N] [--new] [--no-wait] [--timeout 600]
                                           pair this computer's server with its app in the owner's Saltix by a QR
                                           code: the key is made here and never leaves it (.grain/pair.key, then
                                           app.key, owner-only, and app.json); it answers the phone, waits until the
                                           registry names the key and writes them. The slug is grain.json's unless
                                           --slug; --name names a new app; --new pairs a new key (to rotate it);
                                           --no-wait shows the offer and returns
  grain status [--json]                    whether this project's server is paired with its app (paired, pairing,
                                           unpaired, revoked, replaced, retired, unregistered, other_network; a
                                           page alone: not_needed) and the command to run next; exit 0 when paired
                                           or not_needed
  grain doctor [--json]                    the project's state and the exact next step: the key, .gitignore, the
                                           chat spec, dependencies, a page's bundle and where its publish stands
                                           (not_uploaded, pending, waiting_for_owner, pending_expired, published:
                                           the registry names it and the network holds its bundle; before the
                                           first, the deposit, the fees and the way to it), a transaction a key
                                           file here sent (publish, access, profile) until it landed, what the
                                           registry holds, who opens the app, the icon, the Connect profile
                                           (connect.json before the app is registered). Exit 0: nothing left to
                                           do; 1: something to do (next: says what); 75: nothing to do but wait
                                           for the network (a transaction on its way: ask again in a minute)
  Every command run in an app's project logs its steps to .grain/log.jsonl: codes and timings, never a key, an
    address or anything typed (SALTIX_GRAIN_LOG=off turns it off).
  grain app-key [--file F] [--offline]     a developer key's public parts (from SALTIX_APP_KEY, --file or stdin),
                                           and whether its network's registry names it; never the secret
  grain app-key make --slug S [--server server.key] [--out app.key]
                                           a developer key for a server key file, written owner-only (test networks)
  The owner's calls (publish, profile, configure, access, bind) are signed in the owner's Saltix by default: a QR
    code, or the tool says what to do in Saltix (My apps) and waits for the registry (--timeout seconds, 600). A key
    file signs only when --key names it, or for an app (a username) whose owner the registry names as that key file's
    account; --wallet always asks Saltix. The account that owns what the call makes is said before anything is signed.
    A call that would change nothing the registry holds says "nothing to change" and sends nothing (exit 0).
    A call signed with a key file returns once it landed and the registry holds it (about 1.5 to 2.5 minutes on the
    test network, saying what it waits for meanwhile; it gives up after 6), so the next one is built above it: its
    nonce, a profile's revision; one the pool refuses for the account's earlier call still pending is built again once
    that landed. --no-wait returns once the pool took it: a coding agent runs these in the background, with a timeout
    of 10 minutes or more, or with --no-wait and then grain doctor until it says the call landed.

  grain sponsor init                       a sponsor key (sponsor.key): its account pays relays for your users
  grain sponsor                            the sponsor's account, WORK, channels and the exchanges to open one with
  grain sponsor open --exchange C --amount W   a channel with city C's exchange, W WORK deposited
  grain sponsor top-up --exchange C --amount W
  grain sponsor close --exchange C         the deposit returns after the claim window

  grain faucet [--key owner.key | --address A] [--wait]
                                           test SALT (and WORK while it lasts) for the key file's account or an
                                           address, from the test network's faucet: once every 5 minutes; --wait
                                           until it is in the account (--timeout seconds, 120)

  --manifest F   the manifest (grain.json); --key F   a key file (owner.key): the owner's calls only when named
  --network N    whose public relays a registry command goes through: devnet, Saltix's test network (the default)
  --relay URL#H  or a relay you name, pinned by its certificate's SHA-256 H (wss://host:30335/#…; repeat it)
  --node URL     or your own node's wallet interface (plain HTTP: a local node or a tunnel)
  --genesis H    refuse a node of another network; --fee N   base units of SALT; --valid-for N   slots (600)
  A flag's value is the word after it, or comes after = in the same word; a flag a command does not take is refused.
  grain --version says which version of the tool this is.
`;

function text(flags: Map<string, string | true>, name: string, fallback?: string): string {
  const v = flags.get(name);
  if (typeof v === "string") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is needed`);
}

function signing(flags: Map<string, string | true>, reach: Reach): Signing {
  const fee = flags.get("fee");
  return {
    node: reach.node,
    genesis: typeof flags.get("genesis") === "string" ? (flags.get("genesis") as string) : undefined,
    fee: typeof fee === "string" ? BigInt(fee) : undefined,
    validFor: Number(text(flags, "valid-for", "600")),
  };
}

/** Who signs an owner's call about `what` (an app, or a username), whose owner the registry names (`owner`): a key file
 *  only when --key names it or it is that owner's, else the owner's Saltix (`signerFor`); said before anything is
 *  signed. With the network that answers. */
async function ownerSigner(what: string, owner: string | null, keyPath: string, flags: Map<string, string | true>, reach: Reach, log: DevLog): Promise<Signer & { network: string; genesis: string }> {
  if (owner === null) throw new Error(`${what}: not registered yet (grain publish registers an app; grain show --slug S says what the registry holds)`);
  const signer = signerFor({ wallet: flags.get("wallet") === true, keyPath, named: flags.has("key"), owner, what });
  const { network, genesis } = await nodeCall<{ network: string; genesis: string }>(reach.node, "node_status");
  log.onNetwork(network);
  log.step("signer", "ok", signer.by === "key" ? `key_${signer.why}` : `wallet_${signer.why}`);
  console.log(ownerLine(signer, network, owner, keyPath));
  return { ...signer, network, genesis };
}

/** A call that would change nothing: said, and nothing signed or sent (exit 0). */
class NothingToChange extends Error {}

/** What the project keeps of an owner's call a key file here sends (`.grain/publish.json`), so that `grain doctor` says
 *  where it stands until it landed: for the project's own app only. */
interface Keep {
  record: (sent: Sent) => void;
  forget: (sent: Sent) => void;
}

/** `keep` for a call about `slug` when it is the project's own app (grain.json's slug here), else none. */
function keepFor(slug: string, manifestPath: string, where: { network: string; genesis: string }, makes: (sent: Sent) => Pick<SentRecord, "access" | "revision">,
  then?: (record: SentRecord) => void): Keep | undefined {
  let own: string | null = null;
  try {
    own = existsSync(manifestPath) ? readManifest(manifestPath).manifest.slug : null;
  } catch {
    own = null;
  }
  if (own !== slug) return undefined;
  const dir = dirname(resolve(manifestPath));
  return {
    record: (sent) => {
      const record = recordOf(sent, 0, Date.now(), makes(sent));
      recordSent(dir, { ...where, slug }, record);
      then?.(record);
    },
    forget: (sent) => forgetSent(dir, sent.id),
  };
}

/** Where a command's waits are said: one line rewritten in place on a terminal, a line every 15 seconds elsewhere. */
const waitOut = (): WaitOut => ({ tty: process.stdout.isTTY === true, print: (line) => console.log(line), progress: rewriteLine((text) => process.stdout.write(text)) });

/** The owner's call that `build` makes from what the registry holds, by `signer`: signed with its key file (one call of
 *  the account at a time, `sendSettled`), or done in the owner's Saltix and waited for. Either way the steps' log gets
 *  where it ended (`registry`). */
async function ownerCall(signer: Signer, build: (secret?: Uint8Array) => Promise<GrainCall>, flags: Map<string, string | true>, reach: Reach, log: DevLog,
  keep?: Keep): Promise<number> {
  // What the registry holds already is never signed again: nothing to change, nothing sent (as grain publish).
  const said = (call: GrainCall) => {
    log.step("registry", "ok", "unchanged");
    console.log(`nothing to change: ${unchangedWords(call)}; nothing signed or sent`);
    return 0;
  };
  if (signer.by === "wallet") {
    const call = await build();
    if (await unchanged(reach.node, call)) return said(call);
    console.log(inSaltix(call));
    const limit = Number(text(flags, "timeout", "600")) * 1000;
    const w = new Waiting(waitOut(), "waiting for the owner's Saltix, then the registry", limit);
    const ok = await waitForRegistry(reach.node, call, limit, 3000, () => w.at("not in the registry yet"));
    w.done();
    log.step("registry", ok ? "ok" : "timeout", ok ? "set" : "not_signed");
    console.log(ok ? "the registry has it" : "not in the registry yet: check with grain show");
    return ok ? 0 : 1;
  }
  // Built again whenever the pool refuses it for an earlier call of the account: by then that call may have made it.
  const fresh = async () => {
    const call = await build(signer.secret);
    if (await unchanged(reach.node, call)) throw new NothingToChange(unchangedWords(call));
    return call;
  };
  try {
    return await keyCall(fresh, signer.secret, flags, reach, (sent) => `${sent.call}: transaction ${sent.id} (fee ${salt(sent.fee)} SALT)`, log, keep);
  } catch (e) {
    if (!(e instanceof NothingToChange)) throw e;
    log.step("registry", "ok", "unchanged");
    console.log(`nothing to change: ${e.message}; nothing signed or sent`);
    return 0;
  }
}

/**
 * Send the call `build` makes, signed with `secret`, and wait until it landed (unless `--no-wait`): a command returns
 * once the registry holds what it made, so the next one is built above it (its nonce, a profile's revision). `said`
 * names the transaction once the pool took it; the wait is said as it goes, and logged as `registry`.
 */
async function keyCall(build: () => Promise<GrainCall>, secret: Uint8Array, flags: Map<string, string | true>, reach: Reach, said: (s: Sent) => string, log: DevLog,
  keep?: Keep): Promise<number> {
  const wait = flags.get("no-wait") !== true;
  // Who says when it landed: grain doctor for a call the project keeps, grain show for any other.
  const ask = keep ? `grain doctor${reach.flags}` : "grain show";
  let w: Waiting | null = null;
  // One deadline for the whole wait, an earlier call of the account's included: each line says how long is left of it.
  const end = Date.now() + SETTLE_MS;
  const { sent, landed } = await sendSettled(build, secret, signing(flags, reach), {
    wait, end,
    onSent: (s) => {
      (w as Waiting | null)?.done();
      console.log(said(s));
      // Kept before the wait: a run cut short (Ctrl-C, a tool's timeout) leaves grain doctor something to follow.
      keep?.record(s);
      if (wait) console.log(`Waiting for it to land: ${LANDS_IN} (Ctrl-C stops waiting; the transaction stays sent, and ${ask} says when it landed)`);
      w = new Waiting(waitOut(), s.call, end - Date.now());
    },
    // Before the pool took it: the account's earlier call still pending.
    onWait: (stage) => (w ??= new Waiting(waitOut(), "waiting", end - Date.now())).at(stage),
  });
  (w as Waiting | null)?.done();
  if (!wait) {
    log.step("registry", "waiting", "no_wait");
    console.log(`sent: it lands in the registry in a few minutes (${LANDS_IN}); ${ask} says when it has landed`);
  } else if (landed === null) {
    log.step("registry", "waiting", "unknown");
    console.log(`the node cannot say where the transaction is: ${ask} says when the registry has it`);
  } else {
    log.step("registry", landed ? "ok" : "timeout", landed ? "set" : "not_landed");
    if (landed) keep?.forget(sent);
    console.log(landed ? "the registry has it" : `not in the registry yet: ${ask} says when it is`);
  }
  return landed === false ? 1 : 0;
}

/** `grain icon`'s run: a picture it cannot make an icon of is refused in the steps' log by its reason, then said. */
function iconRun(run: () => number, log: DevLog): number {
  try {
    return run();
  } catch (e) {
    if (e instanceof IconError) log.step("icon", "refused", e.reason);
    throw e;
  }
}

/** All of stdin, when it is piped in. */
async function stdinText(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv: string[], log: DevLog): Promise<number> {
  const { command, topic, positional, flags, all } = parse(argv);
  const manifestPath = text(flags, "manifest", MANIFEST_FILE);
  /** Where the command reaches the network: the public relays by default, --relay, or --node. */
  const reach = () => reachOf(flags, all);
  const keyPath = text(flags, "key", KEY_FILE);
  switch (command) {
    case "init": {
      const dir = resolve(positional[0] ?? ".");
      const slug = text(flags, "slug", basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 32));
      const name = text(flags, "name", slug);
      if (!/^[a-z0-9][a-z0-9-]{2,31}$/.test(slug)) {
        throw new Error(`the slug "${slug}" is not one: 3 to 32 of [a-z0-9-], starting with a letter or a digit` +
          (flags.has("slug") ? "" : ` (it comes from the directory's name: pass --slug)`));
      }
      if (existsSync(join(dir, MANIFEST_FILE))) throw new Error(`${join(dir, MANIFEST_FILE)} exists already`);
      const chat = flags.get("chat") === true;
      const signIn = flags.get("sign-in") === true;
      if (chat && signIn) throw new UsageError("--chat or --sign-in: a chat-only app has no page to sign in to");
      mkdirSync(chat ? dir : join(dir, "public"), { recursive: true });
      log.at(dir);
      const ownerKey = newKey(join(dir, KEY_FILE));
      const manifest: Manifest = {
        slug, version: 1, ...ownerOf(ownerKey), name: { en: name }, description: { en: "" }, icon: "00".repeat(32),
        entry: { chat: {} }, permissions: chat ? 4 : 1, sponsor: null, min_host: 1,
      };
      if (!manifest.description.en) delete (manifest.description as Record<string, string>).en;
      // Every app ships a Connect profile: what Saltix shows before anyone signs in (19-connect §11).
      writeFileSync(join(dir, CONNECT_FILE), template.connectJson(slug, name, chat));
      writeFileSync(join(dir, ".gitignore"), template.gitignore);
      // The rules a coding agent follows (an app's page: safe by default, full screen with viewport-fit=cover), for every
      // agent and for Claude Code.
      writeFileSync(join(dir, "AGENTS.md"), template.agentsMd(slug, chat));
      writeFileSync(join(dir, "CLAUDE.md"), template.claudeMd);
      if (chat) {
        writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
        writeFileSync(join(dir, "chat.json"), template.chatJson(slug, name));
        writeFileSync(join(dir, "server.mjs"), chatTemplate.chatServer(slug));
        writeFileSync(join(dir, "chat.mjs"), chatTemplate.chatHandlers(slug));
        mkdirSync(join(dir, "test"), { recursive: true });
        writeFileSync(join(dir, "test", "chat.test.mjs"), chatTemplate.chatTest(slug));
        writeFileSync(join(dir, "package.json"), chatTemplate.chatPackageJson(slug, chatTemplate.sdkDependency(dir), chatTemplate.cliDependency(dir)));
        writeFileSync(join(dir, "README.md"), template.chatReadme(slug));
        console.log(`a chat-only grain "${slug}" in ${dir}; owner public key ${ownerKey}: its secret is in ${KEY_FILE} (keep it secret)`);
        console.log(`next: npm install, then grain pair in ${dir}: scan its QR code with your Saltix, which makes the app ` +
          `${slug} (or pairs it, if it is yours already); then npm start. The server's key is made here and never leaves it`);
        console.log(`  or on the test network, with owner.key: grain faucet --wait, grain publish, grain cert init, ` +
          `grain configure --slug ${slug} --server server.key, grain app-key make --slug ${slug}`);
        log.step("init", "ok", "chat");
        return 0;
      }
      // A page that works on its own; with --sign-in, one for some people only that checks first and renders after.
      writeFileSync(join(dir, "public", "index.html"), template.indexHtml(name, signIn));
      writeFileSync(join(dir, "public", "app.js"), template.appJs(slug, signIn));
      const bridge = fileURLToPath((import.meta as unknown as { resolve(s: string): string }).resolve("@saltix/grain"));
      copyFileSync(bridge, join(dir, "public", "grain.js"));
      // Sealed from the start, as grain publish will put it into the network: no placeholder host to be told about, and
      // the Connect sheet's preview says what users will read (a sealed app's code changes only with a version its
      // owner signs). grain publish and grain dev seal public/ again as it changes.
      writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(sealed(manifest, makeBundle(join(dir, "public")), { sources: [] }), null, 2) + "\n");
      writeFileSync(join(dir, "README.md"), template.readme(slug, signIn));
      // The grain command in the project itself: `npx grain` there runs this tool, never a registry's package of that name.
      writeFileSync(join(dir, "package.json"), chatTemplate.pagePackageJson(slug, chatTemplate.cliDependency(dir)));
      console.log(`a grain "${slug}" in ${dir}; owner public key ${ownerKey}: its secret is in ${KEY_FILE} (keep it secret; ` +
        `grain dev signs with it, and grain publish only with --key ${KEY_FILE}, on the test network without a phone)`);
      console.log(`next: npm install in ${dir} (it links the grain command), then npx grain dev`);
      log.step("init", "ok", signIn ? "page_sign_in" : "page");
      return 0;
    }
    case "dev": {
      const port = Number(text(flags, "port", "8090"));
      if (isChatOnly(readManifest(manifestPath).manifest)) {
        throw new Error("a chat-only grain has no page to serve: run its chat server (npm start; docs/first-app.md)");
      }
      const secret = readKey(keyPath);
      if (flags.get("tap") === true && flags.get("check") !== true) throw new UsageError("--tap goes with --check: grain dev --check --tap");
      if (flags.get("check") === true) {
        // The simulator driven headless, once, and an exit status: for an agent or CI, where nobody watches a browser.
        return runCheck({ dir: process.cwd(), manifest: () => readManifest(manifestPath).manifest, secret, log, tap: flags.get("tap") === true });
      }
      const keyFile = typeof flags.get("app-key") === "string" ? (flags.get("app-key") as string) : undefined;
      const appKey = keyFile !== undefined || process.env[APP_KEY_ENV]?.trim() ? readAppKey(keyFile) : undefined;
      await serve(process.cwd(), () => readManifest(manifestPath).manifest, secret, port, "0.0.0.0", { appKey });
      // Serving until stopped: Ctrl-C (or a supervisor's SIGTERM) is how it ends, and the log's last line says so.
      stopsOk = true;
      const served = readManifest(manifestPath).manifest;
      log.step("serve", "ok", "sealed" in served.entry ? "sealed" : placeholderHosted(served) ? "page" : "hosted");
      console.log(`serving ${resolve("public")} on port ${port}`);
      console.log(`  a development registry at http://localhost:${port}/api/dev/rpc (node for your server): ` +
        (appKey ? `${appKey.network} ${appKey.genesis}…, naming the developer key's server key` : "pass --app-key to run your server from its developer key against it"));
      console.log(`  a debug Saltix in the emulator: ${linkFor(`http://10.0.2.2:${port}`)}`);
      console.log(`  this computer:                  ${linkFor(`http://localhost:${port}`)}`);
      console.log(`  the simulator (your page framed as in Saltix, the wallet's controls, the Fold's sizes): ${simulatorFor(`http://localhost:${port}`)}`);
      return await new Promise<number>(() => {});
    }
    case "lint": {
      const { manifest, signed } = readManifest(manifestPath);
      const owner = existsSync(keyPath) ? publicKeyOf(readKey(keyPath)) : undefined;
      const { errors, warnings } = lint(manifest, owner);
      if (signed && !verifyManifest(signed)) errors.push("signature: does not check against owner_key");
      // What Saltix's Connect sheet shows before anyone signs in: the profile, the icon, the permissions (19-connect §12).
      const projectDir = dirname(resolve(manifestPath));
      for (const more of [lintConnect(projectDir, manifest), lintIcon(projectDir, manifest)]) {
        errors.push(...more.errors);
        warnings.push(...more.warnings);
      }
      warnings.push(...lintPermissionsUse(projectDir, manifest));
      // An older grain init's placeholder origin (a new project starts sealed): a page nobody hosts, which grain publish
      // seals into the network instead; grain bundle seals it now, and the warning goes.
      if (placeholderHosted(manifest)) {
        warnings.push(`entry: ${"hosted" in manifest.entry ? manifest.entry.hosted.url : ""} is an older grain init's placeholder (an example domain, no host): ` +
          "grain publish seals public/ into the network in its place, and grain bundle seals it now; only a page you host yourself names its own https origin (grain publish --hosted)");
      }
      // A page's frame: inside the safe area, or edge to edge with viewport-fit=cover (12-grains §7). A chat-only grain has
      // none.
      if (!("chat" in manifest.entry)) warnings.push(...lintPages(join(dirname(resolve(manifestPath)), "public")));
      for (const w of warnings) console.log(`warning: ${w}`);
      for (const e of errors) console.error(`error: ${e}`);
      log.step("lint", errors.length > 0 ? "refused" : "ok", errors.length > 0 ? "errors" : warnings.length > 0 ? "warnings" : "clean");
      // What the registry took at the last grain publish, so that a published app never reads as one to register.
      if (errors.length === 0) console.log(readiness(manifest, readPublishState(projectDir), projectDir));
      return errors.length === 0 ? 0 : 1;
    }
    case "icon": {
      const fix = flags.get("fix") === true;
      const given = flags.get("background");
      const background = typeof given === "string" ? parseColour(given) : null;
      if (given !== undefined && background === null) throw new UsageError("--background #rrggbb");
      const preview = typeof flags.get("preview") === "string" ? (flags.get("preview") as string) : undefined;
      const dir = dirname(resolve(manifestPath));
      const monogram = flags.get("monogram");
      if (monogram !== undefined) {
        // An icon with no picture: letters on a colour, written where the project keeps its icon unless --out says.
        if (typeof monogram !== "string") throw new UsageError("--monogram L: one or two letters or digits (A-Z, 0-9)");
        if (positional.length > 0 || fix || flags.has("fit")) throw new UsageError("grain icon --monogram L [--background #rrggbb] [--out icon.png]: no picture");
        const out = typeof flags.get("out") === "string" ? (flags.get("out") as string) : join(dir, "icon.png");
        const seed = existsSync(manifestPath) ? readManifest(manifestPath).manifest.slug : monogram;
        let refused = "check";
        const code = iconRun(() => runIcon({ input: "", monogram, seed, out, background, preview, dir, manifestPath, onRefused: (r) => (refused = r) }), log);
        log.step("icon", code === 0 ? "ok" : "refused", code === 0 ? "monogram" : refused);
        return code;
      }
      const input = positional[0];
      const out = fix ? positional[1] : typeof flags.get("out") === "string" ? (flags.get("out") as string) : undefined;
      if (!input || (fix && !out)) {
        throw new UsageError(fix ? "grain icon --fix <picture> <icon.png>" : "grain icon <icon.png>, grain icon <picture> --out icon.png, or grain icon --monogram L");
      }
      const fit = flags.get("fit");
      if (fit !== undefined && fit !== "crop" && fit !== "contain" && fit !== "mark") throw new UsageError("--fit crop, contain or mark");
      let refused = "check";
      const code = iconRun(() => runIcon({ input, out, fit: fit as Fit | undefined, background, preview, dir, manifestPath, onRefused: (r) => (refused = r) }), log);
      // Refused: why, by the check's own code (alpha, dimensions, hash…), never only that it was checked.
      log.step("icon", code === 0 ? "ok" : "refused", code === 0 ? (out === undefined ? "checked" : "made") : refused);
      return code;
    }
    case "sign": {
      if (placeholderHosted(readManifest(manifestPath).manifest)) {
        throw new Error("grain.json's entry is grain init's placeholder (an example domain): grain sign is for a page at your own https origin " +
          "(set entry.hosted to it first); grain publish puts public/ into the network without one");
      }
      const signed = signedFor(manifestPath, readKey(keyPath));
      const out = text(flags, "out", "signed.json");
      writeFileSync(out, JSON.stringify(signed, null, 2) + "\n");
      console.log(`${out}: serve it at /.well-known/saltix-grain`);
      return 0;
    }
    case "publish": {
      const r = reach();
      const projectDir = dirname(resolve(manifestPath));
      log.at(projectDir);
      const appKey = flags.get("app-key");
      return publishApp({
        dir: projectDir, manifestPath, node: r.node, flags: r.flags, log, hosted: flags.get("hosted") === true,
        wallet: flags.get("wallet") === true, keyPath, keyNamed: flags.has("key"), appKeyFile: typeof appKey === "string" ? appKey : undefined,
        wait: flags.get("no-wait") !== true, timeoutMs: Number(text(flags, "timeout", "600")) * 1000, out: text(flags, "out", "signed.json"),
        signing: signing(flags, r), tty: process.stdout.isTTY === true,
        progress: rewriteLine((line) => process.stdout.write(line)),
      });
    }
    case "retire": {
      const slug = text(flags, "slug");
      const secret = readKey(keyPath);
      const r = reach();
      return keyCall(() => retireCall(slug, r.node, secret), secret, flags, r, (sent) => `retire ${slug}: transaction ${sent.id} (fee ${salt(sent.fee)} SALT)`, log);
    }
    case "show": {
      const slug = text(flags, "slug");
      const node = reach().node;
      const status = await nodeCall<{ network: string; genesis: string }>(node, "node_status");
      log.onNetwork(status.network);
      const g = await show(node, slug);
      log.step("registry", "ok", g === null ? "free" : g.retired !== null ? "retired" : "registered");
      if (g === null) {
        // A free slug: what registering it takes, and nothing else to show (exit 0: the question was answered).
        const { deposit } = await grainQuote(node, slug);
        console.log(`${slug} is free on ${status.network} ${status.genesis.slice(0, 16)}: registering it keeps a deposit of ${salt(deposit)} SALT ` +
          "until it retires (100 SALT for 3–5 characters, 30 for 6–7, 10 for 8 or more); its first grain publish registers it");
        return 0;
      }
      const out = flags.get("out");
      if (flags.get("json") === true) {
        // For a program: the registry's whole record and nothing else on stdout.
        console.log(JSON.stringify(g, null, 2));
        if (typeof out === "string" && g.manifest) {
          writeFileSync(out, JSON.stringify(g.manifest, null, 2) + "\n");
          console.error(`${out}: the signed manifest the registry holds`);
        }
        return 0;
      }
      // For people: what the record says, in a few lines; --json prints all of it.
      const m = g.manifest?.manifest;
      const members = g.members?.length ?? 0;
      console.log(`${slug} on ${status.network} ${status.genesis.slice(0, 16)}: v${g.version}, ` +
        (g.retired !== null ? `retired at slot ${g.retired}` : g.public === false ? `private, ${members} member${members === 1 ? "" : "s"}` : "public"));
      console.log(`  owner    ${addressOf(status.network, g.owner)}`);
      if (m) {
        const form = "sealed" in m.entry ? `a sealed page, bundle ${m.entry.sealed.bundle.slice(0, 16)}… (${m.entry.sealed.size} bytes)`
          : "hosted" in m.entry ? `a page hosted at ${m.entry.hosted.url}` : "a chat-only app";
        console.log(`  manifest ${m.name.en ?? slug}: ${form}; icon ${/^0+$/.test(m.icon) ? "none (wallets draw the monogram)" : `${m.icon.slice(0, 16)}…`}`);
      }
      if (g.servers !== undefined) {
        console.log(`  servers  ${g.servers.length === 0 ? "none named (a page alone needs none)" : `${g.servers.length} key${g.servers.length === 1 ? "" : "s"}, the app's chat goes to ${g.servers[0]!.slice(0, 16)}…`}`);
      }
      if (g.profile) {
        // As a wallet takes it: checked against the record's slug and owner (whether its key still speaks for the owner
        // is the registry's, which took it).
        const problem = checkGrainProfile(g.profile, g.slug, g.owner);
        const p = g.profile.profile;
        console.log(`  profile  Connect profile revision ${p.revision}: "${profileText(p, "en").tagline}" (${Object.keys(p.texts).sort().join(", ")})` +
          (problem ? `; a wallet refuses it: ${problem}` : "; it checks"));
      } else if (g.profile === null) {
        console.log(`  profile  none: grain profile sets it from connect.json`);
      }
      if (typeof out === "string" && g.manifest) {
        writeFileSync(out, JSON.stringify(g.manifest, null, 2) + "\n");
        console.log(`${out}: the signed manifest the registry holds`);
      }
      console.log(`grain show --slug ${slug} --json prints the registry's whole record`);
      return 0;
    }
    case "bundle": {
      const { manifest } = readManifest(manifestPath);
      const made = makeBundle(join(text(flags, "dir", "."), "public"));
      const list = (name: string) => (typeof flags.get(name) === "string" ? (flags.get(name) as string).split(",").filter(Boolean) : undefined);
      const next = sealed(manifest, made, {
        sources: list("sources"), start: typeof flags.get("start") === "string" ? (flags.get("start") as string) : undefined, connect: list("connect"),
      });
      const out = text(flags, "out", "bundle.zip");
      writeFileSync(out, made.zip);
      writeFileSync(manifestPath, JSON.stringify(next, null, 2) + "\n");
      console.log(`${out}: ${made.files.length} files, ${made.size} bytes, bundle ${made.hash}`);
      const sources = "sealed" in next.entry ? next.entry.sealed.sources : [];
      console.log(sources.length > 0
        ? `${manifestPath} names it, and your sources ${sources.join(", ")} (upload ${out} there too); grain publish makes it the next version`
        : `${manifestPath} names it; grain publish puts the bundle into the network itself, no hosting needed (the next version, if the app is published)`);
      return 0;
    }
    case "chat-spec": {
      const spec = readChatSpec(text(flags, "spec", CHAT_SPEC_FILE));
      const manifest = existsSync(manifestPath) ? readManifest(manifestPath).manifest : undefined;
      const secret = readKey(keyPath);
      const { errors, warnings } = lintChatSpec(spec, manifest, publicKeyOf(secret));
      for (const w of warnings) console.log(`warning: ${w}`);
      for (const e of errors) console.error(`error: ${e}`);
      if (errors.length > 0) return 1;
      const certPath = flags.get("cert");
      const cert = typeof certPath === "string" ? readCert(certPath) : null;
      const out = text(flags, "out", CHAT_DOCUMENT_FILE);
      const doc = signedChatDocument(spec, secret, cert, out);
      writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
      console.log(`${out}: ${spec.slug}'s chat spec v${spec.version}, ${spec.commands.length} commands` +
        (cert ? `; serve it at /.well-known/saltix-grain-chat` : `; add --cert ${CERT_FILE} for the document to serve, or pass the spec to ChatServer`));
      return 0;
    }
    case "cert": {
      const serverKey = text(flags, "server", SERVER_KEY_FILE);
      if (positional[0] === "init") {
        const key = newKey(serverKey);
        console.log(`a server key in ${serverKey} (keep it secret, on your server); its public key ${key}`);
        console.log(`next: grain cert (the owner key certifies it)`);
        return 0;
      }
      const given = flags.get("server-key");
      const key = typeof given === "string" ? given.toLowerCase() : publicKeyOf(readKey(serverKey));
      const slug = text(flags, "slug", existsSync(manifestPath) ? readManifest(manifestPath).manifest.slug : undefined);
      const { cert, warnings } = issueCert(readKey(keyPath), slug, key, Number(text(flags, "days", "30")));
      for (const w of warnings) console.log(`warning: ${w}`);
      const out = text(flags, "out", CERT_FILE);
      writeFileSync(out, JSON.stringify(cert, null, 2) + "\n");
      console.log(`${out}: ${slug}'s server key ${key} until ${new Date(cert.expires_at).toISOString()}`);
      return 0;
    }
    case "configure": {
      const slug = text(flags, "slug");
      const servers = all("server").map(serverKeyOf);
      if (servers.length === 0 && flags.get("revoke-all") !== true) {
        throw new Error("--server KEY (up to 4), or --revoke-all to name none: every developer key would stop at once");
      }
      if (servers.length > 0 && flags.get("revoke-all") === true) throw new Error("--server or --revoke-all, not both");
      const category = typeof flags.get("category") === "string" ? (flags.get("category") as string) : undefined;
      const r = reach();
      const signer = await ownerSigner(slug, (await grainGet(r.node, slug))?.owner ?? null, keyPath, flags, r, log);
      return ownerCall(signer, (secret) => configureCall(r.node, slug, servers, category, secret), flags, r, log);
    }
    case "access": {
      const open = flags.get("public") === true;
      if (open === (flags.get("private") === true)) throw new Error("--public or --private");
      const r = reach();
      const slug = text(flags, "slug");
      const members = membersOf(all("member"));
      const signer = await ownerSigner(slug, (await grainGet(r.node, slug))?.owner ?? null, keyPath, flags, r, log);
      // The owner said public or private: a registration's pending "make it private" here is theirs to decide no more,
      // and the call they sent is the one grain doctor follows.
      const projectDir = dirname(resolve(manifestPath));
      let kept = false;
      const keep = keepFor(slug, manifestPath, signer, () => ({ access: { public: open, members } }), (record) => {
        kept = true;
        accessDecided(projectDir, slug, record);
      });
      const code = await ownerCall(signer, (secret) => accessCall(r.node, slug, open, members, secret), flags, r, log, keep);
      if (code === 0 && !kept) accessDecided(projectDir, slug);
      return code;
    }
    case "rate": {
      const score = Number(text(flags, "score"));
      const review = typeof flags.get("review") === "string" ? (flags.get("review") as string) : "";
      if (!existsSync(keyPath)) {
        console.log(`a rating is signed by the rater's account: in Saltix (Marketplace → ${text(flags, "slug")} → Rate), or with --key on test networks`);
        return 1;
      }
      const rater = readKey(keyPath);
      const r = reach();
      return keyCall(() => rateCall(r.node, text(flags, "slug"), score, review, rater), rater, flags, r,
        (sent) => `rate ${text(flags, "slug")} ${score}: transaction ${sent.id} (fee ${salt(sent.fee)} SALT); a rating names its account`, log);
    }
    case "bind": {
      const clear = flags.get("clear") === true;
      const slug = clear ? null : text(flags, "slug");
      const r = reach();
      const typed = text(flags, "handle");
      const handle = parseHandle(typed);
      if (handle === null) throw new Error(`${typed}: not a name (@anna) or a number (+0 777 1234)`);
      // A username is its holder's: the holder's key file, or their Saltix, binds it.
      const signer = await ownerSigner(typed, (await handleGet(r.node, handle))?.owner ?? null, keyPath, flags, r, log);
      return ownerCall(signer, (secret) => (secret ? bindCall(r.node, typed, slug, secret) : Promise.resolve({ bind: { handle, slug } })), flags, r, log);
    }
    case "app-key": {
      if (positional[0] === "make") {
        const r = reach();
        const status = await nodeCall<{ network: "mainnet" | "testnet" | "devnet"; genesis: string }>(r.node, "node_status");
        const secret = readKey(text(flags, "server", "server.key"));
        const key = AppKey.of(status.network, status.genesis, text(flags, "slug"), secret);
        const out = text(flags, "out", APP_KEY_FILE);
        writeAppKey(out, key);
        console.log(`${out}: the developer key of ${key.slug} on ${status.network} ${key.genesis}, server key ${key.publicKey} (owner-only; keep it secret)`);
        const described = await describeAppKey(key, r.node);
        if (described.registered !== true) console.log(`the registry does not name it yet: grain configure --slug ${key.slug} --server ${key.publicKey}${r.flags}`);
        return 0;
      }
      if (positional.length > 0) {
        throw new Error("never put a developer key on the command line (shells keep their history): set SALTIX_APP_KEY, pass --file, or pipe it in");
      }
      const file = typeof flags.get("file") === "string" ? (flags.get("file") as string) : undefined;
      const key = readAppKey(file, process.env, file === undefined && !process.env.SALTIX_APP_KEY ? await stdinText() : undefined);
      // The key's own network unless told: its public relays, --relay or --node.
      const described = await describeAppKey(key, flags.get("offline") === true ? null : reachOf(flags, all, key.network).node);
      console.log(JSON.stringify(described, null, 2));
      return described.registered === false ? 1 : 0;
    }
    case "pair": {
      const r = reach();
      const given = flags.get("timeout");
      return pair({
        dir: process.cwd(), node: r.node, flags: r.flags, log,
        slug: typeof flags.get("slug") === "string" ? (flags.get("slug") as string) : undefined,
        name: typeof flags.get("name") === "string" ? (flags.get("name") as string) : undefined,
        fresh: flags.get("new") === true, wait: flags.get("no-wait") !== true,
        timeoutMs: Number(typeof given === "string" ? given : "600") * 1000, tty: process.stdout.isTTY === true,
      });
    }
    case "status": {
      const r = reach();
      const state = await keyState(process.cwd(), r.node, r.flags);
      log.step("status", settled(state.status) ? "ok" : "refused", state.status);
      // The same words for a person and a program: `next` is never null, "nothing: …" when nothing is to run.
      const next = state.next ?? "nothing: the server is paired (npm start runs it; grain doctor checks the rest)";
      if (flags.get("json") === true) {
        const { grain: _grain, ...shown } = state;
        console.log(JSON.stringify({ ...shown, next }, null, 2));
      } else {
        console.log(`status: ${state.status}`);
        console.log(`  ${state.detail}`);
        console.log(`next: ${next}`);
      }
      return settled(state.status) ? 0 : 1;
    }
    case "doctor": {
      const r = reach();
      const { state, findings, publish, next, outcome } = await doctor(process.cwd(), r.node, r.flags);
      // The first thing to do, else the first thing waited for: the log's reason, as the exit status tells the outcome.
      const first = findings.find((f) => !f.ok && !f.waiting) ?? findings.find((f) => !f.ok);
      log.step("doctor", outcome === "fix" ? "refused" : outcome === "waiting" ? "waiting" : "ok", first ? first.what.replace(/ /g, "_") : "done");
      if (publish !== null) log.step("doctor_publish", publish === "published" ? "ok" : "waiting", publish);
      if (flags.get("json") === true) {
        // `next` as the text's last line says it, "nothing: …" included: one answer for a person and a program.
        console.log(JSON.stringify({ status: state.status, publish, outcome, exit: DOCTOR_EXIT[outcome], findings, next }, null, 2));
      } else {
        for (const f of findings) {
          const tag = f.ok ? "ok  " : f.waiting ? "wait" : "fix ";
          console.log(`${tag} ${f.what.padEnd(15)} ${f.detail}${f.ok || !f.next ? "" : ` → ${f.next}`}`);
        }
        console.log(`next: ${next}`);
      }
      return DOCTOR_EXIT[outcome];
    }
    case "sponsor": {
      const sponsorKey = text(flags, "key", SPONSOR_KEY_FILE);
      const sub = positional[0] ?? "show";
      if (sub === "init") {
        const key = newKey(sponsorKey);
        console.log(`a sponsor key in ${sponsorKey} (keep it secret, on your server); its public key ${key}`);
        console.log(`set "sponsor" in grain.json to its account: grain sponsor shows it`);
        return 0;
      }
      const secret = readKey(sponsorKey);
      if (sub === "show") {
        console.log(JSON.stringify(await sponsorStatus(reach().node, secret), null, 2));
        return 0;
      }
      const exchange = text(flags, "exchange").toLowerCase();
      const call = sub === "open" ? { open: { exchange, amount: parseWork(text(flags, "amount")) } }
        : sub === "top-up" ? { topUp: { exchange, amount: parseWork(text(flags, "amount")) } }
        : sub === "close" ? { close: { exchange } } : null;
      if (call === null) throw new Error(`grain sponsor ${sub}: init, show, open, top-up or close`);
      const sent = await channel(call, secret, signing(flags, reach()));
      console.log(`${sub} the channel with ${exchange}: transaction ${sent.id} (fee ${salt(sent.fee)} SALT)`);
      return 0;
    }
    case "profile": {
      const { manifest } = readManifest(manifestPath);
      const slug = manifest.slug;
      const r = reach();
      const signer = await ownerSigner(slug, (await grainGet(r.node, slug))?.owner ?? null, keyPath, flags, r, log);
      if (flags.get("clear") === true) {
        return ownerCall(signer, (secret) => clearCall(r.node, slug, secret), flags, r, log, keepFor(slug, manifestPath, signer, () => ({ revision: null })));
      }
      const value = readConnectFile(text(flags, "profile", join(dirname(resolve(manifestPath)), CONNECT_FILE)));
      const placeholder = placeholderLinks(value);
      if (placeholder.length > 0) {
        log.step("profile", "refused", "placeholder_link");
        throw new Error(`${CONNECT_FILE}: ${placeholder.join("; ")}`);
      }
      // grain init's own words, about the counter it makes: a wallet would show them as this app's.
      const template = templateTexts(value);
      if (template.length > 0) {
        log.step("profile", "refused", "connect_template");
        throw new Error(`${CONNECT_FILE}: ${template.join("; ")}: rewrite it for this app (what it is, what it does, what it keeps), then grain profile again`);
      }
      if (signer.by === "key") {
        log.step("sign", "ok", "key_file");
        // The revision each build signs, which grain doctor waits for in the registry.
        let revision: number | null = null;
        const keep = keepFor(slug, manifestPath, signer, () => ({ revision }));
        return ownerCall(signer, async (secret) => {
          const call = await profileCall(r.node, slug, value, secret!);
          revision = "profile" in call && call.profile.profile ? call.profile.profile.profile.revision : null;
          return call;
        }, flags, r, log, keep);
      }
      // The owner's key stays in the wallet: it fills in its account and the revision, signs and sends (12-grains §10).
      const { link, profile, before } = await profileLinkFor(r.node, slug, value);
      if (profileHeld(await grainGet(r.node, slug), profile)) {
        log.step("registry", "ok", "unchanged");
        console.log(`nothing to change: the registry holds ${slug}'s Connect profile with these words already; nothing signed or sent`);
        return 0;
      }
      console.log(await QRCode.toString(link, { type: "terminal", small: true, errorCorrectionLevel: "L" }));
      console.log(`Scan it with the owner's Saltix: it shows ${slug}'s Connect profile as the sheet will, and sets it after the PIN.`);
      console.log(`The link: ${link}`);
      console.log(`Waiting for the owner's Saltix, then the registry (${LANDS_IN} once they confirm)…`);
      log.step("link", "waiting", "shown");
      const limit = Number(text(flags, "timeout", "600")) * 1000;
      const w = new Waiting(waitOut(), "waiting for the owner's Saltix, then the registry", limit);
      const set = await waitForProfile(r.node, slug, profile, before, limit, 3000, () => w.at("not in the registry yet"));
      w.done();
      log.step("registry", set ? "ok" : "timeout", set ? "set" : "not_signed");
      console.log(set ? `the registry has it: revision ${set.profile.revision}` : `not in the registry yet: grain show --slug ${slug}${r.flags} says when it is`);
      return set ? 0 : 1;
    }
    case "connect-profile": {
      const out = text(flags, "out", ".well-known/saltix-connect");
      const given = flags.get("revision");
      if (given !== undefined && (typeof given !== "string" || !/^[1-9][0-9]{0,9}$/.test(given) || Number(given) > 0xffff_ffff)) {
        throw new UsageError("--revision N: 1 or more, above the one the site serves now");
      }
      const site = await siteProfile({
        value: readConnectFile(text(flags, "profile", CONNECT_FILE)),
        origin: typeof flags.get("origin") === "string" ? (flags.get("origin") as string) : undefined,
        name: typeof flags.get("name") === "string" ? (flags.get("name") as string) : undefined,
        category: typeof flags.get("category") === "string" ? (flags.get("category") as string) : undefined,
        revision: typeof given === "string" ? Number(given) : undefined,
        served: flags.get("offline") === true ? async () => null : (origin) => servedSiteRevision(origin),
        previous: out,
        owner: typeof flags.get("owner") === "string" ? (flags.get("owner") as string) : undefined,
      }, readKey(text(flags, "key")));
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(out, JSON.stringify(site, null, 2) + "\n");
      const origin = "site" in site.profile.subject ? site.profile.subject.site.origin : "";
      console.log(`${out}: revision ${site.profile.revision}, owner account ${site.profile.owner}`);
      console.log(`serve it at ${wellKnownOf(origin)} as application/json, with no redirect: Saltix reads it before a sign-in (docs/connect.md)`);
      return 0;
    }
    case "faucet": {
      const r = reach();
      const given = flags.get("address");
      log.onNetwork((await nodeCall<{ network: string }>(r.node, "node_status")).network);
      const address = await grantAddress(r.node, typeof given === "string" ? { address: given } : { secret: readKey(keyPath) });
      const before = flags.get("wait") === true ? await saltOf(r.node, address).catch(() => 0n) : 0n;
      let grant: Awaited<ReturnType<typeof requestGrant>>;
      try {
        grant = await requestGrant(r.node, address);
      } catch (e) {
        log.step("grant", "refused", reasonOf(e));
        throw e;
      }
      log.step("grant", "ok", "sent");
      console.log(`the faucet sent ${granted(grant)}, through ${r.where}`);
      if (flags.get("wait") !== true) return 0;
      console.log("Waiting for it in the account…");
      const landed = await waitForSalt(r.node, address, before + grant.salt.amount, Number(text(flags, "timeout", "120")) * 1000);
      log.step("wait", landed ? "ok" : "timeout", landed ? "landed" : "not_landed");
      console.log(landed ? "it is in the account" : `not in the account yet: its shard's next blocks bring it (grain faucet again in 5 minutes if not)`);
      return landed ? 0 : 1;
    }
    case "help": {
      if (topic === undefined) {
        console.log(HELP);
        return 0;
      }
      const part = helpFor(HELP, topic);
      if (part === null) throw new UsageError(`no command "${topic}" (grain help lists them)`);
      console.log(part);
      return 0;
    }
    case "version": {
      const { name, version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };
      console.log(`grain ${version} (${name})`);
      return 0;
    }
    default:
      throw new UsageError(`no command "${command}" (grain help lists them)`);
  }
}

/** This tool's version, for the steps' log. */
const toolVersion = (): string => {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
};

/** Whether a signal is the command's own way to end (`grain dev` serving), rather than a run cut short. */
let stopsOk = false;

const argv = process.argv.slice(2);
let commandName = "other";
try {
  commandName = parse(argv).command;
} catch {
  // A misuse is still logged, as "other": main says what was wrong.
}
const log = new DevLog(process.cwd(), commandName, toolVersion());
// Stopped by Ctrl-C, SIGTERM or a closed terminal, however it was launched (`npx grain`, `npm run`, the command itself):
// the log's last line says so (a server stopped, or a wait given up), and the exit status is the shell's for that signal.
endOnSignals(log, () => stopsOk);
main(argv, log).then((code) => {
  log.end(code);
  if (code !== 0) process.exitCode = code;
}, (e) => {
  const exit = e instanceof UsageError ? 2 : 1;
  log.end(exit, reasonOf(e));
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = exit;
});

