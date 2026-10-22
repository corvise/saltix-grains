// `grain sponsor`: the account that pays the relays for a grain's users (Saltix 11-access §4, 12-grains §5.4) —
// its key file, its channels with pools' exchanges, and the transactions that open, top up and close them.
import {
  type ChannelCall, type NetworkName, type NodeLike, nodeCall, signChannelTx, channelTxFee, accountId, encodeAddress, toHex, fromHex,
} from "@saltix/grain-server";
import { publicKeyOf } from "./project.js";
import type { Signing } from "./registry.js";

export const SPONSOR_KEY_FILE = "sponsor.key";
/** A payer holds at most two channels, with different exchanges (11-access §4.2). */
export const MAX_CHANNELS = 2;

export interface Channel { exchange: string; deposit: string; closing_at: number | null }
export interface Exchange { pool: string; pool_key: string; fee_bp: number; bond: string; closed: number | null; reachable: boolean }
export interface SponsorStatus {
  address: string;
  /** What the manifest's `sponsor` names. */
  account: string;
  salt: string;
  work: string;
  channels: Channel[];
  exchanges: Exchange[];
}

interface Status { genesis: string; slot: number; network: NetworkName }
interface Account { nonce: number; salt: string; work: string; channels: Channel[] }

/** µWORK of a decimal amount of WORK (6 decimals). */
export function parseWork(text: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) throw new Error(`${text}: an amount of WORK, at most 6 decimals`);
  const units = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
  if (units === 0n) throw new Error("the amount must be more than 0");
  return units;
}

export async function sponsorStatus(node: NodeLike, secret: Uint8Array): Promise<SponsorStatus> {
  const status = await nodeCall<Status>(node, "node_status");
  const account = toHex(accountId(fromHex(publicKeyOf(secret), 32)));
  const a = await nodeCall<Account>(node, "account_get", { address: account });
  const { exchanges } = await nodeCall<{ exchanges: Exchange[] }>(node, "exchange_list");
  return {
    address: encodeAddress(status.network, fromHex(account, 32)), account, salt: a.salt, work: a.work, channels: a.channels, exchanges,
  };
}

/** Open, top up or close the sponsor's channel; what a node would refuse is refused here first. */
export async function channel(call: ChannelCall, secret: Uint8Array, s: Signing): Promise<{ id: string; fee: bigint }> {
  const status = await nodeCall<Status>(s.node, "node_status");
  if (s.genesis !== undefined && status.genesis !== s.genesis.toLowerCase()) {
    throw new Error(`the node is on genesis ${status.genesis}, not ${s.genesis}`);
  }
  const account = toHex(accountId(fromHex(publicKeyOf(secret), 32)));
  const a = await nodeCall<Account>(s.node, "account_get", { address: account });
  const exchange = "open" in call ? call.open.exchange : "topUp" in call ? call.topUp.exchange : call.close.exchange;
  const held = a.channels.find((c) => c.exchange === exchange);
  if ("open" in call) {
    if (held) throw new Error(`a channel with ${exchange} is open already${held.closing_at !== null ? " and closing" : ""}`);
    if (a.channels.length >= MAX_CHANNELS) throw new Error(`the account holds ${MAX_CHANNELS} channels already`);
    const { exchanges } = await nodeCall<{ exchanges: Exchange[] }>(s.node, "exchange_list");
    const e = exchanges.find((x) => x.pool === exchange);
    if (!e || e.closed !== null) throw new Error(`${exchange}: no open exchange of that pool (grain sponsor lists them)`);
  } else if (!held || held.closing_at !== null) {
    throw new Error(`no open channel with ${exchange}`);
  }
  const amount = "open" in call ? call.open.amount : "topUp" in call ? call.topUp.amount : 0n;
  if (BigInt(a.work) < amount) throw new Error(`the account has ${a.work} µWORK; the channel needs ${amount}`);
  const fee = s.fee ?? channelTxFee(call);
  if (BigInt(a.salt) < fee) throw new Error(`the account has ${a.salt} base units of SALT; the fee is ${fee}`);
  const signed = signChannelTx(secret, { nonce: a.nonce, fee, validUntilSlot: status.slot + s.validFor }, call, status.genesis);
  const answer = await nodeCall<{ id: string }>(s.node, "transaction_submit", { transaction: signed.hex });
  return { id: answer.id, fee };
}
