// The protocol version a transaction signed now meets (Saltix 23-upgrades §6, §6a): every block header names the
// version its network's schedule gives the slot's epoch, and a block takes only the tags of its version. So a call is
// built in the form of the version the network runs (`networkVersion`), and a call of a form a scheduled version
// retires is signed valid only until the slot before that version begins (`windowFor`): it lands before the switch or
// expires there, never waiting in a pool into blocks that refuse it.
import { type GrainCall, callVersions } from "@saltix/grain-server";

/** What `node_status` says of the chain's slots and its protocol versions (08-node §6); a node from before versions
 *  says nothing of them, which is version 1. */
export interface VersionStatus {
  slot?: unknown;
  epoch_slots?: unknown;
  protocol?: { version?: unknown; next?: { version?: unknown; epoch?: unknown } | null; outdated?: { version?: unknown } | null } | null;
}

/** The slots before a switch within which a call of a form it retires is not signed: three shard blocks (04-consensus §2). */
export const SWITCH_MARGIN = 30;

const whole = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** The version the node's own schedule runs now: 1 from a node that names none. */
export function protocolOf(status: VersionStatus): number {
  const v = whole(status.protocol?.version);
  return v !== null && v >= 1 ? v : 1;
}

/** The version the network runs: the node's, or the later one a node left behind saw in a header (`outdated`). */
export function networkVersion(status: VersionStatus): number {
  const seen = whole(status.protocol?.outdated?.version);
  return Math.max(protocolOf(status), seen ?? 0);
}

/** The first slot of the next version the schedule names, with that version; null when none is named, or the node
 *  names no epoch length to place it. */
export function nextSwitch(status: VersionStatus): { version: number; slot: number } | null {
  const next = status.protocol?.next;
  const version = whole(next?.version);
  const epoch = whole(next?.epoch);
  const epochSlots = whole(status.epoch_slots);
  if (version === null || epoch === null || epochSlots === null || version <= protocolOf(status)) return null;
  const slot = epoch * epochSlots;
  return Number.isSafeInteger(slot) ? { version, slot } : null;
}

/** Why a call cannot be signed now (`windowFor`): the network does not run its version, or retires its form too soon. */
export class VersionError extends Error {}

/**
 * The last slot `call`, signed at the node's `slot` for `validFor` slots, stays valid in: the whole window, or up to the
 * slot before a scheduled version that refuses its form. Throws `VersionError` for a call the network's version does not
 * take, and for one whose form a version beginning within `SWITCH_MARGIN` slots refuses (sign it again after the switch).
 */
export function windowFor(call: GrainCall, status: VersionStatus, validFor: number): number {
  const slot = whole(status.slot) ?? 0;
  const runs = networkVersion(status);
  const { since, until } = callVersions(call);
  if (runs < since) {
    throw new VersionError(`the network runs protocol version ${runs}; this call is protocol version ${since}'s`);
  }
  if (until !== null && runs >= until) {
    throw new VersionError(`the network runs protocol version ${runs}, which no longer takes this form of the call: build it again`);
  }
  const end = slot + validFor;
  const next = nextSwitch(status);
  if (until === null || next === null || next.version < until || end < next.slot) return end;
  if (next.slot - slot < SWITCH_MARGIN) {
    throw new VersionError(`the network moves to protocol version ${next.version} at slot ${next.slot}, in ${next.slot - slot} ` +
      `slots: run it again after the switch, when it is sent in that version's form`);
  }
  return next.slot - 1;
}
