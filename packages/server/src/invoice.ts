import { ed25519 } from "@noble/curves/ed25519";
import { Reader, Writer, derive, fromHex, toHex } from "./bytes.js";
import { type DeviceKey, verifyByDeviceKey } from "./keys.js";

export type Asset = "SALT" | "WORK";

/** A payment your grain asks for (12-grains §5.2); `to` is an account id in hex, `amount` base units. */
export interface Invoice {
  slug: string;
  to: string;
  asset: Asset;
  amount: bigint;
  /** For the payment sheet: at most 200 bytes, no control characters. */
  memo: string;
  /** 16 bytes, hex: what you find the payment by. */
  reference: string;
  /** Unix ms. */
  expires_at: number;
}

/** A key the owner lets sign invoices for one grain, until `expires_at`. */
export interface InvoiceKeyCert {
  slug: string;
  key: string;
  expires_at: number;
  signature: string;
}

export function encodeInvoice(inv: Invoice): Uint8Array {
  if (new TextEncoder().encode(inv.memo).length > 200 || /\p{Cc}/u.test(inv.memo)) throw new TypeError("memo: at most 200 bytes, no control characters");
  return new Writer()
    .string(inv.slug)
    .fixed(fromHex(inv.to, 32), 32)
    .u8(inv.asset === "SALT" ? 0 : 1)
    .u64(inv.amount)
    .string(inv.memo)
    .fixed(fromHex(inv.reference, 16), 16)
    .u64(inv.expires_at)
    .done();
}

/** What the signer signs: the invoice on the network of `genesisHash` (hex). */
export function invoiceMessage(inv: Invoice, genesisHash: string): Uint8Array {
  return derive("Saltix grain invoice v1", fromHex(genesisHash, 32), encodeInvoice(inv));
}

function certMessage(slug: string, key: Uint8Array, expiresAt: number): Uint8Array {
  return derive("Saltix grain invoice key v1", new Writer().string(slug).fixed(key, 32).u64(expiresAt).done());
}

/** `Option<InvoiceKeyCert>` in Borsh, as invoices and notifications carry it. */
export function writeCert(w: Writer, cert: InvoiceKeyCert | null | undefined): Writer {
  if (!cert) return w.u8(0);
  return w.u8(1).string(cert.slug).fixed(fromHex(cert.key, 32), 32).u64(cert.expires_at).fixed(fromHex(cert.signature, 64), 64);
}

export function readCert(r: Reader): InvoiceKeyCert | null {
  const tag = r.u8();
  if (tag === 0) return null;
  if (tag !== 1) throw new TypeError("borsh: bad option");
  return { slug: r.string(64), key: toHex(r.fixed(32)), expires_at: Number(r.u64()), signature: toHex(r.fixed(64)) };
}

/**
 * Who may sign for `slug`: the manifest's owner key, or — with `cert` — the server key the owner key certified for
 * this grain (Ed25519, or P-256 for a managed owner's phone), until it expires; null when the certificate does not
 * hold. That the owner key still speaks for the owner is the wallet's to check (12-grains §5.2).
 */
export function signerOf(cert: InvoiceKeyCert | null, slug: string, ownerKey: DeviceKey, now: number): DeviceKey | null {
  if (!cert) return ownerKey;
  const ok = cert.slug === slug && cert.expires_at > now &&
    verifyByDeviceKey(ownerKey, certMessage(cert.slug, fromHex(cert.key, 32), cert.expires_at), cert.signature);
  return ok ? { ed25519: cert.key } : null;
}

/** Certify `key` (hex) to sign invoices of `slug` until `expiresAt`, with the owner key's Ed25519 secret. Do it once,
 *  offline. */
export function issueInvoiceKeyCert(ownerSecret: Uint8Array, slug: string, key: string, expiresAt: number): InvoiceKeyCert {
  const signature = toHex(ed25519.sign(certMessage(slug, fromHex(key, 32), expiresAt), ownerSecret));
  return { slug, key, expires_at: expiresAt, signature };
}

/**
 * Sign `inv` with `secret` — the owner's, or the certified key's with its `cert` — for the network
 * of `genesisHash`: the hex `grain.pay({ invoice })` takes.
 */
export function signInvoice(inv: Invoice, secret: Uint8Array, genesisHash: string, cert?: InvoiceKeyCert): string {
  const signature = ed25519.sign(invoiceMessage(inv, genesisHash), secret);
  return toHex(writeCert(new Writer().raw(encodeInvoice(inv)), cert).raw(signature).done());
}

/** The signed invoice in `hex` read back. */
export function decodeInvoice(hex: string): { invoice: Invoice; cert: InvoiceKeyCert | null; signature: string } {
  const r = new Reader(fromHex(hex));
  const invoice: Invoice = {
    slug: r.string(64),
    to: toHex(r.fixed(32)),
    asset: r.u8() === 0 ? "SALT" : "WORK",
    amount: r.u64(),
    memo: r.string(800),
    reference: toHex(r.fixed(16)),
    expires_at: Number(r.u64()),
  };
  const cert = readCert(r);
  const signature = toHex(r.fixed(64));
  r.end();
  return { invoice, cert, signature };
}

/** What a wallet checks (12-grains §5.2): why it would refuse `hex`, or null. */
export function invoiceProblem(hex: string, slug: string, ownerKey: DeviceKey, genesisHash: string, now = Date.now()): string | null {
  try {
    const { invoice, cert, signature } = decodeInvoice(hex);
    if (invoice.slug !== slug) return "grain";
    if (invoice.expires_at <= now) return "expired";
    if (invoice.amount === 0n) return "amount";
    const signer = signerOf(cert, slug, ownerKey, now);
    if (!signer) return "cert";
    return verifyByDeviceKey(signer, invoiceMessage(invoice, genesisHash), signature) ? null : "signature";
  } catch (e) {
    return "malformed";
  }
}

/** The transfer's public memo for `inv`: the reference in hex, then the text. */
export function memoText(inv: Invoice): string {
  return inv.memo ? `${inv.reference} ${inv.memo}` : inv.reference;
}

/** The reference a payment's memo carries, or null. */
export function referenceInMemo(text: string): string | null {
  const m = /^([0-9a-f]{32})(?: |$)/.exec(text);
  return m ? m[1]! : null;
}
