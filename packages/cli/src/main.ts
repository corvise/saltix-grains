#!/usr/bin/env node
// The grain command line (Salarium 12-grains §10).
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { iconHash, verifyManifest, type Manifest } from "@salarium/grain-server";
import { MANIFEST_FILE, KEY_FILE, readManifest, readKey, newKey, lint, signedFor, publicKeyOf } from "./project.js";
import QRCode from "qrcode";
import { publish, retire, show, waitFor, walletLink, waitForPublished, type Signing } from "./registry.js";
import { serve, linkFor } from "./dev.js";
import { SPONSOR_KEY_FILE, channel, parseWork, sponsorStatus } from "./sponsor.js";
import * as template from "./template.js";

const HELP = `grain — make, serve, check, sign, register and retire grains (Salarium 12-grains)

  grain init [dir] [--slug S] [--name N]   a new grain: grain.json, owner.key, public/
  grain dev [--port 8090]                  serve public/ with the manifest signed for this computer
  grain lint [--manifest grain.json]       what stops the manifest from being registered
  grain icon <png>                         the hash a manifest names its 256x256 icon by
  grain sign [--out signed.json]           the signed manifest, for /.well-known/salarium-grain
  grain publish --node URL [--wallet]      register the slug (100 SALT deposit) or record a newer version:
                                           signed in the owner's wallet by a QR code, or with --key
                                           (a key file, for test networks) when owner.key is there
  grain retire --slug S --node URL         close the slug for good; the deposit returns 30 days later
  grain show --slug S --node URL [--out F] what the registry holds for a slug; F gets its signed manifest
  grain sponsor init                       a sponsor key (sponsor.key): its account pays relays for your users
  grain sponsor --node URL                 the sponsor's account, WORK, channels and the exchanges to open one with
  grain sponsor open --exchange C --amount W --node URL   a channel with city C's exchange, W WORK deposited
  grain sponsor top-up --exchange C --amount W --node URL
  grain sponsor close --exchange C --node URL             the deposit returns after the claim window

  --manifest F   the manifest (grain.json); --key F   the owner's key file (owner.key)
  --node URL     a node's wallet interface (plain HTTP: a local node or a tunnel)
  --genesis H    refuse a node of another network; --fee N   base units of SALT; --valid-for N   slots (600)
`;

function parse(argv: string[]): { command: string; positional: string[]; flags: Map<string, string | true> } {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags.set(a.slice(2), next); i++; } else flags.set(a.slice(2), true);
  }
  return { command, positional, flags };
}

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

async function main(argv: string[]): Promise<number> {
  const { command, positional, flags } = parse(argv);
  const manifestPath = text(flags, "manifest", MANIFEST_FILE);
  const keyPath = text(flags, "key", KEY_FILE);
  switch (command) {
    case "init": {
      const dir = resolve(positional[0] ?? ".");
      const slug = text(flags, "slug", basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 32));
      const name = text(flags, "name", slug);
      if (existsSync(join(dir, MANIFEST_FILE))) throw new Error(`${join(dir, MANIFEST_FILE)} exists already`);
      mkdirSync(join(dir, "public"), { recursive: true });
      const ownerKey = newKey(join(dir, KEY_FILE));
      const manifest: Manifest = {
        slug, version: 1, owner_key: ownerKey, name: { en: name }, description: { en: "" }, icon: "00".repeat(32),
        entry: { hosted: { url: `https://${slug}.example/`, origins: [`https://${slug}.example`] } },
        permissions: 1, sponsor: null, min_host: 1,
      };
      if (!manifest.description.en) delete (manifest.description as Record<string, string>).en;
      writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
      writeFileSync(join(dir, "public", "index.html"), template.indexHtml(name));
      writeFileSync(join(dir, "public", "app.js"), template.appJs);
      const bridge = fileURLToPath((import.meta as unknown as { resolve(s: string): string }).resolve("@salarium/grain"));
      copyFileSync(bridge, join(dir, "public", "grain.js"));
      writeFileSync(join(dir, ".gitignore"), template.gitignore);
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
      console.log(`${out}: serve it at /.well-known/salarium-grain`);
      return 0;
    }
    case "publish": {
      if (flags.get("wallet") === true || !existsSync(keyPath)) {
        // The owner's key stays in the wallet: it fills in owner_key, signs and pays (12-grains §10).
        const node = text(flags, "node");
        const { manifest } = readManifest(manifestPath);
        const unowned = { ...manifest, owner_key: "00".repeat(32) };
        const { errors } = lint(unowned);
        if (errors.length > 0) throw new Error(errors.join("\n"));
        const link = await walletLink(manifest, node);
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
        console.log(`${manifest.slug} v${manifest.version} is in the registry, owned by key ${signed.manifest.owner_key}; ${text(flags, "out", "signed.json")} written`);
        return 0;
      }
      const secret = readKey(keyPath);
      const signed = signedFor(manifestPath, secret);
      const s = signing(flags);
      const sent = await publish(signed, secret, s);
      writeFileSync(text(flags, "out", "signed.json"), JSON.stringify(signed, null, 2) + "\n");
      console.log(`${sent.call} ${signed.manifest.slug} v${signed.manifest.version}: transaction ${sent.id} (fee ${sent.fee})`);
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
      const g = await show(text(flags, "node"), text(flags, "slug"));
      console.log(JSON.stringify(g, null, 2));
      const out = flags.get("out");
      if (typeof out === "string" && g?.manifest) {
        writeFileSync(out, JSON.stringify(g.manifest, null, 2) + "\n");
        console.log(`${out}: the signed manifest the registry holds`);
      }
      return g === null ? 1 : 0;
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
    case "help":
    case "--help":
      console.log(HELP);
      return 0;
    default:
      console.error(HELP);
      return 2;
  }
}

main(process.argv.slice(2)).then((code) => { if (code !== 0) process.exitCode = code; }, (e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});

