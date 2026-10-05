// vectors/grains-v1.json: what the node signs and hashes, this SDK reproduces and checks.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import {
  encodeManifest, manifestId, manifestMessage, verifyManifest, signManifest, iconHash, bundleHash, manifestProblem,
  loginMessage, verifyLogin, decodeInvoice, invoiceMessage, invoiceProblem, signInvoice, issueInvoiceKeyCert, memoText,
  referenceInMemo, toHex, fromHex,
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
    // Ed25519 is deterministic: the owner's secret signs the same bytes again.
    assert.deepEqual(signManifest(m, fromHex(v.owner_secret, 32)), c.json);
    assert.ok(!verifyManifest({ ...c.json, manifest: { ...m, version: m.version + 1 } }));
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
  for (const c of inv.cases) {
    const { invoice, cert } = decodeInvoice(c.signed_borsh);
    assert.equal(toHex(invoiceMessage(invoice, inv.genesis_hash)), c.message, c.name);
    assert.equal(invoiceProblem(c.signed_borsh, "chess", inv.owner_key, inv.genesis_hash, inv.now), null);
    assert.equal(memoText(invoice), c.memo_text);
    assert.equal(referenceInMemo(c.memo_text), invoice.reference);
    // The same bytes from this SDK.
    const secret = cert ? fromHex(inv.server_secret, 32) : fromHex(v.owner_secret, 32);
    assert.equal(signInvoice(invoice, secret, inv.genesis_hash, cert ?? undefined), c.signed_borsh);
    assert.equal(invoiceProblem(c.signed_borsh, "go-game", inv.owner_key, inv.genesis_hash, inv.now), "grain");
    assert.equal(invoiceProblem(c.signed_borsh, "chess", inv.owner_key, inv.genesis_hash, invoice.expires_at), "expired");
    assert.equal(invoiceProblem(c.signed_borsh, "chess", inv.owner_key, "00".repeat(32), inv.now), "signature");
  }
  const cert = issueInvoiceKeyCert(fromHex(v.owner_secret, 32), "chess", inv.cert.key, inv.cert.expires_at);
  assert.deepEqual(cert, inv.cert);
  assert.equal(toHex(ed25519.getPublicKey(fromHex(inv.server_secret, 32))), inv.cert.key);
  assert.equal(referenceInMemo("for lunch"), null);
});
