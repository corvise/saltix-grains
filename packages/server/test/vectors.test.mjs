// vectors/grains-v1.json: what the node signs and hashes, this SDK reproduces and checks.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import {
  encodeManifest, manifestId, manifestMessage, verifyManifest, signManifest, iconHash, bundleHash, manifestProblem,
  loginMessage, verifyLogin, decodeInvoice, invoiceMessage, invoiceProblem, signInvoice, issueInvoiceKeyCert, memoText,
  referenceInMemo, toHex, fromHex, isChatOnly,
} from "../dist/index.js";

const v = JSON.parse(readFileSync(new URL("../../../vectors/grains-v1.json", import.meta.url), "utf8"));

test("manifests: Borsh, id, message and the owner's signature", () => {
  for (const c of v.manifests) {
    const m = c.json.manifest;
    assert.equal(toHex(encodeManifest(m)), c.borsh, c.name);
    assert.equal(manifestId(m), c.id);
    assert.equal(toHex(manifestMessage(m)), c.message);
    assert.equal(manifestProblem(m), null);
    assert.ok(verifyManifest(c.json));
    // Ed25519 is deterministic: the owner's secret signs the same bytes again. A managed owner's phone signs with
    // P-256 in its wallet.
    if ("ed25519" in m.owner_key) assert.deepEqual(signManifest(m, fromHex(v.owner_secret, 32)), c.json);
    else assert.throws(() => signManifest(m, fromHex(v.owner_secret, 32)), /owner_key/);
    assert.ok(!verifyManifest({ ...c.json, manifest: { ...m, version: m.version + 1 } }));
    assert.ok(!verifyManifest({ ...c.json, manifest: { ...m, owner: "22".repeat(32) } }), "the owner is signed");
  }
  const managed = v.manifests.find((c) => c.name === "managed").json.manifest;
  assert.ok("p256" in managed.owner_key);
  // A chat-only grain (24-app-studio §2): no page, no origin, notifications only.
  const chat = v.manifests.find((c) => c.name === "chat").json.manifest;
  assert.deepEqual(chat.entry, { chat: {} });
  assert.ok(isChatOnly(chat));
  assert.equal(manifestProblem({ ...chat, permissions: 4 | 1 }), "entry", "a chat-only grain asks for notifications only");
  assert.equal(manifestProblem({ ...chat, permissions: 0 }), null);
  assert.equal(manifestProblem({ ...chat, entry: { chat: { origins: [] } } }), "entry", "an empty object only");
  assert.equal(manifestProblem({ ...chat, entry: { page: {} } }), "entry");
  // The owner key's JSON names one kind, in lowercase hex of its length.
  for (const owner_key of [{ p256: "ab".repeat(32) }, { ed25519: "AB".repeat(32) }, { rsa: "ab".repeat(32) }, "ab".repeat(32)]) {
    assert.equal(manifestProblem({ ...managed, owner_key }), "owner_key");
  }
  assert.equal(iconHash(new TextEncoder().encode(v.hashes.icon_of)), v.hashes.icon);
  assert.equal(bundleHash(new TextEncoder().encode(v.hashes.bundle_of)), v.hashes.bundle);
});

test("the login a wallet signs is checked by the server", () => {
  const l = v.login;
  assert.equal(toHex(loginMessage(l.slug, l.origin, fromHex(l.challenge), l.at)), l.message);
  const answer = { key: l.key, signature: l.signature, at: l.at, origin: l.origin };
  const expected = { slug: "chess", origin: "https://chess.example", challenge: l.challenge, now: l.at };
  assert.ok(verifyLogin(answer, expected));
  assert.ok(!verifyLogin(answer, { ...expected, slug: "go-game" }));
  assert.ok(!verifyLogin(answer, { ...expected, origin: "https://evil.example" }));
  assert.ok(!verifyLogin(answer, { ...expected, challenge: "00" }));
  assert.ok(!verifyLogin(answer, { ...expected, now: l.at + 5 * 60_000 + 1 }));
  assert.ok(!verifyLogin({ ...answer, key: "00".repeat(32) }, expected));
});

test("invoices by the owner and by a certified key", () => {
  const inv = v.invoices;
  const owner = { ed25519: inv.owner_key };
  for (const c of inv.cases) {
    const { invoice, cert } = decodeInvoice(c.signed_borsh);
    assert.equal(toHex(invoiceMessage(invoice, inv.genesis_hash)), c.message, c.name);
    assert.equal(invoiceProblem(c.signed_borsh, "chess", owner, inv.genesis_hash, inv.now), null);
    assert.equal(memoText(invoice), c.memo_text);
    assert.equal(referenceInMemo(c.memo_text), invoice.reference);
    // The same bytes from this SDK.
    const secret = cert ? fromHex(inv.server_secret, 32) : fromHex(v.owner_secret, 32);
    assert.equal(signInvoice(invoice, secret, inv.genesis_hash, cert ?? undefined), c.signed_borsh);
    assert.equal(invoiceProblem(c.signed_borsh, "go-game", owner, inv.genesis_hash, inv.now), "grain");
    assert.equal(invoiceProblem(c.signed_borsh, "chess", owner, inv.genesis_hash, invoice.expires_at), "expired");
    assert.equal(invoiceProblem(c.signed_borsh, "chess", owner, "00".repeat(32), inv.now), "signature");
  }
  const cert = issueInvoiceKeyCert(fromHex(v.owner_secret, 32), "chess", inv.cert.key, inv.cert.expires_at);
  assert.deepEqual(cert, inv.cert);
  assert.equal(toHex(ed25519.getPublicKey(fromHex(inv.server_secret, 32))), inv.cert.key);
  assert.equal(referenceInMemo("for lunch"), null);
});

test("a managed owner's phone certifies the server key with P-256", () => {
  const inv = v.invoices;
  const managed = v.manifests.find((c) => c.name === "managed").json.manifest;
  const c = inv.phone_cert;
  const cert = { slug: c.slug, key: c.key, expires_at: c.expires_at, signature: c.signature };
  const invoice = {
    slug: "club", to: managed.owner, asset: "SALT", amount: 1n, memo: "", reference: "01".repeat(16), expires_at: inv.now + 1,
  };
  const signed = signInvoice(invoice, fromHex(inv.server_secret, 32), inv.genesis_hash, cert);
  assert.equal(invoiceProblem(signed, "club", managed.owner_key, inv.genesis_hash, inv.now), null);
  // Not another owner key's certificate.
  assert.equal(invoiceProblem(signed, "club", { ed25519: inv.owner_key }, inv.genesis_hash, inv.now), "cert");
  // A high s is refused: the phone's signature has one encoding (13-accounts §6.1).
  const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const s = BigInt("0x" + c.signature.slice(64));
  const high = c.signature.slice(0, 64) + (n - s).toString(16).padStart(64, "0");
  const flipped = signInvoice(invoice, fromHex(inv.server_secret, 32), inv.genesis_hash, { ...cert, signature: high });
  assert.equal(invoiceProblem(flipped, "club", managed.owner_key, inv.genesis_hash, inv.now), "cert");
});
