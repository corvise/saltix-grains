// vectors/images-v1.json (Saltix 32-images): the named blobs' kinds and hashes, the image check and the bundle check
// with every refusal, the server key's statement for a pending bundle (Borsh, message, signature, refusals), and the
// frames that carry them, reproduced byte for byte.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import {
  BLOB_PIECE, MAX_ICON_BYTES, MAX_NETWORK_BUNDLE_BYTES, NAMED_KINDS, NAMED_REASONS, PENDING_MS, bundleUploadMessage, bundleUploadNames,
  bundleUploadProblem, checkBundle, checkImage, decodeSignedBundleUpload, encodeBundleUpload, encodeSignedBundleUpload, fromBase64,
  fromHex, iconHash, bundleHash, manifestProblem, monogramColour, namedHash, namedProblem, pendingUntil, signBundleUpload, toBase64, toHex,
} from "../dist/index.js";

const v = JSON.parse(readFileSync(new URL("../../../vectors/images-v1.json", import.meta.url), "utf8"));
const hex = (h) => fromHex(h);

test("kinds: their tags, names, hash domains, bounds, types and sides", () => {
  assert.equal(v.kinds.length, 3);
  for (const k of v.kinds) {
    const ours = NAMED_KINDS[k.name];
    assert.ok(ours, k.name);
    assert.equal(ours.tag, k.tag);
    assert.equal(ours.domain, k.domain);
    assert.equal(ours.maxBytes, k.max_bytes);
    assert.equal(ours.type, k.type);
    assert.deepEqual([...ours.sides], k.sides ?? []);
  }
  assert.equal(MAX_ICON_BYTES, 65_536);
  assert.equal(MAX_NETWORK_BUNDLE_BYTES, 16 * 1024 * 1024);
  assert.equal(BLOB_PIECE, v.bundle_frames.piece_bytes_at_most);
});

test("images each kind takes: the check passes with their sides, and their hashes", () => {
  assert.ok(v.images.length >= 4);
  for (const img of v.images) {
    const bytes = hex(img.hex);
    assert.equal(bytes.length, img.bytes, img.name);
    const checked = checkImage(img.kind, bytes);
    assert.deepEqual(checked, { ok: true, value: { width: img.width, height: img.height } }, img.name);
    assert.equal(namedHash(img.kind, bytes), img.hash, img.name);
    assert.equal(namedProblem(img.kind, bytes), null);
    if (img.kind === "grain_icon") assert.equal(iconHash(bytes), img.hash, "the manifest's icon hash is the named blob's");
    // The other image kind refuses it: another format and other sides.
    assert.notEqual(namedProblem(img.kind === "grain_icon" ? "avatar" : "grain_icon", bytes), null);
  }
});

test("images the check refuses, each for its reason", () => {
  assert.ok(v.refused.length >= 20);
  const reasons = new Set();
  for (const r of v.refused) {
    const checked = checkImage(r.kind, hex(r.hex));
    assert.deepEqual(checked, { ok: false, reason: r.reason }, r.name);
    assert.ok(NAMED_REASONS[r.reason], `words for ${r.reason}`);
    reasons.add(r.reason);
  }
  for (const reason of ["size", "format", "dimensions", "depth", "alpha", "metadata", "animation"]) assert.ok(reasons.has(reason), reason);
  // Over the kind's bound: refused as size before anything is read.
  assert.deepEqual(checkImage("grain_icon", new Uint8Array(MAX_ICON_BYTES + 1)), { ok: false, reason: "size" });
});

test("an icon of every side but the kind's is refused: 512 and 256 only, square", () => {
  const standard = hex(v.images.find((i) => i.kind === "grain_icon" && i.width === 512).hex);
  // The same PNG with its IHDR's width or height changed (and the CRC made right again) is refused as dimensions.
  const resized = (w, h) => {
    const b = Uint8Array.from(standard);
    const view = new DataView(b.buffer);
    view.setUint32(16, w);
    view.setUint32(20, h);
    let c = 0xffffffff;
    for (const x of b.subarray(12, 29)) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    view.setUint32(29, (c ^ 0xffffffff) >>> 0);
    return b;
  };
  for (const [w, h] of [[511, 511], [513, 513], [512, 256], [1024, 1024], [128, 128], [640, 640]]) {
    assert.deepEqual(checkImage("grain_icon", resized(w, h)), { ok: false, reason: "dimensions" }, `${w} × ${h}`);
  }
  assert.equal(checkImage("grain_icon", resized(512, 512)).ok, true);
});

test("the monogram's colour from the slug", () => {
  for (const m of v.monogram) assert.equal(monogramColour(m.slug), m.colour, m.slug);
});

test("bundles: as grain bundle writes them and as other tools do, with the check's counts and their hashes", () => {
  for (const b of v.bundles.made) {
    const bytes = hex(b.hex);
    assert.equal(bytes.length, b.bytes);
    assert.deepEqual(checkBundle(bytes), { ok: true, value: { files: b.files, unpacked: b.unpacked } }, b.name);
    assert.equal(namedHash("grain_bundle", bytes), b.hash);
    assert.equal(bundleHash(bytes), b.hash);
  }
});

test("bundles the check refuses, each for its reason", () => {
  for (const r of v.bundles.refused) {
    assert.deepEqual(checkBundle(hex(r.hex)), { ok: false, reason: r.reason }, r.name);
  }
  // Past the network's 16 MiB: size, though a wallet takes up to 20 MiB from a source.
  const made = hex(v.bundles.made[0].hex);
  assert.deepEqual(checkBundle(new Uint8Array(MAX_NETWORK_BUNDLE_BYTES + 1)), { ok: false, reason: "size" });
  assert.equal(checkBundle(made, 20 * 1024 * 1024).ok, true);
});

test("the server key's statement: Borsh, the message under the genesis, the signature and its encoding", () => {
  const u = v.uploads.upload;
  const upload = { slug: u.slug, bundle: u.bundle, size: u.size, at: u.at };
  assert.equal(toHex(encodeBundleUpload(upload)), u.borsh_hex);
  assert.equal(toHex(bundleUploadMessage(v.uploads.genesis_hash, upload)), u.message_hex);
  const secret = hex(v.uploads.server_key_private_hex);
  assert.equal(toHex(ed25519.getPublicKey(secret)), v.uploads.server_key);
  const signed = signBundleUpload(secret, v.uploads.genesis_hash, upload);
  assert.equal(signed.signature, u.signature_hex);
  assert.equal(signed.key, v.uploads.server_key);
  assert.equal(toHex(encodeSignedBundleUpload(signed)), u.encoded_hex);
  assert.deepEqual(decodeSignedBundleUpload(hex(u.encoded_hex)), signed);
  assert.equal(pendingUntil(upload), u.until);
  assert.equal(u.until - u.at, PENDING_MS);
  // A node takes it: a live grain naming the key, in its day, for the bundle it names.
  assert.equal(bundleUploadProblem(signed, v.uploads.genesis_hash, [v.uploads.server_key], u.at), null);
  assert.equal(bundleUploadNames(signed, u.bundle, u.size), null);
  assert.equal(bundleUploadNames(signed, u.bundle, u.size + 1), "size");
  assert.equal(bundleUploadNames(signed, "00".repeat(32), u.size), "hash");
  // On another network it means nothing.
  assert.equal(bundleUploadProblem(signed, "00".repeat(32), [v.uploads.server_key], u.at), "signature");
  // Strict decoding: nothing after it, nothing longer than a statement can be.
  assert.throws(() => decodeSignedBundleUpload(hex(u.encoded_hex + "00")), /bytes left over|too long/);
  assert.throws(() => decodeSignedBundleUpload(hex(u.encoded_hex.slice(0, -2))), /short/);
});

test("statements a node refuses, each for its reason", () => {
  for (const r of v.uploads.refused) {
    const s = decodeSignedBundleUpload(hex(r.encoded_hex));
    const servers = /no live grain/.test(r.name) ? null : [v.uploads.server_key];
    assert.equal(bundleUploadProblem(s, v.uploads.genesis_hash, servers, r.now), r.reason, r.name);
  }
  const signed = decodeSignedBundleUpload(hex(v.uploads.upload.encoded_hex));
  assert.equal(bundleUploadProblem({ ...signed, upload: { ...signed.upload, size: MAX_NETWORK_BUNDLE_BYTES + 1 } }, v.uploads.genesis_hash, [signed.key], signed.upload.at), "size");
  assert.equal(bundleUploadProblem({ ...signed, upload: { ...signed.upload, slug: "No" } }, v.uploads.genesis_hash, [signed.key], signed.upload.at), "slug");
  // Its last millisecond counts; the next does not.
  assert.equal(bundleUploadProblem(signed, v.uploads.genesis_hash, [signed.key], pendingUntil(signed.upload) - 1), null);
  assert.equal(bundleUploadProblem(signed, v.uploads.genesis_hash, [signed.key], signed.upload.at - 600_000), null, "10 minutes ahead is taken");
});

test("the frames: blob_put's pieces, its answers and refusals, blob_get and the HTTP read", () => {
  const f = v.bundle_frames;
  const zip = hex(v.bundles.made[0].hex);
  const hash = v.bundles.made[0].hash;
  for (const [frame, from] of [[f.blob_put_first, 0], [f.blob_put_last, f.blob_put_first_result.received]]) {
    assert.equal(frame.method, "blob_put");
    const p = frame.params;
    assert.deepEqual(Object.keys(p).sort(), ["data", "from", "hash", "kind", "size", "upload"]);
    assert.equal(p.kind, "grain_bundle");
    assert.equal(p.hash, hash);
    assert.equal(p.size, zip.length);
    assert.equal(p.from, from);
    assert.equal(p.upload, v.uploads.upload.encoded_hex);
    // Standard base64 of the piece from `from`.
    const piece = fromBase64(p.data);
    assert.deepEqual(piece, zip.subarray(from, from + piece.length));
    assert.equal(toBase64(piece), p.data);
  }
  assert.deepEqual(f.blob_put_first_result, { hash, kept: false, kind: "grain_bundle", received: f.blob_put_last.params.from });
  assert.deepEqual(f.blob_put_last_result, { hash, kept: true, kind: "grain_bundle", pending: true, received: zip.length });
  assert.deepEqual(f.blob_put_offset, { code: -32602, data: { reason: "offset", received: 241 }, message: "the bundle is refused: offset" });
  const piece = fromBase64(f.blob_get_result.blob.data);
  assert.deepEqual(piece, zip.subarray(f.blob_get.params.from));
  assert.equal(f.http_get.path, `/_blob/grain_bundle/${hash}`);
  assert.equal(f.http_get.headers["Content-Type"], "application/zip");
  // Every reason blob_put gives is a word this SDK knows.
  assert.deepEqual(f.blob_put_reasons, ["kind", "not_named", "size", "format", "method", "files", "name", "unpacked", "hash", "slug", "key", "time", "signature", "offset", "busy", "pending", "full", "store", "rate_limited"]);
});

test("a sealed manifest without a source: taken from protocol version 2, refused before it; then of 16 MiB at most", () => {
  const grains = JSON.parse(readFileSync(new URL("../../../vectors/grains-v1.json", import.meta.url), "utf8"));
  const sealed = grains.manifests.find((c) => "sealed" in c.json.manifest.entry).json.manifest;
  const none = { ...sealed, entry: { sealed: { ...sealed.entry.sealed, sources: [] } } };
  assert.equal(manifestProblem(sealed, false, 1), null);
  assert.equal(manifestProblem(none, false, 1), "sources");
  assert.equal(manifestProblem(none, false, 2), null);
  assert.equal(manifestProblem(none), null, "a reader takes the newest rules");
  const big = { ...none, entry: { sealed: { ...none.entry.sealed, size: MAX_NETWORK_BUNDLE_BYTES + 1 } } };
  assert.equal(manifestProblem(big, false, 2), "size");
  assert.equal(manifestProblem({ ...big, entry: { sealed: { ...big.entry.sealed, sources: sealed.entry.sealed.sources } } }, false, 2), null, "with a source, up to 20 MiB");
});
