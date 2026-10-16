// A manifest on its way to the owner's phone (Saltix 12-grains §10, 22-grain-chats §4): the publishing link's text, read
// strictly by every reader, and the raw DEFLATE decoder behind it, held to Node's zlib.
import test from "node:test";
import assert from "node:assert/strict";
import { constants, deflateRawSync, inflateRawSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import {
  encodeManifest, decodeManifest, readPublishText, readPublishLink, publishText, publishLink, publishTextOf, toBase64, toHex,
  PublishTextError, UNOWNED, MAX_PUBLISH_TEXT, MAX_PUBLISH_MANIFEST, PUBLISH_LINK_PREFIX, card,
} from "../dist/index.js";
import { inflateRaw } from "../dist/inflate.js";

const manifest = (over = {}) => ({
  slug: "passgen", version: 2, owner: "aa".repeat(32), owner_key: { ed25519: "bb".repeat(32) }, name: { en: "Saltix Pass", ru: "Saltix Pass" },
  description: { en: "Access keys for the closed sites." }, icon: "07".repeat(32),
  entry: { sealed: { bundle: "09".repeat(32), size: 154_240, sources: ["https://download.saltix.io/apps/screens/x.zip"], start: "index.html", connect: ["https://api.saltix.io"] } },
  permissions: 0, sponsor: null, min_host: 1, ...over,
});
const unowned = (m) => ({ ...m, ...UNOWNED });
const pack = (bytes, options = {}) => toBase64(new Uint8Array(deflateRawSync(bytes, options)), true);
const problem = (text) => {
  try {
    readPublishText(text);
    return null;
  } catch (e) {
    assert.ok(e instanceof PublishTextError, String(e));
    return e.problem;
  }
};

test("the inflater reads what zlib writes, at every level and strategy", () => {
  const sources = [
    new Uint8Array(0),
    new TextEncoder().encode("a"),
    new Uint8Array(70_000).fill(0x41), // past one stored block's 65 535 bytes
    randomBytes(5_000), // incompressible: stored blocks
    new TextEncoder().encode("Saltix Pass: one-time access keys. ".repeat(300)),
  ];
  for (let i = 0; i < 40; i++) {
    // Text of a few hundred symbols with repeats: dynamic codes of every shape.
    const alphabet = 2 + (i % 30);
    const n = 1 + Math.floor(Math.random() * 20_000);
    const b = new Uint8Array(n);
    for (let j = 0; j < n; j++) b[j] = j > 10 && Math.random() < 0.3 ? b[j - 1 - Math.floor(Math.random() * 10)] : 97 + Math.floor(Math.random() * alphabet);
    sources.push(b);
  }
  const strategies = [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED, constants.Z_HUFFMAN_ONLY, constants.Z_RLE, constants.Z_FIXED];
  for (const source of sources) {
    for (const level of [0, 1, 6, 9]) {
      for (const strategy of strategies) {
        const packed = new Uint8Array(deflateRawSync(source, { level, strategy }));
        const out = inflateRaw(packed, 80_000);
        assert.ok(out !== null, `level ${level}, strategy ${strategy}, ${source.length} bytes`);
        assert.equal(toHex(out), toHex(source));
      }
    }
  }
});

test("the inflater refuses what is not one whole stream within its limit", () => {
  const source = new TextEncoder().encode("Saltix Pass ".repeat(100));
  const packed = new Uint8Array(deflateRawSync(source, { level: 9 }));
  assert.equal(toHex(inflateRaw(packed, source.length)), toHex(source), "exactly the limit");
  assert.equal(inflateRaw(packed, source.length - 1), null, "a byte past it");
  for (let cut = 0; cut < packed.length; cut++) assert.equal(inflateRaw(packed.subarray(0, cut), 10_000), null, `cut at ${cut}`);
  assert.equal(inflateRaw(new Uint8Array([...packed, 0]), 10_000), null, "a byte after the last block");
  assert.equal(inflateRaw(new Uint8Array([0x07]), 10), null, "block type 3");
  // A stored block whose length's complement does not match.
  assert.equal(inflateRaw(new Uint8Array([0x01, 0x01, 0x00, 0xff, 0xff, 0x41]), 10), null);
  assert.equal(toHex(inflateRaw(new Uint8Array([0x01, 0x01, 0x00, 0xfe, 0xff, 0x41]), 10)), "41");
  // Fixed codes: the literal "a", a copy of 3 from 1 back, the end — and the same copy with nothing before it.
  const copy = new Uint8Array([0x4b, 0x04, 0x02, 0x00]);
  assert.equal(new TextDecoder().decode(inflateRawSync(copy)), "aaaa", "zlib reads it so");
  assert.equal(new TextDecoder().decode(inflateRaw(copy, 10)), "aaaa");
  assert.equal(inflateRaw(new Uint8Array([0x03, 0x02, 0x00]), 10), null, "a distance before the start");
  assert.equal(inflateRaw(new Uint8Array(deflateRawSync(new Uint8Array(0))), 0)?.length, 0, "an empty stream");
  let fuzzed = 0;
  for (let i = 0; i < 2_000; i++) {
    const bytes = randomBytes(1 + (i % 64));
    const out = inflateRaw(bytes, 4_096);
    if (out !== null) fuzzed++;
    assert.ok(out === null || out.length <= 4_096);
  }
  assert.ok(fuzzed < 2_000, "random bytes are rarely a stream");
});

test("a manifest's text reads back with its owner left out, whoever compressed it", () => {
  const m = manifest();
  const text = publishText(m);
  assert.ok(text.length <= MAX_PUBLISH_TEXT && /^[A-Za-z0-9_-]+$/.test(text));
  assert.deepEqual(readPublishText(text), unowned(m));
  assert.equal(publishLink(m), PUBLISH_LINK_PREFIX + text);
  assert.deepEqual(readPublishLink(publishLink(m)), unowned(m));
  assert.equal(publishTextOf(publishLink(m)), text);
  assert.equal(publishTextOf(text), text);
  assert.deepEqual(readPublishText(pack(encodeManifest(unowned(m)), { level: 0 })), unowned(m), "stored blocks too");
  assert.deepEqual(decodeManifest(encodeManifest(m)), m);
});

test("a manifest's text out of form is refused, as the protocol's reader refuses it", () => {
  const m = unowned(manifest());
  const borsh = encodeManifest(m);
  const text = publishText(m);
  assert.equal(problem(""), "size");
  assert.equal(problem("A".repeat(MAX_PUBLISH_TEXT + 1)), "size");
  assert.equal(problem(`${text}=`), "encoding", "padding");
  assert.equal(problem("ab+/"), "encoding", "the standard alphabet");
  assert.equal(problem(`${text} `), "encoding");
  assert.equal(problem("AB"), "encoding", "bits past the last byte");
  assert.equal(problem(toBase64(new Uint8Array(8).fill(0xff), true)), "inflate");
  assert.equal(problem(pack(new Uint8Array(MAX_PUBLISH_MANIFEST + 1))), "inflate", "past 16 384 bytes inflated");
  const packed = new Uint8Array(deflateRawSync(borsh, { level: 9 }));
  assert.equal(problem(toBase64(new Uint8Array([...packed, 0]), true)), "inflate", "a byte after the stream");
  assert.equal(problem(pack(new TextEncoder().encode("not a manifest"))), "manifest");
  assert.equal(problem(pack(new Uint8Array([...borsh, 0]))), "manifest", "bytes after the manifest");
  // A map out of order: Borsh reads it, but it is not the canonical form.
  const two = { ...m, name: { en: "A", ru: "Б" } };
  const canonical = encodeManifest(two);
  const enEntry = [2, 0, 0, 0, 101, 110, 1, 0, 0, 0, 65];
  const ruEntry = [2, 0, 0, 0, 114, 117, 2, 0, 0, 0, 0xd0, 0x91];
  const at = toHex(canonical).indexOf(toHex(new Uint8Array(enEntry))) / 2;
  const swapped = new Uint8Array([...canonical.subarray(0, at), ...ruEntry, ...enEntry, ...canonical.subarray(at + enEntry.length + ruEntry.length)]);
  assert.equal(problem(pack(swapped)), "manifest");
  assert.deepEqual(readPublishText(pack(canonical)), two);
  assert.equal(problem(pack(encodeManifest(manifest()))), "owned");
  assert.equal(problem(pack(encodeManifest({ ...m, owner: "aa".repeat(32) }))), "owned", "an owner alone");
  assert.equal(problem(pack(encodeManifest({ ...m, owner_key: { ed25519: "bb".repeat(32) } }))), "owned", "an owner key alone");
  assert.equal(problem(pack(encodeManifest({ ...m, owner_key: { p256: "02" + "00".repeat(32) } }))), "owned", "a P-256 key");
  assert.throws(() => readPublishLink(text), (e) => e instanceof PublishTextError && e.problem === "link");
  // Too large for a link: written by nobody.
  const scattered = (seed) => Array.from({ length: 200 }, (_, i) => String.fromCodePoint(0x4e00 + ((i * 7919 + seed * 104729) % 20000))).join("");
  const huge = manifest({ description: Object.fromEntries(["en", "ru", "de", "fr", "es", "it", "pt", "pl"].map((l, k) => [l, scattered(k)])) });
  assert.throws(() => publishText(huge), /key file/);
});

test("a card proposes an update by its link, its text or the manifest itself", () => {
  const m = manifest();
  const text = publishText(m);
  const none = () => undefined;
  assert.deepEqual(card().text("x").publish("Review", publishLink(m)).actions(none), [{ label: "Review", kind: { publish: { manifest: text } } }]);
  assert.deepEqual(card().text("x").publish("Review", text).actions(none), [{ label: "Review", kind: { publish: { manifest: text } } }]);
  assert.throws(() => card().text("x").publish("Review", m).actions(none), /ChatServer/, "a manifest needs packing");
  assert.deepEqual(card().text("x").publish("Review", m).actions(none, publishText), [{ label: "Review", kind: { publish: { manifest: text } } }]);
});
