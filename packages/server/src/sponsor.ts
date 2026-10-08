// A grain's sponsor (Salarium 11-access §4, 12-grains §5.4): the channel its users' relay traffic is paid from, and the
// certificates that let each user's grain key spend from it.
import { ed25519 } from "@noble/curves/ed25519";
import { Reader, Writer, derive, fromHex, toHex } from "./bytes.js";
import { accountId } from "./address.js";
import { rpc } from "./node.js";
import { minimumTxFee, signTx, type TxFields } from "./tx.js";

/** What a certificate lets a key buy at relays (the relay enforces it). */
export const SERVICE = { messages: 1, turn: 2, files: 4, mailbox: 8 } as const;
/** A certificate lives at most this many slots (30 days). */
export const MAX_GRANT_LIFE = 2_592_000;
/** The sponsor key's tag on the wire: Ed25519. (A managed account's phone signs with P-256, tag 1; a grain's server
 *  never does.) */
const ED25519 = 0;

/** The sponsor's word that `user_key` may spend up to `per_day` µWORK a day from its channels, for `services`. */
export interface SponsorCert {
  /** The sponsor's Ed25519 key (hex): its personal account pays, and is the manifest's `sponsor`. */
  sponsor: string;
  /** The user's key in the grain (hex): what `grain.login` returned. */
  user_key: string;
  per_day: bigint;
  services: number;
  /** Slots. */
  issued: number;
  expires: number;
}

export function encodeSponsorCert(c: SponsorCert): Uint8Array {
  if (!(c.issued < c.expires && c.expires - c.issued <= MAX_GRANT_LIFE)) throw new TypeError("a certificate lives at most 30 days");
  if (!Number.isInteger(c.services) || c.services < 0 || c.services > 0xff) throw new TypeError("services: a byte");
  return new Writer().u8(ED25519).fixed(fromHex(c.sponsor, 32), 32).fixed(fromHex(c.user_key, 32), 32).u64(c.per_day)
    .u8(c.services).u64(c.issued).u64(c.expires).done();
}

/** What the sponsor signs: the certificate on the network of `genesisHash` (hex). */
export function sponsorCertMessage(c: SponsorCert, genesisHash: string): Uint8Array {
  return derive("Salarium sponsor certificate v1", fromHex(genesisHash, 32), encodeSponsorCert(c));
}

/**
 * Certify `user_key` with the sponsor's secret: the hex `grain.relay.open({ grant })` takes. Issue one at login, for
 * days rather than the 30 the protocol allows, and only for the services your grain uses.
 */
export function issueSponsorCert(sponsorSecret: Uint8Array, cert: Omit<SponsorCert, "sponsor">, genesisHash: string): string {
  const full = { ...cert, sponsor: toHex(ed25519.getPublicKey(sponsorSecret)) };
  return toHex(encodeSponsorCert(full)) + toHex(ed25519.sign(sponsorCertMessage(full, genesisHash), sponsorSecret));
}

export function decodeSponsorCert(hex: string): { cert: SponsorCert; signature: string } {
  const r = new Reader(fromHex(hex));
  if (r.u8() !== ED25519) throw new TypeError("sponsor: not an Ed25519 key");
  const cert: SponsorCert = {
    sponsor: toHex(r.fixed(32)), user_key: toHex(r.fixed(32)), per_day: r.u64(), services: r.u8(), issued: Number(r.u64()),
    expires: Number(r.u64()),
  };
  const signature = toHex(r.fixed(64));
  r.end();
  return { cert, signature };
}

/**
 * What a wallet checks of a grant (12-grains §5.4): why it would refuse `hex` for a grain whose manifest names
 * `sponsorAccount` (hex account id), or null. The exchange checks the rest: the slot, the daily sum.
 */
export function sponsorCertProblem(hex: string, sponsorAccount: string, genesisHash: string): string | null {
  let decoded;
  try {
    decoded = decodeSponsorCert(hex);
    encodeSponsorCert(decoded.cert);
  } catch {
    return "malformed";
  }
  const { cert, signature } = decoded;
  if (toHex(accountId(fromHex(cert.sponsor, 32))) !== sponsorAccount) return "sponsor";
  if ((cert.services & SERVICE.messages) === 0) return "services";
  return ed25519.verify(fromHex(signature, 64), sponsorCertMessage(cert, genesisHash), fromHex(cert.sponsor, 32)) ? null : "signature";
}

/**
 * A grant for the user's grain key `userKey` (hex) from now, as a login handler issues it: `days` long (at most 30),
 * for `services`, up to `perDay` µWORK a day. The node gives the slot and the network.
 */
export async function grantFor(nodeUrl: string, sponsorSecret: Uint8Array, userKey: string,
  options: { perDay: bigint; days?: number; services?: number }): Promise<string> {
  const { slot, genesis } = await rpc<{ slot: number; genesis: string }>(nodeUrl, "node_status");
  const days = Math.min(options.days ?? 7, 30);
  return issueSponsorCert(sponsorSecret, {
    user_key: userKey, per_day: options.perDay, services: options.services ?? SERVICE.messages, issued: slot, expires: slot + days * 86_400,
  }, genesis);
}

/** The sponsor's channel with an exchange (a city id, hex): open with a deposit, top up, close. Amounts in µWORK. */
export type ChannelCall =
  | { open: { exchange: string; amount: bigint } }
  | { topUp: { exchange: string; amount: bigint } }
  | { close: { exchange: string } };

// Action::OpenChannel, TopUpChannel and CloseChannel are tags 2, 3 and 4.
function channelAction(call: ChannelCall): Uint8Array {
  if ("open" in call) return new Writer().u8(2).fixed(fromHex(call.open.exchange, 32), 32).u64(call.open.amount).done();
  if ("topUp" in call) return new Writer().u8(3).fixed(fromHex(call.topUp.exchange, 32), 32).u64(call.topUp.amount).done();
  return new Writer().u8(4).fixed(fromHex(call.close.exchange, 32), 32).done();
}

/** Sign a channel transaction with the sponsor's secret: hex for `transaction_submit`, and its id. */
export function signChannelTx(secret: Uint8Array, fields: Omit<TxFields, "sender">, call: ChannelCall, genesisHash: string): { hex: string; id: string } {
  return signTx(secret, fields, channelAction(call), genesisHash);
}

export function channelTxFee(call: ChannelCall): bigint {
  return minimumTxFee(channelAction(call));
}
