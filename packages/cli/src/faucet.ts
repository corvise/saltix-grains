// `grain faucet`: test SALT, and WORK while its purses hold some, for a key file's account or an address, from a test
// network's faucet (Saltix 08-node §6, `faucet_request`): a node signs a grant from one of its purses and pools it; an
// address gets one every 5 minutes. No mainnet node runs one.
import { FAUCET, type NodeLike, RpcError, accountId, decodeAddress, encodeAddress, fromHex, nodeCall, toHex } from "@saltix/grain-server";
import { publicKeyOf } from "./project.js";
import { salt } from "./registry.js";

/** What the faucet granted: the SALT transfer, and the WORK one after it while the purse holds WORK. Amounts in base
 *  units of SALT and µWORK. */
export interface Grant {
  address: string;
  salt: { id: string; amount: bigint };
  work: { id: string; amount: bigint } | null;
}

/** µWORK as WORK, for people: `1000`, `0.5`. */
export function work(units: bigint): string {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/** The address a grant goes to: `address` as given (on the network answering), or the key file's account's. */
export async function grantAddress(node: NodeLike, options: { address?: string; secret?: Uint8Array }): Promise<string> {
  const { network } = await nodeCall<{ network: "mainnet" | "testnet" | "devnet" }>(node, "node_status");
  if (options.address !== undefined) {
    const decoded = decodeAddress(options.address);
    if (!decoded) throw new Error(`--address ${options.address}: not an address`);
    if (decoded.network !== network) throw new Error(`--address ${options.address}: an address of ${decoded.network}, and the network answering is ${network}`);
    return options.address;
  }
  if (!options.secret) throw new Error("a key file (--key) or --address");
  return encodeAddress(network, accountId(fromHex(publicKeyOf(options.secret), 32)));
}

/** What a faucet's refusal means, in words. */
function refusal(e: RpcError, address: string): string {
  const retry = (e.data as { retry_after?: unknown } | null)?.retry_after;
  switch (e.reason) {
    case "too_soon":
      return `the faucet paid ${address} less than 5 minutes ago` + (typeof retry === "number" ? `: try again in ${retry} s` : ": try again later");
    case "daily_limit":
      return "the faucet has made its grants of the day (UTC): try again tomorrow";
    case "empty":
      return "the faucet's purses are empty: tell the test network's operators";
    case "self":
      return "that is a purse of the faucet itself";
    case "no_faucet":
      return "the node answering runs no faucet: a faucet runs only on a test network";
    default:
      return e.message;
  }
}

/** Ask the faucet for a grant to `address`. Throws in words when it refuses. */
export async function requestGrant(node: NodeLike, address: string): Promise<Grant> {
  let answer: { id: string; amount: string; work: { id: string; amount: string } | null };
  try {
    answer = await nodeCall(node, "faucet_request", { address });
  } catch (e) {
    if (e instanceof RpcError && e.code === FAUCET) throw new Error(refusal(e, address));
    if (e instanceof Error && /no_faucet/.test(e.message)) throw new Error("no node within reach runs a faucet: a faucet runs only on a test network");
    throw e;
  }
  return {
    address,
    salt: { id: answer.id, amount: BigInt(answer.amount) },
    work: answer.work ? { id: answer.work.id, amount: BigInt(answer.work.amount) } : null,
  };
}

/** The account's SALT now, in base units: 0 for one the chain does not know yet. */
export async function saltOf(node: NodeLike, address: string): Promise<bigint> {
  const decoded = decodeAddress(address);
  const a = await nodeCall<{ salt?: string } | null>(node, "account_get", { address: decoded ? toHex(decoded.id) : address });
  return BigInt(a?.salt ?? "0");
}

/** Wait until the account holds `atLeast` base units of SALT, at most `ms`: whether it did. */
export async function waitForSalt(node: NodeLike, address: string, atLeast: bigint, ms: number, every = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if ((await saltOf(node, address).catch(() => 0n)) >= atLeast) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, every));
  }
}

/** A grant in words. */
export const granted = (g: Grant): string =>
  `${salt(g.salt.amount)} SALT to ${g.address} (transaction ${g.salt.id})` + (g.work ? `, and ${work(g.work.amount)} WORK (transaction ${g.work.id})` : "");
