#!/usr/bin/env node
// The grain command line (Saltix 12-grains §10).
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UNOWNED, AppKey, iconHash, verifyManifest, grainQuote, parseHandle, rpc, type GrainCall, type Manifest } from "@saltix/grain-server";
import { MANIFEST_FILE, KEY_FILE, readManifest, readKey, newKey, lint, signedFor, publicKeyOf, ownerOf } from "./project.js";
import QRCode from "qrcode";
import { publish, retire, show, waitFor, walletLink, waitForPublished, salt, type Signing } from "./registry.js";
import {
  APP_KEY_FILE, accessCall, bindCall, configureCall, describeAppKey, inSaltix, membersOf, rateCall, readAppKey, sendCall, serverKeyOf,
  waitForRegistry, walletFor, writeAppKey,
} from "./studio.js";
import { serve, linkFor } from "./dev.js";
import { SPONSOR_KEY_FILE, channel, parseWork, sponsorStatus } from "./sponsor.js";
import { makeBundle, sealed } from "./bundle.js";
import * as template from "./template.js";
import * as chatTemplate from "./chat-template.js";
import { CERT_FILE, CHAT_DOCUMENT_FILE, CHAT_SPEC_FILE, SERVER_KEY_FILE, issueCert, lintChatSpec, readCert, readChatSpec, signedChatDocument } from "./chat.js";
import { UsageError, helpFor, parse } from "./args.js";

const HELP = `grain — make, serve, check, sign, register and retire grains (Saltix 12-grains)

  grain help [command]                     this, or one command's part of it (also: grain <command> --help)
  grain init [dir] [--slug S] [--name N] [--chat]
                                           a new grain: grain.json, owner.key, public/; --chat a chat-only one
                                           (no page: grain.json and chat.json)
  grain dev [--port 8090]                  serve public/ with the manifest signed for this computer
  grain lint [--manifest grain.json]       what stops the manifest from being registered
  grain icon <png>                         the hash a manifest names its 256x256 icon by
  grain sign [--out signed.json]           the signed manifest, for /.well-known/saltix-grain
  grain bundle --sources URL[,URL] [--start index.html] [--connect O[,O]] [--out bundle.zip] [--dir .]
                                           seal public/ into one ZIP; grain.json names its hash and size
                                           (upload bundle.zip to the sources; grain dev serves it itself)
  grain publish --node URL [--wallet] [--wait] [--out signed.json]
                                           register the slug or record a newer version: signed in the owner's
                                           wallet by a QR code, or with --key (a key file, for test networks)
                                           when owner.key is there. The deposit is the node's quote for the
                                           slug's length: 100 SALT for 3-5 characters, 30 for 6-7, 10 for 8+
  grain retire --slug S --node URL         close the slug for good; the deposit returns 30 days later
  grain show --slug S --node URL [--out F] what the registry holds for a slug, or its deposit; F gets the manifest
  grain chat-spec [--spec chat.json] [--cert cert.json] [--out chat.signed.json]
                                           lint the chat spec and sign it with the owner key: the document to serve
                                           at /.well-known/saltix-grain-chat ({spec, cert} with --cert)
  grain cert init                          a server key (server.key): it signs the chat's messages, invoices and
                                           notifications on your server
  grain cert [--server server.key | --server-key HEX] [--days 30] [--out cert.json]
                                           the owner key certifies the server key for the grain (31 days at most
                                           for chats: issue a new one before it ends)
  grain configure --slug S --server KEY [--server KEY…] [--category C] --node URL
                                           name the grain's server keys (hex, or a key file such as server.key; at
                                           most 4) and its category: both replace the registry's. --revoke-all
                                           names none: every developer key stops at once
  grain access --slug S --public|--private [--member ADDRESS:ROLES…] --node URL
                                           who may use the grain: anyone, or its owner and members (roles user,
                                           developer, viewer joined by +; at most 64); both replace the registry's
  grain rate --slug S --score 1-5 [--review TEXT] --node URL --key rater.key
                                           rate someone else's grain (0 withdraws your rating); public, by account
  grain bind --handle @name --slug S --node URL   (or --clear) point a username you hold at your grain: @name
                                           opens its chat
  grain app-key [--file F] [--node URL] [--offline]
                                           a developer key's public parts (from SALTIX_APP_KEY, --file or stdin),
                                           and whether the registry names it; never the secret
  grain app-key make --slug S --node URL [--server server.key] [--out app.key]
                                           a developer key for a server key file, written owner-only (test networks)
  The owner's calls are signed with owner.key (--key) where there is one, for test networks; without it the tool
  says what to do in the owner's Saltix (My apps) and waits for the registry (--timeout seconds, 600).

  grain sponsor init                       a sponsor key (sponsor.key): its account pays relays for your users
  grain sponsor --node URL                 the sponsor's account, WORK, channels and the exchanges to open one with
  grain sponsor open --exchange C --amount W --node URL   a channel with city C's exchange, W WORK deposited
  grain sponsor top-up --exchange C --amount W --node URL
  grain sponsor close --exchange C --node URL             the deposit returns after the claim window

  --manifest F   the manifest (grain.json); --key F   the owner's key file (owner.key)
  --node URL     a node's wallet interface (plain HTTP: a local node or a tunnel)
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

function signing(flags: Map<string, string | true>): Signing {
  const fee = flags.get("fee");
  return {
    node: text(flags, "node"),
    genesis: typeof flags.get("genesis") === "string" ? (flags.get("genesis") as string) : undefined,
    fee: typeof fee === "string" ? BigInt(fee) : undefined,
    validFor: Number(text(flags, "valid-for", "600")),
  };
}

/** The owner's call `call`: signed with the key file when there is one, else done in Saltix and waited for. */
async function ownerCall(call: GrainCall, keyPath: string, flags: Map<string, string | true>): Promise<number> {
  const node = text(flags, "node");
  if (flags.get("wallet") === true || !existsSync(keyPath)) {
    console.log(inSaltix(call));
    console.log("Waiting for the registry…");
    const ok = await waitForRegistry(node, call, Number(text(flags, "timeout", "600")) * 1000);
    console.log(ok ? "the registry has it" : "not in the registry yet: check with grain show");
    return ok ? 0 : 1;
  }
  const { sent, landed } = await sendCall(call, readKey(keyPath), signing(flags), flags.get("wait") === true ? 180_000 : 0);
  console.log(`${sent.call}: transaction ${sent.id} (fee ${sent.fee})`);
  if (landed !== null) console.log(landed ? "the registry has it" : "not in the registry yet: check with grain show");
  return landed === false ? 1 : 0;
}

/** All of stdin, when it is piped in. */
async function stdinText(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv: string[]): Promise<number> {
  const { command, topic, positional, flags, all } = parse(argv);
  const manifestPath = text(flags, "manifest", MANIFEST_FILE);
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
      mkdirSync(chat ? dir : join(dir, "public"), { recursive: true });
      const ownerKey = newKey(join(dir, KEY_FILE));
      const manifest: Manifest = {
        slug, version: 1, ...ownerOf(ownerKey), name: { en: name }, description: { en: "" }, icon: "00".repeat(32),
        entry: chat ? { chat: {} } : { hosted: { url: `https://${slug}.example/`, origins: [`https://${slug}.example`] } },
        permissions: chat ? 4 : 1, sponsor: null, min_host: 1,
      };
      if (!manifest.description.en) delete (manifest.description as Record<string, string>).en;
      writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
      writeFileSync(join(dir, ".gitignore"), template.gitignore);
      if (chat) {
        writeFileSync(join(dir, "chat.json"), template.chatJson(slug, name));
        writeFileSync(join(dir, "server.mjs"), chatTemplate.chatServer(slug));
        writeFileSync(join(dir, "package.json"), chatTemplate.chatPackageJson(slug, chatTemplate.sdkDependency(dir)));
        writeFileSync(join(dir, "README.md"), template.chatReadme(slug));
        console.log(`a chat-only grain "${slug}" in ${dir}; owner key ${ownerKey} in ${KEY_FILE} (keep it secret)`);
        console.log(`next: make the app in Saltix (Apps → My apps → New app, slug ${slug}) and put its developer key in app.key ` +
          `(owner-only, never on the command line); then npm install && npm start in ${dir}`);
        console.log(`  or on a test network, with owner.key: grain publish --node URL, grain cert init, ` +
          `grain configure --slug ${slug} --server server.key --node URL, grain app-key make --slug ${slug} --node URL`);
        return 0;
      }
      writeFileSync(join(dir, "public", "index.html"), template.indexHtml(name));
      writeFileSync(join(dir, "public", "app.js"), template.appJs);
      const bridge = fileURLToPath((import.meta as unknown as { resolve(s: string): string }).resolve("@saltix/grain"));
      copyFileSync(bridge, join(dir, "public", "grain.js"));
      writeFileSync(join(dir, "README.md"), template.readme(slug));
      console.log(`a grain "${slug}" in ${dir}; owner key ${ownerKey} in ${KEY_FILE} (keep it secret)`);
      console.log("next: grain dev");
      return 0;
    }
    case "dev": {
      const port = Number(text(flags, "port", "8090"));
      const secret = readKey(keyPath);
      await serve(process.cwd(), () => readManifest(manifestPath).manifest, secret, port);
      console.log(`serving ${resolve("public")} on port ${port}`);
      console.log(`  a debug Saltix in the emulator: ${linkFor(`http://10.0.2.2:${port}`)}`);
      console.log(`  this computer:                  ${linkFor(`http://localhost:${port}`)}`);
      return await new Promise<number>(() => {});
    }
    case "lint": {
      const { manifest, signed } = readManifest(manifestPath);
      const owner = existsSync(keyPath) ? publicKeyOf(readKey(keyPath)) : undefined;
      const { errors, warnings } = lint(manifest, owner);
      if (signed && !verifyManifest(signed)) errors.push("signature: does not check against owner_key");
      for (const w of warnings) console.log(`warning: ${w}`);
      for (const e of errors) console.error(`error: ${e}`);
      if (errors.length === 0) console.log(`${manifest.slug} ${manifest.version}: ready to register`);
      return errors.length === 0 ? 0 : 1;
    }
    case "icon": {
      const png = positional[0];
      if (!png) throw new Error("grain icon <png>");
      console.log(iconHash(new Uint8Array(readFileSync(png))));
      return 0;
    }
    case "sign": {
      const signed = signedFor(manifestPath, readKey(keyPath));
      const out = text(flags, "out", "signed.json");
      writeFileSync(out, JSON.stringify(signed, null, 2) + "\n");
      console.log(`${out}: serve it at /.well-known/saltix-grain`);
      return 0;
    }
    case "publish": {
      if (flags.get("wallet") === true || !existsSync(keyPath)) {
        // The owner's key stays in the wallet: it fills in the owner and its key, signs and pays (12-grains §10).
        const node = text(flags, "node");
        const { manifest } = readManifest(manifestPath);
        const unowned = { ...manifest, ...UNOWNED };
        const { errors } = lint(unowned);
        if (errors.length > 0) throw new Error(errors.join("\n"));
        const link = await walletLink(manifest, node);
        const { grain, deposit } = await grainQuote(node, manifest.slug);
        if (grain === null) console.log(`Registering ${manifest.slug} keeps a deposit of ${salt(deposit)} SALT until it retires (the slug's length sets it).`);
        console.log(await QRCode.toString(link, { type: "terminal", small: true, errorCorrectionLevel: "L" }));
        console.log(`Scan it with the owner's Saltix (the phone's camera opens it), check the grain and confirm with the PIN.`);
        console.log(`The link: ${link}`);
        console.log("Waiting for the registry…");
        const signed = await waitForPublished(node, manifest, Number(text(flags, "timeout", "600")) * 1000);
        if (signed === null) {
          console.error(`not in the registry yet: once the wallet's transaction lands, grain show --slug ${manifest.slug} --node ${node} --out signed.json writes it`);
          return 1;
        }
        writeFileSync(text(flags, "out", "signed.json"), JSON.stringify(signed, null, 2) + "\n");
        console.log(`${manifest.slug} v${manifest.version} is in the registry, owned by account ${signed.manifest.owner}; ${text(flags, "out", "signed.json")} written`);
        return 0;
      }
      const secret = readKey(keyPath);
      const signed = signedFor(manifestPath, secret);
      const s = signing(flags);
      const sent = await publish(signed, secret, s);
      writeFileSync(text(flags, "out", "signed.json"), JSON.stringify(signed, null, 2) + "\n");
      const deposit = sent.amount > 0n ? `, deposit ${salt(sent.amount)} SALT` : "";
      console.log(`${sent.call} ${signed.manifest.slug} v${signed.manifest.version}: transaction ${sent.id} (fee ${sent.fee}${deposit})`);
      if (flags.get("wait") === true) {
        const v = signed.manifest.version;
        const ok = await waitFor(s.node, signed.manifest.slug, (g) => g?.version === v && g.retired === null, 180_000);
        console.log(ok ? "the registry has it" : "not in the registry yet: check with grain show");
        return ok ? 0 : 1;
      }
      return 0;
    }
    case "retire": {
      const slug = text(flags, "slug");
      const sent = await retire(slug, readKey(keyPath), signing(flags));
      console.log(`retire ${slug}: transaction ${sent.id}`);
      return 0;
    }
    case "show": {
      const slug = text(flags, "slug");
      const g = await show(text(flags, "node"), slug);
      console.log(JSON.stringify(g, null, 2));
      if (g === null) {
        const { deposit } = await grainQuote(text(flags, "node"), slug);
        console.log(`${slug} is free: registering it keeps a deposit of ${salt(deposit)} SALT`);
      }
      const out = flags.get("out");
      if (typeof out === "string" && g?.manifest) {
        writeFileSync(out, JSON.stringify(g.manifest, null, 2) + "\n");
        console.log(`${out}: the signed manifest the registry holds`);
      }
      return g === null ? 1 : 0;
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
      console.log(`${manifestPath} names it; upload ${out} to ${("sealed" in next.entry ? next.entry.sealed.sources : []).join(", ")}, raise "version" if it was published, then grain publish`);
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
      const owner = existsSync(keyPath) && flags.get("wallet") !== true ? readKey(keyPath) : undefined;
      return ownerCall(await configureCall(text(flags, "node"), slug, servers, category, owner), keyPath, flags);
    }
    case "access": {
      const open = flags.get("public") === true;
      if (open === (flags.get("private") === true)) throw new Error("--public or --private");
      const owner = existsSync(keyPath) && flags.get("wallet") !== true ? readKey(keyPath) : undefined;
      const call = await accessCall(text(flags, "node"), text(flags, "slug"), open, membersOf(all("member")), owner);
      return ownerCall(call, keyPath, flags);
    }
    case "rate": {
      const score = Number(text(flags, "score"));
      const review = typeof flags.get("review") === "string" ? (flags.get("review") as string) : "";
      if (!existsSync(keyPath)) {
        console.log(`a rating is signed by the rater's account: in Saltix (Marketplace → ${text(flags, "slug")} → Rate), or with --key on test networks`);
        return 1;
      }
      const rater = readKey(keyPath);
      const { sent } = await sendCall(await rateCall(text(flags, "node"), text(flags, "slug"), score, review, rater), rater, signing(flags));
      console.log(`rate ${text(flags, "slug")} ${score}: transaction ${sent.id} (fee ${sent.fee}); a rating names its account`);
      return 0;
    }
    case "bind": {
      const clear = flags.get("clear") === true;
      const slug = clear ? null : text(flags, "slug");
      const node = text(flags, "node");
      if (!existsSync(keyPath) || flags.get("wallet") === true) {
        const handle = parseHandle(text(flags, "handle"));
        if (handle === null) throw new Error(`${text(flags, "handle")}: not a name (@anna) or a number (+0 777 1234)`);
        return ownerCall({ bind: { handle, slug } }, keyPath, flags);
      }
      return ownerCall(await bindCall(node, text(flags, "handle"), slug, readKey(keyPath)), keyPath, flags);
    }
    case "app-key": {
      if (positional[0] === "make") {
        const node = text(flags, "node");
        const status = await rpc<{ network: "mainnet" | "testnet" | "devnet"; genesis: string }>(node, "node_status");
        const secret = readKey(text(flags, "server", "server.key"));
        const key = AppKey.of(status.network, status.genesis, text(flags, "slug"), secret);
        const out = text(flags, "out", APP_KEY_FILE);
        writeAppKey(out, key);
        console.log(`${out}: the developer key of ${key.slug} on ${status.network} ${key.genesis}, server key ${key.publicKey} (owner-only; keep it secret)`);
        const described = await describeAppKey(key, walletFor(status.network, node));
        if (described.registered !== true) console.log(`the registry does not name it yet: grain configure --slug ${key.slug} --server ${key.publicKey} --node ${node}`);
        return 0;
      }
      if (positional.length > 0) {
        throw new Error("never put a developer key on the command line (shells keep their history): set SALTIX_APP_KEY, pass --file, or pipe it in");
      }
      const file = typeof flags.get("file") === "string" ? (flags.get("file") as string) : undefined;
      const key = readAppKey(file, process.env, file === undefined && !process.env.SALTIX_APP_KEY ? await stdinText() : undefined);
      const node = typeof flags.get("node") === "string" ? (flags.get("node") as string) : undefined;
      const described = await describeAppKey(key, flags.get("offline") === true ? null : walletFor(key.network, node));
      console.log(JSON.stringify(described, null, 2));
      return described.registered === false ? 1 : 0;
    }
    case "sponsor": {
      const sponsorKey = text(flags, "key", SPONSOR_KEY_FILE);
      const sub = positional[0] ?? "show";
      if (sub === "init") {
        const key = newKey(sponsorKey);
        console.log(`a sponsor key in ${sponsorKey} (keep it secret, on your server); its public key ${key}`);
        console.log(`set "sponsor" in grain.json to its account: grain sponsor --node URL shows it`);
        return 0;
      }
      const secret = readKey(sponsorKey);
      if (sub === "show") {
        console.log(JSON.stringify(await sponsorStatus(text(flags, "node"), secret), null, 2));
        return 0;
      }
      const exchange = text(flags, "exchange").toLowerCase();
      const call = sub === "open" ? { open: { exchange, amount: parseWork(text(flags, "amount")) } }
        : sub === "top-up" ? { topUp: { exchange, amount: parseWork(text(flags, "amount")) } }
        : sub === "close" ? { close: { exchange } } : null;
      if (call === null) throw new Error(`grain sponsor ${sub}: init, show, open, top-up or close`);
      const sent = await channel(call, secret, signing(flags));
      console.log(`${sub} the channel with ${exchange}: transaction ${sent.id} (fee ${sent.fee})`);
      return 0;
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

main(process.argv.slice(2)).then((code) => { if (code !== 0) process.exitCode = code; }, (e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = e instanceof UsageError ? 2 : 1;
});

