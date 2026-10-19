// Putting a sealed grain's bundle and icon into the network (Saltix 32-images §7): in pieces of at most 256 KiB, each
// where the node stands; resumed from `received` on `offset` (a node that lost the upload, or another relay after a
// failover, from 0); `busy` and `rate_limited` waited out; a network that does not answer tried again; every other
// refusal ending it with the node's reason. Against the development node, which takes blobs as a node does: a statement
// checked against the registry's server keys, a bundle named or pending, an icon only once named.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { readFileSync } from "node:fs";
import {
  BLOB_PIECE, BlobRefused, RpcError, accountId, blobHeld, fromHex, getBlob, namedHash, putBundle, putIcon, signBundleUpload, signManifest, toHex,
} from "../dist/index.js";
import { createDevRegistry } from "../dist/dev.js";

const v = JSON.parse(readFileSync(new URL("../../../vectors/images-v1.json", import.meta.url), "utf8"));
const ownerSecret = fromHex("41".repeat(32), 32);
const serverSecret = fromHex("42".repeat(32), 32);
const serverKey = toHex(ed25519.getPublicKey(serverSecret));
const NOW = 1_790_000_000_000;

/** A stored ZIP of `size` bytes or so, as grain bundle writes it: one file of random bytes. */
function zipOf(size) {
  const data = randomBytes(size);
  const name = Buffer.from("index.html");
  let c = 0xffffffff;
  for (const x of data) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  const crc = (c ^ 0xffffffff) >>> 0;
  const head = (central) => {
    const b = Buffer.alloc(central ? 46 : 30);
    let at = 0;
    b.writeUInt32LE(central ? 0x02014b50 : 0x04034b50, at); at += 4;
    if (central) { b.writeUInt16LE(20, at); at += 2; }
    b.writeUInt16LE(20, at); at += 2;
    b.writeUInt16LE(0x0800, at); at += 2;
    b.writeUInt16LE(0, at); at += 2;
    b.writeUInt16LE(0, at); at += 2;
    b.writeUInt16LE(0x21, at); at += 2;
    b.writeUInt32LE(crc, at); at += 4;
    b.writeUInt32LE(data.length, at); at += 4;
    b.writeUInt32LE(data.length, at); at += 4;
    b.writeUInt16LE(name.length, at); at += 2;
    b.writeUInt16LE(0, at);
    return b;
  };
  const local = Buffer.concat([head(false), name, data]);
  const central = Buffer.concat([head(true), name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return new Uint8Array(Buffer.concat([local, central, end]));
}

function registry(over = {}) {
  return createDevRegistry({ slug: "space-game", ownerSecret, servers: [serverKey], genesis: v.uploads.genesis_hash, now: () => NOW, ...over });
}

/** A node's wallet interface that counts what it is asked, and answers through `registry`. */
function counted(reg) {
  const calls = [];
  return { calls, call: (method, params) => (calls.push({ method, params: structuredClone(params) }), reg.call(method, params)) };
}

/** The server key's statement for `zip`, dated `at`. */
const statementFor = (zip, at = NOW, secret = serverSecret, slug = "space-game") =>
  signBundleUpload(secret, v.uploads.genesis_hash, { slug, bundle: namedHash("grain_bundle", zip), size: zip.length, at });
const noWait = async () => {};

test("a bundle goes up in pieces of at most 256 KiB, each where the last ended, and is held pending on the statement", async () => {
  const reg = registry();
  const node = counted(reg);
  const zip = zipOf(3 * BLOB_PIECE + 1000);
  const progress = [];
  const put = await putBundle(node, zip, { upload: statementFor(zip), onProgress: (r, s) => progress.push([r, s]), pause: noWait });
  assert.equal(put.pending, true);
  assert.equal(put.pieces, 4);
  assert.equal(put.resumed, 0);
  const puts = node.calls.filter((c) => c.method === "blob_put");
  assert.deepEqual(puts.map((c) => c.params.from), [0, BLOB_PIECE, 2 * BLOB_PIECE, 3 * BLOB_PIECE]);
  for (const c of puts) {
    assert.ok(Buffer.from(c.params.data, "base64").length <= BLOB_PIECE);
    assert.equal(c.params.size, zip.length);
    assert.match(c.params.upload, /^[0-9a-f]+$/);
  }
  assert.deepEqual(progress.at(-1), [zip.length, zip.length]);
  assert.ok(progress.every(([r], i) => i === 0 || r >= progress[i - 1][0]), "progress only grows");
  assert.equal(reg.blobs.get(put.hash).pendingUntil, NOW + 24 * 3_600_000);
  assert.equal(await blobHeld(node, "grain_bundle", put.hash), "held");
  // The bytes come back as they went up, a piece at a time.
  const { blob } = await getBlob(node, "grain_bundle", put.hash, { from: 5, len: 10 });
  assert.deepEqual(blob.data, zip.subarray(5, 15));
  // Sent again: the node holds it, and the first piece ends the upload.
  const again = counted(reg);
  await putBundle(again, zip, { upload: statementFor(zip), pause: noWait });
  assert.equal(again.calls.filter((c) => c.method === "blob_put").length, 1);
});

test("on offset the upload goes on from where the node stands: a lost session from 0, a lost piece from received", async () => {
  const reg = registry();
  const zip = zipOf(4 * BLOB_PIECE);
  let n = 0;
  reg.blobPutHook = () => {
    n++;
    // The third piece is lost on the way: the node says where it stands.
    return n === 3 ? { reason: "offset", received: 2 * BLOB_PIECE } : undefined;
  };
  const node = counted(reg);
  const put = await putBundle(node, zip, { upload: statementFor(zip), pause: noWait });
  assert.equal(put.resumed, 1);
  // The ZIP's headers make it a little longer than 4 pieces: a fifth, short one.
  assert.deepEqual(node.calls.filter((c) => c.method === "blob_put").map((c) => c.params.from), [0, BLOB_PIECE, 2 * BLOB_PIECE, 2 * BLOB_PIECE, 3 * BLOB_PIECE, 4 * BLOB_PIECE]);
  // A failover to a node that never saw the upload: it answers offset with 0, and the upload starts over there.
  const other = registry();
  const zip2 = zipOf(2 * BLOB_PIECE + 5);
  let first = true;
  const switching = {
    calls: [],
    call(method, params) {
      this.calls.push({ method, from: params.from });
      // The first node took the first piece, then went away; the second answers from then on.
      if (first && method === "blob_put") {
        first = false;
        return reg.call(method, params);
      }
      return other.call(method, params);
    },
  };
  const moved = await putBundle(switching, zip2, { upload: statementFor(zip2), pause: noWait });
  assert.equal(moved.resumed, 1);
  assert.deepEqual(switching.calls.map((c) => c.from), [0, BLOB_PIECE, 0, BLOB_PIECE, 2 * BLOB_PIECE]);
  assert.ok(other.blobs.has(moved.hash));
});

test("busy and rate_limited are waited out, a network that does not answer is tried again, patience has an end", async () => {
  const reg = registry();
  const zip = zipOf(BLOB_PIECE + 10);
  const refusals = ["busy", "rate_limited", "busy"];
  reg.blobPutHook = () => {
    const reason = refusals.shift();
    return reason ? { reason } : undefined;
  };
  const waits = [];
  const put = await putBundle(reg, zip, { upload: statementFor(zip), pause: async (ms) => { waits.push(ms); } });
  assert.equal(put.retries, 3);
  assert.deepEqual(waits, [2000, 4000, 8000], "waits that grow");
  // Nothing answers twice, then the node does.
  let down = 2;
  const flaky = { call: (m, p) => (m === "blob_put" && down-- > 0 ? Promise.reject(new Error("fetch failed")) : reg.call(m, p)) };
  const zip2 = zipOf(100);
  assert.equal((await putBundle(flaky, zip2, { upload: statementFor(zip2), pause: noWait })).retries, 2);
  // Busy for good: it gives up once its patience is over, with the node's reason.
  let clock = 0;
  reg.blobPutHook = () => ({ reason: "busy" });
  const zip3 = zipOf(100);
  await assert.rejects(
    putBundle(reg, zip3, { upload: statementFor(zip3), pause: async (ms) => { clock += ms; }, now: () => clock, patienceMs: 60_000 }),
    (e) => e instanceof BlobRefused && e.reason === "busy",
  );
});

test("every other refusal ends the upload with the node's reason", async () => {
  const zip = zipOf(1000);
  for (const reason of ["pending", "full", "store", "kind", "hash"]) {
    const reg = registry();
    reg.blobPutHook = () => ({ reason });
    await assert.rejects(putBundle(reg, zip, { upload: statementFor(zip), pause: noWait }), (e) => e instanceof BlobRefused && e.reason === reason, reason);
  }
  // The statement, as the node checks it against its registry.
  await assert.rejects(putBundle(registry({ servers: ["22".repeat(32)] }), zip, { upload: statementFor(zip), pause: noWait }), (e) => e.reason === "key");
  await assert.rejects(putBundle(registry(), zip, { upload: statementFor(zip, NOW + 600_001), pause: noWait }), (e) => e.reason === "time");
  await assert.rejects(putBundle(registry(), zip, { upload: statementFor(zip, NOW - 24 * 3_600_000), pause: noWait }), (e) => e.reason === "time");
  await assert.rejects(putBundle(registry({ registered: false }), zip, { upload: statementFor(zip), pause: noWait }), (e) => e.reason === "slug");
  await assert.rejects(putBundle(registry(), zip, { upload: statementFor(zip, NOW, serverSecret, "other-game"), pause: noWait }), (e) => e.reason === "slug");
  const forged = { ...statementFor(zip), key: serverKey, signature: toHex(ed25519.sign(new Uint8Array(32), serverSecret)) };
  await assert.rejects(putBundle(registry(), zip, { upload: forged, pause: noWait }), (e) => e.reason === "signature");
  // Without a statement, only a bundle the registry names.
  await assert.rejects(putBundle(registry(), zip, { pause: noWait }), (e) => e.reason === "not_named");
  // A statement for other bytes is refused here, before anything is sent.
  const nothing = counted(registry());
  await assert.rejects(putBundle(nothing, zip, { upload: statementFor(zipOf(10)) }), (e) => e.reason === "hash");
  // A bundle no wallet would unpack is refused here too, with the bundle check's reason.
  await assert.rejects(putBundle(nothing, new TextEncoder().encode("not a zip"), {}), (e) => e.reason === "check" && e.detail === "format");
  assert.equal(nothing.calls.length, 0);
  // A node's error with no reason is the node's: not swallowed.
  await assert.rejects(putBundle({ call: () => Promise.reject(new RpcError("blob_put", -32602, "data: the bytes in base64")) }, zip, {}), RpcError);
});

test("a bundle the registry names goes up without a statement; not_named is waited out while the node catches up", async () => {
  const reg = registry();
  const zip = zipOf(BLOB_PIECE * 2);
  const owner = toHex(accountId(ed25519.getPublicKey(ownerSecret)));
  const hash = namedHash("grain_bundle", zip);
  const manifest = {
    slug: "space-game", version: 2, owner, owner_key: { ed25519: toHex(ed25519.getPublicKey(ownerSecret)) }, name: { en: "Space" },
    description: {}, icon: v.images[0].hash, entry: { sealed: { bundle: hash, size: zip.length, sources: ["https://relay.example/_blob/grain_bundle/" + hash], start: "index.html", connect: [] } },
    permissions: 0, sponsor: null, min_host: 1,
  };
  // The node is a block behind: not_named twice, then it names it.
  let behind = 2;
  reg.blobPutHook = () => (behind-- > 0 ? { reason: "not_named" } : undefined);
  reg.publish(signManifest(manifest, ownerSecret));
  let clock = 0;
  const put = await putBundle(reg, zip, { pause: async (ms) => { clock += ms; }, now: () => clock, namedGraceMs: 60_000 });
  assert.equal(put.pending, false);
  assert.equal(reg.blobs.get(hash).pendingUntil, null);
  // Without grace, not_named ends it at once.
  const fresh = registry();
  await assert.rejects(putBundle(fresh, zip, { pause: noWait }), (e) => e.reason === "not_named");
  // The icon, once named: checked here first, then whole.
  const icon = fromHex(v.images[0].hex);
  assert.equal((await putIcon(reg, icon, { pause: noWait })).hash, v.images[0].hash);
  assert.equal(await blobHeld(reg, "grain_icon", v.images[0].hash), "held");
  await assert.rejects(putIcon(fresh, icon, { pause: noWait }), (e) => e.reason === "not_named");
  await assert.rejects(putIcon(reg, fromHex(v.refused[0].hex), { pause: noWait }), (e) => e.reason === "check" && e.detail === "alpha");
});

test("an upload that does not move is stopped, not looped", async () => {
  const reg = registry();
  const zip = zipOf(BLOB_PIECE * 2);
  // A node that always says it holds nothing: offset 0, forever.
  reg.blobPutHook = (p) => (p.from > 0 ? { reason: "offset", received: 0 } : undefined);
  await assert.rejects(putBundle(reg, zip, { upload: statementFor(zip), pause: noWait }), (e) => e instanceof BlobRefused && e.reason === "stuck");
});
