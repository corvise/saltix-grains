// Writing to users through the relays: records of vectors/relay-v1.json byte for byte, notifications of
// vectors/grains-v1.json, sealed frames, and the client against a relay that checks what it gets.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:https";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { ed25519 } from "@noble/curves/ed25519";
import { x25519 } from "@noble/curves/ed25519";
import {
  fromHex, toHex, accountId, encodeAddress, derive,
  signKeyBinding, encodeKeyBinding, signAddressRecord, encodeAddressRecord, decodeAddressRecord, recordProblem, messagingKeyOf,
  signMailboxAck, toBase64Url, fromBase64Url,
  messagingPublic, sealFrame, openFrame, serverMessagingSecret,
  encodeNotification, notificationMessage, signNotification, decodeNotification, notificationProblem,
  RelayClient, usableEndpoint,
} from "../dist/index.js";

const relayVectors = JSON.parse(readFileSync(new URL("../../../vectors/relay-v1.json", import.meta.url), "utf8")).vectors;
const grains = JSON.parse(readFileSync(new URL("../../../vectors/grains-v1.json", import.meta.url), "utf8"));
const of = (kind) => relayVectors.filter((v) => v.kind === kind);

test("key bindings, address records and mailbox acks are the node's", () => {
  for (const v of of("key_binding")) {
    const b = signKeyBinding(fromHex(v.account_private_key_hex, 32), fromHex(v.messaging_key_hex, 32), v.issued_at, v.key_epoch, v.devices_after);
    assert.equal(toHex(b.accountKey), v.account_key_hex);
    assert.equal(toHex(b.signature), v.signature_hex, v.name);
    assert.equal(toHex(encodeKeyBinding(b)), v.encoded_hex, v.name);
    assert.equal(encodeAddress("devnet", accountId(b.accountKey)), v.address);
  }
  for (const v of of("address_record")) {
    const record = decodeAddressRecord(fromBase64Url(v.record_b64));
    assert.equal(toHex(encodeAddressRecord(record)), v.encoded_hex, v.name);
    assert.equal(toHex(record.signature), v.signature_hex);
    assert.equal(recordProblem(record, v.issued_at), null, v.name);
    assert.equal(recordProblem({ ...record, issuedAt: record.issuedAt + 1 }, v.issued_at), "signature", "a changed record");
    assert.equal(recordProblem(record, v.issued_at - 11 * 60_000), "future");
    if (v.device_hex === null) {
      // Signed by the account key itself — how a server registers: Ed25519 signs the same bytes again.
      const again = signAddressRecord(fromHex(v.signer_private_key_hex, 32), record.key, record.relay, record.nonce, record.issuedAt);
      assert.equal(toBase64Url(encodeAddressRecord(again)), v.record_b64.replace(/=+$/, ""));
    } else {
      assert.equal(recordProblem({ ...record, device: { ...record.device, expiresAt: record.device.expiresAt + 1 } }, v.issued_at), "device");
      assert.equal(recordProblem(record, record.device.expiresAt), "device", "an expired certificate");
      // A device cannot bind another messaging key: only the account key signs bindings.
      const forged = { ...record, key: { ...record.key, messagingKey: new Uint8Array(32).fill(0x66) } };
      const body = encodeAddressRecord(forged).subarray(0, -64);
      const bySigner = ed25519.sign(derive("Salarium address record v1", body), fromHex(v.signer_private_key_hex, 32));
      assert.equal(recordProblem({ ...forged, signature: bySigner }, v.issued_at), "binding");
    }
  }
  for (const v of of("mailbox_ack").filter((v) => v.device_hex === null)) {
    const proof = signMailboxAck(fromHex(v.signer_private_key_hex, 32), v.msg_id, v.at);
    assert.equal(toBase64Url(proof), v.proof_b64.replace(/=+$/, ""), v.name);
  }
});

test("a messaging key is taken only from a record that checks and names the address", () => {
  const v = of("address_record").find((v) => v.device_hex === null);
  const binding = of("key_binding")[0];
  const at = v.issued_at;
  assert.equal(toHex(messagingKeyOf(binding.address, v.record_b64, at, "devnet")), binding.messaging_key_hex);
  assert.equal(messagingKeyOf(binding.address, v.record_b64, at, "testnet"), null, "another network's address");
  const other = encodeAddress("devnet", accountId(ed25519.getPublicKey(new Uint8Array(32).fill(7))));
  assert.equal(messagingKeyOf(other, v.record_b64, at), null, "another address's record");
  const bytes = fromBase64Url(v.record_b64);
  bytes[40] ^= 1;
  assert.equal(messagingKeyOf(binding.address, toBase64Url(bytes), at), null, "a forged messaging key");
  assert.equal(messagingKeyOf(binding.address, null, at), null);
  assert.equal(messagingKeyOf(binding.address, "not base64!", at), null);
});

test("notifications are the node's, by the owner and by a certified server key", () => {
  const n = grains.notifications;
  const inv = grains.invoices;
  for (const c of n.cases) {
    const { notification, cert, signature } = decodeNotification(fromHex(c.signed_borsh));
    assert.equal(toHex(encodeNotification(notification)), c.borsh, c.name);
    assert.equal(toHex(notificationMessage(notification, n.genesis_hash)), c.message);
    const secret = cert ? fromHex(inv.server_secret, 32) : fromHex(grains.owner_secret, 32);
    assert.equal(toHex(signNotification(notification, secret, n.genesis_hash, cert ?? undefined)), c.signed_borsh, c.name);
    const bytes = fromHex(c.signed_borsh);
    assert.equal(notificationProblem(bytes, "chess", { ed25519: inv.owner_key }, n.genesis_hash, n.now), null, c.name);
    assert.equal(notificationProblem(bytes, "go-game", { ed25519: inv.owner_key }, n.genesis_hash, n.now), "grain");
    assert.equal(notificationProblem(bytes, "chess", { ed25519: inv.owner_key }, "00".repeat(32), n.now), "signature");
    assert.equal(notificationProblem(bytes, "chess", { ed25519: inv.owner_key }, n.genesis_hash, notification.at + 7 * 86_400_000 + 1), "time");
    assert.equal(notificationProblem(bytes, "chess", { ed25519: inv.owner_key }, n.genesis_hash, notification.at - 5 * 60_000 - 1), "time");
    if (cert) assert.equal(notificationProblem(bytes, "chess", { ed25519: inv.owner_key }, n.genesis_hash, cert.expires_at), "cert");
    assert.equal(signature.length, 128);
  }
  assert.equal(notificationProblem(Uint8Array.of(1, 2), "chess", { ed25519: inv.owner_key }, n.genesis_hash, n.now), "malformed");
  const base = { slug: "chess", title: "Hi", body: "", at: 1 };
  assert.throws(() => encodeNotification({ ...base, title: "" }), /title/);
  assert.throws(() => encodeNotification({ ...base, title: "x".repeat(65) }), /title/);
  assert.doesNotThrow(() => encodeNotification({ ...base, title: "\u{1F600}".repeat(64) }), "64 characters, not bytes");
  assert.throws(() => encodeNotification({ ...base, body: "a\nb" }), /body/);
  assert.throws(() => encodeNotification({ ...base, start: "a b" }), /start/);
});

test("frames open only for their recipient, from their sender", () => {
  const a = serverMessagingSecret(new Uint8Array(32).fill(1));
  const b = new Uint8Array(32).fill(2);
  assert.equal(toHex(messagingPublic(b)), toHex(x25519.getPublicKey(b)), "X25519 as noble has it");
  const sealed = sealFrame(new TextEncoder().encode("e2e4"), messagingPublic(b), a);
  assert.equal(sealed.length, 24 + 16 + 4);
  assert.equal(new TextDecoder().decode(openFrame(sealed, messagingPublic(a), b)), "e2e4");
  assert.equal(openFrame(sealed, messagingPublic(b), b), null, "another sender");
  assert.equal(openFrame(sealed, messagingPublic(a), a), null, "another recipient");
  assert.equal(openFrame(sealed.subarray(0, 39), messagingPublic(a), b), null);
  assert.notEqual(toHex(sealFrame(Uint8Array.of(1), messagingPublic(b), a)), toHex(sealFrame(Uint8Array.of(1), messagingPublic(b), a)), "fresh nonces");
  assert.equal(toHex(serverMessagingSecret(new Uint8Array(32).fill(1))), toHex(derive("Salarium grain server messaging key v1", new Uint8Array(32).fill(1))));
});

/** A relay that checks registrations like the node does and records what clients send. */
async function fakeRelay({ network = "devnet", https } = {}) {
  const relayKey = new Uint8Array(32).fill(9);
  const records = new Map();
  const sent = [];
  const awaited = [];
  const clients = new Set();
  const wss = https ? new WebSocketServer({ server: https }) : new WebSocketServer({ port: 0, host: "127.0.0.1" });
  if (!https) await new Promise((r) => wss.once("listening", r));
  wss.on("connection", (ws) => {
    const nonce = new Uint8Array(16).fill(Math.floor(Math.random() * 255));
    const sts = Date.now();
    ws.send(JSON.stringify({ type: "hello", nonce: toBase64Url(nonce), sts, relay: toBase64Url(relayKey), network, prices: { frame: "1", file_mib: "1", turn_kib: "1" } }));
    ws.on("message", (data) => {
      const f = JSON.parse(data.toString());
      sent.push(f);
      for (const w of awaited.filter((w) => w.type === f.type)) {
        awaited.splice(awaited.indexOf(w), 1);
        w.resolve(f);
      }
      if (f.type === "register") {
        const r = decodeAddressRecord(fromBase64Url(f.record));
        const ok = recordProblem(r, Date.now()) === null && toHex(r.relay) === toHex(relayKey) && toHex(r.nonce) === toHex(nonce) &&
          Math.abs(r.issuedAt - sts) <= 600_000 && r.device === null;
        if (!ok) return ws.send(JSON.stringify({ type: "error", message: "auth_failed", detail: "invalid" }));
        const address = encodeAddress(network, accountId(r.key.accountKey));
        records.set(address, f.record);
        ws.address = address;
        clients.add(ws);
        ws.send(JSON.stringify({ type: "registered", pubkey: address, keyEpoch: 0, turn: null }));
      } else if (f.type === "get_key") {
        ws.send(JSON.stringify({ type: "key_response", pubkey: f.pubkey, record: records.get(f.pubkey) ?? null, encryptKey: null }));
      }
    });
  });
  const port = () => (https ? https.address().port : wss.address().port);
  return {
    url: () => `${https ? "wss" : "ws"}://127.0.0.1:${port()}`,
    sent, records,
    /** The next frame of `type` a client sends. */
    next: (type) => new Promise((resolve) => awaited.push({ type, resolve })),
    /** A user's wallet: its record known to the relay, its frames delivered. */
    user(seed) {
      const secret = new Uint8Array(32).fill(seed);
      const messaging = new Uint8Array(32).fill(seed + 1);
      const binding = signKeyBinding(secret, messagingPublic(messaging), Date.now());
      const record = signAddressRecord(secret, binding, relayKey, new Uint8Array(16), Date.now());
      const address = encodeAddress(network, accountId(binding.accountKey));
      records.set(address, toBase64Url(encodeAddressRecord(record)));
      return { address, secret, messaging };
    },
    deliver(frame) {
      for (const ws of clients) if (ws.address === frame.to) ws.send(JSON.stringify(frame));
    },
    close: () => new Promise((r) => { for (const ws of clients) ws.terminate(); wss.close(() => r()); https?.close(); }),
  };
}

const quiet = { log: () => {} };

/** A connection that must not happen: the error it failed with (a client that connected anyway is closed). */
async function refused(options) {
  let client;
  try {
    client = await RelayClient.connect({ ...options, ...quiet });
  } catch (e) {
    return e;
  }
  client.close();
  assert.fail("connected");
}

test("a server registers, seals frames to users and hears theirs", async () => {
  const relay = await fakeRelay();
  const secret = new Uint8Array(32).fill(0x63);
  const client = await RelayClient.connect({ endpoints: [{ url: relay.url(), cert_sha256: null }], secret, network: "devnet", ...quiet });
  try {
    assert.equal(client.address, encodeAddress("devnet", accountId(ed25519.getPublicKey(secret))));
    assert.ok(relay.records.has(client.address), "registered with a record it signed itself");
    const user = relay.user(0x41);

    let arrived = relay.next("message");
    await client.send(user.address, new TextEncoder().encode("your move"));
    const live = await arrived;
    assert.equal(live.to, user.address);
    assert.equal(live.ephemeral, true);
    const serverKey = messagingPublic(serverMessagingSecret(secret));
    assert.equal(new TextDecoder().decode(openFrame(fromBase64Url(live.payload), serverKey, user.messaging)), "your move");

    const note = signNotification({ slug: "chess", title: "Your move", body: "", start: "g-1", at: Date.now() }, secret, "5a".repeat(32));
    arrived = relay.next("message");
    await client.notify(user.address, note);
    const kept = await arrived;
    assert.equal(kept.ephemeral, undefined, "kept for the mailbox");
    assert.equal(toHex(openFrame(fromBase64Url(kept.payload), serverKey, user.messaging)), toHex(note));

    await assert.rejects(client.send(encodeAddress("devnet", new Uint8Array(32).fill(5)), Uint8Array.of(1)), /no messaging key/);
    await assert.rejects(client.send(user.address, new Uint8Array(49_113)), /too large/);
    await client.send(user.address, new Uint8Array(48_000));

    // A user's kept frame: opened, handed over, and taken off the server's mailbox with a signed proof.
    const acked = relay.next("message_ack");
    const heard = new Promise((r) => client.once("frame", r));
    const sealed = sealFrame(new TextEncoder().encode("e7e5"), serverKey, user.messaging);
    relay.deliver({ type: "message", to: client.address, from: user.address, payload: toBase64Url(sealed), msgId: "m-9", sts: Date.now() });
    const frame = await heard;
    assert.equal(frame.from, user.address);
    assert.equal(new TextDecoder().decode(frame.payload), "e7e5");
    assert.equal(frame.kept, true);
    const ack = await acked;
    assert.equal(ack.to, user.address);
    assert.equal(ack.msgId, "m-9");
    const proof = fromBase64Url(ack.proof);
    const body = proof.subarray(0, proof.length - 64);
    assert.ok(ed25519.verify(proof.subarray(proof.length - 64), derive("Salarium mailbox ack v1", body), ed25519.getPublicKey(secret)));
  } finally {
    client.close();
    await relay.close();
  }
});

test("a relay of another network, or one that is not the pinned one, is not used", async () => {
  const other = await fakeRelay({ network: "testnet" });
  assert.match((await refused({ endpoints: [{ url: other.url(), cert_sha256: null }], secret: new Uint8Array(32).fill(1), network: "devnet", timeoutMs: 800 })).message, /in time/);
  await other.close();
  // ws:// only on loopback: a remote plain endpoint is never dialed.
  assert.match((await refused({ endpoints: [{ url: "ws://192.0.2.1:30335", cert_sha256: null }], secret: new Uint8Array(32).fill(1), network: "devnet", timeoutMs: 300 })).message, /in time/);
});

test("only wss, or plain ws on loopback, is dialed", () => {
  const ok = (url, cert_sha256 = null) => usableEndpoint({ url, cert_sha256 });
  assert.ok(ok("wss://85.192.42.65:30335", "ab".repeat(32)));
  assert.ok(ok("wss://relay.example"), "a CA's certificate");
  assert.ok(ok("ws://127.0.0.1:30335") && ok("ws://localhost:1") && ok("ws://[::1]:2"));
  assert.ok(!ok("ws://85.192.42.65:30335"), "plain ws to another host");
  assert.ok(!ok("http://127.0.0.1:30335") && !ok("not a url") && !ok(""));
  assert.ok(!ok("wss://relay.example", "zz"), "a malformed pin");
});

test("a self-signed relay is trusted by its certificate's hash", { skip: !hasOpenssl() && "no openssl" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-subj", "/CN=relay",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "pipe" });
  const der = execFileSync("openssl", ["x509", "-in", join(dir, "cert.pem"), "-outform", "DER"]);
  const pin = createHash("sha256").update(der).digest("hex");
  const https = createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) });
  await new Promise((r) => https.listen(0, "127.0.0.1", r));
  const relay = await fakeRelay({ https });
  const secret = new Uint8Array(32).fill(2);
  try {
    assert.match((await refused({ endpoints: [{ url: relay.url(), cert_sha256: "00".repeat(32) }], secret, network: "devnet", timeoutMs: 800 })).message, /in time/);
    assert.equal(relay.sent.filter((f) => f.type === "register").length, 0, "nothing sent to a relay that is not the pinned one");
    const client = await RelayClient.connect({ endpoints: [{ url: relay.url(), cert_sha256: pin }], secret, network: "devnet", ...quiet });
    assert.ok(relay.records.has(client.address));
    client.close();
  } finally {
    await relay.close();
  }
});

function hasOpenssl() {
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
